'use strict'

const path = require('node:path')
const { app, BrowserWindow } = require('electron')

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function nativeWindowHandleToNumber(handle) {
  if (!Buffer.isBuffer(handle) || handle.length < 4) return undefined
  const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return Number(value)
}

const addonPath = path.resolve(
  readArg('--addon') ||
    path.join('audio-engine', 'build', 'smtc-msvc-x64', 'Release', 'twilight_smtc_node.node')
)
const holdMs = Math.max(250, Number(readArg('--hold-ms')) || 250)

app.setName('TwilightEcho')
app.setAppUserModelId('com.TwilightEcho.music')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 320, height: 200 })
  const handle = nativeWindowHandleToNumber(win.getNativeWindowHandle())
  if (!handle) throw new Error('Electron BrowserWindow did not expose a usable HWND')

  const addon = require(addonPath)
  if (typeof addon.SelfTest !== 'function' || addon.SelfTest() !== true) {
    throw new Error('SMTC addon self-test failed')
  }
  const created = addon.Create(() => {}, handle, 'com.TwilightEcho.music')
  console.log(`SMTC Electron HWND smoke: Create=${created} HWND=${handle}`)
  if (!created) throw new Error(addon.GetLastError?.() || 'SMTC Create() returned false')

  addon.Update({
    enabled: true,
    hasTrack: true,
    isPlaying: false,
    isLoading: false,
    canNext: true,
    canPrevious: true,
    shuffle: false,
    autoRepeatMode: 0,
    positionSeconds: 5,
    durationSeconds: 60,
    playbackRate: 1,
    title: 'Twilight Echo SMTC HWND Smoke',
    artist: 'Twilight Echo',
    album: 'Native Integration',
    albumArtist: 'Twilight Echo',
    trackNumber: 1,
    coverUri: ''
  })

  await new Promise((resolve) => setTimeout(resolve, holdMs))
  addon.Destroy()
  win.destroy()
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
