const { existsSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const {
  resolveVst3MsvcBuildDirectory,
  resolveVst3MsvcEnvironment,
  validateVst3MsvcToolchain
} = require('./vst3-msvc-toolchain.cjs')
const { createAudioCapabilityManifest } = require('./generate-audio-capability-manifest.cjs')
const { readStagedAudioRuntimeObservation } = require('./staged-audio-runtime-observation.cjs')
const { assertX64Pe } = require('./verify-release-artifacts.cjs')
const { createReleaseCapabilityStatus } = require('./verify-release-capability-consistency.cjs')

const VST3_HELPER_FILES = Object.freeze(['twilight-vst3-scanner.exe', 'twilight-vst3-host.exe'])
const VST3_RUNTIME_FILES = Object.freeze(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])

function isX64Pe(filePath) {
  try {
    assertX64Pe(filePath)
    return true
  } catch {
    return false
  }
}

function stagedVst3Files(root, exists = existsSync, isPeX64 = isX64Pe) {
  const nativeDir = join(root, 'resources', 'audio-engine')
  const files = [...VST3_HELPER_FILES, ...VST3_RUNTIME_FILES]
  const missing = files.filter((file) => !exists(join(nativeDir, file)))
  const wrongArchitecture = files.filter(
    (file) => exists(join(nativeDir, file)) && !isPeX64(join(nativeDir, file))
  )
  return {
    nativeDir,
    missing,
    wrongArchitecture,
    complete: missing.length === 0 && wrongArchitecture.length === 0
  }
}

function withStagedRuntimePath(environment, nativeDir) {
  const resolved = { ...environment }
  const pathKey = Object.keys(resolved).find((name) => name.toLowerCase() === 'path') || 'PATH'
  resolved[pathKey] = [nativeDir, resolved[pathKey]].filter(Boolean).join(';')
  return resolved
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

function refreshCapabilityArtifacts(nativeDir) {
  const binaryManifest = createAudioCapabilityManifest({ artifactDir: nativeDir })
  const runtimeStatus = readStagedAudioRuntimeObservation({
    artifactDir: nativeDir,
    manifest: binaryManifest
  })
  const manifest = createAudioCapabilityManifest({ artifactDir: nativeDir, runtimeStatus })
  writeFileSync(
    join(nativeDir, 'audio-capabilities.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  const status = createReleaseCapabilityStatus({ nativeDir, manifest })
  writeFileSync(
    join(nativeDir, 'release-capability-status.json'),
    `${JSON.stringify(status, null, 2)}\n`
  )
}

function prepareVst3Msvc({
  root = resolve(__dirname, '..'),
  platform = process.platform,
  arch = process.arch,
  environment,
  exists = existsSync,
  readDirectories,
  run = spawnSync,
  refresh = refreshCapabilityArtifacts,
  force,
  isPeX64 = isX64Pe
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('VST3 helpers can only be packaged from a Windows x64 build.')
  }

  const resolvedEnvironment = environment ? { ...environment } : resolveVst3MsvcEnvironment()
  const shouldForce = force ?? resolvedEnvironment.TWILIGHT_FORCE_VST3_REBUILD === '1'
  const staged = stagedVst3Files(root, exists, isPeX64)
  if (!shouldForce && staged.complete) {
    refresh(staged.nativeDir)
    return { buildDir: '', nativeDir: staged.nativeDir, reused: true }
  }

  const toolchain = validateVst3MsvcToolchain({
    env: resolvedEnvironment,
    exists,
    ...(readDirectories ? { readDirectories } : {})
  })
  if (!toolchain.ok) throw new Error(toolchain.message)

  const buildDir = resolveVst3MsvcBuildDirectory(resolvedEnvironment, root)
  if (!exists(join(buildDir, 'CMakeCache.txt'))) {
    runNodeScript(root, 'configure-vst3-msvc.cjs', [], resolvedEnvironment, run)
  }
  runNodeScript(root, 'run-vst3-msvc.cjs', ['build'], resolvedEnvironment, run)
  runNodeScript(root, 'run-vst3-msvc.cjs', ['stage'], resolvedEnvironment, run)
  runNodeScript(
    root,
    'run-vst3-msvc.cjs',
    ['test'],
    withStagedRuntimePath(resolvedEnvironment, join(root, 'resources', 'audio-engine')),
    run
  )

  const finalStaged = stagedVst3Files(root, exists, isPeX64)
  if (!finalStaged.complete) {
    const missing = [
      ...finalStaged.missing,
      ...finalStaged.wrongArchitecture.map((file) => `${file} is not a Windows x64 PE`)
    ]
    throw new Error(`VST3 staging is incomplete; missing or invalid ${missing.join(', ')}`)
  }
  refresh(finalStaged.nativeDir)
  return { buildDir, nativeDir: finalStaged.nativeDir, reused: false }
}

function main() {
  try {
    const result = prepareVst3Msvc()
    console.log(`${result.reused ? 'Reused' : 'Prepared'} VST3 MSVC helpers in ${result.nativeDir}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  VST3_HELPER_FILES,
  VST3_RUNTIME_FILES,
  isX64Pe,
  prepareVst3Msvc,
  refreshCapabilityArtifacts,
  runNodeScript,
  stagedVst3Files,
  withStagedRuntimePath
}
