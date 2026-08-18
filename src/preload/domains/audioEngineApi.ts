import { IPC } from '../../shared/ipcChannels.ts'
import { ipcRenderer } from 'electron'
import type {
  AudioEngineConfigAppliedCallback,
  AudioEngineConfigAppliedEvent,
  AudioEngineDeviceOptionsChangedCallback,
  AudioEngineEndFileCallback,
  AudioEngineErrorCallback,
  AudioEngineEventCallback,
  AudioEnginePlaybackInfoCallback,
  AudioEnginePlayResult,
  AudioEngineQueueItem,
  AudioEngineServiceCrashCallback,
  AudioEngineServiceReadyCallback,
  AudioEngineSimpleCallback,
  AudioEngineLoudnormStatusCallback,
  AudioOutputId,
  AudioOutputOption,
  AudioOutputState,
  AudioProcessingSettings,
  AudioEqPreset,
  BpmAnalysisCompletedEvent,
  BpmAnalysisRequest,
  BpmAnalysisRequestResult,
  ConvolverInfo,
  DspAsset,
  DspAssetKind,
  DspCorrectionImportResult,
  DspCorrectionProfile,
  DspGraphStatus,
  DspOutputStageConfig,
  DspProfile,
  DspScene,
  DspSceneState,
  DspStereoImageConfig,
  ImportedFrequencyResponse,
  LoudnormStatusEvent,
  LoudnessAnalysisCompletedEvent,
  LoudnessAnalysisRequest,
  LoudnessAnalysisRequestResult,
  NativeAudioMetadata,
  OpraCatalogStatus,
  OpraProfile,
  OutputConfig,
  OutputConfigApplyStatus,
  PlaybackInfo,
  PlayMode,
  VisualizationData,
  VolumeNormalizationMode,
  Vst3CatalogState,
  VisualizationOptions
} from '../types'

const audioEngineEventCallbacks = new Set<AudioEngineEventCallback>()
const audioEngineEndFileCallbacks = new Set<AudioEngineEndFileCallback>()
const audioEngineStartFileCallbacks = new Set<AudioEngineSimpleCallback>()
const audioEngineReadyCallbacks = new Set<AudioEngineSimpleCallback>()
const audioEngineErrorCallbacks = new Set<AudioEngineErrorCallback>()
const audioEngineDisconnectedCallbacks = new Set<AudioEngineSimpleCallback>()
const audioEnginePlaybackInfoCallbacks = new Set<AudioEnginePlaybackInfoCallback>()
const audioEngineLoudnormStatusCallbacks = new Set<AudioEngineLoudnormStatusCallback>()
const audioEngineConfigAppliedCallbacks = new Set<AudioEngineConfigAppliedCallback>()
const audioEngineDeviceOptionsChangedCallbacks = new Set<AudioEngineDeviceOptionsChangedCallback>()
const audioEngineServiceCrashCallbacks = new Set<AudioEngineServiceCrashCallback>()
const audioEngineServiceReadyCallbacks = new Set<AudioEngineServiceReadyCallback>()

