import {
  shallowRef,
  ref,
  computed,
  watch as vueWatch,
  effectScope,
  type Ref,
  type ComputedRef,
  type WatchStopHandle
} from 'vue'
import { shouldApplyNativeTimePosition } from './playerProgressPolicy.ts'
import type { PlaybackSession, Track } from '../types/music'
import type {
  AudioDeviceOption,
  AudioOutputId,
  AudioOutputOption,
  AudioProcessingSettings,
  OutputConfig,
  OutputConfigApplyStatus,
  PlaybackResumeMode,
  PlayMode
} from '../types/settings'
import {
  DEFAULT_DSP_OUTPUT_STAGE,
  DEFAULT_DSP_STEREO_IMAGE,
  extractStereoImageFromGraph,
  mergeDspOutputStage,
  type DspOutputStageConfig,
  type DspStereoImageConfig
} from '../../../shared/dspGraph.ts'
import { extractDominantColor } from '../utils/colorExtractor'
import { resolveCover } from '../utils/coverLoader'
import { normalizeNativePlaybackInfo } from '../utils/playerPlaybackInfo.ts'
import { clampSoftwareVolume, cloneAudioProcessingSettings } from '../utils/playerAudioSettings.ts'
import {
  NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS,
  NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS,
  NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS,
  PLAYBACK_TOGGLE_INTENT_GRACE_MS,
  RENDERER_PLAYBACK_WATCHDOG_MS,
  START_FILE_PLAYBACK_INFO_REFRESH_ATTEMPTS,
  START_FILE_PLAYBACK_INFO_REFRESH_DELAY_MS
} from '../utils/playerConstants.ts'
import { shuffleArray } from '../utils/playerQueueUtils.ts'
import { formatTime, getNowMs } from '../utils/playerTime.ts'
import type { PlaybackClockSnapshot } from '../utils/playbackSessionClock.ts'
import {
  cachedSourceMatchesTrack,
  getTrackAudioSource,
  getTrackSource,
  hasAnalyzedBpm,
  isAnalyzableAudioPath,
  isLikelyLocalFilePath,
  isStreamLikeTrack,
  mergeTrackTransientData,
  nonEmptyString
} from '../utils/playerTrackUtils.ts'
import {
  shouldReuseResolvedStreamUrl,
  shouldUseNativePlaybackTarget
} from '../utils/playbackRouting'
import {
  NCM_STREAM_URL_MAX_AGE_MS,
  preparePlayerNativeQueue,
  stripStaleNcmStreamUrls
} from '../utils/nativeQueuePreparation.ts'
import {
  NativeQueueRevisionFence,
  synchronizeLatestNativeQueue
} from '../utils/nativeQueueRevision.ts'
import {
  toPlaybackQueueSnapshot,
  toPlaybackQueueSnapshots
} from '../utils/playbackQueueVirtualization.ts'
import { clampProviderReliability, findPlaybackFallbackTrack } from '../utils/playbackFallback.ts'
import { findProviderRematchCandidate } from '../utils/libraryRepair.ts'
import { useNcmStore } from './useNcmStore.ts'
import { useLyricsManagement } from './lyricsManagement.ts'
import { usePlaybackBookmarks } from './playbackBookmarks'
import {
  getPodcastDefaultPlaybackRate,
  setPodcastDefaultPlaybackRate,
  usePodcastStore
} from './usePodcastStore.ts'
import { createPlaybackHistoryController } from './player/playbackHistoryController.ts'
import { toggleVolumeMute } from '../utils/volumeMute.ts'
import { createDebouncedVolumePersistence } from '../utils/volumePersistence.ts'
import { configurePlayerStoreHmr } from './playerStoreHmr.ts'
import {
  clampCuePlaybackPosition,
  cueDuration,
  rendererAudioAbsolutePositionForTrack,
  rendererAudioPositionForTrack
} from '../utils/cuePlayback.ts'
import {
  evaluateNativePlaybackInfoIntent,
  type NativePlaybackInfoIntent
} from '../utils/nativePlaybackInfoIntent.ts'
import { syncPluginProviders, useMediaProviders } from '../providers'
import { useSettingsStore } from './useSettingsStore'
import { useMusicStore } from './useMusicStore'
import { type SleepTimerMode, type SleepTimerState } from '../../../shared/sleepTimer.ts'
import { DEFAULT_SOFTWARE_VOLUME } from '../../../shared/audioProcessingOptions.ts'
import { presentError, presentErrorDetail } from '../../../shared/errors/presentError.ts'
import { parseAppError } from '../../../shared/errors/appError.ts'
import { translate } from '../../../shared/i18n/translate.ts'
import { currentLocale } from '../app/useLocale.ts'
import type { LyricSource } from '../../../shared/lyricsManagement.ts'
import { toNativePlayMode } from '../../../shared/playbackModes.ts'
import { deviceOptionsForOutput } from '../../../shared/audioDeviceRouting.ts'
import { createPlayerSleepTimer } from './player/usePlayerSleepTimer.ts'
import { useAppNoticeStore, type AppNoticeKind } from './useAppNoticeStore'
import { claimRendererRuntime } from './playerRuntimeOwnership.ts'
import {
  DEFAULT_AUDIO_DEVICE_OPTION,
  getFallbackAudioOutput,
  getFallbackAudioOutputOptions,
  normalizeAudioDeviceOptions,
  normalizeAudioOutputOptions
} from './player/audioOutputNormalize.ts'
import {
  createInactiveVisualizationData,
  createVisualizationPolling,
  type NativeVisualizationData
} from './player/useVisualizationPolling.ts'
import { createPlaybackClockController } from './player/playbackClockController.ts'
import { createLyricsLoader } from './player/lyricsLoaderController.ts'
import { createPlaybackSessionController } from './player/playbackSessionController.ts'
import { createPlaybackQueueController } from './player/playbackQueueController.ts'
import { createAudioOutputController } from './player/audioOutputController.ts'
import { createHeartModeController } from './player/heartModeController.ts'

type NativePlaybackInfo = Awaited<ReturnType<typeof window.api.audioEngine.getPlaybackInfo>>
type NativeOutputInfo = NativePlaybackInfo['outputInfo']
// Module state is intentionally shared by all player consumers. Vite replaces
// this module in development, so every watcher must belong to a runtime scope
// that the replacement can stop before registering its own listeners.
const playerRuntimeScope = effectScope(true)
const watch = ((...args: unknown[]): WatchStopHandle => {
  let stop: WatchStopHandle | undefined
  playerRuntimeScope.run(() => {
    stop = (vueWatch as (...parameters: unknown[]) => WatchStopHandle)(...args)
  })
  return stop!
}) as typeof vueWatch
const PLAYER_RUNTIME_OWNERSHIP_KEY = Symbol.for('twilight-echo.player-store-runtime')
type ProviderSourceReliability = Record<string, number>
export type PersonalizedStreamKey = 'fm' | 'radar'
export interface PersonalizedStreamSession {
  id: number
  key: PersonalizedStreamKey
}

interface AudioOutputState {
  output: AudioOutputId
  device: string
  exclusiveMode: boolean
  exclusiveAvailable: boolean
  outputOptions: AudioOutputOption[]
  deviceOptions: AudioDeviceOption[]
}

export interface AudioEngineRecoveryNotice {
  kind: 'service-crash' | 'service-fatal' | 'service-ready'
  message: string
  actionLabel?: string
  canResume?: boolean
}

export interface LyricsLoadState {
  trackId: string
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'failed'
}

const currentTrack = ref<Track | null>(null)
const dominantColor = ref('#1a73e8')
const coverThemeColor = ref('#1a73e8')
const themeCoverUrl = ref('')
const themeCoverIdentity = ref('')
const isPlaying = ref(false)
const isLoading = ref(false)
const lyricsLoadState = ref<LyricsLoadState>({ trackId: '', status: 'idle' })

const lyricsLoader = createLyricsLoader({
  currentTrack,
  lyricsLoadState,
  getAppSettings: () => appSettings,
  patchTrackInQueues,
  getLyricsManagement: useLyricsManagement
})

// A lyric request belongs to a particular playback activation, not merely to
// a song id. Returning to the same song after switching away must never reuse
// a suspended request that was started for the previous activation.
watch(
  () => currentTrack.value?.id ?? '',
  (trackId, previousTrackId) => {
    if (trackId === previousTrackId) return
    lyricsLoader.onTrackChanged(trackId, previousTrackId)
  },
  { flush: 'sync' }
)
const isStreamBuffering = ref(false)
/** Live ICY StreamTitle from native radio playback (empty when unavailable). */
const streamNowPlaying = ref('')
/** Last observed native sessionUnderrunCount; rise while playing stream → buffering UX. */
let lastNativeSessionUnderrunCount = 0
let nativeStreamBufferingClearTimer: ReturnType<typeof setTimeout> | null = null
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(DEFAULT_SOFTWARE_VOLUME)
const muted = ref(false)
/** Application-layer playback rate (0.5–2). 1 = realtime. */
const playbackRate = ref(1)
/** A-B loop points in seconds relative to the logical track start. Null = unset. */
const abLoopA = ref<number | null>(null)
const abLoopB = ref<number | null>(null)
const lastAudibleVolume = ref(DEFAULT_SOFTWARE_VOLUME)
let suppressVolumePersist = false
/** Active cast target display name (null when not casting). */
const castTargetName = ref<string | null>(null)
/** Active cast device id (usn); required to re-cast on queue skip. */
const castTargetUsn = ref<string | null>(null)
const sleepTimerState = ref<SleepTimerState | null>(null)
const sleepTimerNotice = ref<string | null>(null)
// Queue entries are immutable playback snapshots. Keeping this as a shallow
// array avoids proxying every nested field for a 5k/20k queue.
const queue = shallowRef<Track[]>([])
const queueIndex = ref(-1)
const playMode = ref<PlayMode>('sequential')
const originalQueue = shallowRef<Track[]>([])
const personalizedStreamSession = ref<PersonalizedStreamSession | null>(null)
const personalizedStreamRemaining = ref(0)
const personalizedStreamEntryIds = new Set<string>()
const personalizedStreamPlayedEntryIds = new Set<string>()
const audioEngineReady = ref(false)
const audioEngineError = ref<string | null>(null)
const audioEngineRecoveryNotice = ref<AudioEngineRecoveryNotice | null>(null)
const { pushNotice, dismissNotice, releaseNoticeDedupe } = useAppNoticeStore()
let audioEngineRecoveryAppNoticeId = 0
let lastAudioEngineNotice = ''

/**
 * Resolve an audio-engine error string for display.
 *
 * Every audio failure reaches the UI through `setAudioEngineError`, including the
 * 14 catch blocks that hand over a raw `err.message` from an IPC rejection.
 * Resolving here means a main-process `ipcError(...)` is translated — and its
 * `[TE-ERR:...]` tail stripped — without each catch block knowing about the codec.
 *
 * Only a sentinel-carrying message is translated. Anything else is passed through
 * verbatim rather than sent to `presentError`: that function's job is to replace
 * unrecognized *platform* English with a generic fallback, and it cannot tell our
 * own English copy from a Node error string. Running "The audio service failed to
 * start" through it under en-US produced "An unknown error occurred" — a
 * regression that zh-CN hid, because the CJK passthrough rule saved it there.
 */
function resolveAudioEngineErrorText(error: string): string {
  const parsed = parseAppError(error)
  if (parsed.code !== null) return presentError(currentLocale(), error).trim()
  return error.trim()
}

/**
 * Publish an audio-engine error to the inline banner and the toast host.
 *
 * `kind` is passed in rather than sniffed out of the message. It used to be
 * inferred by substring-matching Chinese copy ("已启用临时播放通道" and friends),
 * which silently tied severity to wording: translating the message would have
 * reclassified a recovered-with-fallback warning as a hard error. Callers know
 * which case they are in, so they say so.
 */
function setAudioEngineError(error: string | null, kind: AppNoticeKind = 'error'): void {
  const message = typeof error === 'string' ? resolveAudioEngineErrorText(error) : ''
  audioEngineError.value = message || error
  if (!message) {
    lastAudioEngineNotice = ''
    return
  }
  if (message === lastAudioEngineNotice) return
  lastAudioEngineNotice = message
  pushNotice({ kind, message })
}
const exclusiveMode = ref(false)
// Tracks whether the in-PlayingMusic audio visualizer surface is active.
// App.vue reads this to hide the PlayerBar while the visualizer is open.
const visualizerActive = ref(false)
const audioOutput = ref<AudioOutputId>(getFallbackAudioOutput())
const audioDevice = ref('auto')
const audioOutputOptions = ref<AudioOutputOption[]>(getFallbackAudioOutputOptions())
const audioDeviceOptions = ref<AudioDeviceOption[]>([DEFAULT_AUDIO_DEVICE_OPTION])
/**
 * The output-device picker's list. `audioDeviceOptions` stays merged because the
 * DSD route picker targets a second backend and needs every entry; the main output
 * picker must only offer what the selected backend can open.
 */
const audioOutputDeviceOptions = computed(() =>
  deviceOptionsForOutput(audioOutput.value, audioDeviceOptions.value)
)
const defaultAudioProcessing: AudioProcessingSettings = {
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
  eqBands: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequency) => ({
    frequency,
    gain: 0,
    q: 1,
    filterType: 'peak'
  })),
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
const audioProcessing = ref<AudioProcessingSettings>({ ...defaultAudioProcessing })
const defaultAudioOutputConfig: OutputConfig = {
  preferredBufferSize: 0,
  routingMode: 'auto',
  wasapiExclusivePushMode: false
}
const audioOutputConfig = ref<OutputConfig>({ ...defaultAudioOutputConfig })
const audioOutputConfigApplyStatus = ref<OutputConfigApplyStatus>({
  requestedRevision: 0,
  appliedRevision: 0,
  failedRevision: 0,
  state: 'idle',
  error: '',
  generation: 0
})
/** Default-scene graph.outputStage (sample-rate lock / SRC / dither). Not OutputConfig. */
const dspOutputStage = ref<DspOutputStageConfig>({ ...DEFAULT_DSP_OUTPUT_STAGE })
/** Default-scene stereoField + channelStrip polarity (HiFi balance/phase). */
const dspStereoImage = ref<DspStereoImageConfig>({ ...DEFAULT_DSP_STEREO_IMAGE })
const playbackInfo = ref<NativePlaybackInfo | null>(null)
const loudnormStatus = ref<'idle' | 'measuring' | 'cached' | 'fallback' | 'unavailable'>('idle')
const loudnormStatusSource = ref<string | null>(null)
const outputInfo = computed<NativeOutputInfo | null>(() => playbackInfo.value?.outputInfo ?? null)
// 高频（60ms）整体替换的可视化载荷不值得一层层深度代理，消费方只读快照。
const visualizationData = shallowRef<NativeVisualizationData>(createInactiveVisualizationData())
const { settings: appSettings, updateSettings } = useSettingsStore()
const lyricsManagement = useLyricsManagement()
let playbackAudio: HTMLAudioElement | null = null
let playbackObjectUrl: string | null = null
let nativePlaybackActive = false
let nativeQueueDelegated = false
/**
 * 原生引擎在授权/缓存层会把 source 解析成缓存文件或 CDN 直链，playback-info
 * 回传的 source 与渲染层队列条目的 streamUrl/filePath 可能不一致。渲染层每次
 * 实际发起播放时（loadAndPlay）都记录 source->track.id 映射，匹配 playback-info
 * 时先按 source 查映射，保证原生自动切歌后 queueIndex/currentTrack 能同步。
 */
const nativeSourceToTrackId = new Map<string, string>()
// source->track.id 只是 playback-info 匹配提示（失配时走 queueIndex+source 校验
// 回退），但授权层解析出的缓存路径/CDN 直链会让 source 每次播放都不同，只增不减
// 即无界增长。超过上限时先收紧到当前原生队列 source 集合，再按插入序淘汰旧项。
const NATIVE_SOURCE_TO_TRACK_ID_LIMIT = 1024

function pruneNativeSourceToTrackId(
  items: ReadonlyArray<{ source: string; id: string }>,
  protectedSource?: string
): void {
  if (nativeSourceToTrackId.size <= NATIVE_SOURCE_TO_TRACK_ID_LIMIT) return
  const validSources = new Set(items.map((item) => item.source))
  for (const source of nativeSourceToTrackId.keys()) {
    if (nativeSourceToTrackId.size <= NATIVE_SOURCE_TO_TRACK_ID_LIMIT) break
    if (!validSources.has(source) && source !== protectedSource) {
      nativeSourceToTrackId.delete(source)
    }
  }
  for (const source of nativeSourceToTrackId.keys()) {
    if (nativeSourceToTrackId.size <= NATIVE_SOURCE_TO_TRACK_ID_LIMIT) break
    if (source === protectedSource) continue
    nativeSourceToTrackId.delete(source)
  }
}

// —— 8.4 NCM 下一曲播放地址预取 ——
// 触发点：播放进度 ≥70% 或「next 意图」（曲目激活切换）。只预取 1 首、并发 1；
// 预取地址仅在 NCM_STREAM_URL_MAX_AGE_MS（10min）窗口内被原生队列携带——短于
// CDN 链接有效期，也尊重 twilight-media grant 的 30min 空闲 TTL。
const NCM_PREFETCH_TRIGGER_PROGRESS = 0.7
const MAX_NCM_STREAM_URL_RECORDS = 64
const ncmStreamUrlCommittedAt = new Map<string, number>()
let ncmPrefetchInFlightTrackId = ''

function rememberNcmStreamUrlCommit(trackId: string): void {
  ncmStreamUrlCommittedAt.delete(trackId)
  ncmStreamUrlCommittedAt.set(trackId, Date.now())
  while (ncmStreamUrlCommittedAt.size > MAX_NCM_STREAM_URL_RECORDS) {
    const oldest = ncmStreamUrlCommittedAt.keys().next().value
    if (oldest == null) break
    ncmStreamUrlCommittedAt.delete(oldest)
  }
}

/** 队列里的「下一首」：与 advanceAfterPlaybackEnded 的推进语义保持一致。 */
function findUpcomingQueueTrack(): Track | null {
  if (playMode.value === 'repeat' || playMode.value === 'heart') return null
  const nextIndex = queueIndex.value + 1
  if (nextIndex >= 0 && nextIndex < queue.value.length) return queue.value[nextIndex] ?? null
  if ((playMode.value === 'listLoop' || playMode.value === 'shuffle') && queue.value.length > 0) {
    return queue.value[0] ?? null
  }
  return null
}

