import { ref, type Ref } from 'vue'
import type { Track } from '../../types/music'
import type { PlayMode } from '../../types/settings'
import { NATIVE_PAUSE_CONFIRMATION_MS } from '../../utils/playerConstants.ts'
import {
  createPlaybackSessionClock,
  type PlaybackClockSnapshot,
  type PlaybackTransportState
} from '../../utils/playbackSessionClock.ts'
import { createPlaybackClock } from './usePlaybackClock.ts'

export interface PlaybackClockControllerOptions {
  currentTrack: Ref<Track | null>
  currentTime: Ref<number>
  duration: Ref<number>
  playbackRate: Ref<number>
  isPlaying: Ref<boolean>
  isLoading: Ref<boolean>
  abLoopA: Ref<number | null>
  abLoopB: Ref<number | null>
  playMode: Ref<PlayMode>
  getNow: () => number
  getPlaybackToggleIntent: () => { playing: boolean; expiresAt: number } | null
  getAbLoopNativeActive: () => boolean
  enforceAbLoop: (time: number) => void
  isCurrentTrackLiveStream: () => boolean
  applyNativePlaybackInfo: (
    info: NativePlaybackInfo,
    options?: { applyTrackWhenInactive?: boolean }
  ) => boolean
}

type NativePlaybackInfo = Awaited<ReturnType<typeof window.api.audioEngine.getPlaybackInfo>>

