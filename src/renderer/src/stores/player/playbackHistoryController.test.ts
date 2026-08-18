import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { Track } from '../../types/music'
import {
  createPlaybackHistoryController,
  type PlaybackBookmarksService,
  type PodcastProgressService
} from './playbackHistoryController.ts'

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'local:test',
    title: 'Test track',
    artist: 'Test artist',
    album: 'Test album',
    filePath: 'test.flac',
    fileName: 'test.flac',
    duration: 600,
    size: 1,
    cover: null,
    lyrics: null,
    ...overrides
  }
}

interface Harness {
  currentTrack: ReturnType<typeof ref<Track | null>>
  currentTime: ReturnType<typeof ref<number>>
  resumeOffer: ReturnType<
    typeof ref<{
      trackId: string
      positionSeconds: number
      label: string
    } | null>
  >
  bookmarks: PlaybackBookmarksService
  progress: PodcastProgressService
  bookmarkAdds: Array<{ track: Track; position: number; kind: 'resume' | 'manual' }>
  progressWrites: Array<{ subscriptionId: string; episodeGuid: string; seconds: number }>
  controller: ReturnType<typeof createPlaybackHistoryController>
  setNow: (value: number) => void
  setLatestTime: (value: number) => void
  setResume: (position: number, label?: string) => void
  releaseBookmarkLoad: () => void
}

