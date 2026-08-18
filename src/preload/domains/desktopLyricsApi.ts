import { ipcRenderer } from 'electron'
import type { DesktopLyricsSettings, DesktopLyricsTrackPayload } from '../types'

const desktopLyricsToggleCallbacks = new Set<(enabled: boolean) => void>()
const desktopLyricsInitSettingsCallbacks = new Set<(settings: DesktopLyricsSettings) => void>()
const desktopLyricsTrackCallbacks = new Set<(data: DesktopLyricsTrackPayload) => void>()
const desktopLyricsTimeCallbacks = new Set<(time: number) => void>()
const desktopLyricsSettingsUpdateCallbacks = new Set<(settings: DesktopLyricsSettings) => void>()
const desktopLyricsLoadFailedCallbacks = new Set<
  (payload: { code: number; description: string }) => void
>()

export function bindDesktopLyricsIpcEvents(): void {
  ipcRenderer.on('desktopLyrics:toggleChanged', (_event, enabled: boolean) => {
    for (const cb of desktopLyricsToggleCallbacks) {
      cb(enabled)
    }
  })

  ipcRenderer.on('desktopLyrics:initSettings', (_event, settings: DesktopLyricsSettings) => {
    for (const cb of desktopLyricsInitSettingsCallbacks) {
      cb(settings)
    }
  })

  ipcRenderer.on('desktopLyrics:updateTrack', (_event, data: DesktopLyricsTrackPayload) => {
    for (const cb of desktopLyricsTrackCallbacks) {
      cb(data)
    }
  })

  ipcRenderer.on('desktopLyrics:updateTime', (_event, time: number) => {
    for (const cb of desktopLyricsTimeCallbacks) {
      cb(time)
    }
  })

  ipcRenderer.on('desktopLyrics:updateSettings', (_event, settings: DesktopLyricsSettings) => {
    for (const cb of desktopLyricsSettingsUpdateCallbacks) {
      cb(settings)
    }
  })

  ipcRenderer.on('desktopLyrics:loadFailed', (_event, payload: { code: number; description: string }) => {
    for (const cb of desktopLyricsLoadFailedCallbacks) {
      cb(payload)
    }
  })
}

export const desktopLyricsApi = {
  toggle: (): Promise<boolean> => ipcRenderer.invoke('desktopLyrics:toggle'),
  show: (): Promise<void> => ipcRenderer.invoke('desktopLyrics:show'),
  hide: (): Promise<void> => ipcRenderer.invoke('desktopLyrics:hide'),
  updateTrack: (data: DesktopLyricsTrackPayload): void => {
    ipcRenderer.send('desktopLyrics:updateTrack', data)
  },
  updateTime: (time: number): void => {
    ipcRenderer.send('desktopLyrics:updateTime', time)
  },
  updateSettings: (settings: DesktopLyricsSettings): void => {
    ipcRenderer.send('desktopLyrics:updateSettings', settings)
  },
  onToggle: (cb: (enabled: boolean) => void): (() => void) => {
    desktopLyricsToggleCallbacks.add(cb)
    return () => desktopLyricsToggleCallbacks.delete(cb)
  },
  onInitSettings: (cb: (settings: DesktopLyricsSettings) => void): (() => void) => {
    desktopLyricsInitSettingsCallbacks.add(cb)
    return () => desktopLyricsInitSettingsCallbacks.delete(cb)
  },
  onTrackUpdate: (cb: (data: DesktopLyricsTrackPayload) => void): (() => void) => {
    desktopLyricsTrackCallbacks.add(cb)
    return () => desktopLyricsTrackCallbacks.delete(cb)
  },
  onTimeUpdate: (cb: (time: number) => void): (() => void) => {
    desktopLyricsTimeCallbacks.add(cb)
    return () => desktopLyricsTimeCallbacks.delete(cb)
  },
  onSettingsUpdate: (cb: (settings: DesktopLyricsSettings) => void): (() => void) => {
    desktopLyricsSettingsUpdateCallbacks.add(cb)
    return () => desktopLyricsSettingsUpdateCallbacks.delete(cb)
  },
  onLoadFailed: (cb: (payload: { code: number; description: string }) => void): (() => void) => {
    desktopLyricsLoadFailedCallbacks.add(cb)
    return () => desktopLyricsLoadFailedCallbacks.delete(cb)
  },
  getPosition: (): void => {
    ipcRenderer.send('desktopLyrics:getPosition')
  },
  move: (x: number, y: number): void => {
    ipcRenderer.send('desktopLyrics:move', { x, y })
  },
  requestClose: (): void => {
    ipcRenderer.send('desktopLyrics:requestClose')
  }
}
