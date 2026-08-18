import { ipcRenderer } from 'electron'
import type {
  AppSettings,
  PlayerShortcutAction,
  PlayerShortcutStatus,
  SettingsSnapshot
} from '../types'

const settingsChangedCallbacks = new Set<(snapshot: SettingsSnapshot) => void>()
const playerShortcutCallbacks = new Set<(action: PlayerShortcutAction) => void>()

export function bindSettingsIpcEvents(): void {
  ipcRenderer.on('player:shortcut', (_event, action: PlayerShortcutAction) => {
    for (const cb of playerShortcutCallbacks) {
      cb(action)
    }
  })

  ipcRenderer.on('settings:changed', (_event, snapshot: SettingsSnapshot) => {
    for (const cb of settingsChangedCallbacks) {
      cb(snapshot)
    }
  })
}

export const settingsApi = {
  get: (): Promise<SettingsSnapshot> => ipcRenderer.invoke('settings:get'),
  update: (patch: Partial<AppSettings>): Promise<SettingsSnapshot> =>
    ipcRenderer.invoke('settings:update', JSON.parse(JSON.stringify(patch))),
  chooseCacheFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('settings:chooseCacheFolder'),
  chooseBackgroundImage: (): Promise<string | null> =>
    ipcRenderer.invoke('settings:chooseBackgroundImage'),
  importBackgroundImage: (fileName: string, data: ArrayBuffer): Promise<string | null> =>
    ipcRenderer.invoke('settings:importBackgroundImage', fileName, data),
  exportBackup: (): Promise<string> => ipcRenderer.invoke('settings:export'),
  importBackup: (json: string): Promise<SettingsSnapshot> =>
    ipcRenderer.invoke('settings:import', json),
  getCacheSize: (): Promise<number> => ipcRenderer.invoke('settings:getCacheSize'),
  clearCache: (): Promise<number> => ipcRenderer.invoke('settings:clearCache'),
  getShortcutStatuses: (): Promise<PlayerShortcutStatus[]> =>
    ipcRenderer.invoke('settings:getShortcutStatuses'),
  onChanged: (cb: (snapshot: SettingsSnapshot) => void): (() => void) => {
    settingsChangedCallbacks.add(cb)
    return () => settingsChangedCallbacks.delete(cb)
  },
  onPlayerShortcut: (cb: (action: PlayerShortcutAction) => void): (() => void) => {
    playerShortcutCallbacks.add(cb)
    return () => playerShortcutCallbacks.delete(cb)
  }
}
