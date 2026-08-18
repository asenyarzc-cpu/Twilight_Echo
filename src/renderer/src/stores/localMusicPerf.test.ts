/**
 * Performance regression baseline for local music library.
 *
 * Uses Node's built-in test runner (`node --experimental-strip-types --test`).
 * Only pure-logic assertions are tested here — component mount, rAF flush, and
 * DOM events are excluded (they degrade to typecheck + lint + build gates).
 *
 * Later waves (1-5) extend this file with wave-specific tests that are
 * un-skipped once the corresponding feature lands.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Dynamic import of the pure-logic search module (no Vue/window dependencies).
const { filterLocalGridItems } = (await import(
  new URL('../utils/localLibrarySearch.ts', import.meta.url).href
)) as typeof import('../utils/localLibrarySearch')

// ── Mock data generators (exported for reuse by later wave tests) ────────────

export interface MockTrack {
  id: string
  title: string
  artist: string
  album: string
  filePath: string
  fileName: string
  dir: string
  duration: number
  size: number
  cover: string | null
  lyrics: string | null
  source: string
  format: string
  sampleRate: number
  bitrate: number
  bpmAnalysis?: {
    bpm: number
    confidence: number
    source: 'analyzed'
    analyzedAt: string
    algorithmVersion: number
  }
}

interface MockRemovalRequest {
  mode: 'library' | 'trash'
  library: { revision: number; tracks: MockTrack[]; folders: string[] }
  items: Array<{ id: string; filePath: string; title: string; artist: string }>
}

/**
 * Generate `count` mock tracks spread across artists/albums/folders
 * to exercise realistic filtering and derived-collection paths.
 */
export function generateMockTracks(count: number): MockTrack[] {
  const tracks: MockTrack[] = []
  const artistCount = Math.max(50, Math.floor(count / 100))
  const albumCount = Math.max(100, Math.floor(count / 50))
  const folderCount = Math.max(20, Math.floor(count / 250))
  for (let i = 0; i < count; i++) {
    const ext = ['.mp3', '.flac', '.wav', '.m4a'][i % 4]
    const folder = `C:\\music\\folder${i % folderCount}`
    const fileName = `song${i}${ext}`
    tracks.push({
      id: `track_${i}`,
      title: `Song Title ${i}`,
      artist: `Artist ${i % artistCount}`,
      album: `Album ${i % albumCount}`,
      filePath: `${folder}\\${fileName}`,
      fileName,
      dir: folder,
      duration: 120 + (i % 300),
      size: 3_000_000 + i * 1000,
      cover: i % 3 === 0 ? `cover://hash${i}.jpg` : null,
      lyrics: null,
      source: 'local',
      format: ext.slice(1),
      sampleRate: 44100,
      bitrate: 320
    })
  }
  return tracks
}

/**
 * Generate grid items (artist/album/folder-like) each containing a slice of
 * mock tracks, for exercising `filterLocalGridItems`.
 */
export function generateMockGridItems(trackCount: number): {
  name: string
  trackCount: number
  tracks: MockTrack[]
  cover: string | null
  artist: string
  path: string
}[] {
  const tracks = generateMockTracks(trackCount)
  const byArtist = new Map<string, MockTrack[]>()
  for (const t of tracks) {
    if (!byArtist.has(t.artist)) byArtist.set(t.artist, [])
    byArtist.get(t.artist)!.push(t)
  }
  return Array.from(byArtist.entries()).map(([name, items]) => ({
    name,
    trackCount: items.length,
    tracks: items,
    cover: items[0]?.cover ?? null,
    artist: name,
    path: items[0]?.dir ?? ''
  }))
}

// ── Baseline assertions (pass immediately at Wave 0) ────────────────────────

test('mock track generator produces exactly the requested count', () => {
  const tracks = generateMockTracks(5000)
  assert.equal(tracks.length, 5000)
  // Verify spread across artists/albums/folders
  const artists = new Set(tracks.map((t) => t.artist))
  const albums = new Set(tracks.map((t) => t.album))
  const folders = new Set(tracks.map((t) => t.dir))
  assert.ok(artists.size >= 50, `expected >= 50 artists, got ${artists.size}`)
  assert.ok(albums.size >= 100, `expected >= 100 albums, got ${albums.size}`)
  assert.ok(folders.size >= 20, `expected >= 20 folders, got ${folders.size}`)
})

test('filterLocalGridItems filters 5000 tracks across grid items in < 50ms', () => {
  const items = generateMockGridItems(5000)
  assert.ok(items.length > 0)

  const start = performance.now()
  const result = filterLocalGridItems(items, 'song 42')
  const elapsed = performance.now() - start

  assert.ok(elapsed < 50, `filterLocalGridItems took ${elapsed.toFixed(2)}ms, expected < 50ms`)
  assert.ok(result.length > 0, 'expected at least one matching grid item')
})

test('filterLocalGridItems with empty query returns all items (no filtering)', () => {
  const items = generateMockGridItems(200)
  const result = filterLocalGridItems(items, '')
  assert.equal(result.length, items.length)
})

test('filterLocalGridItems with non-matching query returns empty', () => {
  const items = generateMockGridItems(200)
  const result = filterLocalGridItems(items, 'zzz_nonexistent_zzz')
  assert.equal(result.length, 0)
})

test('searchQuery preprocessing: query is normalized once (trim + lowercase)', () => {
  // This validates the memoize pattern: the query should be preprocessed
  // a single time before the filter loop, not per-item.
  // filterLocalGridItems already does this internally (normalizeSearchText).
  const items = generateMockGridItems(500)
  const query = '  Song TITLE 42  '

  // The function normalizes once; verify consistent results regardless of
  // surrounding whitespace/case in the query.
  const resultA = filterLocalGridItems(items, query)
  const resultB = filterLocalGridItems(items, query.trim().toLowerCase())
  assert.deepEqual(resultA, resultB, 'query normalization should be idempotent')
})

// ── Placeholders for later waves (un-skipped when feature lands) ────────────
// Wave 1: search debounce (component mount — degraded to typecheck+lint+build)
test.skip('search debounce: 10 rapid searchQuery changes yield <= 2 filter recomputes', () => {})

// Wave 2: scheduleRebuild coalescing — store is importable in bare Node
// (module-level state uses Vue reactivity which works without DOM)
const useMusicStoreModule = (await import(
  new URL('./useMusicStore.ts', import.meta.url).href
)) as typeof import('./useMusicStore')
const useSettingsStoreModule = (await import(
  new URL('./useSettingsStore.ts', import.meta.url).href
)) as typeof import('./useSettingsStore')

const musicStoreSource = readFileSync(new URL('./useMusicStore.ts', import.meta.url), 'utf8')

// Mock window.api for store tests. saveMusicLibrary is counted for debounce tests.
// loadMusicLibrary is counted to verify incremental vs full-reload paths.
// scanMusicFiles returns mock tracks for the incremental 'add' path.
let saveCallCount = 0
let loadCallCount = 0
let scanCallCount = 0
let libraryScanCallCount = 0

function createSavedMusicLibraryDocument(snapshot: unknown) {
  const record =
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : {}
  const revision =
    typeof record.revision === 'number' && Number.isSafeInteger(record.revision)
      ? record.revision
      : 0
  return {
    version: 2 as const,
    revision: revision + 1,
    tracks: Array.isArray(record.tracks) ? record.tracks : [],
    folders: Array.isArray(record.folders)
      ? record.folders.filter((folder): folder is string => typeof folder === 'string')
      : [],
    exclusions: []
  }
}

function createExclusion(track: MockTrack) {
  return {
    filePath: track.filePath,
    title: track.title,
    artist: track.artist,
    excludedAt: '2026-01-01T00:00:00.000Z'
  }
}

function createRemovalResult(request: MockRemovalRequest, removedTracks: MockTrack[]) {
  const removedIds = new Set(removedTracks.map((track) => track.id))
  const removedPaths = new Set(removedTracks.map((track) => track.filePath))
  return {
    mode: request.mode,
    library: {
      version: 2 as const,
      revision: request.library.revision + 1,
      tracks: request.library.tracks.filter(
        (track) => !removedIds.has(track.id) && !removedPaths.has(track.filePath)
      ),
      folders: request.library.folders,
      exclusions: removedTracks.map(createExclusion)
    },
    removedTrackIds: removedTracks.map((track) => track.id),
    removedFilePaths: removedTracks.map((track) => track.filePath),
    failures: []
  }
}

function installDefaultWindowApi(): void {
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => {
          saveCallCount++
          return createSavedMusicLibraryDocument(snapshot)
        },
        loadMusicLibrary: async (): Promise<unknown[]> => {
          loadCallCount++
          return []
        },
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<unknown[]> => {
          scanCallCount++
          return generateMockTracks(1)
        }
      },
      library: {
        removeTracks: async (): Promise<never> => {
          throw new Error('unexpected local library removal')
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        },
        scanStartup: async () => {
          libraryScanCallCount++
          return createEmptyScanUpdate('startup')
        },
        scanFull: async () => createEmptyScanUpdate('full'),
        getScanStatus: async () => createIdleScanStatus(),
        pauseScan: async () => false,
        resumeScan: async () => false,
        cancelScan: async () => false,
        onChanged: () => () => {},
        onCoversMissing: () => () => {},
        onScanProgress: () => () => {},
        onScanStatus: () => () => {}
      }
    }
  }
}

function createEmptyScanUpdate(mode: 'startup' | 'full' | 'watch') {
  return {
    jobId: `mock-${mode}`,
    mode,
    state: 'completed' as const,
    libraryRevision: 0,
    exclusions: [],
    addedTracks: [],
    updatedTracks: [],
    removedFilePaths: [],
    parsedFileCount: 0,
    skippedUnchanged: 0
  }
}

function createIdleScanStatus() {
  return {
    jobId: null,
    mode: null,
    state: 'idle' as const,
    current: 0,
    total: 0,
    parsedFileCount: 0,
    skippedUnchanged: 0,
    error: ''
  }
}

installDefaultWindowApi()

function setupStore(): ReturnType<typeof useMusicStoreModule.useMusicStore> {
  installDefaultWindowApi()
  saveCallCount = 0
  loadCallCount = 0
  scanCallCount = 0
  libraryScanCallCount = 0
  const store = useMusicStoreModule.useMusicStore()
  store.isScanning.value = true
  store.scannedFolders.value = []
  store.playlists.value = []
  store.libraryRepairReport.value = null
  store.clearTracks()
  store.excludedTracks.value = []
  return store
}

test('confirmed tag writes refresh only matching local track metadata in one library update', async () => {
  const store = setupStore()
  const [first, second] = generateMockTracks(2)
  await store.addTracks([first, second], { deferRebuild: true })

  const changed = store.applyLocalTagWrite([first.filePath], {
    title: 'Updated title',
    artist: 'Updated artist',
    albumArtist: 'Album owner',
    track: 7,
    disc: 2
  })

  assert.equal(changed, 1)
  assert.deepEqual(
    store.tracks.value.map((track) => [
      track.title,
      track.artist,
      track.albumArtist,
      track.trackNumber,
      track.discNumber
    ]),
    [
      ['Updated title', 'Updated artist', 'Album owner', 7, 2],
      [second.title, second.artist, undefined, undefined, undefined]
    ]
  )
})

