<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  DSD_OUTPUT_MODE_OPTIONS,
  gaplessRuntimeStatusCopy,
  HIFI_STATUS_COPY,
  loudnormStatusCopy,
  VOLUME_NORMALIZATION_OPTIONS,
  type LoudnormStatus
} from '../../../../shared/audioProcessingOptions.ts'
import {
  DSP_DITHER_MODE_OPTIONS,
  DSP_OUTPUT_SAMPLE_RATE_OPTIONS,
  DSP_RESAMPLER_QUALITY_OPTIONS,
  outputStageIsActive,
  stereoImageIsActive,
  type DspDitherMode,
  type DspOutputStageConfig,
  type DspResamplerQuality,
  type DspStereoImageConfig
} from '../../../../shared/dspGraph.ts'
import type {
  AudioDeviceOption,
  AudioOutputId,
  AudioOutputOption,
  AudioProcessingSettings,
  ChannelRoutingMode,
  DsdOutputMode,
  OutputConfig,
  VolumeNormalizationMode
} from '../../types/settings'
import type { LyricSource, Track } from '../../types/music'
import type { DlnaDeviceInfo } from '../../../../shared/remoteControl.ts'
import type { PlaybackBookmark } from '../../../../shared/playbackBookmarks.ts'
import type { LyricLayerSourceSelection } from '../../../../shared/lyricsManagement.ts'
import LyricsManagerPanel from './LyricsManagerPanel.vue'
import LyricsAppearanceCustomizer from '../LyricsAppearanceCustomizer.vue'

export type StatusTone = 'success' | 'warning' | 'muted'

export interface HiFiStatusChip {
  label: string
  tone?: StatusTone
  title?: string
}

const props = defineProps<{
  glass?: boolean
  accentColor?: string
  exclusiveMode: boolean
  exclusiveAvailable: boolean
  audioOutput: AudioOutputId
  audioOutputOptions: AudioOutputOption[]
  audioDevice: string
  audioDeviceOptions: AudioDeviceOption[]
  audioProcessing: AudioProcessingSettings
  audioOutputConfig: OutputConfig
  dspOutputStage: DspOutputStageConfig
  dspStereoImage: DspStereoImageConfig
  actualSampleRate?: number
  statusChips: HiFiStatusChip[]
  nonPerfectReason: string
  perfectReasonCode?: string
  /** What is happening to the samples, from the shared reason registry. */
  perfectReasonExplain?: string
  /** The concrete next action; empty when nothing is user-actionable. */
  perfectReasonFix?: string
  /** The engine's raw one-line cause (route decision / negotiation detail). */
  perfectReasonEngineDetail?: string
  volume: number
  gaplessActive?: boolean
  preloadReady?: boolean
  gaplessBlockedReason?: string
  loudnormStatus?: LoudnormStatus
  outputChainText: string
  outputLatencyText: string
  outputDiagnosticsText: string
  nativeDsdRuntimeReasonText: string
  currentTrack: Track | null
  desktopLyricsOn: boolean
  lyricsReloading?: boolean
  originalLayerSelection: LyricLayerSourceSelection
  translationLayerSelection: LyricLayerSourceSelection
  showTranslation: boolean
  lyricControlsPending?: boolean
  playerBarButtons: Array<{
    id: string
    title: string
    description?: string
    command?: string
  }>
  isLiveStream?: boolean
  playbackRate?: number
  playbackRateLabel?: string
  playbackRateTitle?: string
  abLoopA?: number | null
  abLoopB?: number | null
  abLoopTitle?: string
  sleepTimerSelectValue?: string
  sleepTimerStatus?: string
  sleepTimerDefaultMinutes?: number
  castTargetName?: string | null
  castDevices?: DlnaDeviceInfo[]
  castBusy?: boolean
  castError?: string
  canCastCurrentTrack?: boolean
  bookmarks?: PlaybackBookmark[]
  renamingBookmarkId?: string | null
  renameDraft?: string
  formatTime?: (seconds: number) => string
}>()

const emit = defineEmits<{
  openSettings: []
  openDsp: []
  openEqualizer: []
  toggleExclusive: []
  toggleDsp: []
  toggleEq: []
  toggleGapless: []
  toggleCrossfeed: []
  toggleClipGuard: []
  toggleConvolver: []
  toggleDesktopLyrics: []
  setUnityVolume: []
  setReplayGainMode: [mode: VolumeNormalizationMode]
  setCrossfeedStrength: [strength: number]
  setCrossfadeSeconds: [seconds: number]
  setReplayGainPreamp: [db: number]
  setPreferredBufferSize: [frames: number]
  setRoutingMode: [mode: ChannelRoutingMode]
  setPcmToDsdMode: [mode: import('../../types/settings').PcmToDsdMode]
  setDsdOutputMode: [mode: DsdOutputMode]
  setOutputStage: [partial: Partial<DspOutputStageConfig>]
  setStereoImage: [partial: Partial<DspStereoImageConfig>]
  setAudioOutput: [output: AudioOutputId]
  setAudioDevice: [device: string]
  refreshDevices: []
  selectImpulseResponse: []
  clearImpulseResponse: []
  reloadLyrics: [prefer: 'auto' | 'local' | 'amll' | 'provider']
  setLyricLayerSelection: [
    key: 'originalSelection' | 'translationSelection',
    selection: LyricLayerSourceSelection
  ]
  toggleTranslationVisibility: []
  runExtension: [command?: string]
  cyclePlaybackRate: []
  toggleAbLoop: []
  clearAbLoop: []
  sleepTimerSelect: [value: string]
  refreshCastDevices: []
  castToDevice: [usn: string]
  stopCast: []
  addBookmark: []
  jumpBookmark: [bookmark: PlaybackBookmark]
  startRenameBookmark: [bookmark: PlaybackBookmark]
  commitRenameBookmark: []
  updateRenameDraft: [value: string]
  cancelRenameBookmark: []
  deleteBookmark: [id: string]
  lyricsCustomizing: [open: boolean]
}>()

const isVolumeUnity = computed(() => props.volume >= 0.999)
const showUnityVolumeCta = computed(
  () => props.perfectReasonCode === 'volume_not_unity' || !isVolumeUnity.value
)

const gaplessStatusText = computed(() =>
  gaplessRuntimeStatusCopy({
    intentEnabled: props.audioProcessing.gapless,
    gaplessActive: props.gaplessActive === true,
    preloadReady: props.preloadReady === true,
    gaplessBlockedReason: props.gaplessBlockedReason
  })
)

const gaplessStatusTone = computed(() => {
  if (!props.audioProcessing.gapless) return 'muted'
  if (props.gaplessBlockedReason) return 'warning'
  if (props.gaplessActive || props.preloadReady) return 'success'
  return 'muted'
})

const loudnormStatusText = computed(() => {
  if (props.audioProcessing.volumeNormalization !== 'loudnorm') return ''
  return loudnormStatusCopy(props.loudnormStatus ?? 'idle')
})

const loudnormStatusTone = computed(() => {
  if (props.audioProcessing.volumeNormalization !== 'loudnorm') return 'muted'
  switch (props.loudnormStatus) {
    case 'cached':
      return 'success'
    case 'measuring':
      return 'warning'
    case 'fallback':
    case 'unavailable':
      return 'warning'
    default:
      return 'muted'
  }
})

