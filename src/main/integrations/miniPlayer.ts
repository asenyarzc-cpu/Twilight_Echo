import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  EMPTY_MINI_PLAYER_STATE,
  normalizeMiniPlayerCommand,
  normalizeMiniPlayerSettings,
  normalizeMiniPlayerStateSnapshot,
  type MiniPlayerBootstrap,
  type MiniPlayerSettings,
  type MiniPlayerSettingsPatch,
  type MiniPlayerStateSnapshot
} from '../../shared/miniPlayer'
import type { MotionPreference } from '../../shared/motion.ts'
import { runtime } from '../core/runtime'
import { createSettingsSnapshot, writeAppSettings } from '../core/settings'
import { importBackgroundImage } from '../library/coverCache'
import { assertTrustedIpcSender, shouldAcceptIpcEvent } from '../security/electronSecurity.ts'
import {
  MINI_PLAYER_MAX_HEIGHT,
  MINI_PLAYER_MAX_WIDTH,
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH,
  clampMiniPlayerBoundsToWorkArea,
  createMiniPlayerWindowShape,
  miniPlayerBoundsPatch
} from './miniPlayerWindow'

const MINI_PLAYER_EDGE_GAP = 22
const MINI_PLAYER_BOUNDS_SAVE_DELAY_MS = 350

let boundsSaveTimer: NodeJS.Timeout | null = null
let programmedBounds: Electron.Rectangle | null = null

function getMiniPlayerIconPath(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          is.dev
            ? join(app.getAppPath(), 'build', 'icon.ico')
            : join(process.resourcesPath, 'icon.ico')
        ]
      : [
          is.dev
            ? join(app.getAppPath(), 'build', 'icon.png')
            : join(process.resourcesPath, 'icon.png')
        ]
  return candidates.find((candidate) => existsSync(candidate))
}

function currentMiniPlayerSettings(): MiniPlayerSettings {
  return normalizeMiniPlayerSettings(runtime.appSettings.miniPlayer)
}

function resolveInitialBounds(settings: MiniPlayerSettings): Electron.Rectangle {
  const hasSavedPosition = !(settings.windowX === -1 && settings.windowY === -1)
  const display = hasSavedPosition
    ? screen.getDisplayNearestPoint({ x: settings.windowX, y: settings.windowY })
    : runtime.mainWindow && !runtime.mainWindow.isDestroyed()
      ? screen.getDisplayMatching(runtime.mainWindow.getBounds())
      : screen.getPrimaryDisplay()
  const workArea = display.workArea
  const preferredX = hasSavedPosition
    ? settings.windowX
    : workArea.x + workArea.width - settings.windowWidth - MINI_PLAYER_EDGE_GAP
  const preferredY = hasSavedPosition
    ? settings.windowY
    : workArea.y + workArea.height - settings.windowHeight - MINI_PLAYER_EDGE_GAP

  return clampMiniPlayerBoundsToWorkArea(
    {
      x: clampNumber(preferredX, workArea.x, workArea.x + workArea.width - settings.windowWidth),
      y: clampNumber(preferredY, workArea.y, workArea.y + workArea.height - settings.windowHeight),
      width: settings.windowWidth,
      height: settings.windowHeight
    },
    workArea
  )
}

function fitMiniPlayerToWorkArea(win: BrowserWindow, settings: MiniPlayerSettings): void {
  const current = win.getBounds()
  const display = screen.getDisplayMatching(current)
  const next = clampMiniPlayerBoundsToWorkArea(
    { ...current, width: settings.windowWidth, height: settings.windowHeight },
    display.workArea
  )
  if (rectanglesEqual(current, next)) return
  programmedBounds = next
  win.setBounds(next, false)
}

function applyMiniPlayerWindowSettings(settings: MiniPlayerSettings): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed()) return

  if (settings.alwaysOnTop) {
    win.setAlwaysOnTop(true, 'screen-saver')
  } else {
    win.setAlwaysOnTop(false)
  }
  win.setBackgroundColor('#00000000')
  win.setMovable(!settings.positionLocked)
  win.setSkipTaskbar(!settings.showInTaskbar)
  applyMiniPlayerWindowShape(win, settings)
  fitMiniPlayerToWorkArea(win, settings)
}

function applyMiniPlayerWindowShape(win: BrowserWindow, settings: MiniPlayerSettings): void {
  if (process.platform !== 'win32') return
  const profile = settings.profiles[settings.activeStyleId]
  const cornerRadius = profile?.appearance.cornerRadius ?? 0
  const bounds = win.getBounds()
  // The OS window region is binary, so a rounded region is drawn as a 1px
  // stair-step and cannot be anti-aliased. If that region is rounder than the
  // CSS surface it becomes the visible boundary and looks jagged. Keep the
  // region slightly *less* round instead: the staircase then hides in the
  // transparent rim outside the CSS border-radius, and Chromium's antialiased
  // CSS corner is what the user actually sees. The shape still cuts the corner
  // tip so clicks outside the rounded surface fall through to the desktop.
  const safetyRadius = Math.max(0, cornerRadius - 2)
  win.setShape(createMiniPlayerWindowShape(bounds.width, bounds.height, safetyRadius))
}

function persistMiniPlayerBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || runtime.miniPlayerWindow !== win) return
  const boundsPatch = miniPlayerBoundsPatch(win.getBounds())
  runtime.appSettings = {
    ...runtime.appSettings,
    miniPlayer: {
      ...currentMiniPlayerSettings(),
      ...boundsPatch
    }
  }
  writeAppSettings(runtime.appSettings)
  sendMiniPlayerSettings(runtime.appSettings.miniPlayer)
  runtime.mainWindow?.webContents.send(
    'settings:changed',
    createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  )
}

function scheduleMiniPlayerBoundsSave(win: BrowserWindow): void {
  const current = win.getBounds()
  if (programmedBounds && rectanglesEqual(current, programmedBounds)) return
  programmedBounds = null
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null
    persistMiniPlayerBounds(win)
  }, MINI_PLAYER_BOUNDS_SAVE_DELAY_MS)
}

function sendMiniPlayerState(state: MiniPlayerStateSnapshot): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('miniPlayer:state', state)
}

function sendMiniPlayerSettings(settings = currentMiniPlayerSettings()): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('miniPlayer:settings', settings)
}

function sendMiniPlayerMotionPreference(preference = runtime.appSettings.motionPreference): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('miniPlayer:motionPreference', preference)
}

export function applyMiniPlayerSettingsFromApp(settings: MiniPlayerSettings): void {
  applyMiniPlayerWindowSettings(settings)
  sendMiniPlayerSettings(settings)
}

export function applyMiniPlayerMotionPreferenceFromApp(preference: MotionPreference): void {
  sendMiniPlayerMotionPreference(preference)
}

function enterMiniPlayerMode(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  runtime.mainWindow?.hide()
  sendMiniPlayerSettings()
  sendMiniPlayerMotionPreference()
  sendMiniPlayerState(runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE })
}

function createMiniPlayerWindow(): BrowserWindow {
  const settings = currentMiniPlayerSettings()
  const bounds = resolveInitialBounds(settings)
  runtime.appSettings = {
    ...runtime.appSettings,
    miniPlayer: {
      ...settings,
      ...miniPlayerBoundsPatch(bounds)
    }
  }

  const win = new BrowserWindow({
    ...bounds,
    title: 'Twilight Echo Mini Player',
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: settings.alwaysOnTop,
    movable: !settings.positionLocked,
    resizable: true,
    minWidth: MINI_PLAYER_MIN_WIDTH,
    minHeight: MINI_PLAYER_MIN_HEIGHT,
    maxWidth: MINI_PLAYER_MAX_WIDTH,
    maxHeight: MINI_PLAYER_MAX_HEIGHT,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: !settings.showInTaskbar,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: process.platform === 'win32',
    autoHideMenuBar: true,
    icon: getMiniPlayerIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  runtime.miniPlayerWindow = win

  win.setBackgroundColor('#00000000')

  applyMiniPlayerWindowSettings(settings)

  win.on('ready-to-show', () => {
    if (runtime.miniPlayerWindow !== win || win.isDestroyed()) return
    enterMiniPlayerMode(win)
  })

  win.on('move', () => scheduleMiniPlayerBoundsSave(win))
  win.on('resize', () => {
    applyMiniPlayerWindowShape(win, currentMiniPlayerSettings())
    scheduleMiniPlayerBoundsSave(win)
  })

  win.on('close', (event) => {
    if (runtime.forceQuit) {
      persistMiniPlayerBounds(win)
      return
    }
    event.preventDefault()
    restoreMainWindowFromMiniPlayer()
  })

  win.on('closed', () => {
    if (boundsSaveTimer) {
      clearTimeout(boundsSaveTimer)
      boundsSaveTimer = null
    }
    programmedBounds = null
    if (runtime.miniPlayerWindow === win) runtime.miniPlayerWindow = null
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('did-finish-load', () => {
    sendMiniPlayerSettings()
    sendMiniPlayerMotionPreference()
    sendMiniPlayerState(runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE })
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    console.error(`[mini-player] renderer load failed: ${errorCode} ${errorDescription}`)
    restoreMainWindowFromMiniPlayer()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.searchParams.set('window', 'mini-player')
    void win.loadURL(rendererUrl.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'mini-player' }
    })
  }

  return win
}

export function showMiniPlayer(): MiniPlayerSettings {
  const existing = runtime.miniPlayerWindow
  if (existing && !existing.isDestroyed()) {
    if (!existing.webContents.isLoadingMainFrame()) enterMiniPlayerMode(existing)
  } else {
    createMiniPlayerWindow()
  }
  return currentMiniPlayerSettings()
}

export function hideMiniPlayerWindow(): void {
  const win = runtime.miniPlayerWindow
  if (win && !win.isDestroyed()) win.hide()
}

export function restoreMainWindowFromMiniPlayer(): void {
  const miniPlayerWindow = runtime.miniPlayerWindow
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    persistMiniPlayerBounds(miniPlayerWindow)
    miniPlayerWindow.destroy()
  }
  runtime.miniPlayerWindow = null

  const mainWindow = runtime.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function updateMiniPlayerSettings(patch: unknown): MiniPlayerSettings {
  const current = currentMiniPlayerSettings()
  const value =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  const candidate: Record<string, unknown> = { ...current }
  const allowedKeys: (keyof MiniPlayerSettingsPatch)[] = [
    'alwaysOnTop',
    'showInTaskbar',
    'positionLocked',
    'activeStyleId',
    'profiles',
    'windowWidth',
    'windowHeight'
  ]
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) candidate[key] = value[key]
  }

  const settings = normalizeMiniPlayerSettings(candidate)
  runtime.appSettings = { ...runtime.appSettings, miniPlayer: settings }
  writeAppSettings(runtime.appSettings)
  applyMiniPlayerSettingsFromApp(settings)
  runtime.mainWindow?.webContents.send(
    'settings:changed',
    createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  )
  return settings
}

