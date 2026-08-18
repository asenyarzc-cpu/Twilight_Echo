import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../../types/music'
import type { Playlist } from '../useMusicStore.ts'
import {
  albumOrderIndex,
  clonePlaylist,
  compareAlbumTrackOrder,
  deduplicateLibraryPaths,
  getAlbumCoverIdentity,
  getAlbumIdentity,
  isLocalLibraryTrack,
  isTrackUnderLibraryRoot,
  mergeAlbumGroupsByReleaseEvidence,
  normalizeAlbumIdentityText,
  normalizeLibraryPath,
  normalizePortableLibraryPath,
  parentDirectoryOf,
  playlistDataEqual,
  replayPlaylistRecord,
  replayPlaylistTransaction,
  toPlaylistTrackSnapshot
} from './musicStoreData.ts'

interface AlbumGroup {
  tracks: Track[]
  cover: string | null
  artist?: string
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track',
    title: 'Title',
    artist: 'Artist',
    album: 'Album',
    filePath: 'C:\\music\\track.flac',
    fileName: 'track.flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local',
    ...overrides
  }
}

function makePlaylist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: 'pl-mix',
    name: 'Mix',
    trackIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

test('album identity prefers explicit ids and normalizes fallback release evidence', () => {
  assert.equal(getAlbumIdentity(makeTrack({ albumId: '  release-1  ' })), 'id:release-1')
  assert.equal(
    getAlbumIdentity(
      makeTrack({
        album: ' Ａlbum　Title ',
        albumArtist: 'Artist',
        artist: 'Artist',
        dir: 'C:\\Music\\Album Title'
      })
    ),
    'dir:c:\\music\\album title\u001falbum title'
  )
  assert.equal(normalizeAlbumIdentityText(' Ａlbum　Title '), 'album title')
})

test('album cover identity prefers the durable remote origin for twilight media covers', () => {
  assert.equal(getAlbumCoverIdentity(makeTrack()), '')
  assert.equal(
    getAlbumCoverIdentity(
      makeTrack({
        cover: 'twilight-media://image/abc',
        coverSource: 'https://Cover.example/Art.jpg'
      })
    ),
    'https://cover.example/art.jpg'
  )
  assert.equal(getAlbumCoverIdentity(makeTrack({ cover: 'cover://Art.jpg' })), 'cover://art.jpg')
})

test('release evidence merges same-title dir groups only when artwork matches', () => {
  const sharedCover = 'cover://release.jpg'
  const albumMap = new Map<string, AlbumGroup>([
    [
      'dir:c:\\music\\one',
      {
        tracks: [
          makeTrack({ id: 'one', album: '２０', dir: 'C:\\music\\one', cover: sharedCover })
        ],
        cover: sharedCover
      }
    ],
    [
      'dir:c:\\music\\two',
      {
        tracks: [makeTrack({ id: 'two', album: '20', dir: 'C:\\music\\two', cover: sharedCover })],
        cover: sharedCover
      }
    ],
    [
      'dir:c:\\music\\other',
      {
        tracks: [
          makeTrack({
            id: 'other',
            album: '20',
            dir: 'C:\\music\\other',
            cover: 'cover://other.jpg'
          })
        ],
        cover: 'cover://other.jpg'
      }
    ],
    [
      'id:authoritative',
      {
        tracks: [
          makeTrack({
            id: 'authoritative',
            album: '20',
            dir: 'C:\\music\\authoritative',
            cover: sharedCover
          })
        ],
        cover: sharedCover
      }
    ]
  ])

  const merged = mergeAlbumGroupsByReleaseEvidence(albumMap as Map<string, AlbumGroup>)
  assert.equal(merged.size, 3)
  const shared = merged.get('dir:c:\\music\\one')
  assert.deepEqual(shared?.tracks.map((track) => track.id).sort(), ['one', 'two'])
  assert.equal(merged.get('dir:c:\\music\\other')?.tracks[0]?.id, 'other')
  assert.equal(merged.get('id:authoritative')?.tracks[0]?.id, 'authoritative')
})

test('album track ordering groups by disc, track, then file name', () => {
  const tracks = [
    makeTrack({ id: 'disc-two', discNumber: 2, trackNumber: 1, fileName: 'b.flac' }),
    makeTrack({ id: 'missing-track', fileName: 'a.flac' }),
    makeTrack({ id: 'disc-one', discNumber: 1, trackNumber: 2, fileName: 'b.flac' }),
    makeTrack({ id: 'first', discNumber: 1, trackNumber: 1, fileName: 'a.flac' })
  ]
  assert.deepEqual(
    tracks.sort(compareAlbumTrackOrder).map((track) => track.id),
    ['first', 'disc-one', 'disc-two', 'missing-track']
  )
  assert.equal(albumOrderIndex(0), Number.MAX_SAFE_INTEGER)
  assert.equal(albumOrderIndex(3), 3)
})

