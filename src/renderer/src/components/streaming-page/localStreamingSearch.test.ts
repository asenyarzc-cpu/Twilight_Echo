import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../../types/music'

const {
  normalizeLocalStreamingQuery,
  searchLocalStreamingArtists,
  searchLocalStreamingPlaylists,
  searchLocalStreamingSongs
} = (await import(
  new URL('./localStreamingSearch.ts', import.meta.url).href
)) as typeof import('./localStreamingSearch')

function track(id: string, patch: Partial<Track> = {}): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `/music/${id}.flac`,
    fileName: `${id}.flac`,
    duration: 180,
    size: 1024,
    cover: null,
    lyrics: null,
    source: 'local',
    ...patch
  }
}

test('normalizeLocalStreamingQuery keeps searchable letters and numbers', () => {
  assert.equal(normalizeLocalStreamingQuery(' Moon-River 2024! '), 'moonriver2024')
  assert.equal(normalizeLocalStreamingQuery('周杰伦 - 青花瓷'), '周杰伦青花瓷')
})

test('searchLocalStreamingSongs searches title artist and album with pagination', () => {
  const tracks = [
    track('a', { title: 'Moon River' }),
    track('b', { artist: 'The River Band' }),
    track('c', { album: 'River Collection' }),
    track('d', { title: 'Sunrise' })
  ]

  const result = searchLocalStreamingSongs(tracks, 'river', 2, 1)

  assert.equal(result.total, 3)
  assert.deepEqual(
    result.tracks.map((item) => item.id),
    ['b', 'c']
  )
})

test('searchLocalStreamingSongs scans large result sets without returning more than the page', () => {
  const tracks = Array.from({ length: 5000 }, (_, index) =>
    track(String(index), { title: `Matched Song ${index}` })
  )

  const result = searchLocalStreamingSongs(tracks, 'matched', 5, 1234)

  assert.equal(result.total, 5000)
  assert.equal(result.tracks.length, 5)
  assert.deepEqual(
    result.tracks.map((item) => item.id),
    ['1234', '1235', '1236', '1237', '1238']
  )
})

test('searchLocalStreamingPlaylists returns provider summaries for the requested page', () => {
  const playlists = [
    { id: 'p1', name: 'Morning Flow', trackIds: ['a'] },
    { id: 'p2', name: 'Night Flow', trackIds: ['a', 'b'] },
    { id: 'p3', name: 'Focus Flow', trackIds: ['a', 'b', 'c'] }
  ]

  const result = searchLocalStreamingPlaylists(playlists, 'flow', 1, 1)

  assert.equal(result.total, 3)
  assert.deepEqual(result.playlists, [
    {
      id: 'p2',
      name: 'Night Flow',
      cover: null,
      trackCount: 2
    }
  ])
})

test('searchLocalStreamingArtists returns empty results for blank queries', () => {
  const result = searchLocalStreamingArtists(
    [{ name: 'Known Artist', cover: null, trackCount: 4 }],
    '  -  '
  )

  assert.deepEqual(result, { artists: [], total: 0 })
})

test('searchLocalStreamingArtists maps local library items to provider summaries', () => {
  const result = searchLocalStreamingArtists(
    [
      { name: 'Luna', cover: 'cover-a', trackCount: 3 },
      { name: 'Luna Sea', cover: null, trackCount: 8 },
      { name: 'Solar', cover: null, trackCount: 2 }
    ],
    'luna'
  )

  assert.equal(result.total, 2)
  assert.deepEqual(result.artists, [
    { id: 'Luna', name: 'Luna', picUrl: 'cover-a', musicSize: 3 },
    { id: 'Luna Sea', name: 'Luna Sea', picUrl: null, musicSize: 8 }
  ])
})

test('song search blobs do not match across field boundaries', () => {
  const tracks = [track('x', { title: 'Foo', artist: 'Bar', album: 'Baz' })]
  assert.equal(searchLocalStreamingSongs(tracks, 'obar').total, 0)
  assert.equal(searchLocalStreamingSongs(tracks, 'foo').total, 1)
  assert.equal(searchLocalStreamingSongs(tracks, 'bar').total, 1)
})

test('song search reuses normalized blobs across queries on 20k tracks', () => {
  const tracks = Array.from({ length: 20000 }, (_, index) =>
    track(String(index), {
      title: `Song ${index}`,
      artist: `Artist ${index % 500}`,
      album: `Album ${index % 1000}`
    })
  )
  searchLocalStreamingSongs(tracks, 'song 19999')

  const start = performance.now()
  const result = searchLocalStreamingSongs(tracks, 'song 19')
  const elapsed = performance.now() - start

  assert.ok(elapsed < 50, `warm blob search took ${elapsed.toFixed(2)}ms, expected < 50ms`)
  assert.ok(result.total > 0)
})
