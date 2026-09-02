const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const {
  resolveVst3MsvcBuildDirectory,
  resolveVst3MsvcEnvironment
} = require('./vst3-msvc-toolchain.cjs')

const root = resolve(__dirname, '..')
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('VST3 helpers can only run on Windows x64.')
  process.exit(1)
}
const environment = resolveVst3MsvcEnvironment()
const buildDir = resolveVst3MsvcBuildDirectory(environment, root)
const action = process.argv[2]

if (!existsSync(join(buildDir, 'CMakeCache.txt'))) {
  console.error(`VST3 MSVC build directory is not configured: ${buildDir}`)
  console.error('Run pnpm run configure:vst3-msvc first.')
  process.exit(1)
}

const command =
  action === 'build'
    ? [
        'cmake',
        [
          '--build',
          buildDir,
          '--config',
          'Release',
          '--target',
          'twilight_vst3_scanner',
          'twilight_vst3_host'
        ]
      ]
    : action === 'test'
      ? ['ctest', ['--test-dir', buildDir, '-C', 'Release', '--output-on-failure']]
      : action === 'stage'
        ? [
            process.execPath,
            [join(root, 'scripts', 'stage-vst3-msvc.cjs'), '--build-dir', buildDir]
          ]
        : null

if (!command) {
  console.error('Usage: node scripts/run-vst3-msvc.cjs <build|test|stage>')
  process.exit(1)
}

const result = spawnSync(command[0], command[1], { cwd: root, stdio: 'inherit', env: environment })
process.exit(result.status ?? 1)
