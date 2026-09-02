import { readFileSync } from 'fs'
import type {
  AudioCapabilitySupportState,
  AudioDeviceOption,
  AudioEngineQueueItem,
  AudioEngineScheduler,
  AudioOutputId,
  AudioOutputOption,
  AudioProcessingSettings,
  ChannelRoutingMode,
  EqualizerBand,
  EqualizerFilterType,
  EqMode,
  LatencyInfo,
  OutputConfig,
  OutputConversionInfo,
  OutputConversionInfoSource,
  OutputDiagnostics,
  OutputInfo,
  OutputProviderImplementation,
  PlaybackInfo,
  PlayMode,
  VisualizationData,
  VisualizationOptions,
  VisualizationTapStatus,
  VolumeNormalizationMode,
  DsdOutputMode,
  SacdProgramMode
} from './audioEngineTypes.ts'
import type { DspGraphStatus, Vst3ScanDescriptor } from '../../shared/dspGraph.ts'
import {
  DEFAULT_DSD_ROUTE,
  dsdRouteSettingsEqual,
  normalizeDsdRouteSettings
} from '../../shared/audioProcessingOptions.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { toNativePlayMode, type NativePlayMode } from '../../shared/playbackModes.ts'
import { deviceOptionIsAsio } from '../../shared/audioDeviceRouting.ts'

export const AUDIO_OUTPUT_OPTIONS: AudioOutputOption[] = [
  {
    id: 'wasapi',
    label: '系统音频输出',
    description: '系统原生输出。关闭独占时使用共享模式，开启独占时直接访问设备。',
    platform: 'win32',
    supportsExclusive: true
  },
  {
    id: 'asio',
    label: '专业声卡输出',
    description: 'Windows x64 专业声卡驱动输出；自动枚举已安装的 ASIO 驱动。',
    platform: 'win32',
    supportsExclusive: true
  },
  {
    id: 'coreaudio',
    label: '苹果系统音频',
    description: '苹果系统原生音频输出后端。开启独占模式时使用 Hog Mode 绕过系统混音器。',
    platform: 'darwin',
    supportsExclusive: true
  },
  {
    id: 'alsa',
    label: '系统音频输出',
    description: '系统原生音频输出后端。',
    platform: 'linux',
    supportsExclusive: false
  }
]

export const DEFAULT_EQ_BANDS: EqualizerBand[] = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000
].map((frequency) => ({
  frequency,
  gain: 0,
  q: 1,
  filterType: 'peak'
}))

export const MAX_PARAMETRIC_EQ_BANDS = 32
export const EQ_PREAMP_MIN_DB = -24
export const EQ_PREAMP_MAX_DB = 24
export const GRAPHIC_EQ_GAIN_MIN_DB = -12
export const GRAPHIC_EQ_GAIN_MAX_DB = 12
export const PARAMETRIC_EQ_GAIN_MIN_DB = -24
export const PARAMETRIC_EQ_GAIN_MAX_DB = 24
export const GRAPHIC_EQ_Q_MIN = 0.25
export const GRAPHIC_EQ_Q_MAX = 8
export const PARAMETRIC_EQ_Q_MIN = 0.1
export const PARAMETRIC_EQ_Q_MAX = 20

export const DEFAULT_AUDIO_PROCESSING: AudioProcessingSettings = {
  dspEnabled: false,
  directMode: false,
  clipGuard: true,
  fftEnabled: true,
  fftResolution: 8192,
  highResolution: true,
  dsdToPcm: false,
  dsdOutputMode: 'auto',
  dsdRatePolicy: 'pcm-fallback',
  dsdRoute: DEFAULT_DSD_ROUTE,
  sacdProgramMode: 'auto',
  eqEnabled: false,
  eqMode: 'graphic',
  eqPreamp: 0,
  eqBands: DEFAULT_EQ_BANDS,
  volumeNormalization: 'off',
  replayGainPreamp: 0,
  replayGainFallback: 0,
  replayGainClip: true,
  convolverEnabled: false,
  convolverIrPath: '',
  crossfeedEnabled: false,
  crossfeedStrength: 0,
  crossfeedDelayMs: 0.35,
  crossfeedCutoffHz: 700,
  gapless: true,
  crossfadeSeconds: 0
}

export const DEFAULT_OUTPUT_CONFIG: OutputConfig = {
  preferredBufferSize: 0,
  routingMode: 'auto',
  wasapiExclusivePushMode: false,
  pcmToDsdMode: 'off',
  dsdMutePreRollFrames: 256,
  dsdMutePostRollFrames: 256,
  dsdMuteTimeoutFrames: 4096,
  upmixCenterGain: 0.7071,
  upmixLfeGain: 0.5,
  upmixLfeLowpassHz: 120,
  upmixSurroundGain: 0.5,
  upmixSideGain: 0.3,
  upmixSurroundDelayMs: 0
}
export const PLAYBACK_INFO_CACHE_TTL_MS = 200
export const VISUALIZATION_CACHE_TTL_MS = 24
export const AUDIO_DEVICE_OPTIONS_CACHE_TTL_MS = 1000
export const AUDIO_DEVICE_OPTIONS_HOTPLUG_POLL_MS = 5000
/** Faster poll while following the OS default so default-speaker switches are noticed promptly. */
export const AUDIO_DEVICE_OPTIONS_DEFAULT_FOLLOW_POLL_MS = 1000
export const NATIVE_DSP_PLUGIN_STATUS_CACHE_TTL_MS = 200
export const CONVOLVER_INFO_CACHE_TTL_MS = 200
export const UPCOMING_TRACK_CACHE_TTL_MS = 200
export const METADATA_CACHE_TTL_MS = 1000
export const MAX_METADATA_CACHE_ENTRIES = 256
export const PLAYBACK_FANOUT_FIELD_SEPARATOR = '\x1f'
export const PLAYBACK_FANOUT_RECORD_SEPARATOR = '\x1e'

export const DEFAULT_AUDIO_ENGINE_SCHEDULER: AudioEngineScheduler = {
  now: () => Date.now(),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
  setImmediate: (callback) => setImmediate(callback)
}

export function isAudioOutputId(output: unknown): output is AudioOutputId {
  return output === 'wasapi' || output === 'asio' || output === 'coreaudio' || output === 'alsa'
}

export function getAudioOutputOptions(
  platform: NodeJS.Platform = process.platform
): AudioOutputOption[] {
  return AUDIO_OUTPUT_OPTIONS.filter((option) => option.platform === platform)
}

export function getDefaultAudioOutput(platform: NodeJS.Platform = process.platform): AudioOutputId {
  return getAudioOutputOptions(platform)[0]?.id ?? 'alsa'
}

export function normalizeAudioOutput(
  output: unknown,
  platform: NodeJS.Platform = process.platform
): AudioOutputId {
  const options = getAudioOutputOptions(platform)
  if (isAudioOutputId(output) && options.some((option) => option.id === output)) return output
  return getDefaultAudioOutput(platform)
}

