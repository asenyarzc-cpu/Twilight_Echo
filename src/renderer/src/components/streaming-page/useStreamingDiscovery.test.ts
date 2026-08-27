import assert from 'node:assert/strict'
import test from 'node:test'
import type { NcmPlaylistSummary } from '../../stores/useNcmStore.ts'

const { useStreamingDiscovery, DISCOVERY_PAGE_SIZE } = (await import(
  new URL('./useStreamingDiscovery.ts', import.meta.url).href
)) as typeof import('./useStreamingDiscovery')

const catalogueFixture = {
  hotTags: ['华语', '流行'],
  groups: [
    {
      id: 0,
      name: '语种',
      tags: [
        { name: '华语', hot: true },
        { name: '欧美', hot: false }
      ]
    }
  ]
}

function playlist(id: number): NcmPlaylistSummary {
  return {
    id,
    name: `playlist-${id}`,
    cover: null,
    trackCount: id,
    playCount: id * 100
  }
}

function discoveryPage(ids: number[], offset = 0, total = 100) {
  return {
    items: ids.map(playlist),
    total,
    hasMore: offset + ids.length < total,
    offset,
    limit: DISCOVERY_PAGE_SIZE
  }
}

test('ensureLoaded fetches the catalogue and first page exactly once', async () => {
  let catalogueCalls = 0
  let listCalls = 0
  const discovery = useStreamingDiscovery({
    fetchPlaylistCategories: async () => {
      catalogueCalls++
      return catalogueFixture
    },
    fetchDiscoveryPlaylists: async (_cat, _order, _limit, offset = 0) => {
      listCalls++
      return discoveryPage([1, 2], offset)
    },
    fetchHighQualityPlaylists: async () => ({ items: [], total: 0, hasMore: false, lasttime: 0 })
  })

  await discovery.ensureLoaded()
  await discovery.ensureLoaded()

  assert.equal(catalogueCalls, 1)
  assert.equal(listCalls, 1)
  assert.deepEqual(discovery.catalogue.value, catalogueFixture)
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [1, 2]
  )
})

test('selectTag resets the offset, refetches with the new tag, and collapses the panel', async () => {
  const requests: Array<{ cat?: string; order?: string; offset?: number }> = []
  const discovery = useStreamingDiscovery({
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async (cat, order, _limit, offset) => {
      requests.push({ cat, order, offset })
      return discoveryPage([10], offset ?? 0)
    },
    fetchHighQualityPlaylists: async () => ({ items: [], total: 0, hasMore: false, lasttime: 0 })
  })

  await discovery.ensureLoaded()
  discovery.onPageChange({ first: 60 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(discovery.offset.value, 60)

  discovery.panelExpanded.value = true
  discovery.selectTag('欧美')
  await new Promise((resolve) => setTimeout(resolve, 0))

  const last = requests[requests.length - 1]
  assert.equal(last.cat, '欧美')
  assert.equal(last.offset, 0)
  assert.equal(discovery.offset.value, 0)
  assert.equal(discovery.selectedTag.value, '欧美')
  assert.equal(discovery.panelExpanded.value, false)
})

test('stale responses are discarded when a newer request resolves first', async () => {
  let resolveSlow: ((page: ReturnType<typeof discoveryPage>) => void) | null = null
  let call = 0
  const discovery = useStreamingDiscovery({
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async (cat) => {
      call++
      if (call === 1) {
        return new Promise((resolve) => {
          resolveSlow = resolve
        })
      }
      assert.equal(cat, '欧美')
      return discoveryPage([2])
    },
    fetchHighQualityPlaylists: async () => ({ items: [], total: 0, hasMore: false, lasttime: 0 })
  })

  const first = discovery.ensureLoaded()
  discovery.selectTag('欧美')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [2]
  )
  ;(resolveSlow as ((page: ReturnType<typeof discoveryPage>) => void) | null)?.(discoveryPage([1]))
  await first
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [2]
  )
  assert.equal(discovery.listLoading.value, false)
})

test('high-quality mode appends via loadMore threading lasttime as the cursor', async () => {
  const beforeValues: number[] = []
  const discovery = useStreamingDiscovery({
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async () => discoveryPage([1]),
    fetchHighQualityPlaylists: async (_cat, _limit, before = 0) => {
      beforeValues.push(before)
      if (before === 0) {
        return { items: [playlist(11)], total: 2, hasMore: true, lasttime: 1800 }
      }
      return { items: [playlist(12)], total: 2, hasMore: false, lasttime: 1600 }
    }
  })

  await discovery.ensureLoaded()
  discovery.toggleHighQuality()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [11]
  )

  await discovery.loadMore()
  assert.deepEqual(beforeValues, [0, 1800])
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [11, 12]
  )
  assert.equal(discovery.hasMore.value, false)

  await discovery.loadMore()
  assert.deepEqual(beforeValues, [0, 1800])
})

test('list errors populate listError and retry refetches from the start', async () => {
  let fail = true
  let offsetSeen: number | undefined
  const discovery = useStreamingDiscovery({
    fetchPlaylistCategories: async () => catalogueFixture,
    fetchDiscoveryPlaylists: async (_cat, _order, _limit, offset) => {
      if (fail) throw new Error('网络异常')
      offsetSeen = offset
      return discoveryPage([5], offset ?? 0)
    },
    fetchHighQualityPlaylists: async () => ({ items: [], total: 0, hasMore: false, lasttime: 0 })
  })

  await discovery.ensureLoaded()
  assert.equal(discovery.listError.value, '网络异常')
  assert.deepEqual(discovery.playlists.value, [] as NcmPlaylistSummary[])

  fail = false
  discovery.retry()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(discovery.listError.value, '')
  assert.equal(offsetSeen, 0)
  assert.deepEqual(
    discovery.playlists.value.map((item) => item.id),
    [5]
  )
})
