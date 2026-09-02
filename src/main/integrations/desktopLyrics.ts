import { BrowserWindow, ipcMain, powerMonitor, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  DESKTOP_LYRICS_MAX_CONTENT_BYTES,
  normalizeDesktopLyricsSettings,
  type DesktopLyricsBootstrap,
  type DesktopLyricsClockSnapshot,
  type DesktopLyricsLine,
  type DesktopLyricsSession,
  type DesktopLyricsSettingsV3,
  type DesktopLyricsTransportAction
} from '../../shared/desktopLyrics.ts'
import { resolveDesktopLyricsFontFamily } from '../../shared/desktopLyricsFont.ts'
import { runtime } from '../core/runtime'
import { createSettingsSnapshot, writeAppSettings } from '../core/settings'
import { assertTrustedIpcSender, shouldAcceptIpcEvent } from '../security/electronSecurity.ts'
import { stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'

let destroyingWindow = false
let resumeBound = false
let desktopLyricsInteractionActive = false
let desktopLyricsPausedHidden = false
let desktopLyricsHoverCheckTimer: ReturnType<typeof setInterval> | null = null
let desktopLyricsPointerInside = false

const DESKTOP_LYRICS_HOVER_CHECK_INTERVAL_MS = 120

function isMainSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return Boolean(
    runtime.mainWindow &&
    !runtime.mainWindow.isDestroyed() &&
    event.sender === runtime.mainWindow.webContents
  )
}

function isDesktopLyricsSender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
): boolean {
  return Boolean(
    runtime.desktopLyricsWindow &&
    !runtime.desktopLyricsWindow.isDestroyed() &&
    event.sender === runtime.desktopLyricsWindow.webContents
  )
}

function persistDesktopLyricsPosition(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const [windowX, windowY] = win.getPosition()
  runtime.appSettings.desktopLyrics = {
    ...runtime.appSettings.desktopLyrics,
    windowX,
    windowY
  }
  writeAppSettings(runtime.appSettings)
}

function windowPosition(): { x: number; y: number } {
  const settings = runtime.appSettings.desktopLyrics
  const requested = {
    x: Math.round(settings.windowX),
    y: Math.round(settings.windowY),
    width: settings.windowWidth,
    height: settings.windowHeight
  }
  const visible =
    !(requested.x === -1 && requested.y === -1) &&
    screen.getAllDisplays().some((display) => {
      const area = display.workArea
      const horizontal =
        Math.min(requested.x + requested.width, area.x + area.width) - Math.max(requested.x, area.x)
      const vertical =
        Math.min(requested.y + requested.height, area.y + area.height) -
        Math.max(requested.y, area.y)
      return horizontal >= 80 && vertical >= 48
    })
  if (visible) return { x: requested.x, y: requested.y }
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(area.x + (area.width - settings.windowWidth) / 2),
    y: Math.round(area.y + area.height - settings.windowHeight - 56)
  }
}

export function getEffectiveDesktopLyricsSettings(): DesktopLyricsSettingsV3 {
  const settings = runtime.appSettings.desktopLyrics
  return {
    ...settings,
    resolvedFontFamily: resolveDesktopLyricsFontFamily(
      settings.fontFamily,
      runtime.appSettings.lyricsAppearance.styles.active
    ),
    accentColor: runtime.appSettings.accentColor,
    motionPreference: runtime.appSettings.motionPreference
  }
}

function applyWindowSettings(): void {
  const win = runtime.desktopLyricsWindow
  if (!win || win.isDestroyed()) return
  const settings = runtime.appSettings.desktopLyrics
  win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver')
  const ignoreMouseEvents =
    desktopLyricsPausedHidden || (settings.locked && !desktopLyricsInteractionActive)
  win.setIgnoreMouseEvents(ignoreMouseEvents, { forward: ignoreMouseEvents })
  syncDesktopLyricsHoverTracking()
  const bounds = win.getBounds()
  if (bounds.width !== settings.windowWidth || bounds.height !== settings.windowHeight) {
    win.setSize(settings.windowWidth, settings.windowHeight)
  }
  const current = win.getPosition()
  const constrained = clampToCurrentDisplay(win, current[0], current[1])
  if (constrained.x !== current[0] || constrained.y !== current[1]) {
    win.setPosition(constrained.x, constrained.y)
    settings.windowX = constrained.x
    settings.windowY = constrained.y
    writeAppSettings(runtime.appSettings)
  }
}