export function fanoutValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return text
    .replaceAll(PLAYBACK_FANOUT_FIELD_SEPARATOR, ' ')
    .replaceAll(PLAYBACK_FANOUT_RECORD_SEPARATOR, ' ')
}

export function normalizeOutputProviderImplementation(
  value: unknown
): OutputProviderImplementation {
  return value === 'miniaudio' ? 'miniaudio' : 'legacy-native'
}

export function normalizeOutputConversionInfo(
  value: unknown,
  resampled: boolean
): OutputConversionInfo {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const source =
    record.source === 'backend-runtime' ||
    record.source === 'engine-inferred' ||
    record.source === 'unavailable'
      ? (record.source as OutputConversionInfoSource)
      : 'unavailable'
  const factsAvailable = source !== 'unavailable'
  return {
    sampleFormatConverted: factsAvailable && record.sampleFormatConverted === true,
    sampleRateConverted: resampled,
    channelLayoutConverted: factsAvailable && record.channelLayoutConverted === true,
    source
  }
}

export function fanoutArray(values: unknown[] | undefined): string {
  if (!Array.isArray(values) || values.length === 0) return ''
  return values.map(fanoutValue).join(',')
}

export function nativeDspPluginFanoutSignature(
  nativeDsp: OutputInfo['nativeDsp'] | undefined
): string {
  const plugins = nativeDsp?.plugins
  if (!Array.isArray(plugins) || plugins.length === 0) return '0'
  return plugins
    .map((plugin, index) => {
      if (!plugin || typeof plugin !== 'object') return `${index}:${fanoutValue(plugin)}`
      const record = plugin as Record<string, unknown>
      return [
        index,
        record.id,
        record.name,
        record.path,
        record.version,
        record.loaded,
        record.enabled,
        record.active,
        record.bypassed,
        record.bypassReason,
        record.lastError,
        record.lastProcessTimeUs,
        record.maxProcessTimeUs,
        record.timeoutCount,
        record.overBudgetCount,
        record.processOverBudgetCount,
        record.prepareStatus,
        record.state,
        record.status
      ]
        .map(fanoutValue)
        .join(':')
    })
    .join(PLAYBACK_FANOUT_RECORD_SEPARATOR)
}

export function createPlaybackInfoFanoutSignature(
  info: PlaybackInfo,
  nativePlaybackActive: boolean
): string {
  const outputInfo = info.outputInfo
  const latencyInfo = outputInfo.latencyInfo ?? info.latencyInfo
  const diagnostics = outputInfo.diagnostics ?? info.diagnostics
  const upcomingTrack = info.upcomingTrack
  return [
    info.state,
    info.duration,
    info.volume,
    info.playbackRate ?? 1,
    info.requestedConfigRevision,
    info.appliedConfigRevision,
    info.queueIndex,
    info.playMode,
    info.source,
    info.codec,
    info.streamTitle ?? '',
    nativePlaybackActive,
    info.bitrate,
    info.sourceSampleRate,
    info.sourceBitDepth,
    info.decodedSampleRate,
    info.decodedBitDepth,
    info.decodedChannels,
    info.decodedSampleFormat,
    info.outputBackend,
    info.outputDevice,
    info.actualBackend,
    info.driverName,
    info.driverVersion,
    info.actualOutputFormat,
    info.actualSampleRate,
    info.actualBitDepth,
    info.actualChannels,
    info.bufferSizeFrames,
    info.latencyFrames,
    info.latencyMs,
    latencyInfo.bufferLatencyMs,
    latencyInfo.outputLatencyMs,
    latencyInfo.totalLatencyMs,
    info.channelRoutingMode,
    info.supportsOutputPerfect,
    info.sourceExact,
    info.deviceRecovered,
    info.recoveryCount,
    info.outputSampleRate,
    info.outputBitDepth,
    info.channelCount,
    info.outputPerfect,
    info.pcmPassthrough,
    info.dspActive,
    info.replayGainActive,
    info.eqActive,
    info.convolverActive,
    info.crossfeedActive,
    info.crossfadeActive,
    info.fftActive,
    info.irResampled,
    info.replayGainDb,
    info.crossfeedStrength,
    info.crossfadeSeconds,
    info.convolverLatencyFrames,
    info.partitionSize,
    info.channelMappingMode,
    info.perfectReason,
    info.perfectReasonCode,
    info.isDsd,
    info.dsdMode,
    info.dsdRate,
    info.gaplessActive,
    info.preloadReady,
    info.gaplessBlockedReason,
    upcomingTrack?.id,
    upcomingTrack?.source,
    upcomingTrack?.title,
    upcomingTrack?.artist,
    upcomingTrack?.album,
    upcomingTrack?.duration,
    upcomingTrack?.codec,
    upcomingTrack?.sampleRate,
    upcomingTrack?.bitrate,
    upcomingTrack?.bitDepth,
    outputInfo.exclusive,
    outputInfo.supportsOutputPerfect,
    outputInfo.sourceExact,
    outputInfo.outputPerfect,
    outputInfo.pcmPassthrough,
    outputInfo.resampled,
    outputInfo.providerImplementation,
    outputInfo.conversionInfo?.sampleFormatConverted,
    outputInfo.conversionInfo?.sampleRateConverted,
    outputInfo.conversionInfo?.channelLayoutConverted,
    outputInfo.conversionInfo?.source,
    outputInfo.perfectReason,
    outputInfo.outputSampleRate,
    outputInfo.outputBitDepth,
    outputInfo.backend,
    outputInfo.actualBackend,
    outputInfo.deviceName,
    outputInfo.actualDeviceName,
    outputInfo.driverName,
    outputInfo.actualDriverName,
    outputInfo.driverVersion,
    outputInfo.actualDriverVersion,
    outputInfo.actualOutputFormat,
    outputInfo.actualSampleRate,
    outputInfo.actualBitDepth,
    outputInfo.actualChannels,
    outputInfo.accessMode,
    outputInfo.devicePathKind,
    outputInfo.perfectReasonCode,
    outputInfo.capabilityReason,
    outputInfo.driverDopCapable,
    outputInfo.driverNativeDsdCapable,
    fanoutArray(outputInfo.driverDopCarrierSampleRates),
    fanoutArray(outputInfo.driverDopCarrierFormats),
    fanoutArray(outputInfo.driverNativeDsdSampleRates),
    outputInfo.nativeDsdRuntimeState,
    outputInfo.nativeDsdRequestedRate,
    outputInfo.nativeDsdActualRate,
    outputInfo.nativeDsdChannels,
    outputInfo.nativeDsdExplicitlyCapable,
    fanoutArray(outputInfo.nativeDsdAdvertisedSampleRates),
    outputInfo.nativeDsdRuntimeReason,
    outputInfo.bufferSizeFrames,
    outputInfo.latencyFrames,
    outputInfo.latencyMs,
    outputInfo.channelRoutingMode,
    diagnostics.sessionUnderrunCount,
    diagnostics.sessionBufferDropCount,
    diagnostics.sessionRecoveryCount,
    diagnostics.lifetimeUnderrunCount,
    diagnostics.lifetimeBufferDropCount,
    diagnostics.lifetimeRecoveryCount,
    diagnostics.driverRestartCount,
    diagnostics.deviceLostCount,
    diagnostics.driverXrunCount ?? 0,
    diagnostics.lastError,
    outputInfo.deviceRecovered,
    outputInfo.recoveryCount,
    nativeDspPluginFanoutSignature(outputInfo.nativeDsp),
    outputInfo.isDsd,
    outputInfo.dsdMode,
    outputInfo.dsdRate
  ]
    .map(fanoutValue)
    .join(PLAYBACK_FANOUT_FIELD_SEPARATOR)
}