export function createPlaybackClockController(options: PlaybackClockControllerOptions) {
  let pendingNativePause: { position: number } | null = null
  let nativePauseConfirmationTimer: number | null = null
  let playbackClockResyncInFlight = false

  const playbackSessionClock = createPlaybackSessionClock({ now: options.getNow })
  const playbackClockSnapshot = ref<PlaybackClockSnapshot>(playbackSessionClock.snapshot())

  function publishPlaybackClockSnapshot(
    snapshot = playbackSessionClock.snapshot()
  ): PlaybackClockSnapshot {
    playbackClockSnapshot.value = snapshot
    return snapshot
  }

  const playbackClock = createPlaybackClock({
    currentTime: options.currentTime,
    getNow: options.getNow,
    enforceAbLoop: options.enforceAbLoop,
    onTick: () => {
      if (options.isCurrentTrackLiveStream()) return
      const estimated = playbackSessionClock.estimate()
      if (estimated?.needsResync) {
        void requestPlaybackClockResync()
        return
      }
      if (estimated !== null) {
        publishPlaybackClockSnapshot(estimated)
        playbackClock.publishCurrentTime(estimated.position)
      }
    }
  })

  function clearPendingNativePause(): void {
    pendingNativePause = null
    if (nativePauseConfirmationTimer !== null) {
      window.clearTimeout(nativePauseConfirmationTimer)
      nativePauseConfirmationTimer = null
    }
  }

  function deferNativePause(position: number): void {
    pendingNativePause = {
      position: Math.max(
        0,
        Number.isFinite(position) ? position : playbackClock.getLatestPlaybackTime()
      )
    }
    if (nativePauseConfirmationTimer !== null) return
    nativePauseConfirmationTimer = window.setTimeout(() => {
      nativePauseConfirmationTimer = null
      if (pendingNativePause) options.isPlaying.value = false
    }, NATIVE_PAUSE_CONFIRMATION_MS)
  }

  function recoverFromStaleNativePause(position: number): void {
    const pendingPause = pendingNativePause
    if (
      !pendingPause ||
      position <= pendingPause.position + 0.01 ||
      options.getPlaybackToggleIntent()?.playing === false
    ) {
      return
    }
    clearPendingNativePause()
    options.isPlaying.value = true
  }

  function setCurrentTimeImmediate(time: number, clockAlreadyUpdated = false): void {
    playbackClock.cancelScheduledPublish()
    if (!clockAlreadyUpdated)
      publishPlaybackClockSnapshot(playbackSessionClock.setPosition(time, 'intent'))
    playbackClock.publishCurrentTime(time)
  }

  function anchorRendererPlaybackClock(time: number): void {
    publishPlaybackClockSnapshot(playbackSessionClock.setPosition(time, 'intent'))
  }

  function beginPlaybackPositionTransition(
    time: number,
    optionsOverride: { keepRendererClockAlive?: boolean } = {}
  ): void {
    clearPendingNativePause()
    const position = publishPlaybackClockSnapshot(
      playbackSessionClock.begin({
        trackId: options.currentTrack.value?.id ?? '',
        position: time,
        duration: options.duration.value,
        rate: options.playbackRate.value,
        state:
          options.isPlaying.value || optionsOverride.keepRendererClockAlive ? 'playing' : 'loading'
      })
    ).position
    setCurrentTimeImmediate(position, true)
  }

  function applyPlaybackPositionSample(
    time: number,
    source: 'native-time-pos' | 'native-info' | 'html-audio' = 'native-info'
  ): boolean {
    const position = Math.max(0, Number.isFinite(time) ? time : 0)
    const delta = position - playbackSessionClock.snapshot().position
    const expectedRewind =
      delta < 0 &&
      (options.getAbLoopNativeActive() ||
        (options.abLoopA.value != null && options.abLoopB.value != null) ||
        options.playMode.value === 'repeat' ||
        (position <= 0.05 &&
          options.duration.value > 0 &&
          options.currentTime.value >= options.duration.value - 1))
    const decision = playbackSessionClock.ingest({
      trackId: options.currentTrack.value?.id ?? '',
      epoch: playbackSessionClock.epoch(),
      position,
      expectedRewind,
      duration: options.duration.value,
      rate: options.playbackRate.value,
      source,
      state: options.isPlaying.value ? 'playing' : options.isLoading.value ? 'loading' : 'paused'
    })
    if (!decision.accepted) return false
    publishPlaybackClockSnapshot(decision.snapshot)
    if (decision.advanced) recoverFromStaleNativePause(position)

    if (expectedRewind || decision.snapshot.position + 0.5 < options.currentTime.value) {
      setCurrentTimeImmediate(decision.snapshot.position, true)
    } else {
      setCurrentTimeThrottled(decision.snapshot.position, true)
    }
    return true
  }

  function estimatePlaybackClockPosition(at = options.getNow()): number {
    return playbackSessionClock.positionAt(at)
  }

  async function requestPlaybackClockResync(): Promise<void> {
    if (playbackClockResyncInFlight || !options.currentTrack.value) return
    const api = window.api?.audioEngine
    if (!api?.getPlaybackInfo) return
    playbackClockResyncInFlight = true
    try {
      const info = await api.getPlaybackInfo()
      options.applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
    } catch {
      // The next renderer tick retries while the clock remains stalled.
    } finally {
      playbackClockResyncInFlight = false
    }
  }

  function setCurrentTimeThrottled(time: number, clockAlreadyUpdated = false): void {
    if (!clockAlreadyUpdated)
      publishPlaybackClockSnapshot(playbackSessionClock.setPosition(time, 'intent'))
    playbackClock.setCurrentTimeThrottled(time)
  }

  function flushLatestCurrentTime(): void {
    playbackClock.flushLatestCurrentTime()
  }

  function clearPendingTimePublish(): void {
    playbackClock.cancelScheduledPublish()
  }

  function startRendererPlaybackClock(): void {
    playbackClock.startRendererClock()
  }

  function stopRendererPlaybackClock(): void {
    playbackClock.stopRendererClock()
  }

  function getLatestPlaybackTime(): number {
    return playbackClock.getLatestPlaybackTime()
  }

  function setTransport(
    state: PlaybackTransportState,
    rate: number = options.playbackRate.value
  ): void {
    publishPlaybackClockSnapshot(playbackSessionClock.setTransport(state, rate))
  }

  function setDuration(duration: number): void {
    publishPlaybackClockSnapshot(playbackSessionClock.setDuration(duration))
  }

  function resetPlaybackClock(): void {
    publishPlaybackClockSnapshot(playbackSessionClock.reset())
  }

  function dispose(): void {
    clearPendingNativePause()
    clearPendingTimePublish()
    stopRendererPlaybackClock()
  }

  return {
    playbackClockSnapshot,
    clearPendingNativePause,
    deferNativePause,
    recoverFromStaleNativePause,
    setCurrentTimeImmediate,
    anchorRendererPlaybackClock,
    beginPlaybackPositionTransition,
    applyPlaybackPositionSample,
    estimatePlaybackClockPosition,
    flushLatestCurrentTime,
    startRendererPlaybackClock,
    getLatestPlaybackTime,
    setTransport,
    setDuration,
    resetPlaybackClock,
    dispose
  }
}
