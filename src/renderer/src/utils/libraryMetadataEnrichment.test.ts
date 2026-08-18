import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '../types/music'

const {
  enrichLocalTracksFromProviders,
  LibraryMetadataEnrichmentQueue,
  runLibraryMetadataEnrichmentBenchmark
} = (await import(
  new URL('./libraryMetadataEnrichment.ts', import.meta.url).href
)) as typeof import('./libraryMetadataEnrichment')

const localTrack = {
  id: 'local:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: '',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 10_000,
  cover: null,
  lyrics: null,
  source: 'local' as const,
  format: 'flac'
}

test('enrichLocalTracksFromProviders fills missing local metadata from provider search results', async () => {
  const enriched = await enrichLocalTracksFromProviders([localTrack], {
    searchSongs: async (query) => {
      assert.equal(query, 'Moon River Audrey')
      return {
        items: [
          {
            id: 'ncm:123',
            title: 'Moon River',
            artist: 'Audrey',
            album: 'Online Album',
            filePath: 'ncm:123',
            fileName: 'Moon River',
            duration: 179,
            size: 0,
            cover: 'https://cover.example/album.jpg',
            lyrics: '[00:00.00]Moon River',
            translatedLyrics: '[00:00.00]月亮河',
            source: 'ncm' as const,
            streamUrl: 'https://temporary.example/song.mp3'
          }
        ],
        total: 1
      }
    }
  })

  assert.equal(enriched[0].id, 'local:moon')
  assert.equal(enriched[0].filePath, 'D:\\Music\\Moon River.flac')
  assert.equal(enriched[0].album, 'Online Album')
  assert.equal(enriched[0].cover, 'https://cover.example/album.jpg')
  assert.equal(enriched[0].lyrics, '[00:00.00]Moon River')
  assert.equal(enriched[0].translatedLyrics, '[00:00.00]月亮河')
  assert.deepEqual(enriched[0].metadataMatch, {
    providerId: 'ncm',
    trackId: 'ncm:123',
    confidence: 'high',
    score: 96
  })
  assert.equal(enriched[0].streamUrl, undefined)
})

test('enrichLocalTracksFromProviders keeps local playback working when provider search fails', async () => {
  const enriched = await enrichLocalTracksFromProviders([localTrack], {
    searchSongs: async () => {
      throw new Error('provider unavailable')
    }
  })

  assert.deepEqual(enriched, [localTrack])
})

test('enrichLocalTracksFromProviders respects disabled provider metadata cache policy', async () => {
  const enriched = await enrichLocalTracksFromProviders(
    [localTrack],
    {
      searchSongs: async () => ({
        items: [
          {
            id: 'ncm:123',
            title: 'Moon River',
            artist: 'Audrey',
            album: 'Online Album',
            filePath: 'ncm:123',
            fileName: 'Moon River',
            duration: 179,
            size: 0,
            cover: 'https://cover.example/album.jpg',
            lyrics: '[00:00.00]Moon River',
            translatedLyrics: '[00:00.00]月亮河',
            source: 'ncm' as const
          }
        ],
        total: 1
      })
    },
    {
      cachePolicy: {
        cover: false,
        lyrics: false,
        metadata: false
      }
    }
  )

  assert.deepEqual(enriched, [localTrack])
})

test('enrichLocalTracksFromProviders can cache cover without lyrics or album metadata', async () => {
  const enriched = await enrichLocalTracksFromProviders(
    [localTrack],
    {
      searchSongs: async () => ({
        items: [
          {
            id: 'ncm:123',
            title: 'Moon River',
            artist: 'Audrey',
            album: 'Online Album',
            filePath: 'ncm:123',
            fileName: 'Moon River',
            duration: 179,
            size: 0,
            cover: 'https://cover.example/album.jpg',
            lyrics: '[00:00.00]Moon River',
            translatedLyrics: '[00:00.00]月亮河',
            source: 'ncm' as const
          }
        ],
        total: 1
      })
    },
    {
      cachePolicy: {
        cover: true,
        lyrics: false,
        metadata: false
      }
    }
  )

  assert.equal(enriched[0].album, '')
  assert.equal(enriched[0].cover, 'https://cover.example/album.jpg')
  assert.equal(enriched[0].lyrics, null)
  assert.equal(enriched[0].translatedLyrics, undefined)
})

