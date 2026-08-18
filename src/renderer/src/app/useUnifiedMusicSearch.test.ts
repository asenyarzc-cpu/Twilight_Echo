import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music'
import type { UnifiedSearchResult } from '../utils/unifiedMusicSearch.ts'

const { createUnifiedMusicSearch } = (await import(
  new URL('./useUnifiedMusicSearch.ts', import.meta.url).href
)) as typeof import('./useUnifiedMusicSearch.ts')

const localTrack: Track = {
  id: 'local:1',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Album',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local',
  format: 'flac'
}

function unifiedResult(track: Track): UnifiedSearchResult {
  return {
    items: [
      {
        kind: 'track' as const,
        track,
        source: 'local',
        sourceName: 'local',
        local: true,
        lossless: true,
        providerAvailable: true,
        providerReliability: 1
      }
    ],
    logicalItems: [
      {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        preferredTrack: track,
        variants: [
          {
            track,
            source: 'local',
            sourceName: 'local',
            local: true,
            lossless: true,
            providerAvailable: true,
            providerReliability: 1
          }
        ]
      }
    ],
    health: {},
    total: 1
  }
}

test('unified music search composable exposes unified items and provider health', async () => {
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [localTrack],
    searchAllSongs: async ({ localTracks }): Promise<UnifiedSearchResult> => ({
      items: localTracks.map((track) => ({
        kind: 'track' as const,
        track,
        source: 'local',
        sourceName: '本地音乐',
        local: true,
        lossless: true,
        providerAvailable: true,
        providerReliability: 1
      })),
      logicalItems: [
        {
          id: 'moon river::audrey',
          title: 'Moon River',
          artist: 'Audrey',
          album: 'Album',
          preferredTrack: localTrack,
          variants: [
            {
              track: localTrack,
              source: 'local',
              sourceName: '本地音乐',
              local: true,
              lossless: true,
              providerAvailable: true,
              providerReliability: 1
            }
          ]
        }
      ],
      health: {
        ncm: {
          providerId: 'ncm',
          providerName: 'NetEase',
          available: false,
          searchable: true,
          resultCount: 0,
          lastError: 'login expired',
          pluginStatus: null,
          successRate: null,
          playbackUrlSuccessRate: null,
          playbackUrlLastError: null,
          lastCheckedAt: null
        }
      },
      total: 1
    })
  })

  await search.search('moon')

  assert.equal(search.loading.value, false)
  assert.equal(search.error.value, '')
  assert.deepEqual(
    search.items.value.map((item) => item.track.id),
    ['local:1']
  )
  assert.equal(search.logicalItems.value[0].preferredTrack.id, 'local:1')
  assert.equal(search.providerHealth.value.ncm.available, false)
  assert.equal(search.providerHealth.value.ncm.lastError, 'login expired')
})

test('unified music search clears state for blank queries', async () => {
  let called = false
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [localTrack],
    searchAllSongs: async () => {
      called = true
      return { items: [], logicalItems: [], health: {}, total: 0 }
    }
  })

  await search.search('   ')

  assert.equal(called, false)
  assert.equal(search.loading.value, false)
  assert.equal(search.items.value.length, 0)
  assert.equal(search.logicalItems.value.length, 0)
  assert.deepEqual(search.providerHealth.value, {})
})

test('a late unified search page cannot overwrite a newer request with the same query', async () => {
  let resolveFirst!: () => void
  let resolveSecond!: () => void
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  const second = new Promise<void>((resolve) => {
    resolveSecond = resolve
  })
  const pageZero = { ...localTrack, id: 'local:page-0', title: 'Page zero' }
  const pageThirty = { ...localTrack, id: 'local:page-30', title: 'Page thirty' }
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [localTrack],
    searchAllSongs: async ({ offset }) => {
      if (offset === 0) {
        await first
        return unifiedResult(pageZero)
      }
      await second
      return unifiedResult(pageThirty)
    }
  })

  const oldRequest = search.search('moon', { offset: 0 })
  const newestRequest = search.search('moon', { offset: 30 })
  resolveSecond()
  await newestRequest
  resolveFirst()
  await oldRequest

  assert.deepEqual(
    search.items.value.map((item) => item.track.id),
    ['local:page-30']
  )
  assert.equal(search.loading.value, false)
})
