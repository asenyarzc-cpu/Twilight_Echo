<script setup lang="ts">
import { ref, computed, onMounted, watch, type ComponentPublicInstance } from 'vue'
import { usePlayerStore } from '../stores/usePlayerStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useMusicStore } from '../stores/useMusicStore'
import { usePlaybackBookmarks } from '../stores/playbackBookmarks'
import { useLyricsManagement } from '../stores/lyricsManagement'
import type { PlaybackBookmark } from '../../../shared/playbackBookmarks.ts'
import { useExtensionRegistry } from '../extensions/registry'
import { useMediaProviders } from '../providers'
import { normalizeAccentColor } from '../utils/colorExtractor'
import { useSmoothedValue } from '../utils/useSmoothedValue'
import { HIFI_STATUS_COPY } from '../../../shared/audioProcessingOptions.ts'
import type { LyricLayerSourceSelection } from '../../../shared/lyricsManagement.ts'
import CoverImg from './CoverImg.vue'
import HiFiSidebar from './player-bar/HiFiSidebar.vue'
import nextTrackIcon from '../assets/icons/next-track.svg'
import pauseIcon from '../assets/icons/pause.svg'
import playIcon from '../assets/icons/play.svg'
import previousTrackIcon from '../assets/icons/previous-track.svg'
import repeatIcon from '../assets/icons/single-song-repeat.svg'
import listLoopIcon from '../assets/icons/list-loop-repeat.svg'
import sequentialIcon from '../assets/icons/sequential-playback.svg'
import shuffleIcon from '../assets/icons/shuffle.svg'
import { useFavoriteButton } from './player-bar/useFavoriteButton'
import { useFloatingPanels } from './player-bar/useFloatingPanels'
import { useEscapeToClose } from '../app/useDismissLayer.ts'
import { usePlaybackQueueVirtualScroll } from './player-bar/usePlaybackQueueVirtualScroll'
import { usePlaybackQueueDrawerActions } from './player-bar/usePlaybackQueueDrawerActions'
import type {
  AudioOutputId,
  ChannelRoutingMode,
  DsdOutputMode,
  PcmToDsdMode,
  VolumeNormalizationMode
} from '../types/settings'

const props = withDefaults(
  defineProps<{
    glass?: boolean
    menuOpen?: boolean
    preview?: boolean
  }>(),
  { preview: false }
)

const {
  currentTrack,
  dominantColor,
  isPlaying,
  isStreamBuffering,
  streamNowPlaying,
  currentTime,
  duration,
  volume,
  playbackRate,
  setPlaybackRate,
  sleepTimerState,
  sleepTimerNotice,
  queue,
  queueIndex,
  playMode,
  exclusiveMode,
  audioOutput,
  audioOutputOptions,
  audioDevice,
  audioDeviceOptions,
  audioProcessing,
  audioOutputConfig,
  dspOutputStage,
  dspStereoImage,
  playbackInfo,
  loudnormStatus,
  outputInfo,
  cyclePlayMode,
  togglePlay,
  next,
  prev,
  seek,
  abLoopA,
  abLoopB,
  toggleAbLoopAtCurrentTime,
  clearAbLoop,
  refreshCurrentLyrics,
  resumeOffer,
  acceptResumeOffer,
  dismissResumeOffer,
  addManualBookmarkAtCurrentTime,
  playTrack,
  enqueueTrack,
  playNextTrack,
  removeQueueItem,
  clearQueue,
  reorderQueue,
  saveQueueAsPlaylist,
  toggleExclusiveMode,
  formatTime,
  setUnityVolume,
  configureSleepTimer,
  cancelSleepTimer,
  setAudioProcessing,
  setAudioOutputConfig,
  setAudioOutput,
  setAudioDevice,
  setOutputStage,
  setStereoImage,
  refreshAudioOutputState,
  toggleDspEnabled,
  toggleEqEnabled,
  toggleCrossfeed,
  toggleGapless,
  setReplayGainMode,
  setCrossfeedStrength,
  selectImpulseResponse,
  clearImpulseResponse,
  castTargetName,
  castToDevice,
  stopCast,
  discoverCastDevices,
  refreshCastTarget
} = usePlayerStore()

/** Destroy/recreate the whole left rail on track change (navigation remount is what fixed covers). */
const playerLeftKey = computed(
  () =>
    `pl:${currentTrack.value?.id ?? 'none'}:${currentTrack.value?.queueEntryId ?? ''}:${currentTrack.value?.cover ?? ''}`
)
const {
  playlists,
  addToPlaylist,
  removeFromPlaylist,
  createPlaylist,
  createPlaylistWithTracks,
  isFavoriteTrack,
  addFavoriteTrack,
  removeFavoriteTrack
} = useMusicStore()
const mediaProviders = useMediaProviders()

const coverRef = ref<HTMLElement | null>(null)
const playerBarShellRef = ref<HTMLElement | null>(null)
const playButtonColor = computed(() => normalizeAccentColor(dominantColor.value))
const { uiContributions, syncExtensions } = useExtensionRegistry()
const playerBarButtons = computed(() =>
  uiContributions.value.filter((contribution) => contribution.kind === 'playerBarButton')
)
const { settings } = useSettingsStore()
const lyricsManagement = useLyricsManagement()
const desktopLyricsOn = ref(settings.value.desktopLyrics.enabled)
const miniPlayerOpening = ref(false)
const lyricsReloading = ref(false)
const lyricControlsPending = ref(false)
const managedLyricOverride = computed(() => lyricsManagement.entryFor(currentTrack.value?.id ?? ''))
const originalLayerSelection = computed(() => lyricLayerSelection('originalSelection'))
const translationLayerSelection = computed(() => lyricLayerSelection('translationSelection'))
const showTranslation = computed(() => lyricsManagement.document.value.showTranslation)

async function toggleDesktopLyrics(): Promise<void> {
  const enabled = await window.api.desktopLyrics.toggle()
  desktopLyricsOn.value = enabled
}

async function openMiniPlayer(): Promise<void> {
  if (miniPlayerOpening.value) return
  miniPlayerOpening.value = true
  try {
    await window.api.miniPlayer.open()
  } catch (error) {
    console.error('[mini-player] Failed to open mini player:', error)
  } finally {
    miniPlayerOpening.value = false
  }
}

if (!props.preview) {
  window.api.desktopLyrics.onToggle((enabled: boolean) => {
    desktopLyricsOn.value = enabled
  })
  window.api.desktopLyrics.onLoadFailed?.((payload) => {
    desktopLyricsOn.value = false
    console.error('[desktop-lyrics] load failed', payload.code, payload.description)
  })
}

const emit = defineEmits<{
  clickCover: [rect: { x: number; y: number; w: number; h: number }]
  openSettings: []
  openDsp: []
  openEqualizer: []
  openArtist: []
}>()

function onArtistClick(): void {
  if (props.preview || !currentTrack.value?.artist.trim()) return
  emit('openArtist')
}