function notifySettingsChanged(): void {
  const settings = getEffectiveDesktopLyricsSettings()
  applyWindowSettings()
  runtime.desktopLyricsWindow?.webContents.send('desktopLyrics:settingsChanged', settings)
  runtime.mainWindow?.webContents.send(
    'settings:changed',
    createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  )
  runtime.refreshTrayMenu?.(true)
}

function publishDesktopLyricsHoverIntent(pointerInside: boolean): void {
  runtime.desktopLyricsWindow?.webContents.send('desktopLyrics:hoverIntent', pointerInside)
}

function clearDesktopLyricsHoverTracking(): void {
  if (desktopLyricsHoverCheckTimer != null) {
    clearInterval(desktopLyricsHoverCheckTimer)
    desktopLyricsHoverCheckTimer = null
  }
  if (!desktopLyricsPointerInside) return
  desktopLyricsPointerInside = false
  publishDesktopLyricsHoverIntent(false)
}

function refreshDesktopLyricsHoverIntent(): void {
  const win = runtime.desktopLyricsWindow
  if (
    !win ||
    win.isDestroyed() ||
    !win.isVisible() ||
    desktopLyricsPausedHidden ||
    !runtime.appSettings.desktopLyrics.locked
  ) {
    clearDesktopLyricsHoverTracking()
    return
  }
  const bounds = win.getBounds()
  const point = screen.getCursorScreenPoint()
  const pointerInside =
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  if (pointerInside === desktopLyricsPointerInside) return
  desktopLyricsPointerInside = pointerInside
  publishDesktopLyricsHoverIntent(pointerInside)
}

function syncDesktopLyricsHoverTracking(): void {
  const win = runtime.desktopLyricsWindow
  const shouldTrack = Boolean(
    win &&
    !win.isDestroyed() &&
    win.isVisible() &&
    !desktopLyricsPausedHidden &&
    runtime.appSettings.desktopLyrics.locked
  )
  if (!shouldTrack) {
    clearDesktopLyricsHoverTracking()
    return
  }
  refreshDesktopLyricsHoverIntent()
  if (desktopLyricsHoverCheckTimer != null) return
  desktopLyricsHoverCheckTimer = setInterval(
    refreshDesktopLyricsHoverIntent,
    DESKTOP_LYRICS_HOVER_CHECK_INTERVAL_MS
  )
}

export function syncDesktopLyricsSettings(): void {
  notifySettingsChanged()
}

function updateDesktopLyricsSettings(
  patch: Partial<DesktopLyricsSettingsV3>
): DesktopLyricsSettingsV3 {
  const lockChanged = 'locked' in patch
  if (lockChanged) desktopLyricsInteractionActive = false
  runtime.appSettings.desktopLyrics = normalizeDesktopLyricsSettings(
    { ...runtime.appSettings.desktopLyrics, ...patch, version: 3 },
    { resetLegacy: false }
  )
  writeAppSettings(runtime.appSettings)
  notifySettingsChanged()
  if (lockChanged) publishDesktopLyricsHoverIntent(desktopLyricsPointerInside)
  return getEffectiveDesktopLyricsSettings()
}

function setDesktopLyricsInteractionActive(active: boolean): void {
  desktopLyricsInteractionActive = active && runtime.appSettings.desktopLyrics.locked
  applyWindowSettings()
}

function setDesktopLyricsPausedHidden(hidden: boolean): void {
  desktopLyricsPausedHidden = hidden
  if (hidden) desktopLyricsInteractionActive = false
  applyWindowSettings()
}

function clampToCurrentDisplay(win: BrowserWindow, x: number, y: number): { x: number; y: number } {
  const size = win.getBounds()
  const area = screen.getDisplayMatching({ ...size, x, y }).workArea
  return {
    x: Math.min(Math.max(Math.round(x), area.x), area.x + area.width - size.width),
    y: Math.min(Math.max(Math.round(y), area.y), area.y + area.height - size.height)
  }
}

function validWord(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  return (
    typeof value.text === 'string' &&
    value.text.length <= 4096 &&
    Number.isFinite(value.startMs) &&
    Number.isFinite(value.endMs) &&
    Number(value.endMs) >= Number(value.startMs)
  )
}

