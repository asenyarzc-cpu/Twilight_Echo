/**
 * Shared HiFi / Settings option sources and Stage-1 status copy.
 * Keep SettingsPage and HiFiSidebar in lockstep; never re-alias loudnorm to track.
 */

export type VolumeNormalizationMode = 'off' | 'track' | 'album' | 'loudnorm'
export type DsdOutputMode = 'auto' | 'pcm' | 'dop' | 'native'
export type DsdRatePolicy = 'exact' | 'downrate' | 'pcm-fallback'
export type LoudnormStatus = 'idle' | 'measuring' | 'cached' | 'fallback' | 'unavailable'

export interface LabeledOption<T extends string> {
  value: T
  label: string
  description?: string
}

/** Default EBU R128 loudnorm parameters (must match ReplayGainProcessor / createLegacyDspGraph). */
export const LOUDNORM_TARGET_LUFS = -23
export const LOUDNORM_TRUE_PEAK_CEILING_DB = -1
export const LOUDNORM_ALGORITHM_VERSION = 1

/** Default software volume: protect hearing; bit-perfect needs explicit Unity (1.0). */
export const DEFAULT_SOFTWARE_VOLUME = 0.7
export const UNITY_SOFTWARE_VOLUME = 1

/** Below this a gain stage is bit-transparent. Mirrors the engine's own epsilon. */
export const TRANSPARENT_GAIN_EPSILON_DB = 0.0001

/**
 * Whether an equalizer band changes the signal.
 *
 * A gain-shaped band (peak / shelf) sitting at 0 dB is bit-transparent, so an
 * enabled but flat equalizer is not processing anything. Filter bands reshape
 * the signal at any gain, so for those the enable flag alone counts.
 *
 * Kept in lockstep with eqBandAltersSignal() in audio-engine/core/AudioPipeline.cpp:
 * the engine decides from this rule whether a DSD source may stay on its
 * passthrough transport, and the UI must name the same blockers the engine acts on.
 */
export function equalizerBandAltersSignal(band: {
  gain: number
  filterType: string
  enabled?: boolean
}): boolean {
  if (band.enabled === false) return false
  if (
    band.filterType === 'peak' ||
    band.filterType === 'lowShelf' ||
    band.filterType === 'highShelf'
  ) {
    return Math.abs(band.gain) > TRANSPARENT_GAIN_EPSILON_DB
  }
  return true
}

/** Whether the equalizer settings, as configured, would alter the signal. */
export function equalizerSettingsAlterSignal(settings: {
  eqEnabled: boolean
  eqPreamp: number
  eqBands: readonly { gain: number; filterType: string; enabled?: boolean }[]
}): boolean {
  if (!settings.eqEnabled) return false
  if (Math.abs(settings.eqPreamp) > TRANSPARENT_GAIN_EPSILON_DB) return true
  return settings.eqBands.some(equalizerBandAltersSignal)
}

export const VOLUME_NORMALIZATION_OPTIONS: readonly LabeledOption<VolumeNormalizationMode>[] = [
  {
    value: 'off',
    label: 'Off',
    description: '不施加响度增益'
  },
  {
    value: 'track',
    label: 'Track / R128',
    description: '仅使用源标签 ReplayGain Track / R128 track'
  },
  {
    value: 'album',
    label: 'Album / R128',
    description: '仅使用源标签 ReplayGain Album / R128 album'
  },
  {
    value: 'loudnorm',
    label: 'Loudnorm (EBU R128)',
    description:
      '离线测量 integrated LUFS；缓存命中用测量增益，无缓存首播 fallback 并后台测量。禁止映射为 Track'
  }
] as const

export const DSD_OUTPUT_MODE_OPTIONS: readonly LabeledOption<DsdOutputMode>[] = [
  { value: 'auto', label: 'Auto', description: '按设备能力自动选择 Native / DoP / PCM' },
  { value: 'pcm', label: 'PCM', description: '强制 DSD 解码为 PCM' },
  { value: 'dop', label: 'DoP', description: 'DoP 载波传输' },
  { value: 'native', label: 'Native', description: 'Native DSD（平台/设备支持时）' }
] as const

export const DSD_RATE_POLICY_OPTIONS: readonly LabeledOption<DsdRatePolicy>[] = [
  { value: 'pcm-fallback', label: 'PCM fallback', description: '保持现有 Native → DoP → PCM 行为' },
  { value: 'exact', label: 'Exact rate', description: '只允许源倍率 Native / DoP；不可用时报错' },
  {
    value: 'downrate',
    label: 'DSD downrate',
    description: '源倍率不可用时在 DSD 域滤波降至较低倍率'
  }
] as const