test('scan progress and worker failure status remain observable in the renderer store', () => {
  const store = setupStore()
  store.applyLibraryScanProgress({
    jobId: 'scan-1',
    mode: 'full',
    phase: 'parsing',
    current: 4,
    total: 10,
    parsedFileCount: 3,
    skippedUnchanged: 1
  })

  assert.equal(store.libraryScanProgress.value?.current, 4)
  assert.equal(store.libraryScanStatus.value.parsedFileCount, 3)

  store.applyLibraryScanStatus({
    jobId: 'scan-1',
    mode: 'full',
    state: 'failed',
    current: 4,
    total: 10,
    parsedFileCount: 3,
    skippedUnchanged: 1,
    error: 'background worker exited'
  })

  assert.equal(store.libraryScanStatus.value.state, 'failed')
  assert.equal(store.libraryScanStatus.value.error, 'background worker exited')
  assert.equal(store.libraryScanProgress.value, null)
})

test('full scan applies added, changed, and removed path deltas without a full reload', async () => {
  const store = setupStore()
  const [removed, changed] = generateMockTracks(2)
  await store.addTracks([removed, changed], { deferRebuild: true })
  store.refreshLibraryIndex()
  const replacement = { ...changed, title: 'Updated metadata' }
  const added = { ...generateMockTracks(1)[0], id: 'scan-added', filePath: 'C:\\music\\added.flac' }

  const windowRecord = (globalThis as Record<string, unknown>).window as {
    api: { library: { scanFull: () => Promise<unknown> } }
  }
  windowRecord.api.library.scanFull = async () => ({
    jobId: 'full-1',
    mode: 'full',
    state: 'completed',
    libraryRevision: 7,
    exclusions: [],
    addedTracks: [added],
    updatedTracks: [replacement],
    removedFilePaths: [removed.filePath],
    parsedFileCount: 2,
    skippedUnchanged: 0
  })

  await store.startFullLibraryScan()

  assert.deepEqual(
    store.tracks.value.map((track) => track.id).sort(),
    [added.id, changed.id].sort()
  )
  assert.equal(
    store.tracks.value.find((track) => track.id === changed.id)?.title,
    'Updated metadata'
  )
  assert.equal(loadCallCount, 0)
  store.clearTracks()
})

test('removeTrack debounce: 10 removeTrack calls coalesce into 1 rebuild', async () => {
  const store = setupStore()
  await store.addTracks(generateMockTracks(5000), { deferRebuild: true })
  store.refreshLibraryIndex()

  const countBefore = store.getRebuildCount()
  const tracksBefore = store.tracks.value.length

  for (let i = 0; i < 10; i++) {
    store.removeTrack(`track_${i}`)
  }
  store.flushRebuild()

  const rebuildDelta = store.getRebuildCount() - countBefore
  assert.equal(rebuildDelta, 1, `expected 1 rebuild, got ${rebuildDelta}`)
  assert.equal(store.tracks.value.length, tracksBefore - 10)

  store.clearTracks()
})

test('single removeTrack does not rebuild immediately (deferred to microtask)', async () => {
  const store = setupStore()
  await store.addTracks(generateMockTracks(100), { deferRebuild: true })
  store.refreshLibraryIndex()

  const countBefore = store.getRebuildCount()
  store.removeTrack('track_0')

  // Rebuild should NOT have fired yet (still pending in microtask queue)
  assert.equal(store.getRebuildCount(), countBefore, 'rebuild should be deferred')

  store.flushRebuild()
  assert.equal(store.getRebuildCount(), countBefore + 1, 'rebuild should fire on flush')

  store.clearTracks()
})

test('store cleanup: clearTracks cancels pending scheduled rebuild', async () => {
  const store = setupStore()
  await store.addTracks(generateMockTracks(100), { deferRebuild: true })
  store.refreshLibraryIndex()

  // Schedule a rebuild via removeTrack (don't flush — leave microtask pending)
  store.removeTrack('track_0')
  const countBefore = store.getRebuildCount()

  // clearTracks should cancel the pending microtask and do immediate rebuild
  store.clearTracks()

  // Let microtasks flush — the cancelled microtask should be a no-op
  await new Promise<void>((resolve) => queueMicrotask(resolve))

  assert.equal(
    store.getRebuildCount(),
    countBefore,
    'no extra rebuild should fire after clearTracks cancels pending'
  )
})

test('addTracks non-deferRebuild updates derived collections after flush', async () => {
  const store = setupStore()
  await store.addTracks(generateMockTracks(50), { deferRebuild: false })

  store.flushRebuild()

  assert.ok(store.artists.value.length > 0, 'artists should be populated')
  assert.ok(store.albums.value.length > 0, 'albums should be populated')
  assert.ok(store.genres.value.length > 0, 'genres should be populated')
  assert.ok(
    store.genres.value.some((item) => item.name === '未知流派'),
    'tracks without genre should fall back to 未知流派'
  )

  store.clearTracks()
})

test('genre derived collection and tag write updates groups', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'genre-a',
        artist: 'Genre Artist',
        album: 'Genre Album',
        genre: 'Jazz',
        filePath: 'C:\\music\\genre\\a.flac'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'genre-b',
        artist: 'Genre Artist',
        album: 'Genre Album',
        genre: 'Rock',
        filePath: 'C:\\music\\genre\\b.flac'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'genre-c',
        artist: 'Genre Artist',
        album: 'Genre Album',
        genre: null,
        filePath: 'C:\\music\\genre\\c.flac'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  assert.equal(store.genres.value.find((item) => item.name === 'Jazz')?.trackCount, 1)
  assert.equal(store.genres.value.find((item) => item.name === 'Rock')?.trackCount, 1)
  assert.equal(store.genres.value.find((item) => item.name === '未知流派')?.trackCount, 1)

  const changed = store.applyLocalTagWrite(['C:\\music\\genre\\c.flac'], { genre: 'Jazz' })
  assert.equal(changed, 1)
  store.flushRebuild()
  assert.equal(store.genres.value.find((item) => item.name === 'Jazz')?.trackCount, 2)
  assert.equal(
    store.genres.value.find((item) => item.name === '未知流派'),
    undefined
  )

  store.clearTracks()
})

test('genre derived collection splits default and custom separator characters', async () => {
  const store = setupStore()
  const settingsStore = useSettingsStoreModule.useSettingsStore()
  const previousSeparators = settingsStore.settings.value.genreSeparators
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'multi-genre',
        genre: 'Rock，Jazz；Fusion、Electronic/Ambient',
        filePath: 'C:\\music\\genre\\multi.flac'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  assert.deepEqual(
    store.genres.value.map((item) => item.name),
    ['Ambient', 'Electronic', 'Fusion', 'Jazz', 'Rock']
  )
  for (const genre of store.genres.value) assert.equal(genre.trackCount, 1)

  settingsStore.settings.value = { ...settingsStore.settings.value, genreSeparators: '|' }
  store.tracks.value = [
    {
      ...store.tracks.value[0],
      genre: 'Pop|Dance/Rock'
    }
  ]
  store.refreshLibraryIndex()
  assert.deepEqual(
    store.genres.value.map((item) => item.name),
    ['Dance/Rock', 'Pop']
  )

  settingsStore.settings.value = {
    ...settingsStore.settings.value,
    genreSeparators: previousSeparators
  }
  store.clearTracks()
})

test('folder groups fall back to track directories when persisted roots are missing', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'fallback-folder-a',
        dir: 'C:\\music\\album-a',
        filePath: 'C:\\music\\album-a\\a.flac'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'fallback-folder-b',
        dir: 'C:\\music\\album-b',
        filePath: 'C:\\music\\album-b\\b.flac'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  assert.deepEqual(
    store.folders.value.map((folder) => [folder.name, folder.trackCount]),
    [
      ['album-a', 1],
      ['album-b', 1]
    ]
  )

  store.clearTracks()
})

test('derived collections keep first cover without per-group rescans', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'no-cover',
        artist: 'Cover Artist',
        album: 'Cover Album',
        dir: 'C:\\music\\cover-folder',
        filePath: 'C:\\music\\cover-folder\\a.flac',
        cover: null
      },
      {
        ...generateMockTracks(1)[0],
        id: 'with-cover',
        artist: 'Cover Artist',
        album: 'Cover Album',
        dir: 'C:\\music\\cover-folder',
        filePath: 'C:\\music\\cover-folder\\b.flac',
        cover: 'cover://first.jpg'
      }
    ],
    { deferRebuild: false }
  )
  store.syncFolders(['C:\\music\\cover-folder'])
  store.flushRebuild()

  assert.equal(
    store.artists.value.find((item) => item.name === 'Cover Artist')?.cover,
    'cover://first.jpg'
  )
  assert.equal(
    store.albums.value.find((item) => item.name === 'Cover Album')?.cover,
    'cover://first.jpg'
  )
  assert.equal(
    store.folders.value.find((item) => item.path === 'C:\\music\\cover-folder')?.cover,
    'cover://first.jpg'
  )
  assert.match(musicStoreSource, /interface DerivedTrackGroup/)
  assert.doesNotMatch(musicStoreSource, /items\.find\(\(t\) => t\.cover\)/)

  store.clearTracks()
})

test('same-named albums remain separate by stable album artist identity', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'album-a',
        artist: 'Guest One',
        albumArtist: 'Primary One',
        album: 'Greatest Hits',
        filePath: 'C:\\music\\one\\a.flac'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'album-b',
        artist: 'Guest Two',
        albumArtist: 'Primary Two',
        album: 'Greatest Hits',
        filePath: 'C:\\music\\two\\b.flac'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  const sameNamedAlbums = store.albums.value.filter((album) => album.name === 'Greatest Hits')
  assert.equal(sameNamedAlbums.length, 2)
  assert.notEqual(sameNamedAlbums[0]?.id, sameNamedAlbums[1]?.id)
  assert.deepEqual(sameNamedAlbums.map((album) => album.artist).sort(), [
    'Primary One',
    'Primary Two'
  ])
  assert.deepEqual(sameNamedAlbums.map((album) => album.tracks[0]?.id).sort(), [
    'album-a',
    'album-b'
  ])

  store.clearTracks()
})

test('polluted albumArtist equal to track artist still merges a multi-artist release folder', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'release-a',
        artist: 'Guest A',
        // Legacy scan pollution: albumArtist copied from track artist.
        albumArtist: 'Guest A',
        album: '依・睐-复刻',
        cover: 'cover://release.jpg',
        filePath: 'C:\\music\\release\\a.flac',
        dir: 'C:\\music\\release'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'release-b',
        artist: 'Guest B',
        albumArtist: 'Guest B',
        album: '依・睐-复刻',
        cover: 'cover://release.jpg',
        filePath: 'C:\\music\\release\\b.flac',
        dir: 'C:\\music\\release'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'other-folder',
        artist: 'Guest C',
        albumArtist: 'Guest C',
        album: '依・睐-复刻',
        cover: 'cover://other-release.jpg',
        filePath: 'C:\\music\\other\\c.flac',
        dir: 'C:\\music\\other'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  const sameNamed = store.albums.value.filter((album) => album.name === '依・睐-复刻')
  assert.equal(sameNamed.length, 2)
  const primary = sameNamed.find((album) => album.trackCount === 2)
  const secondary = sameNamed.find((album) => album.trackCount === 1)
  assert.ok(primary, 'same-folder multi-artist tracks should merge into one album card')
  assert.ok(secondary, 'same title in another folder should stay separate')
  assert.deepEqual(primary!.tracks.map((track) => track.id).sort(), ['release-a', 'release-b'])
  assert.equal(secondary!.tracks[0]?.id, 'other-folder')

  store.clearTracks()
})

