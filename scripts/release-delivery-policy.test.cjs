const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('release configuration is intentionally unsigned and does not advertise a placeholder updater', () => {
  const builder = read('electron-builder.yml')
  assert.doesNotMatch(builder, /example\.com\/auto-updates/)
  assert.doesNotMatch(builder, /^publish:/m)
  assert.match(builder, /^win:\s*$/m)
  assert.doesNotMatch(builder, /^\s+forceCodeSigning:/m)
  assert.match(builder, /^\s+signAndEditExecutable:\s*false\s*$/m)
  assert.equal(fs.existsSync(path.join(root, 'electron-builder.release-win.yml')), false)
})

test('Windows packaging strips copied native binaries while unsigned releases stay fail-closed', () => {
  const afterPack = read('scripts/after-pack-windows.cjs')
  const packageBuild = read('scripts/build-app-package.cjs')
  const releaseBuild = read('scripts/build-windows-release.cjs')
  const audioStaging = read('scripts/packaged-audio-staging.cjs')
  const lifecycle = read('src/main/app/lifecycle.ts')
  assert.match(afterPack, /process\.env\.TWILIGHT_RELEASE_BUILD === '1'/)
  assert.match(afterPack, /process\.env\.TWILIGHT_PACKAGE_STRIP === '1'/)
  assert.match(afterPack, /--set-icon/)
  assert.match(afterPack, /FileDescription/)
  assert.match(afterPack, /ProductName/)
  assert.match(afterPack, /TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED/)
  assert.match(audioStaging, /NATIVE_RUNTIME_FILES\.includes\(name\)/)
  assert.match(audioStaging, /stripNativeFile\(workingPath\)/)
  assert.match(audioStaging, /createAudioCapabilityManifest/)
  assert.match(audioStaging, /createReleaseCapabilityStatus/)
  assert.match(audioStaging, /readStagedAudioRuntimeObservation/)
  assert.match(audioStaging, /stagedVst3Files/)
  assert.match(packageBuild, /TWILIGHT_PACKAGE_STRIP: '1'/)
  assert.match(packageBuild, /prepareSmtcMsvc/)
  assert.match(packageBuild, /prepareVst3Msvc/)
  assert.match(packageBuild, /preparePackagedAudioStaging/)
  assert.match(packageBuild, /targetsWindows/)
  assert.match(packageBuild, /verifyWindowsAppBranding/)
  assert.match(releaseBuild, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/)
  assert.match(releaseBuild, /TWILIGHT_RELEASE_BUILD: '1'/)
  assert.match(releaseBuild, /TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED: '1'/)
  assert.match(releaseBuild, /prepareSmtcMsvc/)
  assert.match(releaseBuild, /prepareVst3Msvc/)
  assert.match(releaseBuild, /preparePackagedAudioStaging/)
  assert.doesNotMatch(releaseBuild, /--require-signature/)
  assert.match(releaseBuild, /verifyWindowsAppBranding/)
  assert.match(releaseBuild, /verifyPackagedDependencyClosure/)
  assert.match(releaseBuild, /findInstaller/)
  assert.match(releaseBuild, /createHash\('sha256'\)/)
  assert.match(releaseBuild, /\.sha256/)
  assert.ok(lifecycle.indexOf("app.setName('TwilightEcho')") < lifecycle.indexOf('app.whenReady()'))
  assert.ok(
    lifecycle.indexOf('electronApp.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)') <
      lifecycle.indexOf('app.whenReady()')
  )
})