async function prefetchUpcomingNcmStream(): Promise<void> {
  const upcoming = findUpcomingQueueTrack()
  if (!upcoming || getTrackSource(upcoming) !== 'ncm') return
  const trackId = upcoming.id
  if (ncmPrefetchInFlightTrackId) return
  const committedAt = ncmStreamUrlCommittedAt.get(trackId)
  if (committedAt != null && Date.now() - committedAt < NCM_STREAM_URL_MAX_AGE_MS) return
  ncmPrefetchInFlightTrackId = trackId
  try {
    await syncPluginProviders()
    const resolved = await useMediaProviders().resolvePlaybackUrl(upcoming, {
      quality: appSettings.value.ncmPlaybackQuality
    })
    if (!resolved) return
    // 迟到守卫：解析期间目标已不再是「下一首」时丢弃结果，绝不写共享轨状态。
    const stillUpcoming = findUpcomingQueueTrack()
    if (!stillUpcoming || stillUpcoming.id !== trackId) return
    if (/^https?:\/\//i.test(resolved)) {
      stillUpcoming.streamUrl = resolved
    }
    // 有结果（含 provider 磁盘缓存命中）即视为已预热：下次解析即时返回。
    rememberNcmStreamUrlCommit(trackId)
  } catch {
    // 预取失败静默：切曲时走正常解析与错误提示链路。
  } finally {
    if (ncmPrefetchInFlightTrackId === trackId) ncmPrefetchInFlightTrackId = ''
  }
}

const nativeQueueRevisionFence = new NativeQueueRevisionFence()
let activeLoadToken = 0
let rendererFallbackInProgress = false
let rendererPlaybackWatchdogTimer: number | null = null
let playbackToggleIntent: { playing: boolean; expiresAt: number } | null = null
let nativePlaybackInfoIntent: NativePlaybackInfoIntent | null = null
let startFilePlaybackInfoRefreshGeneration = 0
let rendererResumePlaybackInfoRefresh: Promise<void> | null = null
const bpmAnalysisRequests = new Set<string>()

function isActiveLoad(loadToken: number, track: Track): boolean {
  return loadToken === activeLoadToken && currentTrack.value?.id === track.id
}

function clearRendererPlaybackWatchdog(): void {
  if (rendererPlaybackWatchdogTimer !== null) {
    window.clearTimeout(rendererPlaybackWatchdogTimer)
    rendererPlaybackWatchdogTimer = null
  }
}

/** After an intentional next/prev/load, reject delayed previous-track snapshots. */
let intentionalTrackGuard: {
  trackId: string
  source: string
  until: number
} | null = null

function setNativePlaybackInfoIntent(
  loadToken: number,
  track: Track,
  source = '',
  targetQueueIndex = queueIndex.value
): void {
  const normalizedSource = typeof source === 'string' ? source.trim() : ''
  const now = getNowMs()
  nativePlaybackInfoIntent = {
    loadToken,
    trackId: track.id,
    queueIndex: targetQueueIndex,
    source: normalizedSource,
    expiresAt: now + NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS,
    confirmedAt: null
  }
  // Sticky guard outlives the intent so a late previous-track tick cannot flash
  // the UI after confirmation clears/expires the primary intent.
  intentionalTrackGuard = {
    trackId: track.id,
    source: normalizedSource || getTrackAudioSource(track),
    until:
      now + NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS + NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS
  }
}

function clearNativePlaybackInfoIntent(): void {
  nativePlaybackInfoIntent = null
}

function clearNativePlaybackInfoIntentForLoad(loadToken: number): void {
  if (nativePlaybackInfoIntent?.loadToken === loadToken) {
    clearNativePlaybackInfoIntent()
  }
}

function markNativePlaybackInfoIntentConfirmed(now = getNowMs()): void {
  const intent = nativePlaybackInfoIntent
  if (!intent) return
  if (intent.confirmedAt === null) intent.confirmedAt = now
  // Keep filtering non-matching snapshots through the post-confirmation window.
  intent.expiresAt = Math.max(
    intent.expiresAt,
    now + NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS
  )
  if (intentionalTrackGuard && intentionalTrackGuard.trackId === intent.trackId) {
    intentionalTrackGuard.until = Math.max(
      intentionalTrackGuard.until,
      now + NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS
    )
  }
}

function shouldIgnoreNativePlaybackInfo(info: NativePlaybackInfo, infoIndex: number): boolean {
  const indexedTrack = infoIndex >= 0 ? queue.value[infoIndex] : null
  const now = getNowMs()
  const source = typeof info.source === 'string' ? info.source.trim() : ''
  const candidateTrackId = indexedTrack?.id ?? ''

  const intent = nativePlaybackInfoIntent
  if (intent) {
    const decision = evaluateNativePlaybackInfoIntent(
      intent,
      { trackId: candidateTrackId, source },
      now,
      NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS
    )
    if (decision === 'expired') {
      clearNativePlaybackInfoIntent()
      // Fall through to sticky guard — do not immediately apply a non-matching row.
    } else if (decision === 'match') {
      markNativePlaybackInfoIntentConfirmed(now)
      return false
    } else {
      return true
    }
  }

  const guard = intentionalTrackGuard
  if (guard && now <= guard.until) {
    const matchesGuardTrack = candidateTrackId.length > 0 && candidateTrackId === guard.trackId
    const matchesGuardSource =
      source.length > 0 && (source === guard.source || source === guard.trackId)
    if (matchesGuardTrack || matchesGuardSource) return false
    // Conflicting identity while a recent intentional switch is still settling.
    if (candidateTrackId.length > 0 || source.length > 0) return true
  } else if (guard && now > guard.until) {
    intentionalTrackGuard = null
  }

  return false
}

function setPlaybackToggleIntent(playing: boolean): void {
  if (playing) clearPendingNativePause()
  playbackToggleIntent = {
    playing,
    expiresAt: getNowMs() + PLAYBACK_TOGGLE_INTENT_GRACE_MS
  }
}

function clearPlaybackToggleIntent(): void {
  playbackToggleIntent = null
}

function applyNativePlayingState(playing: boolean, pausePosition: number | null = null): void {
  if (playbackToggleIntent) {
    if (getNowMs() > playbackToggleIntent.expiresAt) {
      clearPlaybackToggleIntent()
    } else if (playing !== playbackToggleIntent.playing) {
      // Drop stale pause/playback-info that still reflects the pre-toggle state.
      // Clearing the intent immediately after togglePause re-opened this race and
      // made the play/pause button briefly flip back before settling.
      return
    }
    // Matching confirmation: apply UI state but keep the intent until grace
    // expires so later out-of-order ticks cannot reverse the button again.
  }

  if (playing) {
    clearPendingNativePause()
    isPlaying.value = true
    publishPlaybackClockTransport('playing', playbackRate.value)
    return
  }

  if (
    pausePosition !== null &&
    isPlaying.value &&
    nativePlaybackActive &&
    playbackToggleIntent?.playing !== false
  ) {
    deferNativePause(pausePosition)
    return
  }

  clearPendingNativePause()
  isPlaying.value = playing
  publishPlaybackClockTransport('paused', playbackRate.value)
}

function scheduleRendererPlaybackWatchdog(track: Track, loadToken: number): void {
  clearRendererPlaybackWatchdog()
  rendererPlaybackWatchdogTimer = window.setTimeout(async () => {
    rendererPlaybackWatchdogTimer = null
    if (!isActiveLoad(loadToken, track) || nativePlaybackActive) return

    const audio = playbackAudio
    if (!audio || !audio.src || !audio.paused || audio.ended) return

    try {
      await stopNativeAudio()
      await audio.play()
    } catch (err) {
      if (!isActiveLoad(loadToken, track)) return
      console.warn('[audio-engine] Renderer playback watchdog retry failed:', err)
    }
  }, RENDERER_PLAYBACK_WATCHDOG_MS)
}

function getPlaybackAudio(): HTMLAudioElement {
  if (playbackAudio) return playbackAudio

  const audio = new Audio()
  audio.preload = 'auto'
  audio.volume = volume.value
  applyPlaybackRateToHtmlAudio(audio)

  audio.addEventListener('loadedmetadata', () => {
    if (currentTrack.value?.cueRange) {
      duration.value = cueDuration(currentTrack.value)
    } else if (Number.isFinite(audio.duration) && audio.duration > 0) {
      duration.value = audio.duration
    }
    publishPlaybackClockDuration(duration.value)
  })

  audio.addEventListener('timeupdate', () => {
    if (Number.isFinite(audio.currentTime)) {
      const track = currentTrack.value
      const position = rendererAudioPositionForTrack(audio.currentTime, track)
      applyPlaybackPositionSample(position, 'html-audio')
      if (track?.cueRange && audio.currentTime >= track.cueRange.endSeconds) {
        audio.pause()
        audio.currentTime = track.cueRange.endSeconds
        setCurrentTimeImmediate(cueDuration(track))
        void handlePlaybackEnded()
        return
      }
      scheduleCrossfadeIfNeeded()
    }
  })

  audio.addEventListener('play', () => {
    isPlaying.value = true
    flushLatestCurrentTime()
  })

  audio.addEventListener('pause', () => {
    if (!audio.ended) {
      isPlaying.value = false
      flushLatestCurrentTime()
    }
  })

  audio.addEventListener('ended', () => {
    isPlaying.value = false
    void handlePlaybackEnded()
  })

  audio.addEventListener('error', () => {
    resetNativeStreamBufferingState()
    const code = audio.error?.code ?? 0
    const mediaErrorMessage = audio.error?.message?.trim() || ''
    const message = mediaErrorMessage
      ? `临时播放通道失败：${mediaErrorMessage}`
      : `临时播放通道失败（错误码 ${code}）`
    console.error('[audio-engine] Renderer audio error:', {
      code,
      message: mediaErrorMessage,
      src: audio.src ? audio.src.slice(0, 120) : ''
    })
    // Renderer (non-native) playback failed — attempt cross-source fallback
    // before surfacing the error. loadAndPlay's catch block already handles
    // failures during initial load; this covers mid-stream CDN drops / 403 /
    // decode errors that occur after playback has started.
    const track = currentTrack.value
    if (track && !nativePlaybackActive && !rendererFallbackInProgress) {
      rendererFallbackInProgress = true
      void handlePlaybackFallback(track, new Error(message), activeLoadToken).then((handled) => {
        rendererFallbackInProgress = false
        if (!handled) {
          setAudioEngineError(message)
          isPlaying.value = false
          isLoading.value = false
        }
      })
      return
    }
    setAudioEngineError(message)
    isPlaying.value = false
    isLoading.value = false
  })

  const markBuffering = (): void => {
    if (nativePlaybackActive) return
    const track = currentTrack.value
    if (!track) return
    if (
      track.source === 'radio' ||
      track.source === 'podcast' ||
      /^https?:\/\//i.test(track.filePath || '')
    ) {
      isStreamBuffering.value = true
    }
  }
  const clearBuffering = (): void => {
    isStreamBuffering.value = false
  }
  audio.addEventListener('waiting', markBuffering)
  audio.addEventListener('stalled', markBuffering)
  audio.addEventListener('canplay', clearBuffering)
  audio.addEventListener('playing', clearBuffering)
  audio.addEventListener('emptied', clearBuffering)

  playbackAudio = audio
  return audio
}

function releasePlaybackObjectUrl(): void {
  if (playbackObjectUrl) {
    URL.revokeObjectURL(playbackObjectUrl)
    playbackObjectUrl = null
  }
}

function stopRendererAudio(clearSource = false): void {
  clearRendererPlaybackWatchdog()
  if (!playbackAudio) return
  playbackAudio.pause()
  if (clearSource) {
    playbackAudio.removeAttribute('src')
    playbackAudio.load()
    releasePlaybackObjectUrl()
  }
}

function resetPlaybackRuntimeStateForRestore(): void {
  activeLoadToken += 1
  nativePlaybackActive = false
  nativeQueueDelegated = false
  loadedTrackId = ''
  playbackInfo.value = null
  clearNativePlaybackInfoIntent()
  clearPlaybackToggleIntent()
  resetPlaybackClock()
  resetNativeStreamBufferingState()
  stopVisualizationPolling(true)
  stopRendererAudio(true)
  void stopNativeAudio()
}

function seekRendererAudioWhenReady(
  audio: HTMLAudioElement,
  startTime: number,
  track: Track,
  loadToken: number
): void {
  const targetTime = clampCuePlaybackPosition(track, startTime)

  const applySeek = (): void => {
    if (!isActiveLoad(loadToken, track)) return
    try {
      audio.currentTime = rendererAudioAbsolutePositionForTrack(targetTime, track)
    } catch (err) {
      console.warn('[audio-engine] Failed to restore renderer playback position:', err)
    }
  }

  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    applySeek()
    return
  }

  audio.addEventListener('loadedmetadata', applySeek, { once: true })
}

async function stopNativeAudio(): Promise<void> {
  nativeQueueDelegated = false
  try {
    await window.api.audioEngine.stop()
  } catch {
    // The renderer audio fallback can still continue if the native bridge is unavailable.
  }
}

const playbackClockController = createPlaybackClockController({
  currentTrack,
  currentTime,
  duration,
  playbackRate,
  isPlaying,
  isLoading,
  abLoopA,
  abLoopB,
  playMode,
  getNow: getNowMs,
  getPlaybackToggleIntent: () => playbackToggleIntent,
  getAbLoopNativeActive: () => abLoopNativeActive,
  enforceAbLoop,
  isCurrentTrackLiveStream,
  applyNativePlaybackInfo
})
const {
  playbackClockSnapshot,
  clearPendingNativePause,
  deferNativePause,
  setCurrentTimeImmediate,
  anchorRendererPlaybackClock,
  beginPlaybackPositionTransition,
  applyPlaybackPositionSample,
  estimatePlaybackClockPosition,
  flushLatestCurrentTime,
  startRendererPlaybackClock,
  getLatestPlaybackTime,
  setTransport: publishPlaybackClockTransport,
  setDuration: publishPlaybackClockDuration,
  resetPlaybackClock,
  dispose: disposePlaybackClock
} = playbackClockController

const playbackSessionController = createPlaybackSessionController({
  currentTrack,
  queue,
  originalQueue,
  queueIndex,
  playMode,
  duration,
  currentTime,
  isPlaying,
  isLoading,
  sleepTimerState,
  getAppSettings: () => appSettings,
  getSleepTimerController: () => getSleepTimerController(),
  hydratePlaybackTrack,
  resetPlaybackRuntimeStateForRestore,
  setPlayModeInternal,
  loadLyricsForTrack: (track) => void lyricsLoader.ensureCurrentTrackLyricsLoaded(track),
  clearCrossfadeTimer,
  setCurrentTimeImmediate,
  clearSleepTimerIntervals: () => clearSleepTimerIntervals(),
  flushLatestCurrentTime,
  queueNativeQueueStateSync,
  deleteAutomaticLyricsBaseline: lyricsLoader.deleteLyricsBaseline,
  getRestoredPlaybackPending: () => restoredPlaybackPending,
  setRestoredPlaybackPending: (value) => {
    restoredPlaybackPending = value
  },
  getRestoredPlaybackPosition: () => restoredPlaybackPosition,
  setRestoredPlaybackPosition: (value) => {
    restoredPlaybackPosition = value
  },
  getPendingLoadStartTime: () => pendingLoadStartTime,
  setPendingLoadStartTime: (value) => {
    pendingLoadStartTime = value
  },
  getAutoAdvanceInFlight: () => autoAdvanceInFlight,
  setAutoAdvanceInFlight: (value) => {
    autoAdvanceInFlight = value
  },
  getAdvancingFromEndedTrackId: () => advancingFromEndedTrackId,
  setAdvancingFromEndedTrackId: (value) => {
    advancingFromEndedTrackId = value
  },
  getNativePlaybackActive: () => nativePlaybackActive
})
const {
  persistSelectedTrackSession,
  persistPlaybackSessionAfterQueueMutation,
  restorePlaybackSession,
  createPlaybackSession,
  removeUnavailableTracks
} = playbackSessionController

const playerSleepTimer = createPlayerSleepTimer({
  volume,
  muted,
  isPlaying,
  isLoading,
  state: sleepTimerState,
  notice: sleepTimerNotice,
  getSettings: () => useSettingsStore().settings.value.sleepTimer,
  getBridge: () => window.api?.sleepTimer,
  persistSession: persistSelectedTrackSession,
  clearCrossfade: () => clearCrossfadeTimer(),
  stopVisualization: () => stopVisualizationPolling(true),
  stopRendererAudio: () => stopRendererAudio(false),
  stopNativeAudio
})

const {
  clearIntervals: clearSleepTimerIntervals,
  getController: getSleepTimerController,
  configure: configureSleepTimer,
  cancel: cancelSleepTimer
} = playerSleepTimer

function toggleMute(): void {
  const next = toggleVolumeMute({
    volume: volume.value,
    muted: muted.value,
    lastAudibleVolume: lastAudibleVolume.value
  })
  volume.value = next.volume
  muted.value = next.muted
  lastAudibleVolume.value = next.lastAudibleVolume
}

function shouldUseNativePlayback(track: Track, target: string): boolean {
  return shouldUseNativePlaybackTarget(getTrackSource(track), target)
}

function isNativeQueueDelegated(): boolean {
  return nativeQueueDelegated
}

async function createPlayableUrl(
  target: string,
  track: Track,
  loadToken: number
): Promise<string | null> {
  // http(s)/blob/data stream directly. twilight-media:// is the granted proxy
  // scheme registered in main (protocol.handle) and allowed by media-src CSP.
  if (
    /^https?:\/\//i.test(target) ||
    /^blob:/i.test(target) ||
    /^data:/i.test(target) ||
    /^twilight-media:/i.test(target)
  ) {
    if (!isActiveLoad(loadToken, track)) return null
    releasePlaybackObjectUrl()
    return target
  }

  const fileUrl = await window.api.fs.getAudioFileUrl(target)
  if (!isActiveLoad(loadToken, track)) return null
  releasePlaybackObjectUrl()
  if (!duration.value && track.duration) {
    duration.value = track.duration
  }
  return fileUrl
}

async function playWithRendererAudio(
  track: Track,
  target: string,
  startTime: number,
  loadToken: number
): Promise<boolean> {
  const audio = getPlaybackAudio()
  audio.pause()
  // Renderer HTMLAudio is a shared-mode Windows stream. Never start it while the
  // native engine (e.g. WASAPI Exclusive) could still be playing, or the same
  // track is heard twice. Stopping is a cheap no-op when native is already idle.
  await stopNativeAudio()
  if (!isActiveLoad(loadToken, track)) return false

  const playableUrl = await createPlayableUrl(target, track, loadToken)
  if (!playableUrl || !isActiveLoad(loadToken, track)) return false

  audio.src = playableUrl
  audio.volume = volume.value
  applyPlaybackRateToHtmlAudio(audio)
  if (!isActiveLoad(loadToken, track)) return false

  seekRendererAudioWhenReady(audio, startTime, track, loadToken)
  if (!isActiveLoad(loadToken, track)) return false

  try {
    await audio.play()
  } catch (err) {
    if (!isActiveLoad(loadToken, track)) return false

    await new Promise((resolve) => window.setTimeout(resolve, 140))
    if (!isActiveLoad(loadToken, track)) return false

    try {
      await audio.play()
    } catch {
      console.error('[audio-engine] Renderer audio play failed:', {
        message: err instanceof Error ? err.message : String(err),
        src: audio.src ? audio.src.slice(0, 120) : ''
      })
      throw err
    }
  }

  return isActiveLoad(loadToken, track)
}

