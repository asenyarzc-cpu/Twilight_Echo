import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const traySource = readFileSync(new URL('./shortcutsTray.ts', import.meta.url), 'utf8')
const trayPlayerSource = readFileSync(new URL('./trayPlayer.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../preload/index.ts', import.meta.url), 'utf8')
const rendererSource = readFileSync(
  new URL('../../renderer/src/tray-player/TrayPlayerApp.vue', import.meta.url),
  'utf8'
)
const appSource = readFileSync(new URL('../../renderer/src/App.vue', import.meta.url), 'utf8')
const desktopLyricsSource = readFileSync(new URL('./desktopLyrics.ts', import.meta.url), 'utf8')

test('system tray mirrors the reference playback menu without obsolete window actions', () => {
  assert.match(traySource, /label: formatTrayTrackLabel\(\)/)
  assert.match(traySource, /label: '上一首'/)
  assert.match(traySource, /label: isPlaying \? '暂停' : '播放'/)
  assert.match(traySource, /label: '下一首'/)
  assert.match(traySource, /label: state\?\.favoriteLiked \? '取消喜欢' : '喜欢'/)
  assert.match(traySource, /label: '播放模式'/)
  assert.match(traySource, /submenu: buildPlayModeSubmenu\(\)/)
  assert.match(traySource, /label: '桌面歌词'/)
  assert.match(traySource, /label: '迷你播放器'/)
  assert.match(traySource, /showMiniPlayer\(\)/)
  assert.match(traySource, /label: '设置'/)
  assert.match(traySource, /openMainWindowAt\('settings'\)/)
  assert.match(traySource, /label: '退出'/)
  assert.doesNotMatch(traySource, /label: '播放控制'/)
  assert.doesNotMatch(traySource, /label: '打开本地主页'/)
  assert.doesNotMatch(traySource, /label: '打开流媒体页'/)
  assert.doesNotMatch(traySource, /label: '隐藏窗口'/)
  assert.doesNotMatch(traySource, /开启音乐桌面/)
  assert.match(traySource, /runtime\.tray\.on\('click',[\s\S]*restoreMainWindowFromMiniPlayer\(\)/)
  assert.match(traySource, /export function syncTrayState\(\): void \{[\s\S]*createTray\(\)/)
})

test('tray keeps compact top-level labels while preserving full track text in the tooltip', () => {
  assert.match(traySource, /function truncateTrayLabel\(label: string, maxWidth = 18\): string/)
  assert.match(traySource, /if \(!track\) return '暂无播放'/)
  assert.match(traySource, /runtime\.tray\.setToolTip\(formatTrayTrackTooltip\(\)\)/)
})

test('tray menu rebuilds only when visible menu state changes', () => {
  assert.match(traySource, /function createTrayMenuSignature\(\): string/)
  assert.match(traySource, /if \(!force && signature === trayMenuSignature\) return/)
  assert.doesNotMatch(traySource, /currentTime/)
  // The lyrics window's close control routes through setDesktopLyricsEnabled,
  // which publishes enabledChanged and then rebuilds the tray menu.
  assert.match(
    desktopLyricsSource,
    /ipcMain\.on\('desktopLyrics:close'[\s\S]*?setDesktopLyricsEnabled\(false\)/
  )
  assert.match(
    desktopLyricsSource,
    /desktopLyrics:enabledChanged', enabled\)[\s\S]*?runtime\.refreshTrayMenu\?\.\(true\)/
  )
})

test('tray player window is isolated and forwards validated commands to the playback host', () => {
  assert.match(trayPlayerSource, /sandbox: true/)
  assert.match(trayPlayerSource, /contextIsolation: true/)
  assert.match(trayPlayerSource, /nodeIntegration: false/)
  assert.match(trayPlayerSource, /normalizeMiniPlayerCommand\(rawCommand\)/)
  assert.match(trayPlayerSource, /normalizeTrayNavigationTarget\(rawTarget\)/)
  assert.match(trayPlayerSource, /mainWindow\.webContents\.send\('miniPlayer:command', command\)/)
  assert.match(
    preloadSource,
    /if \(isTrayPlayerDocument\(\)\) return \{ trayPlayer: trayPlayerWindowApi \}/
  )
})

test('tray popup provides seek and transport controls backed by the shared playback snapshot', () => {
  assert.match(rendererSource, /type="range"/)
  assert.match(rendererSource, /aria-label="拖动播放进度"/)
  assert.match(rendererSource, /sendCommand\(\{ type: 'seek', value \}\)/)
  assert.match(rendererSource, /sendCommand\(\{ type: 'previous' \}\)/)
  assert.match(rendererSource, /sendCommand\(\{ type: 'next' \}\)/)
  assert.match(rendererSource, /sendCommand\(\{ type: 'toggle-play' \}\)/)
  assert.match(rendererSource, /navigate\('local'\)/)
  assert.match(rendererSource, /navigate\('streaming'\)/)
})

test('main window consumes pending tray navigation after renderer startup', () => {
  assert.match(trayPlayerSource, /runtime\.pendingTrayNavigation = target/)
  assert.match(trayPlayerSource, /export function consumePendingTrayNavigation/)
  assert.match(appSource, /window\.api\.app\.consumePendingNavigation\(\)/)
  assert.match(appSource, /if \(pendingNavigation\) applyExternalNavigation\(pendingNavigation\)/)
  assert.match(appSource, /onSelectView\('dashboard', null\)/)
  assert.match(appSource, /enterStreamingMode\(\)/)
  assert.match(appSource, /target === 'settings'/)
  assert.match(appSource, /openSettingsPage\('general'\)/)
})
