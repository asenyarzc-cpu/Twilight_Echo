import { shallowRef, ref, computed, watch, type Ref, type ComputedRef } from 'vue'
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
  mergeDspStereoImage,
  type DspOutputStageConfig,
  type DspStereoImageConfig
} from '../../../shared/dspGraph.ts'
import { extractDominantColor } from '../utils/colorExtractor'
import { resolveCover } from '../utils/coverLoader'
import {
  shouldReuseResolvedStreamUrl,
  shouldUseNativePlaybackTarget
} from '../utils/playbackRouting'
import { preparePlayerNativeQueue } from '../utils/nativeQueuePreparation.ts'
import {
  NativeQueueRevisionFence,
  synchronizeLatestNativeQueue
} from '../utils/nativeQueueRevision.ts'
import {
  toPlaybackQueueSnapshot,
  toPlaybackQueueSnapshots
} from '../utils/playbackQueueVirtualization.ts'
import { findPlaybackFallbackTrack } from '../utils/playbackFallback.ts'
import { findProviderRematchCandidate } from '../utils/libraryRepair.ts'
import { resolveLyricsWithSources } from '../utils/lyricSourceResolution.ts'
import type { LyricResolverSource } from '../utils/lyricSourceResolution.ts'
import { resolverLyricsInput } from '../utils/managedLyricsSource.ts'
import { useLyricsManagement } from './lyricsManagement.ts'
import {
  getPodcastDefaultPlaybackRate,
  parsePodcastTrackId,
  setPodcastDefaultPlaybackRate,
  usePodcastStore
} from './usePodcastStore.ts'
import { toggleVolumeMute } from '../utils/volumeMute.ts'
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
import { playbackSessionWriter } from '../app/playbackSessionWriter.ts'
import {
  onLocalTracksUnavailable,
  pruneUnavailableLocalTracks
} from '../utils/localTrackRemovalPolicy.ts'
import { type SleepTimerMode, type SleepTimerState } from '../../../shared/sleepTimer.ts'
import { DEFAULT_SOFTWARE_VOLUME } from '../../../shared/audioProcessingOptions.ts'
import { createSleepTimerController, getRestorableSleepTimerState } from './sleepTimerController.ts'
import { createSleepTimerFadeController } from './sleepTimerFade.ts'
import { usePlaybackBookmarks } from './playbackBookmarks'
import { useAppNoticeStore } from './useAppNoticeStore'
import {
  DEFAULT_AUDIO_DEVICE_OPTION,
  getFallbackAudioOutput,
  getFallbackAudioOutputOptions,
  normalizeAudioDeviceOptions,
  normalizeAudioOutputOptions
} from './player/audioOutputNormalize.ts'

type NativePlaybackInfo = Awaited<ReturnType<typeof window.api.audioEngine.getPlaybackInfo>>
type NativeOutputInfo = NativePlaybackInfo['outputInfo']
type NativeVisualizationData = Awaited<
  ReturnType<typeof window.api.audioEngine.getVisualizationData>
>
type ProviderSourceReliability = Record<string, number>
export type PersonalizedStreamKey = 'fm' | 'radar'
export interface PersonalizedStreamSession {
  id: number
  key: PersonalizedStreamKey
}
const automaticLyricsBaselines = new Map<string, Track>()
/** Per-track generation so a later load for A does not cancel an in-flight load for B. */
const lyricsLoadGenerationByTrackId = new Map<string, number>()

interface AudioOutputState {
  output: AudioOutputId
  device: string
  exclusiveMode: boolean
  exclusiveAvailable: boolean
  outputOptions: AudioOutputOption[]
  deviceOptions: AudioDeviceOption[]
}

export interface AudioEngineRecoveryNotice {
  kind: 'service-crash' | 'service-ready'
  message: string
  actionLabel?: string
  canResume?: boolean
}

export interface LyricsLoadState {
  trackId: string
  status: 'idle' | 'loading' | 'ready'
}

const currentTrack = ref<Track | null>(null)
const dominantColor = ref('#1a73e8')
const coverThemeColor = ref('#1a73e8')
const themeCoverUrl = ref('')
const themeCoverIdentity = ref('')
const isPlaying = ref(false)
const isLoading = ref(false)
const lyricsLoadState = ref<LyricsLoadState>({ trackId: '', status: 'idle' })
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
/** Offer to resume a long track from a saved resume bookmark. */
const resumeOffer = ref<{ trackId: string; positionSeconds: number; label: string } | null>(null)
const lastAudibleVolume = ref(DEFAULT_SOFTWARE_VOLUME)
let volumePersistTimer: ReturnType<typeof setTimeout> | null = null
let suppressVolumePersist = false
/** Active cast target display name (null when not casting). */
const castTargetName = ref<string | null>(null)
/** Active cast device id (usn); required to re-cast on queue skip. */
const castTargetUsn = ref<string | null>(null)
const sleepTimerState = ref<SleepTimerState | null>(null)
const sleepTimerNotice = ref<string | null>(null)
let sleepTimerFadeController: ReturnType<typeof createSleepTimerFadeController> | null = null
let sleepTimerController: ReturnType<typeof createSleepTimerController> | null = null
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
let personalizedStreamSessionSequence = 0
const audioEngineReady = ref(false)
const audioEngineError = ref<string | null>(null)
const audioEngineRecoveryNotice = ref<AudioEngineRecoveryNotice | null>(null)
const { pushNotice, dismissNotice } = useAppNoticeStore()
let audioEngineRecoveryAppNoticeId = 0
let lastAudioEngineNotice = ''

function setAudioEngineError(error: string | null): void {
  const message = typeof error === 'string' ? error.trim() : ''
  audioEngineError.value = error
  if (!message) {
    lastAudioEngineNotice = ''
    return
  }
  if (message === lastAudioEngineNotice) return
  lastAudioEngineNotice = message
  const isFallbackNotice =
    message.includes('已启用临时播放通道') ||
    message.includes('已尝试切换到') ||
    message.includes('已重新匹配到')
  pushNotice({ kind: isFallbackNotice ? 'warning' : 'error', message })
}
const exclusiveMode = ref(false)
// Tracks whether the in-PlayingMusic audio visualizer surface is active.
// App.vue reads this to hide the PlayerBar while the visualizer is open.
const visualizerActive = ref(false)
const audioOutput = ref<AudioOutputId>(getFallbackAudioOutput())
const audioDevice = ref('auto')
const audioOutputOptions = ref<AudioOutputOption[]>(getFallbackAudioOutputOptions())
const audioDeviceOptions = ref<AudioDeviceOption[]>([DEFAULT_AUDIO_DEVICE_OPTION])
const defaultAudioProcessing: AudioProcessingSettings = {
  dspEnabled: false,
  directMode: false,
  clipGuard: true,
  fftEnabled: true,
  fftResolution: 8192,
  highResolution: true,
  dsdToPcm: false,
  dsdOutputMode: 'auto',
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
const visualizationOptions = {
  spectrumPoints: 64,
  waveformPoints: 48,
  spectrogramFrames: 32,
  oscilloscopePoints: 512
} as const
const createInactiveVisualizationData = (): NativeVisualizationData => ({
  spectrum: Array.from({ length: visualizationOptions.spectrumPoints }, () => 0),
  waveform: Array.from({ length: visualizationOptions.waveformPoints }, () => 0),
  oscilloscope: Array.from({ length: visualizationOptions.oscilloscopePoints }, () => 0),
  peakDb: -120,
  rmsDb: -120,
  lufsMomentary: null,
  spectrogram: [],
  sampleRate: 0,
  maxFrequency: 20000,
  active: false,
  tapStatus: 'stopped',
  reason: ''
})
const visualizationData = ref<NativeVisualizationData>(createInactiveVisualizationData())
const { settings: appSettings, updateSettings } = useSettingsStore()
let playbackAudio: HTMLAudioElement | null = null
let playbackObjectUrl: string | null = null
let nativePlaybackActive = false
let nativeQueueDelegated = false
const nativeQueueRevisionFence = new NativeQueueRevisionFence()
let activeLoadToken = 0
let rendererFallbackInProgress = false
let rendererPlaybackWatchdogTimer: number | null = null
const RENDERER_PLAYBACK_WATCHDOG_MS = 220
// Keep long enough to outlive a full audio-service Pause + GetPlaybackInfo
// round-trip and any already-queued tick that still reports the pre-toggle state.
const PLAYBACK_TOGGLE_INTENT_GRACE_MS = 1200
const NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS = 2500
const NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS = 500
const NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS = 80
const START_FILE_PLAYBACK_INFO_REFRESH_ATTEMPTS = 4
const START_FILE_PLAYBACK_INFO_REFRESH_DELAY_MS = 120
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
}