const activeSection = ref<'console' | 'output' | 'dsp' | 'tools' | 'lyrics'>('console')
const lyricsCustomizerOpen = ref(false)

/*
 * The customizer is a left-edge drawer whose whole purpose is watching the
 * lyrics react underneath, and this deck covers the right side of the same
 * window. Tell the PlayerBar to stand the overlay down while it is open.
 *
 * Note the panel is Teleported from inside this component, so the deck can only
 * be *hidden*, never unmounted — dropping `v-if="moreOpen"` on the overlay would
 * take the customizer down with it.
 */
watch(lyricsCustomizerOpen, (open) => emit('lyricsCustomizing', open))

const bufferSizeOptions = [
  { value: 0, label: 'Auto' },
  { value: 64, label: '64' },
  { value: 128, label: '128' },
  { value: 256, label: '256' },
  { value: 512, label: '512' },
  { value: 1024, label: '1024' },
  { value: 2048, label: '2048' },
  { value: 4096, label: '4096' }
] as const

const routingModeOptions: { value: ChannelRoutingMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'stereo', label: 'Stereo' },
  { value: 'stereo-to-5.1', label: '2.0 → 5.1' },
  { value: 'stereo-to-7.1', label: '2.0 → 7.1' },
  { value: 'mono-to-stereo', label: 'Mono → Stereo' },
  { value: 'mono-to-multichannel', label: 'Mono → Multi' }
]

const pcmToDsdModeOptions: { value: import('../../types/settings').PcmToDsdMode; label: string }[] =
  [
    { value: 'off', label: '关闭' },
    { value: 'dsd64', label: 'DSD64' },
    { value: 'dsd128', label: 'DSD128' },
    { value: 'dsd256', label: 'DSD256' }
  ]

const dsdOutputModeOptions = DSD_OUTPUT_MODE_OPTIONS
const replayGainOptions = VOLUME_NORMALIZATION_OPTIONS
const sampleRateOptions = DSP_OUTPUT_SAMPLE_RATE_OPTIONS
const resamplerOptions = DSP_RESAMPLER_QUALITY_OPTIONS
const ditherOptions = DSP_DITHER_MODE_OPTIONS

const sectionTabs = [
  { id: 'console' as const, label: '链路', icon: 'ph-waveform' },
  { id: 'output' as const, label: '输出', icon: 'ph-speaker-hifi' },
  { id: 'dsp' as const, label: 'DSP', icon: 'ph-sliders-horizontal' },
  { id: 'tools' as const, label: '工具', icon: 'ph-toolbox' },
  { id: 'lyrics' as const, label: '歌词', icon: 'ph-text-aa' }
]

const rateActive = computed(() => Math.abs((props.playbackRate ?? 1) - 1) > 0.001)
const abLoopPartial = computed(
  () => !props.isLiveStream && props.abLoopA != null && props.abLoopB == null
)
const abLoopActive = computed(
  () => !props.isLiveStream && props.abLoopA != null && props.abLoopB != null
)
const sleepDefaultMinutes = computed(() => props.sleepTimerDefaultMinutes ?? 30)
const castDeviceList = computed(() => props.castDevices ?? [])
const bookmarkList = computed(() => props.bookmarks ?? [])
const renameDraftValue = computed({
  get: () => props.renameDraft ?? '',
  set: (value: string) => emit('updateRenameDraft', value)
})

function onSleepTimerChange(event: Event): void {
  emit('sleepTimerSelect', (event.target as HTMLSelectElement).value)
}

function onLyricLayerSelectionChange(
  key: 'originalSelection' | 'translationSelection',
  event: Event
): void {
  const selection = (event.target as HTMLSelectElement).value
  if (
    selection !== 'automatic' &&
    selection !== 'local' &&
    selection !== 'amll' &&
    selection !== 'provider' &&
    selection !== 'manual'
  ) {
    return
  }
  emit('setLyricLayerSelection', key, selection)
}

