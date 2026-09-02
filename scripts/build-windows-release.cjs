const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { writeFile } = require('node:fs/promises')
const path = require('node:path')
const { findInstaller } = require('./verify-release-artifacts.cjs')
const { verifyPackagedDependencyClosure } = require('./verify-packaged-dependency-closure.cjs')
const { verifyWindowsAppBranding } = require('./verify-windows-app-branding.cjs')
const { preparePackagedAudioStaging } = require('./packaged-audio-staging.cjs')
const { prepareVst3Msvc } = require('./prepare-vst3-msvc.cjs')
const {
  verifyReleaseCapabilityConsistency
} = require('./verify-release-capability-consistency.cjs')
const packageMetadata = require('../package.json')

const root = path.resolve(__dirname, '..')
const electronBuilder = require.resolve('electron-builder/out/cli/cli.js')
const expectedInstaller = path.join(
  root,
  'dist',
  `${packageMetadata.name}-${packageMetadata.version}-setup.exe`
)

function run(command, args, environment = process.env) {
  return spawnSync(command, args, { cwd: root, stdio: 'inherit', env: environment })
}

async function writeInstallerChecksum(installerPath = expectedInstaller) {
  const installer = findInstaller({ artifactDir: '', installer: installerPath })
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer)) hash.update(chunk)
  const checksumPath = `${installer}.sha256`
  const checksum = `${hash.digest('hex')}  ${path.basename(installer)}\n`
  await writeFile(checksumPath, checksum, 'utf8')
  console.log(`Wrote release checksum: ${checksumPath}`)
  return checksumPath
}

async function main() {
  const releaseEnvironment = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    TWILIGHT_RELEASE_BUILD: '1',
    TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED: '1'
  }
  delete releaseEnvironment.CSC_LINK
  delete releaseEnvironment.WIN_CSC_LINK
  delete releaseEnvironment.CSC_KEY_PASSWORD
  delete releaseEnvironment.WIN_CSC_KEY_PASSWORD

  console.warn(
    'Windows release is intentionally unsigned; publish the generated SHA-256 and expect SmartScreen warnings.'
  )
  prepareVst3Msvc({ root, environment: releaseEnvironment })
  const staging = preparePackagedAudioStaging(root)
  let build
  try {
    build = run(
      process.execPath,
      [electronBuilder, '--win', '--config', staging.configPath],
      releaseEnvironment
    )
  } finally {
    staging.dispose()
  }
  if (build.error) throw build.error
  if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1)
  const branding = verifyWindowsAppBranding(path.join(root, 'dist', 'win-unpacked'))
  console.log(`Windows executable branding verified: ${branding.productName}`)
  const packagedAsar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')
  const dependencyClosure = verifyPackagedDependencyClosure(packagedAsar)
  console.log(`Packaged dependency closure verified: ${dependencyClosure.packages} packages`)
  const verify = run(process.execPath, [
    path.join(root, 'scripts', 'verify-release-artifacts.cjs'),
    '--native-dir',
    path.join(root, 'dist', 'win-unpacked', 'resources', 'audio-engine'),
    '--installer',
    expectedInstaller
  ])
  if (verify.error) throw verify.error
  if ((verify.status ?? 1) !== 0) process.exit(verify.status ?? 1)
  verifyReleaseCapabilityConsistency({
    nativeDir: path.join(root, 'dist', 'win-unpacked', 'resources', 'audio-engine'),
    declaration: path.join(root, 'docs', 'release-capability-status.md')
  })
  await writeInstallerChecksum(expectedInstaller)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

module.exports = { electronBuilder, expectedInstaller, main, run, writeInstallerChecksum }