export function bindAudioEngineIpcEvents(): void {
  ipcRenderer.on(
    IPC.audioEngine.propertyChange,
    (_event, data: { name: string; data: unknown }) => {
      for (const cb of audioEngineEventCallbacks) {
        cb(data)
      }
    }
  )

  ipcRenderer.on(IPC.audioEngine.endFile, (_event, data: { reason: string }) => {
    for (const cb of audioEngineEndFileCallbacks) {
      cb(data.reason)
    }
  })

  ipcRenderer.on(IPC.audioEngine.startFile, () => {
    for (const cb of audioEngineStartFileCallbacks) {
      cb()
    }
  })

  ipcRenderer.on(IPC.audioEngine.ready, () => {
    for (const cb of audioEngineReadyCallbacks) {
      cb()
    }
  })

  ipcRenderer.on(IPC.audioEngine.error, (_event, message: string) => {
    for (const cb of audioEngineErrorCallbacks) {
      cb(message)
    }
  })

  ipcRenderer.on(IPC.audioEngine.disconnected, () => {
    for (const cb of audioEngineDisconnectedCallbacks) {
      cb()
    }
  })

  ipcRenderer.on(IPC.audioEngine.playbackInfo, (_event, info: PlaybackInfo) => {
    for (const cb of audioEnginePlaybackInfoCallbacks) {
      cb(info)
    }
  })

  ipcRenderer.on(IPC.audioEngine.loudnormStatus, (_event, event: LoudnormStatusEvent) => {
    for (const cb of audioEngineLoudnormStatusCallbacks) {
      cb(event)
    }
  })

  ipcRenderer.on(IPC.audioEngine.configApplied, (_event, event: AudioEngineConfigAppliedEvent) => {
    for (const cb of audioEngineConfigAppliedCallbacks) {
      cb(event)
    }
  })

  ipcRenderer.on(IPC.audioEngine.deviceOptionsChanged, (_event, event: { reason: string }) => {
    for (const cb of audioEngineDeviceOptionsChangedCallbacks) {
      cb(event)
    }
  })

  ipcRenderer.on(IPC.audioEngine.serviceCrash, (_event, event: { reason: string }) => {
    for (const cb of audioEngineServiceCrashCallbacks) {
      cb(event)
    }
  })

  ipcRenderer.on(
    IPC.audioEngine.serviceReady,
    (
      _event,
      event: { manualResumeRequired: boolean; outputRouteSynced: boolean; restoreErrors: string[] }
    ) => {
      for (const cb of audioEngineServiceReadyCallbacks) {
        cb(event)
      }
    }
  )
}

