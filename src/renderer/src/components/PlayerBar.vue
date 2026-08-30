<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, type ComponentPublicInstance } from 'vue'
import { usePlayerStore } from '../stores/usePlayerStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useMusicStore } from '../stores/useMusicStore'
import { usePlaybackBookmarks } from '../stores/playbackBookmarks'
import { useLyricsManagement } from '../stores/lyricsManagement'
import type { PlaybackBookmark } from '../../../shared/playbackBookmarks.ts'
import { useExtensionRegistry } from '../extensions/registry'
import {
  createFrameCoalescer,
  LIQUID_GLASS_POINTER_FRAME_INTERVAL_MS,
  pointerCssVariables,
  resolvePointerOffset,
  staticPointerCssVariables
} from '../utils/liquidGlassPointer.ts'
import {
  LIQUID_GLASS_PRESS_TARGET_SCALE,
  LiquidGlassPressController,
  liquidGlassPressCssVariables
} from '../utils/liquidGlassPress.ts'
import { useMediaProviders } from '../providers'
import { normalizeAccentColor } from '../utils/colorExtractor'
import { useSmoothedValue } from '../utils/useSmoothedValue'
import { HIFI_STATUS_COPY } from '../../../shared/audioProcessingOptions.ts'
import { resolveReasonCode } from '../../../shared/audio/reasonCodes.ts'
import { useLocale } from '../app/useLocale.ts'
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
import heartModeIcon from '../assets/icons/heart-mode.svg'
import { useFavoriteButton } from './player-bar/useFavoriteButton'
import { useFloatingPanels } from './player-bar/useFloatingPanels'
import { usePlaybarAutoHide } from './player-bar/usePlaybarAutoHide.ts'
import { resolveSeekTargetSeconds, type PlayerBarMode } from '../../../shared/playerBar.ts'
import {
  resolvePlayerBarRegions,
  PLAYER_BAR_REGION_NAMES,
  type PlayerBarRegionName
} from '../../../shared/playerBarLayout.ts'
import { useEscapeToClose } from '../app/useDismissLayer.ts'
import { usePlaybackQueueVirtualScroll } from './player-bar/usePlaybackQueueVirtualScroll'
import { usePlaybackQueueDrawerActions } from './player-bar/usePlaybackQueueDrawerActions'
import { useQueueAddToPlaylist } from './player-bar/useQueueAddToPlaylist'
import QueueAddToPlaylistDialog from './player-bar/QueueAddToPlaylistDialog.vue'
import CompactPlayerBarVisualizer from './player-bar/CompactPlayerBarVisualizer.vue'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'
import { syncPluginProviders } from '../providers'
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
    /** Show the expanded artwork and waveform stage on the actual lyrics page. */
    visualizerVisible?: boolean
    /**
     * Standard = full bar; mini is a long flat progress strip with utility
     * tools; compact spans the window edge to edge with its progress on the
     * top edge. Which controls each shape shows is the layout's business.
     */
    mode?: PlayerBarMode
    /** Hide until the pointer approaches the bottom edge. Mini and compact only. */
    autoHide?: boolean
    /**
     * Fully hidden: no reveal gesture at all, any shape. Named `hiddenBar`
     * rather than `hidden` so Vue does not fall the global `hidden` attribute
     * through onto the shell, which would `display: none` the element the
     * geometry consumers query.
     */
    hiddenBar?: boolean
  }>(),
  {
    preview: false,
    visualizerVisible: false,
    mode: 'standard',
    autoHide: false,
    hiddenBar: false
  }
)

const isMini = computed(() => props.mode === 'mini')
const isStandard = computed(() => props.mode === 'standard')
/** Edge-to-edge strip flush with the window bottom; progress rides its top edge. */
const isCompact = computed(() => props.mode === 'compact')
const showCompactVisualizer = computed(() => isCompact.value && props.visualizerVisible)

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
  audioOutputDeviceOptions,
  audioProcessing,
  audioOutputConfig,
  dspOutputStage,
  dspStereoImage,
  playbackInfo,
  loudnormStatus,
  outputInfo,
  visualizationData,
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
  localPlaylists,
  addToPlaylist,
  addTracksToPlaylist,
  removeFromPlaylist,
  createPlaylist,
  createPlaylistWithTracks,
  isFavoriteTrack,
  addFavoriteTrack,
  removeFavoriteTrack
} = useMusicStore()
const mediaProviders = useMediaProviders()
const { pushNotice } = useAppNoticeStore()
// Reason-code copy is resolved per locale, so the chip labels re-render when the
// language preference changes rather than freezing whatever was active at mount.
const { locale } = useLocale()