test('Linux packaging fails closed when native engine artifacts are missing', () => {
  const afterPack = read('scripts/after-pack-linux.cjs')
  assert.match(
    afterPack,
    /const runtimeFiles = \['libtwilight-audio-engine\.so', 'twilight_audio_node\.node'\]/
  )
  assert.match(
    afterPack,
    /if \(!existsSync\(source\)\) \{\s*throw new Error\(`\[after-pack-linux\] Missing required native artifact:/
  )
})

test('release packaging writes an SHA-256 companion file for the installer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-release-checksum-'))
  try {
    const installer = path.join(root, 'TwilightEcho-1.0.2-setup.exe')
    fs.writeFileSync(installer, 'twilight-release')
    const { writeInstallerChecksum } = require('./build-windows-release.cjs')
    const checksumPath = await writeInstallerChecksum(installer)
    assert.equal(checksumPath, `${installer}.sha256`)
    const expected = createHash('sha256').update('twilight-release').digest('hex')
    assert.equal(
      fs.readFileSync(checksumPath, 'utf8'),
      `${expected}  TwilightEcho-1.0.2-setup.exe\n`
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Windows packages use maximum compression', () => {
  const builder = read('electron-builder.yml')
  assert.match(builder, /^compression:\s*maximum\s*$/m)
  assert.match(builder, /^electronLanguages:\s*\n\s+- zh-CN\s*\n\s+- zh-TW\s*\n\s+- en-US\s*$/m)
  assert.doesNotMatch(builder, /^\s+- node_modules\/\*\*\s*$/m)
  assert.doesNotMatch(builder, /^\s+include:\s*build\/installer\.nsh\s*$/m)
})

test('update checks download GitHub release installers without electron-updater', () => {
  const projectUrls = read('src/shared/projectUrls.ts')
  const updater = read('src/main/ipc/appIpc.ts')
  const service = read('src/main/app/appUpdateService.ts')
  assert.match(projectUrls, /export const GITHUB_OWNER = 'asenyarzc-cpu'/)
  assert.match(projectUrls, /export const GITHUB_REPO = 'Twilight_Echo'/)
  assert.match(
    projectUrls,
    /GITHUB_API_LATEST_RELEASE_URL = `https:\/\/api\.github\.com\/repos\/\$\{GITHUB_OWNER\}\/\$\{GITHUB_REPO\}\/releases\/latest`/
  )
  assert.match(projectUrls, /GITHUB_API_RELEASES_URL/)
  assert.match(projectUrls, /RELEASES_URL = `\$\{GITHUB_URL\}\/releases`/)
  assert.match(updater, /checkForAppUpdate/)
  assert.match(updater, /downloadAppUpdate/)
  assert.match(updater, /installDownloadedAppUpdate/)
  assert.doesNotMatch(updater, /autoUpdater/)
  assert.doesNotMatch(service, /electron-updater/)
  assert.doesNotMatch(service, /autoUpdater/)
  assert.match(service, /shell\.openPath/)
  assert.match(service, /createHash\('sha256'\)/)
  assert.match(service, /error: 'no-checksum'/)
  assert.match(service, /pickLatestAvailableRelease/)
  assert.match(service, /extractAssetDigestSha256/)
  assert.match(service, /GitHub Release 未提供 Windows 安装包的 SHA-256 校验和/)
  const settingsTypes = read('src/renderer/src/components/settings-page/types.ts')
  const about = read('src/renderer/src/components/settings-page/AboutSettingsSection.vue')
  assert.match(settingsTypes, /from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/projectUrls\.ts'/)
  assert.match(settingsTypes, /RELEASES_URL/)
  assert.match(about, /下载更新/)
  assert.match(about, /安装并退出/)
  assert.match(about, /点击检查更新/)
})

test('release docs keep non-Windows audio backends explicitly unverified', () => {
  const readme = read('README.md')
  assert.match(readme, /macOS 与 Linux 后端已有实现，但尚未达到正式发布验证标准/)
  assert.match(
    readme,
    /CoreAudio 与 ALSA 后端已存在，但目前没有经过与 Windows 同等级别的发布和真实设备验证/
  )
  assert.doesNotMatch(readme, /macOS 与 Linux 的原生音频引擎仍在验证阶段（代码已 release-ready/)
})
