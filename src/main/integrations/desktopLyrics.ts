import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { runtime } from '../core/runtime'
import type { DesktopLyricsSettings } from '../core/types'
import type { DesktopLyricsTrackPayload } from '../../shared/lyricsManagement.ts'
import { resolveDesktopLyricsFontFamily } from '../../shared/desktopLyricsFont.ts'
import { createSettingsSnapshot, normalizeDesktopLyrics, writeAppSettings } from '../core/settings'
import { assertTrustedIpcSender, shouldAcceptIpcEvent } from '../security/electronSecurity.ts'

let moveSaveTimer: NodeJS.Timeout | null = null
let hoverWatchTimer: NodeJS.Timeout | null = null
let temporarilyInteractive = false
let lastHoverIntent = false

function clearMoveSaveTimer(): void {
  if (!moveSaveTimer) return
  clearTimeout(moveSaveTimer)
  moveSaveTimer = null
}

function stopLockedHoverWatch(): void {
  if (!hoverWatchTimer) return
  clearInterval(hoverWatchTimer)
  hoverWatchTimer = null
  lastHoverIntent = false
}

function sendHoverIntent(over: boolean): void {
  const win = runtime.desktopLyricsWindow
  if (!win || win.isDestroyed()) return
  if (lastHoverIntent === over) return
  lastHoverIntent = over
  win.webContents.send('desktopLyrics:hoverIntent', over)
}

function pollLockedCursor(): void {
  const win = runtime.desktopLyricsWindow
  if (!win || win.isDestroyed()) {
    stopLockedHoverWatch()
    temporarilyInteractive = false
    return
  }
  if (!runtime.appSettings.desktopLyrics.locked) {
    if (temporarilyInteractive) {
      temporarilyInteractive = false
      applyDesktopLyricsMouseMode()
    }
    sendHoverIntent(false)
    return
  }
  const point = screen.getCursorScreenPoint()
  const bounds = win.getBounds()
  const over =
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  if (over !== temporarilyInteractive) {
    temporarilyInteractive = over
    applyDesktopLyricsMouseMode()
  }
  sendHoverIntent(over)
}

function startLockedHoverWatch(): void {
  if (hoverWatchTimer) return
  pollLockedCursor()
  hoverWatchTimer = setInterval(pollLockedCursor, 80)
}

function syncLockedHoverWatch(): void {
  const win = runtime.desktopLyricsWindow
  if (!win || win.isDestroyed() || !runtime.appSettings.desktopLyrics.locked) {
    stopLockedHoverWatch()
    return
  }
  startLockedHoverWatch()
}

function persistDesktopLyricsPosition(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const [px, py] = win.getPosition()
  runtime.appSettings.desktopLyrics.windowX = px
  runtime.appSettings.desktopLyrics.windowY = py
  writeAppSettings(runtime.appSettings)
}

function applyDesktopLyricsMouseMode(): void {
  const win = runtime.desktopLyricsWindow
  if (!win || win.isDestroyed()) return
  const shouldIgnoreMouseEvents =
    runtime.appSettings.desktopLyrics.locked && !temporarilyInteractive
  win.setIgnoreMouseEvents(shouldIgnoreMouseEvents, { forward: true })
}

export function getEffectiveDesktopLyricsSettings(): DesktopLyricsSettings {
  const settings = runtime.appSettings.desktopLyrics
  return {
    ...settings,
    resolvedFontFamily: resolveDesktopLyricsFontFamily(
      settings.fontFamily,
      runtime.appSettings.lyricsAppearance.styles.active
    )
  }
}

export function syncDesktopLyricsSettings(): void {
  const win = runtime.desktopLyricsWindow
  if (!win || win.isDestroyed()) return

  const settings = runtime.appSettings.desktopLyrics
  win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver')
  applyDesktopLyricsMouseMode()
  syncLockedHoverWatch()
  if (
    settings.windowWidth !== win.getBounds().width ||
    settings.windowHeight !== win.getBounds().height
  ) {
    win.setSize(settings.windowWidth, settings.windowHeight)
  }
  win.webContents.send('desktopLyrics:initSettings', getEffectiveDesktopLyricsSettings())
}