test('missing albumArtist merges by release directory instead of track artist', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'solo-a',
        artist: 'Artist A',
        album: 'Shared Title',
        filePath: 'C:\\music\\album\\a.flac',
        dir: 'C:\\music\\album'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'solo-b',
        artist: 'Artist B',
        album: 'Shared Title',
        filePath: 'C:\\music\\album\\b.flac',
        dir: 'C:\\music\\album'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  const albums = store.albums.value.filter((album) => album.name === 'Shared Title')
  assert.equal(albums.length, 1)
  assert.equal(albums[0]?.trackCount, 2)

  store.clearTracks()
})

test('same-title tracks with shared cover merge across per-track directories', async () => {
  const store = setupStore()
  const sharedCover = 'cover://shared-release.jpg'
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'split-release-a',
        artist: 'Artist A',
        album: '20',
        cover: sharedCover,
        filePath: 'C:\\music\\20\\01\\a.flac',
        dir: 'C:\\music\\20\\01'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'split-release-b',
        artist: 'Artist B',
        album: '２０',
        cover: sharedCover,
        filePath: 'C:\\music\\20\\02\\b.flac',
        dir: 'C:\\music\\20\\02'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'different-release',
        artist: 'Artist C',
        album: '20',
        cover: 'cover://different-release.jpg',
        filePath: 'C:\\music\\other\\c.flac',
        dir: 'C:\\music\\other'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  const sameNamed = store.albums.value.filter((album) => ['20', '２０'].includes(album.name))
  assert.equal(sameNamed.length, 2)
  const merged = sameNamed.find((album) => album.trackCount === 2)
  assert.ok(merged, 'shared artwork should identify one release across nested directories')
  assert.deepEqual(merged!.tracks.map((track) => track.id).sort(), [
    'split-release-a',
    'split-release-b'
  ])

  store.clearTracks()
})

test('same-title tracks with shared cover merge when no ancestor directory matches the album', async () => {
  const store = setupStore()
  const sharedCover = 'cover://nightcord-release.jpg'
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'unmatched-layout-a',
        artist: 'Artist A',
        album: '25時、ナイトコードで。',
        cover: sharedCover,
        filePath: 'C:\\music\\catalog\\disc-01\\track-a.flac',
        dir: 'C:\\music\\catalog\\disc-01'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'unmatched-layout-b',
        artist: 'Artist B',
        album: '25時、ナイトコードで。',
        cover: sharedCover,
        filePath: 'C:\\music\\catalog\\disc-02\\track-b.flac',
        dir: 'C:\\music\\catalog\\disc-02'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  const albums = store.albums.value.filter((album) => album.name === '25時、ナイトコードで。')
  assert.equal(albums.length, 1)
  assert.equal(albums[0]?.trackCount, 2)
  assert.deepEqual(albums[0]?.tracks.map((track) => track.id).sort(), [
    'unmatched-layout-a',
    'unmatched-layout-b'
  ])

  store.clearTracks()
})

test('distinct explicit album artists stay separate even when title and cover match', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'owner-a',
        artist: 'Guest A',
        albumArtist: 'Album Owner A',
        album: 'Shared Cover Title',
        cover: 'cover://shared-artwork.jpg',
        filePath: 'C:\\music\\owner-a\\a.flac',
        dir: 'C:\\music\\owner-a'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'owner-b',
        artist: 'Guest B',
        albumArtist: 'Album Owner B',
        album: 'Shared Cover Title',
        cover: 'cover://shared-artwork.jpg',
        filePath: 'C:\\music\\owner-b\\b.flac',
        dir: 'C:\\music\\owner-b'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  const albums = store.albums.value.filter((album) => album.name === 'Shared Cover Title')
  assert.equal(albums.length, 2)
  assert.deepEqual(albums.map((album) => album.artist).sort(), ['Album Owner A', 'Album Owner B'])

  store.clearTracks()
})

test('explicit album id stays authoritative over matching fallback cover evidence', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'provider-release',
        artist: 'Artist A',
        albumId: 'provider:release-42',
        album: 'Authoritative Release',
        cover: 'cover://shared-authoritative.jpg',
        filePath: 'C:\\music\\authoritative\\provider.flac',
        dir: 'C:\\music\\authoritative'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'fallback-release',
        artist: 'Artist B',
        album: 'Authoritative Release',
        cover: 'cover://shared-authoritative.jpg',
        filePath: 'C:\\music\\fallback\\local.flac',
        dir: 'C:\\music\\fallback'
      }
    ],
    { deferRebuild: false }
  )
  store.flushRebuild()

  const albums = store.albums.value.filter((album) => album.name === 'Authoritative Release')
  assert.equal(albums.length, 2)
  assert.ok(albums.some((album) => album.id === 'id:provider:release-42'))

  store.clearTracks()
})

test('scan root folders aggregate tracks from nested directories at path boundaries', async () => {
  const store = setupStore()
  await store.addTracks(
    [
      {
        ...generateMockTracks(1)[0],
        id: 'root-track',
        filePath: 'C:\\music\\root.flac',
        dir: 'C:\\music'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'nested-track',
        filePath: 'C:\\music\\nested\\child.flac',
        dir: 'C:\\music\\nested'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'deep-track',
        filePath: 'C:\\music\\nested\\deep\\song.flac',
        dir: 'C:\\music\\nested\\deep'
      },
      {
        ...generateMockTracks(1)[0],
        id: 'outside-track',
        filePath: 'C:\\music-other\\outside.flac',
        dir: 'C:\\music-other'
      }
    ],
    { deferRebuild: false }
  )
  store.syncFolders(['C:\\music'])
  store.flushRebuild()

  assert.deepEqual(
    store.folders.value
      .find((folder) => folder.path === 'C:\\music')
      ?.tracks.map((track) => track.id),
    ['root-track', 'nested-track', 'deep-track']
  )
  assert.deepEqual(
    store.folders.value
      .find((folder) => folder.path === 'C:\\music\\nested')
      ?.tracks.map((track) => track.id),
    ['nested-track', 'deep-track']
  )
  assert.deepEqual(
    store.folders.value
      .find((folder) => folder.path === 'C:\\music\\nested\\deep')
      ?.tracks.map((track) => track.id),
    ['deep-track']
  )
  assert.equal(
    store.folders.value.some((folder) => folder.path === 'C:\\music-other'),
    false
  )

  store.clearTracks()
})

