import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music'
import { archivePlaybackQueue, buildArchiveLibrary } from './archiveLibrary.ts'

function track(index: number, addedAt = 0): Track {
  return { id: String(index), title: String(index), duration: 180, addedAt } as Track
}

test('archive shelves rank additions by timestamp and preserve newest insertion on ties', () => {
  const tracks = [track(0, 400), track(1, 100), track(2, 300), track(3, 400)]
  const library = buildArchiveLibrary(tracks, 3)
  assert.deepEqual(
    library.recentlyAdded.map((item) => item.id),
    ['3', '0', '2']
  )
  assert.equal(library.totalSeconds, 720)
  assert.equal(library.indexById.get('2'), 2)
  assert.deepEqual(
    tracks.map((item) => item.id),
    ['0', '1', '2', '3']
  )
})

test('archive materializes at most 30 additions for large and legacy libraries', () => {
  const tracks = Array.from({ length: 100_000 }, (_, index) => track(index))
  const library = buildArchiveLibrary(tracks)
  assert.equal(library.recentlyAdded.length, 30)
  assert.equal(library.recentlyAdded[0].id, '99999')
  assert.equal(library.recentlyAdded[29].id, '99970')
  for (const index of [0, 99, 50000, 99999]) {
    const queue = archivePlaybackQueue(tracks, library.indexById, tracks[index])
    assert.equal(queue.length, 200)
    assert.ok(queue.includes(tracks[index]))
    assert.ok(
      queue.every(
        (item, position) => position === 0 || Number(item.id) === Number(queue[position - 1].id) + 1
      )
    )
  }
})

test('archive playback preserves remote history tracks and handles short or empty libraries', () => {
  const tracks = [track(1), track(2)]
  const library = buildArchiveLibrary(tracks)
  const remote = { ...track(3), source: 'ncm' } as Track
  assert.deepEqual(archivePlaybackQueue(tracks, library.indexById, remote), [remote])
  assert.deepEqual(archivePlaybackQueue(tracks, library.indexById, tracks[1]), tracks)
  assert.deepEqual(buildArchiveLibrary([]).recentlyAdded, [])
  assert.equal(buildArchiveLibrary([]).totalSeconds, 0)
})