export function supportsAudioExclusive(output: AudioOutputId): boolean {
  return getAudioOutputOptions().some((option) => option.id === output && option.supportsExclusive)
}

export function isDefaultAudioDeviceAlias(device: string): boolean {
  const normalized = device.trim()
  const lower = normalized.toLowerCase()
  return (
    lower === 'auto' ||
    lower === 'default' ||
    lower === 'system default' ||
    lower === 'system-default' ||
    normalized === '系统默认'
  )
}

export function normalizeAudioDevice(device: unknown): string {
  if (typeof device !== 'string') return 'auto'
  const normalized = device.trim()
  if (!normalized || isDefaultAudioDeviceAlias(normalized)) return 'auto'
  return normalized
}

export function getAlsaPlaybackDeviceCandidates(): string[] {
  if (process.platform !== 'linux') return []
  try {
    const entries = readFileSync('/proc/asound/pcm', 'utf8')
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^(\d+)-(\d+):\s*(.*):\s*playback\b/)
        if (!match) return null
        const description = match[3].toLowerCase()
        const score = description.includes('usb') ? 0 : description.includes('hdmi') ? 2 : 1
        return {
          card: Number(match[1]),
          device: Number(match[2]),
          score
        }
      })
      .filter((entry): entry is { card: number; device: number; score: number } => Boolean(entry))
      .sort(
        (left, right) =>
          left.score - right.score || left.card - right.card || left.device - right.device
      )

    const candidates: string[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      for (const prefix of ['plughw', 'hw']) {
        const id = `${prefix}:${entry.card},${entry.device}`
        if (!seen.has(id)) {
          seen.add(id)
          candidates.push(id)
        }
      }
    }
    return candidates
  } catch {
    return []
  }
}

