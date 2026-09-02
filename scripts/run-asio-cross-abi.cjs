const { existsSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  prepareMingwCmakeEnvironment,
  prepareMingwBuildLayout,
  resolveMingwEnvironment
} = require('./audio-engine-toolchain.cjs')
const {
  cmakeCachePath,
  prepareAsioMsvcNinjaToolchain,
  resolveAsioMsvcBuildDirectory,
  resolveAsioMsvcEnvironment
} = require('./asio-msvc-toolchain.cjs')
const { verifyAsioAbiManifests } = require('./verify-asio-abi-manifest.cjs')

const root = resolve(__dirname, '..')

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env, windowsHide: true })
  return result.status ?? 1
}

if (process.platform !== 'win32') {
  console.error('ASIO cross-compiler ABI validation can only run on Windows.')
  process.exit(1)
}

const msvcEnvironment = resolveAsioMsvcEnvironment()
const msvcToolchain = prepareAsioMsvcNinjaToolchain({ env: msvcEnvironment })
if (!msvcToolchain.ok) {
  console.error(msvcToolchain.message)
  process.exit(1)
}
const msvcBuildDir = resolveAsioMsvcBuildDirectory(msvcEnvironment, root)
mkdirSync(msvcBuildDir, { recursive: true })
const fixtureSource = join(root, 'audio-engine', 'tests', 'asio-abi-fixture')
if (
  run(
    msvcToolchain.cmakePath,
    [
      '-S',
      fixtureSource,
      '-B',
      msvcBuildDir,
      '-G',
      'Ninja',
      `-DCMAKE_MAKE_PROGRAM=${cmakeCachePath(msvcToolchain.ninjaPath)}`,
      '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_RC_COMPILER=${cmakeCachePath(msvcToolchain.rcPath)}`
    ],
    msvcToolchain.environment
  ) !== 0
)
  process.exit(1)
if (run(msvcToolchain.cmakePath, ['--build', msvcBuildDir], msvcToolchain.environment) !== 0)
  process.exit(1)

const mingwEnvironment = resolveMingwEnvironment()
const mingwLayout = prepareMingwBuildLayout({ root, env: mingwEnvironment })
if (!mingwLayout.ok) {
  console.error(mingwLayout.message)
  process.exit(1)
}
const mingwPreflight = prepareMingwCmakeEnvironment({
  buildDir: mingwLayout.buildDir,
  env: mingwEnvironment
})
if (!mingwPreflight.ok) {
  console.error(mingwPreflight.message)
  process.exit(1)
}
if (
  run(
    process.execPath,
    [join(root, 'scripts', 'configure-audio-engine-mingw.cjs')],
    mingwPreflight.environment
  ) !== 0
)
  process.exit(1)
if (run('cmake', ['--build', mingwLayout.buildDir], mingwPreflight.environment) !== 0)
  process.exit(1)

const msvcManifest = join(msvcBuildDir, 'twilight_asio_abi_manifest.exe')
const fakeDriver = join(msvcBuildDir, 'twilight_asio_fake_driver.dll')
const mingwManifest = join(mingwLayout.buildDir, 'twilight_asio_abi_manifest.exe')
for (const artifact of [msvcManifest, fakeDriver, mingwManifest]) {
  if (!existsSync(artifact)) {
    console.error(`ASIO cross-compiler ABI artifact is missing: ${artifact}`)
    process.exit(1)
  }
}

const manifestResult = verifyAsioAbiManifests({
  goldenPath: join(root, 'audio-engine', 'output', 'asio', 'abi', 'asio-abi-manifest.json'),
  manifestPaths: [msvcManifest, mingwManifest]
})
if (!manifestResult.ok) {
  console.error(manifestResult.message)
  process.exit(1)
}

const crossResult = spawnSync(
  'ctest',
  [
    '--test-dir',
    mingwLayout.buildDir,
    '--output-on-failure',
    '-R',
    '^twilight_asio_abi_cross_dll$'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...mingwPreflight.environment, TAE_ASIO_FAKE_DRIVER_PATH: fakeDriver },
    windowsHide: true
  }
)
process.exit(crossResult.status ?? 1)