function assertSenderWindow(
  event: IpcMainEvent | IpcMainInvokeEvent,
  expectedWindow: BrowserWindow | null,
  capability: string
): void {
  assertTrustedIpcSender(event, capability)
  if (
    !expectedWindow ||
    expectedWindow.isDestroyed() ||
    event.sender.id !== expectedWindow.webContents.id
  ) {
    throw new Error(`${capability} rejected from unexpected window`)
  }
}

function shouldAcceptSenderWindow(
  event: IpcMainEvent | IpcMainInvokeEvent,
  expectedWindow: BrowserWindow | null,
  capability: string
): boolean {
  if (!shouldAcceptIpcEvent(event, capability)) return false
  if (
    expectedWindow &&
    !expectedWindow.isDestroyed() &&
    event.sender.id === expectedWindow.webContents.id
  ) {
    return true
  }
  console.warn(`${capability} rejected from unexpected window`)
  return false
}

export function setupMiniPlayerIpc(): void {
  ipcMain.handle('miniPlayer:open', (event) => {
    assertSenderWindow(event, runtime.mainWindow, 'mini player host IPC')
    return showMiniPlayer()
  })

  ipcMain.on('miniPlayer:publishState', (event, rawState: unknown) => {
    if (!shouldAcceptSenderWindow(event, runtime.mainWindow, 'mini player state IPC')) return
    const state = normalizeMiniPlayerStateSnapshot(rawState)
    runtime.latestMiniPlayerState = state
    sendMiniPlayerState(state)
    runtime.refreshTrayMenu?.()
    runtime.refreshTaskbarThumbarButtons?.()
    runtime.refreshWindowsSmtc?.()
    const trayPlayerWindow = runtime.trayPlayerWindow
    if (
      trayPlayerWindow &&
      !trayPlayerWindow.isDestroyed() &&
      !trayPlayerWindow.webContents.isDestroyed()
    ) {
      trayPlayerWindow.webContents.send('trayPlayer:state', state)
    }
  })

  ipcMain.handle('miniPlayer:getBootstrap', (event): MiniPlayerBootstrap => {
    assertSenderWindow(event, runtime.miniPlayerWindow, 'mini player window IPC')
    return {
      state: runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE },
      settings: currentMiniPlayerSettings(),
      motionPreference: runtime.appSettings.motionPreference
    }
  })

  ipcMain.on('miniPlayer:command', (event, rawCommand: unknown) => {
    if (!shouldAcceptSenderWindow(event, runtime.miniPlayerWindow, 'mini player command IPC')) {
      return
    }
    const command = normalizeMiniPlayerCommand(rawCommand)
    if (!command) return
    const mainWindow = runtime.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('miniPlayer:command', command)
  })

  ipcMain.handle('miniPlayer:updateSettings', (event, patch: MiniPlayerSettingsPatch) => {
    assertSenderWindow(event, runtime.miniPlayerWindow, 'mini player settings IPC')
    return updateMiniPlayerSettings(patch)
  })

  ipcMain.handle('miniPlayer:chooseBackgroundImage', async (event) => {
    assertSenderWindow(event, runtime.miniPlayerWindow, 'mini player background image IPC')
    const win = runtime.miniPlayerWindow
    if (!win || win.isDestroyed()) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '背景图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return importBackgroundImage(result.filePaths[0])
  })

  ipcMain.on('miniPlayer:minimize', (event) => {
    if (!shouldAcceptSenderWindow(event, runtime.miniPlayerWindow, 'mini player window IPC')) {
      return
    }
    runtime.miniPlayerWindow?.minimize()
  })

  ipcMain.on('miniPlayer:returnToMain', (event) => {
    if (!shouldAcceptSenderWindow(event, runtime.miniPlayerWindow, 'mini player window IPC')) {
      return
    }
    restoreMainWindowFromMiniPlayer()
  })
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)))
}

function rectanglesEqual(first: Electron.Rectangle, second: Electron.Rectangle): boolean {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  )
}
