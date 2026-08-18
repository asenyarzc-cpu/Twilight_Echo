import { IPC } from '../../shared/ipcChannels.ts'
import { ipcRenderer } from 'electron'
import type {
  DuplicateDetectionReadApi,
  DuplicateDetectionResult,
  LibraryChange,
  LocalLibraryRemoveRequest,
  LocalLibraryRemoveResult,
  LocalLibraryResetResult,
  LocalLibraryRestoreRequest,
  LocalLibraryRestoreResult,
  LocalLibraryScanProgress,
  LocalLibraryScanStatus,
  LocalLibraryScanUpdate,
  LocalLibraryTagRestoreRequest,
  LocalLibraryTagRestoreResult,
  LocalLibraryTagWriteRequest,
  LocalLibraryTagWriteResult,
  LibraryWatcherStatusSnapshot
} from '../types'

const duplicateDetectionApi: DuplicateDetectionReadApi = {
  detectDuplicates: (): Promise<DuplicateDetectionResult> =>
    ipcRenderer.invoke(IPC.library.detectDuplicates)
}

export const libraryAndFileSystemApi = {
  library: {
    removeTracks: (request: LocalLibraryRemoveRequest): Promise<LocalLibraryRemoveResult> =>
      ipcRenderer.invoke(IPC.library.removeTracks, request),
    restoreExclusions: (request: LocalLibraryRestoreRequest): Promise<LocalLibraryRestoreResult> =>
      ipcRenderer.invoke(IPC.library.restoreExclusions, request),
    reset: (): Promise<LocalLibraryResetResult> => ipcRenderer.invoke(IPC.library.reset),
    ...duplicateDetectionApi,
    writeTags: (request: LocalLibraryTagWriteRequest): Promise<LocalLibraryTagWriteResult> =>
      ipcRenderer.invoke(IPC.library.writeTags, request),
    restoreTags: (request: LocalLibraryTagRestoreRequest): Promise<LocalLibraryTagRestoreResult> =>
      ipcRenderer.invoke(IPC.library.restoreTags, request),
    scanStartup: (): Promise<LocalLibraryScanUpdate> => ipcRenderer.invoke(IPC.library.scanStartup),
    scanFull: (): Promise<LocalLibraryScanUpdate> => ipcRenderer.invoke(IPC.library.scanFull),
    getScanStatus: (): Promise<LocalLibraryScanStatus> =>
      ipcRenderer.invoke(IPC.library.getScanStatus),
    getWatcherStatus: (): Promise<LibraryWatcherStatusSnapshot> =>
      ipcRenderer.invoke(IPC.library.getWatcherStatus),
    pauseScan: (): Promise<boolean> => ipcRenderer.invoke(IPC.library.pauseScan),
    resumeScan: (): Promise<boolean> => ipcRenderer.invoke(IPC.library.resumeScan),
    cancelScan: (): Promise<boolean> => ipcRenderer.invoke(IPC.library.cancelScan),
    onChanged: (cb: (change: LibraryChange | undefined) => void): (() => void) => {
      const handler = (_event, change: LibraryChange | undefined): void => cb(change)
      ipcRenderer.on(IPC.library.changed, handler)
      return () => ipcRenderer.removeListener(IPC.library.changed, handler)
    },
    onCoversMissing: (cb: (info: { dirtyCount: number }) => void): (() => void) => {
      const handler = (_event, info: { dirtyCount: number }): void => cb(info)
      ipcRenderer.on(IPC.library.coversMissing, handler)
      return () => ipcRenderer.removeListener(IPC.library.coversMissing, handler)
    },
    onScanProgress: (cb: (progress: LocalLibraryScanProgress) => void): (() => void) => {
      const handler = (_event, progress: LocalLibraryScanProgress): void => cb(progress)
      ipcRenderer.on(IPC.library.scanProgress, handler)
      return () => ipcRenderer.removeListener(IPC.library.scanProgress, handler)
    },
    onScanStatus: (cb: (status: LocalLibraryScanStatus) => void): (() => void) => {
      const handler = (_event, status: LocalLibraryScanStatus): void => cb(status)
      ipcRenderer.on(IPC.library.scanStatus, handler)
      return () => ipcRenderer.removeListener(IPC.library.scanStatus, handler)
    }
  },
  fs: {
    scanMusicFiles: (folderPath: string): Promise<unknown[]> =>
      ipcRenderer.invoke('fs:scanMusicFiles', folderPath),
    readAudioFile: (filePath: string): Promise<{ buffer: ArrayBuffer; mimeType: string }> =>
      ipcRenderer.invoke('fs:readAudioFile', filePath),
    getAudioFileUrl: (filePath: string): Promise<string> =>
      ipcRenderer.invoke('fs:getAudioFileUrl', filePath),
    isAudioFileAuthorized: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:isAudioFileAuthorized', filePath),
    onScanProgress: (cb: (progress: { current: number; total: number }) => void): (() => void) => {
      const handler = (_event, data: { current: number; total: number }): void => cb(data)
      ipcRenderer.on('fs:scanProgress', handler)
      return () => ipcRenderer.removeListener('fs:scanProgress', handler)
    }
  }
}
