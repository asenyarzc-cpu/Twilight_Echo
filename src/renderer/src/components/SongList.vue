<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LocalLibraryTagPatch } from '../../../shared/localLibraryTags.ts'
import { useUnifiedMusicSearch } from '../app/useUnifiedMusicSearch'
import { syncPluginProviders, useMediaProviders } from '../providers'
import { useMusicStore } from '../stores/useMusicStore'
import { usePlayerStore } from '../stores/usePlayerStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { usePlaybackBookmarks } from '../stores/playbackBookmarks'
import { useProviderStore } from '../stores/useProviderStore'
import { getRecentTracks, useListeningStatsStore } from '../stores/useListeningStatsStore'
import type { Track } from '../types/music'
import { resolveUnifiedRecentTracks } from '../utils/unifiedRecentTracks'
import { getTrackSearchBlob, normalizeSearchText } from '../utils/localLibrarySearch'
import { getTrackSource as getLogicalTrackSource } from '../utils/logicalTrackModel'
import { useEscapeToClose } from '../app/useDismissLayer.ts'
import { buildMetadataMatchCandidates } from '../utils/musicMetadataMatching'
import {
  applyLibraryCollectionView,
  availableCollectionGenres,
  availableCollectionLetters,
  AZ_INDEX_LETTERS,
  collectionIndexLetter,
  firstCollectionIndexForLetter,
  LibraryCollectionViewPreferences,
  type LibraryCollectionSort,
  type LibraryCollectionViewState
} from '../utils/libraryCollectionView.ts'
import {
  formatPlaylistSourceSummary,
  summarizePlaylistSources
} from '../utils/playlistSourceSummary'
import { PLAYLIST_EXPORT_FORMATS } from '../utils/playlistExport.ts'
import { selectLocalLibraryActionTracks } from '../utils/localTrackRemovalPolicy'
import {
  applyLibraryView,
  createDefaultLibraryViewState,
  libraryViewKey,
  LibraryViewPreferences,
  trackFolder,
  type LibrarySortDirection,
  type LibrarySortKey,
  type LibraryViewFilters,
  type LibraryViewState
} from '../utils/libraryViewPreferences.ts'
import CoverImg from './CoverImg.vue'
import LocalLibraryTagManager from './LocalLibraryTagManager.vue'
import ThemeIcon from './ThemeIcon.vue'
import { formatDuration } from './song-list/formatDuration'
import type { GridItem } from './song-list/types'
import { useSongListContextMenu } from './song-list/useSongListContextMenu'
import { useSongListGridRendering } from './song-list/useSongListGridRendering'
import { usePlaylistLifecycleActions } from './song-list/usePlaylistLifecycleActions.ts'
import { useSongListSearch } from './song-list/useSongListSearch'
import { useSongListVirtualScroll } from './song-list/useSongListVirtualScroll'
import { useTrackMultiSelect } from './song-list/useTrackMultiSelect'

const props = defineProps<{
  category: string
  filter: string | null
  hasPlayer: boolean
  transitionName: 'page-down' | 'page-up'
}>()

const emit = defineEmits<{
  selectView: [category: string, filter: string | null]
  customizeAppearance: []
}>()

const {
  tracks,
  artists,
  albums,
  genres,
  playlists,
  folders,
  libraryRepairReport,
  excludedTracks,
  getPlaylistTracks,
  removeTrack,
  removeLocalTracks,
  restoreExcludedTracks,
  applyLocalTagWrite,
  clearTrackMetadataMatch,
  applyTrackMetadataMatch,
  refreshLibraryIndex,
  addToPlaylist,
  removeFromPlaylist,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  replaceTrackReference,
  createPlaylist,
  createPlaylistWithTracks,
  deletePlaylist,
  isFavoriteTrack,
  setFavoriteTracks
} = useMusicStore()
const playbackStore = usePlayerStore()
const settingsStore = useSettingsStore()
const { currentTrack } = playbackStore
const { playTrack, playTrackFromPosition, setPlayMode, playNextTrack } = playbackStore
const playbackBookmarks = usePlaybackBookmarks()
void playbackBookmarks.ensureLoaded()
const mediaProviders = useMediaProviders()
const unifiedSearch = useUnifiedMusicSearch()
const providerStore = useProviderStore()
const { listeningStats } = useListeningStatsStore()

const { searchQuery, debouncedSearchQuery, searchInputFocused } = useSongListSearch()

// ─── Recent playback source selector ──────────────────────────────────────
const recentSource = ref('local')
const recentSourceMenuOpen = ref(false)

const recentSourceOptions = computed(() => {
  const options = [
    { id: 'local', label: '本地音乐', icon: 'pi pi-desktop' },
    { id: 'all', label: '全平台', icon: 'pi pi-bolt' }
  ]
  for (const provider of providerStore.providers.value) {
    if (provider.capabilities.includes('library')) {
      options.push({
        id: provider.id,
        label: provider.name,
        icon: provider.ui?.icon || 'pi pi-cloud'
      })
    }
  }
  return options
})

const activeRecentSourceLabel = computed(
  () => recentSourceOptions.value.find((o) => o.id === recentSource.value)?.label ?? '本地音乐'
)

function selectRecentSource(sourceId: string): void {
  recentSourceMenuOpen.value = false
  recentSource.value = sourceId
}

function closeRecentSourceMenuDelayed(): void {
  setTimeout(() => {
    recentSourceMenuOpen.value = false
  }, 150)
}

// ─── 库管理下拉（重复检查 + 已移除） ────────────────────────────────────────
const libraryToolsMenuOpen = ref(false)

const baseDisplayTracks = computed(() => {
  if (props.category === 'allSongs') return tracks.value
  if (props.category === 'recent') {
    const recentStats = getRecentTracks()
    const source = recentSource.value
    if (source === 'all') {
      return resolveUnifiedRecentTracks({ recentStats, localTracks: tracks.value })
    }
    const filteredStats =
      source === 'local'
        ? recentStats.filter((stat) => stat.sourceIds?.some((sid) => sid.source === 'local'))
        : recentStats.filter((stat) => stat.sourceIds?.some((sid) => sid.source === source))
    return resolveUnifiedRecentTracks({ recentStats: filteredStats, localTracks: tracks.value })
  }
  if (props.filter) {
    if (props.filter.startsWith('artist:')) {
      const name = props.filter.slice(7)
      return artists.value.find((artist) => artist.name === name)?.tracks ?? []
    }
    if (props.filter.startsWith('album:')) {
      const id = props.filter.slice(6)
      return albums.value.find((album) => album.id === id)?.tracks ?? []
    }
    if (props.filter.startsWith('genre:')) {
      const name = props.filter.slice(6)
      return genres.value.find((genre) => genre.name === name)?.tracks ?? []
    }
    if (props.filter.startsWith('playlist:')) {
      const name = props.filter.slice(9)
      return getPlaylistTracks(name)
    }
    if (props.filter.startsWith('folder:')) {
      const path = props.filter.slice(7)
      const folder = folders.value.find((f) => f.path === path)
      return folder?.tracks ?? []
    }
  }
  return []
})

const libraryViewPreferences = new LibraryViewPreferences()
const currentLibraryViewKey = computed(() => libraryViewKey(props.category, props.filter))
const libraryViewState = ref<LibraryViewState>(
  libraryViewPreferences.read(currentLibraryViewKey.value, props.category)
)

watch(
  [currentLibraryViewKey, () => props.category],
  ([viewKey, category]) => {
    libraryViewState.value = libraryViewPreferences.read(viewKey, category)
  },
  { immediate: true }
)

function updateLibraryView(next: LibraryViewState): void {
  libraryViewState.value = next
  libraryViewPreferences.write(currentLibraryViewKey.value, next)
}

function setSortKey(value: string): void {
  updateLibraryView({ ...libraryViewState.value, sortKey: value as LibrarySortKey })
}

function setSortDirection(value: string): void {
  updateLibraryView({ ...libraryViewState.value, sortDirection: value as LibrarySortDirection })
}

function setLibraryFilter<K extends keyof LibraryViewFilters>(
  key: K,
  value: LibraryViewFilters[K]
): void {
  updateLibraryView({
    ...libraryViewState.value,
    filters: { ...libraryViewState.value.filters, [key]: value }
  })
}

const libraryFilterPanelOpen = ref(false)
const libraryFilterDropdownRef = ref<HTMLElement | null>(null)

function toggleLibraryFilterPanel(): void {
  libraryFilterPanelOpen.value = !libraryFilterPanelOpen.value
  if (libraryFilterPanelOpen.value) libraryToolsMenuOpen.value = false
}

function closeLibraryFilterPanel(): void {
  libraryFilterPanelOpen.value = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!libraryFilterPanelOpen.value) return
  const root = libraryFilterDropdownRef.value
  const target = event.target
  if (!(target instanceof Node) || !root || root.contains(target)) return
  closeLibraryFilterPanel()
}

function resetLibraryFilters(): void {
  const defaults = createDefaultLibraryViewState(props.category)
  updateLibraryView({
    ...libraryViewState.value,
    sortKey: defaults.sortKey,
    sortDirection: defaults.sortDirection,
    filters: { ...defaults.filters }
  })
}

const activeLibraryFilterCount = computed(() => {
  const filters = libraryViewState.value.filters
  let count = 0
  if (filters.lossless) count += 1
  if (filters.dsd) count += 1
  if (filters.sampleRate !== null) count += 1
  if (filters.bitDepth !== null) count += 1
  if (filters.folder) count += 1
  if (filters.provider) count += 1
  return count
})