function applyAudioOutputState(state: AudioOutputState): void {
  exclusiveMode.value = state.exclusiveMode
  audioOutput.value = state.output
  audioDevice.value = state.device
  audioOutputOptions.value = normalizeAudioOutputOptions(state.outputOptions, state.output)
  audioDeviceOptions.value = normalizeAudioDeviceOptions(
    state.deviceOptions,
    state.device,
    state.output
  )
}

let audioEngineStateRequest: Promise<void> | null = null
let audioEngineStateRefreshQueued = false

async function refreshAudioOutputState(): Promise<void> {
  if (audioEngineStateRequest) {
    audioEngineStateRefreshQueued = true
    return audioEngineStateRequest
  }
  const api = window.api?.audioEngine
  if (!api) return

  audioEngineStateRequest = (async () => {
    audioEngineStateRefreshQueued = false
    try {
      const [outputState, processingSettings, sceneState] = await Promise.all([
        api.getAudioOutputState(),
        api.getAudioProcessing(),
        api.getDspSceneState?.() ?? Promise.resolve(null)
      ])
      applyAudioOutputState(outputState)
      audioProcessing.value = processingSettings
      if (sceneState) {
        const defaultScene = sceneState.scenes?.find((scene) => scene.id === 'default')
        const graph = defaultScene?.graph ?? sceneState.graph
        if (graph?.outputStage) {
          dspOutputStage.value = mergeDspOutputStage(graph.outputStage, {})
        }
        if (graph) {
          dspStereoImage.value = extractStereoImageFromGraph(graph)
        }
      }
      audioEngineReady.value = true
      setAudioEngineError(null)
    } catch (err) {
      audioEngineReady.value = false
      console.warn('[audio-engine] Failed to refresh audio output state:', err)
    } finally {
      audioEngineStateRequest = null
    }
  })()

  await audioEngineStateRequest
  if (audioEngineStateRefreshQueued) {
    await refreshAudioOutputState()
  }
}

async function persistAudioProcessingFallback(
  nextSettings: AudioProcessingSettings,
  reason: unknown
): Promise<void> {
  setAudioEngineError(reason instanceof Error ? reason.message : String(reason))
  try {
    const savedSettings = await updateSettings({ audioProcessing: nextSettings })
    audioProcessing.value = cloneAudioProcessingSettings(savedSettings.audioProcessing)
  } catch (err) {
    setAudioEngineError(err instanceof Error ? err.message : String(err))
    console.error('[audio-engine] Failed to persist audio processing fallback:', err)
  }
}

function findLibraryTrackHint(track: Track, _libraryHint?: Track | null): Track | null {
  // Always resolve from the real library. Callers used to pass the queue row as
  // libraryHint, which short-circuited lookup and left lyrics:null / stale cover
  // forever (queue snapshots intentionally strip lyrics). O(1) via trackById —
  // never linear-scan tracks on the switch hot path (freezes PlayingMusic).
  return useMusicStore().getTrackById(track.id) ?? null
}

/**
 * Hydrate a queue/session snapshot for the active currentTrack.
 * Queue rows intentionally strip lyrics (memory) and may lose cover after
 * restore; never inherit cover/lyrics from a *different* previous track id.
 */
function hydratePlaybackTrack(track: Track, libraryHint?: Track | null): Track {
  const hint = findLibraryTrackHint(track, libraryHint)
  const cover = nonEmptyString(track.cover) || nonEmptyString(hint?.cover)
  const coverSource = nonEmptyString(track.coverSource) || nonEmptyString(hint?.coverSource)
  // Queue snapshots force lyrics: null — restore embedded library lyrics so
  // PlayingMusic does not blank until (or unless) async re-resolution finishes.
  const lyrics = nonEmptyString(track.lyrics) || nonEmptyString(hint?.lyrics)
  const translatedLyrics =
    nonEmptyString(track.translatedLyrics) || nonEmptyString(hint?.translatedLyrics)
  const romanizedLyrics =
    nonEmptyString(track.romanizedLyrics) || nonEmptyString(hint?.romanizedLyrics)
  const fallbackLyricsSource: LyricSource =
    getTrackSource(track) === 'ncm' ? 'provider' : 'embedded'
  const lyricsSource =
    track.lyricsSource ?? hint?.lyricsSource ?? (lyrics ? fallbackLyricsSource : null)
  const translatedLyricsSource =
    track.translatedLyricsSource ??
    hint?.translatedLyricsSource ??
    (translatedLyrics ? fallbackLyricsSource : null)
  const romanizedLyricsSource =
    track.romanizedLyricsSource ??
    hint?.romanizedLyricsSource ??
    (romanizedLyrics ? fallbackLyricsSource : null)

  if (
    cover === (track.cover ?? null) &&
    coverSource === (track.coverSource ?? null) &&
    lyrics === (track.lyrics ?? null) &&
    translatedLyrics === (track.translatedLyrics ?? null) &&
    romanizedLyrics === (track.romanizedLyrics ?? null) &&
    lyricsSource === (track.lyricsSource ?? null) &&
    translatedLyricsSource === (track.translatedLyricsSource ?? null) &&
    romanizedLyricsSource === (track.romanizedLyricsSource ?? null)
  ) {
    return track
  }

  return {
    ...track,
    cover,
    coverSource,
    lyrics,
    translatedLyrics,
    romanizedLyrics,
    lyricsSource,
    translatedLyricsSource,
    romanizedLyricsSource
  }
}

function activateCurrentTrack(
  track: Track,
  options: { resetUi?: boolean; position?: number } = {}
): void {
  const next = hydratePlaybackTrack(track)
  // Fresh object every activation so cover/lyrics watchers always rebind.
  currentTrack.value = { ...next }
  loadedTrackId = next.id
  lastActiveTrack = currentTrack.value
  if (options.resetUi !== false) {
    resetPlaybackUiForTrackSwitch(next, options.position ?? 0)
  }
  // Queue snapshots strip lyrics — always re-resolve for the active track.
  void lyricsLoader.ensureCurrentTrackLyricsLoaded(currentTrack.value, true)
}

/**
 * Re-apply library cover/lyrics onto the active track + queue after the library
 * finishes loading (session restore often runs before loadLibrary completes).
 */
function rehydrateCurrentTrackFromLibrary(): void {
  const active = currentTrack.value
  if (active) {
    const next = hydratePlaybackTrack(active)
    if (
      next.cover !== active.cover ||
      next.coverSource !== active.coverSource ||
      next.lyrics !== active.lyrics ||
      next.translatedLyrics !== active.translatedLyrics
    ) {
      currentTrack.value = { ...next }
      lastActiveTrack = currentTrack.value
    }
  }

  const musicStore = useMusicStore()
  const patchRow = (row: Track): Track => {
    const library = musicStore.getTrackById(row.id)
    if (!library) return row
    const cover = nonEmptyString(row.cover) || nonEmptyString(library.cover)
    const coverSource = nonEmptyString(row.coverSource) || nonEmptyString(library.coverSource)
    if (cover === (row.cover ?? null) && coverSource === (row.coverSource ?? null)) return row
    return { ...row, cover, coverSource }
  }
  queue.value = queue.value.map(patchRow)
  originalQueue.value = originalQueue.value.map(patchRow)
}

function patchTrackInQueues(updatedTrack: Track): void {
  const snapshot = toPlaybackQueueSnapshot(updatedTrack)
  queue.value = queue.value.map((track) =>
    track.id === updatedTrack.id ? { ...snapshot, queueEntryId: track.queueEntryId } : track
  )
  originalQueue.value = originalQueue.value.map((track) =>
    track.id === updatedTrack.id ? { ...snapshot, queueEntryId: track.queueEntryId } : track
  )
}

function findTrackIndexFromPlaybackInfo(info: NativePlaybackInfo): number {
  const mappedTrackId =
    typeof info.source === 'string' && info.source.length > 0
      ? nativeSourceToTrackId.get(info.source)
      : undefined
  if (mappedTrackId) {
    const mappedIndex = queue.value.findIndex((track) => track.id === mappedTrackId)
    if (mappedIndex >= 0) return mappedIndex
  }
  if (
    Number.isInteger(info.queueIndex) &&
    info.queueIndex >= 0 &&
    info.queueIndex < queue.value.length
  ) {
    // 验证 queueIndex 指向的曲目与原生引擎实际播放的 source 一致。
    // 队列重排（如切换 shuffle 模式）后，原生引擎可能仍报告旧 index，
    // 旧 index 在新队列中可能指向不同曲目。
    const trackAt = queue.value[info.queueIndex]
    const source = typeof info.source === 'string' ? info.source.trim() : ''
    if (trackAt && source.length > 0) {
      if (
        getTrackAudioSource(trackAt) === source ||
        trackAt.id === source ||
        cachedSourceMatchesTrack(trackAt, source) ||
        // A delegated native queue owns queueIndex even when authorization or
        // cache resolution rewrites the reported source.
        nativeQueueDelegated
      ) {
        return info.queueIndex
      }
      // queueIndex 与 source 不匹配，队列可能已被重排，回退到 source 查找
    } else if (trackAt && !source) {
      return info.queueIndex
    }
  }

  if (!info.source) return -1
  return queue.value.findIndex(
    (track) =>
      track.id === info.source ||
      getTrackAudioSource(track) === info.source ||
      cachedSourceMatchesTrack(track, info.source)
  )
}

function clearNativeStreamBufferingTimer(): void {
  if (nativeStreamBufferingClearTimer) {
    clearTimeout(nativeStreamBufferingClearTimer)
    nativeStreamBufferingClearTimer = null
  }
}

/** Reset native underrun-derived LIVE buffering UX (load/stop/error). */
function resetNativeStreamBufferingState(): void {
  clearNativeStreamBufferingTimer()
  lastNativeSessionUnderrunCount = 0
  isStreamBuffering.value = false
}

/**
 * Map native output underrun counters onto isStreamBuffering for LIVE/stream tracks.
 * Sticky for 1.5s so single xruns don't flicker the badge; no engine ABI change.
 */
function applyNativeStreamBufferingFromInfo(info: NativePlaybackInfo): void {
  if (!nativePlaybackActive) return
  const track = currentTrack.value
  if (!isStreamLikeTrack(track)) {
    lastNativeSessionUnderrunCount = 0
    clearNativeStreamBufferingTimer()
    return
  }
  const underruns = Number(
    info.diagnostics?.sessionUnderrunCount ??
      info.outputInfo?.diagnostics?.sessionUnderrunCount ??
      0
  )
  if (!Number.isFinite(underruns) || underruns < 0) return
  if (underruns > lastNativeSessionUnderrunCount) {
    isStreamBuffering.value = true
    clearNativeStreamBufferingTimer()
    // Sticky briefly so the LIVE badge doesn't flicker on single xruns.
    nativeStreamBufferingClearTimer = setTimeout(() => {
      isStreamBuffering.value = false
      nativeStreamBufferingClearTimer = null
    }, 1500)
  }
  lastNativeSessionUnderrunCount = underruns
  if (info.state === 'stopped' || info.state === 'paused') {
    clearNativeStreamBufferingTimer()
    isStreamBuffering.value = false
  }
}

/**
 * Reset playbar progress / A-B when the active track identity changes without
 * going through loadAndPlay (native gapless, delegated queue next, start-file).
 */
function resetPlaybackUiForTrackSwitch(track: Track | null, position = 0): void {
  clearAbLoop()
  pendingLoadStartTime = 0
  duration.value = track ? cueDuration(track) : 0
  beginPlaybackPositionTransition(position, { keepRendererClockAlive: true })
}

function applyNativePlaybackInfo(
  info: NativePlaybackInfo,
  options: { applyTrackWhenInactive?: boolean } = {}
): boolean {
  const preserveRestoredPosition = restoredPlaybackPending && isLoading.value
  const infoIndex = findTrackIndexFromPlaybackInfo(info)
  if (shouldIgnoreNativePlaybackInfo(info, infoIndex)) return false

  const normalizedInfo = normalizeNativePlaybackInfo(info)
  playbackInfo.value = normalizedInfo
  if (typeof (info as { streamTitle?: string }).streamTitle === 'string') {
    streamNowPlaying.value = (info as { streamTitle?: string }).streamTitle?.trim() ?? ''
  }
  // Promote nativePlaybackActive when the engine confirms it, but never demote
  // it from a transient/stale snapshot while we still believe native is active.
  // Demoting here drops time-pos updates and freezes the playbar until pause
  // forces a full playback-info sync.
  if (info.nativePlaybackActive === true) {
    nativePlaybackActive = true
  } else if (
    info.nativePlaybackActive === false &&
    playbackToggleIntent?.playing !== true &&
    (info.state === 'stopped' || (!isPlaying.value && !isLoading.value))
  ) {
    nativePlaybackActive = false
  }
  if (!nativePlaybackActive && !options.applyTrackWhenInactive) return true

  const previousQueueIndex = queueIndex.value
  const previousTrackId = currentTrack.value?.id ?? loadedTrackId
  let switchedTrack = false

  if (infoIndex >= 0) {
    const track = queue.value[infoIndex]
    // Treat queue-index changes as a switch even when consecutive CUE/logical
    // entries share metadata, so cover + progress always rebind.
    switchedTrack =
      previousTrackId !== track.id || previousQueueIndex !== infoIndex || loadedTrackId !== track.id
    const mergedTrack = mergeTrackTransientData(track, currentTrack.value)
    queueIndex.value = infoIndex
    if (mergedTrack !== track) {
      const snapshot = { ...toPlaybackQueueSnapshot(mergedTrack), queueEntryId: track.queueEntryId }
      queue.value = queue.value.map((item, index) => (index === infoIndex ? snapshot : item))
    }
    // Always assign a fresh object on switch so cover/title/lyrics watchers and
    // PlayerBar remount keys fire even when the queue snapshot is referentially
    // stable (same album handle, gapless hand-off, delegated next).
    if (switchedTrack) {
      // Hydrate from library (not the queue row) so embedded cover/lyrics return
      // after queue snapshots stripped them. Never inherit previous track fields.
      // Keep lyrics null so the now-playing column stays in loading reserve until
      // ensureCurrentTrackLyricsLoaded commits '' or real text for this id.
      const hydrated = hydratePlaybackTrack({
        ...mergedTrack,
        cover: nonEmptyString(track.cover) || nonEmptyString(mergedTrack.cover),
        coverSource: nonEmptyString(track.coverSource) || nonEmptyString(mergedTrack.coverSource),
        lyrics: null,
        translatedLyrics: null,
        romanizedLyrics: null
      })
      currentTrack.value = { ...hydrated }
      lastActiveTrack = currentTrack.value
      // Native gapless / delegated next skips activateCurrentTrack — still load lyrics.
      void lyricsLoader.ensureCurrentTrackLyricsLoaded(currentTrack.value, true)
    } else {
      currentTrack.value = mergedTrack
      lastActiveTrack = mergedTrack
    }
    loadedTrackId = mergedTrack.id
  }

  const nextDuration =
    Number.isFinite(info.duration) && info.duration > 0
      ? info.duration
      : currentTrack.value
        ? cueDuration(currentTrack.value)
        : 0

  const nextPosition = Number.isFinite(info.position)
    ? Math.max(0, info.position)
    : switchedTrack
      ? 0
      : getLatestPlaybackTime()

  if (switchedTrack) {
    // Native gapless / queue next does not go through loadAndPlay — clear A-B and
    // reset duration/time so the playbar cover + progress do not stick on the previous track.
    clearAbLoop()
    pendingLoadStartTime = 0
    duration.value =
      nextDuration > 0 ? nextDuration : currentTrack.value ? cueDuration(currentTrack.value) : 0
    beginPlaybackPositionTransition(nextPosition, { keepRendererClockAlive: true })
    // Keep the intent/guard confirmed so delayed previous-track ticks still drop.
    markNativePlaybackInfoIntentConfirmed()
  } else {
    if (nextDuration > 0) {
      duration.value = nextDuration
    }
    applyPlaybackPositionSample(nextPosition, 'native-info')
  }

  applyNativePlayingState(
    normalizedInfo.state === 'playing',
    normalizedInfo.state === 'paused' ? nextPosition : null
  )
  applyNativeStreamBufferingFromInfo(normalizedInfo)
  isLoading.value = false
  autoAdvanceInFlight = false
  advancingFromEndedTrackId = ''
  if (!preserveRestoredPosition) {
    restoredPlaybackPending = false
    restoredPlaybackPosition = 0
  }
  scheduleCrossfadeIfNeeded()
  return true
}

interface NativeQueueStateSnapshot {
  revision: number
  queue: Track[]
  current: Track | null
  currentIndex: number
  playMode: PlayMode
}

function captureNativeQueueState(revision: number): NativeQueueStateSnapshot {
  return {
    revision,
    queue: queue.value,
    current: currentTrack.value ? toPlaybackQueueSnapshot(currentTrack.value) : null,
    currentIndex: queueIndex.value,
    playMode: playMode.value
  }
}