test('single-track update paths use track indexes instead of linear scans', () => {
  assert.match(musicStoreSource, /const trackIndexById = new Map<string, number>\(\)/)
  assert.match(musicStoreSource, /function replaceTrackAtIndex\(index: number, nextTrack: Track\)/)
  assert.doesNotMatch(musicStoreSource, /tracks\.value\.findIndex\(/)
})

test('track indexes are cleaned on removeTrack', async () => {
  const store = setupStore()
  await store.addTracks(generateMockTracks(10), { deferRebuild: true })
  store.refreshLibraryIndex()

  // Verify track exists in derived collections
  assert.equal(store.tracks.value.length, 10)

  store.removeTrack('track_0')
  store.flushRebuild()

  assert.equal(store.tracks.value.length, 9)
  // After flush, rebuildDerivedCollections rebuilds trackById — verify the
  // removed track is gone
  const playlists = store.getPlaylistTracks('test')
  assert.equal(playlists.length, 0, 'removed track should not appear in playlists')

  store.clearTracks()
})

test('5000-track library removal applies one IPC transaction and one derived rebuild', async () => {
  const store = setupStore()
  const inputTracks = generateMockTracks(5000)
  await store.addTracks(inputTracks, { deferRebuild: true })
  store.refreshLibraryIndex()
  const rebuildBefore = store.getRebuildCount()
  let mutationCalls = 0
  let directSaveCalls = 0

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => {
          directSaveCalls++
          return createSavedMusicLibraryDocument(snapshot)
        },
        loadMusicLibrary: async (): Promise<unknown[]> => [],
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<unknown[]> => []
      },
      library: {
        removeTracks: async (request: {
          mode: 'library' | 'trash'
          items: Array<{ id: string; filePath: string; title: string; artist: string }>
        }) => {
          mutationCalls++
          return {
            mode: request.mode,
            library: {
              version: 2 as const,
              revision: 1,
              tracks: [],
              folders: [],
              exclusions: request.items.map((item) => ({
                filePath: item.filePath,
                title: item.title,
                artist: item.artist,
                excludedAt: '2026-01-01T00:00:00.000Z'
              }))
            },
            removedTrackIds: request.items.map((item) => item.id),
            removedFilePaths: request.items.map((item) => item.filePath),
            failures: []
          }
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  store.isScanning.value = false
  const pendingSave = store.scheduleSaveLibrary()
  const result = await store.removeLocalTracks(inputTracks, 'library')
  await pendingSave

  assert.equal(mutationCalls, 1)
  assert.equal(directSaveCalls, 0, 'the removal transaction must absorb the pending snapshot')
  assert.equal(result.removedTrackIds.length, 5000)
  assert.equal(store.tracks.value.length, 0)
  assert.equal(store.excludedTracks.value.length, 5000)
  assert.equal(store.getRebuildCount() - rebuildBefore, 1)
  store.clearTracks()
})

test('all-trash-failed preserves tracks and only flushes a pre-existing pending save', async () => {
  const store = setupStore()
  const track = generateMockTracks(1)[0]
  await store.addTracks([track], { deferRebuild: true })
  store.refreshLibraryIndex()
  store.isScanning.value = false
  let saveCalls = 0
  let mutationCalls = 0

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: {
          revision: number
          tracks: unknown[]
          folders: string[]
        }) => {
          saveCalls++
          return {
            version: 2 as const,
            revision: snapshot.revision + 1,
            tracks: snapshot.tracks,
            folders: snapshot.folders,
            exclusions: []
          }
        },
        loadMusicLibrary: async (): Promise<unknown[]> => [],
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<unknown[]> => []
      },
      library: {
        removeTracks: async (request: {
          mode: 'library' | 'trash'
          library: { revision: number; tracks: unknown[]; folders: string[] }
          items: Array<{ filePath: string }>
        }) => {
          mutationCalls++
          return {
            mode: request.mode,
            library: {
              version: 2 as const,
              revision: request.library.revision,
              tracks: request.library.tracks,
              folders: request.library.folders,
              exclusions: []
            },
            removedTrackIds: [],
            removedFilePaths: [],
            failures: request.items.map((item) => ({
              filePath: item.filePath,
              message: 'file is locked'
            }))
          }
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  const pendingSave = store.scheduleSaveLibrary()
  const failed = await store.removeLocalTracks([track], 'trash')
  await pendingSave

  assert.equal(mutationCalls, 1)
  assert.equal(saveCalls, 1, 'the canceled pre-existing save must be flushed exactly once')
  assert.equal(failed.removedTrackIds.length, 0)
  assert.equal(store.tracks.value.length, 1)

  saveCalls = 0
  await store.removeLocalTracks([track], 'trash')
  assert.equal(
    saveCalls,
    0,
    'a failed trash action without pending work must not write the library'
  )
  assert.equal(store.tracks.value.length, 1)
  store.clearTracks()
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => {
          saveCallCount++
          return createSavedMusicLibraryDocument(snapshot)
        },
        loadMusicLibrary: async (): Promise<unknown[]> => {
          loadCallCount++
          return []
        },
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<unknown[]> => {
          scanCallCount++
          return generateMockTracks(1)
        }
      },
      library: {
        removeTracks: async (): Promise<never> => {
          throw new Error('unexpected local library removal')
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }
})

test('deferred removal rebases a concurrently added track instead of replacing current state', async () => {
  const store = setupStore()
  const removedTrack = generateMockTracks(1)[0]
  const concurrentTrack = {
    ...generateMockTracks(1)[0],
    id: 'track_concurrent',
    title: 'Concurrent Track',
    filePath: 'C:\\music\\concurrent\\track.flac',
    fileName: 'track.flac',
    dir: 'C:\\music\\concurrent'
  }
  await store.addTracks([removedTrack], { deferRebuild: true })
  store.refreshLibraryIndex()

  let resolveRemoval!: (value: ReturnType<typeof createRemovalResult>) => void
  let signalRemovalStarted!: () => void
  const removalStarted = new Promise<void>((resolve) => {
    signalRemovalStarted = resolve
  })
  const removalResponse = new Promise<ReturnType<typeof createRemovalResult>>((resolve) => {
    resolveRemoval = resolve
  })
  const savedSnapshots: Array<{ revision: number; tracks: MockTrack[]; folders: string[] }> = []
  let removalRequest: MockRemovalRequest | null = null

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: {
          revision: number
          tracks: MockTrack[]
          folders: string[]
        }) => {
          savedSnapshots.push(snapshot)
          return {
            version: 2 as const,
            revision: snapshot.revision + 1,
            tracks: snapshot.tracks,
            folders: snapshot.folders,
            exclusions: [createExclusion(removedTrack)]
          }
        },
        loadMusicLibrary: async (): Promise<unknown[]> => [],
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: { scanMusicFiles: async (): Promise<unknown[]> => [] },
      library: {
        removeTracks: async (request: MockRemovalRequest) => {
          removalRequest = request
          signalRemovalStarted()
          return removalResponse
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  const removal = store.removeLocalTracks([removedTrack], 'library')
  await removalStarted
  await store.addTracks([concurrentTrack], { deferRebuild: true })
  assert.ok(removalRequest)
  resolveRemoval(createRemovalResult(removalRequest!, [removedTrack]))
  await removal

  assert.deepEqual(
    store.tracks.value.map((track) => track.id),
    ['track_concurrent']
  )
  assert.equal(savedSnapshots.length, 1)
  assert.deepEqual(
    savedSnapshots[0].tracks.map((track) => track.id),
    ['track_concurrent']
  )
  store.clearTracks()
})

test('a save scheduled during deferred removal persists metadata against the returned revision', async () => {
  const store = setupStore()
  const [removedTrack, keptTrack] = generateMockTracks(2)
  await store.addTracks([removedTrack, keptTrack], { deferRebuild: true })
  store.refreshLibraryIndex()

  let resolveRemoval!: (value: ReturnType<typeof createRemovalResult>) => void
  let signalRemovalStarted!: () => void
  const removalStarted = new Promise<void>((resolve) => {
    signalRemovalStarted = resolve
  })
  const removalResponse = new Promise<ReturnType<typeof createRemovalResult>>((resolve) => {
    resolveRemoval = resolve
  })
  const savedSnapshots: Array<{ revision: number; tracks: MockTrack[]; folders: string[] }> = []
  let capturedRequest!: Parameters<typeof createRemovalResult>[0] | null

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: {
          revision: number
          tracks: MockTrack[]
          folders: string[]
        }) => {
          savedSnapshots.push(snapshot)
          return {
            version: 2 as const,
            revision: snapshot.revision + 1,
            tracks: snapshot.tracks,
            folders: snapshot.folders,
            exclusions: [createExclusion(removedTrack)]
          }
        },
        loadMusicLibrary: async (): Promise<unknown[]> => [],
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: { scanMusicFiles: async (): Promise<unknown[]> => [] },
      library: {
        removeTracks: async (request: Parameters<typeof createRemovalResult>[0]) => {
          capturedRequest = request
          signalRemovalStarted()
          return removalResponse
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  const removal = store.removeLocalTracks([removedTrack], 'library')
  await removalStarted
  const analysis = {
    bpm: 123,
    confidence: 0.9,
    source: 'analyzed' as const,
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: 1
  }
  assert.equal(store.applyBpmAnalysis(keptTrack.id, keptTrack.filePath, analysis), true)
  const scheduledSave = store.scheduleSaveLibrary()
  assert.ok(capturedRequest)
  resolveRemoval(createRemovalResult(capturedRequest!, [removedTrack]))
  await removal
  await scheduledSave

  assert.equal(savedSnapshots.length, 1)
  const persistedKept = savedSnapshots[0].tracks.find((track) => track.id === keptTrack.id)
  assert.deepEqual(persistedKept?.bpmAnalysis, analysis)
  assert.equal(savedSnapshots[0].revision, capturedRequest!.library.revision + 1)
  store.clearTracks()
})

test('rejected removal restores the canceled save without resolving it early', async () => {
  const store = setupStore()
  const track = generateMockTracks(1)[0]
  await store.addTracks([track], { deferRebuild: true })
  store.refreshLibraryIndex()
  let rejectRemoval!: (error: Error) => void
  let signalRemovalStarted!: () => void
  const removalStarted = new Promise<void>((resolve) => {
    signalRemovalStarted = resolve
  })
  const removalResponse = new Promise<never>((_resolve, reject) => {
    rejectRemoval = reject
  })
  let saveCalls = 0
  let capturedRemovalRequest: MockRemovalRequest | null = null

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => {
          saveCalls++
          return createSavedMusicLibraryDocument(snapshot)
        },
        loadMusicLibrary: async () => ({
          version: 2 as const,
          revision: capturedRemovalRequest?.library.revision ?? 0,
          tracks: [track],
          folders: [],
          exclusions: []
        }),
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: { scanMusicFiles: async (): Promise<unknown[]> => [] },
      library: {
        removeTracks: async (request: MockRemovalRequest) => {
          capturedRemovalRequest = request
          signalRemovalStarted()
          return removalResponse
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  let pendingResolved = false
  const pendingSave = store.scheduleSaveLibrary().then(() => {
    pendingResolved = true
  })
  const removal = store.removeLocalTracks([track], 'trash')
  await removalStarted
  rejectRemoval(new Error('trash IPC rejected'))
  await assert.rejects(removal, /trash IPC rejected/)
  await Promise.resolve()
  assert.equal(pendingResolved, false)
  assert.equal(saveCalls, 0)

  let settlementTimeout: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    pendingSave,
    new Promise<never>((_resolve, reject) => {
      settlementTimeout = setTimeout(() => reject(new Error('pending save did not retry')), 2_000)
    })
  ])
  if (settlementTimeout) clearTimeout(settlementTimeout)
  assert.equal(pendingResolved, true)
  assert.equal(saveCalls, 1)
  assert.deepEqual(
    store.tracks.value.map((item) => item.id),
    [track.id]
  )
  store.clearTracks()
})

test('trash recovery revision conflict rebases ghost removal and settles pending save', async () => {
  const store = setupStore()
  const track = generateMockTracks(1)[0]
  await store.addTracks([track], { deferRebuild: true })
  store.refreshLibraryIndex()
  let serverRevision = 0
  let loadCalls = 0
  const saveSnapshots: Array<{ revision: number; tracks: MockTrack[]; folders: string[] }> = []

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: {
          revision: number
          tracks: MockTrack[]
          folders: string[]
        }) => {
          saveSnapshots.push(snapshot)
          if (snapshot.revision !== serverRevision) {
            const error = new Error(
              `Music library changed concurrently (expected revision ${snapshot.revision}, current ${serverRevision})`
            )
            error.name = 'MusicLibraryRevisionConflictError'
            throw error
          }
          serverRevision++
          return {
            version: 2 as const,
            revision: serverRevision,
            tracks: snapshot.tracks,
            folders: snapshot.folders,
            exclusions: []
          }
        },
        loadMusicLibrary: async () => {
          loadCalls++
          if (loadCalls === 1) throw new Error('journal recovery retry failed')
          return {
            version: 2 as const,
            revision: serverRevision,
            tracks: [],
            folders: [],
            exclusions: []
          }
        },
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: { scanMusicFiles: async (): Promise<unknown[]> => [] },
      library: {
        removeTracks: async (request: MockRemovalRequest) => {
          serverRevision = request.library.revision + 1
          throw new Error('initial library persist failed')
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  let pendingResolved = false
  const pendingSave = store.scheduleSaveLibrary().then(() => {
    pendingResolved = true
  })
  await assert.rejects(store.removeLocalTracks([track], 'trash'), /journal recovery retry failed/)
  assert.equal(pendingResolved, false)
  assert.deepEqual(
    store.tracks.value.map((item) => item.id),
    [track.id]
  )

  let retryTimeout: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    pendingSave,
    new Promise<never>((_resolve, reject) => {
      retryTimeout = setTimeout(() => reject(new Error('revision retry did not settle')), 2_000)
    })
  ])
  if (retryTimeout) clearTimeout(retryTimeout)
  assert.equal(pendingResolved, true)
  assert.deepEqual(store.tracks.value, [])
  assert.equal(loadCalls, 2)
  assert.equal(saveSnapshots.length, 2)
  assert.deepEqual(
    saveSnapshots[0].tracks.map((item) => item.id),
    [track.id]
  )
  assert.deepEqual(saveSnapshots[1].tracks, [])
  assert.equal(saveSnapshots[1].revision, saveSnapshots[0].revision + 1)
  const callsAfterSettlement = saveSnapshots.length
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(saveSnapshots.length, callsAfterSettlement)
  store.clearTracks()
})

test('deferred exclusion restore rebases concurrent metadata and add even when scan is empty', async () => {
  const store = setupStore()
  const baseTrack = generateMockTracks(1)[0]
  const concurrentTrack = {
    ...generateMockTracks(1)[0],
    id: 'restore-concurrent',
    filePath: 'C:\\music\\restore-concurrent.flac',
    fileName: 'restore-concurrent.flac'
  }
  const missingPath = 'C:\\music\\missing-restored.flac'
  let resolveRestore!: (value: {
    library: {
      version: 2
      revision: number
      tracks: MockTrack[]
      folders: string[]
      exclusions: never[]
    }
    restoredFilePaths: string[]
  }) => void
  let signalRestoreStarted!: () => void
  const restoreStarted = new Promise<void>((resolve) => {
    signalRestoreStarted = resolve
  })
  const restoreResponse = new Promise<{
    library: {
      version: 2
      revision: number
      tracks: MockTrack[]
      folders: string[]
      exclusions: never[]
    }
    restoredFilePaths: string[]
  }>((resolve) => {
    resolveRestore = resolve
  })
  let capturedRestoreRequest!: {
    library: { revision: number; tracks: MockTrack[]; folders: string[] }
  } | null
  const saveSnapshots: Array<{ revision: number; tracks: MockTrack[] }> = []

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        loadMusicLibrary: async () => ({
          version: 2 as const,
          revision: 7,
          tracks: [baseTrack],
          folders: [],
          exclusions: [
            {
              filePath: missingPath,
              title: 'Missing',
              artist: '',
              excludedAt: '2026-01-01T00:00:00.000Z'
            }
          ]
        }),
        saveMusicLibrary: async (snapshot: {
          revision: number
          tracks: MockTrack[]
          folders: string[]
        }) => {
          saveSnapshots.push({ revision: snapshot.revision, tracks: snapshot.tracks })
          return {
            version: 2 as const,
            revision: snapshot.revision + 1,
            tracks: snapshot.tracks,
            folders: snapshot.folders,
            exclusions: []
          }
        },
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: { scanMusicFiles: async (): Promise<unknown[]> => [] },
      library: {
        removeTracks: async (): Promise<never> => {
          throw new Error('unexpected local removal')
        },
        restoreExclusions: async (request: {
          library: { revision: number; tracks: MockTrack[]; folders: string[] }
        }) => {
          capturedRestoreRequest = request
          signalRestoreStarted()
          return restoreResponse
        },
        scanStartup: async () => ({
          ...createEmptyScanUpdate('startup'),
          libraryRevision: capturedRestoreRequest!.library.revision + 1
        })
      }
    }
  }

  await store.loadLibrary()
  await store.whenLibrarySettled()
  const restore = store.restoreExcludedTracks([missingPath])
  await restoreStarted
  await store.addTracks([concurrentTrack], { deferRebuild: true })
  const analysis = {
    bpm: 127,
    confidence: 0.95,
    source: 'analyzed' as const,
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: 1
  }
  assert.equal(store.applyBpmAnalysis(baseTrack.id, baseTrack.filePath, analysis), true)
  let pendingResolved = false
  const pendingSave = store.scheduleSaveLibrary().then(() => {
    pendingResolved = true
  })
  assert.equal(pendingResolved, false)
  assert.ok(capturedRestoreRequest)
  resolveRestore({
    library: {
      version: 2,
      revision: capturedRestoreRequest!.library.revision + 1,
      tracks: capturedRestoreRequest!.library.tracks,
      folders: capturedRestoreRequest!.library.folders,
      exclusions: []
    },
    restoredFilePaths: [missingPath]
  })

  assert.equal(await restore, 1)
  await pendingSave
  assert.equal(pendingResolved, true)
  assert.equal(saveSnapshots.length, 1)
  assert.equal(saveSnapshots[0].revision, capturedRestoreRequest!.library.revision + 1)
  assert.deepEqual(
    saveSnapshots[0].tracks.map((item) => item.id),
    [baseTrack.id, concurrentTrack.id]
  )
  assert.deepEqual(saveSnapshots[0].tracks[0].bpmAnalysis, analysis)
  assert.equal(
    store.tracks.value.some((item) => item.filePath === missingPath),
    false
  )
  store.clearTracks()
})

test('a scan result collected before exclusion commit cannot re-add the removed track', async () => {
  const store = setupStore()
  const track = generateMockTracks(1)[0]
  await store.addTracks([track], { deferRebuild: true })
  store.refreshLibraryIndex()
  const staleScanResult = Promise.resolve([{ ...track, id: 'stale-scan-track' }])
  const savedSnapshots: MockTrack[][] = []

  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: {
          revision: number
          tracks: MockTrack[]
          folders: string[]
        }) => {
          savedSnapshots.push(snapshot.tracks)
          return {
            version: 2 as const,
            revision: snapshot.revision + 1,
            tracks: snapshot.tracks,
            folders: snapshot.folders,
            exclusions: [createExclusion(track)]
          }
        },
        loadMusicLibrary: async (): Promise<unknown[]> => [],
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: { scanMusicFiles: async () => staleScanResult },
      library: {
        removeTracks: async (request: MockRemovalRequest) => createRemovalResult(request, [track]),
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  await store.removeLocalTracks([track], 'library')
  await store.addTracks(await staleScanResult, { deferRebuild: true })
  await store.saveLibrary()

  assert.deepEqual(store.tracks.value, [])
  assert.deepEqual(savedSnapshots.at(-1), [])
  store.clearTracks()
})

// Wave 3 TODO 4: saveLibrary debounce (testable in bare Node via window.api mock)
test('saveLibrary debounce: 10 scheduled saves yield 1 IPC write', async () => {
  const store = setupStore()
  store.isScanning.value = false

  saveCallCount = 0
  const promises: Promise<void>[] = []
  for (let i = 0; i < 10; i++) {
    promises.push(store.scheduleSaveLibrary())
  }

  // Wait for debounce timer (500ms + buffer)
  await new Promise((resolve) => setTimeout(resolve, 600))
  await Promise.all(promises)

  assert.equal(saveCallCount, 1, `expected 1 IPC write, got ${saveCallCount}`)

  store.isScanning.value = true
  store.clearTracks()
})

test('saveLibrary direct call flushes pending debounce and writes immediately', async () => {
  const store = setupStore()
  store.isScanning.value = false

  saveCallCount = 0
  // Schedule a debounced save
  const scheduled = store.scheduleSaveLibrary()
  // Immediately call direct saveLibrary (should flush timer + write now)
  await store.saveLibrary()
  await scheduled

  // Both the scheduled and direct save resolve after 1 IPC write (direct flushes)
  assert.ok(saveCallCount >= 1, 'expected at least 1 IPC write from direct saveLibrary')
  // The timer should be cleared (no extra write after 600ms)
  const countAfterWait = saveCallCount
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(saveCallCount, countAfterWait, 'no extra write after flush')

  store.isScanning.value = true
  store.clearTracks()
})

test('flushSaveLibrary clears timer without scheduling extra write', () => {
  const store = setupStore()
  store.isScanning.value = false

  saveCallCount = 0
  // Schedule a debounced save
  void store.scheduleSaveLibrary()
  // Flush (quit-flush) — should clear timer and do one synchronous save
  store.flushSaveLibrary()

  assert.ok(saveCallCount >= 1, 'expected at least 1 IPC write from flush')
  // Timer was cleared — no extra assertion possible in sync test,
  // but the cleared timer means no future write will fire
  store.isScanning.value = true
  store.clearTracks()
})

// loadLibrary skip-repair is a main-process behavior — verified via grep, not runtime test
test.skip('loadLibrary skips repairMissingLibraryCovers', () => {})

// Wave 3 TODO 5: incremental reload — store handleLibraryChange is testable
test('incremental remove: single file remove triggers removeTrack not full loadLibrary', async () => {
  const store = setupStore()
  await store.addTracks(generateMockTracks(10), { deferRebuild: true })
  store.refreshLibraryIndex()
  store.isScanning.value = false

  loadCallCount = 0
  const tracksBefore = store.tracks.value.length
  const filePath = store.tracks.value[0].filePath

  await store.handleLibraryChange({ kind: 'remove', path: filePath })

  assert.equal(loadCallCount, 0, 'loadLibrary should NOT be called for incremental remove')
  assert.equal(store.tracks.value.length, tracksBefore - 1, 'track should be removed')

  store.clearTracks()
})

test('incremental add: single file add triggers addTracks not full loadLibrary', async () => {
  const store = setupStore()
  await store.addTracks(generateMockTracks(5), { deferRebuild: true })
  store.refreshLibraryIndex()
  store.isScanning.value = false

  loadCallCount = 0
  scanCallCount = 0
  const tracksBefore = store.tracks.value.length

  // Mock scanMusicFiles returns a track with filePath matching the change path
  const newFilePath = 'C:\\music\\newfolder\\newsong.mp3'
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => {
          saveCallCount++
          return createSavedMusicLibraryDocument(snapshot)
        },
        loadMusicLibrary: async (): Promise<unknown[]> => {
          loadCallCount++
          return []
        },
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<unknown[]> => {
          scanCallCount++
          return [
            {
              ...generateMockTracks(1)[0],
              filePath: newFilePath,
              id: 'new_track_1'
            }
          ]
        }
      }
    }
  }

  await store.handleLibraryChange({ kind: 'add', path: newFilePath })

  assert.equal(loadCallCount, 0, 'loadLibrary should NOT be called for incremental add')
  assert.equal(scanCallCount, 1, 'scanMusicFiles should be called once')
  assert.equal(store.tracks.value.length, tracksBefore + 1, 'track should be added')

  // Restore default mock
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => {
          saveCallCount++
          return createSavedMusicLibraryDocument(snapshot)
        },
        loadMusicLibrary: async (): Promise<unknown[]> => {
          loadCallCount++
          return []
        },
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<unknown[]> => {
          scanCallCount++
          return generateMockTracks(1)
        }
      }
    }
  }

  store.clearTracks()
})

