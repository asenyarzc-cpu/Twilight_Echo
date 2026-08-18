import type { OpraCatalogStatus } from '../../../preload/types'
import type {
  AudioEqPreset,
  AudioProcessingSettings,
  EqualizerBand,
  EqualizerFilterType,
  EqMode,
  HeadphoneCompensationSettings
} from '../types/settings'

export const GRAPH_MIN_FREQUENCY = 20
export const GRAPH_MAX_FREQUENCY = 20000
export const GRAPH_MIN_GAIN = -18
export const GRAPH_MAX_GAIN = 18
export const FREQUENCY_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000, 20000]
export const GAIN_TICKS = [-18, -12, -6, 0, 6, 12, 18]
export const DEFAULT_BAND_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export const filterTypes: { value: EqualizerFilterType; label: string; usesGain: boolean }[] = [
  { value: 'peak', label: '峰值', usesGain: true },
  { value: 'lowShelf', label: '低频搁架', usesGain: true },
  { value: 'highShelf', label: '高频搁架', usesGain: true },
  { value: 'bandPass', label: '带通', usesGain: false },
  { value: 'lowPass', label: '低通', usesGain: false },
  { value: 'highPass', label: '高通', usesGain: false },
  { value: 'allPass', label: '全通', usesGain: false },
  { value: 'notch', label: '陷波', usesGain: false }
]

export const defaultEqBands: EqualizerBand[] = DEFAULT_BAND_FREQUENCIES.map((frequency) => ({
  frequency,
  gain: 0,
  q: 1,
  filterType: 'peak'
}))