async function syncNativeQueueState(snapshot: NativeQueueStateSnapshot): Promise<void> {
  if (!nativeQueueRevisionFence.isCurrent(snapshot.revision)) return
  const current = snapshot.current
  if (!current) {
    if (!nativeQueueRevisionFence.isCurrent(snapshot.revision)) return
    await stopNativeAudio()
    return
  }

  const nativePlayMode = toNativePlayMode(snapshot.playMode)
  const heartModeActive = snapshot.playMode === 'heart'
  const synchronized = await synchronizeLatestNativeQueue(
    nativeQueueRevisionFence,
    snapshot.revision,
    {
      prepare: () =>
        preparePlayerNativeQueue(
          {
            // 心动模式由渲染层管理智能列表与边界续播，原生引擎只加载当前曲目，
            // 避免原生引擎在列表耗尽时静默停止而无法触发渲染层补拉。
            queue: stripStaleNcmStreamUrls(heartModeActive ? [current] : snapshot.queue, {
              committedAtByTrackId: ncmStreamUrlCommittedAt
            }),
            currentTrack: current,
            currentTarget: getTrackAudioSource(current),
            currentIndex: heartModeActive ? 0 : snapshot.currentIndex
          },
          {
            isAudioFileAuthorized: window.api.fs.isAudioFileAuthorized,
            areAudioFilesAuthorized: window.api.fs.areAudioFilesAuthorized
          }
        ),
      loadQueue: (preparedQueue) =>
        window.api.audioEngine.loadQueue(preparedQueue.items, preparedQueue.startIndex),
      setPlayMode: () => window.api.audioEngine.setPlayMode(nativePlayMode)
    }
  )
  if (!synchronized.applied) return
  if (synchronized.loadQueueError) {
    console.warn(
      '[audio-engine] Native queue resynchronization failed:',
      synchronized.loadQueueError
    )
  }
  const preparedQueue = synchronized.prepared
  if (preparedQueue) pruneNativeSourceToTrackId(preparedQueue.items, getTrackAudioSource(current))
  if (!preparedQueue) {
    // 不要因为队列重同步失败就停掉正在播放的引擎：停止会让主进程误判
    // “播放结束”（单曲队列 queueIndex>=len-1 恒真）→ 渲染层自动切歌/重播。
    // 保持现有播放不变，让 loadAndPlay 走正常的“不可用→回退”路径。
    return
  }
  nativeQueueDelegated = heartModeActive ? false : preparedQueue.delegated
}

function trackNativeQueueSyncRequest(request: Promise<void>): Promise<void> {
  nativeQueueSyncRequest = request
  void request.finally(() => {
    if (nativeQueueSyncRequest === request) {
      nativeQueueSyncRequest = null
    }
  })
  return request
}

function queueNativeQueueStateSync(): Promise<void> {
  const revision = nativeQueueRevisionFence.next()
  const snapshot = captureNativeQueueState(revision)
  const previousRequest = nativeQueueSyncRequest
  const request = (previousRequest ?? Promise.resolve())
    .catch(() => {})
    .then(() => syncNativeQueueState(snapshot))
  return trackNativeQueueSyncRequest(request)
}

function queueNativePlayModeSync(mode: PlayMode): Promise<void> {
  const nativePlayMode = toNativePlayMode(mode)
  const previousRequest = nativeQueueSyncRequest
  const request = (previousRequest ?? Promise.resolve())
    .catch(() => {})
    .then(() => window.api.audioEngine.setPlayMode(nativePlayMode))
  return trackNativeQueueSyncRequest(request)
}

async function waitForNativeQueueStateSync(): Promise<void> {
  const request = nativeQueueSyncRequest
  if (request) {
    await request
  }
}

function getNativeQueueAdvanceTarget(
  direction: 'next' | 'previous'
): { track: Track; queueIndex: number } | null {
  if (queue.value.length === 0) return null

  const currentQueueIndex =
    queueIndex.value >= 0 && queueIndex.value < queue.value.length
      ? queueIndex.value
      : Math.max(
          0,
          queue.value.findIndex((track) => track.id === currentTrack.value?.id)
        )
  const targetQueueIndex =
    direction === 'next'
      ? (currentQueueIndex + 1) % queue.value.length
      : (currentQueueIndex - 1 + queue.value.length) % queue.value.length
  const track = queue.value[targetQueueIndex]
  return track ? { track, queueIndex: targetQueueIndex } : null
}

async function advanceNativePlayback(direction: 'next' | 'previous'): Promise<void> {
  // Drop any pending pause/play grace — a track switch is a new transport action
  // and must not be blocked by a prior pause intent (UI stuck paused while audio
  // already advanced).
  const wasPlaying = isPlaying.value
  clearPlaybackToggleIntent()

  // The native queue mirrors the renderer's queue order in every mode now
  // (shuffle is applied by the renderer before the queue is handed over), so the
  // adjacent item is a safe prediction and shuffle keeps the optimistic UI too.
  const target = getNativeQueueAdvanceTarget(direction)
  if (target) {
    // Optimistic UI update so cover/title/progress reset immediately instead of
    // waiting for (or missing) the first native playback-info event.
    queueIndex.value = target.queueIndex
    activateCurrentTrack(target.track, { resetUi: true, position: 0 })
    setNativePlaybackInfoIntent(
      activeLoadToken,
      target.track,
      getTrackAudioSource(target.track),
      target.queueIndex
    )
  } else {
    clearNativePlaybackInfoIntent()
  }
  stopVisualizationPolling(false)
  try {
    isLoading.value = true
    await waitForNativeQueueStateSync()
    if (direction === 'next') {
      await window.api.audioEngine.next()
    } else {
      await window.api.audioEngine.previous()
    }
    await new Promise((resolve) =>
      window.setTimeout(resolve, NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS)
    )
    let info = await window.api.audioEngine.getPlaybackInfo()
    let applied = applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
    if (!applied) {
      await new Promise((resolve) =>
        window.setTimeout(resolve, NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS)
      )
      info = await window.api.audioEngine.getPlaybackInfo()
      applied = applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
    }
    if (!applied) {
      // Keep optimistic track metadata; force a full load if native did not confirm.
      // loadAndPlay manages nativePlaybackActive — do not demote it here or the
      // playbar will ignore time-pos until the next pause/play handshake.
      const track = currentTrack.value
      if (track) {
        await loadAndPlay(track)
      }
      return
    }

    const track = currentTrack.value
    if (track && info.state !== 'playing') {
      // Paused engine after next/previous: start the new track. loadAndPlay also
      // clears any residual pause intent and sets isPlaying.
      await loadAndPlay(track)
      return
    }

    // Engine already playing the new track — mirror that into UI even when the
    // user was paused (native next often auto-starts) or a stale pause intent
    // would have blocked applyNativePlayingState.
    if (info.state === 'playing' || wasPlaying) {
      clearPlaybackToggleIntent()
      isPlaying.value = true
      if (info.nativePlaybackActive === true || nativeQueueDelegated) {
        nativePlaybackActive = true
      }
      isLoading.value = false
    } else {
      isLoading.value = false
    }
  } catch (err) {
    clearNativePlaybackInfoIntent()
    setAudioEngineError(err instanceof Error ? err.message : String(err))
    console.error('[音频引擎] 切换歌曲失败:', err)
    isLoading.value = false
  } finally {
    if (isPlaying.value && currentTrack.value) startVisualizationPolling()
  }
}

async function persistSoftwareVolume(val: number): Promise<void> {
  const next = clampSoftwareVolume(val)
  const saved = clampSoftwareVolume(
    typeof appSettings.value?.softwareVolume === 'number'
      ? appSettings.value.softwareVolume
      : DEFAULT_SOFTWARE_VOLUME
  )
  if (Math.abs(saved - next) < 0.0005) return
  await updateSettings({ softwareVolume: next })
}

const softwareVolumePersistence = createDebouncedVolumePersistence(persistSoftwareVolume)

function scheduleSoftwareVolumePersist(val: number): void {
  if (!suppressVolumePersist) softwareVolumePersistence.schedule(val)
}

async function flushSoftwareVolumePersist(): Promise<void> {
  if (suppressVolumePersist) return
  try {
    await softwareVolumePersistence.flush(volume.value)
  } catch (err) {
    console.error('[音频引擎] 保存软件音量失败:', err)
    throw err
  }
}

watch(volume, (val) => {
  if (val > 0) {
    lastAudibleVolume.value = val
    muted.value = false
  }
  if (playbackAudio) playbackAudio.volume = val
  window.api.audioEngine.setVolume(val).catch(() => {})
  if (castTargetName.value) {
    void window.api.remote?.controlCast?.({ volume: val }).catch(() => {})
  }
  scheduleSoftwareVolumePersist(val)
})