watch([() => props.category, () => props.filter], () => {
  closeLibraryFilterPanel()
  libraryToolsMenuOpen.value = false
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

const libraryFilterOptions = computed(() => {
  const values = baseDisplayTracks.value
  const sampleRates = [
    ...new Set(
      values
        .map((track) => track.sampleRate)
        .filter((value): value is number => typeof value === 'number' && value > 0)
    )
  ].sort((left, right) => left - right)
  const bitDepths = [
    ...new Set(
      values
        .map((track) => track.bitDepth)
        .filter((value): value is number => typeof value === 'number' && value > 0)
    )
  ].sort((left, right) => left - right)
  const folders = [
    ...new Set(values.map(trackFolder).filter((value): value is string => !!value))
  ].sort((left, right) => left.localeCompare(right, 'zh'))
  const providers = [...new Set(values.map((track) => getLogicalTrackSource(track)))].sort(
    (left, right) => left.localeCompare(right, 'zh')
  )
  return { sampleRates, bitDepths, folders, providers }
})

const lastPlayedByTrackId = computed(() => {
  const result = new Map<string, number>()
  for (const stat of Object.values(listeningStats.value.tracks)) {
    if (stat.track?.id) result.set(stat.track.id, stat.lastPlayed)
    for (const sourceId of stat.sourceIds ?? []) result.set(sourceId.trackId, stat.lastPlayed)
  }
  return result
})

const viewTitle = computed(() => {
  if (props.category === 'folders') {
    if (props.filter && props.filter.startsWith('folder:')) {
      return folders.value.find((f) => f.path === props.filter?.slice(7))?.name ?? '文件夹'
    }
    return '文件夹'
  }
  if (props.category === 'allSongs') return '本地音乐'
  if (props.category === 'recent') return '最近播放'
  if (props.category === 'artists') {
    if (props.filter && props.filter.startsWith('artist:')) return props.filter.slice(7)
    return '艺术家'
  }
  if (props.category === 'albums') {
    if (props.filter && props.filter.startsWith('album:')) {
      const id = props.filter.slice(6)
      return albums.value.find((album) => album.id === id)?.name ?? '专辑'
    }
    return '专辑'
  }
  if (props.category === 'genres') {
    if (props.filter && props.filter.startsWith('genre:')) return props.filter.slice(6)
    return '流派'
  }
  if (props.category === 'playlists') {
    if (props.filter && props.filter.startsWith('playlist:')) return props.filter.slice(9)
    return '歌单'
  }
  return '我的音乐'
})

const gridStatsText = computed(() => {
  const count = gridTotalCount.value
  if (count === 0) return ''
  const unit =
    props.category === 'artists'
      ? '位艺术家'
      : props.category === 'albums'
        ? '张专辑'
        : props.category === 'genres'
          ? '种流派'
          : props.category === 'playlists'
            ? '份歌单'
            : props.category === 'folders'
              ? '个文件夹'
              : '个条目'
  return `共 ${count} ${unit}`
})

const totalDurationText = computed(() => {
  let total = 0
  for (const track of displayTracks.value) total += track.duration || 0
  if (total <= 0) return ''
  const minutes = Math.round(total / 60)
  if (minutes < 1) return '不足 1 分钟'
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
})

const viewStatsText = computed(() => {
  if (props.category === 'allSongs') return ''
  const count = displayTracks.value.length
  if (count === 0) return ''
  return totalDurationText.value ? `${count} 首 · ${totalDurationText.value}` : `${count} 首`
})

const currentPlaylistName = computed(() => {
  if (props.category !== 'playlists' || !props.filter?.startsWith('playlist:')) return null
  return props.filter.slice(9)
})

const isPlaylistDetail = computed(() => currentPlaylistName.value !== null)
const isAlbumDetail = computed(
  () => props.category === 'albums' && props.filter?.startsWith('album:') === true
)

function trackListNumber(track: Track, visibleIndex: number): number {
  if (
    isAlbumDetail.value &&
    typeof track.trackNumber === 'number' &&
    Number.isFinite(track.trackNumber) &&
    track.trackNumber > 0
  ) {
    return track.trackNumber
  }
  return visibleRange.value.start + visibleIndex + 1
}

const currentPlaylist = computed(() =>
  currentPlaylistName.value
    ? (playlists.value.find((playlist) => playlist.name === currentPlaylistName.value) ?? null)
    : null
)
const repairMessage = ref('')
const showExcludedTracksDialog = ref(false)
const showTagManager = ref(false)
const tagManagerInitialView = ref<'edit' | 'duplicates'>('edit')
const tagManagerTracks = ref<Track[]>([])
const tagManagerFocusRestoreTarget = ref<HTMLElement | null>(null)
const libraryMutationPending = ref(false)
const exclusionRestorePending = ref(false)
const searchOnlineSongs = ref(false)

const showOnlineSearchToggle = computed(() => props.category === 'allSongs' && !props.filter)
const shouldUseUnifiedSearch = computed(
  () => showOnlineSearchToggle.value && searchOnlineSongs.value
)

const libraryRepairStatusText = computed(() => {
  if (props.category !== 'allSongs' || props.filter) return ''
  const report = libraryRepairReport.value
  if (!report || (report.repairedCount === 0 && report.unresolvedCount === 0)) return ''
  const parts: string[] = []
  if (report.repairedCount > 0) parts.push(`已自动重定位 ${report.repairedCount} 首`)
  if (report.unresolvedCount > 0) {
    parts.push(`${report.unresolvedCount} 首本地文件未找到，可右键重新匹配音源`)
  }
  return parts.join('，')
})

watch(
  [debouncedSearchQuery, () => props.category, () => props.filter, searchOnlineSongs],
  ([query]) => {
    const q = query.trim()
    if (!q || !shouldUseUnifiedSearch.value) {
      unifiedSearch.clear()
      return
    }
    void unifiedSearch.search(q, { limit: 100, offset: 0 })
  },
  { immediate: true }
)

const searchedTracks = computed(() => {
  const q = debouncedSearchQuery.value.trim()
  if (!q) return baseDisplayTracks.value
  if (shouldUseUnifiedSearch.value) {
    return unifiedSearch.items.value.map((item) => item.track)
  }
  const normalizedQuery = normalizeSearchText(q)
  if (!normalizedQuery) return baseDisplayTracks.value
  return baseDisplayTracks.value.filter((t) => getTrackSearchBlob(t).includes(normalizedQuery))
})

const displayTracks = computed(() =>
  applyLibraryView(searchedTracks.value, libraryViewState.value, lastPlayedByTrackId.value)
)

const unifiedSearchSourceNames = computed(
  () => new Map(unifiedSearch.items.value.map((item) => [item.track.id, item.sourceName]))
)

const showUnifiedSearchStatus = computed(
  () => shouldUseUnifiedSearch.value && debouncedSearchQuery.value.trim().length > 0
)

const unifiedSearchHealthItems = computed(() =>
  Object.values(unifiedSearch.providerHealth.value).map((health) => ({
    ...health,
    state: unifiedSearchHealthState(health),
    label: unifiedSearchHealthLabel(health),
    detail: unifiedSearchHealthDetail(health)
  }))
)

const unifiedSearchStatusText = computed(() => {
  if (!showUnifiedSearchStatus.value) return ''
  if (unifiedSearch.loading.value) return '正在同时搜索本地库和在线音源'
  if (unifiedSearch.error.value) return `统一搜索失败：${unifiedSearch.error.value}`
  const providerCount = unifiedSearchHealthItems.value.length
  const failedCount = unifiedSearchHealthItems.value.filter((item) => item.state === 'error').length
  const resultCount = displayTracks.value.length
  if (failedCount > 0)
    return `找到 ${resultCount} 首，${failedCount}/${providerCount} 个在线音源不可用`
  return `找到 ${resultCount} 首，已合并本地库和 ${providerCount} 个在线音源`
})

const showDetailBackButton = computed(() => {
  // Top-level views (including recent / all songs) are reached from the side
  // menu; a back button that only clears the filter is a no-op there.
  return !!props.filter
})

const showGrid = computed(() => {
  if (props.category === 'allSongs' || props.category === 'recent') return false
  return !props.filter
})

const showTable = computed(() => {
  if (props.category === 'allSongs' || props.category === 'recent') return true
  return !!props.filter
})

const isCollectionGrid = computed(
  () => showGrid.value && (props.category === 'artists' || props.category === 'albums')
)
const collectionViewPreferences = new LibraryCollectionViewPreferences()
const collectionViewState = ref<LibraryCollectionViewState>(
  collectionViewPreferences.read(props.category)
)
const activeCollectionLetter = ref<string | null>(null)

watch(
  () => props.category,
  (category) => {
    if (category === 'artists' || category === 'albums') {
      collectionViewState.value = collectionViewPreferences.read(category)
    }
    activeCollectionLetter.value = null
  }
)

function updateCollectionView(next: LibraryCollectionViewState): void {
  collectionViewState.value = next
  collectionViewPreferences.write(props.category, next)
  activeCollectionLetter.value = null
}

function setCollectionSort(value: string): void {
  updateCollectionView({ ...collectionViewState.value, sort: value as LibraryCollectionSort })
}

function setCollectionGenre(value: string): void {
  updateCollectionView({ ...collectionViewState.value, genre: value || null })
}

const baseCollectionItems = computed<GridItem[]>(() => {
  if (props.category === 'artists') return artists.value
  if (props.category === 'albums') return albums.value
  return []
})
const collectionGenreOptions = computed(() =>
  availableCollectionGenres(baseCollectionItems.value, settingsStore.settings.value.genreSeparators)
)
const collectionGridItems = computed(() =>
  applyLibraryCollectionView(
    baseCollectionItems.value,
    collectionViewState.value,
    settingsStore.settings.value.genreSeparators
  )
)

watch(
  () => settingsStore.settings.value.genreSeparators,
  () => refreshLibraryIndex()
)
const currentGridItems = computed<GridItem[]>(() => {
  if (isCollectionGrid.value) return collectionGridItems.value
  if (props.category === 'genres') return genres.value
  if (props.category === 'playlists') return playlists.value
  if (props.category === 'folders') return folders.value
  return []
})

function onRowDblClick(track: Track, event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('.btn-remove') || target.closest('.track-select-checkbox')) return
  if (multiSelect.shouldSuppressRowDoubleClick(event)) return
  if (settingsStore.settings.value.trackActivationMode !== 'doubleClick') return
  if (track.source === 'network') {
    void playNetworkTrack(track)
    return
  }
  playTrack(track, displayTracks.value)
}

async function playNetworkTrack(track: Track): Promise<void> {
  const network = track.networkSource
  if (!network || !window.api?.networkSources) return
  try {
    const plan = await window.api.networkSources.resolvePlayback(network.profileId, network.entry)
    const resolved: Track = {
      ...track,
      filePath: plan.kind === 'direct-url' ? (plan.url ?? '') : (plan.cacheFilePath ?? '')
    }
    playTrack(resolved, [resolved])
  } catch (err) {
    unifiedSearch.error.value = `网络源播放失败：${err instanceof Error ? err.message : String(err)}`
  }
}

function playAllTracks(): void {
  const list = displayTracks.value
  if (list.length === 0) return
  playTrack(list[0], list)
}

function shufflePlayTracks(): void {
  const list = displayTracks.value
  if (list.length === 0) return
  setPlayMode('shuffle')
  playTrack(list[Math.floor(Math.random() * list.length)], list)
}

function trackQualityLabel(track: Track): string {
  const parts: string[] = []
  if (track.format) parts.push(track.format.toUpperCase())
  if (typeof track.sampleRate === 'number' && track.sampleRate > 0) {
    const khz = track.sampleRate / 1000
    parts.push(`${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`)
  }
  if (typeof track.bitDepth === 'number' && track.bitDepth > 0) parts.push(`${track.bitDepth} bit`)
  return parts.join(' · ')
}

function metadataMatchLabel(track: Track): string {
  const match = track.metadataMatch
  if (!match) return ''
  const confidence = match.confidence === 'high' ? '高置信度' : '中置信度'
  return `已匹配 ${match.providerId} · ${confidence}`
}

function metadataMatchTitle(track: Track): string {
  const match = track.metadataMatch
  if (!match) return ''
  const confidence = match.confidence === 'high' ? '高置信度' : '中置信度'
  return `流媒体元数据匹配：${match.providerId} / ${match.trackId} · ${confidence} · ${match.score} 分`
}

function unifiedSearchHealthLabel(health: {
  searchable: boolean
  available: boolean
  resultCount: number
  lastError: string | null
  pluginStatus: string | null
  playbackUrlSuccessRate: number | null
}): string {
  if (health.pluginStatus && health.pluginStatus !== 'enabled') return `插件 ${health.pluginStatus}`
  if (!health.searchable) return '不支持搜索'
  if (health.lastError) return health.lastError
  if (!health.available) return '音源不可用'
  if (health.playbackUrlSuccessRate !== null && health.playbackUrlSuccessRate < 0.95) {
    return `播放 URL ${formatPercent(health.playbackUrlSuccessRate)}`
  }
  return `${health.resultCount} 首`
}

function unifiedSearchHealthState(health: {
  searchable: boolean
  available: boolean
  lastError: string | null
  pluginStatus: string | null
  successRate: number | null
  playbackUrlSuccessRate: number | null
}): 'ok' | 'warning' | 'error' {
  if (health.pluginStatus && health.pluginStatus !== 'enabled') return 'error'
  if (!health.searchable || !health.available || health.lastError) return 'error'
  if (
    (health.successRate !== null && health.successRate < 0.95) ||
    (health.playbackUrlSuccessRate !== null && health.playbackUrlSuccessRate < 0.95)
  ) {
    return 'warning'
  }
  return 'ok'
}

function unifiedSearchHealthDetail(health: {
  searchable: boolean
  available: boolean
  resultCount: number
  lastError: string | null
  pluginStatus: string | null
  successRate: number | null
  playbackUrlSuccessRate: number | null
  playbackUrlLastError: string | null
  lastCheckedAt: string | null
}): string {
  return [
    `搜索 ${health.searchable ? '支持' : '不支持'}`,
    `可用性 ${health.available ? '可用' : '不可用'}`,
    health.pluginStatus ? `插件 ${health.pluginStatus}` : '',
    health.successRate !== null ? `API 成功率 ${formatPercent(health.successRate)}` : '',
    health.playbackUrlSuccessRate !== null
      ? `播放 URL 成功率 ${formatPercent(health.playbackUrlSuccessRate)}`
      : '',
    `结果 ${health.resultCount} 首`,
    health.lastError ? `最近错误 ${health.lastError}` : '',
    health.playbackUrlLastError ? `播放 URL 最近错误 ${health.playbackUrlLastError}` : '',
    health.lastCheckedAt ? `最后检查 ${health.lastCheckedAt}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function trackSourceLabel(track: Track): string {
  const searchSourceName = unifiedSearchSourceNames.value.get(track.id)
  return searchSourceName || getLogicalTrackSource(track)
}

function trackSourceClass(track: Track): string {
  return getLogicalTrackSource(track) === 'local' ? 'local' : 'provider'
}

function playlistSourceSummaryLabel(playlist: GridItem): string {
  return formatPlaylistSourceSummary(summarizePlaylistSources(playlist))
}

async function handleManualRematch(track: Track): Promise<void> {
  repairMessage.value = `正在重新匹配 ${track.title || '当前曲目'}...`
  try {
    await syncPluginProviders()
    const query = [track.title, track.artist].filter(Boolean).join(' ')
    const result = await mediaProviders.searchAllSongs({
      query,
      localTracks: tracks.value,
      limit: 20,
      offset: 0
    })
    const candidates = buildMetadataMatchCandidates(
      track,
      result.items.map((item) => item.track)
    )
    const rematched = candidates[0]?.track
    if (!rematched) {
      repairMessage.value = `未找到可替换 ${track.title || '当前曲目'} 的音源`
      return
    }
    const replacedCount = replaceTrackReference(track.id, rematched)
    repairMessage.value =
      replacedCount > 0
        ? `已重新匹配到 ${rematched.source ?? getTrackSource(rematched)}：${rematched.title || track.title}`
        : `找到 ${rematched.title || track.title}，但没有需要替换的引用`
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '重新匹配音源失败'
  }
}

async function handleMetadataRematch(track: Track): Promise<void> {
  repairMessage.value = `正在匹配 ${track.title || '当前曲目'} 的流媒体元数据...`
  try {
    await syncPluginProviders()
    const query = [track.title, track.artist].filter(Boolean).join(' ')
    const result = await mediaProviders.searchAllSongs({
      query,
      localTracks: tracks.value,
      limit: 20,
      offset: 0
    })
    const candidates = buildMetadataMatchCandidates(
      track,
      result.items.map((item) => item.track)
    )
    const best = candidates[0]
    if (!best) {
      repairMessage.value = `未找到可匹配 ${track.title || '当前曲目'} 的流媒体元数据`
      return
    }
    const changed = applyTrackMetadataMatch(track.id, best.track, {
      confidence: best.confidence,
      score: best.score
    })
    repairMessage.value = changed
      ? `已匹配 ${best.sourceLabel}：${best.track.title || track.title}`
      : `找到 ${best.track.title || track.title}，但未能应用到本地曲目`
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '重新匹配流媒体元数据失败'
  }
}

const {
  showContextMenu,
  menuX,
  menuY,
  selectedTrack,
  canViewSelectedContext,
  canPlayNextSelectedTrack,
  handlePlayNext,
  handleViewArtist,
  handleViewAlbum,
  showPlaylistSubmenu,
  showCreatePlaylistDialog,
  newPlaylistName,
  onContextMenu,
  handleOpenFolder,
  canRematchSelectedTrack,
  handleRematchTrack,
  canRematchMetadataSelectedTrack,
  handleRematchMetadata,
  canClearMetadataMatchSelectedTrack,
  handleClearMetadataMatch,
  openCreatePlaylistDialog,
  handleCreatePlaylist,
  completeCreatePlaylistDialog,
  handleDeletePlaylist,
  closeContextMenu
} = useSongListContextMenu({
  currentPlaylistName,
  removeTrack,
  addToPlaylist,
  removeFromPlaylist,
  rematchTrack: handleManualRematch,
  rematchMetadata: handleMetadataRematch,
  clearMetadataMatch: (track) => {
    clearTrackMetadataMatch(track.id)
  },
  createPlaylist,
  deletePlaylist,
  playNext: playNextTrack,
  viewArtist: (track) => {
    const artist = track.artist.trim()
    if (!artist) return
    emit('selectView', 'artists', `artist:${artist}`)
  },
  viewAlbum: (track) => {
    const album = track.album?.trim()
    if (!album) return
    const albumItem = albums.value.find((item) =>
      item.tracks.some((albumTrack) => albumTrack.id === track.id)
    )
    if (!albumItem?.id) return
    emit('selectView', 'albums', `album:${albumItem.id}`)
  }
})

useEscapeToClose(showContextMenu, closeContextMenu)

const {
  containerRef,
  tbodyRef,
  rowHeight,
  visibleRange,
  visibleTracks,
  totalHeight,
  paddingTop,
  onScroll,
  onRowPointerMove,
  updateViewportHeight
} = useSongListVirtualScroll({
  displayTracks,
  resetSources: [
    () => props.category,
    () => props.filter,
    debouncedSearchQuery,
    currentLibraryViewKey,
    libraryViewState
  ],
  shouldResetOnSearch: showTable,
  debouncedSearchQuery
})
void containerRef.value
void tbodyRef.value

const multiSelect = useTrackMultiSelect({
  tracks: displayTracks,
  resetSources: [() => props.category, () => props.filter, debouncedSearchQuery, recentSource],
  enabled: showTable
})

const { selectedCount, hasSelection, isSelected, clearSelection, toggle, getSelectedTracks } =
  multiSelect

const {
  playlistImportInput,
  playlistCoverInput,
  playlistExportFormat,
  playlistRepairPending,
  triggerPlaylistImport,
  handlePlaylistImport,
  downloadPlaylistDocument,
  triggerPlaylistCoverPicker,
  handlePlaylistCover,
  handleRenamePlaylist,
  handleCopyPlaylist,
  handleMoveSelectedWithinPlaylist,
  handlePlaylistDragStart,
  handlePlaylistDrop,
  handleMoveSelectedToPlaylist,
  handlePlaylistRepair
} = usePlaylistLifecycleActions({
  currentPlaylist,
  isPlaylistDetail,
  repairMessage,
  getSelectedTracks,
  isSelected,
  clearSelection,
  selectPlaylist: (name) => emit('selectView', 'playlists', `playlist:${name}`)
})
void playlistImportInput.value
void playlistCoverInput.value

const pendingBatchCreateTracks = ref<Track[]>([])

function absoluteIndex(indexInVisible: number): number {
  return visibleRange.value.start + indexInVisible
}

function onRowClick(track: Track, indexInVisible: number, event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('.btn-remove')) return
  if (target.closest('.track-select-checkbox')) return
  if (event.detail > 1) return
  const index = absoluteIndex(indexInVisible)
  const result = multiSelect.onRowClick(track, index, event)
  if (result !== 'play') return
  if (track.source === 'network') {
    void playNetworkTrack(track)
    return
  }
  if (settingsStore.settings.value.trackActivationMode === 'doubleClick') return
  playTrack(track, displayTracks.value)
}

function onTrackSelectToggle(track: Track, indexInVisible: number, event: Event): void {
  event.stopPropagation()
  toggle(track.id, absoluteIndex(indexInVisible))
}

function onTrackContextMenu(event: MouseEvent, track: Track): void {
  onContextMenu(event, track)
}

function customizeLibraryAppearance(): void {
  closeContextMenu()
  emit('customizeAppearance')
}

const contextUsesSelection = computed(
  () => !!selectedTrack.value && isSelected(selectedTrack.value.id) && selectedCount.value > 0
)
const contextActionTracks = computed(() =>
  contextUsesSelection.value
    ? getSelectedTracks()
    : selectedTrack.value
      ? [selectedTrack.value]
      : []
)
const contextActionCount = computed(() => contextActionTracks.value.length)
const contextActionLabel = computed(() =>
  contextActionCount.value > 1 ? ` (${contextActionCount.value})` : ''
)
const contextAllFavorited = computed(() => {
  const targets = contextActionTracks.value
  return targets.length > 0 && targets.every((track) => isFavoriteTrack(track))
})
const contextLocalTrackCount = computed(
  () => selectLocalLibraryActionTracks(contextActionTracks.value).length
)
const contextLocalActionLabel = computed(() =>
  contextLocalTrackCount.value > 1 ? ` (${contextLocalTrackCount.value})` : ''
)

const selectionActionTracks = computed(() => getSelectedTracks())
const selectionAllFavorited = computed(() => {
  const selected = selectionActionTracks.value
  return selected.length > 0 && selected.every((track) => isFavoriteTrack(track))
})
const selectedLocalTrackCount = computed(
  () => selectLocalLibraryActionTracks(selectionActionTracks.value).length
)
const localSelectionActionLabel = computed(() =>
  selectedLocalTrackCount.value > 1 ? ` (${selectedLocalTrackCount.value})` : ''
)

async function runLocalLibraryRemoval(
  mode: 'library' | 'trash',
  actionTracks: Track[] = selectionActionTracks.value
): Promise<void> {
  if (libraryMutationPending.value) return
  const selected = selectLocalLibraryActionTracks(actionTracks)
  if (selected.length === 0) return
  if (
    mode === 'library' &&
    !window.confirm(
      `确定从音乐库移除选中的 ${selected.length} 首？\n文件仍保留在磁盘，不会删除；可在「已从音乐库移除」中恢复。`
    )
  ) {
    return
  }
  if (
    mode === 'trash' &&
    !window.confirm(
      `确定将选中的 ${selected.length} 个本地文件移到系统回收站吗？失败的文件会继续保留在音乐库中。`
    )
  ) {
    return
  }

  libraryMutationPending.value = true
  try {
    const result = await removeLocalTracks(selected, mode)
    const action = mode === 'trash' ? '移到回收站' : '从音乐库移除'
    repairMessage.value = `${action} ${result.removedTrackIds.length} 首${
      result.failures.length > 0 ? `，${result.failures.length} 项失败` : ''
    }`
    if (result.failures.length > 0) {
      const details = result.failures
        .slice(0, 8)
        .map((failure) => `${failure.filePath}\n${failure.message}`)
        .join('\n\n')
      window.alert(`${action}未全部完成：\n\n${details}`)
    }
    clearSelection()
    closeContextMenu()
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '本地音乐库操作失败'
  } finally {
    libraryMutationPending.value = false
  }
}

async function handleRestoreExclusions(filePaths: string[]): Promise<void> {
  if (exclusionRestorePending.value || filePaths.length === 0) return
  exclusionRestorePending.value = true
  try {
    const restoredCount = await restoreExcludedTracks(filePaths)
    repairMessage.value = `已恢复 ${restoredCount} 个排除项`
    if (excludedTracks.value.length === 0) showExcludedTracksDialog.value = false
  } catch (error) {
    repairMessage.value = error instanceof Error ? error.message : '恢复排除项失败'
  } finally {
    exclusionRestorePending.value = false
  }
}

function excludedTrackLabel(filePath: string, title: string): string {
  return title || filePath.split(/[\\/]/).pop() || filePath
}

function formatExcludedAt(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString() : ''
}

function removeActionTracksFromCurrentPlaylist(actionTracks: Track[]): void {
  const playlistName = currentPlaylistName.value
  if (!playlistName || actionTracks.length === 0) return
  removeTracksFromPlaylist(
    playlistName,
    actionTracks.map((track) => track.id)
  )
  clearSelection()
  closeContextMenu()
}

function handleBatchRemoveFromPlaylist(): void {
  removeActionTracksFromCurrentPlaylist(selectionActionTracks.value)
}

function favoriteActionTracks(actionTracks: Track[]): void {
  if (actionTracks.length === 0) return
  if (actionTracks.every((track) => isFavoriteTrack(track))) {
    setFavoriteTracks(actionTracks, false)
  } else {
    setFavoriteTracks(actionTracks, true)
  }
  closeContextMenu()
}

function handleBatchFavorite(): void {
  favoriteActionTracks(selectionActionTracks.value)
}

function addActionTracksToPlaylist(playlistName: string, actionTracks: Track[]): void {
  if (actionTracks.length === 0) return
  addTracksToPlaylist(playlistName, actionTracks)
  closeContextMenu()
}

function handleBatchCreatePlaylistFromMenu(actionTracks: Track[]): void {
  if (actionTracks.length === 0) return
  pendingBatchCreateTracks.value = actionTracks
  openCreatePlaylistDialog(actionTracks[0])
}

function dismissCreatePlaylistDialog(): void {
  pendingBatchCreateTracks.value = []
  completeCreatePlaylistDialog()
}

function handleConfirmCreatePlaylist(): void {
  const name = newPlaylistName.value.trim()
  if (!name) return
  const batch = pendingBatchCreateTracks.value
  if (batch.length > 0) {
    createPlaylistWithTracks(name, batch)
    pendingBatchCreateTracks.value = []
    completeCreatePlaylistDialog()
    clearSelection()
    return
  }
  handleCreatePlaylist()
}

function handleContextRemoveFromLibrary(): void {
  void runLocalLibraryRemoval('library', contextActionTracks.value)
}

function handleContextMoveToTrash(): void {
  void runLocalLibraryRemoval('trash', contextActionTracks.value)
}

function handleContextRemoveFromPlaylist(): void {
  removeActionTracksFromCurrentPlaylist(contextActionTracks.value)
}

function handleContextFavorite(): void {
  favoriteActionTracks(contextActionTracks.value)
}

function handleContextAddToPlaylist(playlistName: string): void {
  addActionTracksToPlaylist(playlistName, contextActionTracks.value)
}

function handleContextCreatePlaylist(): void {
  handleBatchCreatePlaylistFromMenu(contextActionTracks.value)
}

const canContinueFromBookmark = computed(() => {
  const track = selectedTrack.value
  if (!track || contextActionCount.value > 1) return false
  return (
    !!playbackBookmarks.resumeBookmarkFor(track) || playbackBookmarks.bookmarksFor(track).length > 0
  )
})

function handleContinueFromBookmark(): void {
  const track = selectedTrack.value
  if (!track) return
  const resume =
    playbackBookmarks.resumeBookmarkFor(track) ?? playbackBookmarks.bookmarksFor(track)[0]
  if (!resume) return
  closeContextMenu()
  playTrackFromPosition(track, resume.positionSeconds, displayTracks.value)
}

function handleToolbarRemoveFromLibrary(): void {
  void runLocalLibraryRemoval('library')
}

function handleToolbarMoveToTrash(): void {
  void runLocalLibraryRemoval('trash')
}

function handleToolbarFavorite(): void {
  handleBatchFavorite()
}

function openTagManager(initialView: 'edit' | 'duplicates' = 'edit'): void {
  const selected = selectLocalLibraryActionTracks(getSelectedTracks())
  tagManagerFocusRestoreTarget.value =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  tagManagerTracks.value = selected
  tagManagerInitialView.value = initialView
  showTagManager.value = true
  closeContextMenu()
}

function closeLibraryToolsMenuDelayed(): void {
  setTimeout(() => {
    libraryToolsMenuOpen.value = false
  }, 150)
}

function openLibraryDuplicates(): void {
  libraryToolsMenuOpen.value = false
  openTagManager('duplicates')
}

function openLibraryExcluded(): void {
  libraryToolsMenuOpen.value = false
  showExcludedTracksDialog.value = true
}

function closeTagManager(): void {
  showTagManager.value = false
  const target = tagManagerFocusRestoreTarget.value
  tagManagerFocusRestoreTarget.value = null
  void nextTick(() => {
    if (target?.isConnected) target.focus()
  })
}

function applyTagManagerWrite(filePaths: string[], patch: LocalLibraryTagPatch): void {
  const changed = applyLocalTagWrite(filePaths, patch)
  repairMessage.value =
    changed > 0 ? `已更新 ${changed} 首本地歌曲的本地视图` : '标签已写入，等待下次扫描刷新本地视图'
}

const {
  renderedGridCount,
  filteredGridItems,
  gridTotalCount,
  visibleArtists,
  visibleAlbums,
  visibleGenres,
  visiblePlaylists,
  visibleFolders,
  renderGridThroughIndex,
  localTransitionName,
  viewKey,
  isSwitching,
  onViewBeforeLeave,
  finishViewSwitch
} = useSongListGridRendering({
  category: () => props.category,
  filter: () => props.filter,
  transitionName: () => props.transitionName,
  debouncedSearchQuery,
  currentGridItems,
  showGrid,
  updateViewportHeight
})

const availableIndexLetters = computed(() => availableCollectionLetters(filteredGridItems.value))

function collectionLetterDisabled(letter: string): boolean {
  return !availableIndexLetters.value.has(letter)
}

async function jumpToCollectionLetter(letter: string): Promise<void> {
  if (!isCollectionGrid.value || collectionLetterDisabled(letter)) return
  const index = firstCollectionIndexForLetter(filteredGridItems.value, letter)
  if (index < 0) return
  activeCollectionLetter.value = letter
  renderGridThroughIndex(index)
  await nextTick()
  const card = await ensureCollectionCardRendered(index)
  if (!card || !containerRef.value) return
  const containerRect = containerRef.value.getBoundingClientRect()
  const cardRect = card.getBoundingClientRect()
  containerRef.value.scrollTo({
    top: Math.max(0, containerRef.value.scrollTop + cardRect.top - containerRect.top - 92),
    behavior: 'smooth'
  })
}

async function ensureCollectionCardRendered(index: number): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const card = containerRef.value?.querySelector<HTMLElement>(
      `[data-collection-index="${index}"]`
    )
    if (card) return card
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
  }
  return null
}

function updateActiveCollectionLetter(): void {
  if (!isCollectionGrid.value || !containerRef.value) return
  const containerTop = containerRef.value.getBoundingClientRect().top + 104
  let current: string | null = null
  for (const card of containerRef.value.querySelectorAll<HTMLElement>('[data-collection-letter]')) {
    if (card.getBoundingClientRect().top <= containerTop)
      current = card.dataset.collectionLetter ?? null
    else break
  }
  activeCollectionLetter.value =
    current ?? collectionIndexLetter(filteredGridItems.value[0]?.name ?? '')
}

function onSongListScroll(event: Event): void {
  onScroll(event)
  updateActiveCollectionLetter()
}

watch([filteredGridItems, () => props.category], () => {
  activeCollectionLetter.value = collectionIndexLetter(filteredGridItems.value[0]?.name ?? '')
})

function getTrackSource(track: Pick<Track, 'id' | 'source'>): string {
  if (track.source) return track.source
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return 'local'
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : 'local'
}
</script>

<template>
  <div
    ref="containerRef"
    class="song-list"
    :class="{ 'has-player': props.hasPlayer, 'is-switching': isSwitching }"
    :style="{ height: '100vh' }"
    @scroll="onSongListScroll"
  >
    <Transition
      :name="localTransitionName"
      mode="out-in"
      @before-leave="onViewBeforeLeave"
      @after-enter="finishViewSwitch"
      @enter-cancelled="finishViewSwitch"
      @leave-cancelled="finishViewSwitch"
    >
      <div :key="viewKey" :class="showGrid ? 'grid-view' : 'table-view'">
        <template v-if="showGrid">
          <div class="song-list-header">
            <div class="title-group">
              <div class="title-line">
                <h2 class="song-list-title">{{ viewTitle }}</h2>
                <span v-if="gridStatsText" class="view-stats">{{ gridStatsText }}</span>
              </div>
            </div>
            <div class="header-right">
              <div v-if="isCollectionGrid" class="collection-view-controls" aria-label="分类与排序">
                <label>
                  <span class="sr-only">排序方式</span>
                  <select
                    :value="collectionViewState.sort"
                    aria-label="排序方式"
                    @change="setCollectionSort(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="name-asc">名称 A-Z</option>
                    <option value="name-desc">名称 Z-A</option>
                    <option value="added-newest">添加时间：最新优先</option>
                    <option value="added-oldest">添加时间：最旧优先</option>
                  </select>
                </label>
                <label>
                  <span class="sr-only">按流派筛选</span>
                  <select
                    :value="collectionViewState.genre ?? ''"
                    aria-label="按流派筛选"
                    @change="setCollectionGenre(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">全部流派</option>
                    <option v-for="genre in collectionGenreOptions" :key="genre" :value="genre">
                      {{ genre }}
                    </option>
                  </select>
                </label>
              </div>
              <div class="search-box" :class="{ focused: searchInputFocused }">
                <ThemeIcon class="search-icon" icon-slot="library.search" />
                <input
                  v-model="searchQuery"
                  type="text"
                  class="search-input"
                  placeholder="搜索歌曲、歌手、专辑或文件夹"
                  @focus="searchInputFocused = true"
                  @blur="searchInputFocused = false"
                />
                <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">
                  <ThemeIcon icon-slot="library.clear" />
                </button>
              </div>
            </div>
          </div>
          <div v-if="category === 'artists' && artists.length === 0" class="empty-state">
            <p class="empty-text">暂无艺术家</p>
            <p class="empty-hint">通过歌单「添加文件夹」导入音乐</p>
          </div>
          <div v-else-if="category === 'albums' && albums.length === 0" class="empty-state">
            <p class="empty-text">暂无专辑</p>
            <p class="empty-hint">通过歌单「添加文件夹」导入音乐</p>
          </div>
          <div v-else-if="isCollectionGrid && gridTotalCount === 0" class="empty-state">
            <p class="empty-text">没有符合条件的{{ category === 'artists' ? '艺术家' : '专辑' }}</p>
            <p class="empty-hint">请更改流派筛选或搜索条件</p>
          </div>
          <div v-else-if="category === 'genres' && genres.length === 0" class="empty-state">
            <p class="empty-text">暂无流派</p>
            <p class="empty-hint">导入带流派标签的音乐，或完整重扫媒体库以回填</p>
          </div>
          <div v-else-if="category === 'playlists' && playlists.length === 0" class="empty-state">
            <p class="empty-text">暂无歌单</p>
            <p class="empty-hint">点击下方卡片创建你的第一个歌单</p>
          </div>
          <div v-else-if="category === 'folders' && folders.length === 0" class="empty-state">
            <div class="empty-icon">
              <ThemeIcon class="empty-library-icon" icon-slot="library.folder" />
            </div>
            <p class="empty-text">暂无可显示的文件夹</p>
            <p class="empty-hint">请在设置的“媒体库管理”中添加音乐文件夹，然后执行完整重扫。</p>
          </div>
          <div v-else-if="gridTotalCount === 0" class="empty-state">
            <p class="empty-text">没有符合搜索条件的内容</p>
            <p class="empty-hint">请清除搜索内容后重试</p>
          </div>
          <div v-else class="collection-grid-layout" :class="{ 'has-az-index': isCollectionGrid }">
            <div class="card-grid">
              <!-- Artist Cards -->
              <template v-if="category === 'artists'">
                <div
                  v-for="(artist, index) in visibleArtists"
                  :key="artist.name"
                  class="artist-card"
                  :data-collection-index="index"
                  :data-collection-letter="collectionIndexLetter(artist.name) ?? undefined"
                  data-te-interactive
                  @click="emit('selectView', 'artists', `artist:${artist.name}`)"
                >
                  <CoverImg
                    v-if="artist.cover"
                    :cover="artist.cover"
                    class="artist-cover"
                    alt="cover"
                  />
                  <div v-else class="artist-cover-placeholder">
                    <ThemeIcon class="library-placeholder-icon" icon-slot="library.artist" />
                  </div>
                  <div class="artist-name">{{ artist.name }}</div>
                  <div class="artist-count">{{ artist.trackCount }} 首</div>
                </div>
                <div v-if="renderedGridCount < gridTotalCount" class="grid-loading-more">
                  正在加载更多艺术家...
                </div>
              </template>
              <!-- Album Cards -->
              <template v-if="category === 'albums'">
                <div
                  v-for="(album, index) in visibleAlbums"
                  :key="album.id"
                  class="album-card"
                  :data-collection-index="index"
                  :data-collection-letter="collectionIndexLetter(album.name) ?? undefined"
                  data-te-interactive
                  @click="emit('selectView', 'albums', `album:${album.id}`)"
                >
                  <CoverImg
                    v-if="album.cover"
                    :cover="album.cover"
                    class="album-cover"
                    alt="cover"
                  />
                  <div v-else class="album-cover-placeholder">
                    <ThemeIcon class="library-placeholder-icon" icon-slot="library.album" />
                  </div>
                  <div class="album-name">{{ album.name }}</div>
                  <div class="album-count">{{ album.trackCount }} 首</div>
                </div>
              </template>
              <!-- Genre Cards -->
              <template v-if="category === 'genres'">
                <div
                  v-for="genre in visibleGenres"
                  :key="genre.name"
                  class="artist-card"
                  data-te-interactive
                  @click="emit('selectView', 'genres', `genre:${genre.name}`)"
                >
                  <CoverImg
                    v-if="genre.cover"
                    :cover="genre.cover"
                    class="artist-cover"
                    alt="cover"
                  />
                  <div v-else class="artist-cover-placeholder">
                    <ThemeIcon class="library-placeholder-icon" icon-slot="library.genre" />
                  </div>
                  <div class="artist-name">{{ genre.name }}</div>
                  <div class="artist-count">{{ genre.trackCount }} 首</div>
                </div>
                <div v-if="renderedGridCount < gridTotalCount" class="grid-loading-more">
                  正在加载更多流派...
                </div>
              </template>
              <!-- Playlist Cards -->
              <template v-if="category === 'playlists'">
                <!-- Create Playlist Card -->
                <div
                  class="playlist-card create-playlist-card"
                  data-te-interactive
                  @click="openCreatePlaylistDialog()"
                >
                  <div class="playlist-cover-placeholder create-placeholder">
                    <ThemeIcon class="library-placeholder-icon" icon-slot="library.add" />
                  </div>
                  <div class="playlist-name">创建歌单</div>
                  <div class="playlist-count">点击创建新歌单</div>
                </div>
                <div
                  v-for="playlist in visiblePlaylists"
                  :key="playlist.id"
                  class="playlist-card"
                  data-te-interactive
                  @click="emit('selectView', 'playlists', `playlist:${playlist.name}`)"
                >
                  <CoverImg
                    v-if="playlist.cover"
                    :cover="playlist.cover"
                    class="album-cover"
                    alt="playlist cover"
                  />
                  <div
                    v-else
                    class="playlist-cover-placeholder"
                    :class="{ 'default-playlist-cover': playlist.isDefault }"
                  >
                    <i
                      :class="playlist.isDefault ? 'pi pi-heart' : 'pi pi-list'"
                      style="font-size: 32px; color: #ccc"
                    ></i>
                  </div>
                  <div class="playlist-name">{{ playlist.name }}</div>
                  <div class="playlist-count">{{ playlist.trackIds?.length ?? 0 }} 首</div>
                  <div v-if="playlistSourceSummaryLabel(playlist)" class="playlist-source-summary">
                    {{ playlistSourceSummaryLabel(playlist) }}
                  </div>
                  <div
                    v-if="!playlist.isDefault"
                    class="playlist-delete-btn"
                    data-te-interactive
                    title="删除歌单"
                    @click="handleDeletePlaylist(playlist.id || '', $event)"
                  >
                    <i class="pi pi-trash" style="font-size: 12px"></i>
                  </div>
                </div>
              </template>
              <template v-if="category === 'folders'">
                <div
                  v-for="folder in visibleFolders"
                  :key="folder.path"
                  class="playlist-card folder-card"
                  data-te-interactive
                  @click="emit('selectView', 'folders', `folder:${folder.path}`)"
                >
                  <CoverImg
                    v-if="folder.cover"
                    :cover="folder.cover"
                    class="album-cover"
                    alt="cover"
                  />
                  <div v-else class="playlist-cover-placeholder">
                    <ThemeIcon class="library-placeholder-icon" icon-slot="library.folder" />
                  </div>
                  <div class="playlist-name">{{ folder.name }}</div>
                  <div class="playlist-count">{{ folder.trackCount }} 首</div>
                </div>
              </template>
            </div>
            <nav v-if="isCollectionGrid" class="az-index" aria-label="A-Z 快捷索引">
              <button
                v-for="letter in AZ_INDEX_LETTERS"
                :key="letter"
                type="button"
                :class="{ active: activeCollectionLetter === letter }"
                :disabled="collectionLetterDisabled(letter)"
                :aria-current="activeCollectionLetter === letter ? 'location' : undefined"
                :title="
                  collectionLetterDisabled(letter) ? `${letter} 暂无内容` : `跳转到 ${letter}`
                "
                @click="jumpToCollectionLetter(letter)"
              >
                {{ letter }}
              </button>
            </nav>
          </div>
        </template>
        <template v-else>
          <div class="song-list-header">
            <div class="header-left">
              <button
                v-if="showDetailBackButton"
                class="btn-back"
                data-te-back-button="icon"
                title="返回"
                @click="emit('selectView', category, null)"
              >
                <i class="pi pi-arrow-left"></i>
              </button>
              <div class="title-group">
                <div class="title-line">
                  <h2 class="song-list-title">{{ viewTitle }}</h2>
                  <span v-if="viewStatsText" class="view-stats">{{ viewStatsText }}</span>
                </div>
                <span v-if="repairMessage" class="repair-status">{{ repairMessage }}</span>
                <span v-else-if="libraryRepairStatusText" class="library-repair-status">
                  {{ libraryRepairStatusText }}
                </span>
              </div>
            </div>
            <div class="header-right">
              <div v-if="isPlaylistDetail" class="playlist-lifecycle-actions" aria-label="歌单操作">
                <button type="button" title="重命名歌单" @click="handleRenamePlaylist">
                  <i class="pi pi-pencil"></i>
                </button>
                <button type="button" title="复制歌单" @click="handleCopyPlaylist">
                  <i class="pi pi-copy"></i>
                </button>
                <button type="button" title="设置歌单封面" @click="triggerPlaylistCoverPicker">
                  <i class="pi pi-image"></i>
                </button>
                <button type="button" title="导入 M3U、M3U8 或 PLS" @click="triggerPlaylistImport">
                  <i class="pi pi-file-import"></i>
                </button>
                <label class="playlist-export-format" title="选择导出歌单格式">
                  <span class="sr-only">导出歌单格式</span>
                  <select v-model="playlistExportFormat" aria-label="导出歌单格式">
                    <option
                      v-for="option in PLAYLIST_EXPORT_FORMATS"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <button
                  type="button"
                  :title="`导出 ${playlistExportFormat.toUpperCase()}`"
                  @click="downloadPlaylistDocument(playlistExportFormat)"
                >
                  <i class="pi pi-download"></i>
                </button>
                <button
                  type="button"
                  title="扫描文件夹并批量重新定位缺失文件"
                  :disabled="playlistRepairPending"
                  @click="handlePlaylistRepair"
                >
                  <i
                    :class="playlistRepairPending ? 'pi pi-spin pi-spinner' : 'pi pi-map-marker'"
                  ></i>
                </button>
              </div>
              <div
                v-if="category === 'allSongs'"
                class="library-tools-dropdown"
                :class="{ open: libraryToolsMenuOpen }"
              >
                <button
                  type="button"
                  class="excluded-tracks-trigger library-tools-trigger"
                  title="重复检查与已移除管理"
                  :aria-expanded="libraryToolsMenuOpen"
                  aria-haspopup="menu"
                  @click="libraryToolsMenuOpen = !libraryToolsMenuOpen"
                  @blur="closeLibraryToolsMenuDelayed"
                >
                  <i class="pi pi-sitemap"></i>
                  <span>库管理</span>
                  <span v-if="excludedTracks.length > 0" class="library-tools-badge">{{
                    excludedTracks.length
                  }}</span>
                  <i class="pi pi-chevron-down" style="font-size: 10px"></i>
                </button>
                <div v-if="libraryToolsMenuOpen" class="library-tools-menu" role="menu">
                  <button
                    type="button"
                    class="library-tools-option"
                    role="menuitem"
                    @mousedown.prevent="openLibraryDuplicates"
                  >
                    <i class="pi pi-copy"></i>
                    <span>重复检查</span>
                  </button>
                  <button
                    type="button"
                    class="library-tools-option"
                    role="menuitem"
                    @mousedown.prevent="openLibraryExcluded"
                  >
                    <i class="pi pi-ban"></i>
                    <span>已移除 {{ excludedTracks.length }}</span>
                  </button>
                </div>
              </div>
              <div
                v-if="category === 'recent'"
                class="recent-source-dropdown"
                :class="{ open: recentSourceMenuOpen }"
              >
                <button
                  class="recent-source-trigger"
                  @click="recentSourceMenuOpen = !recentSourceMenuOpen"
                  @blur="closeRecentSourceMenuDelayed"
                >
                  <i class="pi pi-bolt" style="font-size: 13px"></i>
                  <span>{{ activeRecentSourceLabel }}</span>
                  <i class="pi pi-chevron-down" style="font-size: 10px"></i>
                </button>
                <div v-if="recentSourceMenuOpen" class="recent-source-menu">
                  <div
                    v-for="opt in recentSourceOptions"
                    :key="opt.id"
                    class="recent-source-option"
                    :class="{ active: recentSource === opt.id }"
                    @mousedown.prevent="selectRecentSource(opt.id)"
                  >
                    <i class="pi" :class="opt.icon" style="font-size: 13px"></i>
                    <span>{{ opt.label }}</span>
                    <i
                      v-if="recentSource === opt.id"
                      class="pi pi-check"
                      style="font-size: 12px; margin-left: auto"
                    ></i>
                  </div>
                </div>
              </div>
              <div
                ref="libraryFilterDropdownRef"
                class="library-filter-dropdown"
                :class="{ open: libraryFilterPanelOpen }"
                aria-label="媒体库排序和过滤"
              >
                <button
                  type="button"
                  class="library-filter-trigger"
                  :class="{ active: libraryFilterPanelOpen || activeLibraryFilterCount > 0 }"
                  :aria-expanded="libraryFilterPanelOpen"
                  aria-haspopup="dialog"
                  title="筛选器"
                  @click="toggleLibraryFilterPanel"
                >
                  <ThemeIcon icon-slot="library.filter" />
                  <span>筛选器</span>
                  <span
                    v-if="activeLibraryFilterCount > 0"
                    class="library-filter-badge"
                    aria-label="已启用筛选条件数量"
                  >
                    {{ activeLibraryFilterCount }}
                  </span>
                  <i class="pi pi-chevron-down" style="font-size: 10px"></i>
                </button>
                <div
                  v-if="libraryFilterPanelOpen"
                  class="library-filter-panel"
                  role="dialog"
                  aria-label="筛选器"
                >
                  <div class="library-filter-panel-header">
                    <strong>筛选器</strong>
                    <button
                      type="button"
                      class="library-filter-reset"
                      :disabled="activeLibraryFilterCount === 0"
                      @click="resetLibraryFilters"
                    >
                      重置
                    </button>
                  </div>
                  <div class="library-view-controls">
                    <label>
                      <span>排序</span>
                      <select
                        :value="libraryViewState.sortKey"
                        @change="setSortKey(($event.target as HTMLSelectElement).value)"
                      >
                        <option value="playlist">歌单顺序</option>
                        <option value="title">标题</option>
                        <option value="artist">歌手</option>
                        <option value="album">专辑</option>
                        <option value="trackNumber">曲目号</option>
                        <option value="duration">时长</option>
                        <option value="format">格式</option>
                        <option value="sampleRate">采样率</option>
                        <option value="addedAt">加入时间</option>
                        <option value="lastPlayed">最近播放</option>
                      </select>
                    </label>
                    <label>
                      <span>顺序</span>
                      <select
                        :value="libraryViewState.sortDirection"
                        @change="setSortDirection(($event.target as HTMLSelectElement).value)"
                      >
                        <option value="asc">升序</option>
                        <option value="desc">降序</option>
                      </select>
                    </label>
                    <label class="library-filter-toggle">
                      <input
                        type="checkbox"
                        :checked="libraryViewState.filters.lossless"
                        @change="
                          setLibraryFilter('lossless', ($event.target as HTMLInputElement).checked)
                        "
                      />
                      <span>无损</span>
                    </label>
                    <label class="library-filter-toggle">
                      <input
                        type="checkbox"
                        :checked="libraryViewState.filters.dsd"
                        @change="
                          setLibraryFilter('dsd', ($event.target as HTMLInputElement).checked)
                        "
                      />
                      <span>DSD</span>
                    </label>
                    <label>
                      <span>采样率</span>
                      <select
                        :value="libraryViewState.filters.sampleRate ?? ''"
                        @change="
                          setLibraryFilter(
                            'sampleRate',
                            Number(($event.target as HTMLSelectElement).value) || null
                          )
                        "
                      >
                        <option value="">全部</option>
                        <option
                          v-for="value in libraryFilterOptions.sampleRates"
                          :key="value"
                          :value="value"
                        >
                          {{ value / 1000 }} kHz
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>位深</span>
                      <select
                        :value="libraryViewState.filters.bitDepth ?? ''"
                        @change="
                          setLibraryFilter(
                            'bitDepth',
                            Number(($event.target as HTMLSelectElement).value) || null
                          )
                        "
                      >
                        <option value="">全部</option>
                        <option
                          v-for="value in libraryFilterOptions.bitDepths"
                          :key="value"
                          :value="value"
                        >
                          {{ value }} bit
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>文件夹</span>
                      <select
                        :value="libraryViewState.filters.folder ?? ''"
                        @change="
                          setLibraryFilter(
                            'folder',
                            ($event.target as HTMLSelectElement).value || null
                          )
                        "
                      >
                        <option value="">全部</option>
                        <option
                          v-for="folder in libraryFilterOptions.folders"
                          :key="folder"
                          :value="folder"
                        >
                          {{ folder }}
                        </option>
                      </select>
                    </label>
                    <label>
                      <span>来源</span>
                      <select
                        :value="libraryViewState.filters.provider ?? ''"
                        @change="
                          setLibraryFilter(
                            'provider',
                            ($event.target as HTMLSelectElement).value || null
                          )
                        "
                      >
                        <option value="">全部</option>
                        <option
                          v-for="provider in libraryFilterOptions.providers"
                          :key="provider"
                          :value="provider"
                        >
                          {{ provider }}
                        </option>
                      </select>
                    </label>
                  </div>
                </div>
              </div>
              <label
                v-if="showOnlineSearchToggle"
                class="online-search-toggle"
                title="搜索网络歌曲"
              >
                <span>网络搜索</span>
                <input v-model="searchOnlineSongs" type="checkbox" aria-label="搜索网络歌曲" />
                <span class="online-search-toggle-track" aria-hidden="true"></span>
              </label>
              <div class="search-box" :class="{ focused: searchInputFocused }">
                <ThemeIcon class="search-icon" icon-slot="library.search" />
                <input
                  v-model="searchQuery"
                  type="text"
                  class="search-input"
                  placeholder="搜索歌曲、歌手、专辑或文件夹"
                  @focus="searchInputFocused = true"
                  @blur="searchInputFocused = false"
                />
                <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">
                  <ThemeIcon icon-slot="library.clear" />
                </button>
              </div>
            </div>
          </div>
          <div class="library-play-actions" aria-label="播放控制">
            <button
              type="button"
              class="btn-play-all"
              title="播放全部"
              :disabled="displayTracks.length === 0"
              @click="playAllTracks"
            >
              <i class="ph ph-play"></i>
              <span>播放全部</span>
            </button>
            <button
              type="button"
              class="btn-shuffle-all"
              title="随机播放"
              :disabled="displayTracks.length === 0"
              @click="shufflePlayTracks"
            >
              <i class="ph ph-shuffle"></i>
              <span>随机播放</span>
            </button>
          </div>
          <div
            v-if="showUnifiedSearchStatus"
            class="unified-search-status"
            :class="{ error: !!unifiedSearch.error.value }"
          >
            <div class="unified-search-summary">
              <i
                :class="
                  unifiedSearch.loading.value
                    ? 'pi pi-spin pi-spinner'
                    : unifiedSearch.error.value
                      ? 'pi pi-times-circle'
                      : 'pi pi-search'
                "
              ></i>
              <span>{{ unifiedSearchStatusText }}</span>
            </div>
            <div v-if="unifiedSearchHealthItems.length" class="unified-search-health-list">
              <span
                v-for="health in unifiedSearchHealthItems"
                :key="health.providerId"
                class="unified-search-health-chip"
                :class="health.state"
                :title="health.detail"
              >
                {{ health.providerName }} · {{ health.label }}
              </span>
            </div>
          </div>
          <div v-if="displayTracks.length === 0" class="empty-state">
            <div class="empty-icon">
              <ThemeIcon class="empty-library-icon" icon-slot="library.empty" />
            </div>
            <p class="empty-text">暂无内容</p>
            <p class="empty-hint">通过左侧菜单「歌单 → 添加文件夹」导入音乐</p>
          </div>
          <div v-else class="track-table-wrapper">
            <div v-if="hasSelection" class="selection-toolbar">
              <span class="selection-count">已选择 {{ selectedCount }} 首</span>
              <div class="selection-actions">
                <button type="button" class="selection-btn" @click="handleToolbarFavorite">
                  <i :class="selectionAllFavorited ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
                  <span>{{ selectionAllFavorited ? '取消收藏' : '加入收藏' }}</span>
                </button>
                <button
                  v-if="selectedLocalTrackCount > 0"
                  type="button"
                  class="selection-btn"
                  :disabled="libraryMutationPending"
                  @click="openTagManager('edit')"
                >
                  <i class="pi pi-tag"></i>
                  <span>编辑标签{{ localSelectionActionLabel }}</span>
                </button>
                <button
                  v-if="isPlaylistDetail"
                  type="button"
                  class="selection-btn"
                  @click="handleBatchRemoveFromPlaylist"
                >
                  <i class="pi pi-minus-circle"></i>
                  <span>从歌单移除</span>
                </button>
                <button
                  v-if="isPlaylistDetail"
                  type="button"
                  class="selection-btn"
                  @click="handleMoveSelectedWithinPlaylist(false)"
                >
                  <i class="pi pi-angle-double-up"></i>
                  <span>移到开头</span>
                </button>
                <button
                  v-if="isPlaylistDetail"
                  type="button"
                  class="selection-btn"
                  @click="handleMoveSelectedWithinPlaylist(true)"
                >
                  <i class="pi pi-angle-double-down"></i>
                  <span>移到末尾</span>
                </button>
                <button
                  v-if="isPlaylistDetail"
                  type="button"
                  class="selection-btn"
                  @click="handleMoveSelectedToPlaylist"
                >
                  <i class="pi pi-arrow-right-arrow-left"></i>
                  <span>移动到歌单</span>
                </button>
                <button
                  v-if="selectedLocalTrackCount > 0"
                  type="button"
                  class="selection-btn"
                  :disabled="libraryMutationPending"
                  @click="handleToolbarRemoveFromLibrary"
                >
                  <i class="pi pi-minus-circle"></i>
                  <span>从音乐库移除</span>
                </button>
                <button
                  v-if="selectedLocalTrackCount > 0"
                  type="button"
                  class="selection-btn danger"
                  :disabled="libraryMutationPending"
                  @click="handleToolbarMoveToTrash"
                >
                  <i class="pi pi-trash"></i>
                  <span>移到回收站</span>
                </button>
                <button type="button" class="selection-btn ghost" @click="clearSelection">
                  <i class="pi pi-times"></i>
                  <span>取消</span>
                </button>
              </div>
            </div>
            <table class="track-table">
              <thead>
                <tr>
                  <th class="col-index">#</th>
                  <th class="col-cover-header"></th>
                  <th class="col-info">标题</th>
                  <th class="col-album">专辑</th>
                  <th class="col-duration">时长</th>
                </tr>
              </thead>
              <tbody
                ref="tbodyRef"
                :style="{ height: totalHeight + 'px', position: 'relative', display: 'block' }"
              >
                <tr
                  class="virtual-spacer"
                  :style="{ height: paddingTop + 'px' }"
                  aria-hidden="true"
                >
                  <td colspan="5"></td>
                </tr>
                <tr
                  v-for="(track, index) in visibleTracks"
                  :key="track.id"
                  class="track-row"
                  data-te-interactive
                  :class="{
                    'track-playing': currentTrack?.id === track.id,
                    'track-selected': isSelected(track.id),
                    'playlist-draggable': isPlaylistDetail
                  }"
                  :style="{ height: rowHeight - 4 + 'px', display: 'flex' }"
                  :draggable="isPlaylistDetail"
                  @click="onRowClick(track, Number(index), $event)"
                  @dblclick="onRowDblClick(track, $event)"
                  @dragstart="handlePlaylistDragStart($event, track)"
                  @dragover.prevent
                  @drop="handlePlaylistDrop($event, track)"
                  @pointermove="onRowPointerMove"
                  @contextmenu="onTrackContextMenu($event, track)"
                >
                  <td class="col-index">
                    <span v-if="currentTrack?.id === track.id" class="playing-indicator">
                      <ThemeIcon icon-slot="library.playing" />
                    </span>
                    <span v-else>{{ trackListNumber(track, Number(index)) }}</span>
                  </td>
                  <td class="col-cover">
                    <div class="track-cover-cell" :class="{ 'has-selection': hasSelection }">
                      <label
                        v-if="hasSelection"
                        class="track-select-checkbox"
                        :title="isSelected(track.id) ? '取消选中' : '选中'"
                        @click.stop
                      >
                        <input
                          type="checkbox"
                          :checked="isSelected(track.id)"
                          :aria-label="`选中 ${track.title}`"
                          @change="onTrackSelectToggle(track, Number(index), $event)"
                        />
                        <span class="track-select-box" aria-hidden="true">
                          <ThemeIcon v-if="isSelected(track.id)" icon-slot="library.selected" />
                        </span>
                      </label>
                      <CoverImg
                        v-if="track.cover"
                        :cover="track.cover"
                        :cover-source="track.coverSource"
                        :identity="track.id"
                        class="cover-img"
                        alt="cover"
                      />
                      <div v-else class="cover-placeholder">
                        <ThemeIcon icon-slot="library.empty" />
                      </div>
                    </div>
                  </td>
                  <td class="col-info">
                    <div class="track-title-row">
                      <div class="track-title">{{ track.title }}</div>
                      <div class="track-badges">
                        <span
                          v-if="getLogicalTrackSource(track) !== 'local'"
                          class="track-source-chip"
                          :class="trackSourceClass(track)"
                          :title="`来源：${trackSourceLabel(track)}`"
                        >
                          {{ trackSourceLabel(track) }}
                        </span>
                        <span
                          v-if="track.metadataMatch"
                          class="metadata-match-chip"
                          :title="metadataMatchTitle(track)"
                        >
                          {{ metadataMatchLabel(track) }}
                        </span>
                      </div>
                    </div>
                    <div class="track-artist">{{ track.artist }}</div>
                  </td>
                  <td class="col-album">{{ track.album }}</td>
                  <td class="col-duration">
                    <span class="duration-time">{{ formatDuration(track.duration) }}</span>
                    <span v-if="trackQualityLabel(track)" class="duration-quality">
                      {{ trackQualityLabel(track) }}
                    </span>
                  </td>
                </tr>
                <tr
                  class="virtual-spacer"
                  :style="{
                    height: totalHeight - paddingTop - visibleTracks.length * rowHeight + 'px'
                  }"
                  aria-hidden="true"
                >
                  <td colspan="5"></td>
                </tr>
              </tbody>
            </table>

            <!-- Context Menu -->
            <Teleport to="body">
              <div
                v-if="showContextMenu"
                class="context-menu"
                :style="{ top: menuY + 'px', left: menuX + 'px' }"
                @click.stop
              >
                <div
                  v-if="canPlayNextSelectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handlePlayNext"
                >
                  <i class="pi pi-step-forward"></i>
                  <span>下一首播放</span>
                </div>
                <div
                  v-if="
                    canViewSelectedContext &&
                    selectedTrack?.artist.trim() &&
                    contextActionCount <= 1
                  "
                  class="menu-item"
                  data-te-interactive
                  @click="handleViewArtist"
                >
                  <i class="ph ph-microphone-stage"></i>
                  <span>查看歌手</span>
                </div>
                <div
                  v-if="
                    canViewSelectedContext && selectedTrack?.album.trim() && contextActionCount <= 1
                  "
                  class="menu-item"
                  data-te-interactive
                  @click="handleViewAlbum"
                >
                  <i class="ph ph-disc"></i>
                  <span>查看专辑</span>
                </div>
                <div
                  v-if="contextLocalTrackCount > 0"
                  class="menu-item"
                  data-te-interactive
                  @click="handleContextRemoveFromLibrary"
                >
                  <i class="pi pi-minus-circle"></i>
                  <span>从音乐库移除{{ contextLocalActionLabel }}</span>
                </div>
                <div
                  v-if="contextLocalTrackCount > 0"
                  class="menu-item danger"
                  data-te-interactive
                  @click="handleContextMoveToTrash"
                >
                  <i class="pi pi-trash"></i>
                  <span>移到回收站{{ contextLocalActionLabel }}</span>
                </div>
                <div
                  v-if="isPlaylistDetail"
                  class="menu-item"
                  data-te-interactive
                  @click="handleContextRemoveFromPlaylist"
                >
                  <i class="pi pi-minus-circle"></i>
                  <span>从歌单移除{{ contextActionLabel }}</span>
                </div>
                <div class="menu-item" data-te-interactive @click="handleContextFavorite">
                  <i :class="contextAllFavorited ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
                  <span
                    >{{ contextAllFavorited ? '取消收藏' : '加入收藏'
                    }}{{ contextActionLabel }}</span
                  >
                </div>
                <div
                  v-if="canRematchSelectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handleRematchTrack"
                >
                  <i class="pi pi-refresh"></i>
                  <span>重新匹配音源</span>
                </div>
                <div
                  v-if="canRematchMetadataSelectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handleRematchMetadata"
                >
                  <i class="pi pi-sync"></i>
                  <span>重新匹配流媒体元数据</span>
                </div>
                <div
                  v-if="canClearMetadataMatchSelectedTrack && contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handleClearMetadataMatch"
                >
                  <i class="pi pi-times-circle"></i>
                  <span>取消流媒体匹配</span>
                </div>
                <div
                  v-if="contextActionCount <= 1"
                  class="menu-item"
                  data-te-interactive
                  @click="handleOpenFolder"
                >
                  <i class="pi pi-folder-open"></i>
                  <span>打开文件所在位置</span>
                </div>
                <div
                  v-if="canContinueFromBookmark"
                  class="menu-item"
                  data-te-interactive
                  @click="handleContinueFromBookmark"
                >
                  <i class="pi pi-bookmark"></i>
                  <span>从书签继续</span>
                </div>
                <div class="menu-item" @mouseenter="showPlaylistSubmenu = true">
                  <i class="pi pi-plus"></i>
                  <span>加入到歌单{{ contextActionLabel }}</span>
                  <i class="pi pi-chevron-right submenu-icon"></i>

                  <div v-if="showPlaylistSubmenu" class="submenu">
                    <div
                      class="menu-item create-playlist-menu-item"
                      data-te-interactive
                      @click="handleContextCreatePlaylist"
                    >
                      <i class="pi pi-plus" style="font-size: 14px; margin-right: 6px"></i>
                      <span>创建新歌单</span>
                    </div>
                    <div v-if="playlists.length === 0" class="menu-item disabled">暂无歌单</div>
                    <div
                      v-for="pl in playlists"
                      :key="pl.id"
                      class="menu-item"
                      data-te-interactive
                      @click="handleContextAddToPlaylist(pl.name)"
                    >
                      {{ pl.name }}
                    </div>
                  </div>
                </div>
                <div class="menu-item" data-te-interactive @click="customizeLibraryAppearance">
                  <i class="ph ph-palette"></i>
                  <span>定制此区域外观</span>
                </div>
              </div>
            </Teleport>
          </div>
        </template>
      </div>
    </Transition>

    <input
      ref="playlistImportInput"
      type="file"
      accept=".m3u,.m3u8,.pls,audio/x-mpegurl,audio/x-scpls"
      hidden
      @change="handlePlaylistImport"
    />
    <input
      ref="playlistCoverInput"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      @change="handlePlaylistCover"
    />

    <!-- Create Playlist Dialog -->
    <Teleport to="body">
      <Transition name="dialog-fade">
        <div
          v-if="showCreatePlaylistDialog"
          class="dialog-overlay"
          @click.self="dismissCreatePlaylistDialog"
        >
          <div class="create-playlist-dialog" @click.stop>
            <h3 class="dialog-title">创建歌单</h3>
            <input
              v-model="newPlaylistName"
              class="dialog-input"
              type="text"
              placeholder="请输入歌单名称"
              maxlength="50"
              autofocus
              @keyup.enter="handleConfirmCreatePlaylist"
            />
            <div class="dialog-actions">
              <button class="dialog-btn cancel" @click="dismissCreatePlaylistDialog">取消</button>
              <button
                class="dialog-btn confirm"
                :disabled="!newPlaylistName.trim()"
                @click="handleConfirmCreatePlaylist"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="dialog-fade">
        <div v-if="showTagManager" class="dialog-overlay" @click.self="closeTagManager">
          <LocalLibraryTagManager
            :key="`${tagManagerInitialView}:${tagManagerTracks.map((track) => track.id).join(',')}`"
            :initial-view="tagManagerInitialView"
            :tracks="tagManagerTracks"
            @close="closeTagManager"
            @applied="applyTagManagerWrite"
          />
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="dialog-fade">
        <div
          v-if="showExcludedTracksDialog"
          class="dialog-overlay"
          @click.self="showExcludedTracksDialog = false"
        >
          <div class="excluded-tracks-dialog" @click.stop>
            <div class="excluded-dialog-header">
              <div>
                <h3 class="dialog-title">已从音乐库移除</h3>
                <p class="excluded-dialog-count">{{ excludedTracks.length }} 个排除项</p>
              </div>
              <button
                type="button"
                class="excluded-dialog-close"
                title="关闭"
                @click="showExcludedTracksDialog = false"
              >
                <i class="pi pi-times"></i>
              </button>
            </div>
            <div v-if="excludedTracks.length === 0" class="excluded-empty">暂无排除项</div>
            <div v-else class="excluded-track-list">
              <div v-for="item in excludedTracks" :key="item.filePath" class="excluded-track-row">
                <div class="excluded-track-copy">
                  <strong>{{ excludedTrackLabel(item.filePath, item.title) }}</strong>
                  <span v-if="item.artist">{{ item.artist }}</span>
                  <span class="excluded-track-path" :title="item.filePath">{{
                    item.filePath
                  }}</span>
                  <time v-if="formatExcludedAt(item.excludedAt)">{{
                    formatExcludedAt(item.excludedAt)
                  }}</time>
                </div>
                <button
                  type="button"
                  class="excluded-restore-button"
                  :disabled="exclusionRestorePending"
                  title="恢复到音乐库"
                  @click="handleRestoreExclusions([item.filePath])"
                >
                  <i class="pi pi-refresh"></i>
                  <span>恢复</span>
                </button>
              </div>
            </div>
            <div class="dialog-actions excluded-dialog-actions">
              <button class="dialog-btn cancel" @click="showExcludedTracksDialog = false">
                关闭
              </button>
              <button
                class="dialog-btn confirm"
                :disabled="excludedTracks.length === 0 || exclusionRestorePending"
                @click="handleRestoreExclusions(excludedTracks.map((item) => item.filePath))"
              >
                全部恢复
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped src="./song-list/SongList.css"></style>