function validLine(raw: unknown): raw is DesktopLyricsLine {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  const words = value.words
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 160 &&
    typeof value.text === 'string' &&
    value.text.length <= 4096 &&
    (value.translation == null ||
      (typeof value.translation === 'string' && value.translation.length <= 4096)) &&
    (value.romanization == null ||
      (typeof value.romanization === 'string' && value.romanization.length <= 4096)) &&
    (value.startMs == null || Number.isFinite(value.startMs)) &&
    (value.endMs == null || Number.isFinite(value.endMs)) &&
    (words == null ||
      (Array.isArray(words) && words.length <= 512 && words.every((word) => validWord(word))))
  )
}

function validSession(raw: unknown): raw is DesktopLyricsSession {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  try {
    stringifyJsonForIpcStorage(raw, 'desktop lyrics session', DESKTOP_LYRICS_MAX_CONTENT_BYTES)
  } catch {
    return false
  }
  const value = raw as Record<string, unknown>
  const lines = value.lines
  const track = value.track
  const validTrack =
    track === null ||
    (typeof track === 'object' &&
      !Array.isArray(track) &&
      track !== null &&
      typeof (track as Record<string, unknown>).id === 'string' &&
      String((track as Record<string, unknown>).id).length <= 160 &&
      typeof (track as Record<string, unknown>).title === 'string' &&
      String((track as Record<string, unknown>).title).length <= 1024 &&
      typeof (track as Record<string, unknown>).artist === 'string' &&
      String((track as Record<string, unknown>).artist).length <= 1024)
  return (
    value.schemaVersion === 1 &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 160 &&
    Number.isSafeInteger(value.contentRevision) &&
    Number(value.contentRevision) >= 0 &&
    validTrack &&
    ['idle', 'loading', 'ready', 'empty', 'error'].includes(String(value.status)) &&
    Number.isFinite(value.lyricOffsetMs) &&
    Math.abs(Number(value.lyricOffsetMs)) <= 600000 &&
    Array.isArray(lines) &&
    lines.length <= 10000 &&
    lines.every((line) => validLine(line))
  )
}

function validClock(raw: unknown): raw is DesktopLyricsClockSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  return (
    value.schemaVersion === 1 &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 160 &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 0 &&
    Number.isSafeInteger(value.epoch) &&
    Number(value.epoch) >= 0 &&
    Number.isFinite(value.positionMs) &&
    Number(value.positionMs) >= 0 &&
    Number.isFinite(value.durationMs) &&
    Number(value.durationMs) >= 0 &&
    Number.isFinite(value.rate) &&
    Number(value.rate) >= 0.5 &&
    Number(value.rate) <= 2 &&
    ['idle', 'loading', 'playing', 'paused'].includes(String(value.state))
  )
}

function validQuickSettingsPatch(raw: unknown): raw is Partial<DesktopLyricsSettingsV3> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as Record<string, unknown>
  const keys = Object.keys(value)
  if (
    !keys.every((key) =>
      ['fontSize', 'palette', 'customActiveColor', 'translationVisible'].includes(key)
    )
  ) {
    return false
  }
  if (
    'fontSize' in value &&
    (!Number.isFinite(value.fontSize) || Number(value.fontSize) < 20 || Number(value.fontSize) > 64)
  )
    return false
  if (
    'palette' in value &&
    !['accent', 'sunset', 'twilight', 'warm', 'custom'].includes(String(value.palette))
  )
    return false
  if (
    'customActiveColor' in value &&
    (typeof value.customActiveColor !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(value.customActiveColor))
  )
    return false
  return !('translationVisible' in value) || typeof value.translationVisible === 'boolean'
}