function sendDesktopLyricsSnapshot(): void {
  if (!runtime.desktopLyricsWindow || runtime.desktopLyricsWindow.isDestroyed()) return

  runtime.desktopLyricsWindow.webContents.send(
    'desktopLyrics:initSettings',
    getEffectiveDesktopLyricsSettings()
  )
  if (runtime.latestDesktopLyricsTrack) {
    runtime.desktopLyricsWindow.webContents.send(
      'desktopLyrics:updateTrack',
      runtime.latestDesktopLyricsTrack
    )
  }
  runtime.desktopLyricsWindow.webContents.send(
    'desktopLyrics:updateTime',
    runtime.latestDesktopLyricsTime
  )
}

function createDesktopLyricsWindow(): void {
  if (runtime.desktopLyricsWindow && !runtime.desktopLyricsWindow.isDestroyed()) return

  const dl = runtime.appSettings.desktopLyrics
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
  const x = dl.windowX >= 0 ? dl.windowX : Math.round((screenWidth - dl.windowWidth) / 2)
  const y = dl.windowY >= 0 ? dl.windowY : screenHeight - dl.windowHeight - 60

  runtime.desktopLyricsWindow = new BrowserWindow({
    width: dl.windowWidth,
    height: dl.windowHeight,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: dl.alwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  runtime.desktopLyricsWindow.setAlwaysOnTop(dl.alwaysOnTop, 'screen-saver')
  applyDesktopLyricsMouseMode()
  syncLockedHoverWatch()

  runtime.desktopLyricsWindow.on('ready-to-show', () => {
    runtime.desktopLyricsWindow?.show()
    sendDesktopLyricsSnapshot()
  })

  runtime.desktopLyricsWindow.on('closed', () => {
    clearMoveSaveTimer()
    stopLockedHoverWatch()
    temporarilyInteractive = false
    runtime.desktopLyricsWindow = null
  })

  runtime.desktopLyricsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  runtime.desktopLyricsWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  runtime.desktopLyricsWindow.on('move', () => {
    if (moveSaveTimer) clearTimeout(moveSaveTimer)
    moveSaveTimer = setTimeout(() => {
      moveSaveTimer = null
      if (!runtime.desktopLyricsWindow || runtime.desktopLyricsWindow.isDestroyed()) return
      persistDesktopLyricsPosition(runtime.desktopLyricsWindow)
    }, 500)
  })

  runtime.desktopLyricsWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription) => {
      console.error('[desktop-lyrics] load failed', errorCode, errorDescription)
      runtime.mainWindow?.webContents.send('desktopLyrics:loadFailed', {
        code: errorCode,
        description: errorDescription
      })
      hideDesktopLyrics()
    }
  )

  const desktopLyricsHtml = is.dev
    ? join(__dirname, '../../resources/desktop-lyrics.html')
    : join(__dirname, '../renderer/desktop-lyrics.html')
  runtime.desktopLyricsWindow.loadFile(desktopLyricsHtml)
}

export function showDesktopLyrics(): void {
  if (!runtime.desktopLyricsWindow || runtime.desktopLyricsWindow.isDestroyed()) {
    createDesktopLyricsWindow()
  } else {
    runtime.desktopLyricsWindow.show()
    sendDesktopLyricsSnapshot()
  }
}

export function destroyDesktopLyrics(): void {
  const win = runtime.desktopLyricsWindow
  clearMoveSaveTimer()
  stopLockedHoverWatch()
  temporarilyInteractive = false
  if (!win || win.isDestroyed()) {
    runtime.desktopLyricsWindow = null
    return
  }
  persistDesktopLyricsPosition(win)
  runtime.desktopLyricsWindow = null
  win.destroy()
}

export function hideDesktopLyrics(): void {
  destroyDesktopLyrics()
}

export function toggleDesktopLyrics(): boolean {
  const shouldShow = !runtime.appSettings.desktopLyrics.enabled
  runtime.appSettings.desktopLyrics.enabled = shouldShow
  writeAppSettings(runtime.appSettings)
  if (shouldShow) {
    showDesktopLyrics()
  } else {
    hideDesktopLyrics()
  }
  // Notify renderer
  runtime.mainWindow?.webContents.send('desktopLyrics:toggleChanged', shouldShow)
  runtime.refreshTrayMenu?.()
  return shouldShow
}

