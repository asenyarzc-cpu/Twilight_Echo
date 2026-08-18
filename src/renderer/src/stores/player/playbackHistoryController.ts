import { ref, type Ref } from 'vue'
import type { Track } from '../../types/music'
import { parsePodcastTrackId } from '../../../../shared/podcastSubscriptions.ts'

export interface PlaybackResumeOffer {
  trackId: string
  positionSeconds: number
  label: string
}

export interface PlaybackBookmarksService {
  ensureLoaded: () => Promise<void>
  shouldOfferLongTrackResume: (track: Track | null | undefined) => boolean
  resumeBookmarkFor: (
    track: Track | null | undefined
  ) => { positionSeconds: number; label: string } | null
  addBookmark: (
    track: Track,
    positionSeconds: number,
    options: { kind: 'resume' | 'manual' }
  ) => Promise<unknown>
}

export interface PodcastProgressService {
  updateEpisodeProgress: (
    subscriptionId: string,
    episodeGuid: string,
    progressSeconds: number
  ) => Promise<void>
}

export interface PlaybackHistoryControllerOptions {
  currentTrack: Ref<Track | null>
  currentTime: Ref<number>
  getLatestPlaybackTime: () => number
  seekPlayback: (time: number) => void
  getPlaybackBookmarks: () => PlaybackBookmarksService
  getPodcastStore: () => PodcastProgressService
  now: () => number
}

export function createPlaybackHistoryController(options: PlaybackHistoryControllerOptions) {
  const resumeOffer = ref<PlaybackResumeOffer | null>(null)
  let disposed = false
  let generation = 0
  let lastPodcastProgressWriteAt = 0
  let lastPodcastProgressTrackId = ''
  let lastPodcastProgressSeconds = -1

  function isActive(expectedGeneration: number): boolean {
    return !disposed && generation === expectedGeneration
  }

  function maybeRecordResumeBookmark(track: Track | null | undefined, position: number): void {
    if (disposed || !track) return
    const requestGeneration = generation
    const bookmarks = options.getPlaybackBookmarks()
    void bookmarks.ensureLoaded().then(() => {
      if (!isActive(requestGeneration)) return
      if (!bookmarks.shouldOfferLongTrackResume(track)) return
      if (!Number.isFinite(position) || position < 15) return
      const dur = track.duration
      if (typeof dur === 'number' && Number.isFinite(dur) && position > dur - 10) return
      void bookmarks.addBookmark(track, position, { kind: 'resume' }).catch(() => {})
    })
  }

  function flushPodcastEpisodeProgress(force = false): void {
    if (disposed) return
    const track = options.currentTrack.value
    if (!track || track.source !== 'podcast') return
    const parsed = parsePodcastTrackId(track.id)
    if (!parsed) return
    const seconds = Math.max(
      0,
      Math.floor(options.getLatestPlaybackTime() || options.currentTime.value || 0)
    )
    if (seconds < 1 && !force) return
    const now = options.now()
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
    void options
      .getPodcastStore()
      .updateEpisodeProgress(parsed.subscriptionId, parsed.episodeGuid, seconds)
  }

  function flushPodcastProgressForTrack(track: Track | null | undefined, position: number): void {
    if (disposed || !track || track.source !== 'podcast') return
    const parsed = parsePodcastTrackId(track.id)
    if (!parsed) return
    const seconds = Math.max(0, Math.floor(position || 0))
    if (seconds < 1) return
    void options
      .getPodcastStore()
      .updateEpisodeProgress(parsed.subscriptionId, parsed.episodeGuid, seconds)
  }

  function recordTrackDeparture(track: Track | null | undefined): void {
    if (disposed) return
    const position = options.getLatestPlaybackTime()
    maybeRecordResumeBookmark(track, position)
    flushPodcastProgressForTrack(track, position)
  }

  function dismissResumeOffer(): void {
    if (disposed) return
    resumeOffer.value = null
  }

  function acceptResumeOffer(): void {
    if (disposed) return
    const offer = resumeOffer.value
    if (!offer) return
    const track = options.currentTrack.value
    if (!track || track.id !== offer.trackId) {
      resumeOffer.value = null
      return
    }
    resumeOffer.value = null
    options.seekPlayback(offer.positionSeconds)
  }

  function addManualBookmarkAtCurrentTime(): void {
    if (disposed) return
    const track = options.currentTrack.value
    if (!track) return
    const position =
      options.getLatestPlaybackTime() > 0
        ? options.getLatestPlaybackTime()
        : options.currentTime.value
    void options
      .getPlaybackBookmarks()
      .addBookmark(track, position, { kind: 'manual' })
      .catch(() => {})
  }

  function maybeOfferResumeForTrack(track: Track, normalizedStartTime: number): void {
    if (disposed) return
    if (normalizedStartTime > 5) {
      if (resumeOffer.value?.trackId === track.id) resumeOffer.value = null
      return
    }
    const requestGeneration = generation
    void options
      .getPlaybackBookmarks()
      .ensureLoaded()
      .then(() => {
        if (!isActive(requestGeneration)) return
        if (options.currentTrack.value?.id !== track.id) return
        const bookmarks = options.getPlaybackBookmarks()
        if (!bookmarks.shouldOfferLongTrackResume(track)) return
        const resume = bookmarks.resumeBookmarkFor(track)
        if (!resume || resume.positionSeconds < 15) return
        resumeOffer.value = {
          trackId: track.id,
          positionSeconds: resume.positionSeconds,
          label: resume.label
        }
      })
      .catch(() => {})
  }

  function clearResumeOfferForOtherTrack(track: Track): void {
    if (disposed) return
    if (resumeOffer.value && resumeOffer.value.trackId !== track.id) {
      resumeOffer.value = null
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    generation += 1
    resumeOffer.value = null
  }

  return {
    resumeOffer,
    maybeRecordResumeBookmark,
    dismissResumeOffer,
    acceptResumeOffer,
    addManualBookmarkAtCurrentTime,
    maybeOfferResumeForTrack,
    flushPodcastEpisodeProgress,
    recordTrackDeparture,
    clearResumeOfferForOtherTrack,
    dispose
  }
}
