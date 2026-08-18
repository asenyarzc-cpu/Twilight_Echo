import { contextBridge, ipcRenderer } from 'electron'
import type {
  MiniPlayerBootstrap,
  MiniPlayerCommand,
  MiniPlayerSettings,
  MiniPlayerSettingsPatch,
  MiniPlayerStateSnapshot,
  TrayNavigationTarget,
  TrayPlayerBootstrap,
  MotionPreference
} from './types'
import { createSleepTimerEventBridge } from './sleepTimerEvents.ts'
import { dataApi, miniPlayerCoverDataApi } from './domains/dataApi.ts'
import { audioEngineApi, bindAudioEngineIpcEvents } from './domains/audioEngineApi.ts'
import { bindDesktopLyricsIpcEvents, desktopLyricsApi } from './domains/desktopLyricsApi.ts'
import { libraryAndFileSystemApi } from './domains/libraryApi.ts'
import { mediaSubscriptionsApi } from './domains/mediaSubscriptionsApi.ts'
import { networkSourcesApi } from './domains/networkSourcesApi.ts'
import { bindSettingsIpcEvents, settingsApi } from './domains/settingsApi.ts'
import { bindThemesIpcEvents, themesApi } from './domains/themesApi.ts'
import { bindPluginsIpcEvents, pluginsApi } from './domains/pluginsApi.ts'
import { bindSystemIpcEvents, systemApi } from './domains/systemApi.ts'

const miniPlayerStateCallbacks = new Set<(state: MiniPlayerStateSnapshot) => void>()
const miniPlayerSettingsCallbacks = new Set<(settings: MiniPlayerSettings) => void>()
const miniPlayerMotionPreferenceCallbacks = new Set<(preference: MotionPreference) => void>()
const miniPlayerCommandCallbacks = new Set<(command: MiniPlayerCommand) => void>()
const trayPlayerStateCallbacks = new Set<(state: MiniPlayerStateSnapshot) => void>()
const sleepTimerEvents = createSleepTimerEventBridge()

bindSettingsIpcEvents()
bindPluginsIpcEvents()
bindSystemIpcEvents()
bindAudioEngineIpcEvents()
bindDesktopLyricsIpcEvents()
bindThemesIpcEvents()

sleepTimerEvents.bind(ipcRenderer)
ipcRenderer.on('desktopLyrics:position', (_event, pos: { x: number; y: number }) => {
  // Forward to a temporary global that the HTML page can read
  ;(window as unknown as Record<string, unknown>).__dlPos = pos
})

ipcRenderer.on('miniPlayer:state', (_event, state: MiniPlayerStateSnapshot) => {
  for (const cb of miniPlayerStateCallbacks) cb(state)
})

ipcRenderer.on('miniPlayer:settings', (_event, settings: MiniPlayerSettings) => {
  for (const cb of miniPlayerSettingsCallbacks) cb(settings)
})

ipcRenderer.on('miniPlayer:motionPreference', (_event, preference: MotionPreference) => {
  for (const cb of miniPlayerMotionPreferenceCallbacks) cb(preference)
})

ipcRenderer.on('miniPlayer:command', (_event, command: MiniPlayerCommand) => {
  for (const cb of miniPlayerCommandCallbacks) cb(command)
})

ipcRenderer.on('trayPlayer:state', (_event, state: MiniPlayerStateSnapshot) => {
  for (const cb of trayPlayerStateCallbacks) cb(state)
})

const miniPlayerWindowApi = {
  getBootstrap: (): Promise<MiniPlayerBootstrap> => ipcRenderer.invoke('miniPlayer:getBootstrap'),
  command: (command: MiniPlayerCommand): void => {
    ipcRenderer.send('miniPlayer:command', command)
  },
  updateSettings: (patch: MiniPlayerSettingsPatch): Promise<MiniPlayerSettings> =>
    ipcRenderer.invoke('miniPlayer:updateSettings', patch),
  chooseBackgroundImage: (): Promise<string | null> =>
    ipcRenderer.invoke('miniPlayer:chooseBackgroundImage'),
  minimize: (): void => {
    ipcRenderer.send('miniPlayer:minimize')
  },
  returnToMain: (): void => {
    ipcRenderer.send('miniPlayer:returnToMain')
  },
  onState: (cb: (state: MiniPlayerStateSnapshot) => void): (() => void) => {
    miniPlayerStateCallbacks.add(cb)
    return () => miniPlayerStateCallbacks.delete(cb)
  },
  onSettings: (cb: (settings: MiniPlayerSettings) => void): (() => void) => {
    miniPlayerSettingsCallbacks.add(cb)
    return () => miniPlayerSettingsCallbacks.delete(cb)
  },
  onMotionPreference: (cb: (preference: MotionPreference) => void): (() => void) => {
    miniPlayerMotionPreferenceCallbacks.add(cb)
    return () => miniPlayerMotionPreferenceCallbacks.delete(cb)
  }
}

