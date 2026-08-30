import assert from 'node:assert/strict'
import test from 'node:test'

const { repairMovedLocalTracks, findProviderRematchCandidate } = (await import(
  new URL('./libraryRepair.ts', import.meta.url).href
)) as typeof import('./libraryRepair')

const missingLocalTrack = {
  id: 'local:oldhash',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Old Album',
  filePath: 'D:\\Old\\Moon River.flac',
  fileName: 'Moon River.flac',
  dir: 'D:\\Old',
  duration: 181,
  size: 10_000,
  cover: null,
  lyrics: null,
  source: 'local',
  format: 'flac'
}

test('repairMovedLocalTracks relocates missing local files from newly scanned tracks while preserving stable ids', () => {
  const repaired = repairMovedLocalTracks({
    existingTracks: [missingLocalTrack],
    scannedTracks: [
      {
        id: 'local:newhash',
        title: ' moon  river ',
        artist: 'AUDREY',
        album: 'New Album',
        filePath: 'E:\\Music\\Audrey\\Moon River.flac',
        fileName: 'Moon River.flac',
        dir: 'E:\\Music\\Audrey',
        duration: 179,
        size: 12_000,
        cover: 'cover://new',
        lyrics: null,
        source: 'local',
        format: 'flac',
        bpm: 128
      }
    ],
    fileExists: (path) => !path.startsWith('D:\\Old')
  })

  assert.equal(repaired.repairedTracks.length, 1)
  assert.equal(repaired.repairedTracks[0].id, 'local:oldhash')
  assert.equal(repaired.repairedTracks[0].filePath, 'E:\\Music\\Audrey\\Moon River.flac')
  assert.equal(repaired.repairedTracks[0].dir, 'E:\\Music\\Audrey')
  assert.equal(repaired.repairedTracks[0].fileName, 'Moon River.flac')
  assert.equal(repaired.repairedTracks[0].cover, 'cover://new')
  assert.equal(repaired.repairedTracks[0].bpm, 128)
  assert.deepEqual(repaired.unresolvedTracks, [])
})

test('repairMovedLocalTracks reports unresolved missing files without dropping them', () => {
  const repaired = repairMovedLocalTracks({
    existingTracks: [missingLocalTrack],
    scannedTracks: [],
    fileExists: () => false
  })

  assert.deepEqual(repaired.repairedTracks, [])
  assert.deepEqual(repaired.unresolvedTracks, [missingLocalTrack])
})

test('findProviderRematchCandidate finds same-song replacement when provider ids expire', () => {
  const replacement = findProviderRematchCandidate(
    {
      id: 'ncm:expired',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Online Album',
      filePath: 'ncm:expired',
      fileName: 'Moon River',
      duration: 180,
      size: 0,
      cover: null,
      lyrics: null,
      source: 'ncm'
    },
    [
      {
        id: 'bili:wrong',
        title: 'Moon River Live',
        artist: 'Audrey',
        album: 'Concert',
        filePath: 'bili:wrong',
        fileName: 'Moon River Live',
        duration: 260,
        size: 0,
        cover: null,
        lyrics: null,
        source: 'bili'
      },
      {
        id: 'ncm:new',
        title: ' moon  river ',
        artist: 'AUDREY',
        album: 'Online Album',
        filePath: 'ncm:new',
        fileName: 'Moon River',
        duration: 181,
        size: 0,
        cover: null,
        lyrics: null,
        source: 'ncm'
      }
    ]
  )

  assert.equal(replacement?.id, 'ncm:new')
})

test('findProviderRematchCandidate preserves caller ranking when match quality ties', () => {
  const replacement = findProviderRematchCandidate(
    {
      id: 'ncm:expired',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Online Album',
      filePath: 'ncm:expired',
      fileName: 'Moon River',
      duration: 180,
      size: 0,
      cover: null,
      lyrics: null,
      source: 'ncm'
    },
    [
      {
        id: 'zzhealthy:1',
        title: 'Moon River',
        artist: 'Audrey',
        album: 'Online Album',
        filePath: 'zzhealthy:1',
        fileName: 'Moon River',
        duration: 180,
        size: 0,
        cover: null,
        lyrics: null,
        source: 'zzhealthy'
      },
      {
        id: 'aaunstable:1',
        title: 'Moon River',
        artist: 'Audrey',
        album: 'Online Album',
        filePath: 'aaunstable:1',
        fileName: 'Moon River',
        duration: 180,
        size: 0,
        cover: null,
        lyrics: null,
        source: 'aaunstable'
      }
    ]
  )

  assert.equal(replacement?.id, 'zzhealthy:1')
})

test('findProviderRematchCandidate keeps caller ranking ahead of metadata richness', () => {
  const replacement = findProviderRematchCandidate(
    {
      id: 'ncm:expired',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Online Album',
      filePath: 'ncm:expired',
      fileName: 'Moon River',
      duration: 180,
      size: 0,
      cover: null,
      lyrics: null,
      source: 'ncm'
    },
    [
      {
        id: 'zzhealthy:1',
        title: 'Moon River',
        artist: 'Audrey',
        album: 'Online Album',
        filePath: 'zzhealthy:1',
        fileName: 'Moon River',
        duration: 180,
        size: 0,
        cover: null,
        lyrics: null,
        source: 'zzhealthy'
      },
      {
        id: 'aaunstable:1',
        title: 'Moon River',
        artist: 'Audrey',
        album: 'Online Album',
        filePath: 'aaunstable:1',
        fileName: 'Moon River',
        duration: 180,
        size: 0,
        cover: 'https://cover.example/album.jpg',
        lyrics: '[00:00.00]Moon River',
        translatedLyrics: '[00:00.00]月亮河',
        source: 'aaunstable'
      }
    ]
  )

  assert.equal(replacement?.id, 'zzhealthy:1')
})
