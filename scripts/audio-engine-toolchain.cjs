const {
  accessSync: fileAccessSync,
  constants: fileSystemConstants,
  existsSync: fileExistsSync,
  readFileSync: fileReadFileSync,
  mkdirSync: makeDirectorySync
} = require('node:fs')
const { delimiter, dirname, join, resolve } = require('node:path')
const { spawnSync: childProcessSpawnSync } = require('node:child_process')
const { cpus: osCpus, totalmem: osTotalmem } = require('node:os')

function osTotalMemory() {
  return osTotalmem()
}

function osCpuCount() {
  return osCpus().length
}

const PERSISTED_MINGW_VARIABLES = [
  'VCPKG_ROOT',
  'W64DEVKIT_ROOT',
  'TAE_MINGW_BUILD_DIR',
  'TWILIGHT_GNU_PATCH'
]

const MINGW_EXPECTED_CTESTS = Object.freeze([
  'twilight_audio_engine_smoke',
  'twilight_dsp_unit',
  'twilight_channel_router_unit',
  'twilight_wsola_unit',
  'twilight_audio_buffer_unit',
  'twilight_diagnostic_log_unit',
  'twilight_native_dsp_plugin_unit',
  'twilight_native_dsp_plugin_crash_fixture',
  'twilight_metadata_unit',
  'twilight_bitperfect_unit',
  'twilight_ffmpeg_decoder_unit',
  'twilight_dsd_dop_unit',
  'twilight_dsd_mute_guard_unit',
  'twilight_dsd_downrate_unit',
  'twilight_pcm_to_dsd_unit',
  'twilight_queue_unit',
  'twilight_backend_factory_unit',
  'twilight_miniaudio_backend_unit',
  'twilight_wasapi_format_negotiator_unit',
  'twilight_asio_backend_unit',
  'twilight_asio_helper_selftest',
  'twilight_asio_helper_process_unit',
  'twilight_asio_abi_checks',
  'twilight_asio_abi_manifest',
  'twilight_asio_abi_cross_dll',
  'twilight_asio_control_thread_unit',
  'twilight_output_backend_unit',
  'twilight_runtime_queue_reroute_unit',
  'twilight_audio_performance_gate',
  'twilight_dst_decoder_unit',
  'twilight_coreaudio_backend_unit',
  'twilight_alsa_backend_unit',
  'twilight_platform_backend_smoke'
])

function environmentValue(env, name) {
  const direct = env[name]
  if (typeof direct === 'string' && direct) return direct
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
  const value = key ? env[key] : undefined
  return typeof value === 'string' && value ? value : undefined
}

function setEnvironmentValue(env, name, value) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name.toUpperCase()) delete env[key]
  }
  env[name] = value
}

function resolveMingwEnvironment({ env = process.env, spawnSync = childProcessSpawnSync } = {}) {
  const resolved = { ...env }
  if (process.platform !== 'win32') return resolved
  for (const name of PERSISTED_MINGW_VARIABLES) {
    if (environmentValue(resolved, name)) continue
    const result = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result?.status !== 0 || result.error) continue
    const expression = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im')
    const match = expression.exec(result.stdout ?? '')
    if (match?.[1]) resolved[name] = match[1].trim()
  }
  return resolved
}

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function validateMingwToolchain({ env = process.env, existsSync = fileExistsSync } = {}) {
  const vcpkgRoot = env.VCPKG_ROOT ? resolve(env.VCPKG_ROOT) : ''
  const devkitRoot = env.W64DEVKIT_ROOT ? resolve(env.W64DEVKIT_ROOT) : ''
  const missing = []

  if (!vcpkgRoot) {
    missing.push('VCPKG_ROOT is required and must point to a vcpkg checkout')
  } else if (!existsSync(join(vcpkgRoot, 'scripts', 'buildsystems', 'vcpkg.cmake'))) {
    missing.push(`VCPKG_ROOT does not contain scripts/buildsystems/vcpkg.cmake: ${vcpkgRoot}`)
  }

  if (!devkitRoot) {
    missing.push('W64DEVKIT_ROOT is required and must point to a w64devkit installation')
  } else {
    const requiredBinaries = [
      'gcc.exe',
      'g++.exe',
      'x86_64-w64-mingw32-gcc.exe',
      'x86_64-w64-mingw32-g++.exe',
      'ninja.exe'
    ]
    for (const binary of requiredBinaries) {
      if (!existsSync(join(devkitRoot, 'bin', binary))) {
        missing.push(`W64DEVKIT_ROOT is missing bin/${binary}: ${devkitRoot}`)
      }
    }
  }

  return missing.length === 0
    ? { ok: true, message: '' }
    : { ok: false, message: `MinGW audio toolchain preflight failed:\n- ${missing.join('\n- ')}` }
}