test('enrichLocalTracksFromProviders skips local tracks that already have enrichment metadata', async () => {
  let calls = 0
  const enrichedTrack = {
    ...localTrack,
    album: 'Local Album',
    genre: 'Jazz',
    cover: 'cover://embedded',
    lyrics: '[00:00.00]local',
    translatedLyrics: '[00:00.00]local translated'
  }

  const enriched = await enrichLocalTracksFromProviders([enrichedTrack], {
    searchSongs: async () => {
      calls++
      return { items: [], total: 0 }
    }
  })

  assert.equal(calls, 0)
  assert.deepEqual(enriched, [enrichedTrack])
})

test('metadata enrichment queue deduplicates matching queries and updates every local track', async () => {
  const statuses: string[] = []
  const updates: string[] = []
  let searches = 0
  const secondTrack = {
    ...localTrack,
    id: 'local:moon-live',
    filePath: 'D:\\Music\\Moon River Live.flac',
    fileName: 'Moon River Live.flac'
  }
  const queue = new LibraryMetadataEnrichmentQueue({
    concurrency: 8,
    provider: {
      searchSongs: async (query) => {
        searches += 1
        assert.equal(query, 'Moon River Audrey')
        return { items: [createProviderTrack(localTrack)], total: 1 }
      }
    },
    onStatus: (status) => statuses.push(status.state),
    onTrackEnriched: (update) => updates.push(update.track.id)
  })

  await queue.enqueue([localTrack, secondTrack])

  assert.equal(searches, 1)
  assert.deepEqual(updates.sort(), ['local:moon', 'local:moon-live'])
  assert.ok(statuses.includes('enriching'))
  assert.equal(queue.getStatus().state, 'completed')
  assert.equal(queue.getStatus().completed, 2)
})

test('metadata enrichment deduplicates an active query while retaining each track policy', async () => {
  let searches = 0
  let resolveSearch: ((value: { items: Track[]; total: number }) => void) | null = null
  const updates = new Map<string, Track>()
  const secondTrack = {
    ...localTrack,
    id: 'local:moon-policy-two',
    filePath: 'D:\\Music\\Moon River Policy Two.flac',
    fileName: 'Moon River Policy Two.flac'
  }
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async () => {
        searches += 1
        return await new Promise((resolve) => {
          resolveSearch = resolve
        })
      }
    },
    onTrackEnriched: (update) => updates.set(update.track.id, update.track)
  })

  const coverOnly = queue.enqueue([localTrack], { cover: true, lyrics: false, metadata: false })
  await waitFor(() => searches === 1)
  const lyricsOnly = queue.enqueue([secondTrack], { cover: false, lyrics: true, metadata: false })
  ;(resolveSearch as ((value: { items: Track[]; total: number }) => void) | null)?.({ items: [createProviderTrack(localTrack)], total: 1 })
  await Promise.all([coverOnly, lyricsOnly])

  assert.equal(searches, 1)
  assert.equal(updates.get(localTrack.id)?.cover, 'https://cover.example/album.jpg')
  assert.equal(updates.get(localTrack.id)?.lyrics, null)
  assert.equal(updates.get(secondTrack.id)?.cover, null)
  assert.equal(updates.get(secondTrack.id)?.lyrics, '[00:00.00]Moon River')
})

test('metadata enrichment queue caches query failures with retry backoff', async () => {
  let now = 1_000
  let searches = 0
  let shouldFail = true
  const queue = new LibraryMetadataEnrichmentQueue({
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    now: () => now,
    provider: {
      searchSongs: async () => {
        searches += 1
        if (shouldFail) throw new Error('offline')
        return { items: [createProviderTrack(localTrack)], total: 1 }
      }
    }
  })

  await queue.enqueue([localTrack])
  assert.equal(searches, 1)
  assert.equal(queue.getStatus().state, 'failed')

  await queue.enqueue([localTrack])
  assert.equal(searches, 1, 'the same query must respect its cached retry window')
  assert.equal(queue.getStatus().skipped, 1)

  shouldFail = false
  now += 100
  await queue.enqueue([localTrack])
  assert.equal(searches, 2)
  assert.equal(queue.getStatus().state, 'completed')
})