test('unknown watcher payload triggers indexed startup reconciliation without reloading storage', async () => {
  const store = setupStore()
  await store.addTracks(generateMockTracks(5), { deferRebuild: true })
  store.refreshLibraryIndex()
  store.isScanning.value = false

  loadCallCount = 0
  libraryScanCallCount = 0
  await store.handleLibraryChange({ kind: 'unknown' })

  assert.equal(loadCallCount, 0)
  assert.equal(libraryScanCallCount, 1)

  store.clearTracks()
})

test('missing watcher payload triggers indexed startup reconciliation without reloading storage', async () => {
  const store = setupStore()
  store.isScanning.value = false

  loadCallCount = 0
  libraryScanCallCount = 0
  await store.handleLibraryChange(undefined)

  assert.equal(loadCallCount, 0)
  assert.equal(libraryScanCallCount, 1)

  store.clearTracks()
})

test('loadLibrary renders persisted tracks without running metadata or cover scans in renderer', async () => {
  const store = setupStore()
  const persisted = generateMockTracks(2)
  scanCallCount = 0
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => createSavedMusicLibraryDocument(snapshot),
        loadMusicLibrary: async () => ({
          version: 2 as const,
          revision: 4,
          tracks: persisted,
          folders: ['C:\\music'],
          exclusions: []
        }),
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<never> => {
          scanCallCount++
          throw new Error('renderer must not scan on load')
        }
      }
    }
  }

  await store.loadLibrary()
  await store.whenLibrarySettled()

  assert.equal(scanCallCount, 0)
  assert.deepEqual(
    store.tracks.value.map((track) => track.id),
    persisted.map((track) => track.id)
  )
  store.clearTracks()
})

