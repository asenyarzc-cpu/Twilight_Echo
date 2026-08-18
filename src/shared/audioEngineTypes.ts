import type { CueRange } from './cue.ts'
import type { DsdRouteSettings } from './audioProcessingOptions.ts'

export type { DsdRouteSettings }
export type {
  VolumeNormalizationMode,
  DsdOutputMode,
  LoudnormStatus
} from './audioProcessingOptions.ts'
import type { DsdOutputMode, VolumeNormalizationMode } from './audioProcessingOptions.ts'

export type AudioOutputId = 'wasapi' | 'asio' | 'coreaudio' | 'alsa'
export type PlayMode = 'sequential' | 'listLoop' | 'repeat' | 'shuffle' | 'heart'
export type EqMode = 'graphic' | 'parametric'
export type ChannelRoutingMode =
  | 'auto'
  | 'stereo'
  | 'stereo-to-5.1'
  | 'stereo-to-7.1'
  | 'mono-to-stereo'
  | 'mono-to-multichannel'
/** PCM → DSD output-stage modulation; off keeps PCM sources on the float/typed PCM path. */
export type PcmToDsdMode = 'off' | 'dsd64' | 'dsd128' | 'dsd256'
export type SacdProgramMode = 'auto' | 'stereo' | 'multichannel'
export type EqualizerFilterType =
  | 'peak'
  | 'lowShelf'
  | 'highShelf'
  | 'bandPass'
  | 'lowPass'
  | 'highPass'
  | 'allPass'
  | 'notch'

export interface EqualizerBand {
  frequency: number
  gain: number
  q: number
  filterType: EqualizerFilterType
  enabled?: boolean
  channelMask?: number
}

export interface AudioProcessingSettings {
  dspEnabled: boolean
  /** Runtime direct path: preserve saved DSP settings while applying an identity graph. */
  directMode: boolean
  clipGuard: boolean
  fftEnabled: boolean
  fftResolution: number
  highResolution: boolean
  dsdToPcm: boolean
  dsdOutputMode: DsdOutputMode
  /** DSD 兼容层路由：与 dsdOutputMode 正交，决定 DSD 走哪条 backend/device。 */
  dsdRoute: DsdRouteSettings
  sacdProgramMode: SacdProgramMode
  eqEnabled: boolean
  eqMode: EqMode
  eqPreamp: number
  eqBands: EqualizerBand[]
  volumeNormalization: VolumeNormalizationMode
  replayGainPreamp: number
  replayGainFallback: number
  replayGainClip: boolean
  convolverEnabled: boolean
  convolverIrPath: string
  crossfeedEnabled: boolean
  crossfeedStrength: number
  crossfeedDelayMs: number
  crossfeedCutoffHz: number
  gapless: boolean
  crossfadeSeconds: number
}

export interface AudioOutputOption {
  id: AudioOutputId
  label: string
  description: string
  platform: NodeJS.Platform
  supportsExclusive: boolean
}

export interface AudioDeviceOption {
  id: string
  label: string
  isDefault: boolean
  backend?: string
  name?: string
  channels?: number
  sampleRates?: number[]
  driverName?: string
  driverVersion?: number
  bitDepths?: number[]
  latencyFrames?: number
  minBufferSize?: number
  maxBufferSize?: number
  granularity?: number
  preferredBufferSize?: number
  capabilityVersion?: number
  supportsExclusive?: boolean
  supportsHogMode?: boolean
  supportsDirectHw?: boolean
  supportsDop?: boolean
  supportsNativeDsd?: boolean
  dopSupportState?: AudioCapabilitySupportState
  nativeDsdSupportState?: AudioCapabilitySupportState
  supportedDsdRates?: number[]
  nativeDsdSampleRates?: number[]
  nativeDsdSampleFormats?: string[]
  dopCarrierSampleRates?: number[]
  dopCarrierFormats?: string[]
  pathKind?: string
  capabilityReason?: string
}

export type AudioCapabilitySupportState = 'verified' | 'runtime-probed' | 'unsupported' | 'unknown'