export const audioEngineApi = {
  audioEngine: {
    loadQueue: (items: AudioEngineQueueItem[], startIndex?: number): Promise<void> =>
      ipcRenderer.invoke(IPC.audioEngine.loadQueue, items, startIndex),
    play: (filePath: string, startTime?: number): Promise<AudioEnginePlayResult> =>
      ipcRenderer.invoke(IPC.audioEngine.play, filePath, startTime),
    isHtmlAudioFallbackAllowed: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC.audioEngine.isHtmlAudioFallbackAllowed),
    togglePause: (): Promise<void> => ipcRenderer.invoke(IPC.audioEngine.togglePause),
    seek: (time: number): Promise<void> => ipcRenderer.invoke(IPC.audioEngine.seek, time),
    setVolume: (volume: number): Promise<void> =>
      ipcRenderer.invoke(IPC.audioEngine.setVolume, volume),
    setPlaybackRate: (rate: number): Promise<void> =>
      ipcRenderer.invoke(IPC.audioEngine.setPlaybackRate, rate),
    setLoopRange: (startSeconds: number, endSeconds: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC.audioEngine.setLoopRange, startSeconds, endSeconds),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.audioEngine.stop),
    next: (): Promise<void> => ipcRenderer.invoke(IPC.audioEngine.next),
    previous: (): Promise<void> => ipcRenderer.invoke(IPC.audioEngine.previous),
    setPlayMode: (mode: PlayMode): Promise<void> =>
      ipcRenderer.invoke(IPC.audioEngine.setPlayMode, mode),
    getUpcomingTrack: (): Promise<AudioEngineQueueItem | null> =>
      ipcRenderer.invoke(IPC.audioEngine.getUpcomingTrack),
    setExclusiveMode: (enabled: boolean): Promise<AudioOutputState> =>
      ipcRenderer.invoke(IPC.audioEngine.setExclusiveMode, enabled),
    getExclusiveMode: (): Promise<boolean> => ipcRenderer.invoke(IPC.audioEngine.getExclusiveMode),
    setAudioOutput: (output: AudioOutputId, device?: string): Promise<AudioOutputState> =>
      ipcRenderer.invoke(IPC.audioEngine.setAudioOutput, output, device),
    setAudioDevice: (device: string): Promise<AudioOutputState> =>
      ipcRenderer.invoke(IPC.audioEngine.setAudioDevice, device),
    setOutputConfig: (config: OutputConfig): Promise<OutputConfig> =>
      ipcRenderer.invoke(IPC.audioEngine.setOutputConfig, config),
    getOutputConfigApplyStatus: (): Promise<OutputConfigApplyStatus> =>
      ipcRenderer.invoke(IPC.audioEngine.getOutputConfigApplyStatus),
    getAudioOutput: (): Promise<AudioOutputId> =>
      ipcRenderer.invoke(IPC.audioEngine.getAudioOutput),
    getAudioOutputOptions: (): Promise<AudioOutputOption[]> =>
      ipcRenderer.invoke(IPC.audioEngine.getAudioOutputOptions),
    getAudioOutputState: (): Promise<AudioOutputState> =>
      ipcRenderer.invoke(IPC.audioEngine.getAudioOutputState),
    setAudioProcessing: (
      settings: Partial<AudioProcessingSettings>
    ): Promise<AudioProcessingSettings> =>
      ipcRenderer.invoke(IPC.audioEngine.setAudioProcessing, JSON.parse(JSON.stringify(settings))),
    getAudioProcessing: (): Promise<AudioProcessingSettings> =>
      ipcRenderer.invoke(IPC.audioEngine.getAudioProcessing),
    getDspSceneState: (): Promise<DspSceneState> =>
      ipcRenderer.invoke(IPC.audioEngine.getDspSceneState),
    setDspScenes: (scenes: DspScene[], pinnedSceneId?: string | null): Promise<DspSceneState> =>
      ipcRenderer.invoke(IPC.audioEngine.setDspScenes, scenes, pinnedSceneId),
    setOutputStage: (partial: Partial<DspOutputStageConfig>): Promise<DspSceneState> =>
      ipcRenderer.invoke(IPC.audioEngine.setOutputStage, partial),
    setStereoImage: (partial: Partial<DspStereoImageConfig>): Promise<DspSceneState> =>
      ipcRenderer.invoke(IPC.audioEngine.setStereoImage, partial),
    applyDspScene: (
      sceneId: string | null,
      confirmDsdPcmFallback = false
    ): Promise<DspSceneState> =>
      ipcRenderer.invoke(IPC.audioEngine.applyDspScene, sceneId, confirmDsdPcmFallback),
    getDspGraphStatus: (): Promise<DspGraphStatus> =>
      ipcRenderer.invoke(IPC.audioEngine.getDspGraphStatus),
    getDspAssets: (): Promise<DspAsset[]> => ipcRenderer.invoke(IPC.audioEngine.getDspAssets),
    importDspAsset: (kind: DspAssetKind): Promise<DspAsset | null> =>
      ipcRenderer.invoke(IPC.audioEngine.importDspAsset, kind),
    importDspCorrectionProfile: (): Promise<DspCorrectionImportResult | null> =>
      ipcRenderer.invoke(IPC.audioEngine.importDspCorrectionProfile),
    importFrequencyResponse: (): Promise<ImportedFrequencyResponse | null> =>
      ipcRenderer.invoke(IPC.audioEngine.importFrequencyResponse),
    getDspCorrectionProfile: (assetId: string): Promise<DspCorrectionProfile> =>
      ipcRenderer.invoke(IPC.audioEngine.getDspCorrectionProfile, assetId),
    deleteDspAsset: (assetId: string): Promise<DspAsset[]> =>
      ipcRenderer.invoke(IPC.audioEngine.deleteDspAsset, assetId),
    exportDspProfile: (name?: string): Promise<DspProfile | null> =>
      ipcRenderer.invoke(IPC.audioEngine.exportDspProfile, name),
    importDspProfile: (): Promise<{
      state: DspSceneState
      profile: DspProfile
      importedAssets: DspAsset[]
    } | null> => ipcRenderer.invoke(IPC.audioEngine.importDspProfile),
    getVst3Catalog: (): Promise<Vst3CatalogState> =>
      ipcRenderer.invoke(IPC.audioEngine.getVst3Catalog),
    setVst3Enabled: (enabled: boolean): Promise<Vst3CatalogState> =>
      ipcRenderer.invoke(IPC.audioEngine.setVst3Enabled, enabled),
    selectVst3SearchPath: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.audioEngine.selectVst3SearchPath),
    setVst3SearchPaths: (paths: string[]): Promise<Vst3CatalogState> =>
      ipcRenderer.invoke(IPC.audioEngine.setVst3SearchPaths, paths),
    scanVst3Plugins: (): Promise<Vst3CatalogState> =>
      ipcRenderer.invoke(IPC.audioEngine.scanVst3Plugins),
    clearVst3Quarantine: (id: string): Promise<Vst3CatalogState> =>
      ipcRenderer.invoke(IPC.audioEngine.clearVst3Quarantine, id),
    selectImpulseResponse: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.audioEngine.selectImpulseResponse),
    loadImpulseResponse: (path: string): Promise<ConvolverInfo> =>
      ipcRenderer.invoke(IPC.audioEngine.loadImpulseResponse, path),
    unloadImpulseResponse: (): Promise<ConvolverInfo> =>
      ipcRenderer.invoke(IPC.audioEngine.unloadImpulseResponse),
    getConvolverInfo: (): Promise<ConvolverInfo> =>
      ipcRenderer.invoke(IPC.audioEngine.getConvolverInfo),
    setEqBands: (settings: Partial<AudioProcessingSettings>): Promise<AudioProcessingSettings> =>
      ipcRenderer.invoke(IPC.audioEngine.setEqBands, settings),
    setEqPreset: (preset: AudioEqPreset): Promise<AudioProcessingSettings> =>
      ipcRenderer.invoke(IPC.audioEngine.setEqPreset, preset),
    setCrossfeedStrength: (strength: number): Promise<AudioProcessingSettings> =>
      ipcRenderer.invoke(IPC.audioEngine.setCrossfeedStrength, strength),
    setReplayGainMode: (
      mode: VolumeNormalizationMode,
      preamp?: number,
      fallback?: number,
      clip?: boolean
    ): Promise<AudioProcessingSettings> =>
      ipcRenderer.invoke(IPC.audioEngine.setReplayGainMode, mode, preamp, fallback, clip),
    getMetadata: (source: string): Promise<NativeAudioMetadata | null> =>
      ipcRenderer.invoke(IPC.audioEngine.getMetadata, source),
    getPlaybackInfo: (): Promise<PlaybackInfo> =>
      ipcRenderer.invoke(IPC.audioEngine.getPlaybackInfo),
    exportDiagnostics: (): Promise<{ filePath: string | null }> =>
      ipcRenderer.invoke(IPC.audioEngine.exportDiagnostics),
    getSpectrumData: (points?: number): Promise<number[]> =>
      ipcRenderer.invoke(IPC.audioEngine.getSpectrumData, points),
    getVisualizationData: (options?: VisualizationOptions): Promise<VisualizationData> =>
      ipcRenderer.invoke(IPC.audioEngine.getVisualizationData, options),
    onPropertyChange: (cb: AudioEngineEventCallback): (() => void) => {
      audioEngineEventCallbacks.add(cb)
      return () => audioEngineEventCallbacks.delete(cb)
    },
    onEndFile: (cb: AudioEngineEndFileCallback): (() => void) => {
      audioEngineEndFileCallbacks.add(cb)
      return () => audioEngineEndFileCallbacks.delete(cb)
    },
    onStartFile: (cb: AudioEngineSimpleCallback): (() => void) => {
      audioEngineStartFileCallbacks.add(cb)
      return () => audioEngineStartFileCallbacks.delete(cb)
    },
    onReady: (cb: AudioEngineSimpleCallback): (() => void) => {
      audioEngineReadyCallbacks.add(cb)
      return () => audioEngineReadyCallbacks.delete(cb)
    },
    onError: (cb: AudioEngineErrorCallback): (() => void) => {
      audioEngineErrorCallbacks.add(cb)
      return () => audioEngineErrorCallbacks.delete(cb)
    },
    onDisconnected: (cb: AudioEngineSimpleCallback): (() => void) => {
      audioEngineDisconnectedCallbacks.add(cb)
      return () => audioEngineDisconnectedCallbacks.delete(cb)
    },
    onPlaybackInfo: (cb: AudioEnginePlaybackInfoCallback): (() => void) => {
      audioEnginePlaybackInfoCallbacks.add(cb)
      return () => audioEnginePlaybackInfoCallbacks.delete(cb)
    },
    onLoudnormStatus: (cb: AudioEngineLoudnormStatusCallback): (() => void) => {
      audioEngineLoudnormStatusCallbacks.add(cb)
      return () => audioEngineLoudnormStatusCallbacks.delete(cb)
    },
    onConfigApplied: (cb: AudioEngineConfigAppliedCallback): (() => void) => {
      audioEngineConfigAppliedCallbacks.add(cb)
      return () => audioEngineConfigAppliedCallbacks.delete(cb)
    },
    onDeviceOptionsChanged: (cb: AudioEngineDeviceOptionsChangedCallback): (() => void) => {
      audioEngineDeviceOptionsChangedCallbacks.add(cb)
      return () => audioEngineDeviceOptionsChangedCallbacks.delete(cb)
    },
    onServiceCrash: (cb: AudioEngineServiceCrashCallback): (() => void) => {
      audioEngineServiceCrashCallbacks.add(cb)
      return () => audioEngineServiceCrashCallbacks.delete(cb)
    },
    onServiceReady: (cb: AudioEngineServiceReadyCallback): (() => void) => {
      audioEngineServiceReadyCallbacks.add(cb)
      return () => audioEngineServiceReadyCallbacks.delete(cb)
    }
  },
  bpmAnalysis: {
    request: (request: BpmAnalysisRequest): Promise<BpmAnalysisRequestResult> =>
      ipcRenderer.invoke('bpmAnalysis:request', request),
    getCacheSize: (): Promise<number> => ipcRenderer.invoke('bpmAnalysis:getCacheSize'),
    clearCache: (): Promise<number> => ipcRenderer.invoke('bpmAnalysis:clearCache'),
    cancel: (filePath?: string): Promise<void> =>
      ipcRenderer.invoke('bpmAnalysis:cancel', filePath),
    onCompleted: (cb: (event: BpmAnalysisCompletedEvent) => void): (() => void) => {
      const handler = (_event, data: BpmAnalysisCompletedEvent): void => cb(data)
      ipcRenderer.on('bpmAnalysis:completed', handler)
      return () => ipcRenderer.removeListener('bpmAnalysis:completed', handler)
    }
  },
  loudnessAnalysis: {
    request: (request: LoudnessAnalysisRequest): Promise<LoudnessAnalysisRequestResult> =>
      ipcRenderer.invoke('loudnessAnalysis:request', request),
    getCacheSize: (): Promise<number> => ipcRenderer.invoke('loudnessAnalysis:getCacheSize'),
    clearCache: (): Promise<number> => ipcRenderer.invoke('loudnessAnalysis:clearCache'),
    getStatus: (): Promise<{ status: string; source: string | null }> =>
      ipcRenderer.invoke('loudnessAnalysis:getStatus'),
    cancel: (filePath?: string): Promise<void> =>
      ipcRenderer.invoke('loudnessAnalysis:cancel', filePath),
    onCompleted: (cb: (event: LoudnessAnalysisCompletedEvent) => void): (() => void) => {
      const handler = (_event, data: LoudnessAnalysisCompletedEvent): void => cb(data)
      ipcRenderer.on('loudnessAnalysis:completed', handler)
      return () => ipcRenderer.removeListener('loudnessAnalysis:completed', handler)
    }
  },
  opra: {
    search: (query: string): Promise<OpraProfile[]> => ipcRenderer.invoke('opra:search', query),
    getProfile: (eqId: string): Promise<OpraProfile | null> =>
      ipcRenderer.invoke('opra:getProfile', eqId),
    refresh: (): Promise<OpraCatalogStatus> => ipcRenderer.invoke('opra:refresh'),
    getStatus: (): Promise<OpraCatalogStatus> => ipcRenderer.invoke('opra:getStatus')
  }
}