function applyPlaybackRateToHtmlAudio(audio: HTMLAudioElement, rate = playbackRate.value): void {
  audio.playbackRate = rate
  try {
    audio.preservesPitch = true
  } catch {
    // preservesPitch is not available on every runtime.
  }
  try {
    ;(audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
  } catch {
    // Safari-style property; ignore when unsupported.
  }
}

async function setPlaybackRate(rate: number): Promise<void> {
  const clamped = Math.min(2, Math.max(0.5, Number.isFinite(rate) ? rate : 1))
  const rounded = Math.round(clamped * 1000) / 1000
  if (Object.is(rounded, playbackRate.value)) return
  playbackRate.value = rounded
  publishPlaybackClockTransport(playbackClockSnapshot.value.state, rounded)
  if (playbackAudio) applyPlaybackRateToHtmlAudio(playbackAudio, rounded)
  window.api.audioEngine.setPlaybackRate(rounded).catch(() => {})
  // Remember podcast speed preference when the user changes rate while on a podcast.
  if (currentTrack.value?.source === 'podcast') {
    setPodcastDefaultPlaybackRate(rounded)
  }
  updateMediaSessionPositionState()
}

watch(
  [
    () => currentTrack.value?.id,
    () => currentTrack.value?.cover,
    () => currentTrack.value?.coverSource,
    () => appSettings.value?.useCoverTheme
  ],
  async ([trackId, cover, coverSource, useCoverTheme]) => {
    const requestId = ++dominantColorRequestId
    const identity = `${trackId ?? 'none'}:${cover ?? ''}:${coverSource ?? ''}`
    themeCoverIdentity.value = identity

    if (cover || coverSource) {
      const displayCover = await resolveCover(cover, coverSource)
      if (
        requestId !== dominantColorRequestId ||
        currentTrack.value?.id !== trackId ||
        currentTrack.value?.cover !== cover ||
        currentTrack.value?.coverSource !== coverSource
      ) {
        return
      }
      if (displayCover) {
        themeCoverUrl.value = displayCover
        const extracted = await extractDominantColor(displayCover)
        if (
          requestId !== dominantColorRequestId ||
          currentTrack.value?.id !== trackId ||
          currentTrack.value?.cover !== cover ||
          currentTrack.value?.coverSource !== coverSource
        ) {
          return
        }
        coverThemeColor.value = extracted
        dominantColor.value = useCoverTheme ? extracted : '#7c4dff'
      } else {
        themeCoverUrl.value = ''
        coverThemeColor.value = '#1a73e8'
        dominantColor.value = useCoverTheme ? '#1a73e8' : '#7c4dff'
      }
    } else {
      themeCoverUrl.value = ''
      coverThemeColor.value = '#1a73e8'
      dominantColor.value = useCoverTheme ? '#1a73e8' : '#7c4dff'
    }
  }
)

watch(
  () => appSettings.value?.audioOutputConfig,
  (config) => {
    audioOutputConfig.value = {
      preferredBufferSize:
        config?.preferredBufferSize ?? defaultAudioOutputConfig.preferredBufferSize,
      routingMode: config?.routingMode ?? defaultAudioOutputConfig.routingMode,
      wasapiExclusivePushMode:
        config?.wasapiExclusivePushMode ?? defaultAudioOutputConfig.wasapiExclusivePushMode,
      upmixCenterGain: config?.upmixCenterGain ?? defaultAudioOutputConfig.upmixCenterGain,
      upmixLfeGain: config?.upmixLfeGain ?? defaultAudioOutputConfig.upmixLfeGain,
      upmixLfeLowpassHz: config?.upmixLfeLowpassHz ?? defaultAudioOutputConfig.upmixLfeLowpassHz,
      upmixSurroundGain: config?.upmixSurroundGain ?? defaultAudioOutputConfig.upmixSurroundGain,
      upmixSideGain: config?.upmixSideGain ?? defaultAudioOutputConfig.upmixSideGain,
      upmixSurroundDelayMs:
        config?.upmixSurroundDelayMs ?? defaultAudioOutputConfig.upmixSurroundDelayMs
    }
  },
  { deep: true, immediate: true }
)

watch(
  () => currentTrack.value?.id,
  async (id, prevId) => {
    const track = currentTrack.value
    if (!track || track.id !== id) return
    // Only on track identity change. Field-level watches re-entered with
    // allowProviderLookup=false after partial writes and could leave blank lyrics.
    if (id === prevId) return
    await lyricsLoader.ensureCurrentTrackLyricsLoaded(track, true)
  }
)

const cleanupFns: (() => void)[] = []
let listenersSetup = false
let crossfadeTimer: number | null = null
let crossfadeTrackId = ''
let advancingFromEndedTrackId = ''
let autoAdvanceInFlight = false
let loadedTrackId = ''
/** Last track that successfully entered the playing pipeline (identity for resume bookmarks). */
let lastActiveTrack: Track | null = null
let restoredPlaybackPending = false
let restoredPlaybackPosition = 0
let pendingLoadStartTime = 0
let nativeQueueSyncRequest: Promise<void> | null = null
const rendererPlayModeBoundaryPending = ref(false)
let dominantColorRequestId = 0

const playbackQueueController = createPlaybackQueueController({
  currentTrack,
  queue,
  originalQueue,
  queueIndex,
  playMode,
  isPlaying,
  personalizedStreamSession,
  personalizedStreamRemaining,
  personalizedStreamEntryIds,
  personalizedStreamPlayedEntryIds,
  rendererPlayModeBoundaryPending,
  persistPlaybackSessionAfterQueueMutation,
  queueNativeQueueStateSync,
  setAudioEngineError,
  clearAutomaticLyricsBaselines: lyricsLoader.clearLyricsBaselines
})
const {
  markCurrentPersonalizedStreamTrackPlayed,
  endPersonalizedStream,
  isPersonalizedStreamTrack,
  startPersonalizedStream,
  applyPendingRendererPlayModeAtBoundary,
  enqueueTrack,
  appendQueueTracks,
  appendPersonalizedStreamTracks,
  playNextTrack,
  removeQueueItem,
  clearQueue,
  reorderQueue,
  saveQueueAsPlaylist
} = playbackQueueController

const playbackHistoryController = createPlaybackHistoryController({
  currentTrack,
  currentTime,
  getLatestPlaybackTime,
  seekPlayback,
  getPlaybackBookmarks: usePlaybackBookmarks,
  getPodcastStore: usePodcastStore,
  now: Date.now
})
const { resumeOffer, acceptResumeOffer, dismissResumeOffer, addManualBookmarkAtCurrentTime } =
  playbackHistoryController

const audioOutputController = createAudioOutputController({
  exclusiveMode,
  audioProcessing,
  audioOutputConfig,
  audioOutputConfigApplyStatus,
  dspOutputStage,
  dspStereoImage,
  getAudioEngineApi: () => window.api.audioEngine,
  applyAudioOutputState,
  setAudioEngineError,
  scheduleCrossfadeIfNeeded,
  refreshPlaybackInfo: async () => {
    playbackInfo.value = normalizeNativePlaybackInfo(await window.api.audioEngine.getPlaybackInfo())
  },
  persistAudioProcessingFallback
})
const {
  toggleExclusiveMode,
  setAudioOutput,
  setAudioDevice,
  setAudioOutputConfig,
  setAudioProcessing,
  applyAudioProcessingState,
  setOutputStage,
  setStereoImage,
  toggleDspEnabled,
  toggleEqEnabled,
  toggleCrossfeed,
  toggleGapless,
  setReplayGainMode,
  setCrossfeedStrength,
  selectImpulseResponse,
  clearImpulseResponse
} = audioOutputController

const heartModeController = createHeartModeController({
  queue,
  queueIndex,
  currentTrack,
  playMode,
  isPlaying,
  isLoading,
  rendererPlayModeBoundaryPending,
  fetchIntelligenceList: (request) => useNcmStore().fetchIntelligenceList(request),
  playQueueTrack,
  advanceAfterPlaybackEnded,
  setAutoAdvanceInFlight: (value) => {
    autoAdvanceInFlight = value
  },
  replaceQueue: (tracks, index, replaceOptions) => {
    const snapshots = toPlaybackQueueSnapshots(tracks)
    queue.value = snapshots
    originalQueue.value = [...snapshots]
    queueIndex.value = index
    if (replaceOptions.persist) persistPlaybackSessionAfterQueueMutation()
    void queueNativeQueueStateSync().catch((error) => {
      setAudioEngineError(error instanceof Error ? error.message : String(error))
    })
  },
  appendQueueAdditions: (additions) => {
    const snapshots = toPlaybackQueueSnapshots(additions)
    queue.value = [...queue.value, ...snapshots]
    originalQueue.value = [...originalQueue.value, ...snapshots]
    persistPlaybackSessionAfterQueueMutation()
    void queueNativeQueueStateSync().catch((error) => {
      setAudioEngineError(error instanceof Error ? error.message : String(error))
    })
  }
})
const {
  heartModeAvailable,
  setHeartModeContext,
  enterHeartMode,
  exitHeartModeToSequential,
  exitHeartModeForManualQueueReplacement,
  advanceHeartPlayback
} = heartModeController

// One dedupe slot for the whole audio-engine recovery lifecycle: crash, fatal
// and ready all update the same toast in place. The main process can emit the
// same crash reason repeatedly (service crash and error channels both fire, and
// a fatal is re-reported on every manual retry), so a fresh notice per event
// would keep replacing the one the user just closed.
const AUDIO_ENGINE_RECOVERY_DEDUPE_KEY = 'audio-engine-recovery'

function publishAudioEngineRecoveryNotice(notice: AudioEngineRecoveryNotice): void {
  audioEngineRecoveryNotice.value = notice
  const unrecoverable = notice.kind === 'service-fatal'
  const action =
    notice.kind === 'service-ready' && notice.canResume !== false
      ? {
          label: notice.actionLabel || translate(currentLocale(), 'action.resumePlayback'),
          run: () => void togglePlayState()
        }
      : unrecoverable
        ? {
            label: notice.actionLabel || translate(currentLocale(), 'action.retry'),
            run: () => void retryAudioService()
          }
        : undefined
  audioEngineRecoveryAppNoticeId = pushNotice({
    kind: unrecoverable
      ? 'error'
      : notice.kind === 'service-crash' || notice.canResume === false
        ? 'warning'
        : 'success',
    message: notice.message,
    action,
    sticky: unrecoverable || notice.kind === 'service-crash' || notice.canResume === false,
    durationMs: 8000,
    dedupeKey: AUDIO_ENGINE_RECOVERY_DEDUPE_KEY
  })
}

/**
 * Both call sites now hand over a bare reason — the structured `serviceCrash`
 * event and the sentinel-carrying `error` channel — so this no longer has to
 * strip a Chinese prefix back off a pre-rendered sentence.
 */
function setAudioServiceCrashNotice(reason: string, options?: { fatal?: boolean }): void {
  const locale = currentLocale()
  const detail = reason.trim() || translate(locale, 'error.audio.unknown_reason')
  if (options?.fatal === true) {
    publishAudioEngineRecoveryNotice({
      kind: 'service-fatal',
      message: translate(locale, 'error.audio.service_fatal', { reason: detail }),
      actionLabel: translate(locale, 'action.retry')
    })
    return
  }
  publishAudioEngineRecoveryNotice({
    kind: 'service-crash',
    message: translate(locale, 'error.audio.service_crashed', { reason: detail }),
    actionLabel: translate(locale, 'action.resumeManually')
  })
}

/**
 * User-driven recovery from a fatal audio-service startup failure. Nothing else
 * re-forks the child, so the retry must also release the notice suppression —
 * the user asked for a fresh answer and deserves to see it.
 */
async function retryAudioService(): Promise<void> {
  const api = window.api?.audioEngine
  if (!api?.restartService) return
  try {
    const result = await api.restartService()
    // Release only after awaiting: the notice host dismisses the toast right
    // after the action returns, which re-suppresses the message it carried.
    // Releasing here guarantees the retry's outcome is visible even when the
    // service fails again with the identical reason.
    releaseNoticeDedupe(AUDIO_ENGINE_RECOVERY_DEDUPE_KEY)
    if (result.restarted) {
      setAudioEngineError(null)
      publishAudioEngineRecoveryNotice({
        kind: 'service-ready',
        message: translate(currentLocale(), 'error.audio.service_restarting'),
        canResume: false
      })
      return
    }
    setAudioServiceCrashNotice(
      result.error || translate(currentLocale(), 'error.audio.service_still_failing'),
      { fatal: true }
    )
  } catch (error) {
    releaseNoticeDedupe(AUDIO_ENGINE_RECOVERY_DEDUPE_KEY)
    setAudioServiceCrashNotice(error instanceof Error ? error.message : String(error), {
      fatal: true
    })
  }
}

function setAudioServiceReadyNotice(event?: {
  outputRouteSynced?: boolean
  restoreErrors?: string[]
}): void {
  const outputRouteSynced = event?.outputRouteSynced === true
  const restoreErrors = Array.isArray(event?.restoreErrors)
    ? event.restoreErrors.filter((item) => item.trim())
    : []
  const locale = currentLocale()
  const detail =
    restoreErrors.length > 0
      ? translate(locale, 'error.audio.restore_detail', { detail: restoreErrors.join('；') })
      : ''
  publishAudioEngineRecoveryNotice({
    kind: 'service-ready',
    message: outputRouteSynced
      ? translate(locale, 'error.audio.service_recovered')
      : translate(locale, 'error.audio.service_recovered_route_pending', { detail }),
    actionLabel: outputRouteSynced ? translate(locale, 'action.resumePlayback') : undefined,
    canResume: outputRouteSynced
  })
}

const visualizationPolling = createVisualizationPolling({
  data: visualizationData,
  active: visualizerActive
})

const { stop: stopVisualizationPolling, start: startVisualizationPolling } = visualizationPolling

async function handlePlaybackEnded(): Promise<void> {
  if (await getSleepTimerController().reportBoundary('trackEnd')) return
  const trackId = currentTrack.value?.id ?? ''
  if (!trackId || autoAdvanceInFlight || advancingFromEndedTrackId === trackId) return
  advancingFromEndedTrackId = trackId
  autoAdvanceInFlight = true
  flushLatestCurrentTime()
  if (playMode.value === 'repeat') {
    const track = currentTrack.value
    if (track) void loadAndPlay(track)
    return
  }
  await advanceAfterPlaybackEnded()
}

async function advanceAfterPlaybackEnded(): Promise<void> {
  clearCrossfadeTimer()
  if (playMode.value === 'heart') {
    await advanceHeartPlayback()
    return
  }
  applyPendingRendererPlayModeAtBoundary()
  const nextIndex = queueIndex.value + 1
  if (nextIndex >= 0 && nextIndex < queue.value.length) {
    queueIndex.value = nextIndex
    const track = queue.value[nextIndex]
    if (track) {
      activateCurrentTrack(track, { resetUi: true, position: 0 })
      void loadAndPlay(track)
    } else {
      currentTrack.value = null
      resetPlaybackUiForTrackSwitch(null, 0)
    }
    return
  }

  if (await getSleepTimerController().reportBoundary('queueEnd')) return

  if ((playMode.value === 'listLoop' || playMode.value === 'shuffle') && queue.value.length > 0) {
    queueIndex.value = 0
    const track = queue.value[0]
    if (track) {
      activateCurrentTrack(track, { resetUi: true, position: 0 })
      void loadAndPlay(track)
      return
    }
  }

  isPlaying.value = false
  isLoading.value = false
  autoAdvanceInFlight = false
  stopVisualizationPolling(true)
}

function handleNativePlaybackEnded(): void {
  if (!nativePlaybackActive) return
  // Do not drop this because the queue is delegated. A delegated queue that
  // actually reached its end is exactly the case that needs the renderer's
  // boundary handling: listLoop/shuffle wrap in advanceAfterPlaybackEnded, and
  // without this the auto-advance budget ended up equal to the queue length.
  // Main only publishes the EOF signal when the engine reports no upcoming
  // track, i.e. when it cannot advance on its own, so this never races the
  // engine's own auto-advance (issue #48).
  void handlePlaybackEnded()
}

function isAutoBpmAnalysisEnabled(): boolean {
  return useSettingsStore().settings.value.autoAnalyzeBpm !== false
}

function applyBpmAnalysisToTrack(
  trackId: string,
  filePath: string,
  analysis: Track['bpmAnalysis']
): void {
  if (!analysis) return
  const target = currentTrack.value
  if (target && (target.id === trackId || target.filePath === filePath)) {
    const updatedTrack = {
      ...target,
      bpmAnalysis: analysis
    }
    currentTrack.value = updatedTrack
    patchTrackInQueues(updatedTrack)
  } else {
    queue.value = queue.value.map((track) =>
      track.id === trackId || track.filePath === filePath
        ? { ...track, bpmAnalysis: analysis }
        : track
    )
    originalQueue.value = originalQueue.value.map((track) =>
      track.id === trackId || track.filePath === filePath
        ? { ...track, bpmAnalysis: analysis }
        : track
    )
  }
  useMusicStore().applyBpmAnalysis(trackId, filePath, analysis)
}

function clearBpmAnalysisFromPlaybackState(): void {
  if (currentTrack.value?.bpmAnalysis) {
    const { bpmAnalysis: _bpmAnalysis, ...nextTrack } = currentTrack.value
    currentTrack.value = nextTrack
  }
  queue.value = queue.value.map((track) => {
    if (!track.bpmAnalysis) return track
    const { bpmAnalysis: _bpmAnalysis, ...nextTrack } = track
    return nextTrack
  })
  originalQueue.value = originalQueue.value.map((track) => {
    if (!track.bpmAnalysis) return track
    const { bpmAnalysis: _bpmAnalysis, ...nextTrack } = track
    return nextTrack
  })
  useMusicStore().clearBpmAnalysis()
}

async function requestBpmAnalysisForTrack(track: Track): Promise<void> {
  if (
    !isAutoBpmAnalysisEnabled() ||
    hasAnalyzedBpm(track) ||
    !isAnalyzableAudioPath(track.filePath)
  )
    return
  const key = `${track.id}\u0000${track.filePath}`
  if (bpmAnalysisRequests.has(key)) return
  bpmAnalysisRequests.add(key)
  try {
    const result = await window.api?.bpmAnalysis?.request({
      trackId: track.id,
      filePath: track.filePath,
      referenceBpm: track.bpm
    })
    if (result?.status === 'cached' || result?.status === 'completed') {
      applyBpmAnalysisToTrack(track.id, track.filePath, result.analysis)
    }
  } catch {
    // BPM analysis is best-effort; playback and live visualization continue.
  } finally {
    bpmAnalysisRequests.delete(key)
  }
}

/** True when a previously resolved local playback file still exists. */
async function isUsableLocalPlaybackFile(filePath: string): Promise<boolean> {
  try {
    return (await window.api?.fs?.isAudioFileAuthorized?.(filePath)) === true
  } catch {
    return false
  }
}

async function resolvePlayTarget(track: Track): Promise<string> {
  const source = getTrackSource(track)
  if (source === 'local') {
    const authorized = await window.api.fs.isAudioFileAuthorized(track.filePath)
    if (!authorized) {
      throw new Error('Local audio file is outside the authorized library folders')
    }
    return track.filePath
  }

  // Live radio always streams.
  if (source === 'radio') {
    const direct = track.streamUrl || track.filePath
    if (direct && /^https?:\/\//i.test(direct)) return direct
    throw new Error('Unable to resolve radio stream URL')
  }

  // Podcast episodes stream from the feed media URL.
  if (source === 'podcast') {
    const direct = track.streamUrl || track.filePath
    if (direct && /^https?:\/\//i.test(direct)) return direct
    throw new Error('Unable to resolve podcast stream URL')
  }

  if (source === 'network') {
    // Browse-page tracks may already carry a resolved cache path/URL. Search
    // and library tracks carry the profile/entry pair and resolve lazily here.
    if (track.filePath) {
      if (
        !isLikelyLocalFilePath(track.filePath) ||
        (await isUsableLocalPlaybackFile(track.filePath))
      ) {
        return track.filePath
      }
      // The managed music cache was cleared: the local copy is gone. Drop the
      // dead path and re-resolve, which re-downloads into the cache.
      track.filePath = ''
    }
    const network = track.networkSource
    if (!network || !window.api?.networkSources) {
      throw new Error('Unable to resolve network stream URL')
    }
    const plan = await window.api.networkSources.resolvePlayback(network.profileId, network.entry)
    const target = plan.kind === 'direct-url' ? plan.url : plan.cacheFilePath
    if (!target) throw new Error('Unable to resolve network stream URL')
    track.filePath = target
    return target
  }

  const ncmPlaybackQuality = appSettings.value.ncmPlaybackQuality
  // Do not reuse a remote NCM URL when a managed disk cache may already exist;
  // the provider is the authority for cache-hit local paths.
  const canReuseNcmStream = source !== 'ncm' || track.streamQuality === ncmPlaybackQuality
  if (
    source !== 'ncm' &&
    track.streamUrl &&
    shouldReuseResolvedStreamUrl(source) &&
    canReuseNcmStream
  ) {
    // Session-scoped twilight-media grants die with the main-process grant map.
    // Never reuse a stale audio grant — re-resolve so protectProviderMedia issues
    // a live token (or the provider returns a fresh cache path / stream URL).
    if (!/^twilight-media:/i.test(track.streamUrl)) {
      return track.streamUrl
    }
  }
  if (
    source === 'ncm' &&
    track.streamUrl &&
    shouldReuseResolvedStreamUrl(source) &&
    canReuseNcmStream &&
    !/^https?:\/\//i.test(track.streamUrl) &&
    !/^twilight-media:/i.test(track.streamUrl)
  ) {
    // Local cache path previously returned by the provider. The managed cache
    // may have been cleared since, so only reuse a path that still exists;
    // otherwise re-resolve through the provider, which re-fetches online and
    // re-caches on demand. loadAndPlay commits the resolved target back onto
    // the track, so no clearing is needed here.
    if (await isUsableLocalPlaybackFile(track.streamUrl)) return track.streamUrl
  }

  await syncPluginProviders()
  const streamUrl = await useMediaProviders().resolvePlaybackUrl(
    track,
    source === 'ncm' ? { quality: ncmPlaybackQuality } : undefined
  )
  if (!streamUrl) {
    if (source === 'ncm') {
      throw new Error('当前网易云账号没有可播放的音质，请检查登录状态、歌曲版权和会员权益')
    }
    throw new Error(`Unable to resolve ${source} stream URL`)
  }

  return streamUrl
}

async function handlePlaybackFallback(
  failedTrack: Track,
  reason: unknown,
  loadToken: number
): Promise<boolean> {
  if (!isActiveLoad(loadToken, failedTrack)) return false
  const failedSource = getTrackSource(failedTrack)
  const fallback = findPlaybackFallbackTrack({
    failedTrack,
    candidates: queue.value,
    unavailableSources: [failedSource],
    sourceReliability: getProviderSourceReliability()
  })
  if (!fallback) return await handleProviderRematchFallback(failedTrack, loadToken)

  // A fallback succeeded: audio is still playing, so this is a warning.
  const fallbackLocale = currentLocale()
  setAudioEngineError(
    translate(fallbackLocale, 'error.audio.playback_fallback_switched', {
      title: failedTrack.title || translate(fallbackLocale, 'error.audio.current_track'),
      source: fallback.source ?? getTrackSource(fallback),
      reason: presentError(fallbackLocale, reason)
    }),
    'warning'
  )
  nativePlaybackActive = false
  loadedTrackId = ''
  stopVisualizationPolling(true)
  stopRendererAudio(true)

  const fallbackSnapshot = toPlaybackQueueSnapshot(fallback)
  queue.value = queue.value.map((track) =>
    track.id === failedTrack.id ? { ...fallbackSnapshot, queueEntryId: track.queueEntryId } : track
  )
  originalQueue.value = originalQueue.value.map((track) =>
    track.id === failedTrack.id ? { ...fallbackSnapshot, queueEntryId: track.queueEntryId } : track
  )
  queueIndex.value = queue.value.findIndex((track) => track.id === fallback.id)
  if (queueIndex.value < 0) queueIndex.value = 0
  currentTrack.value = fallback
  await loadAndPlay(fallback)
  return true
}

function getProviderSourceReliability(): ProviderSourceReliability {
  const reliability: ProviderSourceReliability = {}
  for (const provider of useMediaProviders().list()) {
    const playbackUrlRate = provider.health?.methodStats?.getPlaybackUrl?.successRate
    const successRate =
      typeof playbackUrlRate === 'number' ? playbackUrlRate : provider.health?.successRate
    reliability[provider.id] = clampProviderReliability(successRate)
  }
  return reliability
}

async function handleProviderRematchFallback(
  failedTrack: Track,
  loadToken: number
): Promise<boolean> {
  if (!isActiveLoad(loadToken, failedTrack)) return false
  const failedSource = getTrackSource(failedTrack)

  await syncPluginProviders()
  const searchResult = await useMediaProviders().searchAllSongs({
    query: [failedTrack.title, failedTrack.artist].filter(Boolean).join(' '),
    localTracks: queue.value
  })
  const candidates = searchResult.items
    .map((item) => item.track)
    .filter((track) =>
      failedSource === 'local'
        ? getTrackSource(track) !== 'local'
        : getTrackSource(track) !== failedSource || track.id !== failedTrack.id
    )
  const rematched = findProviderRematchCandidate(failedTrack, candidates)
  if (!rematched || !isActiveLoad(loadToken, failedTrack)) return false

  // Rematch succeeded: playback continues from another source.
  const rematchLocale = currentLocale()
  setAudioEngineError(
    translate(rematchLocale, 'error.audio.playback_fallback_rematched', {
      title: failedTrack.title || translate(rematchLocale, 'error.audio.current_track'),
      source: rematched.source ?? getTrackSource(rematched)
    }),
    'warning'
  )
  nativePlaybackActive = false
  loadedTrackId = ''
  stopVisualizationPolling(true)
  stopRendererAudio(true)

  const rematchedSnapshot = toPlaybackQueueSnapshot(rematched)
  queue.value = queue.value.map((track) =>
    track.id === failedTrack.id ? { ...rematchedSnapshot, queueEntryId: track.queueEntryId } : track
  )
  originalQueue.value = originalQueue.value.map((track) =>
    track.id === failedTrack.id ? { ...rematchedSnapshot, queueEntryId: track.queueEntryId } : track
  )
  queueIndex.value = queue.value.findIndex((track) => track.id === rematched.id)
  if (queueIndex.value < 0) queueIndex.value = 0
  currentTrack.value = rematched
  // Persist the rematch so playlists/library references to the expired
  // provider track are replaced — not just the transient playback queue.
  if (failedSource !== 'local') {
    useMusicStore().replaceTrackReference(failedTrack.id, rematched)
  }
  await loadAndPlay(rematched)
  return true
}

function retryCurrentTrackLyricsIfNeeded(forceReload = false): void {
  lyricsLoader.retryCurrentTrackLyricsIfNeeded(forceReload)
}

async function refreshPlaybackInfoAfterStartFile(): Promise<void> {
  const api = window.api?.audioEngine
  if (!api) return

  const refreshGeneration = ++startFilePlaybackInfoRefreshGeneration
  const trackIdAtStart = currentTrack.value?.id ?? ''
  for (let attempt = 0; attempt < START_FILE_PLAYBACK_INFO_REFRESH_ATTEMPTS; attempt += 1) {
    if (currentTrack.value?.id !== trackIdAtStart) {
      retryCurrentTrackLyricsIfNeeded()
      return
    }
    try {
      const info = await api.getPlaybackInfo()
      if (refreshGeneration !== startFilePlaybackInfoRefreshGeneration) return
      applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
      if (currentTrack.value?.id !== trackIdAtStart) {
        retryCurrentTrackLyricsIfNeeded()
        return
      }
    } catch {
      // A later attempt can observe the post-boundary native service snapshot.
    }

    if (attempt + 1 < START_FILE_PLAYBACK_INFO_REFRESH_ATTEMPTS) {
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, START_FILE_PLAYBACK_INFO_REFRESH_DELAY_MS)
      )
    }
  }

  if (refreshGeneration === startFilePlaybackInfoRefreshGeneration) {
    retryCurrentTrackLyricsIfNeeded()
  }
}

async function refreshPlaybackAfterRendererResume(): Promise<void> {
  if (rendererResumePlaybackInfoRefresh) return rendererResumePlaybackInfoRefresh

  rendererResumePlaybackInfoRefresh = (async () => {
    try {
      const info = await window.api?.audioEngine?.getPlaybackInfo()
      if (info) applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
    } catch {
      // Playback events can resume independently after a short service delay.
    } finally {
      retryCurrentTrackLyricsIfNeeded(true)
      rendererResumePlaybackInfoRefresh = null
    }
  })()

  return rendererResumePlaybackInfoRefresh
}

function setupAudioEngineListeners(): void {
  if (listenersSetup) return
  listenersSetup = true

  const api = window.api?.audioEngine
  if (!api) return

  const settingsApi = window.api?.settings

  cleanupFns.push(
    api.onPropertyChange(({ name, data }) => {
      switch (name) {
        case 'time-pos':
          // 兜底（HTMLAudio）模式下原生 time-pos 与 <audio> timeupdate 双源竞争，
          // 会造成进度冻结；只在原生播放时应用原生时间。
          if (!shouldApplyNativeTimePosition({ nativePlaybackActive, nativeQueueDelegated })) {
            break
          }
          if (typeof data === 'number' && isFinite(data)) {
            applyPlaybackPositionSample(data, 'native-time-pos')
          }
          break
        case 'duration':
          if (typeof data === 'number' && isFinite(data) && data > 0) {
            duration.value = data
          }
          break
        case 'pause':
          if (
            !nativePlaybackActive &&
            !nativeQueueDelegated &&
            !isPlaying.value &&
            !isLoading.value
          ) {
            break
          }
          applyNativePlayingState(!data, data === true ? getLatestPlaybackTime() : null)
          flushLatestCurrentTime()
          break
        case 'eof-reached':
          handleNativePlaybackEnded()
          break
      }
      if (name === 'time-pos' || name === 'duration') {
        scheduleCrossfadeIfNeeded()
      }
    })
  )

  cleanupFns.push(
    api.onEndFile((reason) => {
      if ((nativePlaybackActive || nativeQueueDelegated) && reason === 'eof') {
        handleNativePlaybackEnded()
      }
    })
  )

  cleanupFns.push(
    api.onStartFile(() => {
      // Gapless / delegated auto-advance emits start-file without going through
      // loadAndPlay or advanceNativePlayback. Always refresh track identity +
      // progress so cover and the playbar slider rebind to the new file.
      advancingFromEndedTrackId = ''
      autoAdvanceInFlight = false
      // Consume pending start once so gapless handoffs / late events cannot
      // re-apply a stale loadAndPlay start offset and freeze the progress bar.
      const startAt = pendingLoadStartTime
      pendingLoadStartTime = 0
      beginPlaybackPositionTransition(startAt, { keepRendererClockAlive: true })
      isLoading.value = false
      // start-file is emitted by the native backend when the new file has
      // entered its playback pipeline. Re-open both clocks immediately: a
      // stale pause snapshot may have cleared isPlaying before this event, and
      // leaving nativePlaybackActive false would make the time-pos policy drop
      // every sample from the new track.
      if (currentTrack.value && playbackToggleIntent?.playing !== false) {
        setPlaybackToggleIntent(true)
        nativePlaybackActive = true
        isPlaying.value = true
      }
      void refreshPlaybackInfoAfterStartFile()
    })
  )

  const refreshAfterRendererResume = (): void => {
    if (document.visibilityState === 'hidden') return
    void refreshPlaybackAfterRendererResume()
  }
  document.addEventListener('visibilitychange', refreshAfterRendererResume)
  window.addEventListener('focus', refreshAfterRendererResume)
  cleanupFns.push(() => {
    document.removeEventListener('visibilitychange', refreshAfterRendererResume)
    window.removeEventListener('focus', refreshAfterRendererResume)
  })

  cleanupFns.push(
    api.onPlaybackInfo((info) => {
      applyNativePlaybackInfo(info)
    })
  )

  if (typeof api.onLoudnormStatus === 'function') {
    cleanupFns.push(
      api.onLoudnormStatus((event) => {
        loudnormStatus.value = event.status
        loudnormStatusSource.value = event.source
      })
    )
  }

  if (api.onDeviceOptionsChanged) {
    cleanupFns.push(
      api.onDeviceOptionsChanged(() => {
        void refreshAudioOutputState()
      })
    )
  }

  if (api.onServiceCrash) {
    cleanupFns.push(
      api.onServiceCrash(({ reason, fatal }) => {
        setAudioServiceCrashNotice(reason, { fatal: fatal === true })
      })
    )
  }

  if (api.onServiceReady) {
    cleanupFns.push(
      api.onServiceReady((event) => {
        audioEngineReady.value = true
        if (event.outputRouteSynced) {
          setAudioEngineError(null)
        } else {
          audioEngineError.value =
            event.restoreErrors?.join('；') ||
            translate(currentLocale(), 'error.audio.output_route_not_restored')
        }
        setAudioServiceReadyNotice({
          outputRouteSynced: event.outputRouteSynced === true,
          restoreErrors: event.restoreErrors
        })
        void refreshAudioOutputState()
      })
    )
  }

  cleanupFns.push(
    api.onReady(async () => {
      const recoveredFromServiceCrash = audioEngineRecoveryNotice.value?.kind === 'service-crash'
      audioEngineReady.value = true
      if (recoveredFromServiceCrash) {
        const locale = currentLocale()
        setAudioServiceReadyNotice({
          outputRouteSynced: false,
          restoreErrors: [translate(locale, 'error.audio.awaiting_route_confirmation')]
        })
        audioEngineError.value = translate(locale, 'error.audio.output_route_not_restored')
      } else {
        setAudioEngineError(null)
      }
      api.setVolume(volume.value).catch(() => {})
      api.setPlaybackRate(playbackRate.value).catch(() => {})
      await refreshAudioOutputState()
      try {
        const nativeInfo = await api.getPlaybackInfo()
        audioOutputConfig.value = {
          ...(appSettings.value?.audioOutputConfig ?? defaultAudioOutputConfig)
        }
        playbackInfo.value = normalizeNativePlaybackInfo(nativeInfo)
      } catch {
        // keep default
      }
    })
  )

  cleanupFns.push(
    api.onError((message) => {
      // The sentinel classifies the failure; the prose is only for the console.
      // Reading `code` instead of substring-matching Chinese keeps crash handling
      // working in every language.
      const detail = presentErrorDetail(currentLocale(), message)
      console.error('[audio-engine] Playback error:', detail.developerMessage || message)
      if (detail.code === 'audio.service_fatal') {
        audioEngineError.value = detail.display
        setAudioServiceCrashNotice(String(detail.params.reason ?? ''), { fatal: true })
      } else if (detail.code === 'audio.service_crashed') {
        audioEngineError.value = detail.display
        setAudioServiceCrashNotice(String(detail.params.reason ?? ''))
      } else {
        setAudioEngineError(detail.display)
      }
      clearPlaybackToggleIntent()
      clearNativePlaybackInfoIntent()
      isPlaying.value = false
      isLoading.value = false
    })
  )

  cleanupFns.push(
    api.onDisconnected(() => {
      audioEngineReady.value = false
      nativePlaybackActive = false
      clearPlaybackToggleIntent()
      clearNativePlaybackInfoIntent()
      isPlaying.value = false
    })
  )

  if (settingsApi?.onPlayerShortcut) {
    cleanupFns.push(
      settingsApi.onPlayerShortcut((action) => {
        void handlePlayerShortcutAction(action)
      })
    )
  }

  // Publish playback snapshot for LAN web remote / SSE.
  let lastRemotePublishAt = 0
  const publishRemoteSnapshot = (): void => {
    const remoteApi = window.api?.remote
    if (!remoteApi?.publishState) return
    const now = Date.now()
    if (now - lastRemotePublishAt < 400) return
    lastRemotePublishAt = now
    const track = currentTrack.value
    const isLive =
      track?.source === 'radio' ||
      (typeof track?.duration === 'number' && track.duration <= 0 && duration.value <= 0)
    void remoteApi.publishState({
      state: isPlaying.value ? 'playing' : track ? 'paused' : 'stopped',
      title: track?.title ?? '',
      artist: track?.artist ?? '',
      album: track?.album ?? '',
      position: currentTime.value,
      duration: duration.value,
      volume: volume.value,
      muted: muted.value,
      queueIndex: queueIndex.value,
      queueLength: queue.value.length,
      coverUrl: null,
      isLive: Boolean(isLive),
      castTarget: castTargetName.value,
      updatedAt: now
    })
  }
  cleanupFns.push(
    watch(
      [isPlaying, currentTime, duration, volume, muted, queueIndex, () => currentTrack.value?.id],
      () => publishRemoteSnapshot()
    )
  )
  publishRemoteSnapshot()

  if (settingsApi?.onChanged) {
    cleanupFns.push(
      settingsApi.onChanged((snapshot) => {
        audioOutputConfig.value = {
          ...defaultAudioOutputConfig,
          ...snapshot.settings.audioOutputConfig
        }
        audioProcessing.value = {
          ...defaultAudioProcessing,
          ...snapshot.settings.audioProcessing,
          eqBands: snapshot.settings.audioProcessing.eqBands.map((band) => ({ ...band }))
        }
        const defaultScene = snapshot.settings.dspScenes?.find((scene) => scene.id === 'default')
        if (defaultScene?.graph?.outputStage) {
          dspOutputStage.value = mergeDspOutputStage(defaultScene.graph.outputStage, {})
        }
        if (defaultScene?.graph) {
          dspStereoImage.value = extractStereoImageFromGraph(defaultScene.graph)
        }
      })
    )
  }

  void refreshAudioOutputState()
}

function dismissAudioEngineRecoveryNotice(): void {
  if (audioEngineRecoveryAppNoticeId) dismissNotice(audioEngineRecoveryAppNoticeId)
  audioEngineRecoveryAppNoticeId = 0
  audioEngineRecoveryNotice.value = null
}

function disposePlayerStoreRuntime(): void {
  // Release IPC subscriptions first: stale modules must never keep advancing
  // their own playback clock after a hot replacement has taken ownership.
  for (const cleanup of cleanupFns.splice(0).reverse()) {
    try {
      cleanup()
    } catch {
      // Every cleanup is best-effort; remaining handles are still released.
    }
  }
  listenersSetup = false
  playerRuntimeScope.stop()
  playerIntegrationSideEffectsSetup = false
  clearRendererPlaybackWatchdog()
  clearNativeStreamBufferingTimer()
  disposePlaybackClock()
  playbackHistoryController.dispose()
  clearCrossfadeTimer()
  stopVisualizationPolling(false)
}

// Claim before registering listeners. A Vite replacement invokes the previous
// generation's release callback, so one renderer window has one active audio
// event consumer and one lyric-loading state machine.
const playerRuntimeLease = claimRendererRuntime(
  PLAYER_RUNTIME_OWNERSHIP_KEY,
  disposePlayerStoreRuntime
)
setupAudioEngineListeners()
startRendererPlaybackClock()

configurePlayerStoreHmr(
  import.meta.hot,
  () => window.location.reload(),
  () => playerRuntimeLease.release()
)

watch([isPlaying, playbackRate], ([playing, rate], [previousPlaying, previousRate]) => {
  if (playing && (playing !== previousPlaying || rate !== previousRate)) {
    anchorRendererPlaybackClock(currentTime.value)
  }
})

watch(
  [isPlaying, audioEngineReady, () => currentTrack.value?.id, visualizerActive],
  ([playing, ready, trackId, activeVisualizer]) => {
    if (playing && ready && trackId && !activeVisualizer) {
      startVisualizationPolling()
      return
    }
    stopVisualizationPolling(activeVisualizer ? false : true)
  },
  { immediate: true }
)

function clearCrossfadeTimer(): void {
  if (crossfadeTimer) {
    window.clearTimeout(crossfadeTimer)
    crossfadeTimer = null
  }
  crossfadeTrackId = ''
}

function scheduleCrossfadeIfNeeded(): void {
  const seconds = audioProcessing.value.crossfadeSeconds
  const track = currentTrack.value
  if (
    !track ||
    !isPlaying.value ||
    nativePlaybackActive ||
    playMode.value === 'repeat' ||
    seconds <= 0 ||
    duration.value <= seconds + 1
  ) {
    clearCrossfadeTimer()
    return
  }

  if (queue.value.length <= 1) return
  if (queueIndex.value + 1 >= queue.value.length) return

  const remaining = duration.value - getLatestPlaybackTime()
  if (remaining > seconds || remaining < 0) {
    if (crossfadeTrackId !== track.id) clearCrossfadeTimer()
    return
  }

  if (crossfadeTrackId === track.id) return
  crossfadeTrackId = track.id
  crossfadeTimer = window.setTimeout(
    () => {
      crossfadeTimer = null
      next()
    },
    Math.max(0, remaining * 1000)
  )
}

async function loadAndPlay(track: Track, startTime = 0): Promise<void> {
  // Capture previous playback identity before this load mutates state.
  // Callers (playTrack / next / previous) often set currentTrack and even replace
  // the queue before invoking loadAndPlay, so prefer lastActiveTrack.
  const previousTrack =
    lastActiveTrack && lastActiveTrack.id !== track.id
      ? lastActiveTrack
      : currentTrack.value && currentTrack.value.id !== track.id
        ? currentTrack.value
        : null
  if (previousTrack && previousTrack.id !== track.id) {
    playbackHistoryController.recordTrackDeparture(previousTrack)
  }
  playbackHistoryController.clearResumeOfferForOtherTrack(track)

  const normalizedStartTime = clampCuePlaybackPosition(track, startTime)
  const loadToken = ++activeLoadToken
  // New load is always an intentional play — drop pause-toggle grace so a
  // prior pause cannot keep the UI stuck while this track starts.
  clearPlaybackToggleIntent()
  setNativePlaybackInfoIntent(loadToken, track)
  stopVisualizationPolling(false)
  isLoading.value = true
  resetNativeStreamBufferingState()
  streamNowPlaying.value = ''
  nativePlaybackActive = false
  nativeQueueDelegated = false
  stopRendererAudio(true)
  if (playbackAudio) playbackAudio.muted = false
  pendingLoadStartTime = normalizedStartTime
  duration.value = cueDuration(track)
  beginPlaybackPositionTransition(normalizedStartTime, { keepRendererClockAlive: true })
  clearAbLoop()
  clearCrossfadeTimer()

  // Apply remembered podcast playback rate (or reset to 1 when leaving podcasts).
  if (track.source === 'podcast') {
    const preferred = getPodcastDefaultPlaybackRate()
    if (Math.abs(playbackRate.value - preferred) > 0.001) {
      void setPlaybackRate(preferred)
    }
  } else if (previousTrack?.source === 'podcast' && Math.abs(playbackRate.value - 1) > 0.001) {
    // Leaving a podcast: restore unity rate so music stays bit-perfect by default.
    void setPlaybackRate(1)
  }

  const releaseLoadIfOwned = (): void => {
    // Only the still-current load token may clear loading. A superseded load
    // must leave isLoading true for the newer owner.
    if (loadToken === activeLoadToken) isLoading.value = false
  }

  try {
    await stopNativeAudio()
    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }

    const playTarget = await resolvePlayTarget(track)
    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    track.streamUrl = playTarget
    if (getTrackSource(track) === 'ncm') {
      track.streamQuality = appSettings.value.ncmPlaybackQuality
      rememberNcmStreamUrlCommit(track.id)
    }
    patchTrackInQueues(track)
    nativeSourceToTrackId.set(playTarget, track.id)
    // resolvePlayTarget 只改写了传入的 track 对象，而 active currentTrack 是
    // 激活时的拷贝；若不回写，后续队列重同步（如切换播放模式）会因取不到
    // source 而误判“当前曲目不支持原生播放”→ stopNativeAudio → 误触发切歌。
    if (currentTrack.value && currentTrack.value.id === track.id) {
      currentTrack.value = {
        ...currentTrack.value,
        streamUrl: track.streamUrl ?? currentTrack.value.streamUrl,
        filePath: track.filePath ?? currentTrack.value.filePath,
        streamQuality: track.streamQuality ?? currentTrack.value.streamQuality
      }
    }
    setNativePlaybackInfoIntent(loadToken, track, playTarget)
    const useNativePlayback = shouldUseNativePlayback(track, playTarget)

    let nativeStarted = false
    let nativeFallbackReason = ''

    if (useNativePlayback) {
      try {
        const preparedQueue = await preparePlayerNativeQueue(
          {
            // 心动模式：渲染层自行驱动切歌与补拉，原生引擎只加载当前曲目。
            queue: stripStaleNcmStreamUrls(playMode.value === 'heart' ? [track] : queue.value, {
              committedAtByTrackId: ncmStreamUrlCommittedAt
            }),
            currentTrack: track,
            currentTarget: playTarget,
            currentIndex: playMode.value === 'heart' ? 0 : queueIndex.value
          },
          {
            isAudioFileAuthorized: window.api.fs.isAudioFileAuthorized,
            areAudioFilesAuthorized: window.api.fs.areAudioFilesAuthorized
          }
        )
        if (!preparedQueue) {
          throw new Error('Native playback target is unavailable')
        }
        for (const item of preparedQueue.items) {
          nativeSourceToTrackId.set(item.source, item.id)
        }
        // 当前播放 source 挪到最新插入位，保证淘汰时最后才被考虑。
        nativeSourceToTrackId.delete(playTarget)
        nativeSourceToTrackId.set(playTarget, track.id)
        pruneNativeSourceToTrackId(preparedQueue.items, playTarget)
        if (!isActiveLoad(loadToken, track)) {
          releaseLoadIfOwned()
          return
        }

        await window.api.audioEngine.loadQueue(preparedQueue.items, preparedQueue.startIndex)
        if (!isActiveLoad(loadToken, track)) {
          releaseLoadIfOwned()
          return
        }
        nativeQueueDelegated = preparedQueue.delegated
        // 心动模式由渲染层驱动切歌与补拉，原生队列不代管边界。
        if (playMode.value === 'heart') nativeQueueDelegated = false

        const nativePlayMode = toNativePlayMode(playMode.value)
        await window.api.audioEngine.setPlayMode(nativePlayMode)
        if (!isActiveLoad(loadToken, track)) {
          releaseLoadIfOwned()
          return
        }

        const playResult = await window.api.audioEngine.play(playTarget, normalizedStartTime)
        if (!isActiveLoad(loadToken, track)) {
          releaseLoadIfOwned()
          return
        }
        nativeStarted = playResult?.nativeStarted === true
        nativeFallbackReason = playResult?.fallbackReason ?? ''
      } catch (engineErr) {
        if (!isActiveLoad(loadToken, track)) {
          releaseLoadIfOwned()
          return
        }
        nativeQueueDelegated = false
        nativeFallbackReason = engineErr instanceof Error ? engineErr.message : String(engineErr)
        console.warn(
          '[audio-engine] Native output unavailable, falling back to Electron playback:',
          engineErr
        )
      }
    }

    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    nativePlaybackActive = nativeStarted

    if (nativePlaybackActive) {
      setAudioEngineError('')
      stopRendererAudio(true)
    } else if (useNativePlayback) {
      nativeQueueDelegated = false
      clearNativePlaybackInfoIntentForLoad(loadToken)
      const htmlAudioFallbackAllowed =
        typeof window.api?.audioEngine?.isHtmlAudioFallbackAllowed === 'function'
          ? await window.api.audioEngine.isHtmlAudioFallbackAllowed()
          : false
      if (!isActiveLoad(loadToken, track)) {
        releaseLoadIfOwned()
        return
      }
      if (!htmlAudioFallbackAllowed) {
        setAudioEngineError(
          nativeFallbackReason
            ? translate(currentLocale(), 'error.audio.native_unavailable_detail', {
                reason: nativeFallbackReason
              })
            : translate(currentLocale(), 'error.audio.native_unavailable')
        )
        isPlaying.value = false
        releaseLoadIfOwned()
        return
      }
      // Degraded but audible: the HTML audio path took over, so this is a
      // warning rather than an error.
      setAudioEngineError(
        nativeFallbackReason
          ? translate(currentLocale(), 'error.audio.native_fallback', {
              reason: nativeFallbackReason
            })
          : '',
        'warning'
      )
      const rendererStarted = await playWithRendererAudio(
        track,
        playTarget,
        normalizedStartTime,
        loadToken
      )
      if (!rendererStarted || !isActiveLoad(loadToken, track)) {
        releaseLoadIfOwned()
        return
      }
      scheduleRendererPlaybackWatchdog(track, loadToken)
    } else {
      nativeQueueDelegated = false
      clearNativePlaybackInfoIntentForLoad(loadToken)
      setAudioEngineError('')
      const rendererStarted = await playWithRendererAudio(
        track,
        playTarget,
        normalizedStartTime,
        loadToken
      )
      if (!rendererStarted || !isActiveLoad(loadToken, track)) {
        releaseLoadIfOwned()
        return
      }
      scheduleRendererPlaybackWatchdog(track, loadToken)
    }

    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    advancingFromEndedTrackId = ''
    autoAdvanceInFlight = false
    loadedTrackId = track.id
    lastActiveTrack = track
    const resumeAt =
      restoredPlaybackPending && Number.isFinite(restoredPlaybackPosition)
        ? clampCuePlaybackPosition(track, restoredPlaybackPosition)
        : normalizedStartTime
    restoredPlaybackPending = false
    restoredPlaybackPosition = 0
    beginPlaybackPositionTransition(resumeAt, { keepRendererClockAlive: true })
    if (resumeAt > 0.05 && Math.abs(resumeAt - normalizedStartTime) > 0.05) {
      if (nativePlaybackActive) {
        void window.api.audioEngine.seek(resumeAt).catch(() => {})
      } else if (playbackAudio) {
        playbackAudio.currentTime = rendererAudioAbsolutePositionForTrack(resumeAt, track)
      }
    }
    isLoading.value = false
    isPlaying.value = true
    startVisualizationPolling()
    playbackHistoryController.maybeOfferResumeForTrack(track, resumeAt)
  } catch (err) {
    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    clearNativePlaybackInfoIntentForLoad(loadToken)
    if (await handlePlaybackFallback(track, err, loadToken)) return
    console.error('[audio-engine] Playback failed:', err)
    setAudioEngineError(err instanceof Error ? err.message : String(err))
    autoAdvanceInFlight = false
    isLoading.value = false
    isPlaying.value = false
    nativePlaybackActive = false
    nativeQueueDelegated = false
    stopVisualizationPolling(true)
  }
}