test('metadata enrichment cancellation drops late provider results', async () => {
  let resolveSearch: ((value: { items: Track[]; total: number }) => void) | null = null
  let started = false
  const updates: string[] = []
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async () => {
        started = true
        return await new Promise((resolve) => {
          resolveSearch = resolve
        })
      }
    },
    onTrackEnriched: (update) => updates.push(update.track.id)
  })

  const run = queue.enqueue([localTrack])
  await waitFor(() => started)
  assert.equal(queue.cancel(), true)
  ;(resolveSearch as ((value: { items: Track[]; total: number }) => void) | null)?.({ items: [createProviderTrack(localTrack)], total: 1 })
  await run
  await Promise.resolve()

  assert.equal(queue.getStatus().state, 'cancelled')
  assert.deepEqual(updates, [])
})

test('metadata enrichment cancellation aborts providers that expose AbortSignal support', async () => {
  let aborted = false
  let started = false
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async (_query, _limit, _offset, signal) => {
        started = true
        return await new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('cancelled', 'AbortError'))
          })
        })
      }
    }
  })

  const run = queue.enqueue([localTrack])
  await waitFor(() => started)
  assert.equal(queue.cancel(), true)
  await run

  assert.equal(aborted, true)
  assert.equal(queue.getStatus().state, 'cancelled')
})

test('metadata enrichment updates retain the source snapshot for stale-result fencing', async () => {
  const updates: Array<{ source: Track; track: Track }> = []
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async () => ({ items: [createProviderTrack(localTrack)], total: 1 })
    },
    onTrackEnriched: (update) => updates.push(update)
  })

  await queue.enqueue([localTrack])

  assert.equal(updates.length, 1)
  assert.equal(updates[0].source, localTrack)
  assert.equal(updates[0].track.id, localTrack.id)
  assert.notEqual(updates[0].track, localTrack)
})

test('metadata enrichment queue caps concurrent queries while deduplicating the same track', async () => {
  const tracks = Array.from({ length: 24 }, (_, index) => ({
    ...localTrack,
    id: `local:concurrent-${index}`,
    title: `Concurrent ${index}`,
    artist: 'Queue Artist',
    filePath: `D:\\Music\\Concurrent ${index}.flac`,
    fileName: `Concurrent ${index}.flac`
  }))
  let active = 0
  let maxActive = 0
  let searches = 0
  const updates: string[] = []
  const states: string[] = []
  const queue = new LibraryMetadataEnrichmentQueue({
    concurrency: 6,
    provider: {
      searchSongs: async (query) => {
        searches += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        const source = tracks.find((track) => `${track.title} ${track.artist}` === query)!
        return { items: [createProviderTrack(source)], total: 1 }
      }
    },
    onStatus: (status) => states.push(status.state),
    onTrackEnriched: (update) => updates.push(update.track.id)
  })

  await queue.enqueue([...tracks, tracks[0]])

  assert.equal(searches, tracks.length)
  assert.equal(maxActive, 6)
  assert.equal(updates.length, tracks.length)
  assert.equal(new Set(updates).size, tracks.length)
  assert.ok(states.includes('enriching'))
  assert.equal(queue.getStatus().state, 'completed')
})

test('metadata enrichment benchmark handles a large library with bounded query work', async () => {
  const result = await runLibraryMetadataEnrichmentBenchmark({
    trackCount: 2_000,
    uniqueQueryCount: 200,
    concurrency: 6
  })

  assert.equal(result.queryCalls, 200)
  assert.equal(result.maxConcurrentQueries, 6)
  assert.ok(result.durationMs >= 0)
  console.log(
    `metadata enrichment benchmark: ${result.trackCount} tracks, ${result.queryCalls} queries, ${result.durationMs.toFixed(1)}ms`
  )
})

function createProviderTrack(track: typeof localTrack): Track {
  return {
    ...track,
    id: `ncm:${track.id}`,
    filePath: `ncm:${track.id}`,
    fileName: track.title,
    album: 'Online Album',
    cover: 'https://cover.example/album.jpg',
    lyrics: '[00:00.00]Moon River',
    translatedLyrics: '[00:00.00]月亮河',
    source: 'ncm'
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}