const coverRef = ref<HTMLElement | null>(null)
const playerBarShellRef = ref<HTMLElement | null>(null)
const playButtonColor = computed(() => normalizeAccentColor(dominantColor.value))
const { uiContributions, syncExtensions } = useExtensionRegistry()
const playerBarButtons = computed(() =>
  uiContributions.value.filter((contribution) => contribution.kind === 'playerBarButton')
)
const { settings } = useSettingsStore()
/* Only the standard bar wears the material. Mini and compact are deliberately
   flat control strips, so they opt out entirely rather than wearing it with the
   refracting layer switched off. `.player-bar-liquid` claims `background`,
   `border-color` and the rim `box-shadow` with `!important`, which neither strip
   can out-rank: they rendered as a transparent pane ringed by the rim highlight
   — a white outline drawn around glass that was not there. Gating it here also
   skips the warp element and the per-pointer-move variable writes for them. */
const liquidGlassActive = computed(
  () =>
    isStandard.value &&
    (settings.value.surfaceMaterial === 'liquidGlass' || settings.value.liquidGlass.playbarEnabled)
)
/**
 * Which controls this shape puts in each region, resolved through the shared
 * layout contract. The class names are fixed (`player-left` / `player-center` /
 * `player-right`): the six preset theme layouts and this component's own
 * stylesheet both address the bar through them, so only the contents move.
 */
const barRegions = computed(() => {
  const regions = resolvePlayerBarRegions(settings.value.playerBar.layout, props.mode)
  return PLAYER_BAR_REGION_NAMES.map((name: PlayerBarRegionName) => ({
    name,
    className: `player-${name}`,
    // The left rail still remounts on track change — that remount is what fixed
    // stale covers — so its key carries the track identity, not just the region.
    key: name === 'left' ? `left:${playerLeftKey.value}` : name,
    items: regions[name]
  }))
})

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
  const enabled = await window.api.desktopLyrics.setEnabled(!desktopLyricsOn.value)
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
  window.api.desktopLyrics.onEnabledChanged((enabled: boolean) => {
    desktopLyricsOn.value = enabled
  })
  window.api.desktopLyrics.onLoadFailed?.((payload) => {
    desktopLyricsOn.value = false
    console.error('[desktop-lyrics] load failed', payload.code, payload.description)
  })
}

const emit = defineEmits<{
  clickCover: [rect: { x: number; y: number; w: number; h: number }]
  exitPlayingPage: []
  openSettings: []
  openDsp: []
  openEqualizer: []
  openArtist: []
}>()

function onArtistClick(): void {
  if (props.preview || !currentTrack.value?.artist.trim()) return
  emit('openArtist')
}

/**
 * A function ref, because the cover now renders inside the region `v-for` and a
 * string `ref` there would collect into an array instead of the element.
 */
function setCoverRef(element: Element | ComponentPublicInstance | null): void {
  coverRef.value = element instanceof HTMLElement ? element : null
}

/** The now-playing page zooms out of whatever was clicked, so pass its rect. */
function emitOpenPlayingPage(origin: HTMLElement | null): void {
  if (origin) {
    const r = origin.getBoundingClientRect()
    emit('clickCover', { x: r.left, y: r.top, w: r.width, h: r.height })
    return
  }
  emit('clickCover', { x: 24, y: window.innerHeight - 60, w: 48, h: 48 })
}

function onCoverClick(): void {
  emitOpenPlayingPage(coverRef.value)
}

/**
 * The cover is the way into the now-playing page, but an arrangement can leave
 * it out — compact's default does, and any shape can have it removed — which
 * would strand the page behind no entry point at all. The title takes the role
 * over exactly when no region placed a cover, so there is always one way in and
 * never two competing ones.
 */
const trackTitleOpensPlayingPage = computed(
  () => !props.preview && !barRegions.value.some((region) => region.items.includes('cover'))
)

function onTrackTitleClick(event: Event): void {
  if (!trackTitleOpensPlayingPage.value) return
  emitOpenPlayingPage(event.currentTarget instanceof HTMLElement ? event.currentTarget : null)
}

function onProgressInput(event: Event): void {
  if (isLiveStream.value) return
  const target = event.target as HTMLInputElement
  seek(Number(target.value))
}

/**
 * The flat rails carry a 0..1 ratio so their width never has to match the
 * timeline. Shared by mini's long middle rail and compact's top-edge hairline.
 */