function onCoverClick(): void {
  const el = coverRef.value
  if (el) {
    const r = el.getBoundingClientRect()
    emit('clickCover', { x: r.left, y: r.top, w: r.width, h: r.height })
  } else {
    emit('clickCover', { x: 24, y: window.innerHeight - 60, w: 48, h: 48 })
  }
}

function onProgressInput(event: Event): void {
  if (isLiveStream.value) return
  const target = event.target as HTMLInputElement
  seek(Number(target.value))
}

const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2] as const

const isLiveStream = computed(() => {
  const track = currentTrack.value
  if (!track) return false
  if (track.source === 'radio') return true
  // On-demand sources (local / NCM / podcast) keep a seekable timeline even when
  // metadata duration is still 0 before the engine reports length.
  const source =
    track.source || (track.id.includes(':') ? track.id.slice(0, track.id.indexOf(':')) : 'local')
  if (source === 'local' || source === 'ncm' || source === 'podcast') return false
  if (duration.value > 0) return false
  return (
    track.duration === 0 && Boolean(track.streamUrl || /^https?:\/\//i.test(track.filePath || ''))
  )
})

/** Real DOM width (not CSS custom-prop on ::-webkit-slider-runnable-track).
 *  Chromium often skips repainting track pseudo-elements when only a custom
 *  property changes, which freezes the playbar fill until a full re-style
 *  (pause / open or close now-playing). */
const effectiveDuration = computed(() => {
  if (Number.isFinite(duration.value) && duration.value > 0) return duration.value
  const trackDuration = currentTrack.value?.duration
  if (typeof trackDuration === 'number' && Number.isFinite(trackDuration) && trackDuration > 0) {
    return trackDuration
  }
  return 0
})

const progressPercent = computed(() => {
  if (isLiveStream.value) return 100
  const total = effectiveDuration.value
  if (!Number.isFinite(total) || total <= 0) return 0
  const ratio = currentTime.value / total
  if (!Number.isFinite(ratio)) return 0
  return Math.min(100, Math.max(0, ratio * 100))
})

// Playback ticks arrive stepped (~4/s); chase them so the fill glides between
// ticks. Jumps over 2.5% (seek / track switch) snap instead of gliding.
const smoothedProgressPercent = useSmoothedValue(progressPercent, {
  tau: 160,
  snapThreshold: 2.5
})

const progressFillStyle = computed(() => ({
  width: `${Math.min(100, Math.max(0, smoothedProgressPercent.value))}%`
}))

const abLoopTitle = computed(() => {
  if (isLiveStream.value) return '直播流不支持 A-B 循环'
  if (abLoopA.value == null) return '设置 A-B 循环起点'
  if (abLoopB.value == null) return '设置 A-B 循环终点（右键清除）'
  return '清除 A-B 循环（右键也可清除）'
})

const liveBadgeLabel = computed(() => {
  if (!isLiveStream.value) return ''
  if (isStreamBuffering.value) return '缓冲中'
  if (currentTrack.value?.source === 'radio') return '电台 LIVE'
  return 'LIVE'
})

const playbackRateLabel = computed(() => {
  const rate = playbackRate.value
  return Number.isInteger(rate) ? `${rate.toFixed(1)}x` : `${rate}x`
})

const playbackRateTitle = computed(() => `播放倍速 ${playbackRate.value}x`)

function cyclePlaybackRate(): void {
  const current = playbackRate.value
  const idx = RATE_PRESETS.findIndex((r) => Math.abs(r - current) < 0.001)
  const next = RATE_PRESETS[(idx + 1) % RATE_PRESETS.length] ?? 1
  void setPlaybackRate(next)
}

const abLoopRangeStyle = computed(() => {
  const total = effectiveDuration.value || 1
  const a = Math.max(0, Math.min(abLoopA.value ?? 0, total))
  const b = Math.max(a, Math.min(abLoopB.value ?? a, total))
  return {
    left: `${(a / total) * 100}%`,
    width: `${((b - a) / total) * 100}%`
  }
})

const activeResumeOffer = computed(() => {
  const offer = resumeOffer.value
  const track = currentTrack.value
  if (!offer || !track || offer.trackId !== track.id) return null
  return offer
})

const playbackBookmarks = usePlaybackBookmarks()
const renamingBookmarkId = ref<string | null>(null)
const renameDraft = ref('')
const currentTrackBookmarks = computed(() => playbackBookmarks.bookmarksFor(currentTrack.value))

const castDevices = ref<import('../../../shared/remoteControl.ts').DlnaDeviceInfo[]>([])
const castBusy = ref(false)
const castError = ref('')
const canCastCurrentTrack = computed(() => {
  const track = currentTrack.value
  if (!track) return false
  // Local path or any stream URL (podcast / radio / provider) can cast once the
  // remote media token proxy is available in main.
  return Boolean(
    track.streamUrl || track.filePath || track.source === 'radio' || track.source === 'podcast'
  )
})

const sleepTimerSelectValue = computed(() => {
  if (!sleepTimerState.value?.active) return 'off'
  if (sleepTimerState.value.mode === 'minutes') {
    return String(settings.value.sleepTimer.defaultMinutes)
  }
  return sleepTimerState.value.mode
})

async function refreshCastDevices(): Promise<void> {
  castError.value = ''
  castBusy.value = true
  try {
    await refreshCastTarget()
    castDevices.value = await discoverCastDevices()
  } catch (err) {
    castError.value = err instanceof Error ? err.message : String(err)
  } finally {
    castBusy.value = false
  }
}

async function onCastToDevice(usn: string): Promise<void> {
  castBusy.value = true
  castError.value = ''
  try {
    await castToDevice(usn)
  } catch (err) {
    castError.value = err instanceof Error ? err.message : String(err)
  } finally {
    castBusy.value = false
  }
}

async function onStopCast(): Promise<void> {
  castBusy.value = true
  castError.value = ''
  try {
    await stopCast()
  } catch (err) {
    castError.value = err instanceof Error ? err.message : String(err)
  } finally {
    castBusy.value = false
  }
}

watch(
  () => currentTrack.value?.id,
  () => {
    renamingBookmarkId.value = null
    renameDraft.value = ''
  }
)

function onAddBookmark(): void {
  addManualBookmarkAtCurrentTime()
  void playbackBookmarks.ensureLoaded()
}

function jumpToBookmark(bookmark: PlaybackBookmark): void {
  seek(bookmark.positionSeconds)
}

function startRenameBookmark(bookmark: PlaybackBookmark): void {
  renamingBookmarkId.value = bookmark.id
  renameDraft.value = bookmark.label
}

function cancelRenameBookmark(): void {
  renamingBookmarkId.value = null
  renameDraft.value = ''
}

async function commitRenameBookmark(): Promise<void> {
  const id = renamingBookmarkId.value
  if (!id) return
  const label = renameDraft.value
  renamingBookmarkId.value = null
  renameDraft.value = ''
  try {
    await playbackBookmarks.renameBookmark(id, label)
  } catch {
    // CAS conflict: list will refresh on next open
  }
}

async function deleteBookmark(id: string): Promise<void> {
  try {
    await playbackBookmarks.removeBookmark(id)
  } catch {
    // ignore CAS conflict
  }
}

function onAcceptResume(): void {
  acceptResumeOffer()
}

function onDismissResume(): void {
  dismissResumeOffer()
}

function onVolumeInput(event: Event): void {
  const target = event.target as HTMLInputElement
  volume.value = clampVolume(Number(target.value))
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return volume.value
  return Math.min(1, Math.max(0, value))
}

function onVolumeWheel(event: WheelEvent): void {
  event.preventDefault()
  // I2: 滚轮只调音量，不再自动弹开音量抽屉（避免悬停误触弹出面板）。
  // 抽屉已打开时保持打开，便于看到滑杆反馈。
  const step = event.shiftKey ? 0.01 : 0.04
  volume.value = clampVolume(volume.value + (event.deltaY < 0 ? step : -step))
}

function onSleepTimerSelectValue(value: string): void {
  if (value === 'off') {
    cancelSleepTimer()
    return
  }
  if (value === 'trackEnd' || value === 'queueEnd') {
    configureSleepTimer(value)
    return
  }
  configureSleepTimer('minutes', Number(value))
}

const sleepTimerStatus = computed(() => {
  if (sleepTimerNotice.value) return sleepTimerNotice.value
  const state = sleepTimerState.value
  if (!state?.active) return ''
  if (state.mode === 'trackEnd') return '当前曲结束后停止'
  if (state.mode === 'queueEnd') return '队列结束后停止'
  if (!state.endsAt) return ''
  return `${Math.max(1, Math.ceil((state.endsAt - Date.now()) / 60_000))} 分钟后停止`
})

const {
  volumeOpen,
  playlistOpen,
  moreOpen,
  floatingPanelOpen,
  dismissFloatingPanels,
  toggleVolume,
  togglePlaylist,
  toggleMore
} = useFloatingPanels(playerBarShellRef)

watch(moreOpen, (open) => {
  if (open) void playbackBookmarks.ensureLoaded()
})

const {
  containerRef: playlistListRef,
  visibleItems: visibleQueueItems,
  totalHeight: queueVirtualHeight,
  translateY: queueVirtualTranslateY,
  onScroll: onQueueScroll,
  scrollToCurrent: scrollQueueToCurrent
} = usePlaybackQueueVirtualScroll(queue, queueIndex, playlistOpen)

const {
  draggedEntryId,
  getEntryIndex,
  playNext: playQueueEntryNext,
  addToTail: addQueueEntryToTail,
  remove: removeQueueEntry,
  clear: clearPlaybackQueue,
  onDragStart: onQueueDragStart,
  onDragOver: onQueueDragOver,
  onDrop: onQueueDrop,
  onDragEnd: onQueueDragEnd
} = usePlaybackQueueDrawerActions({
  queue,
  commands: {
    enqueueTrack,
    playNextTrack,
    removeQueueItem,
    clearQueue,
    reorderQueue,
    saveQueueAsPlaylist
  },
  createPlaylistWithTracks
})

function setPlaylistListRef(element: Element | ComponentPublicInstance | null): void {
  playlistListRef.value = element instanceof HTMLElement ? element : null
}

function playQueueEntry(queueEntryId: string): void {
  const index = getEntryIndex(queueEntryId)
  if (index !== -1) playTrackAt(index)
}

const queueSummaryText = computed(() => {
  const total = queue.value.length
  if (total === 0) return '暂无歌曲，从曲库或流媒体加入几首吧'
  let totalSeconds = 0
  for (const track of queue.value) {
    if (Number.isFinite(track.duration) && track.duration > 0) totalSeconds += track.duration
  }
  const position =
    queueIndex.value >= 0 && queueIndex.value < total ? `正在播放第 ${queueIndex.value + 1} 首` : ''
  const minutes = Math.round(totalSeconds / 60)
  const durationText =
    minutes < 1
      ? ''
      : minutes < 60
        ? `${minutes} 分钟`
        : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
  return [position, durationText ? `共 ${durationText}` : ''].filter(Boolean).join(' · ')
})

function dismissAllFloatingPanels(): void {
  dismissFloatingPanels()
}

useEscapeToClose(floatingPanelOpen, dismissAllFloatingPanels)

const {
  favoriteButtonVisible,
  favoriteButtonLiked,
  favoriteButtonLoading,
  favoriteButtonTitle,
  toggleFavorite
} = useFavoriteButton({
  currentTrack,
  playlists,
  mediaProviders,
  addToPlaylist,
  removeFromPlaylist,
  createPlaylist,
  isFavoriteTrack,
  addFavoriteTrack,
  removeFavoriteTrack
})

const modeLabels: Record<string, string> = {
  sequential: '顺序播放',
  listLoop: '列表循环',
  repeat: '单曲循环',
  shuffle: '随机播放'
}

const modeTitle = computed(() => modeLabels[playMode.value] ?? '')
const selectedAudioOutput = computed(() =>
  audioOutputOptions.value.find((option) => option.id === audioOutput.value)
)
const exclusiveAvailable = computed(() => selectedAudioOutput.value?.supportsExclusive ?? false)
const backendLabels: Record<string, string> = {
  wasapi: 'WASAPI Shared',
  'wasapi-exclusive': 'WASAPI Exclusive',
  asio: 'ASIO',
  coreaudio: 'CoreAudio',
  'coreaudio-exclusive': 'CoreAudio Hog',
  alsa: 'ALSA'
}
const reasonCodeLabels: Record<string, string> = {
  shared_mixer: '共享输出经过系统混音器',
  processing_active: '当前处理链正在改变样本',
  replaygain_active: 'ReplayGain 正在改变样本',
  loudnorm_active: HIFI_STATUS_COPY.loudnormActive,
  eq_active: 'EQ 正在改变样本',
  convolver_active: 'Convolver 正在改变样本',
  crossfeed_active: 'Crossfeed 正在改变声道内容',
  crossfade_active: 'Crossfade 正在改变播放连续性',
  volume_not_unity: HIFI_STATUS_COPY.volumeNotUnity,
  playback_rate_not_unity: HIFI_STATUS_COPY.playbackRateNotUnity,
  routing_changes_semantics: '声道路由或通道语义发生变化',
  hog_mode_failed: '无法获取 CoreAudio Hog Mode 独占访问',
  sample_rate_unsupported: '设备不支持请求的采样率',
  pcm_converted: 'PCM 格式或采样率发生转换',
  integer_passthrough_unavailable: '源格式与设备实际输出格式不一致，无法 PCM 直通',
  source_lossy: '源文件是有损格式，不能 Source Exact',
  source_format_differs: '源格式与输出链不一致',
  backend_not_output_perfect: '当前输出路径未声明 bit-perfect 能力',
  output_not_perfect: '当前输出链尚未验证为直通',
  visualization_inactive: '当前没有可视化采样数据',
  dsd_processing_pcm_fallback: 'DSD 因处理链启用而回退到 PCM',
  dsd_high_rate_pcm_fallback: 'DSD 因采样率或驱动限制回退到 PCM',
  dsd_converted_to_pcm: 'DSD 当前已转换为 PCM 输出',
  dsd_source_unsupported: '当前 DSD 源或模式不受支持',
  sacd_iso_unsupported: 'SACD ISO 不含可播放的未压缩 DSD 区域',
  dst_dsd_provider_unavailable: 'SACD DST 需要保留 DSD 的 provider，当前不可用',
  dst_dsd_provider_failed: 'SACD DST 保 DSD provider 解码失败',
  dsd_dop: '当前 DSD 正在通过 DoP 载波传输',
  dop_carrier_mismatch: 'DoP 载波格式与目标 DSD 速率不匹配',
  dop_passthrough_unproven: 'DoP 输出路径未能证明直通',
  plugin_path: '当前设备路径包含插件或混音层',
  device_not_found: '当前后端没有找到请求设备',
  format_not_supported: '当前设备不支持请求的输出格式',
  backend_open_failure: '输出后端打开失败',
  backend_start_failure: '输出后端启动失败',
  buffer_failure: '输出缓冲失败或发生 underrun',
  device_lost: '输出设备已断开，需要恢复',
  driver_restart: '驱动发生重启或重置'
}
const accessModeLabels: Record<string, string> = {
  shared: 'Shared',
  exclusive: 'Exclusive',
  hog: 'Hog',
  direct: 'Direct',
  plugin: 'Plugin'
}
const nativeDsdStateLabels: Record<string, string> = {
  unsupported: 'Native DSD Unsupported',
  candidate: 'Native DSD Candidate',
  unproven: 'Native DSD Unproven',
  mismatch: 'Native DSD Mismatch',
  proven: 'Native DSD Proven'
}

function canonicalSourceExact(): boolean {
  return outputInfo.value?.sourceExact === true
}

function canonicalOutputPerfect(): boolean {
  return outputInfo.value?.outputPerfect === true
}

function formatBackendLabel(backend: string): string {
  return backendLabels[backend] ?? backend
}

function formatPerfectReason(reason: string): string {
  const trimmed = reason.trim()
  if (!trimmed) return ''
  return trimmed
}

function resolvePerfectReasonText(): string {
  const code = outputInfo.value?.perfectReasonCode || playbackInfo.value?.perfectReasonCode || ''
  if (code && reasonCodeLabels[code]) return reasonCodeLabels[code]
  const capabilityReason = outputInfo.value?.capabilityReason?.trim() || ''
  if (capabilityReason) return capabilityReason
  return formatPerfectReason(
    outputInfo.value?.perfectReason || playbackInfo.value?.perfectReason || ''
  )
}

function nativeDsdRuntimeTone(state: string): 'success' | 'warning' | 'muted' {
  if (state === 'proven') return 'success'
  if (state === 'candidate' || state === 'unproven' || state === 'mismatch') return 'warning'
  return 'muted'
}

const nativeDsdRuntimeText = computed(() => {
  const info = outputInfo.value
  if (!info) return ''
  const state = info.nativeDsdRuntimeState || 'unsupported'
  const hasRuntimeInterest =
    state !== 'unsupported' ||
    info.driverNativeDsdCapable ||
    info.nativeDsdRequestedRate > 0 ||
    info.nativeDsdExplicitlyCapable
  if (!hasRuntimeInterest) return ''
  const label = nativeDsdStateLabels[state] ?? `Native DSD ${state}`
  const rate =
    info.nativeDsdActualRate ||
    info.nativeDsdRequestedRate ||
    info.driverNativeDsdSampleRates?.[0] ||
    0
  return rate > 0 ? `${label} ${compactRate(rate)}` : label
})

const audioStatusChips = computed(() => {
  const chips: { label: string; tone?: 'success' | 'warning' | 'muted'; title?: string }[] = []
  const sourceExact = canonicalSourceExact()
  const outputPerfect = canonicalOutputPerfect()
  const reasonText = resolvePerfectReasonText()
  chips.push({
    label: 'Source Exact',
    tone: sourceExact ? 'success' : 'muted',
    title: sourceExact
      ? '源格式未改写（Source Exact）'
      : reasonText || '源路径非 Exact（有损/格式变更等）'
  })
  chips.push({
    label: 'Output Perfect',
    tone: outputPerfect ? 'success' : outputInfo.value?.supportsOutputPerfect ? 'warning' : 'muted',
    title: outputPerfect
      ? '输出链已验证直通（Output Perfect）'
      : reasonText || '当前输出链尚未验证为 bit-perfect 直通'
  })
  if (outputInfo.value?.resampled)
    chips.push({ label: 'Resampled', tone: 'warning', title: '采样率或格式发生重采样' })
  if (playbackInfo.value?.dspActive)
    chips.push({ label: 'DSP', tone: 'warning', title: 'DSP 处理链正在改变样本' })
  if (exclusiveMode.value)
    chips.push({ label: 'Exclusive', tone: 'success', title: '独占模式（设置态，非实时证明）' })
  if (outputInfo.value?.accessMode) {
    chips.push({
      label: accessModeLabels[outputInfo.value.accessMode] ?? outputInfo.value.accessMode,
      tone: outputInfo.value.accessMode === 'shared' ? 'muted' : 'success',
      title:
        outputInfo.value.accessMode === 'shared'
          ? 'Shared 模式会经系统混音，通常不是 bit-perfect'
          : '当前访问模式'
    })
  }
  if (nativeDsdRuntimeText.value) {
    chips.push({
      label: nativeDsdRuntimeText.value,
      tone: nativeDsdRuntimeTone(outputInfo.value?.nativeDsdRuntimeState || 'unsupported'),
      title: '运行时 Native DSD 状态（列表筛选≠当前输出模式）'
    })
  }
  return chips
})
const nonPerfectReason = computed(() => {
  const sourceExact = canonicalSourceExact()
  const outputPerfect = canonicalOutputPerfect()
  if (sourceExact && outputPerfect) return ''
  const reason = resolvePerfectReasonText()
  return reason ? `未达成：${reason}` : ''
})
const perfectReasonCode = computed(
  () => outputInfo.value?.perfectReasonCode || playbackInfo.value?.perfectReasonCode || ''
)
const showVolumeNotUnityCta = computed(() => perfectReasonCode.value === 'volume_not_unity')
function compactRate(rate: number): string {
  return rate > 0 ? `${Math.round(rate / 100) / 10}kHz` : ''
}

function compactSampleFormat(format: string, bitDepth: number): string {
  const normalized = format.trim().toLowerCase()
  if (/^(f32|float|float32|flt|fltp)$/.test(normalized)) return 'float32'
  if (/^(s24|s24_3le|int24|int24in32|s32p24)/.test(normalized)) return 'int24'
  if (/^(s16|s16le|int16)/.test(normalized)) return 'int16'
  if (/^(s32|s32le|int32)/.test(normalized)) return 'int32'
  return format || (bitDepth > 0 ? `${bitDepth}bit` : '')
}

function compactPcm(
  format: string,
  bitDepth: number,
  sampleRate: number,
  channels: number,
  includeRate = true
): string {
  const parts = [
    compactSampleFormat(format, bitDepth),
    includeRate && sampleRate > 0 ? compactRate(sampleRate) : '',
    channels > 0 ? `${channels}ch` : ''
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'PCM'
}

function isSacdIsoSource(info: NonNullable<typeof playbackInfo.value>): boolean {
  return info.source.split('.').pop()?.toUpperCase() === 'ISO'
}

function inferDsdRate(sampleRate: number): number {
  if (sampleRate >= 20000000) return 512
  if (sampleRate >= 10000000) return 256
  if (sampleRate >= 5000000) return 128
  if (sampleRate >= 2500000) return 64
  return 0
}

function isDsdSource(info: NonNullable<typeof playbackInfo.value>): boolean {
  return /\.(dsf|dff)$/i.test(info.source) || info.codec.trim().toLowerCase() === 'dsd'
}

function isDsdPlayback(): boolean {
  const out = outputInfo.value
  return (
    out?.isDsd === true ||
    out?.dsdMode === 'native' ||
    out?.dsdMode === 'dop' ||
    out?.dsdMode === 'unsupported'
  )
}

function formatDsdSource(info: NonNullable<typeof playbackInfo.value>): string {
  const ext = info.source.split('.').pop()?.toUpperCase()
  const container = ext === 'DSF' || ext === 'DFF' ? ext : ext === 'ISO' ? 'SACD ISO' : 'DSD'
  const dsdRate = outputInfo.value?.dsdRate || inferDsdRate(info.sourceSampleRate)
  return [container, dsdRate > 0 ? `DSD${dsdRate}` : 'DSD'].filter(Boolean).join(' ')
}

function formatDecodedStage(info: NonNullable<typeof playbackInfo.value>): string {
  const pcm = compactPcm(
    info.decodedSampleFormat,
    info.decodedBitDepth,
    info.decodedSampleRate,
    info.decodedChannels,
    false
  )
  if (!isDsdSource(info) && !isDsdPlayback()) return pcm
  const mode = outputInfo.value?.dsdMode || 'pcm'
  if (mode === 'native') return 'Native DSD path'
  if (mode === 'dop') return `DoP carrier ${pcm}`
  if (mode === 'unsupported' && isSacdIsoSource(info)) return 'SACD unsupported'
  return `PCM fallback ${pcm}`
}

const outputChainText = computed(() => {
  const info = playbackInfo.value
  if (!info) return ''
  const source =
    isDsdSource(info) || isSacdIsoSource(info)
      ? formatDsdSource(info)
      : [
          info.codec || 'Source',
          info.sourceBitDepth > 0 ? `${info.sourceBitDepth}bit` : '',
          compactRate(info.sourceSampleRate)
        ]
          .filter(Boolean)
          .join(' ')
  const decoded = formatDecodedStage(info)
  const out = outputInfo.value
  const backend = out?.actualBackend || info.actualBackend || ''
  const actual = compactPcm(
    out?.actualOutputFormat || info.actualOutputFormat,
    out?.actualBitDepth || info.actualBitDepth,
    out?.actualSampleRate || info.actualSampleRate,
    out?.actualChannels || info.actualChannels,
    false
  )
  const perfect =
    canonicalSourceExact() && canonicalOutputPerfect()
      ? 'Bit Perfect'
      : resolvePerfectReasonText()
        ? `Not Bit Perfect (${resolvePerfectReasonText()})`
        : 'Not Bit Perfect'
  return `${source || 'Source'} -> ${decoded} -> ${backend ? formatBackendLabel(backend) : 'Backend pending'} -> ${actual} -> ${perfect}`
})
const outputLatencyText = computed(() => {
  const info = outputInfo.value
  if (!info) return 'Latency 0.0 ms'
  const buffer = info.latencyInfo?.bufferLatencyMs ?? 0
  const driver = info.latencyInfo?.outputLatencyMs ?? 0
  const total = info.latencyInfo?.totalLatencyMs ?? info.latencyMs ?? 0
  const frames = info.bufferSizeFrames || playbackInfo.value?.bufferSizeFrames || 0
  return `Latency Buffer ${buffer.toFixed(1)} ms · Driver ${driver.toFixed(1)} ms · Total ${total.toFixed(total >= 10 ? 0 : 1)} ms${frames > 0 ? ` · ${frames} frames` : ''}`
})
const outputDiagnosticsText = computed(() => {
  const diagnostics = outputInfo.value?.diagnostics ?? playbackInfo.value?.diagnostics
  if (!diagnostics) return 'Underrun 0 · Drop 0 · Restart 0 · Lost 0 · Recovery 0'
  return `Underrun ${diagnostics.sessionUnderrunCount} · Drop ${diagnostics.sessionBufferDropCount} · Restart ${diagnostics.driverRestartCount} · Lost ${diagnostics.deviceLostCount} · Recovery ${diagnostics.sessionRecoveryCount}`
})
const nativeDsdRuntimeReasonText = computed(() => {
  const reason = outputInfo.value?.nativeDsdRuntimeReason?.trim()
  return reason ? `Native DSD: ${reason}` : ''
})

function playTrackAt(index: number): void {
  const track = queue.value[index]
  if (track) {
    queueIndex.value = index
    playTrack(track)
  }
}

function openPlaybackSettings(): void {
  moreOpen.value = false
  emit('openSettings')
}

function openDspSettings(): void {
  moreOpen.value = false
  emit('openDsp')
}

function openEqualizerPage(): void {
  moreOpen.value = false
  emit('openEqualizer')
}

async function runPlayerBarExtension(command?: string): Promise<void> {
  if (!command) return
  moreOpen.value = false
  await window.api.extensions.executeCommand(command, [currentTrack.value])
}

function onToggleClipGuard(): void {
  void setAudioProcessing({ clipGuard: !audioProcessing.value.clipGuard })
}

function onToggleConvolver(): void {
  void setAudioProcessing({
    dspEnabled: true,
    convolverEnabled: !audioProcessing.value.convolverEnabled
  })
}

function onSetReplayGainMode(mode: VolumeNormalizationMode): void {
  void setReplayGainMode(mode)
}

function onSetCrossfeedStrength(strength: number): void {
  void setCrossfeedStrength(strength)
}

function onSetCrossfadeSeconds(seconds: number): void {
  void setAudioProcessing({ crossfadeSeconds: seconds })
}

function onSetReplayGainPreamp(db: number): void {
  void setAudioProcessing({ dspEnabled: true, replayGainPreamp: db })
}

function onSetPreferredBufferSize(frames: number): void {
  void setAudioOutputConfig({ preferredBufferSize: frames })
}

function onSetRoutingMode(mode: ChannelRoutingMode): void {
  void setAudioOutputConfig({ routingMode: mode })
}

function onSetPcmToDsdMode(mode: PcmToDsdMode): void {
  void setAudioOutputConfig({ pcmToDsdMode: mode })
}

function onSetDsdOutputMode(mode: DsdOutputMode): void {
  void setAudioProcessing({ dsdOutputMode: mode })
}

function onSetAudioOutput(output: AudioOutputId): void {
  void setAudioOutput(output)
}

function onSetAudioDevice(device: string): void {
  void setAudioDevice(device)
}

function onRefreshDevices(): void {
  void refreshAudioOutputState()
}

async function onReloadLyrics(prefer: 'auto' | 'local' | 'provider'): Promise<void> {
  const track = currentTrack.value
  if (!track || lyricsReloading.value) return
  lyricsReloading.value = true
  try {
    await lyricsManagement.selectSource(track.id, prefer)
    if (currentTrack.value?.id !== track.id) return
    await refreshCurrentLyrics()
  } catch (error) {
    console.error('[hifi] Failed to reload lyrics:', error)
  } finally {
    lyricsReloading.value = false
  }
}

function lyricLayerSelection(
  key: 'originalSelection' | 'translationSelection' | 'romanizationSelection'
): LyricLayerSourceSelection {
  const selection = managedLyricOverride.value?.[key]
  if (
    selection === 'automatic' ||
    selection === 'local' ||
    selection === 'provider' ||
    selection === 'manual'
  ) {
    return selection
  }
  const source = managedLyricOverride.value?.source
  return source === 'local' || source === 'provider' || source === 'manual' ? source : 'automatic'
}

async function setLyricLayerSelection(
  key: 'originalSelection' | 'translationSelection',
  selection: LyricLayerSourceSelection
): Promise<void> {
  const track = currentTrack.value
  if (!track || lyricsReloading.value || lyricControlsPending.value) return
  lyricControlsPending.value = true
  try {
    await lyricsManagement.updateTrack(track.id, {
      source: 'auto',
      originalSelection:
        key === 'originalSelection' ? selection : lyricLayerSelection('originalSelection'),
      translationSelection:
        key === 'translationSelection' ? selection : lyricLayerSelection('translationSelection'),
      romanizationSelection: lyricLayerSelection('romanizationSelection')
    })
    if (currentTrack.value?.id === track.id) await refreshCurrentLyrics()
  } finally {
    lyricControlsPending.value = false
  }
}

async function toggleTranslationVisibility(): Promise<void> {
  if (lyricsReloading.value || lyricControlsPending.value) return
  lyricControlsPending.value = true
  try {
    await lyricsManagement.updateVisibility({ showTranslation: !showTranslation.value })
  } finally {
    lyricControlsPending.value = false
  }
}

onMounted(() => {
  if (!props.preview) void syncExtensions()
})
</script>

<template>
  <div
    v-if="currentTrack"
    ref="playerBarShellRef"
    class="player-bar-shell"
    :class="{ 'menu-open': menuOpen }"
  >
    <!-- 播放列表面板（向上抽屉） -->
    <button
      v-if="floatingPanelOpen"
      class="player-panel-dismiss"
      type="button"
      aria-label="关闭浮层"
      @pointerdown.prevent.stop="dismissAllFloatingPanels"
      @click.prevent.stop
    ></button>

    <Transition name="drawer-up">
      <div v-if="playlistOpen" class="playlist-panel" :class="{ 'panel-glass': glass }">
        <div class="playlist-header">
          <div class="playlist-heading">
            <div class="playlist-heading-row">
              <span class="playlist-heading-title">播放列表</span>
              <span class="playlist-count">{{ queue.length }} 首</span>
            </div>
            <span class="playlist-heading-subtitle">{{ queueSummaryText }}</span>
          </div>
          <div class="playlist-tools" aria-label="队列操作">
            <button
              class="playlist-tool-btn"
              type="button"
              title="定位到正在播放"
              aria-label="定位到正在播放"
              :disabled="queue.length === 0"
              @click="scrollQueueToCurrent"
            >
              <i class="pi pi-map-marker" aria-hidden="true"></i>
              <span>定位</span>
            </button>
            <button
              class="playlist-tool-btn playlist-tool-danger"
              type="button"
              title="清空播放队列"
              aria-label="清空播放队列"
              :disabled="queue.length === 0"
              @click="clearPlaybackQueue"
            >
              <i class="pi pi-trash" aria-hidden="true"></i>
              <span>清空</span>
            </button>
          </div>
        </div>
        <div v-if="queue.length === 0" class="playlist-empty">
          <span class="playlist-empty-icon" aria-hidden="true">
            <i class="pi pi-inbox"></i>
          </span>
          <span class="playlist-empty-title">队列还是空的</span>
          <span class="playlist-empty-hint">播放任意歌曲后，会在这里排队等候</span>
        </div>
        <div :ref="setPlaylistListRef" class="playlist-list" @scroll.passive="onQueueScroll">
          <div class="playlist-virtual-spacer" :style="{ height: `${queueVirtualHeight}px` }">
            <div
              class="playlist-virtual-window"
              :style="{ transform: `translateY(${queueVirtualTranslateY}px)` }"
            >
              <div
                v-for="item in visibleQueueItems"
                :key="item.queueEntryId"
                class="playlist-item"
                data-te-interactive
                :class="{
                  active: item.index === queueIndex,
                  dragging: draggedEntryId === item.queueEntryId
                }"
                role="button"
                tabindex="0"
                draggable="true"
                :aria-current="item.index === queueIndex ? 'true' : undefined"
                :aria-label="`${item.title} - ${item.artist}`"
                @click="playQueueEntry(item.queueEntryId)"
                @keydown.enter.prevent="playQueueEntry(item.queueEntryId)"
                @keydown.space.prevent="playQueueEntry(item.queueEntryId)"
                @dragstart="onQueueDragStart($event, item.queueEntryId)"
                @dragover="onQueueDragOver($event, item.queueEntryId)"
                @drop="onQueueDrop($event, item.queueEntryId)"
                @dragend="onQueueDragEnd"
              >
                <button
                  class="playlist-drag-handle"
                  type="button"
                  tabindex="-1"
                  aria-label="拖动排序"
                  title="拖动排序"
                  @click.stop
                >
                  <i class="pi pi-bars" aria-hidden="true"></i>
                </button>
                <span class="playlist-index">
                  <span
                    v-if="item.index === queueIndex"
                    class="playing-bars"
                    :class="{ paused: !isPlaying }"
                    aria-hidden="true"
                  >
                    <i></i><i></i><i></i>
                  </span>
                  <span v-else class="playlist-index-num">{{ item.index + 1 }}</span>
                </span>
                <CoverImg
                  v-if="item.cover"
                  :cover="item.cover"
                  :identity="item.id"
                  class="playlist-cover"
                  alt=""
                />
                <div v-else class="playlist-cover-placeholder">
                  <i class="pi pi-wave-pulse" aria-hidden="true"></i>
                </div>
                <div class="playlist-info">
                  <div class="playlist-title">{{ item.title }}</div>
                  <div class="playlist-artist">{{ item.artist }}</div>
                </div>
                <div class="playlist-row-actions" @click.stop>
                  <button
                    type="button"
                    title="下一首播放"
                    :aria-label="`将 ${item.title} 设为下一首`"
                    @click="playQueueEntryNext(item.queueEntryId)"
                  >
                    <i class="pi pi-step-forward" aria-hidden="true"></i>
                  </button>
                  <button
                    type="button"
                    title="添加到队尾"
                    :aria-label="`将 ${item.title} 添加到队尾`"
                    @click="addQueueEntryToTail(item.queueEntryId)"
                  >
                    <i class="pi pi-plus" aria-hidden="true"></i>
                  </button>
                  <button
                    type="button"
                    class="row-action-danger"
                    title="从队列移除"
                    :aria-label="`从队列移除 ${item.title}`"
                    @click="removeQueueEntry(item.queueEntryId)"
                  >
                    <i class="pi pi-times" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- PlayerBar 主体 -->
    <div
      class="player-bar"
      :class="{ 'player-bar-glass': glass }"
      :style="{
        '--accent-color': dominantColor,
        '--play-button-color': playButtonColor
      }"
    >
      <!-- 左侧：整块按曲目 identity remount，避免 cover:// 解码粘住上一首 -->
      <div :key="playerLeftKey" class="player-left">
        <div
          ref="coverRef"
          class="player-cover-slot player-artwork-slot"
          data-te-interactive
          title="打开播放页面"
          @click="onCoverClick"
        >
          <CoverImg
            v-if="currentTrack.cover || currentTrack.coverSource"
            :cover="currentTrack.cover"
            :cover-source="currentTrack.coverSource"
            :identity="currentTrack.id"
            class="player-cover"
            alt=""
          />
          <div v-else class="player-cover-placeholder">
            <i class="pi pi-wave-pulse" style="font-size: 18px; color: #bbb"></i>
          </div>
        </div>
        <div class="player-track-info">
          <div class="player-title-row">
            <div class="player-title">{{ currentTrack.title }}</div>
            <span
              v-if="isLiveStream || isStreamBuffering"
              class="live-badge"
              :class="{ buffering: isStreamBuffering }"
              title="实时流媒体"
              >{{ isStreamBuffering && !isLiveStream ? '缓冲中' : liveBadgeLabel }}</span
            >
          </div>
          <button
            type="button"
            class="player-artist"
            data-te-interactive
            :disabled="preview || !currentTrack.artist.trim()"
            :title="currentTrack.artist ? `打开歌手：${currentTrack.artist}` : undefined"
            @click.stop="onArtistClick"
          >
            {{ currentTrack.artist }}
          </button>
          <div
            v-if="streamNowPlaying && isLiveStream"
            class="player-stream-now-playing"
            :title="streamNowPlaying"
          >
            {{ streamNowPlaying }}
          </div>
        </div>
      </div>

      <!-- 中间 -->
      <div class="player-center">
        <div class="player-controls">
          <button class="ctrl-btn previous-button" aria-label="上一首" @click="prev">
            <img :src="previousTrackIcon" alt="上一首" />
          </button>
          <button
            class="ctrl-btn btn-play"
            :class="{ 'is-playing': isPlaying }"
            aria-label="播放/暂停"
            @click="togglePlay"
          >
            <img :src="isPlaying ? pauseIcon : playIcon" :alt="isPlaying ? '暂停' : '播放'" />
          </button>
          <button class="ctrl-btn next-button" aria-label="下一首" @click="next">
            <img :src="nextTrackIcon" alt="下一首" />
          </button>
        </div>
        <div v-if="activeResumeOffer" class="resume-offer" role="status">
          <span class="resume-offer__text"
            >从 {{ formatTime(activeResumeOffer.positionSeconds) }} 继续</span
          >
          <button type="button" class="resume-offer__action" @click="onAcceptResume">继续</button>
          <button type="button" class="resume-offer__dismiss" @click="onDismissResume">忽略</button>
        </div>
        <div
          :key="`progress:${currentTrack.id}:${currentTrack.queueEntryId || ''}`"
          class="progress-area"
          :data-track-id="currentTrack.id"
          :data-entry-id="currentTrack.queueEntryId || ''"
        >
          <span class="time-label">{{ isLiveStream ? 'LIVE' : formatTime(currentTime) }}</span>
          <div class="progress-slider-wrap">
            <div class="progress-track" aria-hidden="true">
              <div
                class="progress-fill"
                :class="{ live: isLiveStream }"
                :style="progressFillStyle"
              ></div>
            </div>
            <div
              v-if="abLoopA != null && abLoopB != null && effectiveDuration > 0 && !isLiveStream"
              class="ab-loop-range"
              :style="abLoopRangeStyle"
              aria-hidden="true"
            ></div>
            <input
              type="range"
              :value="isLiveStream ? 0 : currentTime"
              min="0"
              :max="effectiveDuration || 1"
              step="0.1"
              class="progress-slider"
              :class="{ live: isLiveStream }"
              :disabled="isLiveStream"
              :aria-valuenow="isLiveStream ? 0 : currentTime"
              :aria-valuetext="isLiveStream ? 'LIVE' : formatTime(currentTime)"
              @input="onProgressInput"
            />
          </div>
          <span class="time-label">{{
            isLiveStream ? 'LIVE' : formatTime(effectiveDuration)
          }}</span>
        </div>
      </div>

      <!-- 右侧 -->
      <div class="player-right">
        <button
          v-if="favoriteButtonVisible"
          class="icon-btn favorite-btn player-misc-icon"
          :class="{ active: favoriteButtonLiked }"
          :title="favoriteButtonTitle"
          :aria-label="favoriteButtonTitle"
          :aria-pressed="favoriteButtonLiked"
          :disabled="favoriteButtonLoading"
          @click="toggleFavorite"
        >
          <i
            :class="
              favoriteButtonLoading
                ? 'pi pi-spin pi-spinner'
                : favoriteButtonLiked
                  ? 'pi pi-heart-fill'
                  : 'pi pi-heart'
            "
          ></i>
        </button>

        <button
          class="ctrl-btn mode-btn-right player-misc-icon"
          :title="modeTitle"
          :aria-label="modeTitle"
          @click="cyclePlayMode"
        >
          <img v-if="playMode === 'sequential'" :src="sequentialIcon" alt="顺序" />
          <img v-else-if="playMode === 'listLoop'" :src="listLoopIcon" alt="列表循环" />
          <img v-else-if="playMode === 'repeat'" :src="repeatIcon" alt="单曲循环" />
          <img v-else :src="shuffleIcon" alt="随机" />
        </button>

        <!-- 独立音量控件：点击仅展开滑杆，不切换静音 -->
        <div class="volume-anchor player-misc-icon" @wheel="onVolumeWheel">
          <Transition name="volume-drawer">
            <div v-if="volumeOpen" class="volume-drawer" :class="{ 'drawer-glass': glass }">
              <div class="volume-drawer-slider-wrap">
                <input
                  type="range"
                  :value="volume"
                  min="0"
                  max="1"
                  step="0.01"
                  class="volume-drawer-slider"
                  aria-label="音量"
                  :style="{ '--range-value': `${volume * 100}%` }"
                  @input="onVolumeInput"
                />
              </div>
              <span class="volume-drawer-val">{{ Math.round(volume * 100) }}</span>
              <button
                v-if="volume < 0.999 || showVolumeNotUnityCta"
                type="button"
                class="volume-unity-btn"
                :class="{ accent: showVolumeNotUnityCta }"
                :disabled="volume >= 0.999"
                title="Unity：固定软件音量 100%（bit-perfect 需要）"
                @click="setUnityVolume"
              >
                {{ HIFI_STATUS_COPY.unityButtonShort }}
              </button>
            </div>
          </Transition>
          <button
            type="button"
            class="volume-control-button icon-btn"
            :class="{ active: volumeOpen }"
            title="音量控制"
            aria-label="音量控制"
            :aria-expanded="volumeOpen"
            @click="toggleVolume"
          >
            <i :class="volume <= 0.001 ? 'pi pi-volume-off' : 'pi pi-volume-up'"></i>
          </button>
        </div>

        <button
          class="icon-btn track-menu-button"
          :class="{ active: playlistOpen }"
          title="播放列表"
          aria-label="播放列表"
          @click="togglePlaylist"
        >
          <i class="pi pi-list"></i>
        </button>

        <button
          class="icon-btn mini-player-btn player-misc-icon"
          title="切换到迷你播放器"
          aria-label="切换到迷你播放器"
          :disabled="miniPlayerOpening"
          @click="openMiniPlayer"
        >
          <i :class="miniPlayerOpening ? 'pi pi-spin pi-spinner' : 'ph ph-picture-in-picture'"></i>
        </button>

        <button
          class="icon-btn desktop-lyrics-btn player-misc-icon"
          :class="{ active: desktopLyricsOn }"
          title="桌面歌词"
          aria-label="桌面歌词"
          :aria-pressed="desktopLyricsOn"
          @click="toggleDesktopLyrics"
        >
          <span class="desktop-lyrics-icon" aria-hidden="true">词</span>
        </button>

        <!-- HiFi 控制台入口 -->
        <button
          class="icon-btn player-misc-icon"
          :class="{ active: moreOpen }"
          title="HiFi 控制台"
          aria-label="HiFi 控制台"
          @click="toggleMore"
        >
          <i class="ph ph-faders"></i>
        </button>
      </div>
    </div>

    <!-- HiFi 右侧覆盖面板 -->
    <Transition name="hifi-overlay">
      <div v-if="moreOpen" class="hifi-overlay" :class="{ glass }">
        <HiFiSidebar
          :glass="glass"
          :accent-color="playButtonColor"
          :exclusive-mode="exclusiveMode"
          :exclusive-available="exclusiveAvailable"
          :audio-output="audioOutput"
          :audio-output-options="audioOutputOptions"
          :audio-device="audioDevice"
          :audio-device-options="audioDeviceOptions"
          :audio-processing="audioProcessing"
          :audio-output-config="audioOutputConfig"
          :dsp-output-stage="dspOutputStage"
          :dsp-stereo-image="dspStereoImage"
          :actual-sample-rate="outputInfo?.actualSampleRate || playbackInfo?.actualSampleRate || 0"
          :status-chips="audioStatusChips"
          :non-perfect-reason="nonPerfectReason"
          :perfect-reason-code="perfectReasonCode"
          :volume="volume"
          :gapless-active="playbackInfo?.gaplessActive === true"
          :preload-ready="playbackInfo?.preloadReady === true"
          :gapless-blocked-reason="playbackInfo?.gaplessBlockedReason || ''"
          :loudnorm-status="loudnormStatus"
          :output-chain-text="outputChainText"
          :output-latency-text="outputLatencyText"
          :output-diagnostics-text="outputDiagnosticsText"
          :native-dsd-runtime-reason-text="nativeDsdRuntimeReasonText"
          :current-track="currentTrack"
          :desktop-lyrics-on="desktopLyricsOn"
          :lyrics-reloading="lyricsReloading"
          :original-layer-selection="originalLayerSelection"
          :translation-layer-selection="translationLayerSelection"
          :show-translation="showTranslation"
          :lyric-controls-pending="lyricsReloading || lyricControlsPending"
          :player-bar-buttons="playerBarButtons"
          :is-live-stream="isLiveStream"
          :playback-rate="playbackRate"
          :playback-rate-label="playbackRateLabel"
          :playback-rate-title="playbackRateTitle"
          :ab-loop-a="abLoopA"
          :ab-loop-b="abLoopB"
          :ab-loop-title="abLoopTitle"
          :sleep-timer-select-value="sleepTimerSelectValue"
          :sleep-timer-status="sleepTimerStatus"
          :sleep-timer-default-minutes="settings.sleepTimer.defaultMinutes"
          :cast-target-name="castTargetName"
          :cast-devices="castDevices"
          :cast-busy="castBusy"
          :cast-error="castError"
          :can-cast-current-track="canCastCurrentTrack"
          :bookmarks="currentTrackBookmarks"
          :renaming-bookmark-id="renamingBookmarkId"
          :rename-draft="renameDraft"
          :format-time="formatTime"
          @open-settings="openPlaybackSettings"
          @open-dsp="openDspSettings"
          @open-equalizer="openEqualizerPage"
          @set-unity-volume="setUnityVolume"
          @toggle-exclusive="toggleExclusiveMode"
          @toggle-dsp="toggleDspEnabled"
          @toggle-eq="toggleEqEnabled"
          @toggle-gapless="toggleGapless"
          @toggle-crossfeed="toggleCrossfeed"
          @toggle-clip-guard="onToggleClipGuard"
          @toggle-convolver="onToggleConvolver"
          @toggle-desktop-lyrics="toggleDesktopLyrics"
          @set-replay-gain-mode="onSetReplayGainMode"
          @set-crossfeed-strength="onSetCrossfeedStrength"
          @set-crossfade-seconds="onSetCrossfadeSeconds"
          @set-replay-gain-preamp="onSetReplayGainPreamp"
          @set-preferred-buffer-size="onSetPreferredBufferSize"
          @set-routing-mode="onSetRoutingMode"
          @set-pcm-to-dsd-mode="onSetPcmToDsdMode"
          @set-dsd-output-mode="onSetDsdOutputMode"
          @set-output-stage="setOutputStage"
          @set-stereo-image="setStereoImage"
          @set-audio-output="onSetAudioOutput"
          @set-audio-device="onSetAudioDevice"
          @refresh-devices="onRefreshDevices"
          @select-impulse-response="selectImpulseResponse"
          @clear-impulse-response="clearImpulseResponse"
          @reload-lyrics="onReloadLyrics"
          @set-lyric-layer-selection="setLyricLayerSelection"
          @toggle-translation-visibility="toggleTranslationVisibility"
          @run-extension="runPlayerBarExtension"
          @cycle-playback-rate="cyclePlaybackRate"
          @toggle-ab-loop="toggleAbLoopAtCurrentTime"
          @clear-ab-loop="clearAbLoop"
          @sleep-timer-select="onSleepTimerSelectValue"
          @refresh-cast-devices="refreshCastDevices"
          @cast-to-device="onCastToDevice"
          @stop-cast="onStopCast"
          @add-bookmark="onAddBookmark"
          @jump-bookmark="jumpToBookmark"
          @start-rename-bookmark="startRenameBookmark"
          @commit-rename-bookmark="commitRenameBookmark"
          @update-rename-draft="renameDraft = $event"
          @cancel-rename-bookmark="cancelRenameBookmark"
          @delete-bookmark="deleteBookmark"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped src="./player-bar/PlayerBar.css"></style>