export function looksLikeWasapiEndpointId(device: string): boolean {
  return /^\{0\.0\.0\./i.test(device.trim())
}

export function deviceOptionBelongsToAsio(option: AudioDeviceOption | undefined): boolean {
  return deviceOptionIsAsio(option)
}

export function deviceCompatibleWithOutput(
  output: AudioOutputId,
  device: string,
  options: AudioDeviceOption[]
): boolean {
  if (device === 'auto') return true
  const option = options.find((entry) => entry.id === device)
  if (output === 'asio') {
    if (looksLikeWasapiEndpointId(device)) return false
    return option ? deviceOptionBelongsToAsio(option) : true
  }
  return !deviceOptionBelongsToAsio(option) && !device.toLowerCase().startsWith('asio:')
}

export function normalizeChannelRoutingMode(value: unknown): ChannelRoutingMode {
  return value === 'stereo' ||
    value === 'stereo-to-5.1' ||
    value === 'stereo-to-7.1' ||
    value === 'mono-to-stereo' ||
    value === 'mono-to-multichannel'
    ? value
    : 'auto'
}

export function normalizePcmToDsdMode(value: unknown): NonNullable<OutputConfig['pcmToDsdMode']> {
  return value === 'dsd64' || value === 'dsd128' || value === 'dsd256' ? value : 'off'
}

export function normalizeOutputConfig(config?: Partial<OutputConfig>): OutputConfig {
  return {
    preferredBufferSize: Number.isFinite(config?.preferredBufferSize)
      ? clampNumber(Math.trunc(config?.preferredBufferSize ?? 0), 0, 2048, 0)
      : DEFAULT_OUTPUT_CONFIG.preferredBufferSize,
    routingMode: normalizeChannelRoutingMode(config?.routingMode),
    wasapiExclusivePushMode: config?.wasapiExclusivePushMode === true,
    pcmToDsdMode: normalizePcmToDsdMode(config?.pcmToDsdMode),
    dsdMutePreRollFrames: clampNumber(config?.dsdMutePreRollFrames, 0, 4096, 256),
    dsdMutePostRollFrames: clampNumber(config?.dsdMutePostRollFrames, 0, 4096, 256),
    dsdMuteTimeoutFrames: clampNumber(config?.dsdMuteTimeoutFrames, 1, 4096, 4096),
    upmixCenterGain: clampNumber(config?.upmixCenterGain, 0, 2, 0.7071),
    upmixLfeGain: clampNumber(config?.upmixLfeGain, 0, 2, 0.5),
    upmixLfeLowpassHz: clampNumber(config?.upmixLfeLowpassHz, 20, 500, 120),
    upmixSurroundGain: clampNumber(config?.upmixSurroundGain, 0, 2, 0.5),
    upmixSideGain: clampNumber(config?.upmixSideGain, 0, 2, 0.3),
    upmixSurroundDelayMs: clampNumber(config?.upmixSurroundDelayMs, 0, 100, 0)
  }
}

export function outputConfigsEqual(left: OutputConfig, right: OutputConfig): boolean {
  return (
    left.preferredBufferSize === right.preferredBufferSize &&
    left.routingMode === right.routingMode &&
    left.wasapiExclusivePushMode === right.wasapiExclusivePushMode &&
    (left.pcmToDsdMode ?? 'off') === (right.pcmToDsdMode ?? 'off') &&
    left.dsdMutePreRollFrames === right.dsdMutePreRollFrames &&
    left.dsdMutePostRollFrames === right.dsdMutePostRollFrames &&
    left.dsdMuteTimeoutFrames === right.dsdMuteTimeoutFrames &&
    left.upmixCenterGain === right.upmixCenterGain &&
    left.upmixLfeGain === right.upmixLfeGain &&
    left.upmixLfeLowpassHz === right.upmixLfeLowpassHz &&
    left.upmixSurroundGain === right.upmixSurroundGain &&
    left.upmixSideGain === right.upmixSideGain &&
    left.upmixSurroundDelayMs === right.upmixSurroundDelayMs
  )
}

export function eqBandsEqual(left: EqualizerBand[], right: EqualizerBand[]): boolean {
  if (left.length !== right.length) return false
  return left.every((band, index) => {
    const other = right[index]
    return (
      band.frequency === other.frequency &&
      band.gain === other.gain &&
      band.q === other.q &&
      band.filterType === other.filterType &&
      // Per-band bypass and channel routing change the rendered response, so a
      // toggle must not compare equal or setAudioProcessing early-returns and
      // the band keeps processing audio.
      (band.enabled !== false) === (other.enabled !== false) &&
      (band.channelMask ?? 0xffffffff) === (other.channelMask ?? 0xffffffff)
    )
  })
}

export function audioProcessingSettingsEqual(
  left: AudioProcessingSettings,
  right: AudioProcessingSettings
): boolean {
  return (
    left.dspEnabled === right.dspEnabled &&
    left.directMode === right.directMode &&
    left.clipGuard === right.clipGuard &&
    left.fftEnabled === right.fftEnabled &&
    left.fftResolution === right.fftResolution &&
    left.highResolution === right.highResolution &&
    left.dsdToPcm === right.dsdToPcm &&
    left.dsdOutputMode === right.dsdOutputMode &&
    dsdRouteSettingsEqual(left.dsdRoute, right.dsdRoute) &&
    left.sacdProgramMode === right.sacdProgramMode &&
    left.eqEnabled === right.eqEnabled &&
    left.eqMode === right.eqMode &&
    left.eqPreamp === right.eqPreamp &&
    eqBandsEqual(left.eqBands, right.eqBands) &&
    left.volumeNormalization === right.volumeNormalization &&
    left.replayGainPreamp === right.replayGainPreamp &&
    left.replayGainFallback === right.replayGainFallback &&
    left.replayGainClip === right.replayGainClip &&
    left.convolverEnabled === right.convolverEnabled &&
    left.convolverIrPath === right.convolverIrPath &&
    left.crossfeedEnabled === right.crossfeedEnabled &&
    left.crossfeedStrength === right.crossfeedStrength &&
    left.crossfeedDelayMs === right.crossfeedDelayMs &&
    left.crossfeedCutoffHz === right.crossfeedCutoffHz &&
    left.gapless === right.gapless &&
    left.crossfadeSeconds === right.crossfadeSeconds
  )
}

export function normalizeVisualizationOptions(
  options?: VisualizationOptions
): Required<VisualizationOptions> {
  return {
    spectrumPoints: Math.trunc(clampNumber(options?.spectrumPoints, 8, 4096, 64)),
    waveformPoints: Math.trunc(clampNumber(options?.waveformPoints, 16, 512, 128)),
    spectrogramFrames: Math.trunc(clampNumber(options?.spectrogramFrames, 0, 96, 48)),
    oscilloscopePoints: Math.trunc(clampNumber(options?.oscilloscopePoints, 0, 4096, 1024)),
    visualizerBarCount: Math.trunc(clampNumber(options?.visualizerBarCount, 0, 256, 0))
  }
}

export function visualizationMaxFrequency(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 20000
  return Math.max(20, Math.min(20000, Math.trunc(sampleRate) / 2))
}

export const DEFAULT_AUDIO_DEVICE_OPTION: AudioDeviceOption = {
  id: 'auto',
  label: '系统默认',
  isDefault: true,
  supportsExclusive: false,
  supportsHogMode: false,
  supportsDirectHw: false,
  supportsDop: false,
  supportsNativeDsd: false,
  dopSupportState: 'runtime-probed',
  nativeDsdSupportState: 'unsupported',
  supportedDsdRates: [],
  nativeDsdSampleRates: [],
  nativeDsdSampleFormats: [],
  dopCarrierSampleRates: [],
  dopCarrierFormats: [],
  pathKind: 'default',
  capabilityReason: ''
}

export function formatAudioDeviceLabel(device: string): string {
  return device === DEFAULT_AUDIO_DEVICE_OPTION.id ? DEFAULT_AUDIO_DEVICE_OPTION.label : device
}

export function normalizeAudioCapabilitySupportState(
  value: unknown
): AudioCapabilitySupportState | null {
  return value === 'verified' ||
    value === 'runtime-probed' ||
    value === 'unsupported' ||
    value === 'unknown'
    ? value
    : null
}

export function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

export function getDeviceBackend(option: Partial<AudioDeviceOption>): string {
  const raw = option.backend || (option.id?.startsWith('asio:') ? 'asio' : '')
  return String(raw || '').toLowerCase()
}

export function getDevicePathKind(option: Partial<AudioDeviceOption>): string {
  return String(option.pathKind || '').toLowerCase()
}

export function deriveDopSupportState(
  option: Partial<AudioDeviceOption>
): AudioCapabilitySupportState {
  const explicit = normalizeAudioCapabilitySupportState(option.dopSupportState)
  if (explicit) return explicit
  if (
    option.supportsDop === true ||
    hasNonEmptyArray(option.dopCarrierSampleRates) ||
    hasNonEmptyArray(option.dopCarrierFormats)
  ) {
    return 'verified'
  }
  if (option.supportsDop === false) return 'unsupported'

  const backend = getDeviceBackend(option)
  const pathKind = getDevicePathKind(option)
  if (
    option.isDefault === true ||
    backend === 'wasapi' ||
    backend === 'coreaudio' ||
    pathKind === 'default' ||
    pathKind === 'endpoint' ||
    pathKind === 'hal'
  ) {
    return 'runtime-probed'
  }
  if (backend === 'asio' || pathKind === 'asio') return 'unknown'
  return 'unknown'
}

export function deriveNativeDsdSupportState(
  option: Partial<AudioDeviceOption>
): AudioCapabilitySupportState {
  const explicit = normalizeAudioCapabilitySupportState(option.nativeDsdSupportState)
  if (explicit) return explicit
  if (
    option.supportsNativeDsd === true ||
    hasNonEmptyArray(option.nativeDsdSampleRates) ||
    hasNonEmptyArray(option.nativeDsdSampleFormats) ||
    hasNonEmptyArray(option.supportedDsdRates)
  ) {
    return 'verified'
  }
  if (option.supportsNativeDsd === false) return 'unsupported'

  const backend = getDeviceBackend(option)
  const pathKind = getDevicePathKind(option)
  if (
    backend === 'wasapi' ||
    backend === 'coreaudio' ||
    pathKind === 'endpoint' ||
    pathKind === 'hal'
  ) {
    return 'unsupported'
  }
  if (backend === 'alsa' && pathKind === 'hw') return 'runtime-probed'
  if (backend === 'asio' || pathKind === 'asio') return 'unknown'
  if (option.isDefault === true || pathKind === 'default') return 'unsupported'
  return 'unknown'
}

export function withAudioCapabilitySupportStates(option: AudioDeviceOption): AudioDeviceOption {
  return {
    ...option,
    dopSupportState: deriveDopSupportState(option),
    nativeDsdSupportState: deriveNativeDsdSupportState(option)
  }
}

export function normalizeAudioDeviceOption(option: unknown): AudioDeviceOption | null {
  if (typeof option === 'string') {
    const id = option.trim()
    if (!id) return null
    return withAudioCapabilitySupportStates({
      id,
      label: formatAudioDeviceLabel(id),
      isDefault: id === DEFAULT_AUDIO_DEVICE_OPTION.id
    })
  }

  if (!option || typeof option !== 'object') return null
  const record = option as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) return null
  const rawLabel = typeof record.label === 'string' ? record.label.trim() : ''
  const rawName = typeof record.name === 'string' ? record.name.trim() : ''
  return withAudioCapabilitySupportStates({
    ...(record as Partial<AudioDeviceOption>),
    id,
    label:
      id === DEFAULT_AUDIO_DEVICE_OPTION.id
        ? DEFAULT_AUDIO_DEVICE_OPTION.label
        : rawLabel || rawName || id,
    isDefault: record.isDefault === true
  })
}

