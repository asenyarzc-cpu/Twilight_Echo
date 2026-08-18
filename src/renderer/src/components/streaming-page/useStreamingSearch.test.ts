import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { SearchSourceOption } from './useStreamingSearch.ts'

const { useStreamingSearch } = (await import(
  new URL('./useStreamingSearch.ts', import.meta.url).href
)) as typeof import('./useStreamingSearch')

const localTrack = {
  id: 'local:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Local Album',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 10_000,
  cover: null,
  lyrics: null,
  source: 'local',
  format: 'flac'
}

const providerTrack = {
  id: 'ncm:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Online Album',
  filePath: 'ncm:moon',
  fileName: 'Moon River',
  duration: 180,
  size: 0,
  cover: null,
  lyrics: null,
  source: 'ncm'
}

const defaultSources = ref<SearchSourceOption[]>([
  {
    id: 'all',
    label: '全部',
    available: true,
    supportedTypes: ['songs', 'playlists', 'artists']
  },
  { id: 'local', label: '本地音乐', available: true, supportedTypes: ['songs'] },
  {
    id: 'ncm',
    label: '网易云',
    available: true,
    supportedTypes: ['songs', 'playlists', 'artists']
  }
])

test('song search uses unified local and provider results when available', async () => {
  let legacySearchCalls = 0
  let unifiedSearchQuery = ''
  const search = useStreamingSearch({
    searchSongs: async () => {
      legacySearchCalls++
      return { tracks: [providerTrack], total: 1 }
    },
    searchUnifiedSongs: async (keywords) => {
      unifiedSearchQuery = keywords
      return { tracks: [localTrack, providerTrack], total: 2 }
    },
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchSources: defaultSources,
    playTrack: () => {}
  })
  search.searchSource.value = 'all'
  search.searchQuery.value = 'Moon River'

  await search.performSearch('Moon River')

  assert.equal(unifiedSearchQuery, 'Moon River')
  assert.equal(legacySearchCalls, 0)
  assert.deepEqual(
    search.searchResults.value.map((track) => track.id),
    ['local:moon', 'ncm:moon']
  )
  assert.equal(search.searchTotal.value, 2)
})

test('song result click plays the visible unified result queue', async () => {
  let playedTrackId = ''
  let queueIds: string[] = []
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchUnifiedSongs: async () => ({ tracks: [localTrack, providerTrack], total: 2 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchSources: defaultSources,
    playTrack: (track, queue) => {
      playedTrackId = track.id
      queueIds = queue?.map((item) => item.id) ?? []
    }
  })
  search.searchSource.value = 'all'
  search.searchQuery.value = 'Moon River'
  await search.performSearch('Moon River')

  search.onSearchTrackClick(providerTrack)

  assert.equal(playedTrackId, 'ncm:moon')
  assert.deepEqual(queueIds, ['local:moon', 'ncm:moon'])
})

test('switching source routes to per-provider search', async () => {
  let providerSearchCalls = 0
  let providerSearchId = ''
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [providerTrack], total: 1 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchProviderSongs: async (providerId, keywords) => {
      providerSearchCalls++
      providerSearchId = providerId
      assert.equal(keywords, 'Moon River')
      return { tracks: [providerTrack], total: 1 }
    },
    searchSources: defaultSources,
    playTrack: () => {}
  })
  search.searchSource.value = 'ncm'
  search.searchQuery.value = 'Moon River'

  await search.performSearch('Moon River')

  assert.equal(providerSearchCalls, 1)
  assert.equal(providerSearchId, 'ncm')
  assert.deepEqual(
    search.searchResults.value.map((track) => track.id),
    ['ncm:moon']
  )
})

test('availableSearchTypes reflects the selected source capabilities', async () => {
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchSources: defaultSources,
    playTrack: () => {}
  })

  assert.deepEqual(search.availableSearchTypes.value, ['songs', 'playlists', 'artists'])

  search.searchSource.value = 'local'
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(search.availableSearchTypes.value, ['songs'])
  assert.equal(search.searchType.value, 'songs', 'searchType should auto-switch to songs for local')
})

test('a late search response cannot overwrite a newer source and page snapshot', async () => {
  let resolveProvider!: () => void
  let resolveUnified!: () => void
  const providerPending = new Promise<void>((resolve) => {
    resolveProvider = resolve
  })
  const unifiedPending = new Promise<void>((resolve) => {
    resolveUnified = resolve
  })
  const calls: Array<{ source: string; offset: number }> = []
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchUnifiedSongs: async (_query, _limit, offset = 0) => {
      calls.push({ source: 'all', offset })
      await unifiedPending
      return { tracks: [{ ...localTrack, id: 'all:page-30' }], total: 31 }
    },
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchProviderSongs: async (providerId, _query, _limit, offset = 0) => {
      calls.push({ source: providerId, offset })
      await providerPending
      return { tracks: [{ ...providerTrack, id: 'ncm:page-0' }], total: 31 }
    },
    searchSources: defaultSources,
    playTrack: () => {}
  })

  search.searchSource.value = 'ncm'
  search.searchQuery.value = 'moon'
  await new Promise((resolve) => setTimeout(resolve, 0))
  search.searchOffset.value = 0
  const oldRequest = search.performSearch('moon')

  search.searchSource.value = 'all'
  await new Promise((resolve) => setTimeout(resolve, 0))
  search.searchOffset.value = 30
  const newestRequest = search.performSearch('moon')
  resolveUnified()
  await newestRequest
  resolveProvider()
  await oldRequest

  assert.deepEqual(calls, [
    { source: 'ncm', offset: 0 },
    { source: 'all', offset: 30 }
  ])
  assert.deepEqual(
    search.searchResults.value.map((track) => track.id),
    ['all:page-30']
  )
  assert.equal(search.searchOffset.value, 30)
  assert.equal(search.searchLoading.value, false)
})