function onFlatRailInput(event: Event): void {
  if (isLiveStream.value) return
  const target = event.target as HTMLInputElement
  const seconds = resolveSeekTargetSeconds(Number(target.value), effectiveDuration.value)
  if (seconds === null) return
  seek(seconds)
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
  transform: `scaleX(${Math.min(100, Math.max(0, smoothedProgressPercent.value)) / 100})`
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

const queueAddToPlaylist = useQueueAddToPlaylist({
  queue,
  playlists: localPlaylists,
  mediaProviders,
  addTracksToPlaylist,
  createPlaylistWithTracks,
  notify: (notice) => {
    pushNotice({ kind: notice.kind, message: notice.message })
  },
  syncProviders: async () => {
    if (typeof window !== 'undefined' && window.api?.providers) await syncPluginProviders()
  }
})

/** One prop for the remote section; null keeps it out of the dialog entirely. */
const queueAddToPlaylistProvider = computed(() =>
  queueAddToPlaylist.providerId.value === null
    ? null
    : {
        name: queueAddToPlaylist.providerName.value,
        writable: queueAddToPlaylist.providerWritable.value,
        canCreate: queueAddToPlaylist.providerCanCreate.value,
        playlists: queueAddToPlaylist.providerPlaylists.value,
        loading: queueAddToPlaylist.providerLoading.value,
        error: queueAddToPlaylist.providerError.value
      }
)

const {
  volumeOpen,
  playlistOpen,
  moreOpen,
  floatingPanelOpen,
  dismissFloatingPanels,
  toggleVolume,
  togglePlaylist,
  toggleMore
} = useFloatingPanels(playerBarShellRef, {
  // The picker is teleported to `body`, so its clicks read as "outside the bar".
  isDismissBlocked: () => queueAddToPlaylist.open.value
})

/*
 * The lyrics customizer opens as a left-edge drawer over the now-playing lyrics,
 * and this deck occupies the right of the same window — right where the lyrics
 * being tuned are. While it is open the deck stands down: still mounted (the
 * customizer is Teleported from inside it), just invisible and click-through.
 */
const lyricsCustomizerActive = ref(false)

watch(moreOpen, (open) => {
  if (open) void playbackBookmarks.ensureLoaded()
  // Closing the deck by any route (outside click, toggle, Esc) leaves no deck to
  // stand down, so drop the flag rather than trusting the child's teardown.
  if (!open) lyricsCustomizerActive.value = false
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

/** The settings preview always shows the bar, whatever the live state resolves to. */
const fullyHidden = computed(() => props.hiddenBar && !props.preview)
// Fully hidden wins, so the pointer listeners never arm for a bar that has no
// reveal gesture. `resolvePlayerBarPresentation` already keeps the two flags
// exclusive; this holds even if a caller forwards both.
const autoHideActive = computed(() => props.autoHide && !fullyHidden.value && !props.preview)

const {
  favoriteButtonVisible,
  favoriteButtonLiked,
  favoriteButtonLoading,
  favoriteButtonTitle,
  toggleFavorite
} = useFavoriteButton({
  currentTrack,
  playlists: localPlaylists,
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
  shuffle: '随机播放',
  heart: '心动模式'
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
// The reason-code labels used to be an inline map here, unreachable from
// Settings or the diagnostics export — and five codes the native engine actually
// emits (dop_marker_mismatch, native_dsd_runtime_unproven,
// native_dsd_typed_callback_missing, unsupported_asio_sample_type,
// topology_rollback_failed) had no entry at all, so they surfaced as raw English
// identifiers. They now resolve through the shared registry, which a repository
// gate keeps in step with the C++ sources.
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
  if (code) {
    const resolved = resolveReasonCode(locale.value, code)
    if (resolved.known) return resolved.label
  }
  const capabilityReason = outputInfo.value?.capabilityReason?.trim() || ''
  if (capabilityReason) return capabilityReason
  return formatPerfectReason(
    outputInfo.value?.perfectReason || playbackInfo.value?.perfectReason || ''
  )
}

/**
 * The full explanation behind the current non-perfect state: what is happening
 * and what to do about it. The registry has carried this copy all along; the
 * chip tooltips only ever showed the one-line label.
 */
const perfectReasonDetail = computed(() => {
  const code = outputInfo.value?.perfectReasonCode || playbackInfo.value?.perfectReasonCode || ''
  if (!code) return null
  const resolved = resolveReasonCode(locale.value, code)
  return resolved.known ? resolved : null
})

/**
 * The engine's own one-line cause (route decision, negotiation or probe
 * detail). Shown under the registry copy as evidence; hidden when it merely
 * restates the label and truncated so a driver essay cannot blow up the deck.
 */
const perfectReasonEngineDetail = computed(() => {
  const raw = (outputInfo.value?.perfectReason || playbackInfo.value?.perfectReason || '').trim()
  if (!raw) return ''
  const code = outputInfo.value?.perfectReasonCode || playbackInfo.value?.perfectReasonCode || ''
  const resolved = code ? resolveReasonCode(locale.value, code) : null
  if (resolved?.known && resolved.label === raw) return ''
  return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw
})

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
  const base = `Underrun ${diagnostics.sessionUnderrunCount} · Drop ${diagnostics.sessionBufferDropCount} · Restart ${diagnostics.driverRestartCount} · Lost ${diagnostics.deviceLostCount} · Recovery ${diagnostics.sessionRecoveryCount}`
  // 驱动瞬时负载事件不会重启流，只在真的发生过时才追加，避免给正常播放增加噪音字段。
  const xrun = diagnostics.driverXrunCount ?? 0
  return xrun > 0 ? `${base} · Xrun ${xrun}` : base
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

async function onReloadLyrics(prefer: 'auto' | 'local' | 'amll' | 'provider'): Promise<void> {
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
    selection === 'amll' ||
    selection === 'provider' ||
    selection === 'manual'
  ) {
    return selection
  }
  const source = managedLyricOverride.value?.source
  return source === 'local' || source === 'amll' || source === 'provider' || source === 'manual'
    ? source
    : 'automatic'
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

/**
 * The player bar has direct pointer events, so it never needs a window-wide
 * listener. This avoids running hit tests while the cursor moves anywhere else in
 * the app and limits expensive glass repaints to the active bar.
 */
const playerBarRef = ref<HTMLElement | null>(null)
let glassPointerEnabled = false
let glassPointerOverBar = false
let glassPointerRect: DOMRect | null = null
let glassPointerElasticity = 0

function writeGlassPointerVariables(variables: ReturnType<typeof pointerCssVariables>): void {
  const element = playerBarRef.value
  if (!element) return
  for (const [name, value] of Object.entries(variables)) {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value)
  }
}

function readGlassPointerElasticity(): number {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--te-lg-elasticity').trim()
  )
  return Number.isFinite(value) ? value : 0
}

const glassPointerFrames = createFrameCoalescer<{ x: number; y: number }>(
  (point) => {
    const element = playerBarRef.value
    if (!element || !glassPointerEnabled || !glassPointerOverBar) return
    // The player bar does not move while its controls are used. Reuse its geometry
    // until the pointer leaves instead of reading layout every animation frame.
    const rect = glassPointerRect ?? element.getBoundingClientRect()
    glassPointerRect = rect
    writeGlassPointerVariables(
      pointerCssVariables(
        resolvePointerOffset(point.x, point.y, {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        }),
        glassPointerElasticity
      )
    )
  },
  { minIntervalMs: LIQUID_GLASS_POINTER_FRAME_INTERVAL_MS }
)

function resetGlassPointer(): void {
  glassPointerFrames.cancel()
  glassPointerOverBar = false
  glassPointerRect = null
  writeGlassPointerVariables(staticPointerCssVariables())
}

function onGlassPointerMove(event: PointerEvent): void {
  if (!glassPointerEnabled) return
  if (!glassPointerOverBar) {
    glassPointerOverBar = true
    glassPointerRect = null
    glassPointerElasticity = readGlassPointerElasticity()
  }
  glassPointerFrames.schedule({ x: event.clientX, y: event.clientY })
}

function setGlassPressOrigin(event: PointerEvent): void {
  const element = playerBarRef.value
  if (!element || !liquidGlassActive.value) return
  const rect = element.getBoundingClientRect()
  element.style.setProperty('--te-lg-press-x', `${event.clientX - rect.left}px`)
  element.style.setProperty('--te-lg-press-y', `${event.clientY - rect.top}px`)
  if (event.button !== 0) return
  stopGlassPress()
  glassPress.press()
  window.addEventListener('pointerup', onGlassPressReleaseEvent, { passive: true })
  window.addEventListener('pointercancel', onGlassPressReleaseEvent, { passive: true })
  if (!motionAllowsPointer()) {
    writeGlassPressVariables(LIQUID_GLASS_PRESS_TARGET_SCALE)
    return
  }
  glassPressLastTime = 0
  glassPressFrame = requestAnimationFrame(tickGlassPress)
}

/* Press "squish": the bar compresses toward the press point on the shared press
   spring and relaxes on release. One rAF loop runs while a press is in flight;
   the release listeners are window-level so a press that ends off-bar still
   settles. */

const glassPress = new LiquidGlassPressController()
let glassPressFrame: number | null = null
let glassPressLastTime = 0

function writeGlassPressVariables(scale: number): void {
  const element = playerBarRef.value
  if (!element) return
  for (const [name, value] of Object.entries(liquidGlassPressCssVariables(scale))) {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value)
  }
}

function tickGlassPress(now: number): void {
  glassPressFrame = null
  const step = glassPressLastTime > 0 ? Math.min(0.05, (now - glassPressLastTime) / 1000) : 1 / 60
  glassPressLastTime = now
  const state = glassPress.update(step)
  writeGlassPressVariables(state.scale)
  if (state.settled && !glassPress.isPressed()) {
    stopGlassPress()
    return
  }
  if (!state.settled) glassPressFrame = requestAnimationFrame(tickGlassPress)
}

function stopGlassPress(): void {
  if (glassPressFrame !== null) {
    cancelAnimationFrame(glassPressFrame)
    glassPressFrame = null
  }
  glassPressLastTime = 0
  const element = playerBarRef.value
  if (element) {
    element.style.removeProperty('--te-lg-press-scale')
    element.style.removeProperty('--te-lg-press-glow')
  }
}

function onGlassPressReleaseEvent(): void {
  window.removeEventListener('pointerup', onGlassPressReleaseEvent)
  window.removeEventListener('pointercancel', onGlassPressReleaseEvent)
  if (!glassPress.isPressed()) return
  glassPress.release()
  if (!motionAllowsPointer()) {
    stopGlassPress()
    return
  }
  if (glassPressFrame === null) {
    glassPressLastTime = 0
    glassPressFrame = requestAnimationFrame(tickGlassPress)
  }
}

function onGlassPointerLeave(): void {
  if (!glassPointerEnabled || !glassPointerOverBar) return
  resetGlassPointer()
}

function motionAllowsPointer(): boolean {
  const mode = document.documentElement.dataset.teMotion ?? 'full'
  return mode !== 'reduced' && mode !== 'off'
}

function syncGlassPointer(): void {
  const shouldTrack =
    liquidGlassActive.value &&
    settings.value.liquidGlass.followPointer &&
    !props.preview &&
    motionAllowsPointer()

  if (shouldTrack === glassPointerEnabled) return
  glassPointerEnabled = shouldTrack
  if (!shouldTrack) resetGlassPointer()
}

watch(
  () => [
    liquidGlassActive.value,
    settings.value.liquidGlass.followPointer,
    settings.value.liquidGlass.light.elasticity,
    settings.value.liquidGlass.dark.elasticity,
    settings.value.theme
  ],
  () => {
    if (glassPointerOverBar) glassPointerElasticity = readGlassPointerElasticity()
    syncGlassPointer()
  },
  { flush: 'post' }
)

const {
  revealed: playbarRevealed,
  flashReveal,
  onBarPointerEnter,
  onBarPointerLeave,
  onBarFocusIn,
  onBarFocusOut
} = usePlaybarAutoHide({
  autoHide: autoHideActive,
  revealThresholdPx: computed(() => settings.value.playerBar.revealThresholdPx),
  hideDelayMs: computed(() => settings.value.playerBar.hideDelayMs),
  keepOpen: floatingPanelOpen,
  barRef: playerBarRef
})

/**
 * Both features want the bar's pointerleave: auto-hide arms its hide timer, and
 * liquid glass releases the refraction offset. Neither reads the event, so the
 * order does not matter -- they just both have to run.
 */
function onBarPointerLeaveWithGlass(): void {
  onBarPointerLeave()
  onGlassPointerLeave()
}

const playbarHidden = computed(
  () => fullyHidden.value || (autoHideActive.value && !playbarRevealed.value)
)

/**
 * Surface the resolved state on the shell. The two geometry consumers
 * (side-menu clearance, now-playing lyric centering) measure `.player-bar-shell`
 * and a transformed bar keeps its layout height, so they need this to tell a
 * hidden bar from a present one.
 *
 * `data-te-playbar-visibility` separates the two ways of being hidden: auto-hide
 * tucks the bar away behind a transform it can slide back from, while `hidden`
 * takes it out of hit-testing and the tab order entirely.
 */
const shellDataAttrs = computed(() => ({
  'data-te-playbar-mode': props.mode,
  'data-te-playbar-hidden': playbarHidden.value ? 'true' : 'false',
  'data-te-playbar-visibility': fullyHidden.value ? 'hidden' : 'auto'
}))

// A track change or play/pause is feedback the user asked for; surface it briefly
// even when the pointer is nowhere near the bottom edge.
watch(
  () => [currentTrack.value?.id, isPlaying.value],
  () => flashReveal()
)

const geometryAnimating = ref(false)
let geometryAnimTimer: number | null = null
watch(
  () => props.menuOpen,
  () => {
    geometryAnimating.value = true
    if (geometryAnimTimer !== null) window.clearTimeout(geometryAnimTimer)
    geometryAnimTimer = window.setTimeout(() => {
      geometryAnimating.value = false
      geometryAnimTimer = null
    }, 340)
  }
)

onMounted(() => {
  if (!props.preview) void syncExtensions()
  syncGlassPointer()
})

onBeforeUnmount(() => {
  if (geometryAnimTimer !== null) window.clearTimeout(geometryAnimTimer)
  geometryAnimTimer = null
  glassPointerEnabled = false
  resetGlassPointer()
  window.removeEventListener('pointerup', onGlassPressReleaseEvent)
  window.removeEventListener('pointercancel', onGlassPressReleaseEvent)
  glassPress.reset()
  stopGlassPress()
})
</script>

<template>
  <div
    v-if="currentTrack"
    ref="playerBarShellRef"
    class="player-bar-shell"
    :class="{
      'menu-open': menuOpen,
      'is-geometry-animating': geometryAnimating
    }"
    v-bind="shellDataAttrs"
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
                    title="添加到歌单"
                    :aria-label="`将 ${item.title} 添加到歌单`"
                    @click="queueAddToPlaylist.openForEntry(item.queueEntryId)"
                  >
                    <i class="pi pi-list-check" aria-hidden="true"></i>
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

    <QueueAddToPlaylistDialog
      :open="queueAddToPlaylist.open.value"
      :target-label="queueAddToPlaylist.targetLabel.value"
      :local-playlists="queueAddToPlaylist.localPlaylists.value"
      :provider="queueAddToPlaylistProvider"
      :error-message="queueAddToPlaylist.errorMessage.value"
      :busy-target="queueAddToPlaylist.busyTarget.value"
      :create-scope="queueAddToPlaylist.createScope.value"
      :new-playlist-name="queueAddToPlaylist.newPlaylistName.value"
      @update:new-playlist-name="queueAddToPlaylist.newPlaylistName.value = $event"
      @close="queueAddToPlaylist.close"
      @start-create="queueAddToPlaylist.startCreate"
      @cancel-create="queueAddToPlaylist.cancelCreate"
      @confirm-create="queueAddToPlaylist.confirmCreate"
      @reload-provider="queueAddToPlaylist.reloadProviderPlaylists"
      @add-local="queueAddToPlaylist.addToLocalPlaylist"
      @add-provider="queueAddToPlaylist.addToProviderPlaylist"
    />

    <!-- PlayerBar 主体 -->
    <div
      ref="playerBarRef"
      class="player-bar"
      :class="{
        'player-bar-glass': glass,
        'player-bar-liquid': liquidGlassActive,
        'player-bar-mini': isMini,
        'player-bar-compact': isCompact,
        'player-bar-compact-visualizer': showCompactVisualizer
      }"
      :style="{
        '--accent-color': dominantColor,
        '--play-button-color': playButtonColor
      }"
      @pointerenter="onBarPointerEnter"
      @pointerdown="setGlassPressOrigin"
      @pointermove="onGlassPointerMove"
      @pointerleave="onBarPointerLeaveWithGlass"
      @focusin="onBarFocusIn"
      @focusout="onBarFocusOut"
    >
      <!-- Refracting layer. Absolute so it stays out of the grid flow, and behind
           content so controls and text are never displaced by the filter. -->
      <span v-if="liquidGlassActive" class="player-bar-warp" aria-hidden="true"></span>

      <CompactPlayerBarVisualizer
        v-if="showCompactVisualizer"
        :spectrum="visualizationData.spectrum"
        :waveform="visualizationData.waveform"
        :active="visualizationData.active"
        :playing="isPlaying"
      />

      <!-- 紧凑形态的进度读数：贴着播放条顶边的一条细线。它属于形态固有 chrome，
           不参与区域编排——三种形态的进度呈现差异太大（标准内联、迷你中列长轨、
           紧凑顶边通栏），做成可搬运的控件只会得到渲染不出来的编排。 -->
      <div v-if="isCompact" class="compact-progress-rail">
        <div class="compact-progress-track" aria-hidden="true">
          <div class="compact-progress-fill" :style="progressFillStyle"></div>
        </div>
        <input
          type="range"
          class="compact-progress-slider"
          @input="onFlatRailInput"
          min="0"
          max="1"
          step="0.0005"
          :value="effectiveDuration > 0 ? currentTime / effectiveDuration : 0"
          :disabled="isLiveStream || effectiveDuration <= 0"
          aria-label="播放进度"
          :aria-valuetext="
            isLiveStream ? 'LIVE' : `${formatTime(currentTime)} / ${formatTime(effectiveDuration)}`
          "
        />
      </div>

      <!-- 三个区域的类名固定为 player-left / player-center / player-right：本组件的
           样式表和 assets/theme-layouts/ 里的 6 套预设布局都按这三个类名改写播放
           条，所以只有装在里面的东西会动。装什么、什么顺序由
           shared/playerBarLayout.ts 的编排决定。

           下面那条 v-if / v-else-if 链故意不夹注释——每个分支的类名已经说明了它
           是什么，而分支之间插节点是最容易把链拆断的写法。 -->
      <div
        v-for="region in barRegions"
        :key="region.key"
        :class="region.className"
        :data-te-playbar-region="region.name"
      >
        <template v-for="control in region.items" :key="control">
          <div
            v-if="control === 'cover'"
            :ref="setCoverRef"
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

          <div v-else-if="control === 'trackInfo'" class="player-track-info">
            <div class="player-title-row">
              <!-- The cover slot is the usual way into the now-playing page, but a
                   shape can leave it out — compact does by default. Rather than
                   stranding those arrangements with no way in, the title takes the
                   entry over exactly when no cover is placed, so every bar has one
                   and no bar has two. -->
              <div v-if="!trackTitleOpensPlayingPage" class="player-title">
                {{ currentTrack.title }}
              </div>
              <button
                v-else
                type="button"
                class="player-title player-title-button"
                data-te-interactive
                title="打开播放页面"
                @click="onTrackTitleClick"
              >
                {{ currentTrack.title }}
              </button>
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
              v-if="streamNowPlaying && isLiveStream && !isMini"
              class="player-stream-now-playing"
              :title="streamNowPlaying"
            >
              {{ streamNowPlaying }}
            </div>
          </div>

          <div v-else-if="control === 'transport'" class="player-controls">
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

          <button
            v-else-if="control === 'playPause'"
            type="button"
            class="mini-play-button"
            :class="{ 'is-playing': isPlaying }"
            :title="isPlaying ? '暂停' : '播放'"
            :aria-label="isPlaying ? '暂停' : '播放'"
            @click="togglePlay"
          >
            <i :class="isPlaying ? 'pi pi-pause' : 'pi pi-play'" aria-hidden="true"></i>
          </button>

          <span
            v-else-if="control === 'time'"
            class="player-time-readout"
            :aria-label="
              isLiveStream
                ? '实时流媒体'
                : `已播放 ${formatTime(currentTime)}，共 ${formatTime(effectiveDuration)}`
            "
          >
            {{
              isLiveStream ? 'LIVE' : `${formatTime(currentTime)}/${formatTime(effectiveDuration)}`
            }}
          </span>

          <button
            v-else-if="control === 'favorite' && favoriteButtonVisible"
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
            v-else-if="control === 'playMode'"
            class="ctrl-btn mode-btn-right player-misc-icon"
            :class="{ 'heart-mode-active': playMode === 'heart' }"
            :title="modeTitle"
            :aria-label="modeTitle"
            @click="cyclePlayMode"
          >
            <img v-if="playMode === 'sequential'" :src="sequentialIcon" alt="顺序" />
            <img v-else-if="playMode === 'listLoop'" :src="listLoopIcon" alt="列表循环" />
            <img v-else-if="playMode === 'repeat'" :src="repeatIcon" alt="单曲循环" />
            <img v-else-if="playMode === 'heart'" :src="heartModeIcon" alt="心动模式" />
            <img v-else :src="shuffleIcon" alt="随机" />
          </button>

          <div
            v-else-if="control === 'volume'"
            class="volume-anchor player-misc-icon"
            @wheel="onVolumeWheel"
          >
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
            v-else-if="control === 'queue'"
            class="icon-btn track-menu-button"
            :class="{ active: playlistOpen }"
            title="播放列表"
            aria-label="播放列表"
            @click="togglePlaylist"
          >
            <i class="pi pi-list"></i>
          </button>

          <button
            v-else-if="control === 'hifi'"
            class="icon-btn player-misc-icon hifi-toggle-button"
            :class="{ active: moreOpen }"
            title="HiFi 控制台"
            aria-label="HiFi 控制台"
            @click="toggleMore"
          >
            <i class="ph ph-faders"></i>
          </button>

          <button
            v-else-if="control === 'equalizer'"
            class="icon-btn equalizer-btn player-misc-icon"
            title="均衡器"
            aria-label="均衡器"
            @click="openEqualizerPage"
          >
            <i class="ph ph-sliders" aria-hidden="true"></i>
          </button>

          <button
            v-else-if="control === 'desktopLyrics'"
            class="icon-btn desktop-lyrics-btn player-misc-icon"
            :class="{ active: desktopLyricsOn }"
            title="桌面歌词"
            aria-label="桌面歌词"
            :aria-pressed="desktopLyricsOn"
            @click="toggleDesktopLyrics"
          >
            <span class="desktop-lyrics-icon" aria-hidden="true">词</span>
          </button>

          <button
            v-else-if="control === 'miniPlayer'"
            class="icon-btn mini-player-btn player-misc-icon"
            title="切换到迷你播放器"
            aria-label="切换到迷你播放器"
            :disabled="miniPlayerOpening"
            @click="openMiniPlayer"
          >
            <i
              :class="miniPlayerOpening ? 'pi pi-spin pi-spinner' : 'ph ph-picture-in-picture'"
            ></i>
          </button>

          <button
            v-else-if="control === 'exitPlayingPage' && glass"
            type="button"
            class="icon-btn playing-page-exit-button"
            title="退出播放页"
            aria-label="退出播放页"
            @click="emit('exitPlayingPage')"
          >
            <i class="ph ph-arrows-out-simple" aria-hidden="true"></i>
          </button>
        </template>

        <!-- 形态固有 chrome，永远排在编排出来的控件之后。迷你条 40px 高，塞不下
             续播提示，所以它在迷你形态里仍然不渲染——和这套编排之前的行为一致。 -->
        <div
          v-if="region.name === 'center' && activeResumeOffer && !isMini"
          class="resume-offer"
          role="status"
        >
          <span class="resume-offer__text"
            >从 {{ formatTime(activeResumeOffer.positionSeconds) }} 继续</span
          >
          <button type="button" class="resume-offer__action" @click="onAcceptResume">继续</button>
          <button type="button" class="resume-offer__dismiss" @click="onDismissResume">忽略</button>
        </div>
        <div
          v-if="region.name === 'center' && isStandard"
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
        <div v-if="region.name === 'center' && isMini" class="mini-progress-rail">
          <div class="mini-progress-track" aria-hidden="true">
            <div class="mini-progress-fill" :style="progressFillStyle"></div>
          </div>
          <span class="mini-progress-time" aria-hidden="true">
            {{
              isLiveStream
                ? 'LIVE'
                : `${formatTime(currentTime)} / ${formatTime(effectiveDuration)}`
            }}
          </span>
          <input
            type="range"
            class="mini-progress-slider"
            @input="onFlatRailInput"
            min="0"
            max="1"
            step="0.0005"
            :value="effectiveDuration > 0 ? currentTime / effectiveDuration : 0"
            :disabled="isLiveStream || effectiveDuration <= 0"
            aria-label="播放进度"
            :aria-valuetext="
              isLiveStream
                ? 'LIVE'
                : `${formatTime(currentTime)} / ${formatTime(effectiveDuration)}`
            "
          />
        </div>
      </div>
    </div>

    <!-- HiFi 右侧覆盖面板 -->
    <Transition name="hifi-overlay">
      <div
        v-if="moreOpen"
        class="hifi-overlay"
        :class="{ glass, 'is-lyrics-customizing': lyricsCustomizerActive }"
      >
        <HiFiSidebar
          :glass="glass"
          :accent-color="playButtonColor"
          :exclusive-mode="exclusiveMode"
          :exclusive-available="exclusiveAvailable"
          :audio-output="audioOutput"
          :audio-output-options="audioOutputOptions"
          :audio-device="audioDevice"
          :audio-device-options="audioOutputDeviceOptions"
          :audio-processing="audioProcessing"
          :audio-output-config="audioOutputConfig"
          :dsp-output-stage="dspOutputStage"
          :dsp-stereo-image="dspStereoImage"
          :dsp-active="playbackInfo?.dspActive === true"
          :actual-sample-rate="outputInfo?.actualSampleRate || playbackInfo?.actualSampleRate || 0"
          :status-chips="audioStatusChips"
          :non-perfect-reason="nonPerfectReason"
          :perfect-reason-code="perfectReasonCode"
          :perfect-reason-explain="perfectReasonDetail?.explain || ''"
          :perfect-reason-fix="perfectReasonDetail?.fix || ''"
          :perfect-reason-engine-detail="perfectReasonEngineDetail"
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
          @lyrics-customizing="lyricsCustomizerActive = $event"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped src="./player-bar/PlayerBar.css"></style>