export function normalizeAudioDeviceOptions(rawOptions: unknown): AudioDeviceOption[] {
  const options: AudioDeviceOption[] = []
  const seen = new Set<string>()

  function addOption(option: AudioDeviceOption | null): void {
    if (!option || seen.has(option.id)) return
    seen.add(option.id)
    options.push(option)
  }

  if (Array.isArray(rawOptions)) {
    for (const option of rawOptions) {
      addOption(normalizeAudioDeviceOption(option))
    }
  }

  if (!seen.has(DEFAULT_AUDIO_DEVICE_OPTION.id)) {
    options.unshift({ ...DEFAULT_AUDIO_DEVICE_OPTION })
    seen.add(DEFAULT_AUDIO_DEVICE_OPTION.id)
  }

  return options
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export const MAX_SOFT_PLAYBACK_CLOCK_GAP_SECONDS = 1.5

export function nativePlayMode(mode: PlayMode): NativePlayMode {
  return toNativePlayMode(mode)
}

export function resolveQueueIndexForSource(
  queue: readonly AudioEngineQueueItem[],
  info: PlaybackInfo
): PlaybackInfo {
  if (!info.source) return info
  if (queue[info.queueIndex]?.source === info.source) return info
  const sourceQueueIndex = queue.findIndex((item) => item.source === info.source)
  if (sourceQueueIndex < 0 || sourceQueueIndex === info.queueIndex) return info
  return {
    ...info,
    queueIndex: sourceQueueIndex
  }
}

export function advanceSoftPlaybackPosition(
  position: number,
  elapsedSeconds: number,
  rate: number,
  duration: number
): number {
  const softElapsed =
    elapsedSeconds > MAX_SOFT_PLAYBACK_CLOCK_GAP_SECONDS ? 0 : Math.max(0, elapsedSeconds)
  const advanced = position + softElapsed * rate
  return duration > 0 ? Math.min(advanced, duration) : advanced
}

export function clampQueueItemPosition(
  item: AudioEngineQueueItem | undefined,
  value: number
): number {
  const position = Math.max(0, Number.isFinite(value) ? value : 0)
  const range = item?.cueRange
  if (!range) return position
  const duration =
    (Number.isFinite(range.virtualPregapSeconds)
      ? Math.max(0, range.virtualPregapSeconds ?? 0)
      : 0) +
    range.endSeconds -
    range.startSeconds
  if (!Number.isFinite(duration) || duration <= 0) return position
  return Math.min(position, duration)
}

export function normalizeEqualizerFilterType(value: unknown): EqualizerFilterType {
  if (
    value === 'lowShelf' ||
    value === 'highShelf' ||
    value === 'bandPass' ||
    value === 'lowPass' ||
    value === 'highPass' ||
    value === 'allPass' ||
    value === 'notch'
  ) {
    return value
  }
  return 'peak'
}

export function normalizeAudioProcessingSettings(
  settings?: Partial<AudioProcessingSettings>
): AudioProcessingSettings {
  const eqMode: EqMode = settings?.eqMode === 'parametric' ? 'parametric' : 'graphic'
  const rawBands = Array.isArray(settings?.eqBands) ? settings.eqBands : DEFAULT_EQ_BANDS
  const eqBands =
    eqMode === 'parametric'
      ? rawBands.slice(0, MAX_PARAMETRIC_EQ_BANDS).map((band, index) => {
          const defaultBand = DEFAULT_EQ_BANDS[index % DEFAULT_EQ_BANDS.length]
          return {
            frequency: clampNumber(band.frequency, 20, 24000, defaultBand.frequency),
            gain: clampNumber(band.gain, PARAMETRIC_EQ_GAIN_MIN_DB, PARAMETRIC_EQ_GAIN_MAX_DB, 0),
            q: clampNumber(band.q, PARAMETRIC_EQ_Q_MIN, PARAMETRIC_EQ_Q_MAX, 1),
            filterType: normalizeEqualizerFilterType(band.filterType),
            enabled: band.enabled !== false,
            channelMask: Math.max(
              0,
              Math.min(0xffffffff, Math.trunc(band.channelMask ?? 0xffffffff))
            )
          }
        })
      : DEFAULT_EQ_BANDS.map((defaultBand, index) => {
          const band = rawBands[index] ?? defaultBand
          return {
            frequency: clampNumber(band.frequency, 20, 24000, defaultBand.frequency),
            gain: clampNumber(band.gain, GRAPHIC_EQ_GAIN_MIN_DB, GRAPHIC_EQ_GAIN_MAX_DB, 0),
            q: clampNumber(band.q, GRAPHIC_EQ_Q_MIN, GRAPHIC_EQ_Q_MAX, 1),
            filterType: normalizeEqualizerFilterType(band.filterType),
            enabled: band.enabled !== false,
            channelMask: Math.max(
              0,
              Math.min(0xffffffff, Math.trunc(band.channelMask ?? 0xffffffff))
            )
          }
        })

  if (eqBands.length === 0) {
    eqBands.push({
      frequency: DEFAULT_EQ_BANDS[0].frequency,
      gain: 0,
      q: 1,
      filterType: 'peak',
      enabled: true,
      channelMask: 0xffffffff
    })
  }

  const volumeNormalization: VolumeNormalizationMode =
    settings?.volumeNormalization === 'track' ||
    settings?.volumeNormalization === 'album' ||
    settings?.volumeNormalization === 'loudnorm'
      ? settings.volumeNormalization
      : 'off'
  const dsdOutputMode: DsdOutputMode =
    settings?.dsdOutputMode === 'auto' ||
    settings?.dsdOutputMode === 'pcm' ||
    settings?.dsdOutputMode === 'dop' ||
    settings?.dsdOutputMode === 'native'
      ? settings.dsdOutputMode
      : settings?.dsdToPcm === true
        ? 'pcm'
        : 'auto'
  const dsdRatePolicy =
    settings?.dsdRatePolicy === 'exact' || settings?.dsdRatePolicy === 'downrate'
      ? settings.dsdRatePolicy
      : 'pcm-fallback'
  const sacdProgramMode: SacdProgramMode =
    settings?.sacdProgramMode === 'stereo' || settings?.sacdProgramMode === 'multichannel'
      ? settings.sacdProgramMode
      : 'auto'

  return {
    dspEnabled: settings?.dspEnabled === true,
    directMode: settings?.directMode === true,
    clipGuard: settings?.clipGuard !== false,
    fftEnabled: settings?.fftEnabled !== false,
    fftResolution: clampNumber(settings?.fftResolution, 64, 8192, 8192),
    highResolution: settings?.highResolution !== false,
    dsdToPcm: dsdOutputMode === 'pcm',
    dsdOutputMode,
    dsdRatePolicy,
    dsdRoute: normalizeDsdRouteSettings(settings?.dsdRoute),
    sacdProgramMode,
    eqEnabled: settings?.eqEnabled === true,
    eqMode,
    eqPreamp: clampNumber(settings?.eqPreamp, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB, 0),
    eqBands,
    volumeNormalization,
    replayGainPreamp: clampNumber(settings?.replayGainPreamp, -12, 12, 0),
    replayGainFallback: clampNumber(settings?.replayGainFallback, -12, 12, 0),
    replayGainClip: settings?.replayGainClip !== false,
    convolverEnabled: settings?.convolverEnabled === true,
    convolverIrPath: typeof settings?.convolverIrPath === 'string' ? settings.convolverIrPath : '',
    crossfeedEnabled: settings?.crossfeedEnabled === true,
    crossfeedStrength: clampNumber(settings?.crossfeedStrength, 0, 1, 0),
    crossfeedDelayMs: clampNumber(settings?.crossfeedDelayMs, 0.05, 2, 0.35),
    crossfeedCutoffHz: clampNumber(settings?.crossfeedCutoffHz, 80, 4000, 700),
    gapless: settings?.gapless !== false,
    crossfadeSeconds: clampNumber(settings?.crossfadeSeconds, 0, 12, 0)
  }
}

export interface ProcessingMasterState {
  dspEnabled: boolean
  directMode: boolean
}

export function resolveProcessingMasterState(
  processing: Pick<
    AudioProcessingSettings,
    | 'dspEnabled'
    | 'directMode'
    | 'eqEnabled'
    | 'eqPreamp'
    | 'volumeNormalization'
    | 'convolverEnabled'
    | 'convolverIrPath'
    | 'crossfeedEnabled'
    | 'crossfeedStrength'
  >,
  explicitDspEnabled?: boolean,
  explicitDirectMode?: boolean
): ProcessingMasterState {
  const moduleActive =
    processing.eqEnabled ||
    processing.volumeNormalization !== 'off' ||
    processing.convolverEnabled ||
    processing.convolverIrPath.length > 0 ||
    (processing.crossfeedEnabled && processing.crossfeedStrength > 0) ||
    Math.abs(processing.eqPreamp) > 0.001

  // An explicit master-switch off always wins: bit-perfect direct path.
  if (explicitDspEnabled === false) {
    return { dspEnabled: false, directMode: true }
  }
  // Enabling DSP or any processing module implies the graph must run.
  if (explicitDspEnabled === true || moduleActive) {
    return { dspEnabled: true, directMode: false }
  }
  if (explicitDirectMode === true) {
    return { dspEnabled: false, directMode: true }
  }
  if (explicitDirectMode === false) {
    return { dspEnabled: processing.dspEnabled, directMode: false }
  }
  return { dspEnabled: processing.dspEnabled, directMode: processing.directMode }
}

export function parseNativeJson<T>(value: string | T | undefined, fallback: T): T {
  if (typeof value !== 'string') return value ?? fallback
  const parsed = tryParseJsonWithNestingLimit(value)
  return parsed.ok ? (parsed.value as T) : fallback
}

export function parseDspGraphStatusOrThrow(value: string | DspGraphStatus): DspGraphStatus {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    const parsedJson = tryParseJsonWithNestingLimit(parsed)
    if (!parsedJson.ok) {
      throw new Error('native audio engine returned invalid DSP graph status JSON')
    }
    parsed = parsedJson.value
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('native audio engine returned an invalid DSP graph status')
  }
  const status = parsed as Partial<DspGraphStatus>
  if (!Number.isSafeInteger(status.revision) || (status.revision as number) < 0) {
    throw new Error('native audio engine returned an invalid DSP graph revision')
  }
  if (!Array.isArray(status.nodes)) {
    throw new Error('native audio engine returned DSP graph status without nodes')
  }
  return status as DspGraphStatus
}

