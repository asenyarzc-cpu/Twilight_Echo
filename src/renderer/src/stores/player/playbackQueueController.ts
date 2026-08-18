import type { Ref } from 'vue'
import type { Track } from '../../types/music'
import type { PlayMode } from '../../types/settings'
import { shuffleArray } from '../../utils/playerQueueUtils.ts'
import { toPlaybackQueueSnapshots } from '../../utils/playbackQueueVirtualization.ts'

export type PersonalizedStreamKey = 'fm' | 'radar'
export interface PersonalizedStreamSession {
  id: number
  key: PersonalizedStreamKey
}

export interface PlaybackQueueControllerOptions {
  currentTrack: Ref<Track | null>
  queue: Ref<Track[]>
  originalQueue: Ref<Track[]>
  queueIndex: Ref<number>
  playMode: Ref<PlayMode>
  isPlaying: Ref<boolean>
  personalizedStreamSession: Ref<PersonalizedStreamSession | null>
  personalizedStreamRemaining: Ref<number>
  personalizedStreamEntryIds: Set<string>
  personalizedStreamPlayedEntryIds: Set<string>
  rendererPlayModeBoundaryPending: Ref<boolean>
  persistPlaybackSessionAfterQueueMutation: () => void
  queueNativeQueueStateSync: () => Promise<void>
  setAudioEngineError: (error: string | null) => void
  clearAutomaticLyricsBaselines: () => void
}