function resolveMingwBuildLayout({ root, env = process.env } = {}) {
  const defaultBuildDir = join(resolve(root ?? '.'), 'audio-engine', 'build', 'mingw-static')
  const buildDir = env.TAE_MINGW_BUILD_DIR ? resolve(env.TAE_MINGW_BUILD_DIR) : defaultBuildDir
  if (/\s/.test(buildDir)) {
    return {
      ok: false,
      message:
        'MinGW audio toolchain preflight failed:\n' +
        '- MinGW build directory cannot contain whitespace because vcpkg FFmpeg passes it to MSYS2. Set TAE_MINGW_BUILD_DIR to a writable path without whitespace'
    }
  }
  return { ok: true, buildDir, tempDir: join(buildDir, 'tmp') }
}

function prepareMingwBuildLayout({
  root,
  env = process.env,
  mkdirSync = makeDirectorySync,
  accessSync = fileAccessSync,
  constants = fileSystemConstants
} = {}) {
  const layout = resolveMingwBuildLayout({ root, env })
  if (!layout.ok) return layout

  try {
    mkdirSync(layout.buildDir, { recursive: true })
    mkdirSync(layout.tempDir, { recursive: true })
    accessSync(layout.buildDir, constants.W_OK)
    accessSync(layout.tempDir, constants.W_OK)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message:
        'MinGW audio toolchain preflight failed:\n' +
        `- MinGW build directory is not writable: ${layout.buildDir} (${reason})`
    }
  }

  return layout
}

function prepareMingwCmakeEnvironment({
  buildDir,
  env = process.env,
  existsSync = fileExistsSync,
  spawnSync = childProcessSpawnSync
} = {}) {
  const validation = validateMingwToolchain({ env, existsSync })
  if (!validation.ok) return validation

  const patch = findGnuPatch(env, existsSync, spawnSync)
  if (!patch) {
    return {
      ok: false,
      message:
        'MinGW audio toolchain preflight failed:\n' +
        '- GNU patch is required before w64devkit/bin. Install Git for Windows or set a valid TWILIGHT_GNU_PATCH GNU patch.exe path'
    }
  }

  const devkitBin = join(resolve(env.W64DEVKIT_ROOT), 'bin')
  const patchBin = dirname(patch)
  const pathEntries = [
    patchBin,
    devkitBin,
    ...(environmentValue(env, 'PATH') ?? '').split(delimiter)
  ]
  const uniquePathEntries = []
  const seen = new Set()
  for (const entry of pathEntries) {
    if (!entry) continue
    const key = normalizePath(entry)
    if (seen.has(key)) continue
    seen.add(key)
    uniquePathEntries.push(entry)
  }

  const environment = { ...env }
  setEnvironmentValue(environment, 'PATH', uniquePathEntries.join(delimiter))
  setEnvironmentValue(environment, 'MSYS', withMsysLinkFallback(environmentValue(env, 'MSYS')))
  if (buildDir) {
    const tempDir = join(resolve(buildDir), 'tmp')
    environment.TEMP = tempDir
    environment.TMP = tempDir
    environment.TMPDIR = tempDir
  }

  return {
    ok: true,
    message: '',
    environment
  }
}

function validateMingwBuildCommands({
  env = process.env,
  spawnSync = childProcessSpawnSync,
  commands = ['cmake', 'ctest']
} = {}) {
  const unavailable = []
  for (const command of commands) {
    let result
    try {
      result = spawnSync(command, ['--version'], {
        env,
        encoding: 'utf8',
        windowsHide: true
      })
    } catch {
      result = null
    }
    if (result?.status === 0 && !result.error) continue

    const name = command === 'ctest' ? 'CTest' : 'CMake'
    unavailable.push(
      `${name} executable "${command}" is unavailable. Install CMake with CTest and add it to PATH`
    )
  }
  return unavailable.length === 0
    ? { ok: true, message: '' }
    : {
        ok: false,
        message: `MinGW audio toolchain preflight failed:\n- ${unavailable.join('\n- ')}`
      }
}