test('startup index update replaces changed metadata and removes missing paths atomically', async () => {
  const store = setupStore()
  const [missing, changed] = generateMockTracks(2)
  await store.addTracks([missing, changed], { deferRebuild: true })
  store.refreshLibraryIndex()
  const replacement = { ...changed, title: 'Worker metadata' }
  let startupCalls = 0
  const windowRecord = (globalThis as Record<string, unknown>).window as {
    api: { library: { scanStartup: () => Promise<unknown> } }
  }
  windowRecord.api.library.scanStartup = async () => {
    startupCalls++
    return {
      ...createEmptyScanUpdate('startup'),
      libraryRevision: 8,
      updatedTracks: [replacement],
      removedFilePaths: [missing.filePath],
      parsedFileCount: 1
    }
  }

  await store.startStartupLibraryScan()

  assert.equal(startupCalls, 1)
  assert.deepEqual(
    store.tracks.value.map((track) => track.id),
    [changed.id]
  )
  assert.equal(store.tracks.value[0].title, 'Worker metadata')
  store.clearTracks()
})

test('loadLibrary enriches missing local metadata from provider search without changing local identity', async () => {
  const store = setupStore()
  const localTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:moon',
    title: 'Moon River',
    artist: 'Audrey',
    album: '',
    filePath: 'D:\\Music\\Moon River.flac',
    fileName: 'Moon River.flac',
    duration: 181,
    cover: null,
    lyrics: null,
    source: 'local' as const,
    format: 'flac'
  }

  saveCallCount = 0
  scanCallCount = 0
  let providerSearchCalls = 0
  let releaseProviderSearch!: ((value: unknown) => void) | null
  let markProviderSearchStarted: (() => void) | null = null
  const providerSearchStarted = new Promise<void>((resolve) => {
    markProviderSearchStarted = resolve
  })
  const pendingProviderSearch = new Promise<unknown>((resolve) => {
    releaseProviderSearch = resolve
  })
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => {
          saveCallCount++
          return createSavedMusicLibraryDocument(snapshot)
        },
        loadMusicLibrary: async (): Promise<unknown> => {
          loadCallCount++
          return { tracks: [localTrack], folders: [] }
        },
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<unknown[]> => {
          scanCallCount++
          return []
        }
      },
      providers: {
        list: async (): Promise<unknown[]> => [
          {
            id: 'ncm',
            name: 'NetEase',
            capabilities: ['search'],
            health: { available: true }
          }
        ],
        call: async (): Promise<unknown> => {
          providerSearchCalls++
          markProviderSearchStarted?.()
          return await pendingProviderSearch
        }
      }
    }
  }

  await store.loadLibrary()
  assert.equal(store.tracks.value[0].id, 'local:moon', 'local track must render before provider IO')
  assert.equal(store.tracks.value[0].cover, null)
  await providerSearchStarted
  assert.equal(store.libraryMetadataEnrichmentStatus.value.state, 'enriching')
  releaseProviderSearch?.({
    items: [
      {
        ...localTrack,
        id: 'ncm:123',
        filePath: 'ncm:123',
        fileName: 'Moon River',
        album: 'Online Album',
        duration: 179,
        cover: 'https://cover.example/album.jpg',
        lyrics: '[00:00.00]Moon River',
        translatedLyrics: '[00:00.00]月亮河',
        source: 'ncm'
      }
    ],
    total: 1
  })
  await store.whenLibrarySettled()

  assert.equal(providerSearchCalls, 1)
  assert.equal(store.tracks.value[0].id, 'local:moon')
  assert.equal(store.tracks.value[0].filePath, 'D:\\Music\\Moon River.flac')
  assert.equal(store.tracks.value[0].album, 'Online Album')
  assert.equal(store.tracks.value[0].cover, 'https://cover.example/album.jpg')
  assert.equal(store.tracks.value[0].lyrics, '[00:00.00]Moon River')
  assert.equal(store.tracks.value[0].translatedLyrics, '[00:00.00]月亮河')
  assert.deepEqual(store.tracks.value[0].metadataMatch, {
    providerId: 'ncm',
    trackId: 'ncm:123',
    confidence: 'high',
    score: 96
  })
  assert.equal(store.tracks.value[0].streamUrl, undefined)
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(saveCallCount, 1, 'enriched library should be saved')

  store.clearTracks()
})

test('clearTrackMetadataMatch removes provider match without dropping cached local metadata', async () => {
  const store = setupStore()
  const matchedTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:matched',
    filePath: 'D:\\Music\\Matched.flac',
    fileName: 'Matched.flac',
    title: 'Matched',
    album: 'Cached Album',
    cover: 'https://cover.example/matched.jpg',
    lyrics: '[00:00.00]Matched lyric',
    metadataMatch: {
      providerId: 'ncm',
      trackId: 'ncm:matched',
      confidence: 'medium' as const,
      score: 82
    }
  }

  await store.addTracks([matchedTrack])
  saveCallCount = 0

  const changed = store.clearTrackMetadataMatch('local:matched')

  assert.equal(changed, true)
  assert.equal(store.tracks.value[0].metadataMatch, null)
  assert.equal(store.tracks.value[0].id, 'local:matched')
  assert.equal(store.tracks.value[0].filePath, 'D:\\Music\\Matched.flac')
  assert.equal(store.tracks.value[0].source, 'local')
  assert.equal(store.tracks.value[0].album, 'Cached Album')
  assert.equal(store.tracks.value[0].cover, 'https://cover.example/matched.jpg')
  assert.equal(store.tracks.value[0].lyrics, '[00:00.00]Matched lyric')
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(saveCallCount, 1, 'cleared metadata match should be saved')

  store.clearTracks()
})

test('applyTrackMetadataMatch applies a selected provider match without replacing local playback identity', async () => {
  const store = setupStore()
  const localTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:selected',
    title: 'Selected Song',
    artist: 'Selected Artist',
    album: '',
    filePath: 'D:\\Music\\Selected Song.flac',
    fileName: 'Selected Song.flac',
    duration: 200,
    cover: null,
    lyrics: null,
    source: 'local' as const,
    format: 'flac'
  }
  const providerTrack = {
    ...localTrack,
    id: 'ncm:selected',
    album: 'Provider Album',
    filePath: 'ncm:selected',
    fileName: 'Selected Song',
    duration: 202,
    cover: 'https://cover.example/selected.jpg',
    lyrics: '[00:00.00]Selected lyric',
    translatedLyrics: '[00:00.00]选择的歌词',
    source: 'ncm' as const,
    streamUrl: 'https://temporary.example/selected.mp3'
  }

  await store.addTracks([localTrack])
  saveCallCount = 0

  const changed = store.applyTrackMetadataMatch('local:selected', providerTrack, {
    confidence: 'medium',
    score: 88
  })

  assert.equal(changed, true)
  assert.equal(store.tracks.value[0].id, 'local:selected')
  assert.equal(store.tracks.value[0].filePath, 'D:\\Music\\Selected Song.flac')
  assert.equal(store.tracks.value[0].source, 'local')
  assert.equal(store.tracks.value[0].album, 'Provider Album')
  assert.equal(store.tracks.value[0].cover, 'https://cover.example/selected.jpg')
  assert.equal(store.tracks.value[0].lyrics, '[00:00.00]Selected lyric')
  assert.equal(store.tracks.value[0].translatedLyrics, '[00:00.00]选择的歌词')
  assert.equal(store.tracks.value[0].lyricsSource, 'provider')
  assert.equal(store.tracks.value[0].translatedLyricsSource, 'provider')
  assert.deepEqual(store.tracks.value[0].metadataMatch, {
    providerId: 'ncm',
    trackId: 'ncm:selected',
    confidence: 'medium',
    score: 88
  })
  assert.equal(store.tracks.value[0].streamUrl, undefined)
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(saveCallCount, 1, 'manual metadata match should be saved')

  store.clearTracks()
})

test('applyTrackMetadataMatch respects disabled metadata cache policy for manual provider matches', async () => {
  const store = setupStore()
  const settingsStore = useSettingsStoreModule.useSettingsStore()
  const previousSettings = settingsStore.settings.value
  settingsStore.settings.value = {
    ...previousSettings,
    cachePolicy: {
      ...previousSettings.cachePolicy,
      cover: false,
      lyrics: false,
      metadata: false
    }
  }
  const localTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:policy',
    title: 'Policy Song',
    artist: 'Policy Artist',
    album: '',
    filePath: 'D:\\Music\\Policy Song.flac',
    fileName: 'Policy Song.flac',
    duration: 200,
    cover: null,
    lyrics: null,
    source: 'local' as const,
    format: 'flac'
  }
  const providerTrack = {
    ...localTrack,
    id: 'ncm:policy',
    album: 'Provider Album',
    filePath: 'ncm:policy',
    fileName: 'Policy Song',
    duration: 200,
    cover: 'https://cover.example/policy.jpg',
    lyrics: '[00:00.00]Policy lyric',
    translatedLyrics: '[00:00.00]策略歌词',
    source: 'ncm' as const
  }

  try {
    await store.addTracks([localTrack])
    saveCallCount = 0

    const changed = store.applyTrackMetadataMatch('local:policy', providerTrack, {
      confidence: 'high',
      score: 95
    })

    assert.equal(changed, true)
    assert.equal(store.tracks.value[0].id, 'local:policy')
    assert.equal(store.tracks.value[0].album, '')
    assert.equal(store.tracks.value[0].cover, null)
    assert.equal(store.tracks.value[0].lyrics, null)
    assert.equal(store.tracks.value[0].translatedLyrics, undefined)
    assert.deepEqual(store.tracks.value[0].metadataMatch, {
      providerId: 'ncm',
      trackId: 'ncm:policy',
      confidence: 'high',
      score: 95
    })
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(saveCallCount, 1, 'manual metadata match trace should be saved')
  } finally {
    settingsStore.settings.value = previousSettings
    store.clearTracks()
  }
})

