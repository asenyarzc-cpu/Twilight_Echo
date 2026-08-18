import assert from 'node:assert/strict'
import test from 'node:test'

const { useMusicStore } = (await import(
  new URL('./useMusicStore.ts', import.meta.url).href
)) as typeof import('./useMusicStore')

const localTrack = {
  id: 'local:cancelled-enrichment',
  title: 'Cancelled Enrichment',
  artist: 'Queue Artist',
  album: '',
  filePath: 'D:\\Music\\Cancelled Enrichment.flac',
  fileName: 'Cancelled Enrichment.flac',
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local' as const,
  format: 'flac'
}

test('cancelled metadata enrichment cannot overwrite a local track or schedule persistence', async () => {
  let saveCalls = 0
  let resolveProviderSearch: ((value: unknown) => void) | null = null
  let markProviderStarted: (() => void) | null = null
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve
  })
  const pendingProviderSearch = new Promise<unknown>((resolve) => {
    resolveProviderSearch = resolve
  })
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      data: {
        loadMusicLibrary: async () => ({ tracks: [localTrack], folders: [] }),
        saveMusicLibrary: async () => {
          saveCalls += 1
          return { version: 2, revision: 1, tracks: [localTrack], folders: [], exclusions: [] }
        },
        savePlaylists: async () => {},
        loadPlaylists: async () => []
      },
      providers: {
        list: async () => [
          {
            id: 'ncm',
            name: 'NetEase',
            capabilities: ['search'],
            health: { available: true }
          }
        ],
        call: async () => {
          markProviderStarted?.()
          return await pendingProviderSearch
        }
      }
    }
  }

  const store = useMusicStore()
  store.clearTracks()
  await store.loadLibrary()
  assert.equal(store.tracks.value[0].id, localTrack.id)
  await providerStarted
  assert.equal(store.libraryMetadataEnrichmentStatus.value.state, 'enriching')
  assert.equal(store.cancelLibraryMetadataEnrichment(), true)

  ;(resolveProviderSearch as ((value: unknown) => void) | null)?.({
    items: [
      {
        ...localTrack,
        id: 'ncm:cancelled-enrichment',
        filePath: 'ncm:cancelled-enrichment',
        fileName: localTrack.title,
        album: 'Provider Album',
        cover: 'https://cover.example/cancelled.jpg',
        lyrics: '[00:00.00]late result',
        source: 'ncm'
      }
    ],
    total: 1
  })
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(store.libraryMetadataEnrichmentStatus.value.state, 'cancelled')
  assert.equal(store.tracks.value[0].id, localTrack.id)
  assert.equal(store.tracks.value[0].filePath, localTrack.filePath)
  assert.equal(store.tracks.value[0].album, '')
  assert.equal(store.tracks.value[0].cover, null)
  assert.equal(store.tracks.value[0].lyrics, null)
  assert.equal(saveCalls, 0)
  store.clearTracks()
})

test(
  'late enrichment from a replaced scan snapshot cannot overwrite UI or persistence',
  { timeout: 3_000 },
  async () => {
    let saveCalls = 0
    let providerCalls = 0
    let resolveFirstSearch: ((value: unknown) => void) | null = null
    let resolveSecondSearch: ((value: unknown) => void) | null = null
    let markFirstStarted: (() => void) | null = null
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const firstSearch = new Promise<unknown>((resolve) => {
      resolveFirstSearch = resolve
    })
    const secondSearch = new Promise<unknown>((resolve) => {
      resolveSecondSearch = resolve
    })
    const replacement = { ...localTrack, title: 'Replacement Scan Snapshot' }

    ;(globalThis as Record<string, unknown>).window = {
      api: {
        data: {
          loadMusicLibrary: async () => ({ tracks: [localTrack], folders: [] }),
          saveMusicLibrary: async () => {
            saveCalls += 1
            return { version: 2, revision: 1, tracks: [replacement], folders: [], exclusions: [] }
          },
          savePlaylists: async () => {},
          loadPlaylists: async () => []
        },
        providers: {
          list: async () => [
            {
              id: 'scan-replacement-test',
              name: 'NetEase',
              capabilities: ['search'],
              health: { available: true }
            }
          ],
          call: async () => {
            providerCalls += 1
            if (providerCalls === 1) {
              markFirstStarted?.()
              return await firstSearch
            }
            return await secondSearch
          }
        }
      }
    }

    const store = useMusicStore()
    store.clearTracks()
    await store.loadLibrary()
    await firstStarted

    await store.handleLibraryChange({
      kind: 'scan',
      update: {
        jobId: 'replacement-scan',
        mode: 'watch',
        state: 'completed',
        libraryRevision: 2,
        exclusions: [],
        addedTracks: [],
        updatedTracks: [replacement],
        removedFilePaths: [],
        parsedFileCount: 1,
        skippedUnchanged: 0
      }
    })

    ;(resolveFirstSearch as ((value: unknown) => void) | null)?.({
      items: [
        {
          ...localTrack,
          id: 'ncm:late-scan-result',
          filePath: 'ncm:late-scan-result',
          fileName: localTrack.title,
          album: 'Stale Provider Album',
          cover: 'https://cover.example/stale.jpg',
          lyrics: '[00:00.00]stale',
          source: 'ncm'
        }
      ],
      total: 1
    })
    await waitFor(() => providerCalls === 2)
    await Promise.resolve()

    assert.equal(store.tracks.value[0], replacement)
    assert.equal(store.tracks.value[0].album, '')
    assert.equal(store.tracks.value[0].cover, null)
    await delay(650)
    assert.equal(saveCalls, 0)

    assert.equal(store.cancelLibraryMetadataEnrichment(), true)
    ;(resolveSecondSearch as ((value: unknown) => void) | null)?.({ items: [], total: 0 })
    await Promise.resolve()
    store.clearTracks()
  }
)

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