const miniPlayerHostApi = {
  ...miniPlayerWindowApi,
  open: (): Promise<MiniPlayerSettings> => ipcRenderer.invoke('miniPlayer:open'),
  publishState: (state: MiniPlayerStateSnapshot): void => {
    ipcRenderer.send('miniPlayer:publishState', state)
  },
  onCommand: (cb: (command: MiniPlayerCommand) => void): (() => void) => {
    miniPlayerCommandCallbacks.add(cb)
    return () => miniPlayerCommandCallbacks.delete(cb)
  }
}

const trayPlayerWindowApi = {
  getBootstrap: (): Promise<TrayPlayerBootstrap> => ipcRenderer.invoke('trayPlayer:getBootstrap'),
  command: (command: MiniPlayerCommand): void => {
    ipcRenderer.send('trayPlayer:command', command)
  },
  navigate: (target: TrayNavigationTarget): void => {
    ipcRenderer.send('trayPlayer:navigate', target)
  },
  hide: (): void => {
    ipcRenderer.send('trayPlayer:hide')
  },
  onState: (cb: (state: MiniPlayerStateSnapshot) => void): (() => void) => {
    trayPlayerStateCallbacks.add(cb)
    return () => trayPlayerStateCallbacks.delete(cb)
  }
}

const api = {
  sleepTimer: {
    configure: (state: import('../shared/sleepTimer.ts').SleepTimerState) =>
      ipcRenderer.invoke('sleepTimer:configure', state),
    cancel: () => ipcRenderer.invoke('sleepTimer:cancel'),
    getState: () => ipcRenderer.invoke('sleepTimer:getState'),
    boundary: (boundary: 'trackEnd' | 'queueEnd') =>
      ipcRenderer.invoke('sleepTimer:boundary', boundary),
    onState: sleepTimerEvents.onState,
    onTrigger: sleepTimerEvents.onTrigger
  },
  ...libraryAndFileSystemApi,
  ...audioEngineApi,
  ...mediaSubscriptionsApi,
  ...networkSourcesApi,
  data: dataApi,
  settings: settingsApi,
  ...systemApi,
  themes: themesApi,
  ...pluginsApi,
  desktopLyrics: desktopLyricsApi,
  miniPlayer: miniPlayerHostApi,
  trayPlayer: trayPlayerWindowApi,
  debug: {
    appendNativeTrace: (message: string): Promise<void> =>
      ipcRenderer.invoke('debug:appendNativeTrace', message)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', exposedApiForDocument())
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = exposedApiForDocument()
}

function exposedApiForDocument():
  | typeof api
  | { desktopLyrics: typeof api.desktopLyrics }
  | { miniPlayer: typeof miniPlayerWindowApi; data: typeof miniPlayerCoverDataApi }
  | { trayPlayer: typeof trayPlayerWindowApi } {
  if (isDesktopLyricsDocument()) return { desktopLyrics: api.desktopLyrics }
  if (isMiniPlayerDocument()) {
    return { miniPlayer: miniPlayerWindowApi, data: miniPlayerCoverDataApi }
  }
  if (isTrayPlayerDocument()) return { trayPlayer: trayPlayerWindowApi }
  return api
}

function isDesktopLyricsDocument(): boolean {
  try {
    return window.location.pathname.endsWith('/desktop-lyrics.html')
  } catch {
    return false
  }
}

function isMiniPlayerDocument(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('window') === 'mini-player'
  } catch {
    return false
  }
}

function isTrayPlayerDocument(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('window') === 'tray-player'
  } catch {
    return false
  }
}