export function isVst3ScanDescriptor(value: unknown): value is Vst3ScanDescriptor {
  if (!value || typeof value !== 'object') return false
  const descriptor = value as Partial<Vst3ScanDescriptor>
  return (
    typeof descriptor.classId === 'string' &&
    typeof descriptor.name === 'string' &&
    typeof descriptor.vendor === 'string' &&
    typeof descriptor.version === 'string'
  )
}

export function normalizeNumberArray(value: unknown, length: number): number[] {
  const source = Array.isArray(value) ? value : []
  return Array.from({ length }, (_, index) => {
    const item = source[index]
    return typeof item === 'number' && Number.isFinite(item) ? item : 0
  })
}

export function normalizeSpectrogram(value: unknown, frames: number, points: number): number[][] {
  if (frames <= 0 || points <= 0) return []
  const source = Array.isArray(value) ? value.slice(-frames) : []
  return source.map((row) => normalizeNumberArray(row, points))
}

export function mapSpectrumToVisualizerBars(
  spectrum: readonly number[],
  sampleRate: number,
  barCount: number
): number[] {
  if (barCount <= 0) return []
  const bars = Array.from({ length: barCount }, () => 0)
  if (spectrum.length === 0) return bars

  const minFrequency = 20
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100
  const maxFrequency = Math.max(minFrequency, Math.min(20000, rate / 2))
  const fftSize = Math.max(2, spectrum.length * 2)
  const binWidth = rate / fftSize
  const maxBinIndex = Math.max(0, spectrum.length - 1)
  const frequencyRatio = maxFrequency / minFrequency
  const frequencyStepCount = Math.max(1, barCount - 1)

  for (let i = 0; i < barCount; i += 1) {
    const frequency = minFrequency * Math.pow(frequencyRatio, i / frequencyStepCount)
    const binIndexDecimal = frequency / binWidth
    const indexLow = Math.min(Math.floor(binIndexDecimal), maxBinIndex)
    const indexHigh = Math.min(indexLow + 1, maxBinIndex)
    const fract = binIndexDecimal - indexLow
    const valLow = spectrum[indexLow] || 0
    const valHigh = spectrum[indexHigh] || 0
    const value = valLow + (valHigh - valLow) * fract
    bars[i] = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  }

  return bars
}