function withMsysLinkFallback(value) {
  const flags = String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return [...flags.filter((flag) => flag !== 'winsymlinks:lnk'), 'winsymlinks:lnk'].join(' ')
}

function findGnuPatch(env, existsSync, spawnSync) {
  if (env.TWILIGHT_GNU_PATCH) {
    const override = resolve(env.TWILIGHT_GNU_PATCH)
    return existsSync(override) && isGnuPatch(override, spawnSync) ? override : ''
  }

  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, 'Git', 'usr', 'bin', 'patch.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Git', 'usr', 'bin', 'patch.exe')
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = resolve(candidate)
    if (existsSync(resolved) && isGnuPatch(resolved, spawnSync)) return resolved
  }
  return ''
}

function isGnuPatch(patch, spawnSync) {
  let result
  try {
    result = spawnSync(patch, ['--version'], {
      encoding: 'utf8',
      windowsHide: true
    })
  } catch {
    return false
  }
  if (result?.status !== 0 || result.error) return false
  return /\bGNU patch\b/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

function findStaleCTestRegistrations(ctestText, buildDir) {
  const normalizedBuildDir = normalizePath(buildDir)
  const quotedPaths = String(ctestText).match(/"([^"\r\n]+)"/g) ?? []
  return quotedPaths
    .map((entry) => entry.slice(1, -1))
    .filter((entry) => /(?:\.exe|\/twilight_[^/]+)$/i.test(entry))
    .filter((entry) => !normalizePath(entry).startsWith(`${normalizedBuildDir}/`))
}

function parseCmakeCache(content) {
  const values = new Map()
  for (const line of String(content).split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const match = /^([^:=]+):[^=]*=(.*)$/.exec(line)
    if (match) values.set(match[1], match[2])
  }
  return values
}

function validateMingwNativeDependencyConfiguration({
  buildDir,
  existsSync = fileExistsSync,
  readFileSync = fileReadFileSync
} = {}) {
  if (!buildDir) {
    return {
      ok: false,
      message: 'MinGW native dependency validation requires a build directory',
      issues: ['build directory is missing']
    }
  }

  const resolvedBuildDir = resolve(buildDir)
  const cache = join(resolvedBuildDir, 'CMakeCache.txt')
  if (!existsSync(cache)) {
    return {
      ok: false,
      message: `MinGW native dependency validation requires ${cache}`,
      issues: ['CMakeCache.txt is missing']
    }
  }

  const values = parseCmakeCache(readFileSync(cache, 'utf8'))
  const installRoot = join(resolvedBuildDir, 'vcpkg_installed')
  const tripletRoot = join(installRoot, 'x64-mingw-static')
  const expected = {
    VCPKG_INSTALLED_DIR: installRoot,
    VCPKG_TARGET_TRIPLET: 'x64-mingw-static',
    TAE_BUILD_NAPI: 'ON',
    FFMPEG_FOUND: 'TRUE'
  }
  const issues = []

  for (const [name, expectedValue] of Object.entries(expected)) {
    const value = values.get(name)
    const matches =
      name === 'VCPKG_INSTALLED_DIR'
        ? typeof value === 'string' && normalizePath(value) === normalizePath(expectedValue)
        : value === expectedValue
    if (!matches) {
      issues.push(`${name} must be ${expectedValue}; found ${value || '<missing>'}`)
    }
  }

  const requiredArtifacts = [
    ['EBUR128_INCLUDE_DIR', join(tripletRoot, 'include'), 'ebur128.h'],
    ['EBUR128_LIBRARY', join(tripletRoot, 'lib', 'libebur128.a')],
    ['FFMPEG_INCLUDE_DIRS', join(tripletRoot, 'include'), 'libavformat', 'avformat.h']
  ]
  for (const [name, expectedPath, ...requiredChildren] of requiredArtifacts) {
    const value = values.get(name)
    const containsExpectedPath =
      typeof value === 'string' && normalizePath(value).includes(normalizePath(expectedPath))
    const artifact = join(expectedPath, ...requiredChildren)
    if (!containsExpectedPath || !existsSync(artifact)) {
      issues.push(`${name} must resolve from ${expectedPath}`)
    }
  }

  return issues.length === 0
    ? { ok: true, message: '', issues: [] }
    : {
        ok: false,
        message: `MinGW native dependency configuration is incomplete:\n- ${issues.join('\n- ')}`,
        issues
      }
}