function playQueueTrack(track: Track): void {
  activateCurrentTrack(track, { resetUi: true, position: 0 })
  // While casting, re-cast the new track to the same device instead of
  // starting local engine playback underneath the cast session.
  if (castTargetUsn.value) {
    void castCurrentTrackToDevice(castTargetUsn.value).catch((error) => {
      console.error('[cast] queue skip re-cast failed:', error)
      void loadAndPlay(track)
    })
    return
  }
  void loadAndPlay(track)
}

function next(): void {
  if (queue.value.length === 0) return
  clearCrossfadeTimer()
  if (playMode.value === 'heart') {
    void advanceHeartPlayback()
    return
  }

  if (!castTargetUsn.value && nativePlaybackActive && isNativeQueueDelegated()) {
    void advanceNativePlayback('next')
    return
  }

  applyPendingRendererPlayModeAtBoundary()
  const nextIndex = queueIndex.value + 1
  if (nextIndex < queue.value.length) {
    queueIndex.value = nextIndex
    const track = queue.value[nextIndex]
    playQueueTrack(track)
  } else {
    queueIndex.value = 0
    const track = queue.value[0]
    playQueueTrack(track)
  }
}

function jumpQueue(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= queue.value.length) return
  clearCrossfadeTimer()
  queueIndex.value = index
  const track = queue.value[index]
  if (!track) return
  playQueueTrack(track)
}

