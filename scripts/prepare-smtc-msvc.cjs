const { existsSync, statSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const {
  resolveSmtcMsvcBuildDirectory,
  resolveSmtcMsvcEnvironment,
  validateSmtcMsvcToolchain
} = require('./smtc-msvc-toolchain.cjs')
const { assertX64Pe } = require('./verify-release-artifacts.cjs')

const SMTC_RUNTIME_FILE = 'twilight_smtc_node.node'
const SMTC_SOURCE_FILES = Object.freeze([
  'audio-engine/smtc/CMakeLists.txt',
  'audio-engine/smtc/twilight_smtc_node.cpp',
  'audio-engine/smtc/node_api_dynamic_win32.cpp'
])

function isX64Pe(filePath) {
  try {
    assertX64Pe(filePath)
    return true
  } catch {
    return false
  }
}

function builtSmtcFile(root, buildDir, exists = existsSync, isPeX64 = isX64Pe, stat = statSync) {
  const candidates = [
    join(buildDir, 'bin', 'Release', SMTC_RUNTIME_FILE),
    join(buildDir, 'Release', SMTC_RUNTIME_FILE)
  ]
  const filePath = candidates.find((candidate) => exists(candidate)) ?? candidates[1]
  const stale = sourceIsNewerThanStaged(root, filePath, exists, stat)
  return {
    buildDir,
    filePath,
    stale,
    complete: exists(filePath) && isPeX64(filePath) && !stale
  }
}

function sourceIsNewerThanStaged(root, filePath, exists = existsSync, stat = statSync) {
  if (!exists(filePath)) return true
  let stagedMtime
  try {
    stagedMtime = stat(filePath).mtimeMs
  } catch {
    return true
  }
  return SMTC_SOURCE_FILES.some((relativePath) => {
    const sourcePath = join(root, relativePath)
    if (!exists(sourcePath)) return false
    try {
      return stat(sourcePath).mtimeMs > stagedMtime
    } catch {
      return true
    }
  })
}

function stagedSmtcFile(root, exists = existsSync, isPeX64 = isX64Pe, stat = statSync) {
  const nativeDir = join(root, 'resources', 'audio-engine')
  const filePath = join(nativeDir, SMTC_RUNTIME_FILE)
  const stale = sourceIsNewerThanStaged(root, filePath, exists, stat)
  return {
    nativeDir,
    filePath,
    stale,
    complete: exists(filePath) && isPeX64(filePath) && !stale
  }
}

function selfTestStagedSmtc(filePath, load = require) {
  const addon = load(filePath)
  if (
    typeof addon?.Create !== 'function' ||
    typeof addon?.Update !== 'function' ||
    typeof addon?.Destroy !== 'function' ||
    typeof addon?.SelfTest !== 'function' ||
    addon.SelfTest() !== true
  ) {
    throw new Error(`Staged SMTC addon failed its N-API self-test: ${filePath}`)
  }
}

function runNodeScript(root, script, args, environment, run = spawnSync) {
  const result = run(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd: root,
    stdio: 'inherit',
    env: environment
  })
  if (result?.error) throw result.error
  if ((result?.status ?? 1) !== 0) {
    throw new Error(`${script} failed with exit code ${result?.status ?? 'unknown'}`)
  }
}

function withStagedRuntimePath(environment, nativeDir) {
  const resolved = { ...environment }
  const pathKey = Object.keys(resolved).find((name) => name.toLowerCase() === 'path') || 'PATH'
  resolved[pathKey] = [nativeDir, resolved[pathKey]].filter(Boolean).join(';')
  return resolved
}

function prepareSmtcMsvc({
  root = resolve(__dirname, '..'),
  platform = process.platform,
  arch = process.arch,
  environment,
  exists = existsSync,
  readDirectories,
  run = spawnSync,
  force,
  isPeX64 = isX64Pe,
  stat = statSync,
  load = require,
  stage = true
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('Native SMTC can only be packaged from a Windows x64 build.')
  }

  const resolvedEnvironment = environment ? { ...environment } : resolveSmtcMsvcEnvironment()
  const shouldForce = force ?? resolvedEnvironment.TWILIGHT_FORCE_SMTC_REBUILD === '1'
  const buildDir = resolveSmtcMsvcBuildDirectory(resolvedEnvironment, root)
  const built = builtSmtcFile(root, buildDir, exists, isPeX64, stat)
  const staged = stage ? stagedSmtcFile(root, exists, isPeX64, stat) : null
  const reusable = stage ? staged : built
  if (!shouldForce && reusable?.complete) {
    selfTestStagedSmtc(reusable.filePath, load)
    return {
      buildDir,
      nativeDir: stage ? staged.nativeDir : buildDir,
      artifactPath: reusable.filePath,
      reused: true,
      staged: stage
    }
  }

  const toolchain = validateSmtcMsvcToolchain({
    env: resolvedEnvironment,
    exists,
    ...(readDirectories ? { readDirectories } : {})
  })
  if (!toolchain.ok) throw new Error(toolchain.message)

  if (!exists(join(buildDir, 'CMakeCache.txt'))) {
    runNodeScript(root, 'configure-smtc-msvc.cjs', [], resolvedEnvironment, run)
  }
  runNodeScript(root, 'run-smtc-msvc.cjs', ['build'], resolvedEnvironment, run)
  runNodeScript(
    root,
    'run-smtc-msvc.cjs',
    ['test'],
    withStagedRuntimePath(resolvedEnvironment, join(root, 'resources', 'audio-engine')),
    run
  )

  const finalBuilt = builtSmtcFile(root, buildDir, exists, isPeX64, stat)
  if (!finalBuilt.complete) {
    throw new Error(
      `SMTC build output is incomplete, stale, or not Windows x64: ${finalBuilt.filePath}`
    )
  }
  selfTestStagedSmtc(finalBuilt.filePath, load)
  if (!stage) {
    return {
      buildDir,
      nativeDir: buildDir,
      artifactPath: finalBuilt.filePath,
      reused: false,
      staged: false
    }
  }

  runNodeScript(root, 'run-smtc-msvc.cjs', ['stage'], resolvedEnvironment, run)

  const finalStaged = stagedSmtcFile(root, exists, isPeX64, stat)
  if (!finalStaged.complete) {
    throw new Error(`SMTC staging is incomplete or not Windows x64: ${finalStaged.filePath}`)
  }
  selfTestStagedSmtc(finalStaged.filePath, load)
  return {
    buildDir,
    nativeDir: finalStaged.nativeDir,
    artifactPath: finalStaged.filePath,
    reused: false,
    staged: true
  }
}

function main() {
  try {
    const stage = !process.argv.includes('--build-only')
    const result = prepareSmtcMsvc({ stage })
    console.log(
      `${result.reused ? 'Reused' : 'Prepared'} native SMTC ${stage ? 'staging' : 'build'} at ${result.artifactPath}`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  SMTC_RUNTIME_FILE,
  SMTC_SOURCE_FILES,
  builtSmtcFile,
  isX64Pe,
  prepareSmtcMsvc,
  runNodeScript,
  selfTestStagedSmtc,
  sourceIsNewerThanStaged,
  stagedSmtcFile,
  withStagedRuntimePath
}