test('library path helpers normalize, deduplicate, and bound tracks to roots', () => {
  assert.equal(parentDirectoryOf('C:/music/album/track.flac'), 'C:\\music\\album')
  assert.equal(parentDirectoryOf('track.flac'), '')
  assert.equal(normalizeLibraryPath('C:/Music/Album/'), 'c:\\music\\album')
  assert.deepEqual(deduplicateLibraryPaths([' C:/Music ', 'C:\\music\\', '  D:\\Tracks  ', '']), [
    'C:/Music',
    'D:\\Tracks'
  ])
  assert.equal(isTrackUnderLibraryRoot('C:\\Music\\Album\\a.flac', 'c:\\music'), true)
  assert.equal(isTrackUnderLibraryRoot('C:\\Music\\Album\\a.flac', 'c:\\music\\album'), true)
  assert.equal(isTrackUnderLibraryRoot('C:\\Music-Other\\a.flac', 'c:\\music'), false)
})

test('playlist snapshots strip volatile stream urls for non-local sources only', () => {
  const local = makeTrack({ source: 'local', streamUrl: 'https://local.example/stream' })
  const remote = makeTrack({
    source: 'ncm',
    streamUrl: 'https://provider.example/stream',
    fileName: 'remote.flac'
  })

  assert.equal(toPlaylistTrackSnapshot(local).streamUrl, 'https://local.example/stream')
  assert.equal(toPlaylistTrackSnapshot(remote).streamUrl, undefined)
  assert.equal(toPlaylistTrackSnapshot(remote).fileName, 'remote.flac')
})

test('playlist clone and equality use deep JSON semantics', () => {
  const playlist = makePlaylist({
    trackSnapshots: { 'track-1': makeTrack({ id: 'track-1' }) }
  })
  const cloned = clonePlaylist(playlist)
  assert.notEqual(cloned, playlist)
  assert.notEqual(cloned.trackSnapshots, playlist.trackSnapshots)
  assert.equal(playlistDataEqual(cloned, playlist), true)
  assert.equal(playlistDataEqual(cloned, { ...playlist, name: 'Other' }), false)
})

test('playlist transaction replay preserves concurrent state and applies local edits', () => {
  const base = [
    makePlaylist({
      id: 'pl-mix',
      name: 'Old Name',
      trackIds: ['a', 'b']
    })
  ]
  const local = [
    makePlaylist({
      id: 'pl-mix',
      name: 'New Name',
      trackIds: ['a', 'b', 'c']
    })
  ]
  const authoritative = [
    makePlaylist({
      id: 'pl-mix',
      name: 'Concurrent Name',
      trackIds: ['a', 'b', 'remote'],
      createdAt: '2026-01-02T00:00:00.000Z'
    }),
    makePlaylist({
      id: 'pl-remote',
      name: 'Remote Only',
      trackIds: ['remote']
    })
  ]

  const merged = replayPlaylistTransaction(base, local, authoritative)
  assert.equal(merged.length, 2)
  assert.equal(merged[0]?.name, 'New Name')
  assert.deepEqual(merged[0]?.trackIds, ['a', 'b', 'remote', 'c'])
  assert.equal(merged[1]?.id, 'pl-remote')
})

test('playlist record replay keeps concurrent additions after a local reorder', () => {
  const base = makePlaylist({ id: 'pl-mix', trackIds: ['a', 'b'] })
  const local = makePlaylist({ id: 'pl-mix', trackIds: ['b', 'a'] })
  const current = makePlaylist({ id: 'pl-mix', trackIds: ['a', 'b', 'concurrent'] })

  const replayed = replayPlaylistRecord(base, local, current)
  assert.deepEqual(replayed.trackIds, ['b', 'a', 'concurrent'])
})

test('portable path normalization normalizes separators and drive-letter casing', () => {
  assert.equal(normalizePortableLibraryPath('C:/Music//Song.flac'), 'c:\\music\\song.flac')
  assert.equal(
    normalizePortableLibraryPath('//Server/Share/File.flac'),
    '\\Server\\Share\\File.flac'
  )
  assert.equal(
    normalizePortableLibraryPath('relative/Music/Song.flac'),
    'relative\\Music\\Song.flac'
  )
})

test('local library track guards require complete local track fields', () => {
  const local = makeTrack({ id: 'local:one' })
  const remote = makeTrack({ id: 'ncm:one', source: 'ncm', fileName: 'remote.flac' })
  assert.equal(isLocalLibraryTrack(local), true)
  assert.equal(isLocalLibraryTrack(remote), false)
  assert.equal(isLocalLibraryTrack({ ...local, filePath: '' }), false)
  assert.equal(isLocalLibraryTrack(null), false)
  assert.equal(isLocalLibraryTrack([]), false)
})

test('playlistDataEqual treats undefined-valued keys as absent with JSON semantics', () => {
  assert.ok(playlistDataEqual({ id: 'a', cover: undefined }, { id: 'a' }))
  assert.ok(!playlistDataEqual({ id: 'a' }, { id: 'a', cover: 'x' }))
  assert.ok(playlistDataEqual(['a', 'b'], ['a', 'b']))
  assert.ok(!playlistDataEqual(['a', 'b'], ['b', 'a']))
  assert.ok(
    playlistDataEqual({ nested: { list: [1, { x: 'y' }] } }, { nested: { list: [1, { x: 'y' }] } })
  )
})

test('clonePlaylist produces independent plain copies of nested data', () => {
  const source = { name: 'p', trackIds: ['a'], trackSnapshots: { a: { id: 'a', title: 't' } } }
  const copy = clonePlaylist(source)
  assert.deepEqual(copy, source)
  assert.notEqual(copy, source)
  assert.notEqual(copy.trackSnapshots, source.trackSnapshots)
})