function formatBookmarkTime(seconds: number): string {
  if (typeof props.formatTime === 'function') return props.formatTime(seconds)
  const total = Math.max(0, Math.floor(seconds || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const selectedDevice = computed(
  () =>
    props.audioDeviceOptions.find((device) => device.id === props.audioDevice) ??
    props.audioDeviceOptions[0]
)

const crossfeedPercent = computed(() => Math.round(props.audioProcessing.crossfeedStrength * 100))
const crossfadeSeconds = computed(() => props.audioProcessing.crossfadeSeconds)
const replayGainPreamp = computed(() => props.audioProcessing.replayGainPreamp)
const dspMasterOn = computed(() => props.audioProcessing.dspEnabled)
const eqOn = computed(() => props.audioProcessing.dspEnabled && props.audioProcessing.eqEnabled)
const crossfeedOn = computed(
  () => props.audioProcessing.dspEnabled && props.audioProcessing.crossfeedEnabled
)
const convolverOn = computed(
  () => props.audioProcessing.dspEnabled && props.audioProcessing.convolverEnabled
)

const convolverPathLabel = computed(() => {
  const path = props.audioProcessing.convolverIrPath?.trim()
  if (!path) return '未载入 IR'
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
})

const outputStageActive = computed(() => outputStageIsActive(props.dspOutputStage))

const targetSampleRateLabel = computed(() => {
  const target = props.dspOutputStage.targetSampleRate
  if (target === 'device') return 'Device'
  const option = sampleRateOptions.find((item) => item.value === target)
  return option?.label ?? `${Math.round(target / 100) / 10} kHz`
})

const actualSampleRateLabel = computed(() => {
  const rate = props.actualSampleRate
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return '—'
  return `${Math.round(rate / 100) / 10} kHz`
})

const outputStageHint = computed(() => {
  if (!outputStageActive.value) {
    return `目标 Device · 实际 ${actualSampleRateLabel.value} · 无强制重采样`
  }
  return `目标 ${targetSampleRateLabel.value} · 实际 ${actualSampleRateLabel.value} · SRC ${props.dspOutputStage.resamplerQuality} · dither ${props.dspOutputStage.dither}（采样率锁会关闭 bit-perfect）`
})

const stereoImageActive = computed(() => stereoImageIsActive(props.dspStereoImage))
const balancePercent = computed(() => Math.round(props.dspStereoImage.balance * 100))
const widthPercent = computed(() => Math.round(props.dspStereoImage.width * 100))
const stereoImageHint = computed(() => {
  if (!stereoImageActive.value) return '平衡 0 · 宽度 100% · 相位正常'
  const parts = [
    `平衡 ${balancePercent.value > 0 ? `R${balancePercent.value}` : balancePercent.value < 0 ? `L${Math.abs(balancePercent.value)}` : '0'}`,
    `宽度 ${widthPercent.value}%`
  ]
  if (props.dspStereoImage.invertLeft) parts.push('L 反相')
  if (props.dspStereoImage.invertRight) parts.push('R 反相')
  if (props.dspStereoImage.swap) parts.push('L/R 交换')
  if (props.dspStereoImage.mono) parts.push('单声道')
  return `${parts.join(' · ')}（会关闭 bit-perfect）`
})

const eqSummary = computed(() => {
  if (!props.audioProcessing.eqEnabled) return '旁路'
  const mode = props.audioProcessing.eqMode === 'parametric' ? '参数' : '图形'
  return `${mode} · Preamp ${props.audioProcessing.eqPreamp.toFixed(1)} dB`
})

const sourceQuality = computed(() => {
  const track = props.currentTrack
  if (!track) {
    return {
      badge: 'Idle',
      tone: 'muted' as StatusTone,
      format: '—',
      rate: '—',
      depth: '—',
      bitrate: '—',
      source: '—'
    }
  }

  const format = (track.format || track.fileName?.split('.').pop() || 'PCM').toUpperCase()
  const rate = track.sampleRate ? `${Math.round(track.sampleRate / 100) / 10} kHz` : '—'
  const depth = track.bitDepth ? `${track.bitDepth} bit` : '—'
  const bitrate = track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '—'
  const source = track.source === 'local' || !track.source ? '本地库' : String(track.source)

  let badge = 'Standard'
  let tone: StatusTone = 'muted'
  if (/\b(dsf|dff|dsd|sacd)\b/i.test(`${format} ${track.fileName || ''}`)) {
    badge = 'DSD'
    tone = 'success'
  } else if ((track.sampleRate || 0) >= 88200 || (track.bitDepth || 0) >= 24) {
    badge = 'Hi-Res'
    tone = 'success'
  } else if ((track.sampleRate || 0) >= 44100 && (track.bitDepth || 0) >= 16 && !track.bitrate) {
    badge = 'Lossless'
    tone = 'success'
  } else if ((track.bitrate || 0) >= 320000) {
    badge = 'High'
    tone = 'warning'
  } else if (track.bitrate) {
    badge = 'Lossy'
    tone = 'muted'
  }

  return { badge, tone, format, rate, depth, bitrate, source }
})

const lyricsSourceLabel = computed(() => lyricSourceText(props.currentTrack?.lyricsSource))
const translatedLyricsSourceLabel = computed(() =>
  lyricSourceText(props.currentTrack?.translatedLyricsSource)
)
const hasLyrics = computed(() => Boolean(props.currentTrack?.lyrics?.trim()))
const hasTranslatedLyrics = computed(() => Boolean(props.currentTrack?.translatedLyrics?.trim()))

function lyricSourceText(source: LyricSource | null | undefined): string {
  if (source === 'embedded') return '内嵌'
  if (source === 'local') return '本地 LRC'
  if (source === 'provider') return '在线 Provider'
  if (source === 'amll') return 'AMLL TTML'
  return '未加载'
}

function deviceSpecText(device: AudioDeviceOption): string {
  const rates = device.sampleRates?.filter((rate) => rate > 0) ?? []
  const depths = device.bitDepths?.filter((depth) => depth > 0) ?? []
  const rateText =
    rates.length > 0
      ? `${Math.round(Math.min(...rates) / 100) / 10}-${Math.round(Math.max(...rates) / 100) / 10} kHz`
      : ''
  const depthText = depths.length > 0 ? `${Math.min(...depths)}-${Math.max(...depths)} bit` : ''
  const channels = device.channels && device.channels > 0 ? `${device.channels} ch` : ''
  return [device.backend?.toUpperCase(), rateText, depthText, channels].filter(Boolean).join(' · ')
}

function deviceIcon(device: AudioDeviceOption): string {
  const text = `${device.label} ${device.name || ''} ${device.driverName || ''}`.toLowerCase()
  if (/usb|dac|asio|hifi|exclusive/.test(text)) return 'ph ph-cpu'
  if (/headphone|headset|ear/.test(text)) return 'ph ph-headphones'
  if (/hdmi|display|tv|monitor/.test(text)) return 'ph ph-monitor'
  return 'ph ph-speaker-high'
}

function onCrossfeedInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('setCrossfeedStrength', Math.min(1, Math.max(0, value / 100)))
}

function onCrossfadeInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('setCrossfadeSeconds', Math.min(12, Math.max(0, value)))
}

function onPreampInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('setReplayGainPreamp', Math.min(12, Math.max(-12, value)))
}

function onBufferChange(event: Event): void {
  emit('setPreferredBufferSize', Number((event.target as HTMLSelectElement).value))
}

function onRoutingChange(event: Event): void {
  emit('setRoutingMode', (event.target as HTMLSelectElement).value as ChannelRoutingMode)
}

function onPcmToDsdModeChange(event: Event): void {
  emit(
    'setPcmToDsdMode',
    (event.target as HTMLSelectElement).value as import('../../types/settings').PcmToDsdMode
  )
}

function onDsdModeChange(event: Event): void {
  emit('setDsdOutputMode', (event.target as HTMLSelectElement).value as DsdOutputMode)
}

function onReplayGainChange(event: Event): void {
  emit('setReplayGainMode', (event.target as HTMLSelectElement).value as VolumeNormalizationMode)
}

function onTargetSampleRateChange(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value
  const targetSampleRate = raw === 'device' ? 'device' : Number(raw)
  emit('setOutputStage', { targetSampleRate })
}

function onResamplerChange(event: Event): void {
  emit('setOutputStage', {
    resamplerQuality: (event.target as HTMLSelectElement).value as DspResamplerQuality
  })
}

function onDitherChange(event: Event): void {
  emit('setOutputStage', {
    dither: (event.target as HTMLSelectElement).value as DspDitherMode
  })
}

function onBalanceInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('setStereoImage', { balance: Math.min(1, Math.max(-1, value / 100)) })
}

function onWidthInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('setStereoImage', { width: Math.min(2, Math.max(0, value / 100)) })
}

function toggleInvertLeft(): void {
  emit('setStereoImage', { invertLeft: !props.dspStereoImage.invertLeft })
}

function toggleInvertRight(): void {
  emit('setStereoImage', { invertRight: !props.dspStereoImage.invertRight })
}

function resetStereoImage(): void {
  emit('setStereoImage', {
    balance: 0,
    width: 1,
    midGainDb: 0,
    sideGainDb: 0,
    invertLeft: false,
    invertRight: false,
    swap: false,
    mono: false
  })
}

/* ===== Signal Deck 展示层 ===== */

const deckRateValue = computed(() => {
  const rate = props.currentTrack?.sampleRate
  if (!rate || !Number.isFinite(rate) || rate <= 0) return '--.-'
  return (Math.round(rate / 100) / 10).toFixed(1)
})

const deckTrackLine = computed(() => {
  const track = props.currentTrack
  if (!track) return 'NO SIGNAL'
  const title = track.title?.trim() || track.fileName || 'Unknown'
  const artist = track.artist?.trim()
  return artist ? `${title} — ${artist}` : title
})

const deckLiveTone = computed<StatusTone>(() => {
  if (!props.currentTrack) return 'muted'
  return props.nonPerfectReason ? 'warning' : 'success'
})

const deckOutNodeSub = computed(() => {
  const backend = selectedDevice.value?.backend?.toUpperCase() || 'OUTPUT'
  return `${backend} · ${props.exclusiveMode ? 'EXCLUSIVE' : 'SHARED'}`
})

const deckAccentVars = computed(() => {
  const color = props.accentColor?.trim()
  return color ? { '--d-accent-src': color } : undefined
})
</script>

