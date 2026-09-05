import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import type { Track } from '@renderer/types/music.ts'
import { createRemotePlaybackPublisher } from './remotePlaybackPublisher.ts'

const track: Track = {
  id: 'a',
  title: 'A',
  artist: '',
  album: '',
  duration: 1,
  filePath: '',
  fileName: '',
  size: 0,
  cover: 'cover://a',
  lyrics: ''
}

test('remote publisher resolves only current cover and ignores stale completion', async () => {
  const currentTrack = shallowRef<Track | null>(track)
  const published: Array<{ coverUrl?: string | null }> = []
  let resolveFirst!: (value: string | null) => void
  const stop = createRemotePlaybackPublisher({
    currentTrack,
    isPlaying: shallowRef(false),
    currentTime: shallowRef(0),
    duration: shallowRef(1),
    volume: shallowRef(1),
    muted: shallowRef(false),
    queueIndex: shallowRef(0),
    queue: shallowRef([track]),
    playMode: shallowRef('sequential'),
    castTarget: shallowRef(null),
    snapshotExtras: () => ({ playMode: 'sequence', queueRevision: 1 }),
    publish: (snapshot) => {
      published.push(snapshot)
    },
    resolveCover: () =>
      new Promise((resolve) => {
        resolveFirst = resolve
      })
  })
  currentTrack.value = { ...track, id: 'b', cover: '' }
  await new Promise((resolve) => setTimeout(resolve, 0))
  resolveFirst('data:image/png;base64,abc')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(published.at(-1)?.coverUrl, null)
  stop()
})

test('paused queue and mode updates publish trailing state and cleanup stops future publications', async () => {
  const queue = shallowRef([track])
  const mode = shallowRef('sequence')
  const snapshots: Array<{ queueLength?: number; playMode?: string }> = []
  const stop = createRemotePlaybackPublisher({
    currentTrack: shallowRef({ ...track, cover: '' }),
    isPlaying: shallowRef(false),
    currentTime: shallowRef(0),
    duration: shallowRef(1),
    volume: shallowRef(1),
    muted: shallowRef(false),
    queueIndex: shallowRef(0),
    queue,
    playMode: mode,
    castTarget: shallowRef(null),
    snapshotExtras: () => ({
      playMode: mode.value === 'loop' ? 'loop' : 'sequence',
      queueRevision: queue.value.length
    }),
    publish: (snapshot) => {
      snapshots.push(snapshot)
    },
    resolveCover: async () => null
  })
  queue.value = [track, track]
  mode.value = 'loop'
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(snapshots.at(-1)?.queueLength, 2)
  assert.equal(snapshots.at(-1)?.playMode, 'loop')
  stop()
  const count = snapshots.length
  queue.value = []
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(snapshots.length, count)
})
