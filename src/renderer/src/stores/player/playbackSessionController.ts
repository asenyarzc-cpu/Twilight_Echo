import type { Ref } from 'vue'
import type { PlaybackSession, Track } from '../../types/music'
import type { AppSettings, PlaybackResumeMode, PlayMode } from '../../types/settings'
import type { SleepTimerState } from '../../../../shared/sleepTimer.ts'
import { playbackSessionWriter } from '../../app/playbackSessionWriter.ts'
import {
  getRestorableSleepTimerState,
  createSleepTimerController
} from '../sleepTimerController.ts'
import { cloneTrackForPlaybackSession } from '../../utils/playerSessionTrack.ts'
import { clampCuePlaybackPosition, cueDuration } from '../../utils/cuePlayback.ts'
import { toPlaybackQueueSnapshots } from '../../utils/playbackQueueVirtualization.ts'
import {
  onLocalTracksUnavailable,
  pruneUnavailableLocalTracks
} from '../../utils/localTrackRemovalPolicy.ts'

export interface PlaybackSessionControllerOptions {
  currentTrack: Ref<Track | null>
  queue: Ref<Track[]>
  originalQueue: Ref<Track[]>
  queueIndex: Ref<number>
  playMode: Ref<PlayMode>
  duration: Ref<number>
  currentTime: Ref<number>
  isPlaying: Ref<boolean>
  isLoading: Ref<boolean>
  sleepTimerState: Ref<SleepTimerState | null>
  getAppSettings: () => Ref<AppSettings>
  getSleepTimerController: () => ReturnType<typeof createSleepTimerController>
  hydratePlaybackTrack: (track: Track) => Track
  resetPlaybackRuntimeStateForRestore: () => void
  setPlayModeInternal: (mode: PlayMode, options?: { persist?: boolean }) => void
  loadLyricsForTrack: (track: Track) => void
  clearCrossfadeTimer: () => void
  setCurrentTimeImmediate: (time: number, clockAlreadyUpdated?: boolean) => void
  clearSleepTimerIntervals: () => void
  flushLatestCurrentTime: () => void
  queueNativeQueueStateSync: () => Promise<void>
  deleteAutomaticLyricsBaseline: (trackId: string) => void
  getRestoredPlaybackPending: () => boolean
  setRestoredPlaybackPending: (value: boolean) => void
  getRestoredPlaybackPosition: () => number
  setRestoredPlaybackPosition: (value: number) => void
  getPendingLoadStartTime: () => number
  setPendingLoadStartTime: (value: number) => void
  getAutoAdvanceInFlight: () => boolean
  setAutoAdvanceInFlight: (value: boolean) => void
  getAdvancingFromEndedTrackId: () => string
  setAdvancingFromEndedTrackId: (value: string) => void
  getNativePlaybackActive: () => boolean
}

export function createPlaybackSessionController(options: PlaybackSessionControllerOptions) {
  function persistSelectedTrackSession(): void {
    const mode = options.getAppSettings().value.playbackResumeMode
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
    if (
      !options.currentTrack.value ||
      options.getAppSettings().value.playbackResumeMode === 'off'
    ) {
      clearPersistedSelectedTrackSession()
      return
    }
    persistSelectedTrackSession()
  }

  function restorePlaybackSession(session: PlaybackSession): void {
    const track = options.hydratePlaybackTrack(cloneTrackForPlaybackSession(session.track))
    const position =
      session.mode === 'trackAndPosition' ? clampCuePlaybackPosition(track, session.position) : 0

    options.resetPlaybackRuntimeStateForRestore()
    options.clearCrossfadeTimer()
    if (session.playMode) {
      options.setPlayModeInternal(session.playMode, { persist: false })
    }
    options.currentTrack.value = { ...track }

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
    options.queue.value = toPlaybackQueueSnapshots(savedQueue)
    options.originalQueue.value = [...options.queue.value]
    options.queueIndex.value = savedIndex

    options.duration.value = cueDuration(track)
    options.isPlaying.value = false
    options.isLoading.value = false
    options.setRestoredPlaybackPending(true)
    options.setRestoredPlaybackPosition(position)
    options.setPendingLoadStartTime(0)
    options.setAutoAdvanceInFlight(false)
    options.setAdvancingFromEndedTrackId('')
    options.setCurrentTimeImmediate(position)
    options.clearSleepTimerIntervals()
    const sleepTimer = getRestorableSleepTimerState(session.sleepTimer)
    if (sleepTimer) {
      options.getSleepTimerController().applyAuthoritativeState(sleepTimer)
      void window.api.sleepTimer?.configure(sleepTimer).catch(() => {})
    }
    options.loadLyricsForTrack(track)
  }

  function createPlaybackSession(mode: PlaybackResumeMode): PlaybackSession | null {
    const track = options.currentTrack.value
    if (!track || mode === 'off') return null

    options.flushLatestCurrentTime()
    const rawPosition =
      mode === 'trackAndPosition'
        ? Math.max(0, Number.isFinite(options.currentTime.value) ? options.currentTime.value : 0)
        : 0
    const position =
      options.duration.value > 0
        ? Math.min(rawPosition, Math.max(0, options.duration.value - 1))
        : rawPosition

    return {
      version: 1,
      savedAt: new Date().toISOString(),
      mode,
      playMode: options.playMode.value === 'heart' ? 'sequential' : options.playMode.value,
      track: cloneTrackForPlaybackSession(track),
      position,
      queue: options.queue.value.map(cloneTrackForPlaybackSession),
      queueIndex: options.queueIndex.value,
      ...(options.sleepTimerState.value?.active
        ? { sleepTimer: options.sleepTimerState.value }
        : {})
    }
  }

  function removeUnavailableTracks(trackIds: string[], filePaths: string[]): void {
    for (const trackId of trackIds) options.deleteAutomaticLyricsBaseline(trackId)
    const nextState = pruneUnavailableLocalTracks(
      {
        currentTrack: options.currentTrack.value,
        queue: options.queue.value,
        originalQueue: options.originalQueue.value,
        queueIndex: options.queueIndex.value
      },
      trackIds,
      filePaths
    )
    const queueChanged =
      nextState.queue.length !== options.queue.value.length ||
      nextState.originalQueue.length !== options.originalQueue.value.length ||
      nextState.queueIndex !== options.queueIndex.value

    options.queue.value = nextState.queue
    options.originalQueue.value = nextState.originalQueue
    options.queueIndex.value = nextState.queueIndex
    if (nextState.activeTrackRemoved) {
      options.clearCrossfadeTimer()
      options.resetPlaybackRuntimeStateForRestore()
      options.currentTrack.value = null
      options.isPlaying.value = false
      options.isLoading.value = false
      options.duration.value = 0
      options.setCurrentTimeImmediate(0)
      clearPersistedSelectedTrackSession()
      return
    }

    options.currentTrack.value = nextState.currentTrack
    if (queueChanged) persistPlaybackSessionAfterQueueMutation()
    if (options.getNativePlaybackActive()) {
      void options.queueNativeQueueStateSync().catch((error) => {
        console.warn('[audio-engine] Failed to synchronize queue after library removal:', error)
      })
    }
  }

  onLocalTracksUnavailable(removeUnavailableTracks)

  return {
    persistSelectedTrackSession,
    clearPersistedSelectedTrackSession,
    persistPlaybackSessionAfterQueueMutation,
    restorePlaybackSession,
    createPlaybackSession,
    removeUnavailableTracks
  }
}