export interface OutputConfig {
  preferredBufferSize: number
  routingMode: ChannelRoutingMode
  wasapiExclusivePushMode?: boolean
  /** After float decode/DSP, modulate PCM to DSD64/128/256 via native DSD or DoP. */
  pcmToDsdMode?: PcmToDsdMode
  upmixCenterGain?: number
  upmixLfeGain?: number
  upmixLfeLowpassHz?: number
  upmixSurroundGain?: number
  upmixSideGain?: number
  upmixSurroundDelayMs?: number
}

export interface OutputConfigApplyStatus {
  requestedRevision: number
  appliedRevision: number
  failedRevision: number
  state: 'idle' | 'pending' | 'applied' | 'failed'
  error: string
  generation: number
}

export interface LatencyInfo {
  bufferLatencyMs: number
  outputLatencyMs: number
  totalLatencyMs: number
}

export interface OutputDiagnostics {
  sessionUnderrunCount: number
  sessionBufferDropCount: number
  sessionRecoveryCount: number
  lifetimeUnderrunCount: number
  lifetimeBufferDropCount: number
  lifetimeRecoveryCount: number
  driverRestartCount: number
  deviceLostCount: number
  /**
   * Transient driver load events (ASIO Overload / LatenciesChanged). Counted but
   * never acted on — they do not invalidate the stream. Optional so existing
   * fixtures and older engine builds stay assignable.
   */
  driverXrunCount?: number
  dsdIdleFrameCount?: number
  dsdShortReadCount?: number
  dsdTransport?: string
  dsdSourceBitOrder?: string
  dsdSourcePacking?: string
  requestedWireFormat?: string
  actualWireFormat?: string
  containerBits?: number
  validBits?: number
  blockAlign?: number
  semanticSampleRate?: number
  transportSampleRate?: number
  typedRawPath?: boolean
  processingBypassed?: boolean
  nativeDsdNegotiation?: string
  dopRuntimeEvidence?: string
  firstBufferSummary?: string
  processArchitecture?: string
  asioBuildEnabled?: boolean
  asioEnvironmentDisabled?: boolean
  asioRegisteredDriverCount32?: number
  asioRegisteredDriverCount64?: number
  asioLoadableDriverCount64?: number
  /** DSD 兼容层路由的运行时事实（实际走了哪条线），不是配置意图。 */
  dsdRouteOverrideActive?: boolean
  dsdRouteBackend?: string
  dsdRouteDevice?: string
  dsdRouteFallbackReason?: string
  lastError: string
}

export interface AudioOutputState {
  output: AudioOutputId
  device: string
  exclusiveMode: boolean
  exclusiveAvailable: boolean
  outputOptions: AudioOutputOption[]
  deviceOptions: AudioDeviceOption[]
}

export interface AudioEngineQueueItem {
  id: string
  source: string
  title?: string
  artist?: string
  album?: string
  duration?: number
  codec?: string
  sampleRate?: number
  bitrate?: number
  bitDepth?: number
  /** Offline EBU R128 measurement for loudnorm (host-injected). */
  measuredIntegratedLufs?: number
  measuredTruePeakDb?: number
  /** Library / host-injected ReplayGain + R128 tags for track/album cold start. */
  replayGainTrackGainDb?: number
  replayGainAlbumGainDb?: number
  replayGainTrackPeak?: number
  replayGainAlbumPeak?: number
  r128TrackGainDb?: number
  r128AlbumGainDb?: number
  cueRange?: CueRange
}

export interface AudioEnginePlayResult {
  nativeStarted: boolean
  fallbackReason: string
}

export interface VisualizationOptions {
  spectrumPoints?: number
  waveformPoints?: number
  spectrogramFrames?: number
  oscilloscopePoints?: number
  visualizerBarCount?: number
}

export interface VisualizationData {
  spectrum: number[]
  visualizerBars?: number[]
  waveform: number[]
  oscilloscope: number[]
  peakDb: number
  rmsDb: number
  lufsMomentary: number | null
  spectrogram: number[][]
  sampleRate: number
  maxFrequency: number
  active: boolean
  tapStatus: VisualizationTapStatus
  reason: string
}