export function applyDesktopLyricsSettings(settings: DesktopLyricsSettings): void {
  const normalized = normalizeDesktopLyrics(settings)
  runtime.appSettings.desktopLyrics = normalized
  writeAppSettings(runtime.appSettings)
  syncDesktopLyricsSettings()
}

export function setupDesktopLyricsIpc(): void {
  ipcMain.on('desktopLyrics:setInteractive', (event, interactive: boolean) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC')) return
    if (
      !runtime.desktopLyricsWindow ||
      runtime.desktopLyricsWindow.isDestroyed() ||
      event.sender !== runtime.desktopLyricsWindow.webContents
    ) {
      return
    }
    temporarilyInteractive = interactive === true
    applyDesktopLyricsMouseMode()
  })

  // Forward track/time updates from renderer to lyrics window
  ipcMain.on('desktopLyrics:updateTrack', (_event, data: DesktopLyricsTrackPayload) => {
    if (!shouldAcceptIpcEvent(_event, 'desktop lyrics IPC')) return
    runtime.latestDesktopLyricsTrack = data
    if (runtime.desktopLyricsWindow && !runtime.desktopLyricsWindow.isDestroyed()) {
      runtime.desktopLyricsWindow.webContents.send('desktopLyrics:updateTrack', data)
    }
  })

  ipcMain.on('desktopLyrics:updateTime', (_event, time: number) => {
    if (!shouldAcceptIpcEvent(_event, 'desktop lyrics IPC')) return
    if (!Number.isFinite(time)) return
    runtime.latestDesktopLyricsTime = Math.max(0, time)
    if (runtime.desktopLyricsWindow && !runtime.desktopLyricsWindow.isDestroyed()) {
      runtime.desktopLyricsWindow.webContents.send(
        'desktopLyrics:updateTime',
        runtime.latestDesktopLyricsTime
      )
    }
  })

  ipcMain.on('desktopLyrics:updateSettings', (_event, settings: Partial<DesktopLyricsSettings>) => {
    if (!shouldAcceptIpcEvent(_event, 'desktop lyrics IPC')) return
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return
    const fromDesktopLyricsWindow =
      runtime.desktopLyricsWindow &&
      !runtime.desktopLyricsWindow.isDestroyed() &&
      _event.sender === runtime.desktopLyricsWindow.webContents
    applyDesktopLyricsSettings({ ...runtime.appSettings.desktopLyrics, ...settings })
    if (fromDesktopLyricsWindow) {
      runtime.mainWindow?.webContents.send(
        'settings:changed',
        createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
      )
    }
  })

  ipcMain.handle('desktopLyrics:toggle', async (event) => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    return toggleDesktopLyrics()
  })

  ipcMain.handle('desktopLyrics:show', async (event) => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    showDesktopLyrics()
  })

  ipcMain.handle('desktopLyrics:hide', async (event) => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    hideDesktopLyrics()
  })

  // Lyrics window → main: get current position (for drag start)
  ipcMain.on('desktopLyrics:getPosition', (event) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC')) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition()
      event.sender.send('desktopLyrics:position', { x, y })
    }
  })

  // Lyrics window → main: move window
  ipcMain.on('desktopLyrics:move', (event, data: { x: number; y: number }) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC')) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return
    const display = screen.getDisplayMatching(win.getBounds())
    const bounds = display.workArea
    const size = win.getBounds()
    const x = clampNumber(Math.round(data.x), bounds.x, bounds.x + bounds.width - size.width)
    const y = clampNumber(Math.round(data.y), bounds.y, bounds.y + bounds.height - size.height)
    win.setPosition(x, y)
  })

  // Lyrics window → main: request close (close button in toolbar)
  ipcMain.on('desktopLyrics:requestClose', (event) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC')) return
    runtime.appSettings.desktopLyrics.enabled = false
    writeAppSettings(runtime.appSettings)
    hideDesktopLyrics()
    runtime.mainWindow?.webContents.send('desktopLyrics:toggleChanged', false)
    runtime.refreshTrayMenu?.()
  })
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