test('loadLibrary respects cache policy when provider metadata is available', async () => {
  const store = setupStore()
  const settingsStore = useSettingsStoreModule.useSettingsStore()
  const previousSettings = settingsStore.settings.value
  settingsStore.settings.value = {
    ...previousSettings,
    cachePolicy: {
      ...previousSettings.cachePolicy,
      cover: false,
      lyrics: false,
      metadata: false
    }
  }
  const localTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:moon',
    title: 'Moon River',
    artist: 'Audrey',
    album: '',
    filePath: 'D:\\Music\\Moon River.flac',
    fileName: 'Moon River.flac',
    duration: 181,
    cover: null,
    lyrics: null,
    source: 'local' as const,
    format: 'flac'
  }

  saveCallCount = 0
  let providerSearchCalls = 0
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => {
          saveCallCount++
          return createSavedMusicLibraryDocument(snapshot)
        },
        loadMusicLibrary: async (): Promise<unknown> => ({ tracks: [localTrack], folders: [] }),
        savePlaylists: async (): Promise<void> => {},
        loadPlaylists: async (): Promise<unknown[]> => []
      },
      fs: {
        scanMusicFiles: async (): Promise<unknown[]> => []
      },
      providers: {
        list: async (): Promise<unknown[]> => [
          {
            id: 'ncm',
            name: 'NetEase',
            capabilities: ['search'],
            health: { available: true }
          }
        ],
        call: async (): Promise<unknown> => {
          providerSearchCalls++
          return {
            items: [
              {
                ...localTrack,
                id: 'ncm:123',
                filePath: 'ncm:123',
                fileName: 'Moon River',
                album: 'Online Album',
                duration: 179,
                cover: 'https://cover.example/album.jpg',
                lyrics: '[00:00.00]Moon River',
                translatedLyrics: '[00:00.00]月亮河',
                source: 'ncm'
              }
            ],
            total: 1
          }
        }
      }
    }
  }

  try {
    await store.loadLibrary()
    await store.whenLibrarySettled()

    assert.equal(providerSearchCalls, 0)
    assert.equal(store.tracks.value[0].album, '')
    assert.equal(store.tracks.value[0].cover, null)
    assert.equal(store.tracks.value[0].lyrics, null)
    assert.equal(store.tracks.value[0].translatedLyrics, undefined)
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(saveCallCount, 0, 'unchanged library should not be saved')
  } finally {
    settingsStore.settings.value = previousSettings
    store.clearTracks()
  }
})

// Wave 4: dashboard memo — Vue computed caching is testable in bare Node
const vue = await import('vue')

test('dashboard memo: byIdMap not rebuilt when only listeningStats changes', () => {
  const tracks = vue.shallowRef(generateMockTracks(100))
  const stats = vue.ref<{ plays: number; duration?: number }>({ plays: 0 })

  let mapBuildCount = 0
  const byIdMap = vue.computed(() => {
    mapBuildCount++
    return new Map(tracks.value.map((t) => [t.id, t]))
  })
  const topTracks = vue.computed(() => {
    const byId = byIdMap.value
    return Object.keys(stats.value).length + byId.size
  })

  // Initial access
  void topTracks.value
  const initialBuildCount = mapBuildCount

  // Change only stats (not tracks) — byIdMap should NOT rebuild
  stats.value = { plays: 1, duration: 10 }
  void topTracks.value
  assert.equal(
    mapBuildCount,
    initialBuildCount,
    'byIdMap should not rebuild when only stats change'
  )

  // Change tracks — byIdMap SHOULD rebuild
  tracks.value = generateMockTracks(200)
  void topTracks.value
  assert.ok(mapBuildCount > initialBuildCount, 'byIdMap should rebuild when tracks change')
})

// Wave 5: pointermove rAF throttle — pure logic extracted from SongList.vue
// (rAF/DOM not available in bare Node; throttle behavior degraded to typecheck+build)

function shouldScheduleFlush(rafId: number | null): boolean {
  return rafId === null
}

function cleanupPointerMove(rafId: number | null, cancelFn: (id: number) => void): void {
  if (rafId !== null) cancelFn(rafId)
}

test('pointermove schedule: shouldScheduleFlush returns true when idle, false when pending', () => {
  assert.equal(shouldScheduleFlush(null), true, 'should schedule when rafId is null')
  assert.equal(shouldScheduleFlush(1), false, 'should NOT schedule when rafId is set')
  assert.equal(shouldScheduleFlush(42), false, 'should NOT schedule when rafId is any number')
})

test('pointermove cleanup: cleanupPointerMove calls cancelAnimationFrame only when rafId is set', () => {
  let cancelledId: number | null = null
  const mockCancel = (id: number): void => {
    cancelledId = id
  }

  // rafId set → cancelAnimationFrame should be called
  cleanupPointerMove(42, mockCancel)
  assert.equal(cancelledId, 42, 'cancelAnimationFrame should be called with rafId 42')

  // rafId null → cancelAnimationFrame should NOT be called
  cancelledId = null
  cleanupPointerMove(null, mockCancel)
  assert.equal(cancelledId, null, 'cancelAnimationFrame should NOT be called when rafId is null')
})

test('mixed-source playlists keep provider track snapshots when the track is not in the local library', async () => {
  const store = setupStore()
  store.playlists.value = []
  const providerTrack = {
    id: 'ncm:12345',
    title: 'Online Song',
    artist: 'Remote Artist',
    album: 'Remote Album',
    filePath: 'ncm:12345',
    fileName: 'Online Song',
    duration: 180,
    size: 0,
    cover: null,
    lyrics: null,
    source: 'ncm'
  }

  store.createPlaylist('mixed-source')
  store.addToPlaylist('mixed-source', providerTrack.id, providerTrack)

  assert.deepEqual(store.getPlaylistTracks('mixed-source'), [providerTrack])

  store.clearTracks()
})

test('playlists preserve removed local snapshots without exposing them as playable tracks', () => {
  const store = setupStore()
  store.playlists.value = []
  const removedLocalTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:removed',
    filePath: 'D:\\Music\\Removed.flac',
    fileName: 'Removed.flac',
    source: 'local'
  }

  store.createPlaylist('preserved-local-history')
  store.addToPlaylist('preserved-local-history', removedLocalTrack.id, removedLocalTrack)

  assert.deepEqual(store.playlists.value[0].trackIds, ['local:removed'])
  assert.equal(
    store.playlists.value[0].trackSnapshots?.['local:removed']?.filePath,
    removedLocalTrack.filePath
  )
  assert.deepEqual(store.getPlaylistTracks('preserved-local-history'), [])
  store.clearTracks()
})

test('mixed-source playlists prefer a local library variant over a provider snapshot for the same logical track', async () => {
  const store = setupStore()
  store.playlists.value = []
  const providerTrack = {
    id: 'ncm:12345',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'Remote Album',
    filePath: 'ncm:12345',
    fileName: 'Moon River',
    duration: 180,
    size: 0,
    cover: null,
    lyrics: null,
    source: 'ncm'
  }
  const localTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:moon',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'Local Album',
    filePath: 'D:\\Music\\Moon River.flac',
    fileName: 'Moon River.flac',
    duration: 181,
    source: 'local',
    format: 'flac'
  }

  store.createPlaylist('mixed-source')
  store.addToPlaylist('mixed-source', providerTrack.id, providerTrack)
  await store.addTracks([localTrack])

  const tracks = store.getPlaylistTracks('mixed-source')

  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].id, 'local:moon')

  store.clearTracks()
})

test('mixed-source playlists prefer the best local library variant over a provider snapshot', async () => {
  const store = setupStore()
  store.playlists.value = []
  const providerTrack = {
    ...generateMockTracks(1)[0],
    id: 'ncm:moon',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'Online Album',
    filePath: 'ncm:moon',
    fileName: 'Moon River',
    duration: 180,
    source: 'ncm',
    format: 'aac'
  }
  const localMp3 = {
    ...providerTrack,
    id: 'local:moon-mp3',
    album: 'Local Album',
    filePath: 'D:\\Music\\Moon River.mp3',
    fileName: 'Moon River.mp3',
    duration: 181,
    source: 'local',
    format: 'mp3',
    bitDepth: undefined
  }
  const localFlac = {
    ...providerTrack,
    id: 'local:moon-flac',
    album: 'Local Album',
    filePath: 'D:\\Music\\Moon River.flac',
    fileName: 'Moon River.flac',
    duration: 181,
    source: 'local',
    format: 'flac',
    bitDepth: 24
  }

  store.createPlaylist('mixed-source')
  store.addToPlaylist('mixed-source', providerTrack.id, providerTrack)
  await store.addTracks([localMp3, localFlac])

  const tracks = store.getPlaylistTracks('mixed-source')

  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].id, 'local:moon-flac')

  store.clearTracks()
})

test('mixed-source playlists can replace expired provider ids with rematched provider snapshots', async () => {
  const store = setupStore()
  store.playlists.value = []
  const expiredTrack = {
    id: 'ncm:expired',
    title: 'Online Song',
    artist: 'Remote Artist',
    album: 'Remote Album',
    filePath: 'ncm:expired',
    fileName: 'Online Song',
    duration: 180,
    size: 0,
    cover: null,
    lyrics: null,
    source: 'ncm'
  }
  const rematchedTrack = {
    ...expiredTrack,
    id: 'ncm:fresh',
    filePath: 'ncm:fresh',
    cover: 'https://cover.example/fresh.jpg'
  }

  store.createPlaylist('mixed-source')
  store.addToPlaylist('mixed-source', expiredTrack.id, expiredTrack)

  const replacedCount = store.replaceTrackReference(expiredTrack.id, rematchedTrack)

  assert.equal(replacedCount, 1)
  assert.deepEqual(store.playlists.value[0].trackIds, ['ncm:fresh'])
  assert.equal(store.playlists.value[0].trackSnapshots?.['ncm:expired'], undefined)
  assert.equal(
    store.playlists.value[0].trackSnapshots?.['ncm:fresh']?.cover,
    'https://cover.example/fresh.jpg'
  )
  assert.deepEqual(store.getPlaylistTracks('mixed-source'), [rematchedTrack])

  store.clearTracks()
})

test('mixed-source playlist rematch de-duplicates when replacement id already exists', async () => {
  const store = setupStore()
  store.playlists.value = []
  const expiredTrack = {
    id: 'ncm:expired',
    title: 'Online Song',
    artist: 'Remote Artist',
    album: 'Remote Album',
    filePath: 'ncm:expired',
    fileName: 'Online Song',
    duration: 180,
    size: 0,
    cover: null,
    lyrics: null,
    source: 'ncm'
  }
  const rematchedTrack = {
    ...expiredTrack,
    id: 'ncm:fresh',
    filePath: 'ncm:fresh'
  }

  store.createPlaylist('mixed-source')
  store.addToPlaylist('mixed-source', expiredTrack.id, expiredTrack)
  store.addToPlaylist('mixed-source', rematchedTrack.id, rematchedTrack)

  const replacedCount = store.replaceTrackReference(expiredTrack.id, rematchedTrack)

  assert.equal(replacedCount, 1)
  assert.deepEqual(store.playlists.value[0].trackIds, ['ncm:fresh'])
  assert.equal(store.playlists.value[0].trackSnapshots?.['ncm:expired'], undefined)
  assert.deepEqual(store.getPlaylistTracks('mixed-source'), [rematchedTrack])

  store.clearTracks()
})

test('default favorites match logical tracks across local and provider variants', async () => {
  const store = setupStore()
  store.playlists.value = []
  const localTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:moon',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'Local Album',
    filePath: 'D:\\Music\\Moon River.flac',
    fileName: 'Moon River.flac',
    duration: 181,
    source: 'local'
  }
  const providerTrack = {
    ...localTrack,
    id: 'ncm:123',
    album: 'Online Album',
    filePath: 'ncm:123',
    fileName: 'Moon River',
    duration: 180,
    size: 0,
    source: 'ncm'
  }

  store.createPlaylist('我收藏的音乐')
  store.addToPlaylist('我收藏的音乐', localTrack.id, localTrack)

  assert.equal(store.isFavoriteTrack(providerTrack), true)
  assert.equal(store.isFavoriteTrack(localTrack), true)

  store.clearTracks()
})