async function handlePlayerShortcutAction(
  action: import('../types/settings').PlayerShortcutAction
): Promise<void> {
  if (typeof action === 'string') {
    if (action === 'previous') {
      previous()
      return
    }
    if (action === 'next') {
      next()
      return
    }
    if (action === 'play') {
      if (!isPlaying.value) await togglePlayState()
      return
    }
    if (action === 'pause') {
      if (isPlaying.value) await togglePlayState()
      return
    }
    if (action === 'toggleDesktopLyrics') {
      const enabled = await window.api.desktopLyrics.setEnabled(
        !appSettings.value.desktopLyrics.enabled
      )
      await updateSettings({ desktopLyrics: { ...appSettings.value.desktopLyrics, enabled } })
      return
    }
    if (action === 'toggleDesktopLyricsLock') {
      await updateSettings({
        desktopLyrics: {
          ...appSettings.value.desktopLyrics,
          locked: !appSettings.value.desktopLyrics.locked
        }
      })
      return
    }
    // playPause
    await togglePlayState()
    return
  }
  if (action.action === 'seek') {
    seekPlayback(action.positionSeconds)
    return
  }
  if (action.action === 'setVolume') {
    volume.value = Math.min(1, Math.max(0, action.volume))
    return
  }
  if (action.action === 'jumpQueue') {
    jumpQueue(action.index)
  }
}

async function togglePlayState(): Promise<void> {
  const track = currentTrack.value
  if (!track) return
  if (loadedTrackId !== track.id) {
    await loadAndPlay(track, restoredPlaybackPending ? restoredPlaybackPosition : 0)
    return
  }
  const casting = Boolean(castTargetName.value)
  try {
    if (casting) {
      // Local engine stays paused while casting; only mirror transport to the device.
      const nextPlaying = !isPlaying.value
      if (isPlaying.value && !nextPlaying) {
        playbackHistoryController.maybeRecordResumeBookmark(track, getLatestPlaybackTime())
        playbackHistoryController.flushPodcastEpisodeProgress(true)
      }
      isPlaying.value = nextPlaying
      void window.api.remote
        ?.controlCast?.(nextPlaying ? { play: true } : { pause: true })
        .catch(() => {})
      return
    }
    if (nativePlaybackActive) {
      const nextPlaying = !isPlaying.value
      if (isPlaying.value && !nextPlaying) {
        playbackHistoryController.maybeRecordResumeBookmark(track, getLatestPlaybackTime())
        playbackHistoryController.flushPodcastEpisodeProgress(true)
      }
      isPlaying.value = nextPlaying
      setPlaybackToggleIntent(nextPlaying)
      await window.api.audioEngine.togglePause()
      // Do not clear the intent here. togglePause publishes the confirmed state,
      // but a tick that was already in flight can still report the previous
      // pause/play value. Re-arm from the current UI state (not the closed-over
      // nextPlaying) so a second click during the await cannot be undone by
      // re-applying the first click's intent.
      setPlaybackToggleIntent(isPlaying.value)
    } else {
      const audio = getPlaybackAudio()
      if (audio.paused) {
        await stopNativeAudio()
        await audio.play()
      } else {
        playbackHistoryController.maybeRecordResumeBookmark(track, getLatestPlaybackTime())
        playbackHistoryController.flushPodcastEpisodeProgress(true)
        audio.pause()
      }
    }
  } catch (err) {
    if (nativePlaybackActive) {
      isPlaying.value = !isPlaying.value
      clearPlaybackToggleIntent()
    }
    console.error('[audio-engine] togglePlay failed:', err)
  }
}

function previous(): void {
  if (queue.value.length === 0) return
  clearCrossfadeTimer()
  if (appSettings.value.previousButtonAction === 'restart' && getLatestPlaybackTime() > 3) {
    const track = currentTrack.value
    beginPlaybackPositionTransition(0)
    if (track && loadedTrackId !== track.id) {
      restoredPlaybackPending = true
      restoredPlaybackPosition = 0
    } else if (castTargetName.value) {
      void window.api.remote?.controlCast?.({ seek: 0 }).catch(() => {})
    } else if (nativePlaybackActive) {
      window.api.audioEngine.seek(0).catch(() => {})
    } else if (playbackAudio && track) {
      playbackAudio.currentTime = rendererAudioAbsolutePositionForTrack(0, track)
    }
    return
  }
  if (!castTargetUsn.value && nativePlaybackActive && isNativeQueueDelegated()) {
    void advanceNativePlayback('previous')
    return
  }

  applyPendingRendererPlayModeAtBoundary()
  const prevIndex = queueIndex.value - 1
  if (prevIndex >= 0) {
    queueIndex.value = prevIndex
    playQueueTrack(queue.value[prevIndex])
  } else {
    const lastIndex = queue.value.length - 1
    queueIndex.value = lastIndex
    playQueueTrack(queue.value[lastIndex])
  }
}

function seekPlayback(time: number): void {
  const track = currentTrack.value
  const position = track ? clampCuePlaybackPosition(track, time) : Math.max(0, time)
  if (!track) {
    beginPlaybackPositionTransition(position)
    return
  }
  if (isLoading.value) {
    restoredPlaybackPending = true
    restoredPlaybackPosition = position
    beginPlaybackPositionTransition(position)
    return
  }
  beginPlaybackPositionTransition(position)
  if (castTargetName.value) {
    void window.api.remote?.controlCast?.({ seek: position }).catch(() => {})
    return
  }
  if (nativePlaybackActive || nativeQueueDelegated) {
    window.api.audioEngine.seek(position).catch(() => {})
  } else if (playbackAudio) {
    playbackAudio.currentTime = rendererAudioAbsolutePositionForTrack(position, track)
  }
}

function clearAbLoop(): void {
  abLoopA.value = null
  abLoopB.value = null
  abLoopNativeActive = false
  // Prefer native clear; soft path is a no-op when range is null.
  void window.api?.audioEngine?.setLoopRange?.(-1, -1).catch(() => {})
}

/** Push current A-B range to native engine when both points are set; otherwise clear. */
function syncNativeAbLoop(): void {
  const a = abLoopA.value
  const b = abLoopB.value
  const api = window.api?.audioEngine?.setLoopRange
  if (!api) return
  if (a == null || b == null || b <= a || isCurrentTrackLiveStream()) {
    abLoopNativeActive = false
    void api(-1, -1).catch(() => {})
    return
  }
  void api(a, b)
    .then((ok) => {
      // When native accepts, soft enforce becomes a safety net only.
      if (ok) abLoopNativeActive = true
      else abLoopNativeActive = false
    })
    .catch(() => {
      abLoopNativeActive = false
    })
}

function isCurrentTrackLiveStream(): boolean {
  const track = currentTrack.value
  if (!track) return false
  if (track.source === 'radio') return true
  return (
    typeof track.duration === 'number' &&
    track.duration <= 0 &&
    Boolean(track.streamUrl || /^https?:\/\//i.test(track.filePath || ''))
  )
}

function setAbLoopPoint(point: 'a' | 'b', time = getLatestPlaybackTime()): void {
  if (isCurrentTrackLiveStream()) return
  const position = Math.max(0, Number.isFinite(time) ? time : 0)
  if (point === 'a') {
    abLoopA.value = position
    if (abLoopB.value != null && abLoopB.value <= position) abLoopB.value = null
    syncNativeAbLoop()
    return
  }
  if (abLoopA.value == null) abLoopA.value = 0
  if (position <= (abLoopA.value ?? 0)) return
  abLoopB.value = position
  syncNativeAbLoop()
}

function toggleAbLoopAtCurrentTime(): void {
  if (isCurrentTrackLiveStream()) {
    clearAbLoop()
    return
  }
  if (abLoopA.value == null) {
    setAbLoopPoint('a')
    return
  }
  if (abLoopB.value == null) {
    setAbLoopPoint('b')
    return
  }
  clearAbLoop()
}

/** True when native SetLoopRange last accepted an active range (soft seek is backup). */
let abLoopNativeActive = false
let abLoopEnforcing = false
function enforceAbLoop(time: number): void {
  if (abLoopEnforcing) return
  if (isCurrentTrackLiveStream()) return
  // When native SetLoopRange is active, clock-thread seek owns enforcement.
  if (abLoopNativeActive) return
  const a = abLoopA.value
  const b = abLoopB.value
  if (a == null || b == null || b <= a) return
  // Soft A-B fallback when native binding is missing or rejected the range.
  if (time + 0.02 >= b) {
    abLoopEnforcing = true
    try {
      seekPlayback(a)
    } finally {
      abLoopEnforcing = false
    }
  }
}

let playerIntegrationSideEffectsSetup = false
let mediaSessionHandlersBound = false
let mediaSessionMetadataKey = ''
let discordPlayStartTimestamp: number | null = null

function updateMediaSessionPlaybackState(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  navigator.mediaSession.playbackState =
    appSettings.value?.smtcEnabled && currentTrack.value
      ? isPlaying.value
        ? 'playing'
        : 'paused'
      : 'none'
}

function updateMediaSessionPositionState(): void {
  if (
    typeof navigator === 'undefined' ||
    !('mediaSession' in navigator) ||
    !appSettings.value?.smtcEnabled ||
    !currentTrack.value ||
    duration.value <= 0 ||
    !Number.isFinite(currentTime.value)
  ) {
    return
  }

  try {
    navigator.mediaSession.setPositionState({
      duration: duration.value,
      position: Math.min(currentTime.value, duration.value),
      playbackRate: playbackRate.value
    })
  } catch {
    // setPositionState can throw if values are invalid; ignore
  }
}

function updateMediaSessionMetadata(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  if (!appSettings.value?.smtcEnabled) {
    mediaSessionMetadataKey = ''
    navigator.mediaSession.metadata = null
    navigator.mediaSession.playbackState = 'none'
    return
  }

  const track = currentTrack.value
  if (!track) {
    mediaSessionMetadataKey = ''
    navigator.mediaSession.metadata = null
    navigator.mediaSession.playbackState = 'none'
    return
  }

  const nextMetadataKey = [
    track.id,
    track.title || '',
    track.artist || '',
    track.album || '',
    track.cover || ''
  ].join('\u0000')

  if (mediaSessionMetadataKey !== nextMetadataKey) {
    mediaSessionMetadataKey = nextMetadataKey
    navigator.mediaSession.metadata =
      typeof MediaMetadata !== 'undefined'
        ? new MediaMetadata({
            title: track.title || '',
            artist: track.artist || '',
            album: track.album || '',
            artwork: track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }] : []
          })
        : null
  }

  updateMediaSessionPlaybackState()
  updateMediaSessionPositionState()
}

function setupMediaSessionHandlers(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  if (mediaSessionHandlersBound) return
  mediaSessionHandlersBound = true
  const ms = navigator.mediaSession
  ms.setActionHandler('play', () => {
    if (!isPlaying.value) void togglePlayState()
  })
  ms.setActionHandler('pause', () => {
    if (isPlaying.value) void togglePlayState()
  })
  ms.setActionHandler('previoustrack', () => {
    previous()
  })
  ms.setActionHandler('nexttrack', () => {
    next()
  })
  ms.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) seekPlayback(details.seekTime)
  })
  ms.setActionHandler('seekbackward', () => {
    seekPlayback(Math.max(0, currentTime.value - 10))
  })
  ms.setActionHandler('seekforward', () => {
    seekPlayback(Math.min(duration.value, currentTime.value + 10))
  })
}

function updateDiscordActivity(): void {
  const discordApi = window.api?.discord
  if (!discordApi) return

  if (appSettings.value?.discordRpcEnabled !== true) {
    discordApi.clearActivity().catch(() => {})
    return
  }
  const track = currentTrack.value
  if (!track || !isPlaying.value) {
    discordPlayStartTimestamp = null
    discordApi.clearActivity().catch(() => {})
    return
  }
  if (discordPlayStartTimestamp === null) {
    discordPlayStartTimestamp = Date.now()
  }
  discordApi
    .updateActivity({
      title: track.title || '',
      artist: track.artist || '',
      album: track.album || '',
      playing: true,
      startTime: discordPlayStartTimestamp
    })
    .catch(() => {})
}

function setupPlayerIntegrationSideEffects(): void {
  if (playerIntegrationSideEffectsSetup) return
  playerIntegrationSideEffectsSetup = true
  void lyricsManagement.ensureLoaded()
  if (window.api.sleepTimer) {
    void window.api.sleepTimer.getState().then((state) => {
      if (state?.active) getSleepTimerController().applyAuthoritativeState(state)
    })
    window.api.sleepTimer.onState((state) => {
      getSleepTimerController().applyAuthoritativeState(state)
    })
    window.api.sleepTimer.onTrigger((state) => {
      getSleepTimerController().applyTrigger(state)
    })
  }

  // This is deliberately owned by the player state machine rather than the
  // application shell. A user can select a track before asynchronous startup
  // work completes, and that selection must still survive a later restart.
  watch(
    () => currentTrack.value?.id,
    (trackId, previousTrackId) => {
      if (!trackId || trackId === previousTrackId) return
      persistSelectedTrackSession()
    },
    { flush: 'sync' }
  )

  watch(
    () => appSettings.value?.smtcEnabled,
    () => {
      if (appSettings.value?.smtcEnabled) setupMediaSessionHandlers()
      updateMediaSessionMetadata()
    },
    { immediate: true }
  )

  watch(
    [
      () => currentTrack.value?.id,
      () => currentTrack.value?.title,
      () => currentTrack.value?.artist,
      () => currentTrack.value?.album,
      () => currentTrack.value?.cover
    ],
    () => updateMediaSessionMetadata(),
    { immediate: true }
  )

  watch(
    isPlaying,
    () => {
      updateMediaSessionPlaybackState()
      if (!isPlaying.value) {
        discordPlayStartTimestamp = null
        // Pause/stop is a good moment to flush podcast progress.
        playbackHistoryController.flushPodcastEpisodeProgress(true)
      }
      updateDiscordActivity()
    },
    { immediate: true }
  )

  // Throttled podcast progress writeback while playing.
  watch(currentTime, () => {
    if (!isPlaying.value) return
    if (currentTrack.value?.source !== 'podcast') return
    playbackHistoryController.flushPodcastEpisodeProgress(false)
  })

  watch([currentTime, duration], () => {
    if (appSettings.value?.smtcEnabled && isPlaying.value) updateMediaSessionPositionState()
  })

  // 8.4：播放后段（≥70%）预解析下一首网易云地址；窗口内的地址由原生队列直接
  // 携带，切曲时 provider 命中磁盘/TTL 缓存即时返回，消除现场解析往返。
  watch([currentTime, duration], ([time, total]) => {
    if (!isPlaying.value || !Number.isFinite(total) || total <= 0) return
    if (time / total < NCM_PREFETCH_TRIGGER_PROGRESS) return
    void prefetchUpcomingNcmStream()
  })

  // 「next 意图」：曲目完成激活切换即预取再下一首（窗口内去重，零额外请求）。
  watch(
    () => currentTrack.value?.id,
    () => {
      if (isPlaying.value) void prefetchUpcomingNcmStream()
    }
  )

  watch(
    () => appSettings.value?.discordRpcEnabled,
    () => updateDiscordActivity(),
    { immediate: true }
  )

  watch(
    () => appSettings.value.playMode,
    (savedPlayMode) => {
      if (savedPlayMode && savedPlayMode !== playMode.value) {
        setPlayModeInternal(savedPlayMode, { persist: false })
      }
    },
    { immediate: true }
  )

  watch(heartModeAvailable, (available) => {
    if (!available && playMode.value === 'heart') {
      exitHeartModeToSequential()
    }
  })

  watch(
    () => appSettings.value.softwareVolume,
    (savedVolume) => {
      if (typeof savedVolume !== 'number' || !Number.isFinite(savedVolume)) return
      const next = clampSoftwareVolume(savedVolume)
      if (Math.abs(next - volume.value) < 0.0005) return
      suppressVolumePersist = true
      volume.value = next
      if (next > 0) lastAudibleVolume.value = next
      queueMicrotask(() => {
        suppressVolumePersist = false
      })
    },
    { immediate: true }
  )

  watch(
    [() => currentTrack.value?.queueEntryId, () => currentTrack.value?.id, queueIndex],
    () => markCurrentPersonalizedStreamTrackPlayed(),
    { flush: 'sync' }
  )

  watch(
    [() => currentTrack.value?.id, isPlaying],
    () => {
      const track = currentTrack.value
      if (track && isPlaying.value) void requestBpmAnalysisForTrack(track)
    },
    { immediate: true }
  )

  window.api?.bpmAnalysis?.onCompleted((event) => {
    applyBpmAnalysisToTrack(event.trackId, event.filePath, event.analysis)
  })
}