export function withPrecomputedVisualizerBars(
  data: VisualizationData,
  options: Required<VisualizationOptions>
): VisualizationData {
  if (options.visualizerBarCount <= 0) return data
  return {
    ...data,
    spectrum: [],
    spectrogram: [],
    oscilloscope: [],
    visualizerBars: mapSpectrumToVisualizerBars(
      data.spectrum,
      data.sampleRate,
      options.visualizerBarCount
    )
  }
}

export function createFallbackVisualizationData(
  options: Required<VisualizationOptions>,
  sampleRate: number,
  phaseSeconds: number,
  reason = 'Native visualization tap unavailable'
): VisualizationData {
  const phase = Number.isFinite(phaseSeconds) ? phaseSeconds : 0
  const spectrum = Array.from({ length: options.spectrumPoints }, (_, index) => {
    const x = index / Math.max(1, options.spectrumPoints - 1)
    const bass = Math.sin((phase * 2.2 + x * 9) * Math.PI) * 0.18
    const mid = Math.sin((phase * 1.15 + x * 23) * Math.PI) * 0.1
    const envelope = Math.pow(1 - x, 0.62)
    return Math.max(0.03, Math.min(1, 0.12 + envelope * (0.34 + bass + mid)))
  })
  const waveform = Array.from({ length: options.waveformPoints }, (_, index) => {
    const x = index / Math.max(1, options.waveformPoints - 1)
    return Math.max(-1, Math.min(1, Math.sin((x * 5.5 + phase * 1.8) * Math.PI) * 0.42))
  })
  const oscilloscope = Array.from({ length: options.oscilloscopePoints }, (_, index) => {
    const x = index / Math.max(1, options.oscilloscopePoints - 1)
    const carrier = Math.sin((x * 10 + phase * 2.4) * Math.PI)
    const harmonic = Math.sin((x * 21 + phase * 1.7) * Math.PI) * 0.22
    return Math.max(-1, Math.min(1, (carrier + harmonic) * 0.48))
  })

  return {
    spectrum,
    waveform,
    oscilloscope,
    peakDb: -18,
    rmsDb: -28,
    lufsMomentary: -24,
    spectrogram: options.spectrogramFrames > 0 ? [spectrum] : [],
    sampleRate: Math.max(1, Math.trunc(sampleRate || 44100)),
    maxFrequency: visualizationMaxFrequency(sampleRate || 44100),
    active: true,
    tapStatus: 'synthetic-fallback',
    reason
  }
}

export function createInactiveVisualizationData(
  options: Required<VisualizationOptions>,
  sampleRate = 0,
  tapStatus: VisualizationTapStatus = 'stopped',
  reason = ''
): VisualizationData {
  return {
    spectrum: Array.from({ length: options.spectrumPoints }, () => 0),
    waveform: Array.from({ length: options.waveformPoints }, () => 0),
    oscilloscope: Array.from({ length: options.oscilloscopePoints }, () => 0),
    peakDb: -120,
    rmsDb: -120,
    lufsMomentary: null,
    spectrogram: [],
    sampleRate: Math.max(0, Math.trunc(sampleRate || 0)),
    maxFrequency: visualizationMaxFrequency(sampleRate),
    active: false,
    tapStatus,
    reason
  }
}

export function normalizeVisualizationTapStatus(
  value: unknown,
  active: boolean
): VisualizationTapStatus {
  if (
    value === 'active' ||
    value === 'stopped' ||
    value === 'disabled' ||
    value === 'no-samples' ||
    value === 'native-unavailable' ||
    value === 'synthetic-fallback'
  ) {
    return value
  }
  return active ? 'active' : 'no-samples'
}

export function normalizeVisualizationData(
  data: Partial<VisualizationData>,
  options: Required<VisualizationOptions>
): VisualizationData {
  const active = data.active === true
  const sampleRate =
    typeof data.sampleRate === 'number' && Number.isFinite(data.sampleRate) ? data.sampleRate : 0
  const maxFrequencyLimit = visualizationMaxFrequency(sampleRate)
  const maxFrequency =
    typeof data.maxFrequency === 'number' && Number.isFinite(data.maxFrequency)
      ? Math.max(20, Math.min(maxFrequencyLimit, data.maxFrequency))
      : maxFrequencyLimit

  return {
    spectrum: normalizeNumberArray(data.spectrum, options.spectrumPoints),
    waveform: normalizeNumberArray(data.waveform, options.waveformPoints),
    oscilloscope: normalizeNumberArray(data.oscilloscope, options.oscilloscopePoints),
    peakDb: typeof data.peakDb === 'number' && Number.isFinite(data.peakDb) ? data.peakDb : -120,
    rmsDb: typeof data.rmsDb === 'number' && Number.isFinite(data.rmsDb) ? data.rmsDb : -120,
    lufsMomentary:
      typeof data.lufsMomentary === 'number' && Number.isFinite(data.lufsMomentary)
        ? data.lufsMomentary
        : null,
    spectrogram: normalizeSpectrogram(
      data.spectrogram,
      options.spectrogramFrames,
      options.spectrumPoints
    ),
    sampleRate,
    maxFrequency,
    active,
    tapStatus: normalizeVisualizationTapStatus(data.tapStatus, active),
    reason: typeof data.reason === 'string' ? data.reason : ''
  }
}

