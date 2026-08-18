import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'

const { collectFilesAsync, filterParsedTracksAgainstExclusions } = (await import(
  new URL('./libraryFiles.ts', import.meta.url).href
)) as typeof import('./libraryFiles.ts')
const {
  assertMusicLibraryRevision,
  beginLibraryPathMutation,
  createMusicLibraryDocument,
  isActiveLibraryPathExcluded,
  isLibraryPathMutationInProgress,
  loadMusicLibraryDocument,
  normalizeLibraryFilePath,
  persistMusicLibraryDocument,
  replaceActiveLibraryExclusions,
  restoreLibraryExclusions
} = (await import(
  new URL('./libraryRepository.ts', import.meta.url).href
)) as typeof import('./libraryRepository.ts')
const {
  commitLocalLibraryRemoval,
  createLocalLibraryRemovalJournal,
  getLocalLibraryRemovalJournalPath,
  recoverLocalLibraryRemoval,
  recoverLocalLibraryRemovalResult
} = (await import(
  new URL('./removal.ts', import.meta.url).href
)) as typeof import('./removal.ts')

test('local library scan normalizes common bpm metadata into Track bpm', () => {
  const source = readFileSync(new URL('./scan.ts', import.meta.url), 'utf8')

  assert.match(source, /function normalizeBpm\(/)
  assert.match(source, /const bpm = normalizeBpm\(common\.bpm\)/)
  assert.match(source, /if \(bpm !== undefined\) track\.bpm = bpm/)
})

test('local library scan persists trackNumber and discNumber from common tags', () => {
  const scanSource = readFileSync(new URL('./scan.ts', import.meta.url), 'utf8')
  const serviceSource = readFileSync(new URL('./libraryScanService.ts', import.meta.url), 'utf8')

  for (const source of [scanSource, serviceSource]) {
    assert.match(source, /function normalizeTrackIndex\(/)
    assert.match(source, /trackNumber/)
    assert.match(source, /discNumber/)
  }
  assert.match(scanSource, /normalizeTrackIndex\(common\.track\)/)
  assert.match(scanSource, /normalizeTrackIndex\(common\.disk\)/)
  assert.match(serviceSource, /normalizeTrackIndex\(metadata\.common\.track\)/)
  assert.match(serviceSource, /normalizeTrackIndex\(metadata\.common\.disk\)/)
})

test('local library scan only stores albumArtist from a real ALBUMARTIST tag', () => {
  const scanSource = readFileSync(new URL('./scan.ts', import.meta.url), 'utf8')
  const serviceSource = readFileSync(new URL('./libraryScanService.ts', import.meta.url), 'utf8')

  assert.match(scanSource, /\.\.\.\(common\.albumartist \? \{ albumArtist: common\.albumartist \} : \{\}\)/)
  assert.doesNotMatch(
    scanSource,
    /albumArtist:\s*common\.albumartist\s*\|\|\s*artist/
  )
  assert.match(
    serviceSource,
    /\.\.\.\(metadata\.common\.albumartist \? \{ albumArtist: metadata\.common\.albumartist \} : \{\}\)/
  )
  assert.doesNotMatch(
    serviceSource,
    /albumArtist:\s*metadata\.common\.albumartist\s*\|\|\s*metadata\.common\.artist/
  )
})

test('local library scan persists ReplayGain and R128 tags onto Track records', () => {
  const source = readFileSync(new URL('./scan.ts', import.meta.url), 'utf8')
  assert.match(source, /export function extractReplayGainTags\(/)
  assert.match(source, /function normalizeGainDb\(/)
  assert.match(source, /function normalizePeak\(/)
  assert.match(source, /function normalizeR128GainDb\(/)
  assert.match(source, /\.\.\.replayGainTags/)
  assert.match(source, /replayGainTrackGainDb/)
  assert.match(source, /replayGainAlbumGainDb/)
  assert.match(source, /replayGainTrackPeak/)
  assert.match(source, /replayGainAlbumPeak/)
  assert.match(source, /r128TrackGainDb/)
  assert.match(source, /r128AlbumGainDb/)
  assert.match(source, /Math\.abs\(value\) > 64 \? value \/ 256/)
  assert.match(source, /REPLAYGAIN_TRACK_GAIN/)
  assert.match(source, /R128_TRACK_GAIN/)
  assert.match(source, /R128_ALBUM_GAIN/)
})

test('local library scan decodes sibling lyrics with the shared multi-encoding decoder', () => {
  const source = readFileSync(new URL('./scan.ts', import.meta.url), 'utf8')

  assert.match(source, /decodeLyrics\(readFileSync\(lrcPath\)\)\.text/)
  assert.doesNotMatch(source, /readFileSync\(lrcPath,\s*['"]utf-?8['"]\)/)
})

test('music library legacy data migrates to schema v2 and survives a restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-migration-'))
  const libraryFile = join(root, 'music-library.json')
  try {
    writeFileSync(
      libraryFile,
      JSON.stringify({
        tracks: [createTrack('legacy', join(root, 'Legacy.flac'))],
        folders: [root]
      }),
      'utf8'
    )

    const firstLoad = loadMusicLibraryDocument(libraryFile)
    assert.equal(firstLoad.migrated, true)
    assert.equal(firstLoad.document.version, 2)
    assert.equal(firstLoad.document.revision, 0)
    persistMusicLibraryDocument(libraryFile, firstLoad.document)

    const restarted = loadMusicLibraryDocument(libraryFile)
    assert.equal(restarted.migrated, false)
    assert.equal(restarted.document.version, 2)
    assert.equal(restarted.document.revision, 0)
    assert.equal(restarted.document.tracks.length, 1)
    assert.deepEqual(restarted.document.exclusions, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('excluded tracks are filtered during create, save, load, and restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-invariant-'))
  const libraryFile = join(root, 'music-library.json')
  const excludedPath = join(root, 'Excluded.flac')
  const keptPath = join(root, 'Kept.flac')
  const exclusion = {
    filePath: excludedPath,
    title: 'Excluded',
    artist: 'Test Artist',
    excludedAt: '2026-01-01T00:00:00.000Z'
  }
  const tracks = [createTrack('excluded', excludedPath), createTrack('kept', keptPath)]
  try {
    const created = createMusicLibraryDocument(
      { revision: 3, tracks, folders: [root] },
      [exclusion]
    )
    assert.deepEqual(created.tracks.map((track) => (track as { id: string }).id), ['kept'])

    persistMusicLibraryDocument(libraryFile, {
      version: 2,
      revision: 3,
      tracks,
      folders: [root],
      exclusions: [exclusion]
    })
    const savedBytes = JSON.parse(readFileSync(libraryFile, 'utf8')) as LocalMusicLibraryDocument
    assert.deepEqual(savedBytes.tracks.map((track) => (track as { id: string }).id), ['kept'])

    writeFileSync(
      libraryFile,
      JSON.stringify({
        version: 2,
        revision: 4,
        tracks,
        folders: [root],
        exclusions: [exclusion]
      }),
      'utf8'
    )
    const loaded = loadMusicLibraryDocument(libraryFile)
    assert.equal(loaded.migrated, true)
    assert.deepEqual(loaded.document.tracks.map((track) => (track as { id: string }).id), [
      'kept'
    ])
    persistMusicLibraryDocument(libraryFile, loaded.document)

    const restarted = loadMusicLibraryDocument(libraryFile)
    assert.equal(restarted.migrated, false)
    assert.deepEqual(restarted.document.tracks.map((track) => (track as { id: string }).id), [
      'kept'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy array removal uses persisted membership and survives restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-legacy-removal-'))
  const libraryFile = join(root, 'music-library.json')
  const filePath = join(root, 'Legacy.flac')
  writeFileSync(libraryFile, JSON.stringify([createTrack('legacy', filePath)]), 'utf8')
  try {
    const loaded = loadMusicLibraryDocument(libraryFile)
    assert.deepEqual(loaded.document.folders, [])
    const result = await commitLocalLibraryRemoval({
      document: loaded.document,
      items: [createSelection('legacy', filePath)],
      mode: 'library',
      trashItem: async () => {
        throw new Error('library-only removal must not touch the file system')
      },
      persist: (document) => {
        document.revision = loaded.document.revision + 1
        persistMusicLibraryDocument(libraryFile, document)
      }
    })

    assert.deepEqual(result.removedTrackIds, ['legacy'])
    assert.equal(result.library.exclusions.length, 1)
    const restarted = loadMusicLibraryDocument(libraryFile)
    assert.equal(restarted.document.tracks.length, 0)
    assert.deepEqual(restarted.document.exclusions.map((item) => item.filePath), [filePath])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('full directory scans omit persisted exclusion paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-scan-'))
  const nested = join(root, 'nested')
  const keptPath = join(root, 'Keep.mp3')
  const excludedPath = join(nested, 'Excluded.flac')
  try {
    mkdirSync(nested)
    writeFileSync(keptPath, 'keep')
    writeFileSync(excludedPath, 'excluded')
    const excludedKey = normalizeLibraryFilePath(excludedPath)

    const files = await collectFilesAsync(
      root,
      (filePath) => normalizeLibraryFilePath(filePath) === excludedKey
    )

    assert.deepEqual(files.map((file) => file.fullPath), [keptPath])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parsed scan results are checked again when exclusion changes after collection', () => {
  const filePath = join(tmpdir(), 'Twilight Deferred Scan.flac')
  const collectedResult = [createTrack('stale', filePath)]
  let excluded = false
  const isExcluded = (candidate: string): boolean => excluded && candidate === filePath

  assert.equal(filterParsedTracksAgainstExclusions(collectedResult, isExcluded).length, 1)
  excluded = true
  assert.deepEqual(filterParsedTracksAgainstExclusions(collectedResult, isExcluded), [])
})

test('persisted exclusions prime the matcher used by incremental watchers', () => {
  const excludedPath = join(tmpdir(), 'Twilight Excluded.flac')
  replaceActiveLibraryExclusions([
    {
      filePath: excludedPath,
      title: 'Excluded',
      artist: 'Test Artist',
      excludedAt: '2026-01-01T00:00:00.000Z'
    }
  ])
  assert.equal(isActiveLibraryPathExcluded(excludedPath), true)
  assert.equal(isActiveLibraryPathExcluded(join(tmpdir(), 'Twilight Other.flac')), false)
  replaceActiveLibraryExclusions([])
})

test('managed exclusions can be restored without dropping unrelated entries', () => {
  const firstPath = join(tmpdir(), 'Twilight First.flac')
  const secondPath = join(tmpdir(), 'Twilight Second.flac')
  const document = createDocument([], 2)
  document.exclusions = [firstPath, secondPath].map((filePath) => ({
    filePath,
    title: filePath,
    artist: '',
    excludedAt: '2026-01-01T00:00:00.000Z'
  }))

  const restored = restoreLibraryExclusions(document, [firstPath])

  assert.deepEqual(restored.restoredFilePaths, [firstPath])
  assert.deepEqual(restored.document.exclusions.map((item) => item.filePath), [secondPath])
})

test('trash failures keep failed records and never persist when every item fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-trash-failure-'))
  const libraryFile = join(root, 'music-library.json')
  const failedPath = join(root, 'Locked.flac')
  const initial = createDocument([createTrack('locked', failedPath)], 4)
  try {
    persistMusicLibraryDocument(libraryFile, initial)
    const bytesBefore = readFileSync(libraryFile, 'utf8')
    let persistCalls = 0

    const result = await commitLocalLibraryRemoval({
      document: initial,
      items: [createSelection('locked', failedPath)],
      mode: 'trash',
      trashItem: async () => {
        throw new Error('file is locked')
      },
      persist: (document) => {
        persistCalls++
        persistMusicLibraryDocument(libraryFile, document)
      }
    })

    assert.equal(persistCalls, 0)
    assert.equal(result.removedTrackIds.length, 0)
    assert.equal(result.failures.length, 1)
    assert.equal(result.library.revision, 4)
    assert.equal(result.library.tracks.length, 1)
    assert.equal(readFileSync(libraryFile, 'utf8'), bytesBefore)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stale library revisions are rejected before a mutation can write', () => {
  assert.doesNotThrow(() => assertMusicLibraryRevision(7, 7))
  assert.throws(
    () => assertMusicLibraryRevision(6, 7),
    (error: unknown) =>
      error instanceof Error && error.name === 'MusicLibraryRevisionConflictError'
  )
})

test('library watcher suppression is scoped to an in-flight trash path', () => {
  const filePath = join(tmpdir(), 'Twilight In Flight.flac')
  const finish = beginLibraryPathMutation([filePath])
  assert.equal(isLibraryPathMutationInProgress(filePath), true)
  finish()
  assert.equal(isLibraryPathMutationInProgress(filePath), false)
})

test('mixed trash results persist successful paths once and retain failed records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-trash-mixed-'))
  const successPath = join(root, 'Success.flac')
  const failedPath = join(root, 'Failed.flac')
  const initial = createDocument(
    [createTrack('success', successPath), createTrack('failed', failedPath)],
    9
  )
  let persistCalls = 0

  const result = await commitLocalLibraryRemoval({
    document: initial,
    items: [createSelection('success', successPath), createSelection('failed', failedPath)],
    mode: 'trash',
    trashItem: async (filePath) => {
      if (filePath === failedPath) throw new Error('access denied')
    },
    persist: (document) => {
      persistCalls++
      document.revision = initial.revision + 1
    }
  })

  assert.equal(persistCalls, 1)
  assert.equal(result.library.revision, 10)
  assert.deepEqual(result.removedTrackIds, ['success'])
  assert.deepEqual(
    result.library.tracks.map((track) => (track as { id: string }).id),
    ['failed']
  )
  assert.equal(result.failures.length, 1)
  assert.equal(result.library.exclusions.length, 0)
})

test('trash journal recovers partial successes after the library commit fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-trash-recovery-'))
  const libraryFile = join(root, 'music-library.json')
  const successPath = join(root, 'Success.flac')
  const failedPath = join(root, 'Failed.flac')
  const initial = createDocument(
    [createTrack('success', successPath), createTrack('failed', failedPath)],
    4
  )
  writeFileSync(successPath, 'success')
  writeFileSync(failedPath, 'failed')
  persistMusicLibraryDocument(libraryFile, initial)
  try {
    await assert.rejects(
      commitLocalLibraryRemoval({
        document: initial,
        items: [createSelection('success', successPath), createSelection('failed', failedPath)],
        mode: 'trash',
        trashItem: async (filePath) => {
          if (filePath === failedPath) throw new Error('access denied')
          unlinkSync(filePath)
        },
        persist: () => {
          throw new Error('simulated library commit failure')
        },
        journal: createLocalLibraryRemovalJournal(libraryFile)
      }),
      /simulated library commit failure/
    )

    assert.equal(existsSync(successPath), false)
    assert.equal(existsSync(failedPath), true)
    assert.equal(loadMusicLibraryDocument(libraryFile).document.tracks.length, 2)
    assert.equal(existsSync(getLocalLibraryRemovalJournalPath(libraryFile)), true)

    assert.throws(
      () =>
        recoverLocalLibraryRemoval(libraryFile, {
          persistDocument: () => {
            throw new Error('recovery disk failure')
          }
        }),
      /recovery disk failure/
    )
    assert.equal(existsSync(getLocalLibraryRemovalJournalPath(libraryFile)), true)

    const recoveryResult = recoverLocalLibraryRemovalResult(
      libraryFile,
      initial,
      [createSelection('success', successPath), createSelection('failed', failedPath)]
    )
    assert.ok(recoveryResult)
    assert.deepEqual(recoveryResult.removedTrackIds, ['success'])
    assert.equal(recoveryResult.library.revision, 5)
    assert.equal(existsSync(getLocalLibraryRemovalJournalPath(libraryFile)), false)

    const restarted = loadMusicLibraryDocument(libraryFile)
    assert.equal(restarted.document.revision, 5)
    assert.deepEqual(
      restarted.document.tracks.map((track) => (track as { id: string }).id),
      ['failed']
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('5000 removals perform one transaction write and create managed exclusions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-library-batch-'))
  const tracks = Array.from({ length: 5000 }, (_, index) =>
    createTrack(`track-${index}`, join(root, `Track ${index}.flac`))
  )
  const initial = createDocument(tracks, 12)
  let persistCalls = 0

  const startedAt = performance.now()
  const result = await commitLocalLibraryRemoval({
    document: initial,
    items: tracks.map((track) =>
      createSelection(track.id as string, track.filePath as string)
    ),
    mode: 'library',
    trashItem: async () => {
      throw new Error('library-only removal must not call trashItem')
    },
    persist: (document) => {
      persistCalls++
      document.revision = initial.revision + 1
    }
  })
  const elapsedMs = performance.now() - startedAt

  assert.equal(persistCalls, 1)
  assert.equal(result.library.revision, 13)
  assert.equal(result.library.tracks.length, 0)
  assert.equal(result.library.exclusions.length, 5000)
  assert.equal(result.removedTrackIds.length, 5000)
  assert.ok(elapsedMs < 5_000, `5000-track removal took ${elapsedMs.toFixed(2)}ms`)
  rmSync(root, { recursive: true, force: true })
})

function createDocument(
  tracks: Array<Record<string, unknown>>,
  revision: number
): LocalMusicLibraryDocument {
  return {
    version: 2,
    revision,
    tracks,
    folders: [],
    exclusions: []
  }
}

function createTrack(id: string, filePath: string): Record<string, unknown> {
  return {
    id,
    title: id,
    artist: 'Test Artist',
    album: 'Test Album',
    filePath,
    fileName: filePath.split(/[\\/]/).pop() || filePath,
    duration: 120,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
}

function createSelection(id: string, filePath: string) {
  return {
    id,
    filePath,
    title: id,
    artist: 'Test Artist'
  }
}
