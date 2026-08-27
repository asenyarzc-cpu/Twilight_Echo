import type { DspStatePayload } from '../../shared/audioServiceContract.ts'
import type { DspGraphStatus, Vst3ScanDescriptor } from '../../shared/dspGraph.ts'
import type {
  AudioDeviceOption,
  BpmAnalysisResult,
  ConvolverInfo,
  LoudnessAnalysisResult,
  NativeAudioMetadata,
  PlaybackInfo,
  VisualizationData
} from '../../shared/audioEngineTypes.ts'

export type * from '../../shared/audioEngineTypes.ts'

export type { DspSceneState } from '../../shared/dspGraph.ts'

export interface AudioEngineScheduler {
  now: () => number
  setInterval: (callback: () => void, delayMs: number) => NodeJS.Timeout
  clearInterval: (handle: NodeJS.Timeout) => void
  setImmediate: (callback: () => void) => void
}

export interface NativeAudioBinding {
  Play: (source: string, startTime?: number) => void
  Pause: () => void
  Stop: () => void
  Seek: (time: number) => void
  SetVolume: (volume: number) => void
  SetPlaybackRate: (rate: number) => void
  /** A-B loop; end <= start clears. Optional on older native bindings. */
  SetLoopRange?: (startSeconds: number, endSeconds: number) => void
  SetOutputDevice: (device: string) => void
  SetOutputBackend: (backend: string) => void
  SetOutputConfig?: (json: string) => void
  LoadQueue?: (queueJson: string, startIndex: number) => void
  Next?: () => void
  Previous?: () => void
  SetPlayMode?: (mode: 'sequential' | 'repeat' | 'shuffle') => void
  SetDspConfig?: (json: string) => void
  SetDspGraph?: (json: string) => void
  ApplyDspState: (revision: number, json: string) => void
  GetDspGraphStatus: () => string | DspGraphStatus
  LoadImpulseResponse?: (path: string) => void
  UnloadImpulseResponse?: () => void
  GetConvolverInfo?: () => string | ConvolverInfo
  SetEqBands?: (json: string) => void
  SetEqPreset?: (json: string) => void
  SetCrossfeedStrength?: (strength: number) => void
  SetReplayGainMode?: (
    mode: import('../../shared/audioProcessingOptions.ts').VolumeNormalizationMode,
    preamp: number,
    fallback: number,
    clip: boolean
  ) => void
  SetDspPluginChain?: (json: string) => void
  GetDspPluginStatus?: () => string | { plugins: unknown[] }
  ScanVst3Module?: (modulePath: string) => string | Vst3ScanDescriptor
  GetMetadata?: (source: string) => string | NativeAudioMetadata
  GetPlaybackInfo?: () => string | PlaybackInfo
  /** 引擎诊断事件环形日志：返回 sequence 大于 sinceSequence 的新条目（JSON 数组字符串）。 */
  GetDiagnosticLog?: (sinceSequence?: number, maxEntries?: number) => string
  GetUpcomingTrack?: () =>
    | string
    | import('../../shared/audioEngineTypes.ts').AudioEngineQueueItem
    | null
  GetSpectrumData?: (points?: number) => number[]
  GetVisualizationData?: (optionsJson: string) => string | VisualizationData
  AnalyzeBpm?: (source: string, optionsJson?: string) => string | BpmAnalysisResult
  AnalyzeLoudness?: (source: string, optionsJson?: string) => string | LoudnessAnalysisResult
  EnumerateDevices?: () => string | AudioDeviceOption[]
  EnumerateBackends?: () => string
  GetEngineCapabilities?: () => string
  GetLastError?: () => string
  /** 异步调用原生方法（service 模式下等待 utility 进程返回）。直接 N-API 模式不实现此方法。 */
  callAsync?: (method: string, args: unknown[]) => Promise<unknown>
}

export interface AudioEngineServiceNativeBinding extends NativeAudioBinding {
  getMetadataAsync: (source: string) => Promise<string | NativeAudioMetadata>
  applyDspState: (revision: number, payload: DspStatePayload) => Promise<DspGraphStatus>
  applyDspGraph: (json: string) => Promise<DspGraphStatus>
  getDspGraphStatusAsync: () => Promise<DspGraphStatus>
  destroy: () => void
  // Present on the real service binding: the fatal-startup latch and its manual
  // release. Optional so lightweight test doubles need not implement them.
  restartAfterFatal?: () => boolean
  readonly fatalStartupError?: string
  on: (
    event: 'crash' | 'error-log' | 'log' | 'ready',
    listener: (...args: any[]) => void
  ) => unknown
}

export interface AudioEngineManagerDependencies {
  nativeBinding?: NativeAudioBinding | null
  scheduler?: Partial<AudioEngineScheduler>
  deviceOptionsProvider?: () => AudioDeviceOption[] | null
  nativeAddonCandidates?: () => string[]
  audioServiceEntry?: string
  audioServiceFactory?: () => AudioEngineServiceNativeBinding
  dspAssetPathResolver?: (assetId: string) => string | null
  vst3ModuleResolver?: (
    catalogId: string,
    classId: string
  ) => {
    modulePath: string | null
    classId: string
    reason: string
  }
  vst3StateAssetResolver?: (assetId: string) => {
    path: string | null
    kind: 'vst3Preset' | 'vst3State' | null
    reason: string
  }
}
