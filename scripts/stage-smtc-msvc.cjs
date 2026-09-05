const { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')
const {
  resolveSmtcMsvcBuildDirectory,
  resolveSmtcMsvcEnvironment
} = require('./smtc-msvc-toolchain.cjs')

const root = resolve(__dirname, '..')
const environment = resolveSmtcMsvcEnvironment()
const outputDir = join(root, 'resources', 'audio-engine')
const argumentIndex = process.argv.indexOf('--build-dir')
const buildDir =
  argumentIndex >= 0 && process.argv[argumentIndex + 1]
    ? resolve(process.argv[argumentIndex + 1])
    : resolveSmtcMsvcBuildDirectory(environment, root)

const files = ['twilight_smtc_node.node']
const candidates = [join(buildDir, 'bin', 'Release'), join(buildDir, 'Release')]
const sourceDir = candidates.find((directory) =>
  files.every((file) => existsSync(join(directory, file)))
)
if (!sourceDir) {
  console.error(`SMTC addon was not found under:\n${candidates.join('\n')}`)
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })
for (const file of files) {
  const source = join(sourceDir, file)
  const destination = join(outputDir, file)
  try {
    copyFileSync(source, destination)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown'
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      console.error(`Unable to stage ${file}: ${destination} is currently in use.`)
      console.error(
        'Close the running Twilight Echo development app before staging. The fresh build output remains available under audio-engine/build/smtc-msvc-x64/Release.'
      )
      process.exit(1)
    }
    throw error
  }
  console.log(`Staged ${file} (${(statSync(destination).size / 1024 / 1024).toFixed(1)} MiB)`)
}

const msvcInstallRoot = environment.TAE_SMTC_MSVC_INSTALL_ROOT
  ? resolve(environment.TAE_SMTC_MSVC_INSTALL_ROOT)
  : environment.TAE_VST3_MSVC_INSTALL_ROOT
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
  console.error('Set TAE_SMTC_MSVC_INSTALL_ROOT before staging the SMTC addon.')
  process.exit(1)
}

for (const file of runtimeFiles) {
  const source = join(runtimeDir, file)
  const destination = join(outputDir, file)
  if (existsSync(destination)) {
    console.log(`Skipped ${file} (already staged)`)
    continue
  }
  copyFileSync(source, destination)
  console.log(`Staged ${file} (${(statSync(destination).size / 1024 / 1024).toFixed(1)} MiB)`)
}
