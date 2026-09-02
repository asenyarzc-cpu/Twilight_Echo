import { ipcRenderer } from 'electron'
import type {
  DesktopLyricsBootstrap,
  DesktopLyricsClockSnapshot,
  DesktopLyricsSession,
  DesktopLyricsSettingsV3,
  DesktopLyricsTransportAction
} from '../../shared/desktopLyrics.ts'

const enabledCallbacks = new Set<(enabled: boolean) => void>()
const resyncCallbacks = new Set<() => void>()
const loadFailedCallbacks = new Set<(payload: { code: number; description: string }) => void>()
const sessionCallbacks = new Set<(session: DesktopLyricsSession) => void>()
const clockCallbacks = new Set<(clock: DesktopLyricsClockSnapshot) => void>()
const settingsCallbacks = new Set<(settings: DesktopLyricsSettingsV3) => void>()
const freezeCallbacks = new Set<() => void>()
const hoverIntentCallbacks = new Set<(pointerInside: boolean) => void>()

export function bindDesktopLyricsIpcEvents(): void {
  ipcRenderer.on('desktopLyrics:enabledChanged', (_event, enabled: boolean) => {
    for (const callback of enabledCallbacks) callback(enabled)
  })
  ipcRenderer.on('desktopLyrics:resyncRequested', () => {
    for (const callback of resyncCallbacks) callback()
  })
  ipcRenderer.on(
    'desktopLyrics:loadFailed',
    (_event, payload: { code: number; description: string }) => {
      for (const callback of loadFailedCallbacks) callback(payload)
    }
  )
  ipcRenderer.on('desktopLyrics:sessionChanged', (_event, session: DesktopLyricsSession) => {
    for (const callback of sessionCallbacks) callback(session)
  })
  ipcRenderer.on('desktopLyrics:clockChanged', (_event, clock: DesktopLyricsClockSnapshot) => {
    for (const callback of clockCallbacks) callback(clock)
  })
  ipcRenderer.on('desktopLyrics:settingsChanged', (_event, settings: DesktopLyricsSettingsV3) => {
    for (const callback of settingsCallbacks) callback(settings)
  })
  ipcRenderer.on('desktopLyrics:freezeClock', () => {
    for (const callback of freezeCallbacks) callback()
  })
  ipcRenderer.on('desktopLyrics:hoverIntent', (_event, pointerInside: boolean) => {
    for (const callback of hoverIntentCallbacks) callback(pointerInside)
  })
}

export const desktopLyricsHostApi = {
  setEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('desktopLyrics:setEnabled', enabled),
  publishSession: (session: DesktopLyricsSession): void => {
    ipcRenderer.send('desktopLyrics:publishSession', session)
  },
  publishClock: (clock: DesktopLyricsClockSnapshot): void => {
    ipcRenderer.send('desktopLyrics:publishClock', clock)
  },
  onEnabledChanged: (callback: (enabled: boolean) => void): (() => void) => {
    enabledCallbacks.add(callback)
    return () => enabledCallbacks.delete(callback)
  },
  onResyncRequested: (callback: () => void): (() => void) => {
    resyncCallbacks.add(callback)
    return () => resyncCallbacks.delete(callback)
  },
  onLoadFailed: (
    callback: (payload: { code: number; description: string }) => void
  ): (() => void) => {
    loadFailedCallbacks.add(callback)
    return () => loadFailedCallbacks.delete(callback)
  }
}

export const desktopLyricsWindowApi = {
  bootstrap: (): Promise<DesktopLyricsBootstrap> => ipcRenderer.invoke('desktopLyrics:bootstrap'),
  updateQuickSettings: (
    patch: Partial<DesktopLyricsSettingsV3>
  ): Promise<DesktopLyricsSettingsV3> =>
    ipcRenderer.invoke('desktopLyrics:updateQuickSettings', patch),
  setLocked: (locked: boolean): Promise<DesktopLyricsSettingsV3> =>
    ipcRenderer.invoke('desktopLyrics:setLocked', locked),
  setInteractionActive: (active: boolean): Promise<void> =>
    ipcRenderer.invoke('desktopLyrics:setInteractionActive', active),
  setPausedHidden: (hidden: boolean): Promise<void> =>
    ipcRenderer.invoke('desktopLyrics:setPausedHidden', hidden),
  transport: (action: DesktopLyricsTransportAction): void => {
    ipcRenderer.send('desktopLyrics:transport', action)
  },
  moveTo: (x: number, y: number): void => {
    ipcRenderer.send('desktopLyrics:moveTo', { x, y })
  },
  moveEnd: (): void => {
    ipcRenderer.send('desktopLyrics:moveEnd')
  },
  ready: (): void => {
    ipcRenderer.send('desktopLyrics:ready')
  },
  close: (): void => {
    ipcRenderer.send('desktopLyrics:close')
  },
  onSessionChanged: (callback: (session: DesktopLyricsSession) => void): (() => void) => {
    sessionCallbacks.add(callback)
    return () => sessionCallbacks.delete(callback)
  },
  onClockChanged: (callback: (clock: DesktopLyricsClockSnapshot) => void): (() => void) => {
    clockCallbacks.add(callback)
    return () => clockCallbacks.delete(callback)
  },
  onSettingsChanged: (callback: (settings: DesktopLyricsSettingsV3) => void): (() => void) => {
    settingsCallbacks.add(callback)
    return () => settingsCallbacks.delete(callback)
  },
  onFreezeClock: (callback: () => void): (() => void) => {
    freezeCallbacks.add(callback)
    return () => freezeCallbacks.delete(callback)
  },
  onHoverIntent: (callback: (pointerInside: boolean) => void): (() => void) => {
    hoverIntentCallbacks.add(callback)
    return () => hoverIntentCallbacks.delete(callback)
  }
}
