import {
  app,
  globalShortcut,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions
} from 'electron'
import { existsSync } from 'fs'
import { runtime } from '../core/runtime'
import {
  MEDIA_KEY_SHORTCUTS,
  type PlayerShortcutAction,
  type PlayerShortcutKeyAction,
  type PlayerShortcutStatus
} from '../core/types'
import { buildPlayerShortcutStatuses } from '../core/shortcutStatus'
import { getAppIconPath } from '../app/window'
import { applyDiscordRpcSetting } from './discord'
import { applyLibraryWatchers } from '../library/watcher'
import { restoreMainWindowFromMiniPlayer, showMiniPlayer } from './miniPlayer'
import { toggleDesktopLyrics, toggleDesktopLyricsLock } from './desktopLyrics'
import { destroyTrayPlayerWindow, openMainWindowAt } from './trayPlayer'
import type { MiniPlayerCommand, MiniPlayerPlayMode } from '../../shared/miniPlayer.ts'

let playerShortcutStatuses: PlayerShortcutStatus[] = buildPlayerShortcutStatuses(
  buildPlayerShortcutDefinitions(),
  false,
  () => false
)

export function sendPlayerShortcut(action: PlayerShortcutAction): void {
  if (runtime.mainWindow?.isDestroyed() === false) {
    runtime.mainWindow.webContents.send('player:shortcut', action)
  }
}

export function handleGlobalShortcutAction(action: PlayerShortcutKeyAction): void {
  if (action === 'toggleDesktopLyrics') {
    toggleDesktopLyrics()
    return
  }
  if (action === 'toggleDesktopLyricsLock') {
    toggleDesktopLyricsLock()
    return
  }
  sendPlayerShortcut(action)
}

export function buildPlayerShortcutDefinitions(): {
  accelerator: string
  action: PlayerShortcutKeyAction
  label: string
}[] {
  const bindings = runtime.appSettings.globalShortcutBindings
  return [
    { accelerator: bindings.previous, action: 'previous', label: '上一首' },
    { accelerator: bindings.next, action: 'next', label: '下一首' },
    { accelerator: bindings.playPause, action: 'playPause', label: '播放 / 暂停' },
    {
      accelerator: bindings.toggleDesktopLyrics,
      action: 'toggleDesktopLyrics',
      label: '桌面歌词'
    },
    {
      accelerator: bindings.toggleDesktopLyricsLock,
      action: 'toggleDesktopLyricsLock',
      label: '锁定 / 解锁桌面歌词'
    },
    ...MEDIA_KEY_SHORTCUTS
  ]
}

export function applyAutoLaunch(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath
    })
  } catch {
    // Some platforms / sandboxed environments don't support setLoginItemSettings
  }
}

export function unregisterPlayerShortcuts(): void {
  globalShortcut.unregisterAll()
}

export function registerPlayerShortcuts(): void {
  unregisterPlayerShortcuts()
  const shortcuts = buildPlayerShortcutDefinitions()
  playerShortcutStatuses = buildPlayerShortcutStatuses(
    shortcuts,
    runtime.appSettings.globalShortcuts,
    (accelerator) => {
      const shortcut = shortcuts.find((item) => item.accelerator === accelerator)
      if (!shortcut) return false
      const ok = globalShortcut.register(shortcut.accelerator, () => {
        handleGlobalShortcutAction(shortcut.action)
      })
      if (!ok) {
        console.warn(`全局快捷键注册失败：${shortcut.label} ${shortcut.accelerator}`)
      }
      return ok
    }
  )
}

export function getPlayerShortcutStatuses(): PlayerShortcutStatus[] {
  return playerShortcutStatuses.map((status) => ({ ...status }))
}

export function resetPlayerShortcutStatuses(): void {
  playerShortcutStatuses = buildPlayerShortcutStatuses(
    buildPlayerShortcutDefinitions(),
    false,
    () => false
  )
}

const PLAY_MODE_LABELS: Record<MiniPlayerPlayMode, string> = {
  sequential: '顺序播放',
  listLoop: '列表循环',
  repeat: '单曲循环',
  shuffle: '随机播放',
  heart: '心动模式'
}

let trayMenuSignature: string | null = null

function createTrayMenuSignature(): string {
  const state = runtime.latestMiniPlayerState
  const track = state?.track
  return JSON.stringify([
    track?.id ?? null,
    track?.title ?? null,
    track?.artist ?? null,
    state?.isPlaying ?? false,
    state?.playMode ?? 'sequential',
    state?.favoriteAvailable ?? false,
    state?.favoriteLiked ?? false,
    state?.favoriteLoading ?? false,
    runtime.appSettings.desktopLyrics.enabled,
    runtime.appSettings.desktopLyrics.locked
  ])
}

function sendMiniPlayerCommand(command: MiniPlayerCommand): void {
  const mainWindow = runtime.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send('miniPlayer:command', command)
}

