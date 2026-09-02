const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { verifyPackagedDependencyClosure } = require('./verify-packaged-dependency-closure.cjs')
const { verifyWindowsAppBranding } = require('./verify-windows-app-branding.cjs')
const { preparePackagedAudioStaging } = require('./packaged-audio-staging.cjs')
const { prepareVst3Msvc } = require('./prepare-vst3-msvc.cjs')

const root = path.resolve(__dirname, '..')
const electronBuilder = require.resolve('electron-builder/out/cli/cli.js')

function targetsWindows(args) {
  if (args.includes('--linux') || args.includes('--mac')) return false
  return args.includes('--win') || (process.platform === 'win32' && args.includes('--dir'))
}

function run(args, environment = process.env) {
  return spawnSync(process.execPath, [electronBuilder, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...environment, TWILIGHT_PACKAGE_STRIP: '1' }
  })
}

function main(args = process.argv.slice(2)) {
  const windowsPackage = targetsWindows(args)
  if (windowsPackage && process.platform !== 'win32') {
    throw new Error('Windows packaging with VST3 helpers must run on Windows x64.')
  }
  if (windowsPackage) prepareVst3Msvc({ root })
  const staging = windowsPackage ? preparePackagedAudioStaging(root) : null
  let result
  try {
    result = run(staging ? [...args, '--config', staging.configPath] : args, {
      ...process.env,
      TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED: staging ? '1' : '0'
    })
  } finally {
    staging?.dispose()
  }
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
  const packagedAsar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')
  if (process.platform === 'win32') {
    const unpackedApp = path.join(root, 'dist', 'win-unpacked')
    const branding = verifyWindowsAppBranding(unpackedApp)
    console.log(`Windows executable branding verified: ${branding.productName}`)
  }
  if (process.platform === 'win32' && fs.existsSync(packagedAsar)) {
    const verified = verifyPackagedDependencyClosure(packagedAsar)
    console.log(`Packaged dependency closure verified: ${verified.packages} packages`)
  }
}

if (require.main === module) main()

module.exports = { electronBuilder, main, run }