function scheduleRendererPlaybackWatchdog(track: Track, loadToken: number): void {
  clearRendererPlaybackWatchdog()
  rendererPlaybackWatchdogTimer = window.setTimeout(async () => {
    rendererPlaybackWatchdogTimer = null
    if (!isActiveLoad(loadToken, track) || nativePlaybackActive) return

    const audio = playbackAudio
    if (!audio || !audio.src || !audio.paused || audio.ended) return

    try {
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
  })

  audio.addEventListener('timeupdate', () => {
    if (Number.isFinite(audio.currentTime)) {
      const track = currentTrack.value
      const position = rendererAudioPositionForTrack(audio.currentTime, track)
      applyPlaybackPositionSample(position)
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
  pendingPlaybackPositionTarget = null
  anchorRendererPlaybackClock(0)
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

function clearSleepTimerIntervals(): void {
  sleepTimerFadeController?.clear()
}

function stopForSleepTimer(): void {
  clearCrossfadeTimer()
  stopVisualizationPolling(true)
  stopRendererAudio(false)
  void stopNativeAudio()
  isPlaying.value = false
  isLoading.value = false
  sleepTimerNotice.value = '睡眠定时器已停止播放'
}

function beginSleepShutdown(state: SleepTimerState): void {
  getSleepTimerFadeController().begin(state)
}

function getSleepTimerFadeController(): ReturnType<typeof createSleepTimerFadeController> {
  if (!sleepTimerFadeController) {
    sleepTimerFadeController = createSleepTimerFadeController({
      getVolume: () => (muted.value ? 0 : volume.value),
      setVolume: (nextVolume) => {
        volume.value = nextVolume
        if (nextVolume > 0.001) muted.value = false
      },
      stop: stopForSleepTimer
    })
  }
  return sleepTimerFadeController
}

function getSleepTimerController(): ReturnType<typeof createSleepTimerController> {
  if (!sleepTimerController) {
    sleepTimerController = createSleepTimerController({
      bridge: window.api.sleepTimer,
      getSettings: () => useSettingsStore().settings.value.sleepTimer,
      getState: () => sleepTimerState.value,
      setState: (state) => {
        sleepTimerState.value = state
      },
      persistSession: persistSelectedTrackSession,
      setNotice: (notice) => {
        sleepTimerNotice.value = notice
      },
      onTriggered: beginSleepShutdown
    })
  }
  return sleepTimerController
}

function configureSleepTimer(mode: SleepTimerMode, minutes?: number): void {
  clearSleepTimerIntervals()
  getSleepTimerController().configure(mode, minutes)
}

function cancelSleepTimer(): void {
  clearSleepTimerIntervals()
  getSleepTimerController().cancel()
}

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

function cloneAudioProcessingSettings(settings: AudioProcessingSettings): AudioProcessingSettings {
  return {
    ...settings,
    eqBands: settings.eqBands.map((band) => ({ ...band }))
  }
}

function mergeAudioProcessingPatch(
  patch: Partial<AudioProcessingSettings>
): AudioProcessingSettings {
  return cloneAudioProcessingSettings({
    ...audioProcessing.value,
    ...patch,
    eqBands: patch.eqBands ?? audioProcessing.value.eqBands
  })
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

function normalizeDsdState(
  canonicalOutput?: Partial<NativeOutputInfo> | null,
  mirror?: Partial<NativePlaybackInfo> | null
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

function normalizeNativePlaybackInfo(info: NativePlaybackInfo): NativePlaybackInfo {
  const canonicalOutput = info.outputInfo
  const sourceExact = canonicalOutput?.sourceExact === true
  const outputPerfect = canonicalOutput?.outputPerfect === true
  const pcmPassthrough = canonicalOutput
    ? canonicalOutput.pcmPassthrough === true
    : info.pcmPassthrough === true
  const perfectReason = canonicalOutput?.perfectReason || ''
  const perfectReasonCode = canonicalOutput?.perfectReasonCode || ''
  const capabilityReason = canonicalOutput?.capabilityReason || ''
  const { isDsd, dsdMode, dsdRate } = normalizeDsdState(canonicalOutput, info)
  return {
    ...info,
    outputInfo: {
      ...canonicalOutput,
      actualBackend: canonicalOutput?.actualBackend || info.actualBackend || '',
      accessMode: canonicalOutput?.accessMode || info.accessMode || '',
      devicePathKind: canonicalOutput?.devicePathKind || info.devicePathKind || '',
      actualOutputFormat: canonicalOutput?.actualOutputFormat || info.actualOutputFormat || '',
      actualSampleRate: canonicalOutput?.actualSampleRate ?? info.actualSampleRate ?? 0,
      actualBitDepth: canonicalOutput?.actualBitDepth ?? info.actualBitDepth ?? 0,
      actualChannels: canonicalOutput?.actualChannels ?? info.actualChannels ?? 0,
      bufferSizeFrames: canonicalOutput?.bufferSizeFrames ?? info.bufferSizeFrames ?? 0,
      latencyFrames: canonicalOutput?.latencyFrames ?? info.latencyFrames ?? 0,
      latencyMs: canonicalOutput?.latencyMs ?? info.latencyMs ?? 0,
      latencyInfo: canonicalOutput?.latencyInfo ?? info.latencyInfo,
      channelRoutingMode: canonicalOutput?.channelRoutingMode || info.channelRoutingMode || 'auto',
      supportsOutputPerfect: canonicalOutput?.supportsOutputPerfect === true,
      sourceExact,
      diagnostics: canonicalOutput?.diagnostics ?? info.diagnostics,
      deviceRecovered: canonicalOutput?.deviceRecovered === true || info.deviceRecovered === true,
      recoveryCount: canonicalOutput?.recoveryCount ?? info.recoveryCount ?? 0,
      outputSampleRate: canonicalOutput?.outputSampleRate ?? info.outputSampleRate ?? 0,
      outputBitDepth: canonicalOutput?.outputBitDepth ?? info.outputBitDepth ?? 0,
      outputPerfect,
      pcmPassthrough,
      perfectReason,
      perfectReasonCode,
      capabilityReason,
      isDsd,
      dsdMode,
      dsdRate: isDsd ? dsdRate : 0
    },
    actualBackend: canonicalOutput?.actualBackend || info.actualBackend || '',
    accessMode: canonicalOutput?.accessMode || info.accessMode || '',
    devicePathKind: canonicalOutput?.devicePathKind || info.devicePathKind || '',
    actualOutputFormat: canonicalOutput?.actualOutputFormat || info.actualOutputFormat || '',
    actualSampleRate: canonicalOutput?.actualSampleRate ?? info.actualSampleRate ?? 0,
    actualBitDepth: canonicalOutput?.actualBitDepth ?? info.actualBitDepth ?? 0,
    actualChannels: canonicalOutput?.actualChannels ?? info.actualChannels ?? 0,
    bufferSizeFrames: canonicalOutput?.bufferSizeFrames ?? info.bufferSizeFrames ?? 0,
    latencyFrames: canonicalOutput?.latencyFrames ?? info.latencyFrames ?? 0,
    latencyMs: canonicalOutput?.latencyMs ?? info.latencyMs ?? 0,
    latencyInfo: canonicalOutput?.latencyInfo ?? info.latencyInfo,
    channelRoutingMode: canonicalOutput?.channelRoutingMode || info.channelRoutingMode || 'auto',
    supportsOutputPerfect: canonicalOutput?.supportsOutputPerfect === true,
    sourceExact,
    diagnostics: canonicalOutput?.diagnostics ?? info.diagnostics,
    deviceRecovered: canonicalOutput?.deviceRecovered === true || info.deviceRecovered === true,
    recoveryCount: canonicalOutput?.recoveryCount ?? info.recoveryCount ?? 0,
    outputSampleRate: canonicalOutput?.outputSampleRate ?? info.outputSampleRate ?? 0,
    outputBitDepth: canonicalOutput?.outputBitDepth ?? info.outputBitDepth ?? 0,
    outputPerfect,
    pcmPassthrough,
    perfectReason,
    perfectReasonCode,
    capabilityReason,
    isDsd,
    dsdMode,
    dsdRate
  }
}

function getTrackAudioSource(track: Track): string {
  return track.cueRange ? track.filePath : track.subTrack || track.streamUrl || track.filePath
}

function mergeTrackTransientData(nextTrack: Track, previousTrack: Track | null): Track {
  if (!previousTrack || previousTrack.id !== nextTrack.id) return nextTrack
  const lyrics = nextTrack.lyrics ?? previousTrack.lyrics
  const translatedLyrics = nextTrack.translatedLyrics ?? previousTrack.translatedLyrics
  if (lyrics === nextTrack.lyrics && translatedLyrics === nextTrack.translatedLyrics)
    return nextTrack
  return {
    ...nextTrack,
    lyrics,
    translatedLyrics
  }
}

function findLibraryTrackHint(track: Track, _libraryHint?: Track | null): Track | null {
  // Always resolve from the real library. Callers used to pass the queue row as
  // libraryHint, which short-circuited lookup and left lyrics:null / stale cover
  // forever (queue snapshots intentionally strip lyrics). O(1) via trackById —
  // never linear-scan tracks on the switch hot path (freezes PlayingMusic).
  return useMusicStore().getTrackById(track.id) ?? null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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
  const lyricsSource = track.lyricsSource ?? hint?.lyricsSource ?? (lyrics ? 'embedded' : null)
  const translatedLyricsSource =
    track.translatedLyricsSource ??
    hint?.translatedLyricsSource ??
    (translatedLyrics ? 'embedded' : null)
  const romanizedLyricsSource =
    track.romanizedLyricsSource ??
    hint?.romanizedLyricsSource ??
    (romanizedLyrics ? 'embedded' : null)

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
  void ensureCurrentTrackLyricsLoaded(currentTrack.value, true)
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
      if (getTrackAudioSource(trackAt) === source || trackAt.id === source) {
        return info.queueIndex
      }
      // queueIndex 与 source 不匹配，队列可能已被重排，回退到 source 查找
    } else if (trackAt && !source) {
      return info.queueIndex
    }
  }

  if (!info.source) return -1
  return queue.value.findIndex(
    (track) => track.id === info.source || getTrackAudioSource(track) === info.source
  )
}

function clearNativeStreamBufferingTimer(): void {
  if (nativeStreamBufferingClearTimer) {
    clearTimeout(nativeStreamBufferingClearTimer)
    nativeStreamBufferingClearTimer = null
  }
}

function isStreamLikeTrack(track: Track | null | undefined): boolean {
  if (!track) return false
  return (
    track.source === 'radio' ||
    track.source === 'podcast' ||
    /^https?:\/\//i.test(track.filePath || '') ||
    /^https?:\/\//i.test(track.streamUrl || '')
  )
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
  beginPlaybackPositionTransition(position)
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
      void ensureCurrentTrackLyricsLoaded(currentTrack.value, true)
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
      : latestPlaybackTime

  if (switchedTrack) {
    // Native gapless / queue next does not go through loadAndPlay — clear A-B and
    // reset duration/time so the playbar cover + progress do not stick on the previous track.
    clearAbLoop()
    pendingLoadStartTime = 0
    duration.value =
      nextDuration > 0 ? nextDuration : currentTrack.value ? cueDuration(currentTrack.value) : 0
    beginPlaybackPositionTransition(nextPosition)
    // Keep the intent/guard confirmed so delayed previous-track ticks still drop.
    markNativePlaybackInfoIntentConfirmed()
  } else {
    if (nextDuration > 0) {
      duration.value = nextDuration
    }
    applyPlaybackPositionSample(nextPosition)
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

  const nativePlayMode =
    snapshot.playMode === 'repeat' || snapshot.playMode === 'shuffle'
      ? snapshot.playMode
      : 'sequential'
  const synchronized = await synchronizeLatestNativeQueue(
    nativeQueueRevisionFence,
    snapshot.revision,
    {
      prepare: () =>
        preparePlayerNativeQueue(
          {
            queue: snapshot.queue,
            currentTrack: current,
            currentTarget: getTrackAudioSource(current),
            currentIndex: snapshot.currentIndex
          },
          {
            isAudioFileAuthorized: window.api.fs.isAudioFileAuthorized
          }
        ),
      loadQueue: (preparedQueue) =>
        window.api.audioEngine.loadQueue(preparedQueue.items, preparedQueue.startIndex),
      setPlayMode: () => window.api.audioEngine.setPlayMode(nativePlayMode)
    }
  )
  if (!synchronized.applied) return
  const preparedQueue = synchronized.prepared
  if (!preparedQueue) {
    // 不要因为队列重同步失败就停掉正在播放的引擎：停止会让主进程误判
    // “播放结束”（单曲队列 queueIndex>=len-1 恒真）→ 渲染层自动切歌/重播。
    // 保持现有播放不变，让 loadAndPlay 走正常的“不可用→回退”路径。
    return
  }
  nativeQueueDelegated = preparedQueue.delegated
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
  const nativePlayMode = mode === 'repeat' || mode === 'shuffle' ? mode : 'sequential'
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

  // In shuffle mode the native queue owns play order. Do not predict an adjacent
  // renderer item; wait for playback-info to identify the actual shuffled target.
  const target = playMode.value === 'shuffle' ? null : getNativeQueueAdvanceTarget(direction)
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

function clampSoftwareVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SOFTWARE_VOLUME
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000))
}

function scheduleSoftwareVolumePersist(val: number): void {
  if (suppressVolumePersist) return
  if (volumePersistTimer != null) clearTimeout(volumePersistTimer)
  volumePersistTimer = setTimeout(() => {
    volumePersistTimer = null
    const next = clampSoftwareVolume(val)
    const saved = clampSoftwareVolume(
      typeof appSettings.value?.softwareVolume === 'number'
        ? appSettings.value.softwareVolume
        : DEFAULT_SOFTWARE_VOLUME
    )
    if (Math.abs(saved - next) < 0.0005) return
    void updateSettings({ softwareVolume: next }).catch((err) => {
      console.error('[音频引擎] 保存软件音量失败:', err)
    })
  }, 280)
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
  if (playbackAudio) applyPlaybackRateToHtmlAudio(playbackAudio, rounded)
  window.api.audioEngine.setPlaybackRate(rounded).catch(() => {})
  // Remember podcast speed preference when the user changes rate while on a podcast.
  if (currentTrack.value?.source === 'podcast') {
    setPodcastDefaultPlaybackRate(rounded)
  }
  updateMediaSessionPositionState()
}

/** Persist podcast episode progress (throttled disk writes via store CAS). */
let lastPodcastProgressWriteAt = 0
let lastPodcastProgressTrackId = ''
let lastPodcastProgressSeconds = -1

function flushPodcastEpisodeProgress(force = false): void {
  const track = currentTrack.value
  if (!track || track.source !== 'podcast') return
  const parsed = parsePodcastTrackId(track.id)
  if (!parsed) return
  const seconds = Math.max(0, Math.floor(latestPlaybackTime || currentTime.value || 0))
  if (seconds < 1 && !force) return
  const now = Date.now()
  const sameTrack = lastPodcastProgressTrackId === track.id
  if (
    !force &&
    sameTrack &&
    Math.abs(seconds - lastPodcastProgressSeconds) < 2 &&
    now - lastPodcastProgressWriteAt < 8_000
  ) {
    return
  }
  if (!force && sameTrack && now - lastPodcastProgressWriteAt < 4_000) return
  lastPodcastProgressWriteAt = now
  lastPodcastProgressTrackId = track.id
  lastPodcastProgressSeconds = seconds
  void usePodcastStore().updateEpisodeProgress(parsed.subscriptionId, parsed.episodeGuid, seconds)
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
    await ensureCurrentTrackLyricsLoaded(track, true)
  }
)

const cleanupFns: (() => void)[] = []
let listenersSetup = false
let crossfadeTimer: number | null = null
let visualizationTimer: number | null = null
let visualizationRequestInFlight = false
let visualizationPollingGeneration = 0
let crossfadeTrackId = ''
const TIME_UPDATE_INTERVAL_MS = 250
const PLAYBACK_POSITION_CONFIRMATION_TOLERANCE_SECONDS = 1.5
const PLAYBACK_POSITION_TRANSITION_GUARD_MS = 3000
const RENDERER_CLOCK_STALE_AFTER_MS = 500
const RENDERER_CLOCK_MAX_UNOBSERVED_GAP_MS = 1500
const NATIVE_PAUSE_CONFIRMATION_MS = 500
const VISUALIZATION_UPDATE_INTERVAL_MS = 200
let latestPlaybackTime = 0
let lastTimePublishAt = 0
let pendingTimePublishTimer: number | null = null
let pendingPlaybackPositionTarget: {
  trackId: string
  position: number
  startedAt: number
} | null = null
let playbackPositionTransitionGuardUntil = 0
let rendererClockAnchorPosition = 0
let rendererClockAnchorAt = 0
let lastAcceptedPlaybackSampleAt = 0
let lastEnginePlaybackPosition = Number.NaN
let lastEnginePlaybackTrackId = ''
let pendingNativePause: { position: number } | null = null
let nativePauseConfirmationTimer: number | null = null
let rendererClockTimer: number | null = null
let advancingFromEndedTrackId = ''
let autoAdvanceInFlight = false
let loadedTrackId = ''
/** Last track that successfully entered the playing pipeline (identity for resume bookmarks). */
let lastActiveTrack: Track | null = null
let restoredPlaybackPending = false
let restoredPlaybackPosition = 0
let pendingLoadStartTime = 0
let nativeQueueSyncRequest: Promise<void> | null = null
let rendererPlayModeBoundaryPending = false
let dominantColorRequestId = 0

function getNowMs(): number {
  return performance.now()
}

function clearPendingNativePause(): void {
  pendingNativePause = null
  if (nativePauseConfirmationTimer !== null) {
    window.clearTimeout(nativePauseConfirmationTimer)
    nativePauseConfirmationTimer = null
  }
}

function deferNativePause(position: number): void {
  pendingNativePause = {
    position: Math.max(0, Number.isFinite(position) ? position : latestPlaybackTime)
  }
  if (nativePauseConfirmationTimer !== null) return
  nativePauseConfirmationTimer = window.setTimeout(() => {
    nativePauseConfirmationTimer = null
    if (pendingNativePause) isPlaying.value = false
  }, NATIVE_PAUSE_CONFIRMATION_MS)
}

function recoverFromStaleNativePause(position: number): void {
  const pendingPause = pendingNativePause
  if (
    !pendingPause ||
    position <= pendingPause.position + 0.01 ||
    playbackToggleIntent?.playing === false
  ) {
    return
  }
  clearPendingNativePause()
  isPlaying.value = true
}

function clearPendingTimePublish(): void {
  if (pendingTimePublishTimer !== null) {
    window.clearTimeout(pendingTimePublishTimer)
    pendingTimePublishTimer = null
  }
}

function publishCurrentTime(time: number): void {
  latestPlaybackTime = time
  currentTime.value = time
  lastTimePublishAt = getNowMs()
  enforceAbLoop(time)
}

function publishLatestCurrentTime(): void {
  pendingTimePublishTimer = null
  publishCurrentTime(latestPlaybackTime)
}

function setCurrentTimeImmediate(time: number): void {
  clearPendingTimePublish()
  publishCurrentTime(time)
}

function anchorRendererPlaybackClock(time: number): void {
  const now = getNowMs()
  rendererClockAnchorPosition = Math.max(0, Number.isFinite(time) ? time : 0)
  rendererClockAnchorAt = now
  lastAcceptedPlaybackSampleAt = now
}

function beginPlaybackPositionTransition(time: number): void {
  const position = Math.max(0, Number.isFinite(time) ? time : 0)
  const startedAt = getNowMs()
  clearPendingNativePause()
  lastEnginePlaybackPosition = Number.NaN
  lastEnginePlaybackTrackId = currentTrack.value?.id ?? ''
  pendingPlaybackPositionTarget = {
    trackId: lastEnginePlaybackTrackId,
    position,
    startedAt
  }
  playbackPositionTransitionGuardUntil = startedAt + PLAYBACK_POSITION_TRANSITION_GUARD_MS
  anchorRendererPlaybackClock(position)
  setCurrentTimeImmediate(position)
}

function applyPlaybackPositionSample(time: number): boolean {
  const position = Math.max(0, Number.isFinite(time) ? time : 0)
  const pending = pendingPlaybackPositionTarget
  const transitionWasPending = pending !== null
  if (pending) {
    const trackId = currentTrack.value?.id ?? ''
    const now = getNowMs()
    if (pending.trackId !== trackId) {
      pendingPlaybackPositionTarget = null
      return false
    } else if (now > playbackPositionTransitionGuardUntil) {
      pendingPlaybackPositionTarget = null
    } else {
      const rate = Number.isFinite(playbackRate.value) ? playbackRate.value : 1
      // Treat isLoading as advancing: load hand-off can clear isPlaying briefly
      // while the engine is already emitting new-track positions near 0.
      const elapsed =
        isPlaying.value || isLoading.value
          ? Math.max(0, (now - pending.startedAt) / 1000) * rate
          : 0
      const expectedPosition = pending.position + elapsed
      if (
        Math.abs(position - expectedPosition) > PLAYBACK_POSITION_CONFIRMATION_TOLERANCE_SECONDS
      ) {
        return false
      }
      pendingPlaybackPositionTarget = null
    }
  }

  const delta = position - currentTime.value
  const expectedRewind =
    delta < 0 &&
    (abLoopNativeActive ||
      (abLoopA.value != null && abLoopB.value != null) ||
      playMode.value === 'repeat' ||
      (position <= 0.05 && duration.value > 0 && currentTime.value >= duration.value - 1))
  if (
    !transitionWasPending &&
    getNowMs() <= playbackPositionTransitionGuardUntil &&
    Math.abs(delta) > PLAYBACK_POSITION_CONFIRMATION_TOLERANCE_SECONDS
  ) {
    if (!expectedRewind) return false
  }

  const trackId = currentTrack.value?.id ?? ''
  if (lastEnginePlaybackTrackId !== trackId) {
    lastEnginePlaybackTrackId = trackId
    lastEnginePlaybackPosition = Number.NaN
    clearPendingNativePause()
  }
  const previousEnginePosition = lastEnginePlaybackPosition
  const engineAdvanced =
    !Number.isFinite(previousEnginePosition) || position > previousEnginePosition + 0.01
  const engineRewound =
    Number.isFinite(previousEnginePosition) && position + 0.01 < previousEnginePosition
  const engineStalled =
    Number.isFinite(previousEnginePosition) && Math.abs(position - previousEnginePosition) <= 0.01

  if (!expectedRewind && engineRewound) return false
  if (!expectedRewind && engineStalled) return false

  lastEnginePlaybackPosition = position
  if (engineAdvanced) recoverFromStaleNativePause(position)
  if (!expectedRewind && engineAdvanced && position + 0.35 < currentTime.value) return false

  anchorRendererPlaybackClock(position)

  if (expectedRewind || position + 0.5 < latestPlaybackTime) {
    setCurrentTimeImmediate(position)
  } else {
    setCurrentTimeThrottled(position)
  }
  return true
}

function tickRendererPlaybackClock(): void {
  // Keep the playbar / lyric clock alive during intentional load hand-off even if
  // a transient pause event clears isPlaying before the new track confirms.
  if ((!isPlaying.value && !isLoading.value) || isCurrentTrackLiveStream()) return
  const now = getNowMs()
  if (now - lastAcceptedPlaybackSampleAt < RENDERER_CLOCK_STALE_AFTER_MS) return
  const elapsedMs = Math.max(0, now - rendererClockAnchorAt)
  if (elapsedMs > RENDERER_CLOCK_MAX_UNOBSERVED_GAP_MS) {
    rendererClockAnchorPosition = currentTime.value
    rendererClockAnchorAt = now
    return
  }
  const rate = Number.isFinite(playbackRate.value) ? playbackRate.value : 1
  const estimated = rendererClockAnchorPosition + (elapsedMs / 1000) * rate
  const total = duration.value > 0 ? duration.value : (currentTrack.value?.duration ?? 0)
  const position = total > 0 ? Math.min(estimated, total) : estimated
  if (position <= currentTime.value) return
  latestPlaybackTime = position
  currentTime.value = position
  lastTimePublishAt = now
  enforceAbLoop(position)
}

function startRendererPlaybackClock(): void {
  if (rendererClockTimer !== null) return
  rendererClockTimer = window.setInterval(tickRendererPlaybackClock, TIME_UPDATE_INTERVAL_MS)
}

function setCurrentTimeThrottled(time: number): void {
  latestPlaybackTime = time
  enforceAbLoop(time)
  const now = getNowMs()
  const remainingMs = TIME_UPDATE_INTERVAL_MS - (now - lastTimePublishAt)

  if (remainingMs <= 0 || currentTime.value === 0) {
    clearPendingTimePublish()
    currentTime.value = time
    lastTimePublishAt = now
    return
  }

  if (pendingTimePublishTimer === null) {
    pendingTimePublishTimer = window.setTimeout(publishLatestCurrentTime, remainingMs)
  }
}

function flushLatestCurrentTime(): void {
  clearPendingTimePublish()
  publishCurrentTime(latestPlaybackTime)
}

function publishAudioEngineRecoveryNotice(notice: AudioEngineRecoveryNotice): void {
  audioEngineRecoveryNotice.value = notice
  if (audioEngineRecoveryAppNoticeId) dismissNotice(audioEngineRecoveryAppNoticeId)
  audioEngineRecoveryAppNoticeId = pushNotice({
    kind: notice.kind === 'service-crash' || notice.canResume === false ? 'warning' : 'success',
    message: notice.message,
    action:
      notice.kind === 'service-ready' && notice.canResume !== false
        ? {
            label: notice.actionLabel || '继续播放',
            run: () => void togglePlayState()
          }
        : undefined,
    sticky: notice.kind === 'service-crash' || notice.canResume === false,
    durationMs: 8000
  })
}

function setAudioServiceCrashNotice(reason: string): void {
  const message = reason.trim()
  const prefix = message.startsWith('音频服务已重启')
    ? message
    : `音频服务已重启：${message || '未知原因'}`
  publishAudioEngineRecoveryNotice({
    kind: 'service-crash',
    message: `${prefix}。正在恢复音频服务，恢复后不会自动续播。`,
    actionLabel: '稍后手动继续'
  })
}

function setAudioServiceReadyNotice(event?: {
  outputRouteSynced?: boolean
  restoreErrors?: string[]
}): void {
  const outputRouteSynced = event?.outputRouteSynced === true
  const restoreErrors = Array.isArray(event?.restoreErrors)
    ? event.restoreErrors.filter((item) => item.trim())
    : []
  const detail = restoreErrors.length > 0 ? `（${restoreErrors.join('；')}）` : ''
  publishAudioEngineRecoveryNotice({
    kind: 'service-ready',
    message: outputRouteSynced
      ? '音频服务已恢复，播放已停止，可手动继续。'
      : `音频服务已恢复，但输出设备/后端未完全恢复${detail}。请重新选择输出设备后继续。`,
    actionLabel: outputRouteSynced ? '继续播放' : undefined,
    canResume: outputRouteSynced
  })
}

async function refreshVisualizationData(): Promise<void> {
  if (visualizationRequestInFlight) return
  const requestGeneration = visualizationPollingGeneration
  visualizationRequestInFlight = true
  try {
    const nextVisualizationData =
      await window.api.audioEngine.getVisualizationData(visualizationOptions)
    if (requestGeneration !== visualizationPollingGeneration) return
    visualizationData.value = nextVisualizationData
  } catch {
    if (requestGeneration !== visualizationPollingGeneration) return
    visualizationData.value = createInactiveVisualizationData()
  } finally {
    visualizationRequestInFlight = false
  }
}

function stopVisualizationPolling(clearData = false): void {
  visualizationPollingGeneration += 1
  if (visualizationTimer !== null) {
    window.clearInterval(visualizationTimer)
    visualizationTimer = null
  }
  if (clearData) {
    visualizationData.value = createInactiveVisualizationData()
  }
}

function startVisualizationPolling(): void {
  if (visualizerActive.value) return
  if (visualizationTimer !== null) return
  void refreshVisualizationData()
  visualizationTimer = window.setInterval(
    () => void refreshVisualizationData(),
    VISUALIZATION_UPDATE_INTERVAL_MS
  )
}

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
  if (isNativeQueueDelegated()) return
  void handlePlaybackEnded()
}

function getTrackSource(track: Track): string {
  if (track.source) return track.source
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return 'local'
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local'
}

function hasAnalyzedBpm(track: Track): boolean {
  const bpm = track.bpmAnalysis?.bpm
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0
}

function isAutoBpmAnalysisEnabled(): boolean {
  return useSettingsStore().settings.value.autoAnalyzeBpm !== false
}

function isAnalyzableAudioPath(filePath: string | undefined): filePath is string {
  if (!filePath) return false
  return !/^[a-z][a-z\d+.-]*:\/\//i.test(filePath)
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

function commitResolvedLyrics(
  triggerTrack: Track,
  resolverTrack: Track,
  resolved: {
    lyrics: string | null
    translatedLyrics: string | null
    lyricsSource: Track['lyricsSource']
    translatedLyricsSource: Track['translatedLyricsSource']
  }
): void {
  if (currentTrack.value?.id !== triggerTrack.id) return
  const existing = currentTrack.value
  const nextLyrics = resolved.lyrics ?? ''
  // Prefer non-empty lyrics already on the active track (e.g. hydrate race).
  if (
    !nextLyrics &&
    typeof existing?.lyrics === 'string' &&
    existing.lyrics.length > 0 &&
    existing.id === triggerTrack.id
  ) {
    return
  }
  const updatedTrack = {
    ...resolverTrack,
    lyrics: nextLyrics,
    translatedLyrics: resolved.translatedLyrics,
    lyricsSource: resolved.lyricsSource,
    translatedLyricsSource: resolved.translatedLyricsSource,
    romanizedLyrics: resolverTrack.romanizedLyrics ?? null,
    romanizedLyricsSource: resolverTrack.romanizedLyricsSource ?? null
  }
  currentTrack.value = updatedTrack
  patchTrackInQueues(updatedTrack)
}

async function ensureCurrentTrackLyricsLoaded(
  triggerTrack: Track | null = currentTrack.value,
  allowProviderLookup = true
): Promise<void> {
  if (!triggerTrack || currentTrack.value?.id !== triggerTrack.id) return
  // Per-track generation: concurrent loads for *different* tracks must not cancel
  // each other; only a newer load for the *same* id supersedes.
  const previousGeneration = lyricsLoadGenerationByTrackId.get(triggerTrack.id) ?? 0
  const loadGeneration = previousGeneration + 1
  lyricsLoadGenerationByTrackId.set(triggerTrack.id, loadGeneration)
  const isCurrentGeneration = (): boolean =>
    lyricsLoadGenerationByTrackId.get(triggerTrack.id) === loadGeneration &&
    currentTrack.value?.id === triggerTrack.id
  lyricsLoadState.value = { trackId: triggerTrack.id, status: 'loading' }
  const completeIfCurrent = (): void => {
    if (isCurrentGeneration()) {
      lyricsLoadState.value = { trackId: triggerTrack.id, status: 'ready' }
    }
  }

  const lyricsManagement = useLyricsManagement()
  try {
    // ensureLoaded itself races the IPC (3s); never block the 12s resolve path
    // indefinitely or the now-playing pane sticks on "加载歌词…".
    await lyricsManagement.ensureLoaded()
  } catch {
    // Automatic resolution remains available when the optional management
    // document cannot be read. The persistent store preserves the bad file.
  }
  if (!isCurrentGeneration()) return

  const override = lyricsManagement.entryFor(triggerTrack.id)
  const requestedSource = override?.source ?? 'auto'
  const layerSource = (
    key: 'originalSelection' | 'translationSelection'
  ): LyricResolverSource | 'manual' => {
    const selection = override?.[key]
    if (selection === 'local' || selection === 'provider' || selection === 'manual') {
      return selection
    }
    if (requestedSource === 'local' || requestedSource === 'provider') return requestedSource
    return 'automatic'
  }
  const originalLayerSource = layerSource('originalSelection')
  const translationLayerSource = layerSource('translationSelection')
  const resolverOriginalSource: LyricResolverSource =
    originalLayerSource === 'manual' ? 'automatic' : originalLayerSource
  const resolverTranslationSource: LyricResolverSource =
    translationLayerSource === 'manual' ? 'automatic' : translationLayerSource
  const sourceSelectionSignature = `${requestedSource}:${originalLayerSource}:${translationLayerSource}`
  // Manual content is applied by the presentation layer. Keeping it out of
  // the queue record means choosing Auto later can always recover
  // the resolver result instead of treating a previous edit as embedded data.
  if (requestedSource === 'manual') {
    // Finish loading state on the track record: null means "still resolving".
    // Manual text is projected from the override; empty override → 暂无歌词.
    if (
      currentTrack.value?.id === triggerTrack.id &&
      currentTrack.value.lyrics == null &&
      currentTrack.value.translatedLyrics == null
    ) {
      commitResolvedLyrics(triggerTrack, triggerTrack, {
        lyrics: '',
        translatedLyrics: null,
        lyricsSource: null,
        translatedLyricsSource: null
      })
    }
    completeIfCurrent()
    return
  }

  if (
    (requestedSource !== 'auto' ||
      originalLayerSource === 'local' ||
      originalLayerSource === 'provider' ||
      translationLayerSource === 'local' ||
      translationLayerSource === 'provider') &&
    !automaticLyricsBaselines.has(triggerTrack.id)
  ) {
    automaticLyricsBaselines.set(triggerTrack.id, { ...triggerTrack })
  }
  const resolverTrack = resolverLyricsInput(
    triggerTrack,
    automaticLyricsBaselines.get(triggerTrack.id),
    requestedSource
  )

  // Already have parseable lyrics (hydrated / previous resolve) — keep them and
  // only top up missing translation via provider when allowed.
  const hasOriginal =
    typeof resolverTrack.lyrics === 'string' && resolverTrack.lyrics.trim().length > 0

  const source = getTrackSource(resolverTrack)
  const canLoadLocalLyrics =
    source === 'local' &&
    (resolverOriginalSource === 'local' ||
      (resolverOriginalSource === 'automatic' && resolverTrack.lyrics == null)) &&
    !!resolverTrack.dir &&
    !!resolverTrack.fileName
  const canLoadProviderLyrics =
    allowProviderLookup &&
    (resolverOriginalSource === 'provider' ||
      resolverTranslationSource === 'provider' ||
      (resolverOriginalSource === 'automatic' && resolverTrack.lyrics == null) ||
      (resolverTranslationSource === 'automatic' && resolverTrack.translatedLyrics == null))
  const canLoadOnlineLyrics =
    resolverOriginalSource === 'automatic' &&
    appSettings.value?.onlineLyricsFallback === true &&
    !!resolverTrack.title?.trim() &&
    !!resolverTrack.artist?.trim() &&
    !hasOriginal

  if (!canLoadLocalLyrics && !canLoadProviderLyrics && !canLoadOnlineLyrics) {
    if (!isCurrentGeneration()) return
    // Finish loading state: null means "still resolving"; '' means "confirmed empty".
    commitResolvedLyrics(triggerTrack, resolverTrack, {
      lyrics: hasOriginal ? resolverTrack.lyrics! : '',
      translatedLyrics: resolverTrack.translatedLyrics ?? null,
      lyricsSource: resolverTrack.lyricsSource ?? (hasOriginal ? 'embedded' : null),
      translatedLyricsSource: resolverTrack.translatedLyricsSource ?? null
    })
    completeIfCurrent()
    return
  }

  const resolvePromise = resolveLyricsWithSources({
    track: resolverTrack,
    originalSource: resolverOriginalSource,
    translationSource: resolverTranslationSource,
    loadLocalLyrics: canLoadLocalLyrics
      ? () =>
          window.api.data
            .getLyrics(resolverTrack.dir!, resolverTrack.fileName, resolverTrack.filePath)
            .catch(() => null)
      : undefined,
    loadProviderLyrics: canLoadProviderLyrics
      ? async () => {
          await syncPluginProviders()
          return useMediaProviders().resolveLyrics(resolverTrack)
        }
      : undefined,
    loadOnlineLyrics: canLoadOnlineLyrics
      ? async () => {
          const result = await window.api.data.searchOnlineLyrics({
            title: resolverTrack.title,
            artist: resolverTrack.artist,
            album: resolverTrack.album || undefined,
            durationSeconds:
              typeof resolverTrack.duration === 'number' && Number.isFinite(resolverTrack.duration)
                ? resolverTrack.duration
                : undefined
          })
          return result.best?.syncedLyrics ?? result.best?.plainLyrics ?? null
        }
      : undefined,
    // LRCLIB does not carry translations. When the online fallback supplied
    // the original lyrics, try the provider path once more just for the
    // NetEase tlyric translation; a miss simply keeps the layer hidden.
    loadOnlineTranslation: canLoadOnlineLyrics
      ? async () => {
          await syncPluginProviders()
          const lyrics = await useMediaProviders().resolveLyrics(resolverTrack)
          return lyrics?.translatedLyrics ?? null
        }
      : undefined
  })
  // Bound async lyric fetches so the now-playing pane cannot stick on "加载歌词…".
  let resolveTimeout: number | null = null
  const resolved = await Promise.race([
    resolvePromise,
    new Promise<Awaited<ReturnType<typeof resolveLyricsWithSources>>>((resolve) => {
      resolveTimeout = window.setTimeout(
        () =>
          resolve({
            lyrics: hasOriginal ? resolverTrack.lyrics! : null,
            translatedLyrics: resolverTrack.translatedLyrics ?? null,
            lyricsSource: resolverTrack.lyricsSource ?? (hasOriginal ? 'embedded' : null),
            translatedLyricsSource: resolverTrack.translatedLyricsSource ?? null
          }),
        4_000
      )
    })
  ]).finally(() => {
    if (resolveTimeout !== null) window.clearTimeout(resolveTimeout)
  })

  if (!isCurrentGeneration()) return
  // Source selection can change while an async local/provider resolver is
  // pending. Do not let a stale forced lookup overwrite the newer Auto (or
  // manual) choice when it finally completes.
  const currentOverride = lyricsManagement.entryFor(triggerTrack.id)
  const currentRequestedSource = currentOverride?.source ?? 'auto'
  const currentLayerSource = (
    key: 'originalSelection' | 'translationSelection'
  ): LyricResolverSource | 'manual' => {
    const selection = currentOverride?.[key]
    if (selection === 'local' || selection === 'provider' || selection === 'manual') {
      return selection
    }
    if (currentRequestedSource === 'local' || currentRequestedSource === 'provider') {
      return currentRequestedSource
    }
    return 'automatic'
  }
  if (
    `${currentRequestedSource}:${currentLayerSource('originalSelection')}:${currentLayerSource('translationSelection')}` !==
    sourceSelectionSignature
  ) {
    completeIfCurrent()
    return
  }
  commitResolvedLyrics(triggerTrack, resolverTrack, resolved)
  completeIfCurrent()
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
    // Local cache path previously returned by the provider.
    return track.streamUrl
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

  track.streamUrl = streamUrl
  if (source === 'ncm') track.streamQuality = ncmPlaybackQuality
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

  setAudioEngineError(
    `播放 ${failedTrack.title || '当前曲目'} 失败，已尝试切换到 ${fallback.source ?? getTrackSource(fallback)} 来源：${reason instanceof Error ? reason.message : String(reason)}`
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

function clampProviderReliability(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(0, Math.min(1, value))
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

  setAudioEngineError(
    `播放 ${failedTrack.title || '当前曲目'} 失败，已重新匹配到 ${rematched.source ?? getTrackSource(rematched)} 来源`
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

function retryCurrentTrackLyricsIfNeeded(): void {
  const track = currentTrack.value
  if (!track) return
  const loading =
    lyricsLoadState.value.trackId === track.id && lyricsLoadState.value.status === 'loading'
  if (track.lyrics == null || loading) {
    void ensureCurrentTrackLyricsLoaded(track, true)
  }
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
      retryCurrentTrackLyricsIfNeeded()
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
          // Prefer continuous progress paint over strict native flags. Drop only
          // when there is no active session identity at all — brief demotions of
          // nativePlaybackActive during track hand-off must not freeze the bar
          // until the user pauses or expands the now-playing page.
          if (
            !currentTrack.value &&
            !nativePlaybackActive &&
            !nativeQueueDelegated &&
            !isPlaying.value &&
            !isLoading.value
          ) {
            break
          }
          if (typeof data === 'number' && isFinite(data)) {
            applyPlaybackPositionSample(data)
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
          applyNativePlayingState(!data, data === true ? latestPlaybackTime : null)
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
      beginPlaybackPositionTransition(startAt)
      isLoading.value = false
      // Keep accepting time-pos during the hand-off even if a stale snapshot
      // temporarily reported nativePlaybackActive=false.
      if (nativeQueueDelegated || isPlaying.value) {
        nativePlaybackActive = true
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
      api.onServiceCrash(({ reason }) => {
        setAudioServiceCrashNotice(reason)
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
          audioEngineError.value = event.restoreErrors?.join('；') || '音频输出设备/后端未完全恢复'
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
        setAudioServiceReadyNotice({
          outputRouteSynced: false,
          restoreErrors: ['等待结构化输出路由恢复确认']
        })
        audioEngineError.value = '音频输出设备/后端未完全恢复'
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
      console.error('[audio-engine] Playback error:', message)
      if (message.includes('音频服务已重启')) {
        audioEngineError.value = message
        setAudioServiceCrashNotice(message)
      } else {
        setAudioEngineError(message)
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

setupAudioEngineListeners()
startRendererPlaybackClock()

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

  const remaining = duration.value - latestPlaybackTime
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

function maybeRecordResumeBookmark(track: Track | null | undefined, position: number): void {
  if (!track) return
  const bookmarks = usePlaybackBookmarks()
  void bookmarks.ensureLoaded().then(() => {
    if (!bookmarks.shouldOfferLongTrackResume(track)) return
    if (!Number.isFinite(position) || position < 15) return
    const dur = track.duration
    if (typeof dur === 'number' && Number.isFinite(dur) && position > dur - 10) return
    void bookmarks.addBookmark(track, position, { kind: 'resume' }).catch(() => {})
  })
}

function dismissResumeOffer(): void {
  resumeOffer.value = null
}

function acceptResumeOffer(): void {
  const offer = resumeOffer.value
  if (!offer) return
  const track = currentTrack.value
  if (!track || track.id !== offer.trackId) {
    resumeOffer.value = null
    return
  }
  resumeOffer.value = null
  seekPlayback(offer.positionSeconds)
}

function addManualBookmarkAtCurrentTime(): void {
  const track = currentTrack.value
  if (!track) return
  const position = latestPlaybackTime > 0 ? latestPlaybackTime : currentTime.value
  void usePlaybackBookmarks()
    .addBookmark(track, position, { kind: 'manual' })
    .catch(() => {})
}

function maybeOfferResumeForTrack(track: Track, normalizedStartTime: number): void {
  if (normalizedStartTime > 5) {
    if (resumeOffer.value?.trackId === track.id) resumeOffer.value = null
    return
  }
  void usePlaybackBookmarks()
    .ensureLoaded()
    .then(() => {
      if (currentTrack.value?.id !== track.id) return
      const bm = usePlaybackBookmarks()
      if (!bm.shouldOfferLongTrackResume(track)) return
      const resume = bm.resumeBookmarkFor(track)
      if (!resume || resume.positionSeconds < 15) return
      resumeOffer.value = {
        trackId: track.id,
        positionSeconds: resume.positionSeconds,
        label: resume.label
      }
    })
    .catch(() => {})
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
    maybeRecordResumeBookmark(previousTrack, latestPlaybackTime)
    // Force-write podcast progress for the track we are leaving.
    if (previousTrack.source === 'podcast') {
      const prevParsed = parsePodcastTrackId(previousTrack.id)
      if (prevParsed) {
        const seconds = Math.max(0, Math.floor(latestPlaybackTime || 0))
        if (seconds >= 1) {
          void usePodcastStore().updateEpisodeProgress(
            prevParsed.subscriptionId,
            prevParsed.episodeGuid,
            seconds
          )
        }
      }
    }
  }
  if (resumeOffer.value && resumeOffer.value.trackId !== track.id) {
    resumeOffer.value = null
  }

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
  beginPlaybackPositionTransition(normalizedStartTime)
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
    patchTrackInQueues(track)
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
            queue: queue.value,
            currentTrack: track,
            currentTarget: playTarget,
            currentIndex: queueIndex.value
          },
          {
            isAudioFileAuthorized: window.api.fs.isAudioFileAuthorized
          }
        )
        if (!preparedQueue) {
          throw new Error('Native playback target is unavailable')
        }

        await window.api.audioEngine.loadQueue(preparedQueue.items, preparedQueue.startIndex)
        if (!isActiveLoad(loadToken, track)) {
          releaseLoadIfOwned()
          return
        }
        nativeQueueDelegated = preparedQueue.delegated

        const nativePlayMode =
          playMode.value === 'repeat' || playMode.value === 'shuffle'
            ? playMode.value
            : 'sequential'
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
            ? `原生音频引擎不可用：${nativeFallbackReason}`
            : '原生音频引擎不可用'
        )
        isPlaying.value = false
        releaseLoadIfOwned()
        return
      }
      setAudioEngineError(
        nativeFallbackReason
          ? `原生音频引擎不可用，已启用临时播放通道：${nativeFallbackReason}`
          : ''
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
    beginPlaybackPositionTransition(resumeAt)
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
    maybeOfferResumeForTrack(track, resumeAt)
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
    if (action === 'volumeUp') {
      volume.value = Math.min(1, volume.value + 0.05)
      return
    }
    if (action === 'volumeDown') {
      volume.value = Math.max(0, volume.value - 0.05)
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
        maybeRecordResumeBookmark(track, latestPlaybackTime)
        flushPodcastEpisodeProgress(true)
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
        maybeRecordResumeBookmark(track, latestPlaybackTime)
        flushPodcastEpisodeProgress(true)
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
        await audio.play()
      } else {
        maybeRecordResumeBookmark(track, latestPlaybackTime)
        flushPodcastEpisodeProgress(true)
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
  if (latestPlaybackTime > 3) {
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
  if (isLoading.value || loadedTrackId !== track.id) {
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

function setAbLoopPoint(point: 'a' | 'b', time = latestPlaybackTime): void {
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
let desktopLyricsTimeThrottle = 0
function persistSelectedTrackSession(): void {
  const mode = appSettings.value.playbackResumeMode
  if (mode === 'off') return

  const session = createPlaybackSession(mode)
  if (!session) return

  const dataApi = window.api?.data
  if (!dataApi) return

  const write = playbackSessionWriter.save(dataApi, session)
  void write.completion.catch((err) => {
    console.warn('保存已选曲目播放会话失败:', err)
  })
}

function clearPersistedSelectedTrackSession(): void {
  const dataApi = window.api?.data
  if (!dataApi) return
  const write = playbackSessionWriter.clear(dataApi)
  void write.completion.catch((error) => {
    console.warn('清理不可用队列的播放会话失败:', error)
  })
}

function persistPlaybackSessionAfterQueueMutation(): void {
  if (!currentTrack.value || appSettings.value.playbackResumeMode === 'off') {
    clearPersistedSelectedTrackSession()
    return
  }
  persistSelectedTrackSession()
}

function syncDesktopLyricsSnapshot(): void {
  const desktopLyricsApi = window.api?.desktopLyrics
  if (!desktopLyricsApi) return

  const track = currentTrack.value
  if (track) {
    desktopLyricsApi.updateTrack({
      lyrics: track.lyrics ?? null,
      translatedLyrics: track.translatedLyrics ?? null,
      lyricsSource: track.lyricsSource ?? null,
      translatedLyricsSource: track.translatedLyricsSource ?? null,
      title: track.title || '',
      artist: track.artist || ''
    })
  } else {
    desktopLyricsApi.updateTrack({
      lyrics: null,
      translatedLyrics: null,
      lyricsSource: null,
      translatedLyricsSource: null,
      title: '',
      artist: ''
    })
  }
  desktopLyricsApi.updateTime(currentTime.value)
}

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
        flushPodcastEpisodeProgress(true)
      }
      updateDiscordActivity()
    },
    { immediate: true }
  )

  // Throttled podcast progress writeback while playing.
  watch(currentTime, () => {
    if (!isPlaying.value) return
    if (currentTrack.value?.source !== 'podcast') return
    flushPodcastEpisodeProgress(false)
  })

  watch([currentTime, duration], () => {
    if (appSettings.value?.smtcEnabled && isPlaying.value) updateMediaSessionPositionState()
  })

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

  watch(currentTrack, () => syncDesktopLyricsSnapshot(), { immediate: true })

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

  watch(currentTime, (time) => {
    const now = Date.now()
    if (now - desktopLyricsTimeThrottle < 200) return
    desktopLyricsTimeThrottle = now
    window.api?.desktopLyrics?.updateTime(time)
  })

  watch(
    () => appSettings.value?.desktopLyrics,
    (dl) => {
      if (!dl) return
      window.api?.desktopLyrics?.updateSettings({ ...dl })
    },
    { deep: true }
  )

  window.api?.desktopLyrics?.onToggle((enabled: boolean) => {
    if (enabled) syncDesktopLyricsSnapshot()
  })

  window.api?.bpmAnalysis?.onCompleted((event) => {
    applyBpmAnalysisToTrack(event.trackId, event.filePath, event.analysis)
  })
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function getPersonalizedStreamEntryId(track: Track | null): string | null {
  if (!track) return null
  if (track.queueEntryId) return track.queueEntryId
  const queued = queue.value[queueIndex.value]
  if (queued?.id === track.id && queued.queueEntryId) return queued.queueEntryId
  return queue.value.find((candidate) => candidate.id === track.id)?.queueEntryId ?? null
}

function refreshPersonalizedStreamRemaining(): void {
  if (!personalizedStreamSession.value) {
    personalizedStreamRemaining.value = 0
    return
  }
  let remaining = 0
  for (const entryId of personalizedStreamEntryIds) {
    if (!personalizedStreamPlayedEntryIds.has(entryId)) remaining += 1
  }
  personalizedStreamRemaining.value = remaining
}

function markCurrentPersonalizedStreamTrackPlayed(): void {
  if (!personalizedStreamSession.value) return
  const entryId = getPersonalizedStreamEntryId(currentTrack.value)
  if (!entryId || !personalizedStreamEntryIds.has(entryId)) return
  personalizedStreamPlayedEntryIds.add(entryId)
  refreshPersonalizedStreamRemaining()
}

function endPersonalizedStream(): void {
  personalizedStreamSession.value = null
  personalizedStreamEntryIds.clear()
  personalizedStreamPlayedEntryIds.clear()
  personalizedStreamRemaining.value = 0
}

function isPersonalizedStreamTrack(track: Track): boolean {
  if (!personalizedStreamSession.value) return false
  if (track.queueEntryId) return personalizedStreamEntryIds.has(track.queueEntryId)
  return queue.value.some(
    (candidate) =>
      candidate.id === track.id &&
      !!candidate.queueEntryId &&
      personalizedStreamEntryIds.has(candidate.queueEntryId)
  )
}

function startPersonalizedStream(key: PersonalizedStreamKey): PersonalizedStreamSession {
  personalizedStreamEntryIds.clear()
  personalizedStreamPlayedEntryIds.clear()
  for (const track of queue.value) {
    if (track.queueEntryId) personalizedStreamEntryIds.add(track.queueEntryId)
  }
  const session = { id: ++personalizedStreamSessionSequence, key }
  personalizedStreamSession.value = session
  markCurrentPersonalizedStreamTrackPlayed()
  refreshPersonalizedStreamRemaining()
  return session
}

function isPersonalizedStreamSessionCurrent(session: PersonalizedStreamSession): boolean {
  const active = personalizedStreamSession.value
  return active?.id === session.id && active.key === session.key
}

function applyPendingRendererPlayModeAtBoundary(): void {
  if (!rendererPlayModeBoundaryPending) return
  rendererPlayModeBoundaryPending = false
  const current = currentTrack.value
  if (!current || originalQueue.value.length === 0) return

  if (playMode.value === 'shuffle') {
    const queueEntryIndex = current.queueEntryId
      ? originalQueue.value.findIndex((track) => track.queueEntryId === current.queueEntryId)
      : -1
    const currentOriginalIndex =
      queueEntryIndex >= 0
        ? queueEntryIndex
        : originalQueue.value.findIndex((track) => track.id === current.id)
    const remaining = originalQueue.value.filter((_, index) => index !== currentOriginalIndex)
    queue.value = [current, ...shuffleArray(remaining)]
    queueIndex.value = 0
    return
  }

  queue.value = [...originalQueue.value]
  queueIndex.value = queue.value.findIndex((track) => track.id === current.id)
  if (queueIndex.value === -1) queueIndex.value = 0
}

function commitQueueEdit(nextQueue: readonly Track[], nextIndex: number): void {
  endPersonalizedStream()
  const snapshots = toPlaybackQueueSnapshots(nextQueue)
  queue.value = snapshots
  originalQueue.value = [...snapshots]
  queueIndex.value =
    snapshots.length === 0 ? -1 : Math.max(0, Math.min(nextIndex, snapshots.length - 1))
  persistPlaybackSessionAfterQueueMutation()
  void queueNativeQueueStateSync().catch((error) => {
    setAudioEngineError(error instanceof Error ? error.message : String(error))
  })
}

function enqueueTrack(track: Track): void {
  const next = [...queue.value, track]
  commitQueueEdit(next, queueIndex.value)
}

function appendQueueTracks(tracks: readonly Track[]): void {
  if (tracks.length === 0) return
  endPersonalizedStream()
  const additions = toPlaybackQueueSnapshots(tracks)
  originalQueue.value = [...originalQueue.value, ...additions]
  queue.value = [
    ...queue.value,
    ...(playMode.value === 'shuffle' ? shuffleArray(additions) : additions)
  ]
  persistPlaybackSessionAfterQueueMutation()
  void queueNativeQueueStateSync().catch((error) => {
    setAudioEngineError(error instanceof Error ? error.message : String(error))
  })
}

function appendPersonalizedStreamTracks(
  session: PersonalizedStreamSession,
  tracks: readonly Track[]
): boolean {
  if (tracks.length === 0 || !isPersonalizedStreamSessionCurrent(session)) return false
  const additions = toPlaybackQueueSnapshots(tracks)
  for (const track of additions) {
    if (track.queueEntryId) personalizedStreamEntryIds.add(track.queueEntryId)
  }
  originalQueue.value = [...originalQueue.value, ...additions]
  queue.value = [
    ...queue.value,
    ...(playMode.value === 'shuffle' ? shuffleArray(additions) : additions)
  ]
  refreshPersonalizedStreamRemaining()
  persistPlaybackSessionAfterQueueMutation()
  void queueNativeQueueStateSync().catch((error) => {
    setAudioEngineError(error instanceof Error ? error.message : String(error))
  })
  return true
}

function playNextTrack(track: Track): void {
  const insertAt = queueIndex.value >= 0 ? queueIndex.value + 1 : 0
  const next = [...queue.value]
  next.splice(insertAt, 0, track)
  commitQueueEdit(next, queueIndex.value)
}

function removeQueueItem(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= queue.value.length) return
  const next = [...queue.value]
  next.splice(index, 1)
  const nextIndex = index < queueIndex.value ? queueIndex.value - 1 : queueIndex.value
  commitQueueEdit(next, nextIndex)
}

function clearQueue(): void {
  commitQueueEdit([], -1)
  currentTrack.value = null
  isPlaying.value = false
  automaticLyricsBaselines.clear()
}

function reorderQueue(fromIndex: number, toIndex: number): void {
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= queue.value.length ||
    toIndex >= queue.value.length ||
    fromIndex === toIndex
  )
    return
  const next = [...queue.value]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  let nextIndex = queueIndex.value
  if (queueIndex.value === fromIndex) nextIndex = toIndex
  else if (fromIndex < queueIndex.value && toIndex >= queueIndex.value) nextIndex--
  else if (fromIndex > queueIndex.value && toIndex <= queueIndex.value) nextIndex++
  commitQueueEdit(next, nextIndex)
}

function saveQueueAsPlaylist(
  name: string,
  createPlaylistWithTracks: (name: string, tracks: Track[]) => string
): string {
  return createPlaylistWithTracks(name, [...queue.value])
}

function cyclePlayMode(): void {
  const modes: PlayMode[] = ['sequential', 'listLoop', 'repeat', 'shuffle']
  const idx = modes.indexOf(playMode.value)
  setPlayModeInternal(modes[(idx + 1) % modes.length])
}

function setPlayModeInternal(mode: PlayMode, options: { persist?: boolean } = {}): void {
  if (mode === playMode.value) return
  playMode.value = mode
  // Preserve the active track, position and queue identity. Renderer fallback
  // applies the new ordering only when next/EOF reaches a track boundary.
  rendererPlayModeBoundaryPending = true
  if (options.persist !== false) {
    void updateSettings({ playMode: mode }).catch((err) => {
      console.error('[音频引擎] 保存播放模式失败:', err)
    })
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

function cloneTrackForPlaybackSession(track: Track): Track {
  // Shallow copy — strip lyrics/translatedLyrics to avoid massive memory usage
  // when the entire queue is cloned for session persistence
  const source = getTrackSource(track)
  const cloned: Track = {
    id: track.id,
    queueEntryId: track.queueEntryId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    filePath: track.filePath,
    fileName: track.fileName,
    dir: track.dir,
    subTrack: track.subTrack,
    cueRange: track.cueRange ? { ...track.cueRange } : undefined,
    cueSheetPath: track.cueSheetPath,
    cueEncoding: track.cueEncoding,
    duration: track.duration,
    size: track.size,
    cover: track.cover,
    coverSource: track.coverSource ?? null,
    lyrics: null,
    source: track.source,
    ncmSongId: track.ncmSongId,
    streamUrl: source === 'local' ? track.streamUrl : null,
    format: track.format,
    sampleRate: track.sampleRate,
    bitrate: track.bitrate,
    bitDepth: track.bitDepth,
    bpm: track.bpm,
    bpmAnalysis: track.bpmAnalysis,
    replayGainTrackGainDb: track.replayGainTrackGainDb,
    replayGainAlbumGainDb: track.replayGainAlbumGainDb,
    replayGainTrackPeak: track.replayGainTrackPeak,
    replayGainAlbumPeak: track.replayGainAlbumPeak,
    r128TrackGainDb: track.r128TrackGainDb,
    r128AlbumGainDb: track.r128AlbumGainDb
  }
  return cloned
}

function restorePlaybackSession(session: PlaybackSession): void {
  const track = hydratePlaybackTrack(cloneTrackForPlaybackSession(session.track))
  const position =
    session.mode === 'trackAndPosition' ? clampCuePlaybackPosition(track, session.position) : 0

  resetPlaybackRuntimeStateForRestore()
  clearCrossfadeTimer()
  if (session.playMode) {
    setPlayModeInternal(session.playMode, { persist: false })
  }
  currentTrack.value = { ...track }

  // 恢复完整播放队列，而非只恢复当前一首歌
  const savedQueue =
    Array.isArray(session.queue) && session.queue.length > 0
      ? session.queue.map(cloneTrackForPlaybackSession)
      : [track]
  const rawIndex = session.queueIndex
  const savedIndex =
    typeof rawIndex === 'number' &&
    Number.isFinite(rawIndex) &&
    rawIndex >= 0 &&
    rawIndex < savedQueue.length
      ? rawIndex
      : 0
  queue.value = toPlaybackQueueSnapshots(savedQueue)
  originalQueue.value = [...queue.value]
  queueIndex.value = savedIndex

  duration.value = cueDuration(track)
  isPlaying.value = false
  isLoading.value = false
  restoredPlaybackPending = true
  restoredPlaybackPosition = position
  pendingLoadStartTime = 0
  autoAdvanceInFlight = false
  advancingFromEndedTrackId = ''
  setCurrentTimeImmediate(position)
  clearSleepTimerIntervals()
  const sleepTimer = getRestorableSleepTimerState(session.sleepTimer)
  if (sleepTimer) {
    getSleepTimerController().applyAuthoritativeState(sleepTimer)
    void window.api.sleepTimer?.configure(sleepTimer).catch(() => {})
  }
  void ensureCurrentTrackLyricsLoaded(track)
}

function createPlaybackSession(mode: PlaybackResumeMode): PlaybackSession | null {
  const track = currentTrack.value
  if (!track || mode === 'off') return null

  flushLatestCurrentTime()
  const rawPosition =
    mode === 'trackAndPosition'
      ? Math.max(0, Number.isFinite(currentTime.value) ? currentTime.value : 0)
      : 0
  const position =
    duration.value > 0 ? Math.min(rawPosition, Math.max(0, duration.value - 1)) : rawPosition

  return {
    version: 1,
    savedAt: new Date().toISOString(),
    mode,
    playMode: playMode.value,
    track: cloneTrackForPlaybackSession(track),
    position,
    queue: queue.value.map(cloneTrackForPlaybackSession),
    queueIndex: queueIndex.value,
    ...(sleepTimerState.value?.active ? { sleepTimer: sleepTimerState.value } : {})
  }
}

function removeUnavailableTracks(trackIds: string[], filePaths: string[]): void {
  for (const trackId of trackIds) automaticLyricsBaselines.delete(trackId)
  const nextState = pruneUnavailableLocalTracks(
    {
      currentTrack: currentTrack.value,
      queue: queue.value,
      originalQueue: originalQueue.value,
      queueIndex: queueIndex.value
    },
    trackIds,
    filePaths
  )
  const queueChanged =
    nextState.queue.length !== queue.value.length ||
    nextState.originalQueue.length !== originalQueue.value.length ||
    nextState.queueIndex !== queueIndex.value

  queue.value = nextState.queue
  originalQueue.value = nextState.originalQueue
  queueIndex.value = nextState.queueIndex
  if (nextState.activeTrackRemoved) {
    clearCrossfadeTimer()
    resetPlaybackRuntimeStateForRestore()
    currentTrack.value = null
    isPlaying.value = false
    isLoading.value = false
    duration.value = 0
    setCurrentTimeImmediate(0)
    clearPersistedSelectedTrackSession()
    return
  }

  currentTrack.value = nextState.currentTrack
  if (queueChanged) persistPlaybackSessionAfterQueueMutation()
  if (nativePlaybackActive) {
    void queueNativeQueueStateSync().catch((error) => {
      console.warn('[audio-engine] Failed to synchronize queue after library removal:', error)
    })
  }
}

onLocalTracksUnavailable(removeUnavailableTracks)

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
  playTrack: (track: Track, trackList?: Track[]) => void
  playTrackFromPosition: (track: Track, positionSeconds: number, trackList?: Track[]) => void
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

  function playTrack(track: Track, trackList?: Track[]): void {
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

  function playTrackFromPosition(track: Track, positionSeconds: number, trackList?: Track[]): void {
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

  async function toggleExclusiveMode(): Promise<void> {
    const next = !exclusiveMode.value
    try {
      applyAudioOutputState(await window.api.audioEngine.setExclusiveMode(next))
    } catch (err) {
      setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[audio-engine] Failed to toggle exclusive mode:', err)
    }
  }

  async function setAudioOutput(output: AudioOutputId, device?: string): Promise<void> {
    try {
      applyAudioOutputState(await window.api.audioEngine.setAudioOutput(output, device))
    } catch (err) {
      setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[audio-engine] Failed to switch audio output:', err)
    }
  }

  async function setAudioDevice(device: string): Promise<void> {
    try {
      applyAudioOutputState(await window.api.audioEngine.setAudioDevice(device))
    } catch (err) {
      setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[audio-engine] Failed to switch audio device:', err)
    }
  }

  async function setAudioOutputConfig(config: Partial<OutputConfig>): Promise<void> {
    if (audioOutputConfigApplyStatus.value.state === 'pending') return
    audioOutputConfigApplyStatus.value = {
      ...audioOutputConfigApplyStatus.value,
      requestedRevision: audioOutputConfigApplyStatus.value.requestedRevision + 1,
      state: 'pending',
      error: ''
    }
    try {
      audioOutputConfig.value = await window.api.audioEngine.setOutputConfig({
        ...audioOutputConfig.value,
        ...config
      })
      audioOutputConfigApplyStatus.value = await window.api.audioEngine.getOutputConfigApplyStatus()
      playbackInfo.value = normalizeNativePlaybackInfo(
        await window.api.audioEngine.getPlaybackInfo()
      )
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setAudioEngineError(errorMessage)
      audioOutputConfigApplyStatus.value = {
        ...audioOutputConfigApplyStatus.value,
        failedRevision: audioOutputConfigApplyStatus.value.requestedRevision,
        state: 'failed',
        error: errorMessage
      }
      console.error('[音频引擎] 更新输出配置失败:', err)
    }
  }

  async function setAudioProcessing(settings: Partial<AudioProcessingSettings>): Promise<void> {
    const nextSettings = mergeAudioProcessingPatch(settings)
    const previousSettings = cloneAudioProcessingSettings(audioProcessing.value)
    try {
      audioProcessing.value = cloneAudioProcessingSettings(
        await window.api.audioEngine.setAudioProcessing(nextSettings)
      )
      // Classic processing rewrites the default graph but must keep sample-rate lock;
      // re-sync output stage from scene state after apply.
      try {
        const sceneState = await window.api.audioEngine.getDspSceneState()
        const defaultScene = sceneState?.scenes?.find((scene) => scene.id === 'default')
        const graph = defaultScene?.graph ?? sceneState?.graph
        if (graph?.outputStage) {
          dspOutputStage.value = mergeDspOutputStage(graph.outputStage, {})
        }
        if (graph) {
          dspStereoImage.value = extractStereoImageFromGraph(graph)
        }
      } catch {
        // Scene state is optional for older bridges; processing still applied.
      }
      playbackInfo.value = normalizeNativePlaybackInfo(
        await window.api.audioEngine.getPlaybackInfo()
      )
      scheduleCrossfadeIfNeeded()
    } catch (err) {
      audioProcessing.value = previousSettings
      setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[audio-engine] Failed to update audio processing settings:', err)
    }
  }

  /**
   * Patch default-scene graph.outputStage (sample-rate lock / resampler / dither).
   * Does not invent OutputConfig fields — rate lock lives only on the DSP graph.
   */
  async function setOutputStage(partial: Partial<DspOutputStageConfig>): Promise<void> {
    const next = mergeDspOutputStage(dspOutputStage.value, partial)
    dspOutputStage.value = next
    try {
      const state = await window.api.audioEngine.setOutputStage(partial)
      const defaultScene = state?.scenes?.find((scene) => scene.id === 'default')
      if (defaultScene?.graph?.outputStage) {
        dspOutputStage.value = mergeDspOutputStage(defaultScene.graph.outputStage, {})
      } else if (state?.graph?.outputStage) {
        dspOutputStage.value = mergeDspOutputStage(state.graph.outputStage, {})
      }
      playbackInfo.value = normalizeNativePlaybackInfo(
        await window.api.audioEngine.getPlaybackInfo()
      )
    } catch (err) {
      setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[音频引擎] 更新输出采样率锁失败:', err)
      try {
        const sceneState = await window.api.audioEngine.getDspSceneState()
        const defaultScene = sceneState?.scenes?.find((scene) => scene.id === 'default')
        const graph = defaultScene?.graph ?? sceneState?.graph
        if (graph?.outputStage) {
          dspOutputStage.value = mergeDspOutputStage(graph.outputStage, {})
        }
        if (graph) {
          dspStereoImage.value = extractStereoImageFromGraph(graph)
        }
      } catch {
        // keep optimistic value if scene state is unavailable
      }
    }
  }

  /**
   * Patch default-scene stereoField balance/width + channelStrip polarity.
   * Graph-only; not classic audioProcessing fields.
   */
  async function setStereoImage(partial: Partial<DspStereoImageConfig>): Promise<void> {
    dspStereoImage.value = mergeDspStereoImage(dspStereoImage.value, partial)
    try {
      const state = await window.api.audioEngine.setStereoImage(partial)
      const defaultScene = state?.scenes?.find((scene) => scene.id === 'default')
      const graph = defaultScene?.graph ?? state?.graph
      if (graph) {
        dspStereoImage.value = extractStereoImageFromGraph(graph)
      }
      playbackInfo.value = normalizeNativePlaybackInfo(
        await window.api.audioEngine.getPlaybackInfo()
      )
    } catch (err) {
      setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[音频引擎] 更新平衡/相位失败:', err)
      try {
        const sceneState = await window.api.audioEngine.getDspSceneState()
        const defaultScene = sceneState?.scenes?.find((scene) => scene.id === 'default')
        const graph = defaultScene?.graph ?? sceneState?.graph
        if (graph) {
          dspStereoImage.value = extractStereoImageFromGraph(graph)
        }
      } catch {
        // keep optimistic value
      }
    }
  }

  async function toggleDspEnabled(): Promise<void> {
    await setAudioProcessing({ dspEnabled: !audioProcessing.value.dspEnabled })
  }

  async function toggleEqEnabled(): Promise<void> {
    await setAudioProcessing({ eqEnabled: !audioProcessing.value.eqEnabled })
  }

  async function toggleCrossfeed(): Promise<void> {
    await setAudioProcessing({
      crossfeedEnabled: !audioProcessing.value.crossfeedEnabled,
      crossfeedStrength:
        !audioProcessing.value.crossfeedEnabled && audioProcessing.value.crossfeedStrength <= 0
          ? 0.35
          : audioProcessing.value.crossfeedStrength
    })
  }

  async function toggleGapless(): Promise<void> {
    await setAudioProcessing({ gapless: !audioProcessing.value.gapless })
  }

  async function setReplayGainMode(
    mode: AudioProcessingSettings['volumeNormalization']
  ): Promise<void> {
    await setAudioProcessing({ volumeNormalization: mode })
  }

  async function setCrossfeedStrength(strength: number): Promise<void> {
    await setAudioProcessing({
      crossfeedEnabled: strength > 0,
      crossfeedStrength: Math.min(1, Math.max(0, strength))
    })
  }

  async function selectImpulseResponse(): Promise<void> {
    try {
      const path = await window.api.audioEngine.selectImpulseResponse()
      if (!path) return
      const nextSettings = mergeAudioProcessingPatch({
        convolverEnabled: true,
        convolverIrPath: path
      })
      audioProcessing.value = nextSettings
      await window.api.audioEngine.loadImpulseResponse(path)
      audioProcessing.value = cloneAudioProcessingSettings(
        await window.api.audioEngine.getAudioProcessing()
      )
      playbackInfo.value = normalizeNativePlaybackInfo(
        await window.api.audioEngine.getPlaybackInfo()
      )
    } catch (err) {
      console.error('[音频引擎] 加载卷积脉冲响应失败:', err)
      await persistAudioProcessingFallback(audioProcessing.value, err)
    }
  }

  async function clearImpulseResponse(): Promise<void> {
    const nextSettings = mergeAudioProcessingPatch({
      convolverEnabled: false,
      convolverIrPath: ''
    })
    audioProcessing.value = nextSettings
    try {
      await window.api.audioEngine.unloadImpulseResponse()
      audioProcessing.value = cloneAudioProcessingSettings(
        await window.api.audioEngine.getAudioProcessing()
      )
      playbackInfo.value = normalizeNativePlaybackInfo(
        await window.api.audioEngine.getPlaybackInfo()
      )
    } catch (err) {
      console.error('[音频引擎] 卸载卷积脉冲响应失败:', err)
      await persistAudioProcessingFallback(nextSettings, err)
    }
  }

  function formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  async function refreshCurrentLyrics(): Promise<void> {
    await ensureCurrentTrackLyricsLoaded(currentTrack.value)
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
