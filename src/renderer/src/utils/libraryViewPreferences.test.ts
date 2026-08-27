import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music'
import {
  applyLibraryView,
  createDefaultLibraryViewState,
  LibraryViewPreferences,
  libraryViewKey,
  type LibraryViewStorage
} from './libraryViewPreferences.ts'

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: id,
    artist: 'Artist',
    album: 'Album',
    filePath: `D:\\Music\\${id}.flac`,
    fileName: `${id}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local',
    format: 'flac',
    sampleRate: 96_000,
    bitDepth: 24,
    addedAt: 1_000,
    ...overrides
  }
}

function memoryStorage(): LibraryViewStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
}

test('combines lossless, DSD, sample rate, bit depth, folder, and provider filters', () => {
  const state = createDefaultLibraryViewState()
  state.filters = {
    lossless: true,
    dsd: true,
    sampleRate: 2_822_400,
    bitDepth: 1,
    folder: 'D:\\Music\\DSD',
    provider: 'local'
  }
  const selected = applyLibraryView(
    [
      track('match', {
        filePath: 'D:\\Music\\DSD\\match.dsf',
        dir: 'D:\\Music\\DSD',
        format: 'dsf',
        sampleRate: 2_822_400,
        bitDepth: 1
      }),
      track('wrong-provider', {
        source: 'ncm',
        filePath: 'ncm:wrong-provider',
        format: 'dsf',
        sampleRate: 2_822_400,
        bitDepth: 1
      }),
      track('wrong-rate', {
        filePath: 'D:\\Music\\DSD\\wrong-rate.dsf',
        dir: 'D:\\Music\\DSD',
        format: 'dsf',
        sampleRate: 176_400,
        bitDepth: 1
      })
    ],
    state
  )
  assert.deepEqual(
    selected.map((item) => item.id),
    ['match']
  )
})

test('sorts every required field with stable tie breaking and last-played metadata', () => {
  const state = createDefaultLibraryViewState()
  const tracks = [
    track('z', {
      title: 'Zulu',
      artist: 'Zed',
      album: 'Z',
      duration: 300,
      format: 'wav',
      sampleRate: 48_000,
      addedAt: 3
    }),
    track('a', {
      title: 'Alpha',
      artist: 'Able',
      album: 'A',
      duration: 120,
      format: 'flac',
      sampleRate: 96_000,
      addedAt: 1
    }),
    track('b', {
      title: 'Beta',
      artist: 'Baker',
      album: 'B',
      duration: 240,
      format: 'dsf',
      sampleRate: 2_822_400,
      addedAt: 2
    })
  ]
  for (const [sortKey, expected] of [
    ['title', ['a', 'b', 'z']],
    ['artist', ['a', 'b', 'z']],
    ['album', ['a', 'b', 'z']],
    ['playlist', ['z', 'a', 'b']],
    ['duration', ['a', 'b', 'z']],
    ['format', ['b', 'a', 'z']],
    ['sampleRate', ['z', 'a', 'b']],
    ['addedAt', ['a', 'b', 'z']],
    ['lastPlayed', ['a', 'z', 'b']]
  ] as const) {
    state.sortKey = sortKey
    state.sortDirection = 'asc'
    assert.deepEqual(
      applyLibraryView(
        tracks,
        state,
        new Map([
          ['a', 1],
          ['z', 2],
          ['b', 3]
        ])
      ).map((item) => item.id),
      expected
    )
  }
})

test('playlist category defaults to the playlist order and never reorders it', () => {
  const defaults = createDefaultLibraryViewState('playlists')
  assert.equal(defaults.sortKey, 'playlist')
  assert.equal(defaults.sortDirection, 'asc')

  const state = createDefaultLibraryViewState('playlists')
  const ordered = applyLibraryView(
    [
      track('first-added', { title: 'Zulu' }),
      track('second-added', { title: 'Alpha' }),
      track('third-added', { title: 'Beta' })
    ],
    state
  )
  assert.deepEqual(
    ordered.map((item) => item.id),
    ['first-added', 'second-added', 'third-added'],
    'a playlist must keep its stored order instead of sorting by title'
  )
})

test('album category defaults to track number and sorts disc then track', () => {
  const defaults = createDefaultLibraryViewState('albums')
  assert.equal(defaults.sortKey, 'trackNumber')
  assert.equal(defaults.sortDirection, 'asc')

  const state = createDefaultLibraryViewState('albums')
  const ordered = applyLibraryView(
    [
      track('t9', { title: 'Zulu', trackNumber: 9, discNumber: 1, fileName: '09.flac' }),
      track('t2', { title: 'Alpha', trackNumber: 2, discNumber: 1, fileName: '02.flac' }),
      track('d2t1', { title: 'Middle', trackNumber: 1, discNumber: 2, fileName: 'd2-01.flac' }),
      track('t1', { title: 'Beta', trackNumber: 1, discNumber: 1, fileName: '01.flac' }),
      track('missing', { title: 'No Tag', fileName: '99-z.flac' })
    ],
    state
  )
  assert.deepEqual(
    ordered.map((item) => item.id),
    ['t1', 't2', 't9', 'd2t1', 'missing']
  )
})

test('trackNumber sort falls back to natural fileName when tags are absent', () => {
  const state = createDefaultLibraryViewState('albums')
  const ordered = applyLibraryView(
    [
      track('b', { title: 'Zulu', fileName: '10. song.flac' }),
      track('a', { title: 'Alpha', fileName: '2. song.flac' }),
      track('c', { title: 'Beta', fileName: '1. song.flac' })
    ],
    state
  )
  assert.deepEqual(
    ordered.map((item) => item.id),
    ['c', 'a', 'b']
  )
})

test('sorting keeps Chinese collation and natural numeric filename order', () => {
  const titleState = createDefaultLibraryViewState()
  const titleOrdered = applyLibraryView(
    [
      track('cn-2', { title: '中文' }),
      track('cn-1', { title: '阿波' }),
      track('cn-3', { title: '英文' })
    ],
    titleState
  )
  assert.deepEqual(
    titleOrdered.map((item) => item.id),
    ['cn-1', 'cn-3', 'cn-2']
  )

  const albumState = createDefaultLibraryViewState('albums')
  const fileOrdered = applyLibraryView(
    [
      track('file-10', { fileName: '10.flac', trackNumber: undefined }),
      track('file-2', { fileName: '2.flac', trackNumber: undefined }),
      track('file-1', { fileName: '1.flac', trackNumber: undefined })
    ],
    albumState
  )
  assert.deepEqual(
    fileOrdered.map((item) => item.id),
    ['file-1', 'file-2', 'file-10']
  )
})

test('persists independent state for every category and detail filter', () => {
  const storage = memoryStorage()
  const preferences = new LibraryViewPreferences(storage)
  const allSongs = libraryViewKey('allSongs', null)
  const album = libraryViewKey('albums', 'album:release-42')
  const allState = createDefaultLibraryViewState()
  allState.sortKey = 'duration'
  const albumState = createDefaultLibraryViewState('albums')
  albumState.filters.provider = 'ncm'
  preferences.write(allSongs, allState)
  preferences.write(album, albumState)
  assert.equal(preferences.read(allSongs).sortKey, 'duration')
  assert.equal(preferences.read(album, 'albums').filters.provider, 'ncm')
  assert.equal(preferences.read(album, 'albums').sortKey, 'trackNumber')
  assert.equal(
    preferences.read(libraryViewKey('artists', 'artist:other'), 'artists').sortKey,
    'title'
  )
})

test('filters and sorts 10,000 tracks within the virtualized view budget', () => {
  const tracks = Array.from({ length: 10_000 }, (_, index) =>
    track(`track-${index}`, {
      title: `Track ${10_000 - index}`,
      duration: index,
      sampleRate: index % 2 === 0 ? 96_000 : 44_100,
      bitDepth: index % 2 === 0 ? 24 : 16,
      dir: index % 3 === 0 ? 'D:\\Music\\A' : 'D:\\Music\\B'
    })
  )
  const state = createDefaultLibraryViewState()
  state.sortKey = 'duration'
  state.filters.sampleRate = 96_000
  const startedAt = performance.now()
  const result = applyLibraryView(tracks, state)
  const elapsed = performance.now() - startedAt
  assert.equal(result.length, 5_000)
  assert.ok(elapsed < 500, `10k combined filter/sort took ${elapsed.toFixed(1)}ms`)
})
