const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  if (
    (process.env.TWILIGHT_RELEASE_BUILD === '1' || process.env.TWILIGHT_PACKAGE_STRIP === '1') &&
    process.env.TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED !== '1'
  ) {
    throw new Error('Packaged audio staging was not prepared before electron-builder started')
  }

  const appInfo = context.packager.appInfo
  const productName = appInfo.productName || 'TwilightEcho'
  const version = appInfo.version || '1.0.0'
  const exeName = `${context.packager.platformSpecificBuildOptions.executableName || productName}.exe`
  const exePath = join(context.appOutDir, exeName)
  const iconPath = join(context.packager.projectDir, 'build', 'icon.ico')
  const rceditPath = join(
    context.packager.projectDir,
    'node_modules',
    'electron-winstaller',
    'vendor',
    'rcedit.exe'
  )

  for (const [label, path] of [
    ['Windows executable', exePath],
    ['Windows icon', iconPath],
    ['rcedit', rceditPath]
  ]) {
    if (!existsSync(path)) throw new Error(`${label} not found: ${path}`)
  }

  const result = spawnSync(
    rceditPath,
    [
      exePath,
      '--set-icon',
      iconPath,
      '--set-file-version',
      version,
      '--set-product-version',
      version,
      '--set-version-string',
      'FileDescription',
      productName,
      '--set-version-string',
      'ProductName',
      productName,
      '--set-version-string',
      'OriginalFilename',
      exeName,
      '--set-version-string',
      'InternalName',
      productName,
      '--set-version-string',
      'CompanyName',
      appInfo.companyName || appInfo.author || productName
    ],
    { encoding: 'utf8' }
  )

  if (result.status !== 0) {
    throw new Error(
      [
        `Failed to write Windows executable metadata with rcedit (exit ${result.status})`,
        result.stdout,
        result.stderr
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
}