/**
 * DSD 兼容层路由。与 dsdOutputMode 正交：mode 决定「要什么形态」，route 决定
 * 「从哪条线出去」。部分 DAC 的自带 ASIO 驱动不接受 DSD 采样类型（或用户只有
 * WASAPI），DSD 必然被降级为 DoP / PCM；此时可把 DSD 单独路由到一个已注册的
 * DSD 代理 ASIO 驱动，由代理转成硬件要的线格式，而 PCM 仍走主输出。
 *
 * 引擎侧只认 backend + device，不认代理品牌名——代理识别只是 UI 标签。
 */
export interface DsdRouteSettings {
  enabled: boolean
  /** 空 = 沿用主输出后端 */
  backend: string
  /** 空 = 沿用主输出设备 */
  device: string
  /** PCM→DSD 上采样是否也走此路由 */
  applyToPcmToDsd: boolean
  /** true = 无法直通时报错停止，不静默降级为 PCM */
  strictPassthrough: boolean
}

export const DEFAULT_DSD_ROUTE: DsdRouteSettings = {
  enabled: false,
  backend: '',
  device: '',
  applyToPcmToDsd: true,
  strictPassthrough: false
}

export function isDsdRouteSettings(value: unknown): value is DsdRouteSettings {
  if (!value || typeof value !== 'object') return false
  const route = value as Partial<DsdRouteSettings>
  return (
    typeof route.enabled === 'boolean' &&
    typeof route.backend === 'string' &&
    typeof route.device === 'string' &&
    typeof route.applyToPcmToDsd === 'boolean' &&
    typeof route.strictPassthrough === 'boolean'
  )
}

export function normalizeDsdRouteSettings(value: unknown): DsdRouteSettings {
  const route = (value ?? {}) as Partial<DsdRouteSettings>
  const backend = typeof route.backend === 'string' ? route.backend.trim() : ''
  const device = typeof route.device === 'string' ? route.device.trim() : ''
  return {
    enabled: route.enabled === true,
    backend,
    device,
    applyToPcmToDsd: route.applyToPcmToDsd !== false,
    strictPassthrough: route.strictPassthrough === true
  }
}

export function dsdRouteSettingsEqual(left: DsdRouteSettings, right: DsdRouteSettings): boolean {
  return (
    left.enabled === right.enabled &&
    left.backend === right.backend &&
    left.device === right.device &&
    left.applyToPcmToDsd === right.applyToPcmToDsd &&
    left.strictPassthrough === right.strictPassthrough
  )
}

/** 只有开启且至少指定了一项覆写时，路由才真正偏离主输出。 */
export function dsdRouteTargetsDistinctRoute(route: DsdRouteSettings): boolean {
  return route.enabled && (route.backend.length > 0 || route.device.length > 0)
}

/**
 * setAudioProcessing 的合并是浅展开：传入的 dsdRoute 会整体替换旧对象，缺失字段
 * 由 normalizeDsdRouteSettings 补默认值（backend/device 变空串）。所以调用方必须
 * 传完整路由，改单个字段用这个 helper 而不要手写 { enabled: true }。
 */
export function withDsdRoutePatch(
  current: DsdRouteSettings,
  patch: Partial<DsdRouteSettings>
): DsdRouteSettings {
  return normalizeDsdRouteSettings({ ...current, ...patch })
}

/** Canonical perfect-reason codes that Stage-1 UI must recognize. */
export const STAGE1_PERFECT_REASON_CODES = [
  'volume_not_unity',
  'playback_rate_not_unity',
  'loudnorm_active',
  'replaygain_active',
  'processing_active',
  'eq_active',
  'convolver_active',
  'crossfeed_active',
  'crossfade_active',
  'shared_mixer'
] as const

export type Stage1PerfectReasonCode = (typeof STAGE1_PERFECT_REASON_CODES)[number]

/** Shared Chinese status copy for HiFi / PlayerBar / Settings. */
export const HIFI_STATUS_COPY = {
  volumeNotUnity: '软件音量不是 100%',
  volumeNotUnityHint: '默认 70% 保护听感；bit-perfect 需 Unity（100%）',
  unityButton: 'Unity 100%',
  unityButtonShort: 'Unity',
  playbackRateNotUnity: '播放倍速不是 1.0x',
  playbackRateNotUnityHint: '非 1.0x 倍速走 WSOLA 保音高变速，会破坏 bit-perfect',
  playbackRateActive: '变速处理中（保音高）',
  playbackRateResetCta: '恢复 1.0x',
  loudnormActive: 'Loudnorm 正在改变样本（EBU R128）',
  loudnormMeasuring: 'Loudnorm：后台测量中（首播使用 Fallback）',
  loudnormCached: 'Loudnorm：已用缓存测量增益',
  loudnormFallback: 'Loudnorm：无测量，使用 Fallback',
  loudnormUnavailable: 'Loudnorm：分析不可用（无 ebur128 或失败）',
  gaplessOn: 'Gapless 意图已开启',
  gaplessOff: 'Gapless 已关闭',
  gaplessNote: '同格式专辑连续播放时尝试无缝衔接；crossfade 会关闭 true gapless',
  gaplessActive: 'Gapless Active：预加载路径已就绪',
  gaplessPreload: 'Preload Ready：下一首已预解码',
  gaplessBlocked: 'Gapless Blocked',
  gaplessBlockedDisabled: 'Gapless 已关闭',
  gaplessBlockedDsd: 'DSD / DoP 路径不支持 gapless preload',
  gaplessBlockedPassthrough: 'Typed PCM passthrough 路径关闭 gapless',
  gaplessBlockedCrossfade: 'Crossfade 关闭 true gapless',
  gaplessBlockedFormat: '相邻曲目格式不匹配，无法 promote'
} as const