function cyclePlayMode(): void {
  const modes: PlayMode[] = ['sequential', 'listLoop', 'repeat', 'shuffle', 'heart']
  const cycleModes = heartModeAvailable.value ? modes : modes.filter((mode) => mode !== 'heart')
  const idx = cycleModes.indexOf(playMode.value)
  if (idx === -1) {
    setPlayModeInternal(cycleModes[0] ?? 'sequential')
    return
  }
  setPlayModeInternal(cycleModes[(idx + 1) % cycleModes.length])
}

function setPlayModeInternal(mode: PlayMode, options: { persist?: boolean } = {}): void {
  if (mode === playMode.value) return
  if (mode === 'heart') {
    if (!heartModeAvailable.value) return
    enterHeartMode(options)
    return
  }
  if (playMode.value === 'heart') {
    exitHeartModeToSequential()
  }
  playMode.value = mode
  // Preserve the active track, position and queue identity. Renderer fallback
  // applies the new ordering only when next/EOF reaches a track boundary.
  rendererPlayModeBoundaryPending.value = true
  // 心动模式分支在上面提前返回，因此这里只会持久化常规播放模式。
  if (options.persist !== false) {
    void updateSettings({ playMode: mode }).catch((err) => {
      console.error('[音频引擎] 保存播放模式失败:', err)
    })
  }
  if (!castTargetUsn.value && nativePlaybackActive && isNativeQueueDelegated()) {
    // A delegated engine has already preloaded its next item, so a later renderer
    // boundary can no longer influence what plays next: the pending reorder would
    // never take effect and shuffle would keep playing in plain queue order.
    // Apply it now and resync the whole queue instead. The active track stays at
    // the head of the new order and loadQueue does not touch the pipeline, so
    // playback continues uninterrupted.
    applyPendingRendererPlayModeAtBoundary()
    void queueNativeQueueStateSync().catch((err) => {
      setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[音频引擎] 同步播放模式失败:', err)
    })
    return
  }
  void queueNativePlayModeSync(mode).catch((err) => {
    setAudioEngineError(err instanceof Error ? err.message : String(err))
    console.error('[音频引擎] 同步播放模式失败:', err)
  })
}

const progress = computed(() => {
  if (duration.value <= 0) return 0
  return (currentTime.value / duration.value) * 100
})

async function castCurrentTrackToDevice(usn: string): Promise<void> {
  const track = currentTrack.value
  if (!track) throw new Error('当前没有可投送的曲目')
  const remoteApi = window.api?.remote
  if (!remoteApi?.castToDevice) throw new Error('远程控制 API 不可用')

  // Prefer a resolved local library / managed-cache path when available;
  // otherwise resolve the live stream URL (podcast / radio / provider) and
  // cast via the remote media token proxy. Provider streams may be
  // twilight-media:// grants — main resolves those to the real upstream.
  let filePath: string | undefined
  let mediaUrl: string | undefined
  const classifyCastTarget = (target: string): void => {
    if (!target) return
    if (target.startsWith('twilight-media:')) {
      mediaUrl = target
      return
    }
    if (/^https?:\/\//i.test(target)) {
      mediaUrl = target
      return
    }
    // Local path (no scheme or file-like absolute path).
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(target)) {
      filePath = target
    }
  }
  try {
    classifyCastTarget(await resolvePlayTarget(track))
  } catch {
    // Fall through to direct fields when resolvePlayTarget fails.
  }
  if (!filePath && !mediaUrl) {
    classifyCastTarget(track.streamUrl || track.filePath || '')
  }
  if (!filePath && !mediaUrl) {
    throw new Error('当前曲目不支持投送（缺少本地路径或流地址）')
  }

  const result = await remoteApi.castToDevice({
    usn,
    ...(filePath ? { filePath } : { mediaUrl }),
    title: track.title,
    artist: track.artist,
    album: track.album,
    // Live radio: do not seek after load.
    positionSeconds: isCurrentTrackLiveStream() ? 0 : currentTime.value
  })
  castTargetUsn.value = result.usn
  castTargetName.value = result.friendlyName
  // Main process already dispatches a 'pause' shortcut for local engine.
}

async function stopCastSession(): Promise<void> {
  const remoteApi = window.api?.remote
  if (remoteApi?.stopCast) await remoteApi.stopCast()
  castTargetUsn.value = null
  castTargetName.value = null
}

async function discoverCastDevices(): Promise<
  import('../../../shared/remoteControl.ts').DlnaDeviceInfo[]
> {
  const remoteApi = window.api?.remote
  if (!remoteApi?.discoverDlna) return []
  return await remoteApi.discoverDlna()
}

async function refreshCastTarget(): Promise<void> {
  const remoteApi = window.api?.remote
  if (!remoteApi?.getCastTarget) {
    castTargetUsn.value = null
    castTargetName.value = null
    return
  }
  const target = await remoteApi.getCastTarget()
  castTargetUsn.value = target?.usn ?? null
  castTargetName.value = target?.friendlyName ?? null
}

export function usePlayerStore(): {
  rehydrateCurrentTrackFromLibrary: () => void
  currentTrack: Ref<Track | null>
  dominantColor: Ref<string>
  coverThemeColor: Ref<string>
  themeCoverUrl: Ref<string>
  themeCoverIdentity: Ref<string>
  isPlaying: Ref<boolean>
  isLoading: Ref<boolean>
  lyricsLoadState: Ref<LyricsLoadState>
  isStreamBuffering: Ref<boolean>
  streamNowPlaying: Ref<string>
  currentTime: Ref<number>
  playbackClockSnapshot: Ref<PlaybackClockSnapshot>
  estimatePlaybackClockPosition: (at?: number) => number
  duration: Ref<number>
  volume: Ref<number>
  muted: Ref<boolean>
  playbackRate: Ref<number>
  abLoopA: Ref<number | null>
  abLoopB: Ref<number | null>
  sleepTimerState: Ref<SleepTimerState | null>
  sleepTimerNotice: Ref<string | null>
  progress: ComputedRef<number>
  queue: Ref<Track[]>
  queueIndex: Ref<number>
  playMode: Ref<PlayMode>
  heartModeAvailable: ComputedRef<boolean>
  setHeartModeContext: (playlistId: number | null) => void
  personalizedStreamSession: Ref<PersonalizedStreamSession | null>
  personalizedStreamRemaining: Ref<number>
  audioEngineReady: Ref<boolean>
  audioEngineError: Ref<string | null>
  audioEngineRecoveryNotice: Ref<AudioEngineRecoveryNotice | null>
  exclusiveMode: Ref<boolean>
  visualizerActive: Ref<boolean>
  audioOutput: Ref<AudioOutputId>
  audioDevice: Ref<string>
  audioOutputOptions: Ref<AudioOutputOption[]>
  audioDeviceOptions: Ref<AudioDeviceOption[]>
  audioOutputDeviceOptions: ComputedRef<AudioDeviceOption[]>
  audioProcessing: Ref<AudioProcessingSettings>
  audioOutputConfig: Ref<OutputConfig>
  audioOutputConfigApplyStatus: Ref<OutputConfigApplyStatus>
  dspOutputStage: Ref<DspOutputStageConfig>
  dspStereoImage: Ref<DspStereoImageConfig>
  playbackInfo: Ref<NativePlaybackInfo | null>
  loudnormStatus: Ref<'idle' | 'measuring' | 'cached' | 'fallback' | 'unavailable'>
  loudnormStatusSource: Ref<string | null>
  outputInfo: ComputedRef<NativeOutputInfo | null>
  visualizationData: Ref<NativeVisualizationData>
  cyclePlayMode: () => void
  setPlayMode: (mode: PlayMode) => void
  enqueueTrack: (track: Track) => void
  appendQueueTracks: (tracks: readonly Track[]) => void
  startPersonalizedStream: (key: PersonalizedStreamKey) => PersonalizedStreamSession
  appendPersonalizedStreamTracks: (
    session: PersonalizedStreamSession,
    tracks: readonly Track[]
  ) => boolean
  endPersonalizedStream: () => void
  playNextTrack: (track: Track) => void
  removeQueueItem: (index: number) => void
  clearQueue: () => void
  reorderQueue: (fromIndex: number, toIndex: number) => void
  saveQueueAsPlaylist: (
    name: string,
    createPlaylistWithTracks: (name: string, tracks: Track[]) => string
  ) => string
  playTrack: (
    track: Track,
    trackList?: Track[],
    options?: { heartModePlaylistId?: number | null }
  ) => void
  playTrackFromPosition: (
    track: Track,
    positionSeconds: number,
    trackList?: Track[],
    options?: { heartModePlaylistId?: number | null }
  ) => void
  togglePlay: () => Promise<void>
  next: () => void
  prev: () => void
  seek: (time: number) => void
  setAbLoopPoint: (point: 'a' | 'b', time?: number) => void
  toggleAbLoopAtCurrentTime: () => void
  clearAbLoop: () => void
  resumeOffer: Ref<{ trackId: string; positionSeconds: number; label: string } | null>
  acceptResumeOffer: () => void
  dismissResumeOffer: () => void
  addManualBookmarkAtCurrentTime: () => void
  setVolume: (vol: number) => void
  flushSoftwareVolumePersist: () => Promise<void>
  setPlaybackRate: (rate: number) => Promise<void>
  toggleMute: () => void
  configureSleepTimer: (mode: SleepTimerMode, minutes?: number) => void
  cancelSleepTimer: () => void
  setUnityVolume: () => void
  toggleExclusiveMode: () => Promise<void>
  setAudioOutput: (output: AudioOutputId, device?: string) => Promise<void>
  setAudioDevice: (device: string) => Promise<void>
  setAudioOutputConfig: (config: Partial<OutputConfig>) => Promise<void>
  refreshAudioOutputState: () => Promise<void>
  dismissAudioEngineRecoveryNotice: () => void
  setAudioProcessing: (settings: Partial<AudioProcessingSettings>) => Promise<void>
  applyAudioProcessingState: (processing: AudioProcessingSettings) => void
  setOutputStage: (partial: Partial<DspOutputStageConfig>) => Promise<void>
  setStereoImage: (partial: Partial<DspStereoImageConfig>) => Promise<void>
  toggleDspEnabled: () => Promise<void>
  toggleEqEnabled: () => Promise<void>
  toggleCrossfeed: () => Promise<void>
  toggleGapless: () => Promise<void>
  setReplayGainMode: (mode: AudioProcessingSettings['volumeNormalization']) => Promise<void>
  setCrossfeedStrength: (strength: number) => Promise<void>
  selectImpulseResponse: () => Promise<void>
  clearImpulseResponse: () => Promise<void>
  restorePlaybackSession: (session: PlaybackSession) => void
  createPlaybackSession: (mode: PlaybackResumeMode) => PlaybackSession | null
  removeUnavailableTracks: (trackIds: string[], filePaths: string[]) => void
  clearBpmAnalysisFromPlaybackState: () => void
  refreshCurrentLyrics: () => Promise<void>
  castTargetName: Ref<string | null>
  castToDevice: (usn: string) => Promise<void>
  stopCast: () => Promise<void>
  discoverCastDevices: () => Promise<import('../../../shared/remoteControl.ts').DlnaDeviceInfo[]>
  refreshCastTarget: () => Promise<void>
  formatTime: (seconds: number) => string
} {
  setupPlayerIntegrationSideEffects()

  function playTrack(
    track: Track,
    trackList?: Track[],
    options?: { heartModePlaylistId?: number | null }
  ): void {
    if (trackList) {
      setHeartModeContext(options?.heartModePlaylistId ?? null)
      // 手动重建队列（例如点击歌单/专辑中的另一首）时退出心动模式，
      // 以新队列为准继续顺序播放。
      exitHeartModeForManualQueueReplacement()
    }
    if (trackList || !isPersonalizedStreamTrack(track)) endPersonalizedStream()
    if (trackList) {
      const snapshots = toPlaybackQueueSnapshots(trackList)
      originalQueue.value = snapshots
      if (playMode.value === 'shuffle') {
        queue.value = shuffleArray(snapshots)
        queueIndex.value = queue.value.findIndex((t) => t.id === track.id)
      } else {
        queue.value = [...snapshots]
        queueIndex.value = snapshots.findIndex((t) => t.id === track.id)
      }
    }
    if (queueIndex.value === -1) queueIndex.value = 0
    // Clone + reset so cover/progress rebind even when the queue entry object
    // is referentially stable across consecutive plays.
    activateCurrentTrack(track, { resetUi: true, position: 0 })
    void loadAndPlay(track)
  }

  function playTrackFromPosition(
    track: Track,
    positionSeconds: number,
    trackList?: Track[],
    options?: { heartModePlaylistId?: number | null }
  ): void {
    if (trackList) {
      setHeartModeContext(options?.heartModePlaylistId ?? null)
      exitHeartModeForManualQueueReplacement()
    }
    if (trackList || !isPersonalizedStreamTrack(track)) endPersonalizedStream()
    if (trackList) {
      const snapshots = toPlaybackQueueSnapshots(trackList)
      originalQueue.value = snapshots
      if (playMode.value === 'shuffle') {
        queue.value = shuffleArray(snapshots)
        queueIndex.value = queue.value.findIndex((t) => t.id === track.id)
      } else {
        queue.value = [...snapshots]
        queueIndex.value = snapshots.findIndex((t) => t.id === track.id)
      }
    }
    if (queueIndex.value === -1) queueIndex.value = 0
    const start = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0
    activateCurrentTrack(track, { resetUi: true, position: start })
    void loadAndPlay(track, start)
  }

  function setPlayMode(mode: PlayMode): void {
    setPlayModeInternal(mode)
  }

  async function togglePlay(): Promise<void> {
    await togglePlayState()
  }

  function prev(): void {
    previous()
  }

  function seek(time: number): void {
    seekPlayback(time)
  }

  function setVolume(vol: number): void {
    volume.value = vol
  }

  /** Explicit user action for bit-perfect: software gain must be unity (1.0). Does not change default 0.7. */
  function setUnityVolume(): void {
    setVolume(1)
  }

  async function refreshCurrentLyrics(): Promise<void> {
    await lyricsLoader.ensureCurrentTrackLyricsLoaded(currentTrack.value, true, true)
  }

  return {
    rehydrateCurrentTrackFromLibrary,
    currentTrack,
    dominantColor,
    coverThemeColor,
    themeCoverUrl,
    themeCoverIdentity,
    isPlaying,
    isLoading,
    lyricsLoadState,
    isStreamBuffering,
    streamNowPlaying,
    currentTime,
    playbackClockSnapshot,
    estimatePlaybackClockPosition,
    duration,
    volume,
    muted,
    playbackRate,
    abLoopA,
    abLoopB,
    sleepTimerState,
    sleepTimerNotice,
    progress,
    queue,
    queueIndex,
    playMode,
    heartModeAvailable,
    setHeartModeContext,
    personalizedStreamSession,
    personalizedStreamRemaining,
    audioEngineReady,
    audioEngineError,
    audioEngineRecoveryNotice,
    exclusiveMode,
    visualizerActive,
    audioOutput,
    audioDevice,
    audioOutputOptions,
    audioDeviceOptions,
    audioOutputDeviceOptions,
    audioProcessing,
    audioOutputConfig,
    audioOutputConfigApplyStatus,
    dspOutputStage,
    dspStereoImage,
    playbackInfo,
    loudnormStatus,
    loudnormStatusSource,
    outputInfo,
    visualizationData,
    castTargetName,
    cyclePlayMode,
    setPlayMode,
    enqueueTrack,
    appendQueueTracks,
    startPersonalizedStream,
    appendPersonalizedStreamTracks,
    endPersonalizedStream,
    playNextTrack,
    removeQueueItem,
    clearQueue,
    reorderQueue,
    saveQueueAsPlaylist,
    playTrack,
    playTrackFromPosition,
    togglePlay,
    next,
    prev,
    seek,
    setAbLoopPoint,
    toggleAbLoopAtCurrentTime,
    clearAbLoop,
    resumeOffer,
    acceptResumeOffer,
    dismissResumeOffer,
    addManualBookmarkAtCurrentTime,
    setVolume,
    flushSoftwareVolumePersist,
    setPlaybackRate,
    toggleMute,
    configureSleepTimer,
    cancelSleepTimer,
    setUnityVolume,
    toggleExclusiveMode,
    setAudioOutput,
    setAudioDevice,
    setAudioOutputConfig,
    refreshAudioOutputState,
    dismissAudioEngineRecoveryNotice,
    setAudioProcessing,
    applyAudioProcessingState,
    setOutputStage,
    setStereoImage,
    toggleDspEnabled,
    toggleEqEnabled,
    toggleCrossfeed,
    toggleGapless,
    setReplayGainMode,
    setCrossfeedStrength,
    selectImpulseResponse,
    clearImpulseResponse,
    restorePlaybackSession,
    createPlaybackSession,
    removeUnavailableTracks,
    clearBpmAnalysisFromPlaybackState,
    refreshCurrentLyrics,
    castToDevice: castCurrentTrackToDevice,
    stopCast: stopCastSession,
    discoverCastDevices,
    refreshCastTarget,
    formatTime
  }
}