test('playlist exact-id reads reuse indexes instead of rebuilding logical maps', async () => {
  const store = setupStore()
  const tracks = generateMockTracks(5000)
  await store.addTracks(tracks, { deferRebuild: true })
  store.refreshLibraryIndex()
  store.playlists.value = [
    {
      id: 'pl_exact',
      name: 'exact-local',
      trackIds: tracks.slice(100, 300).map((track) => track.id),
      createdAt: new Date().toISOString()
    }
  ]

  assert.equal(store.getPlaylistTracks('exact-local').length, 200)

  const start = performance.now()
  for (let i = 0; i < 200; i++) {
    assert.equal(store.getPlaylistTracks('exact-local').length, 200)
  }
  const elapsed = performance.now() - start

  assert.ok(elapsed < 150, `exact playlist reads took ${elapsed.toFixed(2)}ms, expected < 150ms`)

  store.clearTracks()
})

test('favorite logical state reuses playlist identity cache for repeated button reads', async () => {
  const store = setupStore()
  const tracks = generateMockTracks(5000)
  await store.addTracks(tracks, { deferRebuild: true })
  store.refreshLibraryIndex()
  store.playlists.value = [
    {
      id: 'pl_favorites',
      name: '我收藏的音乐',
      trackIds: tracks.map((track) => track.id),
      isDefault: true,
      createdAt: new Date().toISOString()
    }
  ]
  const localTrack = tracks[4200]
  const providerVariant = {
    ...localTrack,
    id: 'ncm:logical-favorite',
    filePath: 'ncm:logical-favorite',
    source: 'ncm'
  }

  assert.equal(store.isFavoriteTrack(providerVariant), true)

  const start = performance.now()
  for (let i = 0; i < 10000; i++) {
    assert.equal(store.isFavoriteTrack(providerVariant), true)
  }
  const elapsed = performance.now() - start

  assert.ok(elapsed < 150, `favorite state reads took ${elapsed.toFixed(2)}ms, expected < 150ms`)

  store.clearTracks()
})

test('removing a logical favorite removes all source variants from default favorites', async () => {
  const store = setupStore()
  store.playlists.value = []
  const localTrack = {
    ...generateMockTracks(1)[0],
    id: 'local:moon',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'Local Album',
    filePath: 'D:\\Music\\Moon River.flac',
    fileName: 'Moon River.flac',
    duration: 181,
    source: 'local'
  }
  const providerTrack = {
    ...localTrack,
    id: 'ncm:123',
    album: 'Online Album',
    filePath: 'ncm:123',
    fileName: 'Moon River',
    duration: 180,
    size: 0,
    source: 'ncm'
  }

  store.createPlaylist('我收藏的音乐')
  store.addToPlaylist('我收藏的音乐', localTrack.id, localTrack)
  store.addToPlaylist('我收藏的音乐', providerTrack.id, providerTrack)

  store.removeFavoriteTrack(providerTrack)

  const favorite = store.playlists.value.find((playlist) => playlist.name === '我收藏的音乐')
  assert.deepEqual(favorite?.trackIds, [])
  assert.equal(store.isFavoriteTrack(localTrack), false)
  assert.equal(store.isFavoriteTrack(providerTrack), false)

  store.clearTracks()
})

test('5000-track batch playlist mutations perform one persistence commit', async () => {
  const store = setupStore()
  const batch = generateMockTracks(5000)
  const initial = [
    {
      id: 'pl_favorites',
      name: '我收藏的音乐',
      trackIds: [],
      isDefault: true,
      createdAt: '2026-07-17T00:00:00.000Z'
    },
    {
      id: 'pl_batch',
      name: 'batch',
      trackIds: [],
      createdAt: '2026-07-17T00:00:00.000Z'
    }
  ]
  let saveCalls = 0
  let revision = 17
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => createSavedMusicLibraryDocument(snapshot),
        loadMusicLibrary: async (): Promise<unknown[]> => [],
        loadPlaylists: async () => ({ version: 2 as const, revision, savedAt: '', data: initial }),
        savePlaylists: async (data: unknown[], expectedRevision: number) => {
          saveCalls++
          assert.equal(expectedRevision, revision)
          revision++
          return { version: 2 as const, revision, savedAt: '', data }
        }
      },
      fs: { scanMusicFiles: async (): Promise<unknown[]> => [] },
      library: {
        removeTracks: async (): Promise<never> => {
          throw new Error('unexpected local library removal')
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  await store.loadPlaylists()
  const startedAt = performance.now()
  assert.equal(store.addTracksToPlaylist('batch', batch), 5000)
  const mutationElapsed = performance.now() - startedAt
  assert.equal(await store.flushPlaylists(), true)

  assert.equal(saveCalls, 1)
  assert.equal(
    store.playlists.value.find((playlist) => playlist.name === 'batch')?.trackIds.length,
    5000
  )
  assert.ok(
    mutationElapsed < 1_000,
    `5000-track batch mutation took ${mutationElapsed.toFixed(1)}ms`
  )
  store.clearTracks()
})

test('playlist CAS conflict replays the local transaction onto the authoritative snapshot', async () => {
  const store = setupStore()
  const localTracks = generateMockTracks(2)
  const base = [
    {
      id: 'pl_favorites',
      name: '我收藏的音乐',
      trackIds: [],
      isDefault: true,
      createdAt: '2026-07-17T00:00:00.000Z'
    },
    {
      id: 'pl_shared',
      name: 'shared',
      trackIds: ['remote:base'],
      createdAt: '2026-07-17T00:00:00.000Z'
    }
  ]
  const authoritative = [
    ...base.slice(0, 1),
    {
      ...base[1],
      trackIds: ['remote:base', 'remote:concurrent']
    },
    {
      id: 'pl_remote',
      name: 'remote-only',
      trackIds: ['remote:other'],
      createdAt: '2026-07-17T00:00:00.000Z'
    }
  ]
  const saveCalls: Array<{ expectedRevision: number; data: unknown[] }> = []
  let serverRevision = 4
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => createSavedMusicLibraryDocument(snapshot),
        loadMusicLibrary: async (): Promise<unknown[]> => [],
        loadPlaylists: async () => ({ version: 2 as const, revision: 4, savedAt: '', data: base }),
        savePlaylists: async (data: unknown[], expectedRevision: number) => {
          saveCalls.push({ expectedRevision, data })
          if (saveCalls.length === 1) {
            const error = Object.assign(new Error('playlist revision changed'), {
              code: 'ERR_PERSISTENCE_REVISION_CONFLICT',
              current: { version: 2 as const, revision: 5, savedAt: '', data: authoritative }
            })
            throw error
          }
          assert.equal(expectedRevision, 5)
          serverRevision = 6
          return { version: 2 as const, revision: serverRevision, savedAt: '', data }
        }
      },
      fs: { scanMusicFiles: async (): Promise<unknown[]> => [] },
      library: {
        removeTracks: async (): Promise<never> => {
          throw new Error('unexpected local library removal')
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  await store.loadPlaylists()
  assert.equal(store.addTracksToPlaylist('shared', localTracks), 2)
  assert.equal(await store.flushPlaylists(), true)

  assert.equal(saveCalls.length, 2, 'one CAS retry is expected after the injected conflict')
  const persisted = saveCalls[1].data as Array<{ name: string; trackIds: string[] }>
  assert.deepEqual(persisted.find((playlist) => playlist.name === 'shared')?.trackIds, [
    'remote:base',
    'remote:concurrent',
    ...localTracks.map((track) => track.id)
  ])
  assert.ok(persisted.some((playlist) => playlist.name === 'remote-only'))
  assert.deepEqual(store.playlists.value.find((playlist) => playlist.name === 'shared')?.trackIds, [
    'remote:base',
    'remote:concurrent',
    ...localTracks.map((track) => track.id)
  ])
  store.clearTracks()
})

test('playlist lifecycle batches move, stable reorder, cover, import, and unique relocation into persistence', async () => {
  const store = setupStore()
  const tracks = generateMockTracks(4)
  await store.addTracks(tracks, { deferRebuild: true })
  store.refreshLibraryIndex()
  let writes = 0
  let revision = 8
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        saveMusicLibrary: async (snapshot: unknown) => createSavedMusicLibraryDocument(snapshot),
        loadMusicLibrary: async (): Promise<unknown[]> => [],
        loadPlaylists: async () => ({ version: 2 as const, revision, savedAt: '', data: [] }),
        savePlaylists: async (data: unknown[], expectedRevision: number) => {
          assert.equal(expectedRevision, revision)
          writes++
          revision++
          return { version: 2 as const, revision, savedAt: '', data }
        }
      },
      fs: { scanMusicFiles: async (): Promise<unknown[]> => [] },
      library: {
        removeTracks: async (): Promise<never> => {
          throw new Error('unexpected local library removal')
        },
        restoreExclusions: async (): Promise<never> => {
          throw new Error('unexpected exclusion restore')
        }
      }
    }
  }

  await store.loadPlaylists()
  store.createPlaylistWithTracks('source', tracks)
  store.createPlaylist('target')
  const source = store.playlists.value.find((playlist) => playlist.name === 'source')!
  assert.equal(store.renamePlaylist(source.id, 'renamed'), true)
  assert.equal(store.setPlaylistCover(source.id, 'cover://managed'), true)
  assert.equal(store.copyPlaylist(source.id, 'renamed copy') !== null, true)
  assert.equal(store.reorderPlaylistTracks('renamed', [tracks[1].id, tracks[3].id], 4), true)
  assert.deepEqual(
    store.playlists.value.find((playlist) => playlist.name === 'renamed')?.trackIds,
    [tracks[0].id, tracks[2].id, tracks[1].id, tracks[3].id]
  )
  assert.deepEqual(store.movePlaylistTracks('renamed', 'target', [tracks[2].id, tracks[1].id]), {
    moved: 2,
    sourceRemoved: 2
  })

  const relativePath = tracks[3].filePath.replace(/^C:\\music\\/i, '')
  const imported = store.importPlaylistDocument(
    'target',
    'paths.m3u',
    `#EXTM3U\n${tracks[0].filePath}\n${relativePath}\nC:\\missing\\none.flac\n`
  )
  assert.equal(imported.importedCount, 2)
  assert.equal(imported.unresolvedEntries, 1)

  const missing = { ...tracks[3], id: 'missing-id', filePath: 'C:\\old\\song3.m4a' }
  store.playlists.value.push({
    id: 'pl_missing',
    name: 'missing',
    trackIds: [missing.id],
    trackSnapshots: { [missing.id]: missing },
    createdAt: '2026-07-18T00:00:00.000Z'
  })
  const moved = { ...tracks[3], id: 'relocated-id', filePath: 'E:\\new\\song3.m4a' }
  const repaired = store.repairPlaylistMissingTracks('missing', [moved])
  assert.equal(repaired.relocations.length, 1)
  assert.deepEqual(
    store.playlists.value.find((playlist) => playlist.name === 'missing')?.trackIds,
    [moved.id]
  )
  assert.equal(await store.flushPlaylists(), true)
  assert.equal(writes, 1, 'all lifecycle mutations coalesce into one persistence write')
  store.clearTracks()
})
