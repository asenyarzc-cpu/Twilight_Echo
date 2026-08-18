import { ipcRenderer } from 'electron'
import type {
  NetworkEntry,
  NetworkPlaybackPlan,
  NetworkSourceErrorCode,
  NetworkSourceProfileInput,
  NetworkSourceProfileSummary
} from '../../shared/networkSources.ts'
import type {
  DlnaDeviceInfo,
  RemoteControlStatus,
  RemotePlaybackSnapshot
} from '../../shared/remoteControl.ts'

export const networkSourcesApi = {
  networkSources: {
    listProfiles: (): Promise<NetworkSourceProfileSummary[]> =>
      ipcRenderer.invoke('networkSources:listProfiles'),
    createProfile: (
      input: NetworkSourceProfileInput
    ): Promise<NetworkSourceProfileSummary> =>
      ipcRenderer.invoke('networkSources:createProfile', input),
    updateProfile: (
      id: string,
      patch: Partial<NetworkSourceProfileInput>
    ): Promise<NetworkSourceProfileSummary> =>
      ipcRenderer.invoke('networkSources:updateProfile', id, patch),
    deleteProfile: (id: string): Promise<void> =>
      ipcRenderer.invoke('networkSources:deleteProfile', id),
    listDirectory: (profileId: string, remotePath: string): Promise<NetworkEntry[]> =>
      ipcRenderer.invoke('networkSources:listDirectory', profileId, remotePath),
    testConnection: (
      profileId: string
    ): Promise<{
      ok: boolean
      errorCode?: NetworkSourceErrorCode
    }> => ipcRenderer.invoke('networkSources:testConnection', profileId),
    resolvePlayback: (
      profileId: string,
      entry: NetworkEntry
    ): Promise<NetworkPlaybackPlan> =>
      ipcRenderer.invoke('networkSources:resolvePlayback', profileId, entry),
    scanDirectory: (
      profileId: string,
      remotePath: string
    ): Promise<{ added: number; total: number }> =>
      ipcRenderer.invoke('networkSources:scanDirectory', profileId, remotePath),
    listLibrary: (profileId: string, query?: string): Promise<NetworkEntry[]> =>
      ipcRenderer.invoke('networkSources:listLibrary', profileId, query),
    removeLibraryEntry: (profileId: string, entryId: string): Promise<void> =>
      ipcRenderer.invoke('networkSources:removeLibraryEntry', profileId, entryId),
    enrichLibrary: (profileId: string): Promise<{ enriched: number; failed: number }> =>
      ipcRenderer.invoke('networkSources:enrichLibrary', profileId),
    cacheInfo: (): Promise<{ sizeBytes: number }> =>
      ipcRenderer.invoke('networkSources:cacheInfo'),
    clearCache: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('networkSources:clearCache'),
    searchLibrary: (
      query?: string
    ): Promise<
      Array<{
        profileId: string
        profileName: string
        entry: NetworkEntry
      }>
    > => ipcRenderer.invoke('networkSources:searchLibrary', query),
    coverDataUrl: (profileId: string, entryId: string): Promise<string | null> =>
      ipcRenderer.invoke('networkSources:coverDataUrl', profileId, entryId)
  },
  remote: {
    getStatus: (): Promise<RemoteControlStatus> => ipcRenderer.invoke('remote:getStatus'),
    setEnabled: (enabled: boolean): Promise<RemoteControlStatus> =>
      ipcRenderer.invoke('remote:setEnabled', enabled),
    rotatePin: (): Promise<{
      pin: string
      status: RemoteControlStatus
    }> => ipcRenderer.invoke('remote:rotatePin'),
    publishState: (snapshot: Partial<RemotePlaybackSnapshot>): Promise<boolean> =>
      ipcRenderer.invoke('remote:publishState', snapshot),
    discoverDlna: (): Promise<DlnaDeviceInfo[]> => ipcRenderer.invoke('remote:discoverDlna'),
    getDlnaDevices: (): Promise<DlnaDeviceInfo[]> => ipcRenderer.invoke('remote:getDlnaDevices'),
    castToDevice: (payload: {
      usn: string
      /** Authorized local library / managed-cache path. Mutually exclusive with mediaUrl. */
      filePath?: string
      /** Direct http(s) stream URL (podcast / radio / provider). Mutually exclusive with filePath. */
      mediaUrl?: string
      contentType?: string
      title?: string
      artist?: string
      album?: string
      positionSeconds?: number
    }): Promise<{
      ok: true
      usn: string
      friendlyName: string
      mediaUrl: string
    }> => ipcRenderer.invoke('remote:castToDevice', payload),
    stopCast: (): Promise<{ ok: true }> => ipcRenderer.invoke('remote:stopCast'),
    getCastTarget: (): Promise<{ usn: string; friendlyName: string } | null> =>
      ipcRenderer.invoke('remote:getCastTarget'),
    controlCast: (payload: {
      seek?: number
      volume?: number
      pause?: boolean
      play?: boolean
    }): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('remote:controlCast', payload)
  }
}