export const defaultAudioProcessing: AudioProcessingSettings = {
  dspEnabled: false,
  directMode: false,
  clipGuard: true,
  fftEnabled: true,
  fftResolution: 8192,
  highResolution: true,
  dsdToPcm: false,
  dsdOutputMode: 'auto',
  dsdRoute: {
    enabled: false,
    backend: '',
    device: '',
    applyToPcmToDsd: true,
    strictPassthrough: false
  },
  sacdProgramMode: 'auto',
  eqEnabled: false,
  eqMode: 'graphic',
  eqPreamp: 0,
  eqBands: defaultEqBands,
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

export const builtInEqPresets: AudioEqPreset[] = [
  {
    id: 'flat',
    name: 'Flat',
    eqMode: 'graphic',
    eqPreamp: 0,
    eqBands: defaultEqBands
  },
  {
    id: 'warm',
    name: 'Warm',
    eqMode: 'graphic',
    eqPreamp: -1,
    eqBands: [2.4, 1.8, 1.1, 0.4, 0, -0.4, -0.5, 0.2, 0.8, 1].map((gain, index) => ({
      ...defaultEqBands[index],
      gain
    }))
  },
  {
    id: 'vocal',
    name: 'Vocal',
    eqMode: 'parametric',
    eqPreamp: -1.5,
    eqBands: [-1, -0.8, -0.2, 0.7, 1.6, 2.4, 2, 1.1, 0.2, -0.6].map((gain, index) => ({
      ...defaultEqBands[index],
      gain,
      q: index >= 4 && index <= 6 ? 1.3 : 1
    }))
  },
  {
    id: 'night',
    name: 'Night',
    eqMode: 'graphic',
    eqPreamp: -2,
    eqBands: [-2.5, -2, -1.1, -0.4, 0, 0.3, 0.2, -0.2, -0.8, -1.4].map((gain, index) => ({
      ...defaultEqBands[index],
      gain
    }))
  }
]

export const tabs: { key: EqMode; label: string; icon: string; desc: string }[] = [
  {
    key: 'graphic',
    label: '图形均衡器',
    icon: 'pi pi-chart-bar',
    desc: '曲线、Master 与 10 波段塑形'
  },
  {
    key: 'parametric',
    label: '参数均衡器',
    icon: 'pi pi-sliders-h',
    desc: '频率、滤波器、增益与 Q 值'
  }
]

export function cloneBands(bands: EqualizerBand[]): EqualizerBand[] {
  return bands.map((band) => ({ ...band }))
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const next = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.min(max, Math.max(min, next))
}

export function normalizeFilterType(value: unknown): EqualizerFilterType {
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

// Per-band bypass and channel routing are optional on EqualizerBand, but they
// must survive normalization: dropping them here silently re-enabled bypassed
// bands on the next edit (the main-process normalizer defaults `enabled` back to
// true), so the engine changed the audio while the editor state stayed put.
function normalizeBandFlags(band: Partial<EqualizerBand>): Partial<EqualizerBand> {
  const flags: Partial<EqualizerBand> = {}
  if (band.enabled !== undefined) flags.enabled = band.enabled !== false
  if (band.channelMask !== undefined) {
    flags.channelMask = Math.max(0, Math.min(0xffffffff, Math.trunc(band.channelMask)))
  }
  return flags
}

export function normalizeAudioProcessing(
  settings?: Partial<AudioProcessingSettings>
): AudioProcessingSettings {
  const eqMode: EqMode = settings?.eqMode === 'parametric' ? 'parametric' : 'graphic'
  const rawBands = Array.isArray(settings?.eqBands) ? settings.eqBands : defaultEqBands
  const eqBands =
    eqMode === 'parametric'
      ? rawBands.slice(0, 32).map((band, index) => {
          const defaultBand = defaultEqBands[index % defaultEqBands.length]
          return {
            frequency: clampNumber(band.frequency, 20, 24000, defaultBand.frequency),
            gain: clampNumber(band.gain, -24, 24, 0),
            q: clampNumber(band.q, 0.1, 20, 1),
            filterType: normalizeFilterType(band.filterType),
            ...normalizeBandFlags(band)
          }
        })
      : defaultEqBands.map((defaultBand, index) => {
          const band = rawBands[index] ?? defaultBand
          return {
            frequency: clampNumber(band.frequency, 20, 24000, defaultBand.frequency),
            gain: clampNumber(band.gain, -12, 12, 0),
            q: clampNumber(band.q, 0.25, 8, 1),
            filterType: normalizeFilterType(band.filterType),
            ...normalizeBandFlags(band)
          }
        })
  return {
    ...defaultAudioProcessing,
    ...settings,
    eqMode,
    dsdOutputMode:
      settings?.dsdOutputMode === 'pcm' ||
      settings?.dsdOutputMode === 'dop' ||
      settings?.dsdOutputMode === 'native'
        ? settings.dsdOutputMode
        : settings?.dsdToPcm === true
          ? 'pcm'
          : 'auto',
    sacdProgramMode:
      settings?.sacdProgramMode === 'stereo' || settings?.sacdProgramMode === 'multichannel'
        ? settings.sacdProgramMode
        : 'auto',
    fftResolution: clampNumber(settings?.fftResolution, 64, 8192, 8192),
    eqPreamp: clampNumber(settings?.eqPreamp, -24, 24, 0),
    replayGainPreamp: clampNumber(settings?.replayGainPreamp, -12, 12, 0),
    replayGainFallback: clampNumber(settings?.replayGainFallback, -12, 12, 0),
    crossfeedStrength: clampNumber(settings?.crossfeedStrength, 0, 1, 0),
    crossfeedDelayMs: clampNumber(settings?.crossfeedDelayMs, 0.05, 2, 0.35),
    crossfeedCutoffHz: clampNumber(settings?.crossfeedCutoffHz, 80, 4000, 700),
    crossfadeSeconds: clampNumber(settings?.crossfadeSeconds, 0, 12, 0),
    eqBands: eqBands.length > 0 ? eqBands : cloneBands(defaultEqBands)
  }
}

export function patchBand(
  bands: EqualizerBand[],
  index: number,
  patch: Partial<EqualizerBand>,
  mode: EqMode
): EqualizerBand[] {
  const next = cloneBands(bands)
  if (!next[index]) return next
  next[index] = {
    ...next[index],
    ...patch,
    frequency:
      patch.frequency !== undefined
        ? clampNumber(patch.frequency, 20, 24000, next[index].frequency)
        : next[index].frequency,
    gain:
      patch.gain !== undefined
        ? clampNumber(
            patch.gain,
            mode === 'parametric' ? -24 : -12,
            mode === 'parametric' ? 24 : 12,
            next[index].gain
          )
        : next[index].gain,
    q:
      patch.q !== undefined
        ? clampNumber(
            patch.q,
            mode === 'parametric' ? 0.1 : 0.25,
            mode === 'parametric' ? 20 : 8,
            next[index].q
          )
        : next[index].q,
    filterType:
      patch.filterType !== undefined
        ? normalizeFilterType(patch.filterType)
        : next[index].filterType
  }
  return next
}

export function formatFrequency(frequency: number): string {
  if (frequency >= 1000) {
    return (frequency / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  }
  return Math.round(frequency).toString()
}

export function frequencyToX(frequency: number): number {
  const min = Math.log10(GRAPH_MIN_FREQUENCY)
  const max = Math.log10(GRAPH_MAX_FREQUENCY)
  const ratio =
    (Math.log10(
      clampNumber(frequency, GRAPH_MIN_FREQUENCY, GRAPH_MAX_FREQUENCY, GRAPH_MIN_FREQUENCY)
    ) -
      min) /
    (max - min)
  return ratio * 100
}

export function gainToY(gain: number): number {
  const ratio =
    (clampNumber(gain, GRAPH_MIN_GAIN, GRAPH_MAX_GAIN, 0) - GRAPH_MIN_GAIN) /
    (GRAPH_MAX_GAIN - GRAPH_MIN_GAIN)
  return 100 - ratio * 100
}

export function responseToPath(response: { frequency: number; db: number }[]): string {
  return response
    .map((point, index) => {
      const x = frequencyToX(point.frequency)
      const y = gainToY(clampNumber(point.db, GRAPH_MIN_GAIN, GRAPH_MAX_GAIN, 0))
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

export function getThumbTop(val: number, max: number) {
  const ratio = (max - val) / (2 * max)
  return ratio * 100 + '%'
}

export function getFillStyle(val: number, max: number) {
  if (val >= 0) {
    const heightRatio = (val / max) * 50
    return { bottom: '50%', height: heightRatio + '%' }
  } else {
    const heightRatio = (-val / max) * 50
    return { top: '50%', height: heightRatio + '%' }
  }
}

export function isGainDisabled(band: EqualizerBand | undefined): boolean {
  if (!band) return true
  return !filterTypes.find((filter) => filter.value === band.filterType)?.usesGain
}

export function formatOpraStatus(status: OpraCatalogStatus | null): string {
  if (!status) return 'OPRA 未加载'
  if (status.loading) return 'OPRA 正在加载'
  if (status.loaded) {
    const source = status.source === 'network' ? '已刷新' : '本地缓存'
    return `${source} · ${status.profileCount.toLocaleString()} profiles`
  }
  return status.lastError ? `离线：${status.lastError}` : '离线，暂无缓存'
}

export function formatActiveCompensationTitle(compensation: HeadphoneCompensationSettings): string {
  if (!compensation.enabled || !compensation.eqId) return '未启用耳机补偿'
  return `${compensation.vendorName} ${compensation.productName}`.trim()
}

export function opraApplyButtonLabel(
  compensationEqId: string,
  profileEqId: string,
  applyingEqId: string
): string {
  if (compensationEqId === profileEqId) return 'In Use'
  if (applyingEqId === profileEqId) return 'Applying'
  return 'Apply'
}