<template>
  <div class="deck" :class="{ 'deck-dark': glass }" :style="deckAccentVars">
    <section class="deck-display">
      <div class="deck-display-head">
        <span class="deck-display-now">NOW DECODING</span>
        <span class="deck-display-track" :title="deckTrackLine">{{ deckTrackLine }}</span>
      </div>
      <div class="deck-display-body">
        <div class="deck-display-rate">
          <span class="deck-rate-num">{{ deckRateValue }}</span>
          <span class="deck-rate-unit">kHz</span>
        </div>
        <div class="deck-display-meta">
          <span class="deck-format-plate">{{ sourceQuality.format }}</span>
          <span class="deck-tier" :data-tone="sourceQuality.tone">{{ sourceQuality.badge }}</span>
          <span class="deck-display-sub"
            >{{ sourceQuality.depth }} · {{ sourceQuality.bitrate }}</span
          >
          <span class="deck-display-sub dim">{{ sourceQuality.source }}</span>
        </div>
      </div>
    </section>

    <div class="deck-main">
      <nav class="deck-rail" aria-label="HiFi 分区">
        <button
          v-for="tab in sectionTabs"
          :key="tab.id"
          type="button"
          class="deck-rail-btn"
          :class="{ active: activeSection === tab.id }"
          :aria-pressed="activeSection === tab.id"
          @click="activeSection = tab.id"
        >
          <i class="ph" :class="tab.icon"></i>
          <span>{{ tab.label }}</span>
        </button>
        <div class="deck-rail-spacer"></div>
        <button
          type="button"
          class="deck-rail-btn utility"
          title="播放设置"
          @click="emit('openSettings')"
        >
          <i class="ph ph-gear-six"></i>
          <span>设置</span>
        </button>
      </nav>

      <div class="deck-content">
        <Transition name="deck-fade" mode="out-in">
          <!-- 链路 -->
          <section v-if="activeSection === 'console'" key="console" class="deck-stack">
            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>01</em>SIGNAL PATH</span>
                <span class="deck-card-hint">实时链路</span>
              </div>

              <div class="deck-flow">
                <div class="deck-node" data-tone="success">
                  <span class="deck-node-led"></span>
                  <strong>SRC</strong>
                  <em>{{ sourceQuality.format }} · {{ sourceQuality.depth }}</em>
                </div>
                <div class="deck-flow-link" :class="{ active: Boolean(currentTrack) }"></div>
                <div class="deck-node" :data-tone="dspMasterOn ? 'warning' : 'muted'">
                  <span class="deck-node-led"></span>
                  <strong>DSP</strong>
                  <em>{{ dspMasterOn ? 'ENGAGED' : 'BYPASS' }}</em>
                </div>
                <div class="deck-flow-link" :class="{ active: Boolean(currentTrack) }"></div>
                <div class="deck-node" :data-tone="deckLiveTone">
                  <span class="deck-node-led"></span>
                  <strong>OUT</strong>
                  <em>{{ deckOutNodeSub }}</em>
                </div>
              </div>

              <div class="deck-chip-row">
                <span
                  v-for="chip in statusChips"
                  :key="chip.label"
                  class="deck-chip"
                  :data-tone="chip.tone || 'muted'"
                  :title="chip.title || chip.label"
                >
                  {{ chip.label }}
                </span>
              </div>

              <p v-if="outputChainText" class="deck-readout" :title="outputChainText">
                {{ outputChainText }}
              </p>
              <p v-if="nonPerfectReason" class="deck-note warn">{{ nonPerfectReason }}</p>
              <p v-if="perfectReasonExplain" class="deck-note">{{ perfectReasonExplain }}</p>
              <p v-if="perfectReasonFix" class="deck-note fix">
                <i class="pi pi-wrench" aria-hidden="true"></i> {{ perfectReasonFix }}
              </p>
              <p
                v-if="perfectReasonEngineDetail"
                class="deck-note engine-detail"
                :title="perfectReasonEngineDetail"
              >
                {{ perfectReasonEngineDetail }}
              </p>

              <div v-if="showUnityVolumeCta" class="deck-unity">
                <div class="deck-unity-copy">
                  <strong>UNITY 音量</strong>
                  <em>
                    {{
                      perfectReasonCode === 'volume_not_unity'
                        ? `${HIFI_STATUS_COPY.volumeNotUnity}，bit-perfect 需要 Unity`
                        : `当前 ${Math.round(volume * 100)}%；${HIFI_STATUS_COPY.volumeNotUnityHint}`
                    }}
                  </em>
                </div>
                <button
                  type="button"
                  class="deck-btn"
                  :class="{ accent: perfectReasonCode === 'volume_not_unity' }"
                  :disabled="isVolumeUnity"
                  @click="emit('setUnityVolume')"
                >
                  {{ HIFI_STATUS_COPY.unityButton }}
                </button>
              </div>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>02</em>TELEMETRY</span>
                <span class="deck-card-hint">延迟 · 诊断</span>
              </div>
              <div class="deck-meter-grid">
                <div class="deck-meter">
                  <span>LATENCY</span>
                  <strong>{{ outputLatencyText.replace(/^Latency\s*/, '') }}</strong>
                </div>
                <div class="deck-meter">
                  <span>DIAGNOSTICS</span>
                  <strong>{{ outputDiagnosticsText }}</strong>
                </div>
              </div>
              <p v-if="nativeDsdRuntimeReasonText" class="deck-note">
                {{ nativeDsdRuntimeReasonText }}
              </p>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>03</em>SOURCE</span>
                <span class="deck-chip" :data-tone="sourceQuality.tone">{{
                  sourceQuality.badge
                }}</span>
              </div>
              <div class="deck-spec-grid">
                <div class="deck-spec">
                  <span>格式</span>
                  <strong>{{ sourceQuality.format }}</strong>
                </div>
                <div class="deck-spec">
                  <span>采样率</span>
                  <strong>{{ sourceQuality.rate }}</strong>
                </div>
                <div class="deck-spec">
                  <span>位深</span>
                  <strong>{{ sourceQuality.depth }}</strong>
                </div>
                <div class="deck-spec">
                  <span>码率</span>
                  <strong>{{ sourceQuality.bitrate }}</strong>
                </div>
              </div>
              <p class="deck-note">来源 · {{ sourceQuality.source }}</p>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>04</em>ENGINE</span>
                <span class="deck-card-hint">快捷开关</span>
              </div>
              <div class="deck-toggles">
                <button
                  type="button"
                  class="deck-toggle"
                  :class="{ on: exclusiveMode }"
                  :disabled="!exclusiveAvailable"
                  @click="emit('toggleExclusive')"
                >
                  <span class="deck-led"></span>
                  <i class="ph ph-lock-key"></i>
                  <span class="deck-toggle-name">Exclusive</span>
                  <em>{{ exclusiveMode ? 'ON' : 'OFF' }}</em>
                </button>
                <button
                  type="button"
                  class="deck-toggle"
                  :class="{ on: audioProcessing.gapless }"
                  @click="emit('toggleGapless')"
                >
                  <span class="deck-led"></span>
                  <i class="ph ph-arrows-merge"></i>
                  <span class="deck-toggle-name">Gapless</span>
                  <em>{{ audioProcessing.gapless ? 'ON' : 'OFF' }}</em>
                </button>
                <button
                  type="button"
                  class="deck-toggle"
                  :class="{ on: audioProcessing.clipGuard }"
                  @click="emit('toggleClipGuard')"
                >
                  <span class="deck-led"></span>
                  <i class="ph ph-shield-check"></i>
                  <span class="deck-toggle-name">Clip Guard</span>
                  <em>{{ audioProcessing.clipGuard ? 'ON' : 'OFF' }}</em>
                </button>
                <button
                  type="button"
                  class="deck-toggle"
                  :class="{ on: dspMasterOn }"
                  @click="emit('toggleDsp')"
                >
                  <span class="deck-led"></span>
                  <i class="ph ph-circuitry"></i>
                  <span class="deck-toggle-name">Master DSP</span>
                  <em>{{ dspMasterOn ? 'ON' : 'OFF' }}</em>
                </button>
              </div>
              <div class="deck-gapless" :data-tone="gaplessStatusTone">
                <span
                  v-if="audioProcessing.gapless && gaplessActive"
                  class="deck-chip"
                  data-tone="success"
                  >Active</span
                >
                <span
                  v-if="audioProcessing.gapless && preloadReady"
                  class="deck-chip"
                  data-tone="success"
                  >Preload</span
                >
                <span
                  v-if="audioProcessing.gapless && gaplessBlockedReason"
                  class="deck-chip"
                  data-tone="warning"
                  >Blocked</span
                >
                <p class="deck-note">{{ gaplessStatusText }}</p>
              </div>
              <p class="deck-note">{{ HIFI_STATUS_COPY.gaplessNote }}</p>
            </section>

            <section class="deck-card deck-actions">
              <button type="button" class="deck-action" @click="emit('openSettings')">
                <i class="ph ph-gear-six"></i>
                <span>
                  <strong>播放设置</strong>
                  <em>输出 · 缓存</em>
                </span>
              </button>
              <button type="button" class="deck-action accent" @click="emit('openEqualizer')">
                <i class="ph ph-faders"></i>
                <span>
                  <strong>均衡器</strong>
                  <em>完整 EQ 页</em>
                </span>
              </button>
              <button type="button" class="deck-action" @click="emit('openDsp')">
                <i class="ph ph-sliders-horizontal"></i>
                <span>
                  <strong>DSP 工作台</strong>
                  <em>空间 · 解码</em>
                </span>
              </button>
            </section>
          </section>

          <!-- 输出 -->
          <section v-else-if="activeSection === 'output'" key="output" class="deck-stack">
            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>01</em>BACKEND</span>
                <span class="deck-card-hint">输出后端</span>
              </div>
              <div class="deck-segmented">
                <button
                  v-for="option in audioOutputOptions"
                  :key="option.id"
                  type="button"
                  :class="{ active: audioOutput === option.id }"
                  @click="emit('setAudioOutput', option.id)"
                >
                  {{ option.label }}
                </button>
              </div>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>02</em>DEVICES</span>
                <button type="button" class="deck-link" @click="emit('refreshDevices')">
                  <i class="ph ph-arrows-clockwise"></i>刷新
                </button>
              </div>
              <div class="deck-devices">
                <button
                  v-for="device in audioDeviceOptions"
                  :key="device.id"
                  type="button"
                  class="deck-device"
                  :class="{ active: audioDevice === device.id }"
                  @click="emit('setAudioDevice', device.id)"
                >
                  <i :class="deviceIcon(device)"></i>
                  <div class="deck-device-copy">
                    <strong>{{ device.label }}</strong>
                    <span>{{ deviceSpecText(device) || '系统默认路径' }}</span>
                  </div>
                  <em v-if="audioDevice === device.id">当前</em>
                </button>
              </div>
              <p v-if="selectedDevice" class="deck-note">当前设备 · {{ selectedDevice.label }}</p>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>03</em>ENGINE PARAMS</span>
                <span class="deck-card-hint">缓冲 / 路由 / 交叉淡入</span>
              </div>
              <div class="deck-toggles">
                <button
                  type="button"
                  class="deck-toggle"
                  :class="{ on: exclusiveMode }"
                  :disabled="!exclusiveAvailable"
                  @click="emit('toggleExclusive')"
                >
                  <span class="deck-led"></span>
                  <i class="ph ph-lock-key"></i>
                  <span class="deck-toggle-name">Exclusive</span>
                  <em>{{ exclusiveMode ? 'ON' : 'OFF' }}</em>
                </button>
                <button
                  type="button"
                  class="deck-toggle"
                  :class="{ on: audioProcessing.gapless }"
                  @click="emit('toggleGapless')"
                >
                  <span class="deck-led"></span>
                  <i class="ph ph-arrows-merge"></i>
                  <span class="deck-toggle-name">Gapless</span>
                  <em>{{ audioProcessing.gapless ? 'ON' : 'OFF' }}</em>
                </button>
              </div>
              <div class="deck-control">
                <div class="deck-control-head">
                  <span>Crossfade</span>
                  <strong>{{ crossfadeSeconds.toFixed(1) }} s</strong>
                </div>
                <input
                  class="deck-range"
                  type="range"
                  min="0"
                  max="12"
                  step="0.5"
                  :value="crossfadeSeconds"
                  :style="{ '--range-value': `${(crossfadeSeconds / 12) * 100}%` }"
                  @input="onCrossfadeInput"
                />
              </div>
              <div class="deck-field-row">
                <label class="deck-field">
                  <span>Buffer</span>
                  <select
                    class="deck-select"
                    :value="audioOutputConfig.preferredBufferSize"
                    @change="onBufferChange"
                  >
                    <option
                      v-for="option in bufferSizeOptions"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <label class="deck-field">
                  <span>Routing</span>
                  <select
                    class="deck-select"
                    :value="audioOutputConfig.routingMode"
                    @change="onRoutingChange"
                  >
                    <option
                      v-for="option in routingModeOptions"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </label>
              </div>
              <label class="deck-field">
                <span>PCM → DSD</span>
                <select
                  class="deck-select"
                  :value="audioOutputConfig.pcmToDsdMode ?? 'off'"
                  @change="onPcmToDsdModeChange"
                >
                  <option
                    v-for="option in pcmToDsdModeOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
              </label>
              <label class="deck-field">
                <span>DSD Mode</span>
                <select
                  class="deck-select"
                  :value="audioProcessing.dsdOutputMode"
                  @change="onDsdModeChange"
                >
                  <option
                    v-for="option in dsdOutputModeOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
              </label>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>04</em>OUTPUT STAGE</span>
                <span class="deck-card-hint">采样率锁 · SRC · dither</span>
              </div>
              <p class="deck-readout" :title="outputStageHint">{{ outputStageHint }}</p>
              <div class="deck-field-row">
                <label class="deck-field">
                  <span>Target Rate</span>
                  <select
                    class="deck-select"
                    :value="String(dspOutputStage.targetSampleRate)"
                    @change="onTargetSampleRateChange"
                  >
                    <option
                      v-for="option in sampleRateOptions"
                      :key="String(option.value)"
                      :value="String(option.value)"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <label class="deck-field">
                  <span>Resampler</span>
                  <select
                    class="deck-select"
                    :value="dspOutputStage.resamplerQuality"
                    @change="onResamplerChange"
                  >
                    <option
                      v-for="option in resamplerOptions"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </label>
              </div>
              <label class="deck-field">
                <span>Dither</span>
                <select class="deck-select" :value="dspOutputStage.dither" @change="onDitherChange">
                  <option v-for="option in ditherOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>
              <p v-if="outputStageActive" class="deck-note warn">
                采样率锁 / SRC / dither 启用时 outputPerfect=false（graph.outputStage，非
                OutputConfig）。
              </p>
            </section>
          </section>

          <!-- DSP -->
          <section v-else-if="activeSection === 'dsp'" key="dsp" class="deck-stack">
            <section class="deck-card">
              <div class="deck-master">
                <div class="deck-master-copy">
                  <span class="deck-led" :class="{ on: dspMasterOn }"></span>
                  <div>
                    <strong>Master DSP</strong>
                    <span>{{ dspMasterOn ? '处理链已启用' : '旁路 · 样本直通优先' }}</span>
                  </div>
                </div>
                <button
                  type="button"
                  class="deck-switch"
                  :class="{ active: dspMasterOn }"
                  role="switch"
                  :aria-checked="dspMasterOn"
                  @click="emit('toggleDsp')"
                >
                  <span class="deck-switch-knob"></span>
                </button>
              </div>

              <div class="deck-modules" :class="{ dim: !dspMasterOn }">
                <div class="deck-module-row">
                  <div class="deck-module-copy">
                    <strong>Equalizer</strong>
                    <span>{{ eqSummary }}</span>
                  </div>
                  <div class="deck-module-actions">
                    <button type="button" class="deck-btn" @click="emit('openEqualizer')">
                      打开 EQ
                    </button>
                    <button
                      type="button"
                      class="deck-switch"
                      :class="{ active: eqOn }"
                      role="switch"
                      :aria-checked="eqOn"
                      @click="emit('toggleEq')"
                    >
                      <span class="deck-switch-knob"></span>
                    </button>
                  </div>
                </div>

                <div class="deck-module-row">
                  <div class="deck-module-copy">
                    <strong>Crossfeed</strong>
                    <span>耳机串音 · {{ crossfeedPercent }}%</span>
                  </div>
                  <button
                    type="button"
                    class="deck-switch"
                    :class="{ active: crossfeedOn }"
                    role="switch"
                    :aria-checked="crossfeedOn"
                    @click="emit('toggleCrossfeed')"
                  >
                    <span class="deck-switch-knob"></span>
                  </button>
                </div>
                <div class="deck-control compact">
                  <input
                    class="deck-range"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    :value="crossfeedPercent"
                    :style="{ '--range-value': `${crossfeedPercent}%` }"
                    @input="onCrossfeedInput"
                  />
                </div>

                <div class="deck-module-row">
                  <div class="deck-module-copy">
                    <strong>Convolver</strong>
                    <span>{{ convolverPathLabel }}</span>
                  </div>
                  <div class="deck-module-actions">
                    <button type="button" class="deck-btn" @click="emit('selectImpulseResponse')">
                      IR
                    </button>
                    <button
                      v-if="audioProcessing.convolverIrPath"
                      type="button"
                      class="deck-btn ghost"
                      @click="emit('clearImpulseResponse')"
                    >
                      清除
                    </button>
                    <button
                      type="button"
                      class="deck-switch"
                      :class="{ active: convolverOn }"
                      role="switch"
                      :aria-checked="convolverOn"
                      @click="emit('toggleConvolver')"
                    >
                      <span class="deck-switch-knob"></span>
                    </button>
                  </div>
                </div>

                <div class="deck-field-row">
                  <label class="deck-field">
                    <span>ReplayGain</span>
                    <select
                      class="deck-select"
                      :value="audioProcessing.volumeNormalization"
                      @change="onReplayGainChange"
                    >
                      <option
                        v-for="option in replayGainOptions"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                  <label class="deck-field">
                    <span>Clip Guard</span>
                    <button
                      type="button"
                      class="deck-inline-toggle"
                      :class="{ on: audioProcessing.clipGuard }"
                      @click="emit('toggleClipGuard')"
                    >
                      <span class="deck-led"></span>
                      {{ audioProcessing.clipGuard ? '已开启' : '已关闭' }}
                    </button>
                  </label>
                </div>

                <p v-if="loudnormStatusText" class="deck-note" :data-tone="loudnormStatusTone">
                  {{ loudnormStatusText }}
                </p>

                <div class="deck-control">
                  <div class="deck-control-head">
                    <span>RG Preamp</span>
                    <strong>{{ replayGainPreamp.toFixed(1) }} dB</strong>
                  </div>
                  <input
                    class="deck-range"
                    type="range"
                    min="-12"
                    max="12"
                    step="0.1"
                    :value="replayGainPreamp"
                    :style="{ '--range-value': `${((replayGainPreamp + 12) / 24) * 100}%` }"
                    @input="onPreampInput"
                  />
                </div>

                <div class="deck-module-row">
                  <div class="deck-module-copy">
                    <strong>Balance / Phase</strong>
                    <span>{{ stereoImageHint }}</span>
                  </div>
                  <button
                    v-if="stereoImageActive"
                    type="button"
                    class="deck-btn ghost"
                    @click="resetStereoImage"
                  >
                    复位
                  </button>
                </div>
                <div class="deck-control compact">
                  <div class="deck-control-head">
                    <span>Balance</span>
                    <strong>{{
                      balancePercent === 0
                        ? 'C'
                        : balancePercent > 0
                          ? `R${balancePercent}`
                          : `L${Math.abs(balancePercent)}`
                    }}</strong>
                  </div>
                  <input
                    class="deck-range"
                    type="range"
                    min="-100"
                    max="100"
                    step="1"
                    :value="balancePercent"
                    :style="{ '--range-value': `${((balancePercent + 100) / 200) * 100}%` }"
                    @input="onBalanceInput"
                  />
                </div>
                <div class="deck-control compact">
                  <div class="deck-control-head">
                    <span>Width</span>
                    <strong>{{ widthPercent }}%</strong>
                  </div>
                  <input
                    class="deck-range"
                    type="range"
                    min="0"
                    max="200"
                    step="1"
                    :value="widthPercent"
                    :style="{ '--range-value': `${(widthPercent / 200) * 100}%` }"
                    @input="onWidthInput"
                  />
                </div>
                <div class="deck-toggles">
                  <button
                    type="button"
                    class="deck-toggle"
                    :class="{ on: dspStereoImage.invertLeft }"
                    @click="toggleInvertLeft"
                  >
                    <span class="deck-led"></span>
                    <i class="ph ph-arrows-left-right"></i>
                    <span class="deck-toggle-name">L Phase</span>
                    <em>{{ dspStereoImage.invertLeft ? 'INV' : 'OK' }}</em>
                  </button>
                  <button
                    type="button"
                    class="deck-toggle"
                    :class="{ on: dspStereoImage.invertRight }"
                    @click="toggleInvertRight"
                  >
                    <span class="deck-led"></span>
                    <i class="ph ph-arrows-left-right"></i>
                    <span class="deck-toggle-name">R Phase</span>
                    <em>{{ dspStereoImage.invertRight ? 'INV' : 'OK' }}</em>
                  </button>
                </div>
                <p v-if="stereoImageActive" class="deck-note warn">
                  平衡 / 宽度 / 相位写入 graph stereoField + channelStrip，会关闭 outputPerfect。
                </p>
              </div>
            </section>

            <section class="deck-card deck-actions">
              <button type="button" class="deck-action accent" @click="emit('openEqualizer')">
                <i class="ph ph-faders"></i>
                <span>
                  <strong>进入 EQ 页面</strong>
                  <em>图形 / 参数均衡</em>
                </span>
              </button>
              <button type="button" class="deck-action" @click="emit('openDsp')">
                <i class="ph ph-sliders-horizontal"></i>
                <span>
                  <strong>完整 DSP 设置</strong>
                  <em>高级参数</em>
                </span>
              </button>
            </section>
          </section>

          <!-- 工具 -->
          <section v-else-if="activeSection === 'tools'" key="tools" class="deck-stack">
            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>01</em>SLEEP TIMER</span>
                <span class="deck-card-hint">定时停止</span>
              </div>
              <label class="deck-field">
                <span>模式</span>
                <select
                  class="deck-select"
                  :value="sleepTimerSelectValue || 'off'"
                  title="睡眠定时器"
                  @change="onSleepTimerChange"
                >
                  <option value="off">睡眠关闭</option>
                  <option
                    v-if="![15, 30, 60].includes(sleepDefaultMinutes)"
                    :value="String(sleepDefaultMinutes)"
                  >
                    {{ sleepDefaultMinutes }} 分钟后停止
                  </option>
                  <option value="15">15 分钟后停止</option>
                  <option value="30">30 分钟后停止</option>
                  <option value="60">60 分钟后停止</option>
                  <option value="trackEnd">当前曲结束</option>
                  <option value="queueEnd">队列结束</option>
                </select>
              </label>
              <p v-if="sleepTimerStatus" class="deck-note" :title="sleepTimerStatus">
                {{ sleepTimerStatus }}
              </p>
              <p v-else class="deck-note">关闭后保持播放；可选分钟数或曲末 / 队列末停止。</p>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>02</em>PLAYBACK RATE</span>
                <span class="deck-card-hint">倍速</span>
              </div>
              <div class="deck-module-row">
                <div class="deck-module-copy">
                  <strong class="deck-mono">{{ playbackRateLabel || '1.0x' }}</strong>
                  <span>{{ playbackRateTitle || '播放倍速' }}</span>
                </div>
                <button
                  type="button"
                  class="deck-btn"
                  :class="{ accent: rateActive }"
                  :title="playbackRateTitle || '播放倍速'"
                  :aria-label="playbackRateTitle || '播放倍速'"
                  @click="emit('cyclePlaybackRate')"
                >
                  切换
                </button>
              </div>
              <p class="deck-note">
                循环切换 0.75x → 1x → 1.25x → 1.5x → 2x。非 1x 会关闭 bit-perfect。
              </p>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>03</em>A-B LOOP</span>
                <span class="deck-card-hint">区间循环</span>
              </div>
              <div class="deck-module-row">
                <div class="deck-module-copy">
                  <strong>
                    {{
                      abLoopActive
                        ? '循环中'
                        : abLoopPartial
                          ? '已设起点 A'
                          : isLiveStream
                            ? '不可用'
                            : '未设置'
                    }}
                  </strong>
                  <span>{{ abLoopTitle || 'A-B 循环' }}</span>
                </div>
                <div class="deck-module-actions">
                  <button
                    type="button"
                    class="deck-btn"
                    :class="{ accent: abLoopActive, ghost: abLoopPartial }"
                    :disabled="isLiveStream"
                    :title="abLoopTitle || 'A-B 循环'"
                    :aria-label="abLoopTitle || 'A-B 循环'"
                    @click="emit('toggleAbLoop')"
                  >
                    A-B
                  </button>
                  <button
                    type="button"
                    class="deck-btn ghost"
                    :disabled="isLiveStream || (abLoopA == null && abLoopB == null)"
                    title="清除 A-B 循环"
                    @click="emit('clearAbLoop')"
                  >
                    清除
                  </button>
                </div>
              </div>
              <p class="deck-note">
                第一次点击设起点，第二次设终点并进入循环；可随时清除。直播流不支持。
              </p>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>04</em>CAST / DLNA</span>
                <span class="deck-card-hint">投送到设备</span>
              </div>
              <div class="deck-module-row">
                <div class="deck-module-copy">
                  <strong>{{ castTargetName || '未投送' }}</strong>
                  <span>{{ canCastCurrentTrack ? '当前曲目可投送' : '当前曲目不可投送' }}</span>
                </div>
                <div class="deck-module-actions">
                  <button
                    type="button"
                    class="deck-btn"
                    :disabled="castBusy"
                    title="刷新设备列表"
                    @click="emit('refreshCastDevices')"
                  >
                    {{ castBusy ? '搜索中…' : '刷新' }}
                  </button>
                  <button
                    v-if="castTargetName"
                    type="button"
                    class="deck-btn ghost"
                    :disabled="castBusy"
                    title="停止投送"
                    @click="emit('stopCast')"
                  >
                    停止
                  </button>
                </div>
              </div>
              <p v-if="castBusy" class="deck-note">正在搜索设备…</p>
              <p v-else-if="castDeviceList.length === 0" class="deck-note">
                未发现投送设备（DLNA / Chromecast）。请确认设备在线且本机已开启远程控制服务。
              </p>
              <ul v-else class="deck-cast-list">
                <li v-for="device in castDeviceList" :key="device.usn">
                  <button
                    type="button"
                    class="deck-cast-item"
                    :disabled="
                      castBusy ||
                      !canCastCurrentTrack ||
                      (device.protocol !== 'chromecast' && !device.avTransportUrl)
                    "
                    @click="emit('castToDevice', device.usn)"
                  >
                    <i class="ph ph-broadcast"></i>
                    <span class="deck-cast-name">{{ device.friendlyName }}</span>
                    <span class="deck-cast-meta">
                      {{
                        device.protocol === 'chromecast'
                          ? 'Chromecast'
                          : device.manufacturer || device.modelName || 'DLNA'
                      }}
                    </span>
                  </button>
                </li>
              </ul>
              <p v-if="castError" class="deck-note warn">{{ castError }}</p>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>05</em>BOOKMARKS</span>
                <span class="deck-card-hint">书签</span>
              </div>
              <div class="deck-module-row">
                <div class="deck-module-copy">
                  <strong>{{ bookmarkList.length }} 个书签</strong>
                  <span>{{ isLiveStream ? '直播流不支持书签' : '当前曲目' }}</span>
                </div>
                <button
                  type="button"
                  class="deck-btn"
                  :disabled="isLiveStream"
                  title="在当前时间添加书签"
                  @click="emit('addBookmark')"
                >
                  添加
                </button>
              </div>
              <p v-if="bookmarkList.length === 0" class="deck-note">
                {{ isLiveStream ? '直播流不支持书签' : '暂无书签，点击右侧「添加」标记当前位置' }}
              </p>
              <ul v-else class="deck-bookmark-list">
                <li v-for="bm in bookmarkList" :key="bm.id" class="deck-bookmark-item">
                  <button
                    type="button"
                    class="deck-bookmark-jump"
                    @click="emit('jumpBookmark', bm)"
                  >
                    <span class="deck-bookmark-time">{{
                      formatBookmarkTime(bm.positionSeconds)
                    }}</span>
                    <template v-if="renamingBookmarkId === bm.id">
                      <input
                        v-model="renameDraftValue"
                        class="deck-bookmark-rename"
                        type="text"
                        maxlength="120"
                        @click.stop
                        @keydown.enter.prevent="emit('commitRenameBookmark')"
                        @keydown.esc.prevent="emit('cancelRenameBookmark')"
                      />
                    </template>
                    <span v-else class="deck-bookmark-label">{{ bm.label }}</span>
                    <span v-if="bm.kind === 'resume'" class="deck-bookmark-kind">续播</span>
                  </button>
                  <div class="deck-module-actions">
                    <button
                      v-if="renamingBookmarkId === bm.id"
                      type="button"
                      class="deck-btn"
                      @click="emit('commitRenameBookmark')"
                    >
                      保存
                    </button>
                    <button
                      v-else
                      type="button"
                      class="deck-btn ghost"
                      @click="emit('startRenameBookmark', bm)"
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      class="deck-btn ghost"
                      @click="emit('deleteBookmark', bm.id)"
                    >
                      删除
                    </button>
                  </div>
                </li>
              </ul>
            </section>
          </section>

          <!-- 歌词 -->
          <section v-else-if="activeSection === 'lyrics'" key="lyrics" class="deck-stack">
            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>01</em>LYRICS SOURCE</span>
                <span class="deck-card-hint">当前曲目</span>
              </div>
              <div class="deck-spec-grid duo">
                <div class="deck-spec">
                  <span>原文</span>
                  <strong>{{ hasLyrics ? lyricsSourceLabel : '无' }}</strong>
                </div>
                <div class="deck-spec">
                  <span>翻译</span>
                  <strong>{{ hasTranslatedLyrics ? translatedLyricsSourceLabel : '无' }}</strong>
                </div>
              </div>
              <div class="deck-lyric-source-controls" aria-label="歌词来源">
                <label>
                  <span>原文</span>
                  <select
                    :value="originalLayerSelection"
                    :disabled="!currentTrack || lyricControlsPending"
                    aria-label="原文歌词来源"
                    @change="onLyricLayerSelectionChange('originalSelection', $event)"
                  >
                    <option value="automatic">自动</option>
                    <option value="local">本地</option>
                    <option value="amll">AMLL TTML</option>
                    <option value="provider">Provider</option>
                    <option value="manual">手写</option>
                  </select>
                </label>
                <label>
                  <span>翻译</span>
                  <select
                    :value="translationLayerSelection"
                    :disabled="!currentTrack || lyricControlsPending"
                    aria-label="翻译歌词来源"
                    @change="onLyricLayerSelectionChange('translationSelection', $event)"
                  >
                    <option value="automatic">自动</option>
                    <option value="local">本地</option>
                    <option value="amll">AMLL TTML</option>
                    <option value="provider">Provider</option>
                    <option value="manual">手写</option>
                  </select>
                </label>
                <button
                  type="button"
                  class="deck-btn ghost deck-translation-toggle"
                  :aria-pressed="showTranslation"
                  :disabled="!currentTrack || lyricControlsPending"
                  @click="emit('toggleTranslationVisibility')"
                >
                  {{ showTranslation ? '隐藏翻译' : '显示翻译' }}
                </button>
              </div>
              <div class="deck-actions trio">
                <button
                  type="button"
                  class="deck-action"
                  :disabled="!currentTrack || lyricsReloading"
                  @click="emit('reloadLyrics', 'auto')"
                >
                  <i
                    :class="lyricsReloading ? 'pi pi-spin pi-spinner' : 'ph ph-arrows-clockwise'"
                  ></i>
                  <span>
                    <strong>自动匹配</strong>
                    <em>本地优先</em>
                  </span>
                </button>
                <button
                  type="button"
                  class="deck-action"
                  :disabled="!currentTrack || lyricsReloading"
                  @click="emit('reloadLyrics', 'local')"
                >
                  <i class="ph ph-folder-open"></i>
                  <span>
                    <strong>本地 LRC</strong>
                    <em>同目录文件</em>
                  </span>
                </button>
                <button
                  type="button"
                  class="deck-action"
                  :disabled="!currentTrack || lyricsReloading"
                  @click="emit('reloadLyrics', 'provider')"
                >
                  <i class="ph ph-cloud-arrow-down"></i>
                  <span>
                    <strong>在线 Provider</strong>
                    <em>插件源</em>
                  </span>
                </button>
              </div>
            </section>

            <section class="deck-card">
              <div class="deck-module-row">
                <div class="deck-module-copy">
                  <strong>桌面歌词</strong>
                  <span>{{ desktopLyricsOn ? '独立窗口已开启' : '当前关闭' }}</span>
                </div>
                <button
                  type="button"
                  class="deck-switch"
                  :class="{ active: desktopLyricsOn }"
                  role="switch"
                  :aria-checked="desktopLyricsOn"
                  @click="emit('toggleDesktopLyrics')"
                >
                  <span class="deck-switch-knob"></span>
                </button>
              </div>
              <p class="deck-note">
                歌词来源会优先使用内嵌 / 本地 LRC，缺失时再回落 Provider。重新匹配不会改动音频本身。
              </p>
            </section>

            <section class="deck-card">
              <div class="deck-card-label">
                <span><em>02</em>LYRICS MANAGER</span>
                <span class="deck-card-hint">偏移 · 导入 · 编辑</span>
              </div>
              <LyricsManagerPanel />
            </section>

            <section class="deck-card">
              <button type="button" class="deck-action full" @click="lyricsCustomizerOpen = true">
                <i class="ph ph-text-aa"></i>
                <span>
                  <strong>歌词显示样式</strong>
                  <em>字体 · 颜色 · 背景 · 高亮 · 动效</em>
                </span>
              </button>
              <button
                type="button"
                class="deck-action deck-action-secondary full"
                @click="emit('openSettings')"
              >
                <i class="ph ph-arrow-square-out"></i>
                <span>
                  <strong>打开设置页</strong>
                  <em>字号 · 对齐 · 暗度 · 桌面歌词外观</em>
                </span>
              </button>
            </section>
          </section>
        </Transition>

        <section v-if="playerBarButtons.length" class="deck-card">
          <div class="deck-card-label">
            <span><em>EX</em>EXTENSIONS</span>
            <span class="deck-card-hint">插件</span>
          </div>
          <div class="deck-extensions">
            <button
              v-for="button in playerBarButtons"
              :key="button.id"
              type="button"
              class="deck-extension"
              @click="emit('runExtension', button.command)"
            >
              <strong>{{ button.title }}</strong>
              <span>{{ button.description || '插件操作' }}</span>
            </button>
          </div>
        </section>
      </div>
    </div>
    <Teleport to="body">
      <LyricsAppearanceCustomizer
        :open="lyricsCustomizerOpen"
        @close="lyricsCustomizerOpen = false"
      />
    </Teleport>
  </div>
</template>

<style scoped src="./HiFiSidebar.css"></style>