function validateMingwCTestRegistration({
  buildDir,
  expectedTests = MINGW_EXPECTED_CTESTS,
  env = process.env,
  existsSync = fileExistsSync,
  readFileSync = fileReadFileSync,
  spawnSync = childProcessSpawnSync,
  cwd = process.cwd()
} = {}) {
  if (!buildDir) {
    return {
      ok: false,
      status: 1,
      message: 'MinGW CTest registration validation requires a build directory',
      output: '',
      missing: [...expectedTests]
    }
  }

  const cache = join(buildDir, 'CMakeCache.txt')
  const ctestFile = join(buildDir, 'CTestTestfile.cmake')
  if (!existsSync(cache)) {
    return {
      ok: false,
      status: 1,
      message: `MinGW build is not configured: missing ${cache}. Run configure:audio-engine:mingw and wait for it to finish.`,
      output: '',
      missing: [...expectedTests]
    }
  }
  if (!existsSync(ctestFile)) {
    return {
      ok: false,
      status: 1,
      message: `MinGW build has no CTest registration: missing ${ctestFile}. Run configure:audio-engine:mingw and wait for it to finish.`,
      output: '',
      missing: [...expectedTests]
    }
  }

  const stale = findStaleCTestRegistrations(readFileSync(ctestFile, 'utf8'), buildDir)
  if (stale.length > 0) {
    return {
      ok: false,
      status: 1,
      message: `CTest registration points outside ${buildDir}:\n${stale.join('\n')}`,
      output: '',
      missing: [...expectedTests]
    }
  }

  let result
  try {
    result = spawnSync('ctest', ['--test-dir', buildDir, '-N'], {
      cwd,
      encoding: 'utf8',
      env,
      windowsHide: true
    })
  } catch (error) {
    return {
      ok: false,
      status: 1,
      message: `Unable to discover MinGW CTest registrations: ${error instanceof Error ? error.message : String(error)}`,
      output: '',
      missing: [...expectedTests]
    }
  }

  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  const missing = expectedTests.filter((name) => !output.includes(name))
  const noTests = /No tests were found|Total Tests:\s*0\b/i.test(output)
  if (result?.error || result?.status !== 0 || noTests || missing.length > 0) {
    const reasons = []
    if (result?.error) reasons.push(result.error.message)
    if (result?.status !== 0)
      reasons.push(`ctest -N exited with status ${result?.status ?? 'unknown'}`)
    if (noTests) reasons.push('ctest discovered zero tests')
    if (missing.length > 0) reasons.push(`missing expected tests: ${missing.join(', ')}`)
    return {
      ok: false,
      status: result?.status && result.status !== 0 ? result.status : 1,
      message: `MinGW CTest registration validation failed: ${reasons.join('; ')}`,
      output,
      missing
    }
  }

  return { ok: true, status: 0, message: '', output, missing: [] }
}

// Ninja defaults to (cores + 2) parallel jobs. A -O3 cc1plus process on this
// codebase's heavier translation units peaks around 1 GiB, so a high-core /
// low-memory host exhausts RAM and cc1plus dies with "out of memory allocating
// N bytes" -- an OOM that reads like a toolchain fault. Cap concurrency by
// available memory instead of core count. TAE_MINGW_BUILD_JOBS overrides.
const MINGW_BYTES_PER_COMPILE_JOB = 1024 * 1024 * 1024

function resolveMingwBuildJobs({
  env = process.env,
  totalMemoryBytes = osTotalMemory(),
  cpuCount = osCpuCount()
} = {}) {
  const override = Number.parseInt(environmentValue(env, 'TAE_MINGW_BUILD_JOBS') ?? '', 10)
  if (Number.isFinite(override) && override > 0) return override

  const cores = Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : 1
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) return cores

  // Reserve one job's worth of headroom for the OS and the linker.
  const memoryBudget = Math.floor(totalMemoryBytes / MINGW_BYTES_PER_COMPILE_JOB) - 1
  return Math.max(1, Math.min(cores, memoryBudget))
}

module.exports = {
  MINGW_EXPECTED_CTESTS,
  findStaleCTestRegistrations,
  prepareMingwCmakeEnvironment,
  prepareMingwBuildLayout,
  resolveMingwBuildJobs,
  resolveMingwEnvironment,
  resolveMingwBuildLayout,
  validateMingwCTestRegistration,
  validateMingwNativeDependencyConfiguration,
  validateMingwBuildCommands,
  validateMingwToolchain
}
