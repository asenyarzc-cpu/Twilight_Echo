'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, shell } = require('electron')

const APP_ID = 'com.TwilightEcho.music'
const root = path.resolve(__dirname, '..')

app.setName('TwilightEcho')
app.setAppUserModelId(APP_ID)

app.whenReady().then(() => {
  const programs = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs'
  )
  const shortcutPath = path.join(programs, 'TwilightEcho.lnk')
  fs.mkdirSync(programs, { recursive: true })

  const icon = path.join(root, 'build', 'icon.ico')
  const details = {
    target: process.execPath,
    cwd: root,
    args: `"${root.replaceAll('"', '\\"')}"`,
    description: 'Twilight Echo music player',
    icon: fs.existsSync(icon) ? icon : process.execPath,
    iconIndex: 0,
    appUserModelId: APP_ID
  }
  const operation = fs.existsSync(shortcutPath) ? 'replace' : 'create'
  if (!shell.writeShortcutLink(shortcutPath, operation, details)) {
    throw new Error(`Failed to write Start Menu shortcut: ${shortcutPath}`)
  }

  const registered = shell.readShortcutLink(shortcutPath)
  if (registered.appUserModelId !== APP_ID) {
    throw new Error(`Shortcut AppUserModelID mismatch: ${registered.appUserModelId || '<empty>'}`)
  }
  console.log(`Windows app identity shortcut: ${shortcutPath}`)
  console.log(`Windows app identity AUMID: ${registered.appUserModelId}`)
  app.quit()
})

process.on('uncaughtException', (error) => {
  console.error(error)
  process.exitCode = 1
  app.quit()
})

process.on('unhandledRejection', (error) => {
  console.error(error)
  process.exitCode = 1
  app.quit()
})