export type VisualizationTapStatus =
  | 'active'
  | 'stopped'
  | 'disabled'
  | 'no-samples'
  | 'native-unavailable'
  | 'synthetic-fallback'

export interface NativeBpmAnalysisOptions {
  maxAnalysisSeconds?: number
  referenceBpm?: number
}

export interface NativeLoudnessAnalysisOptions {
  maxAnalysisSeconds?: number
}

export interface ConvolverInfo {
  loaded: boolean
  active: boolean
  bypassed: boolean
  irResampled: boolean
  path: string
  sampleRate: number
  channels: number
  lengthFrames: number
  lengthMs: number
  partitionSize: number
  latencyFrames: number
  overrunCount: number
  /** 实时线程因超预算而旁通卷积的累计次数 */
  bypassCount: number
  lastProcessMs: number
  maxProcessMs: number
  channelMappingMode: string
  warning: string
  lastError: string
}

export interface NativeAudioMetadata {
  source: string
  title: string
  artist: string
  album: string
  albumArtist: string
  composer: string
  year: string
  genre: string
  trackNumber: string
  discNumber: string
  comment: string
  codec: string
  container: string
  channelLayout: string
  sampleRate: number
  channelCount: number
  bitDepth: number
  bitrate: number
  duration: number
  playable?: boolean
  reasonCode?: string
  isDsd: boolean
  dsdMode: string
  dsdRate: number
  outputModes?: string[]
  coverMime: string
  coverDataBase64: string
  replayGainTrackGain: number | null
  replayGainAlbumGain: number | null
  r128TrackGain: number | null
  r128AlbumGain: number | null
  error: string
  isoTracks?: NativeAudioMetadata[]
}

export interface BpmTempoSegment {
  startMs: number
  endMs: number
  bpm: number
  confidence: number
}

export interface BpmAnalysisResult {
  bpm: number
  confidence: number
  source: 'analyzed'
  analyzedAt: string
  algorithmVersion: number
  variableTempo?: boolean
  bpmRange?: [number, number]
  tempoMap?: BpmTempoSegment[]
}

export interface LoudnessAnalysisResult {
  integratedLufs: number
  truePeakDb: number
  source: 'analyzed'
  analyzedAt: string
  algorithmVersion: number
  sampleRate?: number
  channels?: number
  analyzedFrames?: number
  available?: boolean
}

export interface HeadphoneCompensationSettings {
  enabled: boolean
  productId: string
  productName: string
  vendorName: string
  eqId: string
  author: string
  details: string
  link: string
  preampDb: number
  bands: EqualizerBand[]
}

export interface PlaybackOutputInfoMirror extends Pick<
  OutputInfo,
  | 'actualBackend'
  | 'actualOutputFormat'
  | 'actualSampleRate'
  | 'actualBitDepth'
  | 'actualChannels'
  | 'bufferSizeFrames'
  | 'latencyFrames'
  | 'latencyMs'
  | 'latencyInfo'
  | 'channelRoutingMode'
  | 'supportsOutputPerfect'
  | 'sourceExact'
  | 'diagnostics'
  | 'deviceRecovered'
  | 'recoveryCount'
  | 'outputSampleRate'
  | 'outputBitDepth'
  | 'outputPerfect'
  | 'pcmPassthrough'
  | 'perfectReason'
  | 'perfectReasonCode'
  | 'isDsd'
  | 'dsdMode'
  | 'dsdRate'
> {
  accessMode?: OutputInfo['accessMode']
  devicePathKind?: OutputInfo['devicePathKind']
  capabilityReason?: OutputInfo['capabilityReason']
}

