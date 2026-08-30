import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music'

const { buildLogicalMusicItems, unifiedSearchSongs } = (await import(
  new URL('./unifiedMusicSearch.ts', import.meta.url).href
)) as typeof import('./unifiedMusicSearch')

function track(overrides: Partial<Track> & Pick<Track, 'id' | 'title' | 'artist'>): Track {
  return {
    album: 'Album',
    filePath: overrides.id,
    fileName: `${overrides.title}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    ...overrides
  }
}

test('unified search ranks local tracks before provider results and lossless before lossy', async () => {
  const localMp3 = track({
    id: 'local:mp3',
    title: 'Moon River',
    artist: 'Audrey',
    source: 'local',
    format: 'mp3',
    bitrate: 320000
  })
  const localFlac = track({
    id: 'local:flac',
    title: 'Moon River',
    artist: 'Audrey',
    source: 'local',
    format: 'flac',
    bitDepth: 24
  })

  const result = await unifiedSearchSongs({
    query: 'moon',
    localTracks: [localMp3, localFlac],
    providers: [
      { id: 'ncm', name: 'NetEase', capabilities: ['search'], available: true },
      { id: 'bili', name: 'Bilibili', capabilities: ['search'], available: true }
    ],
    searchProviderSongs: async (providerId) => {
      if (providerId === 'bili') throw new Error('login expired')
      return {
        items: [
          track({
            id: `${providerId}:1`,
            title: 'Moon River',
            artist: 'Audrey',
            source: providerId,
            format: 'flac'
          })
        ],
        total: 1
      }
    }
  })

  assert.deepEqual(
    result.items.map((item) => item.track.id),
    ['local:flac', 'local:mp3', 'ncm:1']
  )
  assert.equal(result.health.ncm.available, true)
  assert.equal(result.health.ncm.resultCount, 1)
  assert.equal(result.health.bili.available, false)
  assert.match(result.health.bili.lastError ?? '', /login expired/)
})

test('unified search merges network library entries with source name', async () => {
  const result = await unifiedSearchSongs({
    query: 'moon',
    localTracks: [],
    networkEntries: [
      {
        profileName: 'NAS',
        entry: {
          id: 'net:1',
          profileId: 'p1',
          name: 'Moon River.flac',
          kind: 'audio',
          path: '/music/Moon River.flac',
          metadata: { title: 'Moon River', artist: 'Audrey' }
        }
      },
      {
        profileName: 'NAS',
        entry: {
          id: 'net:2',
          profileId: 'p1',
          name: 'Other.flac',
          kind: 'audio',
          path: '/music/Other.flac',
          metadata: { title: 'Other' }
        }
      }
    ],
    providers: [],
    searchProviderSongs: async () => ({ items: [], total: 0 })
  })
  assert.equal(result.items.length, 1)
  const item = result.items[0]
  assert.equal(item.sourceName, '网络源')
  assert.equal(item.track.title, 'Moon River')
  assert.equal(item.track.artist, 'Audrey')
  assert.equal(item.track.source, 'network')
  assert.equal(item.track.networkSource?.profileId, 'p1')
  assert.equal(result.total, 1)
})

test('logical music items group matching local and provider variants without merging different performances', () => {
  const items = buildLogicalMusicItems([
    track({
      id: 'local:flac',
      title: 'Moon River',
      artist: 'Audrey',
      source: 'local',
      duration: 181,
      format: 'flac'
    }),
    track({
      id: 'ncm:123',
      title: ' moon river ',
      artist: 'AUDREY',
      source: 'ncm',
      duration: 182,
      format: 'aac'
    }),
    track({
      id: 'bili:BV1:80',
      title: 'Moon River',
      artist: 'Audrey',
      source: 'bili',
      duration: 261,
      format: 'aac'
    })
  ])

  assert.equal(items.length, 2)
  assert.equal(items[0].id, 'logic:moon river::audrey')
  assert.deepEqual(
    items[0].variants.map((variant) => variant.track.id),
    ['local:flac', 'ncm:123']
  )
  assert.equal(items[0].preferredTrack.id, 'local:flac')
  assert.deepEqual(
    items[1].variants.map((variant) => variant.track.id),
    ['bili:BV1:80']
  )
})

test('unified search does not call unavailable or non-search providers', async () => {
  const calledProviders: string[] = []

  const result = await unifiedSearchSongs({
    query: 'moon',
    localTracks: [],
    providers: [
      { id: 'ncm', name: 'NetEase', capabilities: ['library'], available: true },
      { id: 'bili', name: 'Bilibili', capabilities: ['search'], available: false }
    ],
    searchProviderSongs: async (providerId) => {
      calledProviders.push(providerId)
      return { items: [], total: 0 }
    }
  })

  assert.deepEqual(calledProviders, [])
  assert.equal(result.health.ncm.searchable, false)
  assert.equal(result.health.ncm.available, true)
  assert.equal(result.health.bili.searchable, true)
  assert.equal(result.health.bili.available, false)
})

test('unified search ranks healthier provider results before degraded provider results', async () => {
  const result = await unifiedSearchSongs({
    query: 'moon',
    localTracks: [],
    providers: [
      {
        id: 'unstable',
        name: 'Unstable Provider',
        capabilities: ['search'],
        available: true,
        health: {
          available: true,
          successRate: 0.7,
          methodStats: {
            getPlaybackUrl: {
              successRate: 0.25
            }
          }
        }
      },
      {
        id: 'healthy',
        name: 'Healthy Provider',
        capabilities: ['search'],
        available: true,
        health: {
          available: true,
          successRate: 0.98,
          methodStats: {
            getPlaybackUrl: {
              successRate: 1
            }
          }
        }
      }
    ],
    searchProviderSongs: async (providerId) => ({
      items: [
        track({
          id: `${providerId}:1`,
          title: 'Moon River',
          artist: 'Audrey',
          source: providerId,
          format: 'aac'
        })
      ],
      total: 1
    })
  })

  assert.deepEqual(
    result.items.map((item) => item.track.id),
    ['healthy:1', 'unstable:1']
  )
  assert.equal(result.items[0].providerReliability, 1)
  assert.equal(result.items[1].providerReliability, 0.25)
  assert.equal(result.logicalItems[0].preferredTrack.id, 'healthy:1')
})

test('unified search carries provider plugin and playback URL diagnostics', async () => {
  const result = await unifiedSearchSongs({
    query: 'moon',
    localTracks: [],
    providers: [
      {
        id: 'ncm',
        name: 'NetEase',
        capabilities: ['search'],
        available: true,
        health: {
          available: true,
          pluginStatus: 'enabled',
          successRate: 0.8,
          lastError: 'login expired',
          methodStats: {
            getPlaybackUrl: {
              successRate: 0.25,
              lastError: 'stream expired'
            }
          }
        }
      }
    ],
    searchProviderSongs: async () => ({ items: [], total: 0 })
  })

  assert.equal(result.health.ncm.pluginStatus, 'enabled')
  assert.equal(result.health.ncm.successRate, 0.8)
  assert.equal(result.health.ncm.playbackUrlSuccessRate, 0.25)
  assert.equal(result.health.ncm.playbackUrlLastError, 'stream expired')
  assert.equal(result.health.ncm.lastError, 'login expired')
})

test('unified search keeps artist as the text tie-breaker before track id', async () => {
  const result = await unifiedSearchSongs({
    query: 'moon',
    localTracks: [
      track({
        id: 'local:a',
        title: 'Moon River',
        artist: 'Beta Artist',
        source: 'local',
        format: 'mp3'
      }),
      track({
        id: 'local:z',
        title: 'Moon River',
        artist: 'Alpha Artist',
        source: 'local',
        format: 'mp3'
      })
    ],
    providers: [],
    searchProviderSongs: async () => ({ items: [], total: 0 })
  })

  assert.deepEqual(
    result.items.map((item) => item.track.id),
    ['local:z', 'local:a']
  )
})

test('logical preferred track preserves unified provider reliability ordering', async () => {
  const result = await unifiedSearchSongs({
    query: 'moon',
    localTracks: [],
    providers: [
      {
        id: 'aaunstable',
        name: 'AA Unstable Provider',
        capabilities: ['search'],
        available: true,
        health: {
          available: true,
          successRate: 0.8,
          methodStats: {
            getPlaybackUrl: {
              successRate: 0.2
            }
          }
        }
      },
      {
        id: 'zzhealthy',
        name: 'ZZ Healthy Provider',
        capabilities: ['search'],
        available: true,
        health: {
          available: true,
          successRate: 0.99,
          methodStats: {
            getPlaybackUrl: {
              successRate: 1
            }
          }
        }
      }
    ],
    searchProviderSongs: async (providerId) => ({
      items: [
        track({
          id: `${providerId}:1`,
          title: 'Moon River',
          artist: 'Audrey',
          source: providerId,
          format: 'aac'
        })
      ],
      total: 1
    })
  })

  assert.deepEqual(
    result.items.map((item) => item.track.id),
    ['zzhealthy:1', 'aaunstable:1']
  )
  assert.deepEqual(
    result.logicalItems[0].variants.map((variant) => variant.track.id),
    ['zzhealthy:1', 'aaunstable:1']
  )
  assert.equal(result.logicalItems[0].preferredTrack.id, 'zzhealthy:1')
})