function formatTrayTrackTooltip(): string {
  const track = runtime.latestMiniPlayerState?.track
  if (!track) return 'Twilight Echo'
  return track.artist ? `${track.title} - ${track.artist}` : track.title
}

function truncateTrayLabel(label: string, maxWidth = 18): string {
  let width = 0
  let result = ''
  for (const character of label) {
    const characterWidth = character.codePointAt(0)! > 0x7f ? 2 : 1
    if (width + characterWidth > maxWidth - 2) return `${result}…`
    result += character
    width += characterWidth
  }
  return result
}

function formatTrayTrackLabel(): string {
  const track = runtime.latestMiniPlayerState?.track
  if (!track) return '暂无播放'
  const label = track.artist ? `${track.title} - ${track.artist}` : track.title
  return truncateTrayLabel(label)
}

function buildPlayModeSubmenu(): MenuItemConstructorOptions[] {
  const activeMode = runtime.latestMiniPlayerState?.playMode ?? 'sequential'
  return (Object.entries(PLAY_MODE_LABELS) as [MiniPlayerPlayMode, string][]).map(
    ([mode, label]) => ({
      label,
      type: 'radio',
      checked: mode === activeMode,
      click: () => sendMiniPlayerCommand({ type: 'set-play-mode', value: mode })
    })
  )
}

function buildTrayMenuTemplate(): MenuItemConstructorOptions[] {
  const state = runtime.latestMiniPlayerState
  const hasTrack = Boolean(state?.track)
  const isPlaying = state?.isPlaying === true
  const favoriteEnabled = hasTrack && state?.favoriteAvailable === true && !state.favoriteLoading
  return [
    {
      label: formatTrayTrackLabel(),
      enabled: hasTrack,
      click: () => restoreMainWindowFromMiniPlayer()
    },
    { type: 'separator' },
    {
      label: '上一首',
      enabled: hasTrack,
      click: () => sendMiniPlayerCommand({ type: 'previous' })
    },
    {
      label: isPlaying ? '暂停' : '播放',
      enabled: hasTrack,
      click: () => sendMiniPlayerCommand({ type: 'toggle-play' })
    },
    {
      label: '下一首',
      enabled: hasTrack,
      click: () => sendMiniPlayerCommand({ type: 'next' })
    },
    {
      label: state?.favoriteLiked ? '取消喜欢' : '喜欢',
      enabled: favoriteEnabled,
      click: () => sendMiniPlayerCommand({ type: 'toggle-favorite' })
    },
    { type: 'separator' },
    {
      label: '播放模式',
      submenu: buildPlayModeSubmenu()
    },
    { type: 'separator' },
    {
      label: '桌面歌词',
      type: 'checkbox',
      checked: runtime.appSettings.desktopLyrics.enabled,
      click: () => {
        toggleDesktopLyrics()
      }
    },
    {
      label: '锁定桌面歌词',
      type: 'checkbox',
      enabled: runtime.appSettings.desktopLyrics.enabled,
      checked: runtime.appSettings.desktopLyrics.locked,
      click: () => {
        toggleDesktopLyricsLock()
      }
    },
    { type: 'separator' },
    {
      label: '迷你播放器',
      click: () => showMiniPlayer()
    },
    { type: 'separator' },
    {
      label: '设置',
      click: () => openMainWindowAt('settings')
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        runtime.forceQuit = true
        app.quit()
      }
    }
  ]
}

export function refreshTrayMenu(force = false): void {
  if (!runtime.tray) return
  const signature = createTrayMenuSignature()
  if (!force && signature === trayMenuSignature) return
  trayMenuSignature = signature
  runtime.tray.setToolTip(formatTrayTrackTooltip())
  runtime.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()))
}

export function createTray(): void {
  if (runtime.tray) return

  const iconPath = getAppIconPath()
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()
  runtime.tray = new Tray(icon)
  runtime.refreshTrayMenu = refreshTrayMenu
  refreshTrayMenu(true)
  runtime.tray.on('click', () => {
    restoreMainWindowFromMiniPlayer()
  })
  runtime.tray.on('double-click', () => {
    restoreMainWindowFromMiniPlayer()
  })
}

export function destroyTray(): void {
  destroyTrayPlayerWindow()
  runtime.refreshTrayMenu = null
  trayMenuSignature = null
  runtime.tray?.destroy()
  runtime.tray = null
}

export function syncTrayState(): void {
  // The tray is a first-class playback surface while the app is running.
  // closeToTray only controls what the window close button does.
  createTray()
}

export function applyRuntimeSettings(): void {
  applyAutoLaunch(runtime.appSettings.launchAtLogin)
  applyDiscordRpcSetting(runtime.appSettings.discordRpcEnabled)
  applyLibraryWatchers(runtime.appSettings.libraryFolders, runtime.appSettings.watchLibrary)
  registerPlayerShortcuts()
  syncTrayState()
}
