import { getCurrentInstance, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type {
  MediaProviderDiscoveryPlaylistPage,
  MediaProviderHighQualityPlaylistPage,
  MediaProviderPlaylistCatalogue,
  MediaProviderPlaylistSummary
} from '../../providers/mediaProvider'
import type { PageState } from './types'

export type DiscoveryOrder = 'hot' | 'new'

export const DISCOVERY_ALL_TAG = '全部'
export const DISCOVERY_PAGE_SIZE = 30

type UseStreamingDiscoveryOptions = {
  providerId: Ref<string>
  fetchPlaylistCategories?: (providerId: string) => Promise<MediaProviderPlaylistCatalogue>
  fetchDiscoveryPlaylists: (
    providerId: string,
    cat?: string,
    order?: DiscoveryOrder,
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderDiscoveryPlaylistPage>
  fetchHighQualityPlaylists?: (
    providerId: string,
    cat?: string,
    limit?: number,
    before?: number
  ) => Promise<MediaProviderHighQualityPlaylistPage>
}

export function useStreamingDiscovery({
  providerId,
  fetchPlaylistCategories,
  fetchDiscoveryPlaylists,
  fetchHighQualityPlaylists
}: UseStreamingDiscoveryOptions): {
  catalogue: Ref<MediaProviderPlaylistCatalogue | null>
  catalogueLoading: Ref<boolean>
  catalogueError: Ref<string>
  selectedTag: Ref<string>
  order: Ref<DiscoveryOrder>
  highQuality: Ref<boolean>
  panelExpanded: Ref<boolean>
  playlists: Ref<MediaProviderPlaylistSummary[]>
  total: Ref<number>
  offset: Ref<number>
  hasMore: Ref<boolean>
  listLoading: Ref<boolean>
  listError: Ref<string>
  loadingMore: Ref<boolean>
  ensureLoaded: () => Promise<void>
  selectTag: (name: string) => void
  setOrder: (next: DiscoveryOrder) => void
  toggleHighQuality: () => void
  togglePanel: () => void
  onPageChange: (event: PageState) => void
  loadMore: () => Promise<void>
  retry: () => void
} {
  const catalogue = ref<MediaProviderPlaylistCatalogue | null>(null)
  const catalogueLoading = ref(false)
  const catalogueError = ref('')
  const selectedTag = ref(DISCOVERY_ALL_TAG)
  const order = ref<DiscoveryOrder>('hot')
  const highQuality = ref(false)
  const panelExpanded = ref(false)
  const playlists = ref<MediaProviderPlaylistSummary[]>([])
  const total = ref(0)
  const offset = ref(0)
  const hasMore = ref(false)
  const listLoading = ref(false)
  const listError = ref('')
  const loadingMore = ref(false)

  let latestRequestId = 0
  let hqBefore = 0
  let loadedOnce = false
  let loadedProviderId = providerId.value

  async function loadCatalogue(force = false): Promise<void> {
    if (!fetchPlaylistCategories) return
    if (catalogueLoading.value) return
    if (catalogue.value && !force) return
    catalogueLoading.value = true
    catalogueError.value = ''
    const requestProviderId = loadedProviderId
    try {
      const nextCatalogue = await fetchPlaylistCategories(requestProviderId)
      if (requestProviderId !== loadedProviderId) return
      catalogue.value = nextCatalogue
    } catch (error) {
      if (requestProviderId !== loadedProviderId) return
      catalogueError.value = error instanceof Error ? error.message : '加载歌单分类失败'
    } finally {
      if (requestProviderId === loadedProviderId) catalogueLoading.value = false
    }
  }

  async function loadPage(nextOffset: number): Promise<void> {
    const requestId = ++latestRequestId
    listLoading.value = true
    listError.value = ''
    try {
      if (highQuality.value) {
        hqBefore = 0
        if (!fetchHighQualityPlaylists) return
        const page = await fetchHighQualityPlaylists(
          loadedProviderId,
          selectedTag.value,
          DISCOVERY_PAGE_SIZE,
          0
        )
        if (requestId !== latestRequestId) return
        playlists.value = page.items
        total.value = page.total
        hasMore.value = page.hasMore
        hqBefore = page.lasttime
        offset.value = 0
      } else {
        const page = await fetchDiscoveryPlaylists(
          loadedProviderId,
          selectedTag.value,
          order.value,
          DISCOVERY_PAGE_SIZE,
          nextOffset
        )
        if (requestId !== latestRequestId) return
        playlists.value = page.items
        total.value = page.total
        hasMore.value = page.hasMore
        offset.value = page.offset
      }
    } catch (error) {
      if (requestId !== latestRequestId) return
      listError.value = error instanceof Error ? error.message : '加载歌单失败'
      playlists.value = []
      total.value = 0
      hasMore.value = false
    } finally {
      if (requestId === latestRequestId) {
        listLoading.value = false
      }
    }
  }

  async function ensureLoaded(): Promise<void> {
    void loadCatalogue()
    if (loadedOnce && (playlists.value.length > 0 || listLoading.value)) return
    loadedOnce = true
    await loadPage(0)
  }

  function reloadFromStart(): void {
    offset.value = 0
    hqBefore = 0
    void loadPage(0)
  }

  function selectTag(name: string): void {
    const next = typeof name === 'string' && name.trim() ? name.trim() : DISCOVERY_ALL_TAG
    if (selectedTag.value !== next) {
      selectedTag.value = next
      reloadFromStart()
    }
    panelExpanded.value = false
  }

  function setOrder(next: DiscoveryOrder): void {
    if (order.value === next) return
    order.value = next
    if (!highQuality.value) reloadFromStart()
  }

  function toggleHighQuality(): void {
    if (!fetchHighQualityPlaylists) return
    highQuality.value = !highQuality.value
    playlists.value = []
    reloadFromStart()
  }

  function togglePanel(): void {
    panelExpanded.value = !panelExpanded.value
  }

  function onPageChange(event: PageState): void {
    if (highQuality.value) return
    void loadPage(Math.max(0, event.first))
  }

  async function loadMore(): Promise<void> {
    if (!highQuality.value || loadingMore.value || listLoading.value || !hasMore.value) return
    const requestId = ++latestRequestId
    loadingMore.value = true
    try {
      if (!fetchHighQualityPlaylists) return
      const page = await fetchHighQualityPlaylists(
        loadedProviderId,
        selectedTag.value,
        DISCOVERY_PAGE_SIZE,
        hqBefore
      )
      if (requestId !== latestRequestId) return
      const seen = new Set(playlists.value.map((item) => item.id))
      playlists.value = [...playlists.value, ...page.items.filter((item) => !seen.has(item.id))]
      total.value = page.total
      hasMore.value = page.hasMore
      hqBefore = page.lasttime
    } catch (error) {
      if (requestId !== latestRequestId) return
      listError.value = error instanceof Error ? error.message : '加载更多歌单失败'
    } finally {
      if (requestId === latestRequestId) {
        loadingMore.value = false
      }
    }
  }

  function retry(): void {
    if (catalogueError.value) void loadCatalogue(true)
    reloadFromStart()
  }

  function resetForProvider(nextProviderId: string): void {
    loadedProviderId = nextProviderId
    latestRequestId += 1
    catalogue.value = null
    catalogueLoading.value = false
    catalogueError.value = ''
    selectedTag.value = DISCOVERY_ALL_TAG
    order.value = 'hot'
    highQuality.value = false
    panelExpanded.value = false
    playlists.value = []
    total.value = 0
    offset.value = 0
    hasMore.value = false
    listLoading.value = false
    listError.value = ''
    loadingMore.value = false
    hqBefore = 0
    loadedOnce = false
  }

  watch(providerId, (nextProviderId) => {
    if (nextProviderId !== loadedProviderId) resetForProvider(nextProviderId)
  })

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      latestRequestId += 1
    })
  }

  return {
    catalogue,
    catalogueLoading,
    catalogueError,
    selectedTag,
    order,
    highQuality,
    panelExpanded,
    playlists,
    total,
    offset,
    hasMore,
    listLoading,
    listError,
    loadingMore,
    ensureLoaded,
    selectTag,
    setOrder,
    toggleHighQuality,
    togglePanel,
    onPageChange,
    loadMore,
    retry
  }
}
