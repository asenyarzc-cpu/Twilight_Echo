const { mkdirSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const {
  resolveVst3MsvcBuildDirectory,
  resolveVst3MsvcEnvironment,
  validateVst3MsvcToolchain
} = require('./vst3-msvc-toolchain.cjs')

const root = resolve(__dirname, '..')
const environment = resolveVst3MsvcEnvironment()
const sourceDir = join(root, 'audio-engine', 'vst3')
const buildDir = resolveVst3MsvcBuildDirectory(environment, root)

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (process.platform !== 'win32') fail('VST3 helpers can only be configured on Windows.')
const toolchain = validateVst3MsvcToolchain({ env: environment })
if (!toolchain.ok) fail(toolchain.message)
const { sdkRoot, installRoot } = toolchain

mkdirSync(buildDir, { recursive: true })
const result = spawnSync(
  'cmake',
  [
    '-S',
    sourceDir,
    '-B',
    buildDir,
    '-G',
    'Visual Studio 17 2022',
    '-A',
    'x64',
    `-DCMAKE_GENERATOR_INSTANCE=${installRoot}`,
    `-DTAE_VST3_SDK_ROOT=${sdkRoot}`
  ],
  { cwd: root, stdio: 'inherit', env: environment }
)
process.exit(result.status ?? 1)
