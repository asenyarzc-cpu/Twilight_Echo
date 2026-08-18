import { collectClosePersistenceOutcome } from '../closePersistence.ts'
import { ipcRenderer } from 'electron'
import { NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL } from '../../shared/ncmCloud.ts'
import type {
  NcmCloudDownloadRequest,
  NcmCloudDownloadResult,
  NcmCloudSelectedFile,
  NcmCloudTransferProgress,
  NcmCloudUploadResult,
  TrayNavigationTarget
} from '../types'
import type { AppStartupSnapshot } from '../../shared/appStartup.ts'
import type {
  AppUpdateCheckResult,
  AppUpdateDownloadResult,
  AppUpdateInstallResult,
  AppUpdateProgress
} from '../../shared/appUpdate.ts'

const appNavigationCallbacks = new Set<(target: TrayNavigationTarget) => void>()
const savePlaybackSessionCallbacks = new Set<() => Promise<void> | void>()

export function bindSystemIpcEvents(): void {
  ipcRenderer.on('app:save-playback-session', async (_event, requestId: string) => {
    const outcome = await collectClosePersistenceOutcome(savePlaybackSessionCallbacks)
    try {
      await ipcRenderer.invoke('app:playback-session-saved', requestId, outcome)
    } catch (error) {
      // The main process treats a missing result as a timeout and keeps the
      // window open. Do not convert this IPC failure into a successful ACK.
      console.error('[persistence] Failed to report close persistence outcome:', error)
    }
  })

  ipcRenderer.on('app:navigate', (_event, target: TrayNavigationTarget) => {
    if (target !== 'local' && target !== 'streaming') return
    for (const cb of appNavigationCallbacks) cb(target)
  })
}

export const systemApi = {
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
    close: (): void => ipcRenderer.send('window:close')
  },
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder')
  },
  shell: {
    showItemInFolder: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },
  discord: {
    getStatus: (): Promise<{
      enabled: boolean
      connected: boolean
      lastError: string | null
    }> => ipcRenderer.invoke('discord:getStatus'),
    updateActivity: (data: {
      title: string
      artist: string
      album?: string
      playing: boolean
      startTime?: number
    }): Promise<void> => ipcRenderer.invoke('discord:updateActivity', data),
    clearActivity: (): Promise<void> => ipcRenderer.invoke('discord:clearActivity')
  },
  app: {
    getStartupSnapshot: (): Promise<AppStartupSnapshot> =>
      ipcRenderer.invoke('app:getStartupSnapshot'),
    consumePendingNavigation: (): Promise<TrayNavigationTarget | null> =>
      ipcRenderer.invoke('app:consumePendingNavigation'),
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
    checkForUpdates: (): Promise<AppUpdateCheckResult> => ipcRenderer.invoke('app:checkForUpdates'),
    downloadUpdate: (): Promise<AppUpdateDownloadResult> =>
      ipcRenderer.invoke('app:downloadUpdate'),
    cancelUpdateDownload: (): Promise<boolean> => ipcRenderer.invoke('app:cancelUpdateDownload'),
    installUpdate: (): Promise<AppUpdateInstallResult> => ipcRenderer.invoke('app:installUpdate'),
    onUpdateProgress: (cb: (progress: AppUpdateProgress) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: AppUpdateProgress): void => {
        cb(progress)
      }
      ipcRenderer.on('app:update-progress', handler)
      return () => ipcRenderer.removeListener('app:update-progress', handler)
    },
    onSavePlaybackSession: (cb: () => Promise<void> | void): (() => void) => {
      savePlaybackSessionCallbacks.add(cb)
      return () => savePlaybackSessionCallbacks.delete(cb)
    },
    onNavigate: (cb: (target: TrayNavigationTarget) => void): (() => void) => {
      appNavigationCallbacks.add(cb)
      return () => appNavigationCallbacks.delete(cb)
    }
  },
  ncm: {
    getPort: (): Promise<number> => ipcRenderer.invoke('ncm:getPort'),
    request: (path: string, cookie?: string): Promise<unknown> =>
      ipcRenderer.invoke('ncm:request', path, cookie),
    getCachedSong: (songId: number): Promise<string | null> =>
      ipcRenderer.invoke('ncm:getCachedSong', songId),
    cacheSong: (songId: number, url: string, fileName?: string): Promise<string | null> =>
      ipcRenderer.invoke('ncm:cacheSong', songId, url, fileName)
  },
  ncmCloud: {
    chooseUploadFiles: (): Promise<NcmCloudSelectedFile[]> =>
      ipcRenderer.invoke('ncmCloud:chooseUploadFiles'),
    upload: (handle: string): Promise<NcmCloudUploadResult> =>
      ipcRenderer.invoke('ncmCloud:upload', handle),
    download: (request: NcmCloudDownloadRequest): Promise<NcmCloudDownloadResult> =>
      ipcRenderer.invoke('ncmCloud:download', request),
    cancel: (transferId: string): Promise<boolean> =>
      ipcRenderer.invoke('ncmCloud:cancel', transferId),
    onProgress: (callback: (progress: NcmCloudTransferProgress) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: NcmCloudTransferProgress
      ): void => {
        callback(progress)
      }
      ipcRenderer.on(NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL, handler)
      return () => ipcRenderer.removeListener(NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL, handler)
    }
  },
  fonts: {
    listInstalled: (): Promise<string[]> => ipcRenderer.invoke('fonts:listInstalled')
  }
}