function createDesktopLyricsWindow(): void {
  if (runtime.desktopLyricsWindow && !runtime.desktopLyricsWindow.isDestroyed()) return
  desktopLyricsPausedHidden = false
  const settings = runtime.appSettings.desktopLyrics
  const position = windowPosition()
  if (position.x !== settings.windowX || position.y !== settings.windowY) {
    settings.windowX = position.x
    settings.windowY = position.y
    writeAppSettings(runtime.appSettings)
  }
  const win = new BrowserWindow({
    width: settings.windowWidth,
    height: settings.windowHeight,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    alwaysOnTop: settings.alwaysOnTop,
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
  runtime.desktopLyricsWindow = win
  applyWindowSettings()
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('did-fail-load', (_event, code, description) => {
    runtime.mainWindow?.webContents.send('desktopLyrics:loadFailed', { code, description })
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    if (destroyingWindow || details.reason === 'clean-exit') return
    runtime.desktopLyricsWindow = null
    if (!runtime.appSettings.desktopLyrics.enabled || runtime.desktopLyricsCrashRestarts >= 1) {
      runtime.appSettings.desktopLyrics.enabled = false
      writeAppSettings(runtime.appSettings)
      runtime.mainWindow?.webContents.send('desktopLyrics:loadFailed', {
        code: -1,
        description: '桌面歌词渲染进程异常退出，已停止自动重启'
      })
      runtime.refreshTrayMenu?.(true)
      return
    }
    runtime.desktopLyricsCrashRestarts += 1
    setTimeout(() => {
      if (runtime.appSettings.desktopLyrics.enabled) createDesktopLyricsWindow()
    }, 250)
  })
  win.on('closed', () => {
    if (runtime.desktopLyricsWindow !== win) return
    runtime.desktopLyricsWindow = null
    desktopLyricsInteractionActive = false
    desktopLyricsPausedHidden = false
    clearDesktopLyricsHoverTracking()
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.searchParams.set('window', 'desktop-lyrics')
    void win.loadURL(rendererUrl.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'desktop-lyrics' }
    })
  }
}

export function showDesktopLyrics(): void {
  if (!runtime.desktopLyricsWindow || runtime.desktopLyricsWindow.isDestroyed()) {
    createDesktopLyricsWindow()
    return
  }
  runtime.desktopLyricsWindow.showInactive()
  syncDesktopLyricsHoverTracking()
}

export function destroyDesktopLyrics(): void {
  const win = runtime.desktopLyricsWindow
  if (!win || win.isDestroyed()) {
    runtime.desktopLyricsWindow = null
    return
  }
  destroyingWindow = true
  persistDesktopLyricsPosition(win)
  runtime.desktopLyricsWindow = null
  desktopLyricsInteractionActive = false
  desktopLyricsPausedHidden = false
  clearDesktopLyricsHoverTracking()
  win.destroy()
  destroyingWindow = false
}

export function setDesktopLyricsEnabled(enabled: boolean): boolean {
  if (enabled && !runtime.appSettings.desktopLyrics.enabled) {
    runtime.desktopLyricsCrashRestarts = 0
  }
  runtime.appSettings.desktopLyrics.enabled = enabled
  writeAppSettings(runtime.appSettings)
  if (enabled) showDesktopLyrics()
  else destroyDesktopLyrics()
  runtime.mainWindow?.webContents.send('desktopLyrics:enabledChanged', enabled)
  runtime.refreshTrayMenu?.(true)
  return enabled
}

export function toggleDesktopLyrics(): boolean {
  return setDesktopLyricsEnabled(!runtime.appSettings.desktopLyrics.enabled)
}

export function toggleDesktopLyricsLock(): boolean {
  const locked = !runtime.appSettings.desktopLyrics.locked
  updateDesktopLyricsSettings({ locked })
  return locked
}

export function requestDesktopLyricsResync(): void {
  runtime.desktopLyricsWindow?.webContents.send('desktopLyrics:freezeClock')
  runtime.mainWindow?.webContents.send('desktopLyrics:resyncRequested')
}

export function setupDesktopLyricsIpc(): void {
  if (!resumeBound) {
    resumeBound = true
    powerMonitor.on('resume', requestDesktopLyricsResync)
  }

  ipcMain.handle('desktopLyrics:setEnabled', (event, enabled: unknown) => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    if (!isMainSender(event)) throw new Error('desktop lyrics enable rejected from satellite')
    if (typeof enabled !== 'boolean') throw new Error('invalid desktop lyrics enabled state')
    return setDesktopLyricsEnabled(enabled)
  })

  ipcMain.handle('desktopLyrics:bootstrap', (event): DesktopLyricsBootstrap => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    if (!isDesktopLyricsSender(event)) throw new Error('desktop lyrics bootstrap rejected')
    return {
      settings: getEffectiveDesktopLyricsSettings(),
      session: runtime.latestDesktopLyricsSession,
      clock: runtime.latestDesktopLyricsClock
    }
  })

  ipcMain.handle('desktopLyrics:updateQuickSettings', (event, patch: unknown) => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    if (!isDesktopLyricsSender(event)) throw new Error('desktop lyrics settings rejected')
    if (!validQuickSettingsPatch(patch)) {
      throw new Error('invalid desktop lyrics settings patch')
    }
    return updateDesktopLyricsSettings(patch)
  })

  ipcMain.handle('desktopLyrics:setLocked', (event, locked: unknown) => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    if (!isDesktopLyricsSender(event)) throw new Error('desktop lyrics lock rejected')
    return updateDesktopLyricsSettings({ locked: locked === true })
  })

  ipcMain.handle('desktopLyrics:setInteractionActive', (event, active: unknown) => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    if (!isDesktopLyricsSender(event)) throw new Error('desktop lyrics interaction rejected')
    if (typeof active !== 'boolean') throw new Error('invalid desktop lyrics interaction state')
    setDesktopLyricsInteractionActive(active)
  })

  ipcMain.handle('desktopLyrics:setPausedHidden', (event, hidden: unknown) => {
    assertTrustedIpcSender(event, 'desktop lyrics IPC')
    if (!isDesktopLyricsSender(event)) throw new Error('desktop lyrics visibility rejected')
    if (typeof hidden !== 'boolean') throw new Error('invalid desktop lyrics visibility state')
    setDesktopLyricsPausedHidden(hidden)
  })

  ipcMain.on('desktopLyrics:publishSession', (event, session: unknown) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC') || !isMainSender(event)) return
    if (!validSession(session)) return
    runtime.latestDesktopLyricsSession = session
    if (runtime.latestDesktopLyricsClock?.sessionId !== session.sessionId) {
      runtime.latestDesktopLyricsClock = null
    }
    runtime.desktopLyricsWindow?.webContents.send('desktopLyrics:sessionChanged', session)
  })

  ipcMain.on('desktopLyrics:publishClock', (event, clock: unknown) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC') || !isMainSender(event)) return
    if (!validClock(clock)) return
    const current = runtime.latestDesktopLyricsClock
    if (
      current?.sessionId === clock.sessionId &&
      (clock.epoch < current.epoch ||
        (clock.epoch === current.epoch && clock.sequence <= current.sequence))
    ) {
      return
    }
    runtime.latestDesktopLyricsClock = clock
    runtime.desktopLyricsWindow?.webContents.send('desktopLyrics:clockChanged', clock)
  })

  ipcMain.on('desktopLyrics:transport', (event, action: unknown) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC') || !isDesktopLyricsSender(event)) return
    if (!['previous', 'playPause', 'next'].includes(String(action))) return
    runtime.mainWindow?.webContents.send('player:shortcut', action as DesktopLyricsTransportAction)
  })

  ipcMain.on('desktopLyrics:moveTo', (event, payload: unknown) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC') || !isDesktopLyricsSender(event)) return
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const value = payload as { x?: unknown; y?: unknown }
    if (
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) ||
      Math.abs(Number(value.x)) > 100000 ||
      Math.abs(Number(value.y)) > 100000
    )
      return
    const win = runtime.desktopLyricsWindow
    if (!win || win.isDestroyed() || runtime.appSettings.desktopLyrics.locked) return
    const position = clampToCurrentDisplay(win, Number(value.x), Number(value.y))
    win.setPosition(position.x, position.y)
  })

  ipcMain.on('desktopLyrics:moveEnd', (event) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC') || !isDesktopLyricsSender(event)) return
    const win = runtime.desktopLyricsWindow
    if (win && !win.isDestroyed()) persistDesktopLyricsPosition(win)
  })

  ipcMain.on('desktopLyrics:ready', (event) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC') || !isDesktopLyricsSender(event)) return
    runtime.desktopLyricsWindow?.showInactive()
    syncDesktopLyricsHoverTracking()
    publishDesktopLyricsHoverIntent(desktopLyricsPointerInside)
  })

  ipcMain.on('desktopLyrics:close', (event) => {
    if (!shouldAcceptIpcEvent(event, 'desktop lyrics IPC') || !isDesktopLyricsSender(event)) return
    setDesktopLyricsEnabled(false)
  })
}