function createHarness(): Harness {
  const currentTrack = ref<Track | null>(null)
  const currentTime = ref(0)
  const bookmarkAdds: Harness['bookmarkAdds'] = []
  const progressWrites: Harness['progressWrites'] = []
  let now = 1_000
  let latestTime = 0
  let resumePosition: number | null = null
  let resumeLabel = 'Resume'
  const longTrack = true
  const pendingBookmarkLoads: Array<() => void> = []
  const bookmarks: PlaybackBookmarksService = {
    ensureLoaded: () =>
      new Promise<void>((resolve) => {
        pendingBookmarkLoads.push(resolve)
      }),
    shouldOfferLongTrackResume: () => longTrack,
    resumeBookmarkFor: () =>
      resumePosition == null ? null : { positionSeconds: resumePosition, label: resumeLabel },
    addBookmark: async (track, position, options) => {
      bookmarkAdds.push({ track, position, kind: options.kind })
      return null
    }
  }
  const progress: PodcastProgressService = {
    updateEpisodeProgress: async (subscriptionId, episodeGuid, seconds) => {
      progressWrites.push({ subscriptionId, episodeGuid, seconds })
    }
  }
  const controller = createPlaybackHistoryController({
    currentTrack,
    currentTime,
    getLatestPlaybackTime: () => latestTime,
    seekPlayback: (position) => {
      latestTime = position
    },
    getPlaybackBookmarks: () => bookmarks,
    getPodcastStore: () => progress,
    now: () => now
  })

  return {
    currentTrack,
    currentTime,
    resumeOffer: controller.resumeOffer,
    bookmarks,
    progress,
    bookmarkAdds,
    progressWrites,
    controller,
    setNow: (value) => {
      now = value
    },
    setLatestTime: (value) => {
      latestTime = value
    },
    setResume: (position, label = 'Resume') => {
      resumePosition = position
      resumeLabel = label
    },
    releaseBookmarkLoad: () => {
      for (const resolve of pendingBookmarkLoads.splice(0)) resolve()
    }
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('resume offers wait for loaded bookmarks and reject stale track activations', async () => {
  const harness = createHarness()
  const first = makeTrack({ id: 'local:first' })
  const second = makeTrack({ id: 'local:second' })
  harness.setResume(42, '0:42')
  harness.currentTrack.value = first

  harness.controller.maybeOfferResumeForTrack(first, 0)
  harness.currentTrack.value = second
  harness.releaseBookmarkLoad()
  await flushPromises()
  assert.equal(harness.resumeOffer.value, null)

  harness.controller.maybeOfferResumeForTrack(first, 0)
  harness.releaseBookmarkLoad()
  await flushPromises()
  assert.equal(harness.resumeOffer.value, null)

  harness.currentTrack.value = first
  harness.controller.maybeOfferResumeForTrack(first, 0)
  harness.releaseBookmarkLoad()
  await flushPromises()
  assert.deepEqual(harness.resumeOffer.value, {
    trackId: 'local:first',
    positionSeconds: 42,
    label: '0:42'
  })

  harness.controller.acceptResumeOffer()
  assert.equal(harness.resumeOffer.value, null)
  harness.controller.dismissResumeOffer()
  assert.equal(harness.resumeOffer.value, null)
})

test('resume bookmarks enforce long-track, position, and near-end thresholds', async () => {
  const harness = createHarness()
  const track = makeTrack({ id: 'local:long', duration: 100 })
  harness.currentTrack.value = track

  harness.controller.maybeRecordResumeBookmark(track, 14.99)
  harness.releaseBookmarkLoad()
  await flushPromises()
  assert.equal(harness.bookmarkAdds.length, 0)

  harness.controller.maybeRecordResumeBookmark(track, 91)
  harness.releaseBookmarkLoad()
  await flushPromises()
  assert.equal(harness.bookmarkAdds.length, 0)

  harness.controller.maybeRecordResumeBookmark(track, 30)
  harness.releaseBookmarkLoad()
  await flushPromises()
  assert.deepEqual(harness.bookmarkAdds, [{ track, position: 30, kind: 'resume' }])
})

test('dispose invalidates pending bookmark callbacks and clears the stable offer ref', async () => {
  const harness = createHarness()
  const track = makeTrack({ id: 'local:dispose' })
  harness.currentTrack.value = track
  harness.setResume(42, '0:42')

  harness.controller.maybeRecordResumeBookmark(track, 30)
  harness.controller.maybeOfferResumeForTrack(track, 0)
  harness.controller.dispose()
  harness.releaseBookmarkLoad()
  await flushPromises()

  assert.equal(harness.bookmarkAdds.length, 0)
  assert.equal(harness.resumeOffer.value, null)
  harness.controller.maybeRecordResumeBookmark(track, 30)
  harness.controller.maybeOfferResumeForTrack(track, 0)
  assert.equal(harness.resumeOffer.value, null)
})

test('manual bookmarks use the latest playback time and fall back to currentTime', async () => {
  const harness = createHarness()
  const track = makeTrack()
  harness.currentTrack.value = track
  harness.currentTime.value = 18
  harness.controller.addManualBookmarkAtCurrentTime()
  await flushPromises()
  assert.equal(harness.bookmarkAdds[0]?.position, 18)

  harness.setLatestTime(27)
  harness.controller.addManualBookmarkAtCurrentTime()
  await flushPromises()
  assert.equal(harness.bookmarkAdds[1]?.position, 27)
})

test('podcast progress throttles ordinary writes and allows forced flushes', () => {
  const harness = createHarness()
  harness.currentTrack.value = makeTrack({
    id: 'podcast:subscription:episode:with:colon',
    source: 'podcast'
  })
  harness.setLatestTime(42.9)

  harness.controller.flushPodcastEpisodeProgress()
  assert.deepEqual(harness.progressWrites, [
    { subscriptionId: 'subscription', episodeGuid: 'episode:with:colon', seconds: 42 }
  ])

  harness.setLatestTime(43.1)
  harness.controller.flushPodcastEpisodeProgress()
  assert.equal(harness.progressWrites.length, 1)

  harness.setNow(5_001)
  harness.setLatestTime(45.2)
  harness.controller.flushPodcastEpisodeProgress()
  assert.deepEqual(harness.progressWrites.at(-1), {
    subscriptionId: 'subscription',
    episodeGuid: 'episode:with:colon',
    seconds: 45
  })

  harness.controller.flushPodcastEpisodeProgress(true)
  assert.equal(harness.progressWrites.length, 3)
})
