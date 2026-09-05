import { app, nativeImage, type ThumbarButton } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { runtime } from '../core/runtime'

// Windows taskbar-thumbnail toolbar (thumbnail hover / taskbar preview).
// This is deliberately separate from Windows System Media Transport Controls:
// Thumbar buttons belong to the taskbar window preview while SMTC belongs to the
// system-wide media session surfaced by Windows media flyouts / lock-screen UI.

function getThumbarIconPath(name: string): string {
  if (process.platform === 'win32') {
    return is.dev
      ? join(app.getAppPath(), 'build', 'smtc', `${name}.ico`)
      : join(process.resourcesPath, 'smtc', `${name}.ico`)
  }
  return ''
}

let lastSignature = ''

function buildTaskbarThumbarButtons(): ThumbarButton[] {
  const state = runtime.latestMiniPlayerState
  const hasTrack = state?.track != null
  const isPlaying = state?.isPlaying === true
  return [
    {
      tooltip: '上一首',
      icon: nativeImage.createFromPath(getThumbarIconPath('previous')),
      flags: hasTrack ? ['enabled'] : ['disabled'],
      click: () => {
        runtime.mainWindow?.webContents.send('player:shortcut', 'previous')
      }
    },
    {
      tooltip: isPlaying ? '暂停' : '播放',
      icon: nativeImage.createFromPath(getThumbarIconPath(isPlaying ? 'pause' : 'play')),
      flags: hasTrack ? ['enabled'] : ['disabled'],
      click: () => {
        runtime.mainWindow?.webContents.send('player:shortcut', 'playPause')
      }
    },
    {
      tooltip: '下一首',
      icon: nativeImage.createFromPath(getThumbarIconPath('next')),
      flags: hasTrack ? ['enabled'] : ['disabled'],
      click: () => {
        runtime.mainWindow?.webContents.send('player:shortcut', 'next')
      }
    }
  ]
}

export function refreshTaskbarThumbarButtons(force = false): void {
  if (process.platform !== 'win32') return
  const win = runtime.mainWindow
  if (!win || win.isDestroyed()) return
  const enabled = runtime.appSettings.taskbarThumbarButtonsEnabled !== false
  const state = runtime.latestMiniPlayerState
  const signature = `${enabled ? 'on' : 'off'}:${state?.track?.id ?? null}:${state?.isPlaying === true}`
  if (!force && signature === lastSignature) return
  lastSignature = signature
  win.setThumbarButtons(enabled ? buildTaskbarThumbarButtons() : [])
}

export function createTaskbarThumbarButtons(): void {
  if (process.platform !== 'win32') return
  runtime.refreshTaskbarThumbarButtons = refreshTaskbarThumbarButtons
  refreshTaskbarThumbarButtons(true)
}

export function destroyTaskbarThumbarButtons(): void {
  runtime.refreshTaskbarThumbarButtons = null
}
