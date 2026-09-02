const { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { assertX64Pe } = require('./verify-release-artifacts.cjs')
const {
  resolveVst3MsvcBuildDirectory,
  resolveVst3MsvcEnvironment
} = require('./vst3-msvc-toolchain.cjs')

const root = resolve(__dirname, '..')
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('VST3 helpers can only be staged on Windows x64.')
  process.exit(1)
}
const environment = resolveVst3MsvcEnvironment()
const outputDir = join(root, 'resources', 'audio-engine')
const argumentIndex = process.argv.indexOf('--build-dir')
const buildDir =
  argumentIndex >= 0 && process.argv[argumentIndex + 1]
    ? resolve(process.argv[argumentIndex + 1])
    : resolveVst3MsvcBuildDirectory(environment, root)

const files = ['twilight-vst3-scanner.exe', 'twilight-vst3-host.exe']
const candidates = [join(buildDir, 'bin', 'Release'), join(buildDir, 'Release')]
const sourceDir = candidates.find((directory) =>
  files.every((file) => existsSync(join(directory, file)))
)
if (!sourceDir) {
  console.error(`VST3 helper executables were not found under:\n${candidates.join('\n')}`)
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })
for (const file of files) {
  const source = join(sourceDir, file)
  assertX64Pe(source)
  const destination = join(outputDir, file)
  copyFileSync(source, destination)
  console.log(`Staged ${file} (${(statSync(destination).size / 1024 / 1024).toFixed(1)} MiB)`)
}

const msvcInstallRoot = environment.TAE_VST3_MSVC_INSTALL_ROOT
  ? resolve(environment.TAE_VST3_MSVC_INSTALL_ROOT)
  : ''
const runtimeFiles = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
const runtimeRoot = msvcInstallRoot ? join(msvcInstallRoot, 'VC', 'Redist', 'MSVC') : ''
const runtimeDir =
  runtimeRoot && existsSync(runtimeRoot)
    ? readdirSync(runtimeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(runtimeRoot, entry.name, 'x64', 'Microsoft.VC143.CRT'))
        .find((directory) => runtimeFiles.every((file) => existsSync(join(directory, file))))
    : ''

if (!runtimeDir) {
  console.error('Unable to find the x64 Microsoft VC runtime beside the configured Build Tools.')
  console.error('Set TAE_VST3_MSVC_INSTALL_ROOT before staging VST3 helpers.')
  process.exit(1)
}

for (const file of runtimeFiles) {
  const source = join(runtimeDir, file)
  assertX64Pe(source)
  const destination = join(outputDir, file)
  copyFileSync(source, destination)
  console.log(`Staged ${file} (${(statSync(destination).size / 1024 / 1024).toFixed(1)} MiB)`)
}