export function createDefaultPlaybackInfo(
  output: AudioOutputId,
  device: string,
  exclusiveMode: boolean,
  outputConfig: OutputConfig
): PlaybackInfo {
  const exclusive =
    output === 'wasapi'
      ? exclusiveMode
      : output === 'asio'
        ? true
        : output === 'coreaudio'
          ? exclusiveMode
          : false
  const supportsOutputPerfect =
    output === 'asio' ||
    (output === 'wasapi' && exclusiveMode) ||
    (output === 'coreaudio' && exclusiveMode)
  const accessMode =
    output === 'asio'
      ? 'exclusive'
      : output === 'wasapi' || output === 'coreaudio'
        ? exclusiveMode
          ? 'exclusive'
          : 'shared'
        : 'shared'
  const devicePathKind = output === 'asio' ? 'asio' : output === 'coreaudio' ? 'hal' : 'default'
  const perfectReasonCode = supportsOutputPerfect
    ? ''
    : output === 'wasapi' || output === 'coreaudio'
      ? 'shared_mixer'
      : 'backend_not_output_perfect'
  const perfectReason = supportsOutputPerfect
    ? ''
    : output === 'wasapi'
      ? '共享输出经过系统混音'
      : output === 'coreaudio'
        ? 'CoreAudio 默认输出可能经过系统混音或格式转换'
        : output === 'alsa'
          ? 'ALSA 当前设备未声明 hw 直连 bit-perfect 能力'
          : '当前输出路径未声明 bit-perfect 能力'
  const latencyInfo: LatencyInfo = {
    bufferLatencyMs: 0,
    outputLatencyMs: 0,
    totalLatencyMs: 0
  }
  const diagnostics: OutputDiagnostics = {
    sessionUnderrunCount: 0,
    sessionBufferDropCount: 0,
    sessionRecoveryCount: 0,
    lifetimeUnderrunCount: 0,
    lifetimeBufferDropCount: 0,
    lifetimeRecoveryCount: 0,
    driverRestartCount: 0,
    deviceLostCount: 0,
    driverXrunCount: 0,
    lastError: ''
  }
  const outputInfo: OutputInfo = {
    exclusive,
    supportsOutputPerfect,
    sourceExact: false,
    outputPerfect: false,
    pcmPassthrough: false,
    resampled: false,
    providerImplementation: 'legacy-native',
    conversionInfo: {
      sampleFormatConverted: false,
      sampleRateConverted: false,
      channelLayoutConverted: false,
      source: 'unavailable'
    },
    accessMode,
    devicePathKind,
    perfectReasonCode,
    capabilityReason: perfectReason,
    perfectReason,
    outputSampleRate: 0,
    outputBitDepth: 0,
    backend: output,
    actualBackend: output,
    deviceName: device,
    actualDeviceName: device,
    driverName: '',
    actualDriverName: '',
    driverVersion: 0,
    actualDriverVersion: 0,
    actualOutputFormat: '',
    actualSampleRate: 0,
    actualBitDepth: 0,
    actualChannels: 0,
    driverDopCapable: false,
    driverNativeDsdCapable: false,
    driverDopCarrierSampleRates: [],
    driverDopCarrierFormats: [],
    driverNativeDsdSampleRates: [],
    nativeDsdRuntimeState: 'unsupported',
    nativeDsdRequestedRate: 0,
    nativeDsdActualRate: 0,
    nativeDsdChannels: 0,
    nativeDsdExplicitlyCapable: false,
    nativeDsdAdvertisedSampleRates: [],
    nativeDsdRuntimeReason: '',
    bufferSizeFrames: 0,
    latencyFrames: 0,
    latencyMs: 0,
    latencyInfo,
    channelRoutingMode: outputConfig.routingMode,
    diagnostics,
    deviceRecovered: false,
    recoveryCount: 0,
    nativeDsp: { plugins: [] },
    isDsd: false,
    dsdMode: 'pcm',
    dsdRate: 0,
    actualDsdRate: 0,
    dsdRatePolicy: 'pcm-fallback',
    dsdConversion: 'exact',
    dsdConversionReason: ''
  }
  return {
    state: 'stopped',
    position: 0,
    duration: 0,
    volume: 1,
    playbackRate: 1,
    requestedConfigRevision: 0,
    appliedConfigRevision: 0,
    queueIndex: -1,
    playMode: 'sequential',
    source: '',
    codec: '未知',
    bitrate: 0,
    sourceSampleRate: 0,
    sourceBitDepth: 0,
    decodedSampleRate: 0,
    decodedBitDepth: 0,
    decodedChannels: 0,
    decodedSampleFormat: '',
    outputBackend: output,
    outputDevice: device,
    outputInfo,
    actualBackend: output,
    accessMode,
    devicePathKind,
    driverName: '',
    driverVersion: 0,
    actualOutputFormat: '',
    actualSampleRate: 0,
    actualBitDepth: 0,
    actualChannels: 0,
    bufferSizeFrames: 0,
    latencyFrames: 0,
    latencyMs: 0,
    latencyInfo,
    channelRoutingMode: outputConfig.routingMode,
    supportsOutputPerfect,
    sourceExact: false,
    diagnostics,
    deviceRecovered: false,
    recoveryCount: 0,
    outputSampleRate: 0,
    outputBitDepth: 0,
    channelCount: 0,
    outputPerfect: false,
    pcmPassthrough: false,
    dspActive: false,
    replayGainActive: false,
    eqActive: false,
    convolverActive: false,
    crossfeedActive: false,
    crossfadeActive: false,
    fftActive: false,
    irResampled: false,
    replayGainDb: 0,
    crossfeedStrength: 0,
    crossfadeSeconds: 0,
    convolverLatencyFrames: 0,
    partitionSize: 0,
    channelMappingMode: '',
    perfectReason,
    perfectReasonCode,
    capabilityReason: perfectReason,
    isDsd: false,
    dsdMode: 'pcm',
    dsdRate: 0,
    actualDsdRate: 0,
    dsdRatePolicy: 'pcm-fallback',
    dsdConversion: 'exact',
    dsdConversionReason: '',
    gaplessActive: false,
    preloadReady: false,
    gaplessBlockedReason: '',
    upcomingTrack: null,
    nativePlaybackActive: false
  }
}

export function inferCodec(source: string): string {
  const ext = source.split('.').pop()?.toLowerCase()
  if (!ext) return '未知'
  if (ext === 'm4a' || ext === 'mp4') return 'aac/alac'
  if (ext === 'aif' || ext === 'aiff') return 'aiff'
  if (ext === 'dsf' || ext === 'dff') return 'dsd'
  return ext
}

export function sourceLooksDsd(source: string): boolean {
  return /\.(dsf|dff)$/i.test(source)
}

export function normalizeDsdState(
  canonicalOutput?: Partial<OutputInfo> | null,
  mirror?: Partial<PlaybackInfo> | null
): { isDsd: boolean; dsdMode: string; dsdRate: number } {
  const canonicalMode =
    typeof canonicalOutput?.dsdMode === 'string' ? canonicalOutput.dsdMode.trim() : ''
  const mirrorMode = typeof mirror?.dsdMode === 'string' ? mirror.dsdMode.trim() : ''
  const canonicalHasMode = canonicalMode.length > 0
  const modeIndicatesDsd = (mode: string): boolean =>
    mode === 'native' || mode === 'dop' || mode === 'unsupported'
  const canonicalIsDsd =
    typeof canonicalOutput?.isDsd === 'boolean'
      ? canonicalOutput.isDsd
      : canonicalHasMode
        ? modeIndicatesDsd(canonicalMode)
        : undefined
  const isDsd = canonicalIsDsd ?? (mirror?.isDsd === true || modeIndicatesDsd(mirrorMode))
  const rawMode = canonicalHasMode ? canonicalMode : mirrorMode
  const dsdMode = isDsd ? rawMode || 'unsupported' : 'pcm'
  const dsdRate = isDsd ? (canonicalOutput?.dsdRate ?? mirror?.dsdRate ?? 0) : 0
  return { isDsd, dsdMode, dsdRate }
}