/** Runtime gapless blocked reasons from native PlaybackInfo.gaplessBlockedReason. */
export const GAPLESS_BLOCKED_REASONS = [
  'disabled',
  'dsd_path',
  'typed_passthrough',
  'crossfade',
  'format_mismatch'
] as const

export type GaplessBlockedReason = (typeof GAPLESS_BLOCKED_REASONS)[number]

export function isVolumeNormalizationMode(value: unknown): value is VolumeNormalizationMode {
  return value === 'off' || value === 'track' || value === 'album' || value === 'loudnorm'
}

export function isDsdOutputMode(value: unknown): value is DsdOutputMode {
  return value === 'auto' || value === 'pcm' || value === 'dop' || value === 'native'
}

export function isDsdRatePolicy(value: unknown): value is DsdRatePolicy {
  return value === 'exact' || value === 'downrate' || value === 'pcm-fallback'
}

export function labelForVolumeNormalization(mode: VolumeNormalizationMode): string {
  return VOLUME_NORMALIZATION_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}

export function labelForDsdOutputMode(mode: DsdOutputMode): string {
  return DSD_OUTPUT_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}

export function loudnormStatusCopy(status: LoudnormStatus): string {
  switch (status) {
    case 'measuring':
      return HIFI_STATUS_COPY.loudnormMeasuring
    case 'cached':
      return HIFI_STATUS_COPY.loudnormCached
    case 'fallback':
      return HIFI_STATUS_COPY.loudnormFallback
    case 'unavailable':
      return HIFI_STATUS_COPY.loudnormUnavailable
    case 'idle':
    default:
      return ''
  }
}

export function requiresMeasuredLoudnorm(mode: VolumeNormalizationMode): boolean {
  return mode === 'loudnorm'
}

/** Both Settings and HiFi must expose the full mode set including loudnorm. */
export function volumeNormalizationValues(): VolumeNormalizationMode[] {
  return VOLUME_NORMALIZATION_OPTIONS.map((option) => option.value)
}

export function dsdOutputModeValues(): DsdOutputMode[] {
  return DSD_OUTPUT_MODE_OPTIONS.map((option) => option.value)
}

export function dsdRatePolicyValues(): DsdRatePolicy[] {
  return DSD_RATE_POLICY_OPTIONS.map((option) => option.value)
}

export function isGaplessBlockedReason(value: unknown): value is GaplessBlockedReason {
  return (
    value === 'disabled' ||
    value === 'dsd_path' ||
    value === 'typed_passthrough' ||
    value === 'crossfade' ||
    value === 'format_mismatch'
  )
}

export function gaplessBlockedReasonCopy(reason: string | null | undefined): string {
  switch (reason) {
    case 'disabled':
      return HIFI_STATUS_COPY.gaplessBlockedDisabled
    case 'dsd_path':
      return HIFI_STATUS_COPY.gaplessBlockedDsd
    case 'typed_passthrough':
      return HIFI_STATUS_COPY.gaplessBlockedPassthrough
    case 'crossfade':
      return HIFI_STATUS_COPY.gaplessBlockedCrossfade
    case 'format_mismatch':
      return HIFI_STATUS_COPY.gaplessBlockedFormat
    default:
      return reason && reason.trim().length > 0
        ? `${HIFI_STATUS_COPY.gaplessBlocked}：${reason}`
        : ''
  }
}

/** HiFi status line for intent + runtime gapless state. */
export function gaplessRuntimeStatusCopy(input: {
  intentEnabled: boolean
  gaplessActive?: boolean
  preloadReady?: boolean
  gaplessBlockedReason?: string | null
}): string {
  if (!input.intentEnabled) return HIFI_STATUS_COPY.gaplessOff
  const blocked = gaplessBlockedReasonCopy(input.gaplessBlockedReason)
  if (blocked) return blocked
  if (input.gaplessActive && input.preloadReady) return HIFI_STATUS_COPY.gaplessPreload
  if (input.gaplessActive) return HIFI_STATUS_COPY.gaplessActive
  return HIFI_STATUS_COPY.gaplessOn
}