export interface PlaybackInfo extends PlaybackOutputInfoMirror {
  state: 'stopped' | 'playing' | 'paused'
  position: number
  duration: number
  volume: number
  /** Application-layer playback rate; 1 = realtime. */
  playbackRate?: number
  requestedConfigRevision: number
  appliedConfigRevision: number
  queueIndex: number
  playMode: PlayMode
  source: string
  codec: string
  nativePlaybackActive: boolean
  bitrate: number
  sourceSampleRate: number
  sourceBitDepth: number
  decodedSampleRate: number
  decodedBitDepth: number
  decodedChannels: number
  decodedSampleFormat: string
  outputBackend: string
  outputDevice: string
  outputInfo: OutputInfo
  actualBackend: string
  driverName: string
  driverVersion: number
  actualOutputFormat: string
  actualSampleRate: number
  actualBitDepth: number
  actualChannels: number
  bufferSizeFrames: number
  latencyFrames: number
  latencyMs: number
  latencyInfo: LatencyInfo
  channelRoutingMode: string
  supportsOutputPerfect: boolean
  sourceExact: boolean
  diagnostics: OutputDiagnostics
  deviceRecovered: boolean
  recoveryCount: number
  outputSampleRate: number
  outputBitDepth: number
  channelCount: number
  outputPerfect: boolean
  pcmPassthrough: boolean
  dspActive: boolean
  replayGainActive: boolean
  eqActive: boolean
  convolverActive: boolean
  crossfeedActive: boolean
  crossfadeActive: boolean
  fftActive: boolean
  irResampled: boolean
  replayGainDb: number
  crossfeedStrength: number
  crossfadeSeconds: number
  convolverLatencyFrames: number
  partitionSize: number
  channelMappingMode: string
  perfectReason: string
  perfectReasonCode: string
  isDsd: boolean
  dsdMode: string
  dsdRate: number
  gaplessActive: boolean
  preloadReady: boolean
  /** Empty when unblocked; else disabled | dsd_path | typed_passthrough | crossfade | format_mismatch */
  gaplessBlockedReason: string
  upcomingTrack: AudioEngineQueueItem | null
  /** Live ICY StreamTitle (radio). Empty when unavailable. */
  streamTitle?: string
}

export interface OutputInfo {
  exclusive: boolean
  supportsOutputPerfect: boolean
  sourceExact: boolean
  outputPerfect: boolean
  pcmPassthrough: boolean
  resampled: boolean
  perfectReason: string
  outputSampleRate: number
  outputBitDepth: number
  backend: string
  actualBackend: string
  deviceName: string
  actualDeviceName: string
  driverName: string
  actualDriverName: string
  driverVersion: number
  actualDriverVersion: number
  actualOutputFormat: string
  actualSampleRate: number
  actualBitDepth: number
  actualChannels: number
  accessMode: string
  devicePathKind: string
  perfectReasonCode: string
  capabilityReason: string
  driverDopCapable: boolean
  driverNativeDsdCapable: boolean
  driverDopCarrierSampleRates: number[]
  driverDopCarrierFormats: string[]
  driverNativeDsdSampleRates: number[]
  nativeDsdRuntimeState: string
  nativeDsdRequestedRate: number
  nativeDsdActualRate: number
  nativeDsdChannels: number
  nativeDsdExplicitlyCapable: boolean
  nativeDsdAdvertisedSampleRates: number[]
  nativeDsdRuntimeReason: string
  bufferSizeFrames: number
  latencyFrames: number
  latencyMs: number
  latencyInfo: LatencyInfo
  channelRoutingMode: string
  diagnostics: OutputDiagnostics
  deviceRecovered: boolean
  recoveryCount: number
  nativeDsp?: { plugins: unknown[]; graph?: import('./dspGraph.ts').DspGraphStatus }
  isDsd: boolean
  dsdMode: string
  dsdRate: number
}

export interface AudioEngineConfig {
  exclusiveMode: boolean
  /** Initial software gain in [0, 1], restored before the engine reports ready. */
  volume?: number
  audioOutput?: AudioOutputId
  audioDevice?: string
  audioOutputConfig?: Partial<OutputConfig>
  audioProcessing?: Partial<AudioProcessingSettings>
  dspScenes?: import('./dspGraph.ts').DspScene[]
  dspPinnedSceneId?: string | null
}