export function createPlaybackQueueController(options: PlaybackQueueControllerOptions) {
  let personalizedStreamSessionSequence = 0

  function getPersonalizedStreamEntryId(track: Track | null): string | null {
    if (!track) return null
    if (track.queueEntryId) return track.queueEntryId
    const queued = options.queue.value[options.queueIndex.value]
    if (queued?.id === track.id && queued.queueEntryId) return queued.queueEntryId
    return options.queue.value.find((candidate) => candidate.id === track.id)?.queueEntryId ?? null
  }

  function refreshPersonalizedStreamRemaining(): void {
    if (!options.personalizedStreamSession.value) {
      options.personalizedStreamRemaining.value = 0
      return
    }
    let remaining = 0
    for (const entryId of options.personalizedStreamEntryIds) {
      if (!options.personalizedStreamPlayedEntryIds.has(entryId)) remaining += 1
    }
    options.personalizedStreamRemaining.value = remaining
  }

  function markCurrentPersonalizedStreamTrackPlayed(): void {
    if (!options.personalizedStreamSession.value) return
    const entryId = getPersonalizedStreamEntryId(options.currentTrack.value)
    if (!entryId || !options.personalizedStreamEntryIds.has(entryId)) return
    options.personalizedStreamPlayedEntryIds.add(entryId)
    refreshPersonalizedStreamRemaining()
  }

  function endPersonalizedStream(): void {
    options.personalizedStreamSession.value = null
    options.personalizedStreamEntryIds.clear()
    options.personalizedStreamPlayedEntryIds.clear()
    options.personalizedStreamRemaining.value = 0
  }

  function isPersonalizedStreamTrack(track: Track): boolean {
    if (!options.personalizedStreamSession.value) return false
    if (track.queueEntryId) return options.personalizedStreamEntryIds.has(track.queueEntryId)
    return options.queue.value.some(
      (candidate) =>
        candidate.id === track.id &&
        !!candidate.queueEntryId &&
        options.personalizedStreamEntryIds.has(candidate.queueEntryId)
    )
  }

  function startPersonalizedStream(key: PersonalizedStreamKey): PersonalizedStreamSession {
    options.personalizedStreamEntryIds.clear()
    options.personalizedStreamPlayedEntryIds.clear()
    for (const track of options.queue.value) {
      if (track.queueEntryId) options.personalizedStreamEntryIds.add(track.queueEntryId)
    }
    const session = { id: ++personalizedStreamSessionSequence, key }
    options.personalizedStreamSession.value = session
    markCurrentPersonalizedStreamTrackPlayed()
    refreshPersonalizedStreamRemaining()
    return session
  }

  function isPersonalizedStreamSessionCurrent(session: PersonalizedStreamSession): boolean {
    const active = options.personalizedStreamSession.value
    return active?.id === session.id && active.key === session.key
  }

  function applyPendingRendererPlayModeAtBoundary(): void {
    if (!options.rendererPlayModeBoundaryPending.value) return
    options.rendererPlayModeBoundaryPending.value = false
    if (options.playMode.value === 'heart') return
    const current = options.currentTrack.value
    if (!current || options.originalQueue.value.length === 0) return

    if (options.playMode.value === 'shuffle') {
      const queueEntryIndex = current.queueEntryId
        ? options.originalQueue.value.findIndex(
            (track) => track.queueEntryId === current.queueEntryId
          )
        : -1
      const currentOriginalIndex =
        queueEntryIndex >= 0
          ? queueEntryIndex
          : options.originalQueue.value.findIndex((track) => track.id === current.id)
      const remaining = options.originalQueue.value.filter(
        (_, index) => index !== currentOriginalIndex
      )
      options.queue.value = [current, ...shuffleArray(remaining)]
      options.queueIndex.value = 0
      return
    }

    options.queue.value = [...options.originalQueue.value]
    options.queueIndex.value = options.queue.value.findIndex((track) => track.id === current.id)
    if (options.queueIndex.value === -1) options.queueIndex.value = 0
  }

  function commitQueueEdit(nextQueue: readonly Track[], nextIndex: number): void {
    endPersonalizedStream()
    const snapshots = toPlaybackQueueSnapshots(nextQueue)
    options.queue.value = snapshots
    options.originalQueue.value = [...snapshots]
    options.queueIndex.value =
      snapshots.length === 0 ? -1 : Math.max(0, Math.min(nextIndex, snapshots.length - 1))
    options.persistPlaybackSessionAfterQueueMutation()
    void options.queueNativeQueueStateSync().catch((error) => {
      options.setAudioEngineError(error instanceof Error ? error.message : String(error))
    })
  }

  function enqueueTrack(track: Track): void {
    const next = [...options.queue.value, track]
    commitQueueEdit(next, options.queueIndex.value)
  }

  function appendQueueTracks(tracks: readonly Track[]): void {
    if (tracks.length === 0) return
    endPersonalizedStream()
    const additions = toPlaybackQueueSnapshots(tracks)
    options.originalQueue.value = [...options.originalQueue.value, ...additions]
    options.queue.value = [
      ...options.queue.value,
      ...(options.playMode.value === 'shuffle' ? shuffleArray(additions) : additions)
    ]
    options.persistPlaybackSessionAfterQueueMutation()
    void options.queueNativeQueueStateSync().catch((error) => {
      options.setAudioEngineError(error instanceof Error ? error.message : String(error))
    })
  }

  function appendPersonalizedStreamTracks(
    session: PersonalizedStreamSession,
    tracks: readonly Track[]
  ): boolean {
    if (tracks.length === 0 || !isPersonalizedStreamSessionCurrent(session)) return false
    const additions = toPlaybackQueueSnapshots(tracks)
    for (const track of additions) {
      if (track.queueEntryId) options.personalizedStreamEntryIds.add(track.queueEntryId)
    }
    options.originalQueue.value = [...options.originalQueue.value, ...additions]
    options.queue.value = [
      ...options.queue.value,
      ...(options.playMode.value === 'shuffle' ? shuffleArray(additions) : additions)
    ]
    refreshPersonalizedStreamRemaining()
    options.persistPlaybackSessionAfterQueueMutation()
    void options.queueNativeQueueStateSync().catch((error) => {
      options.setAudioEngineError(error instanceof Error ? error.message : String(error))
    })
    return true
  }

  function playNextTrack(track: Track): void {
    const insertAt = options.queueIndex.value >= 0 ? options.queueIndex.value + 1 : 0
    const next = [...options.queue.value]
    next.splice(insertAt, 0, track)
    commitQueueEdit(next, options.queueIndex.value)
  }

  function removeQueueItem(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= options.queue.value.length) return
    const next = [...options.queue.value]
    next.splice(index, 1)
    const nextIndex =
      index < options.queueIndex.value ? options.queueIndex.value - 1 : options.queueIndex.value
    commitQueueEdit(next, nextIndex)
  }

  function clearQueue(): void {
    commitQueueEdit([], -1)
    options.currentTrack.value = null
    options.isPlaying.value = false
    options.clearAutomaticLyricsBaselines()
  }

  function reorderQueue(fromIndex: number, toIndex: number): void {
    if (
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= options.queue.value.length ||
      toIndex >= options.queue.value.length ||
      fromIndex === toIndex
    )
      return
    const next = [...options.queue.value]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    let nextIndex = options.queueIndex.value
    if (options.queueIndex.value === fromIndex) nextIndex = toIndex
    else if (fromIndex < options.queueIndex.value && toIndex >= options.queueIndex.value)
      nextIndex--
    else if (fromIndex > options.queueIndex.value && toIndex <= options.queueIndex.value)
      nextIndex++
    commitQueueEdit(next, nextIndex)
  }

  function saveQueueAsPlaylist(
    name: string,
    createPlaylistWithTracks: (name: string, tracks: Track[]) => string
  ): string {
    return createPlaylistWithTracks(name, [...options.queue.value])
  }

  return {
    markCurrentPersonalizedStreamTrackPlayed,
    endPersonalizedStream,
    isPersonalizedStreamTrack,
    startPersonalizedStream,
    isPersonalizedStreamSessionCurrent,
    applyPendingRendererPlayModeAtBoundary,
    commitQueueEdit,
    enqueueTrack,
    appendQueueTracks,
    appendPersonalizedStreamTracks,
    playNextTrack,
    removeQueueItem,
    clearQueue,
    reorderQueue,
    saveQueueAsPlaylist
  }
}
