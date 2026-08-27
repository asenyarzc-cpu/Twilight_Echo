<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useBackHandler } from '../app/useBackStack'
import type { Track } from '../types/music'
import {
  useNcmStore,
  type NcmPlaylistSummary,
  type NcmAlbumSummary,
  type NcmArtistSummary,
  type NcmUserSummary
} from '../stores/useNcmStore'
import { useProviderStore } from '../stores/useProviderStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import {
  usePlayerStore,
  type PersonalizedStreamKey,
  type PersonalizedStreamSession
} from '../stores/usePlayerStore'
import { useMusicStore } from '../stores/useMusicStore'
import { useMediaProviders } from '../providers'
import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary,
  MediaProviderPlaylistSummary,
  MediaProviderProfile
} from '../providers/mediaProvider'
import StreamingHome from './StreamingHome.vue'
import StreamingDiscovery from './StreamingDiscovery.vue'
import StreamingLibrary from './StreamingLibrary.vue'
import NcmCloudPanel from './NcmCloudPanel.vue'
import StreamingSearch from './StreamingSearch.vue'
import StreamingDetailStage from './streaming-page/StreamingDetailStage.vue'
import StreamingContentHeader from './streaming-page/StreamingContentHeader.vue'
import StreamingSearchControls from './streaming-page/StreamingSearchControls.vue'
import StreamingPlaceholder from './streaming-page/StreamingPlaceholder.vue'
import StreamingSocialStage from './streaming-page/StreamingSocialStage.vue'
import StreamingLoadingStage from './streaming-page/StreamingLoadingStage.vue'
import ProviderSidebar from './streaming-page/ProviderSidebar.vue'
import AggregatePlaylistPage from './aggregate-playlist/AggregatePlaylistPage.vue'
import CreateAggregatePlaylistDialog from './aggregate-playlist/CreateAggregatePlaylistDialog.vue'
import NcmPlaylistDialogs from './streaming-page/NcmPlaylistDialogs.vue'
import ProviderDownloadsPanel from './streaming-page/ProviderDownloadsPanel.vue'
import StreamingContextMenu from './streaming-page/StreamingContextMenu.vue'
import {
  buildStreamingSidebarItems,
  getFirstVisibleStreamingTab,
  getUnifiedLibraryProviders,
  hasStreamingSidebarEntries,
  isSidebarItemActiveForProvider,
  type StreamingSidebarItem,
  type StreamingTabKey
} from '../utils/streamingNavigation'
import {
  findBestStreamingArtistMatch,
  findStreamingArtistById,
  matchStreamingArtistsByName,
  resolveLinkedStreamingArtist,
  type StreamingArtistNavigationRequest
} from '../utils/streamingArtistResolution'
import { getRecentTracks, getTopTracks } from '../stores/useListeningStatsStore'
import { shuffleArray } from '../utils/playerQueueUtils'
import { resolveUnifiedRecentTracks } from '../utils/unifiedRecentTracks'
import { summarizeUnifiedFavorites } from '../utils/unifiedFavoriteTracks'
import {
  searchLocalStreamingArtists,
  searchLocalStreamingPlaylists,
  searchLocalStreamingSongs
} from './streaming-page/localStreamingSearch'
import {
  appendUniqueTracks,
  getPersonalizedStreamKey,
  getSharedLibraryProviderId,
  getSidebarItemsSignature,
  mergePlaylistSummaries,
  resolveExternalProviderName as externalProviderName,
  resolveStreamingTabIndex as getStreamingTabIndex,
  timeGreeting as resolveTimeGreeting
} from './streaming-page/streamingPageModel'
import { useStreamingSearch, type SearchSourceOption } from './streaming-page/useStreamingSearch'
import { useStreamingDiscovery } from './streaming-page/useStreamingDiscovery'
import { useTrackMultiSelect } from './song-list/useTrackMultiSelect'
import {
  executeStreamingBatchRemoval,
  removeStreamingProviderFavorite
} from './streaming-page/streamingBatchRemoval.ts'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'
import { getTrackSource } from '../utils/logicalTrackModel'
import { friendlyStreamingError } from './streaming-page/friendlyStreamingError.ts'
import { useEscapeToClose } from '../app/useDismissLayer.ts'
import type { ProviderDownloadQuality, ProviderDownloadTaskSnapshot } from '../../../preload/types'

interface RecSection {
  key: string
  title: string
  tracks: Track[]
  icon: string
}

interface DetailHeaderInfo {
  title: string
  cover: string | null
  coverSource?: string | null
  desc: string
  icon: string
  intro?: string
}

type StreamingTab = StreamingTabKey
type ArtistDetailTab = 'songs' | 'albums' | 'playlists'
type DetailView =
  | { type: 'liked' }
  | { type: 'playlist'; playlist: MediaProviderPlaylistSummary }
  | { type: 'album'; album: MediaProviderAlbumSummary }
  | { type: 'rec'; section: RecSection }
  | { type: 'artist'; artist: MediaProviderArtistSummary; user?: NcmUserSummary }
  | { type: 'user_list'; listType: 'follows' | 'followers'; users: NcmUserSummary[]; title: string }
  | { type: 'user_playlists'; user: NcmUserSummary; playlists: NcmPlaylistSummary[] }
  | { type: 'recent' }
  | { type: 'ranking' }

// Loaded-detail state captured when navigating one level deeper, so walking
// back restores the level underneath instead of refetching it.
interface DetailSnapshot {
  tracks: Track[]
  users: NcmUserSummary[]
  artistAlbumsList: MediaProviderAlbumSummary[]
  artistPlaylistsList: MediaProviderPlaylistSummary[]
  intro: string
  followed: boolean | null
  artistTab: ArtistDetailTab
  liked: number | null
  likedPaging: { nextOffset: number; total: number | null; hasMore: boolean }
}

interface DetailStackEntry {
  view: DetailView
  snapshot?: DetailSnapshot
}

const props = defineProps<{
  menuOpen: boolean
  hasPlayer: boolean
  active?: boolean
  initialTab?: StreamingTab
  artistNavigationRequest?: StreamingArtistNavigationRequest | null
}>()

const activeTab = ref<StreamingTab>(props.initialTab ?? 'home')
const streamingContentRef = ref<HTMLElement | null>(null)
const streamingTransitionName = ref('stream-page-down')

// Details form a real stack so nested navigation (歌单 → 歌手 → 专辑) walks
// back one level at a time. Read sites keep using `currentDetail` — simply
// the stack top; writes go through pushDetail / replaceTopDetail / popDetail
// / resetDetail so the transition and scroll machinery stay in sync.
const detailStack = ref<DetailStackEntry[]>([])
const currentDetail = computed<DetailView | null>(
  () => detailStack.value[detailStack.value.length - 1]?.view ?? null
)

const streamingViewKey = computed(() => {
  const detail = currentDetail.value
  if (!detail) return `tab:${activeTab.value}`
  switch (detail.type) {
    case 'liked':
      return 'detail:liked'
    case 'playlist':
      return `detail:playlist:${detail.playlist.id}`
    case 'album':
      return `detail:album:${detail.album.id}`
    case 'rec':
      return `detail:rec:${detail.section.key}`
    case 'artist':
      return `detail:artist:${detail.artist.id}`
    case 'user_list':
      return `detail:user_list:${detail.listType}`
    case 'user_playlists':
      return `detail:user_playlists:${detail.user.id}`
    case 'recent':
      return 'detail:recent'
    case 'ranking':
      return 'detail:ranking'
    default:
      return `detail:${(detail as { type: string }).type}`
  }
})

// Scroll offsets per streamingViewKey, saved on forward navigation and restored
// when the user navigates back (Transition after-enter, once layout exists).
const SAVED_SCROLL_POSITION_LIMIT = 32
const savedScrollPositions = new Map<string, number>()

function saveStreamingScrollPosition(): void {
  const el = streamingContentRef.value
  if (!el) return
  // 封顶：深层详情导航只进不出会让这个 Map 无界增长；超出时淘汰最旧条目，
  // 回退到顶部滚动的代价可接受。
  savedScrollPositions.delete(streamingViewKey.value)
  savedScrollPositions.set(streamingViewKey.value, el.scrollTop)
  while (savedScrollPositions.size > SAVED_SCROLL_POSITION_LIMIT) {
    const oldest = savedScrollPositions.keys().next().value
    if (oldest === undefined) break
    savedScrollPositions.delete(oldest)
  }
}

function restoreStreamingScrollPosition(): void {
  const saved = savedScrollPositions.get(streamingViewKey.value)
  if (saved == null) return
  savedScrollPositions.delete(streamingViewKey.value)
  const el = streamingContentRef.value
  if (el) el.scrollTop = saved
}

function beginDetailTransition(): void {
  streamingTransitionName.value = 'stream-detail-forward'
  saveStreamingScrollPosition()
  const el = streamingContentRef.value
  if (el) el.scrollTop = 0
}

// shallowRef + whole-array replacement only: liked songs / playlists can hold
// thousands of tracks and deep reactivity over them is pure overhead.
const detailTracks = shallowRef<Track[]>([])
const detailUsers = ref<NcmUserSummary[]>([])
const artistAlbums = ref<MediaProviderAlbumSummary[]>([])
const artistPlaylists = ref<MediaProviderPlaylistSummary[]>([])
const artistIntro = ref('')
const artistFollowed = ref<boolean | null>(null)
const activeArtistTab = ref<ArtistDetailTab>('songs')
const detailLoading = ref(false)
const detailError = ref('')
const followActionLoading = ref(false)
const followActionError = ref('')
const likedCount = ref<number | null>(null)
let detailLoadToken = 0

const dailySongs = ref<Track[]>([])
const personalFmSongs = ref<Track[]>([])
const privateContentSongs = ref<Track[]>([])
const recommendPlaylists = ref<NcmPlaylistSummary[]>([])
const PERSONALIZED_STREAM_LOAD_THRESHOLD = 0.75
const PERSONALIZED_STREAM_QUEUE_THRESHOLD = 6
const PERSONALIZED_STREAM_RETRY_COOLDOWN_MS = 15_000
const personalizedStreamLoading = reactive<Record<PersonalizedStreamKey, boolean>>({
  fm: false,
  radar: false
})
const personalizedStreamRetryAfter = reactive<Record<PersonalizedStreamKey, number>>({
  fm: 0,
  radar: 0
})
const LIKED_TRACKS_PAGE_SIZE = 100
const LIKED_TRACKS_LOAD_THRESHOLD = 0.75
const likedTracksNextOffset = ref(0)
const likedTracksTotal = ref<number | null>(null)
const likedTracksHasMore = ref(false)
const likedTracksLoadingMore = ref(false)
const likedTracksLoadMoreError = ref('')
const recsLoading = ref(false)
const recsError = ref('')
const providerStore = useProviderStore()
const settingsStore = useSettingsStore()
const musicStore = useMusicStore()
const mediaProviders = useMediaProviders()
const { pushNotice } = useAppNoticeStore()

const NCM_PROVIDER_ID = 'ncm'
const ncmNavigationAvailable = computed(() => providerStore.hasProvider(NCM_PROVIDER_ID))

// ─── Generic external provider state (bili / ytmusic / future) ───────────
// Replaces the previously bili-only refs so any provider declaring a library
// tab can plug into the streaming library view without app-side changes.
interface ExternalProviderState {
  loggedIn: boolean
  profile: MediaProviderProfile | null
  libraryLoading: boolean
  libraryLoaded: boolean
  libraryError: string
  playlists: MediaProviderPlaylistSummary[]
  likedPlaylist: MediaProviderPlaylistSummary | null
  pinnedPlaylistIds: string[]
  pinningPlaylistId: string | number | null
}

function createExternalProviderState(): ExternalProviderState {
  return {
    loggedIn: false,
    profile: null,
    libraryLoading: false,
    libraryLoaded: false,
    libraryError: '',
    playlists: [],
    likedPlaylist: null,
    pinnedPlaylistIds: [],
    pinningPlaylistId: null
  }
}

const externalStates = reactive<Record<string, ExternalProviderState>>({})

function ensureExternalState(id: string): ExternalProviderState {
  if (!externalStates[id]) {
    externalStates[id] = createExternalProviderState()
  }
  return externalStates[id]
}

function isProviderAvailable(id: string): boolean {
  return id === NCM_PROVIDER_ID ? ncmNavigationAvailable.value : providerStore.hasProvider(id)
}

// User's persisted preferred provider — only explicit user toggles change it.
const preferredProvider = ref<string>(
  settingsStore.settings.value.streamingActiveProvider || NCM_PROVIDER_ID
)
const fallbackProvider = ref<string | null>(null)

// Resolved active provider: a non-persisted navigation override wins while it
// is available; otherwise use the persisted preference, then the first provider
// that can back the shared music-library surface.
const activeProvider = computed<string>(() => {
  if (fallbackProvider.value && isProviderAvailable(fallbackProvider.value)) {
    return fallbackProvider.value
  }
  if (isProviderAvailable(preferredProvider.value)) return preferredProvider.value
  return libraryProviders.value[0]?.id ?? NCM_PROVIDER_ID
})

const isExternalActive = computed(() => activeProvider.value !== NCM_PROVIDER_ID)
const activeExternalState = computed<ExternalProviderState | null>(() =>
  isExternalActive.value ? (externalStates[activeProvider.value] ?? null) : null
)

const activeProviderInfo = computed(() => providerStore.getProvider(activeProvider.value))
const activeProviderLabel = computed(() => {
  if (activeProvider.value === NCM_PROVIDER_ID) return '网易云音乐'
  return activeProviderInfo.value?.name ?? '在线音源'
})

// Providers eligible for the unified music-library toggle (the dropdown on
// the profile card). Providers opt in by declaring `ui.unifiedLibrary: true`.
const libraryProviders = computed(() =>
  getUnifiedLibraryProviders({
    ncmAvailable: ncmNavigationAvailable.value,
    providers: providerStore.providers.value
  })
)
const libraryProviderOptions = computed(() =>
  libraryProviders.value.map((provider) => ({
    ...provider,
    health: providerStore.getProvider(provider.id)?.health,
    loggedIn:
      provider.id === NCM_PROVIDER_ID
        ? isLoggedIn.value
        : (externalStates[provider.id]?.loggedIn ?? false)
  }))
)

async function loadRecommendations(): Promise<void> {
  if (isExternalActive.value) return
  if (!isLoggedIn.value) return

  const needsDaily = dailySongs.value.length === 0
  const needsFm = personalFmSongs.value.length === 0
  const needsRadar = privateContentSongs.value.length === 0
  const needsPlaylists = recommendPlaylists.value.length === 0
  if (!needsDaily && !needsFm && !needsRadar && !needsPlaylists) return

  recsLoading.value = true
  recsError.value = ''
  try {
    const [daily, fm, radar, playlists] = await Promise.all([
      needsDaily ? fetchRecommendSongs().catch(() => [] as Track[]) : dailySongs.value,
      needsFm ? fetchPersonalFm().catch(() => [] as Track[]) : personalFmSongs.value,
      needsRadar ? fetchPrivateContent().catch(() => [] as Track[]) : privateContentSongs.value,
      needsPlaylists
        ? fetchRecommendPlaylists().catch(() => [] as NcmPlaylistSummary[])
        : recommendPlaylists.value
    ])
    if (needsDaily) dailySongs.value = daily
    if (needsFm) personalFmSongs.value = fm
    if (needsRadar) privateContentSongs.value = radar
    if (needsPlaylists) recommendPlaylists.value = playlists
  } catch (e) {
    recsError.value = friendlyStreamingError(e, '加载推荐失败')
  } finally {
    recsLoading.value = false
  }
}

const recSections = computed<RecSection[]>(() => [
  { key: 'daily', title: '每日推荐', tracks: dailySongs.value, icon: 'pi pi-calendar' },
  { key: 'fm', title: '私人漫游', tracks: personalFmSongs.value, icon: 'pi pi-compass' },
  { key: 'radar', title: '私人雷达', tracks: privateContentSongs.value, icon: 'pi pi-send' }
])

async function openRecSection(section: RecSection): Promise<void> {
  detailLoadToken++
  beginDetailTransition()
  pushDetail({ type: 'rec', section })
  detailTracks.value = section.tracks
  detailLoading.value = false
  detailError.value = ''
}

async function loadMorePersonalizedStream(
  key: PersonalizedStreamKey,
  session: PersonalizedStreamSession | null = null
): Promise<void> {
  if (personalizedStreamLoading[key] || Date.now() < personalizedStreamRetryAfter[key]) return
  personalizedStreamLoading[key] = true
  try {
    const current = key === 'fm' ? personalFmSongs.value : privateContentSongs.value
    const incoming = await (key === 'fm' ? fetchPersonalFm() : fetchPrivateContent())
    let additions = appendUniqueTracks(current, incoming)
    if (key === 'radar' && additions.length === 0) {
      additions = appendUniqueTracks(current, await fetchPersonalFm())
    }
    if (additions.length === 0) {
      personalizedStreamRetryAfter[key] = Date.now() + PERSONALIZED_STREAM_RETRY_COOLDOWN_MS
      return
    }

    const merged = [...current, ...additions]
    if (key === 'fm') personalFmSongs.value = merged
    else privateContentSongs.value = merged

    const detail = currentDetail.value
    if (detail?.type === 'rec' && detail.section.key === key) {
      replaceTopDetail({ type: 'rec', section: { ...detail.section, tracks: merged } })
      detailTracks.value = merged
    }

    if (session) appendPersonalizedStreamTracks(session, additions)
  } catch {
    personalizedStreamRetryAfter[key] = Date.now() + PERSONALIZED_STREAM_RETRY_COOLDOWN_MS
  } finally {
    personalizedStreamLoading[key] = false
  }
}

type SidebarItem = StreamingSidebarItem

const sidebarItems = computed<SidebarItem[]>(() =>
  buildStreamingSidebarItems({
    ncmAvailable: ncmNavigationAvailable.value,
    providers: providerStore.providers.value
  })
)
const hasOnlineNavigationEntries = computed(() => hasStreamingSidebarEntries(sidebarItems.value))
const visibleTabs = computed(() =>
  sidebarItems.value.filter(
    (item): item is SidebarItem & { tab: StreamingTab } =>
      item.tab === 'home' ||
      item.tab === 'discover' ||
      item.tab === 'library' ||
      item.tab === 'cloud'
  )
)
const currentView = computed(() => visibleTabs.value.find((item) => item.tab === activeTab.value))

const emit = defineEmits<{
  toggleMenu: []
  backToLocal: []
  login: [providerId?: string | null]
}>()

const {
  providerAvailable,
  providerError,
  isLoggedIn,
  profile,
  libraryLoading,
  libraryLoaded,
  libraryError,
  likedPlaylist,
  userPlaylists,
  fetchUserLibrary,
  fetchUserPlaylistsByUid,
  fetchPlaylistTracks,
  fetchLikedTracks,
  fetchLikedTracksPage,
  cloudSongs,
  cloudTotal,
  cloudHasMore,
  cloudLoading,
  cloudLoadingMore,
  cloudError,
  cloudSelectedFiles,
  cloudTransferTasks,
  refreshCloudSongs,
  loadMoreCloudSongs,
  chooseCloudUploadFiles,
  uploadCloudFile,
  downloadCloudSong,
  cancelCloudTransfer,
  removeCloudSelectedFile,
  fetchRecommendSongs,
  fetchRecommendPlaylists,
  fetchPlaylistCategories,
  fetchDiscoveryPlaylists,
  fetchHighQualityPlaylists,
  fetchPersonalFm,
  fetchPrivateContent,
  searchSongs,
  searchPlaylists,
  searchArtists,
  fetchArtistTopSongs,
  fetchArtistAlbums,
  fetchArtistIntro,
  fetchArtistFollowState,
  fetchAlbumTracks,
  fetchArtistPlaylists,
  fetchUserFollows,
  fetchUserFolloweds,
  fetchPlayRecords,
  fetchRecentSongs,
  followArtist,
  followUser,
  likeTrack,
  isTrackLiked,
  syncLikedIds,
  createPlaylist: createNcmPlaylist,
  deletePlaylist: deleteNcmPlaylist,
  addTracksToPlaylist: addNcmTracksToPlaylist,
  removeTracksFromPlaylist: removeNcmTracksFromPlaylist,
  checkLogin
} = useNcmStore()

const playbackStore = usePlayerStore()
const { currentTrack, personalizedStreamSession, personalizedStreamRemaining } = playbackStore
const { playTrack, startPersonalizedStream, appendPersonalizedStreamTracks, formatTime } =
  playbackStore

function playCloudSong(song: import('../stores/useNcmStore.ts').NcmCloudSong): void {
  playTrack(
    song.track,
    cloudSongs.value.map((item) => item.track)
  )
}

function playAllCloudSongs(): void {
  const queue = cloudSongs.value.map((item) => item.track)
  if (queue.length > 0) playTrack(queue[0], queue)
}

async function chooseCloudFiles(): Promise<void> {
  try {
    await chooseCloudUploadFiles()
  } catch (error) {
    pushNotice({ kind: 'error', message: friendlyStreamingError(error, '选择云盘上传文件失败') })
  }
}

async function startCloudUpload(handle: string): Promise<void> {
  try {
    await uploadCloudFile(handle)
  } catch (error) {
    pushNotice({ kind: 'error', message: friendlyStreamingError(error, '创建云盘上传任务失败') })
  }
}

async function startCloudDownload(
  song: import('../stores/useNcmStore.ts').NcmCloudSong
): Promise<void> {
  try {
    await downloadCloudSong(song)
  } catch (error) {
    pushNotice({ kind: 'error', message: friendlyStreamingError(error, '创建云盘下载任务失败') })
  }
}

async function cancelCloudTask(transferId: string): Promise<void> {
  try {
    const cancelled = await cancelCloudTransfer(transferId)
    if (!cancelled) pushNotice({ kind: 'warning', message: '传输任务已结束，无法取消' })
  } catch (error) {
    pushNotice({ kind: 'error', message: friendlyStreamingError(error, '取消云盘传输失败') })
  }
}

function playHomeTrack(track: Track, trackQueue: Track[]): void {
  const section = recSections.value.find((candidate) => candidate.tracks === trackQueue)
  const streamKey = getPersonalizedStreamKey(section ?? null)
  playTrack(track, trackQueue)
  if (streamKey) {
    personalizedStreamRetryAfter[streamKey] = 0
    startPersonalizedStream(streamKey)
  }
}

async function searchUnifiedSongs(
  keywords: string,
  limit?: number,
  offset?: number,
  options?: { signal?: AbortSignal }
): Promise<{ tracks: Track[]; total: number }> {
  const result = await mediaProviders.searchAllSongs({
    query: keywords,
    localTracks: musicStore.tracks.value,
    limit,
    offset,
    signal: options?.signal
  })
  return {
    tracks: result.logicalItems.map((item) => item.preferredTrack),
    total: result.total
  }
}

// ─── Per-provider and local search functions for source switching ──────────

async function searchProviderSongs(
  providerId: string,
  keywords: string,
  limit?: number,
  offset?: number,
  options?: { signal?: AbortSignal }
): Promise<{ tracks: Track[]; total: number }> {
  const result = await mediaProviders.searchSongs(providerId, keywords, limit, offset, options)
  return { tracks: result.items, total: result.total }
}

async function searchProviderPlaylists(
  providerId: string,
  keywords: string,
  limit?: number,
  offset?: number,
  options?: { signal?: AbortSignal }
): Promise<{ playlists: MediaProviderPlaylistSummary[]; total: number }> {
  const result = await mediaProviders.searchPlaylists(providerId, keywords, limit, offset, options)
  return { playlists: result.items, total: result.total }
}

async function searchProviderArtists(
  providerId: string,
  keywords: string,
  limit?: number,
  offset?: number,
  options?: { signal?: AbortSignal }
): Promise<{ artists: MediaProviderArtistSummary[]; total: number }> {
  const result = await mediaProviders.searchArtists(providerId, keywords, limit, offset, options)
  return { artists: result.items, total: result.total }
}

async function searchLocalSongs(
  keywords: string,
  limit: number = 30,
  offset: number = 0
): Promise<{ tracks: Track[]; total: number }> {
  return searchLocalStreamingSongs(musicStore.tracks.value, keywords, limit, offset)
}

async function searchLocalPlaylists(
  keywords: string,
  limit: number = 30,
  offset: number = 0
): Promise<{ playlists: MediaProviderPlaylistSummary[]; total: number }> {
  return searchLocalStreamingPlaylists(musicStore.localPlaylists.value, keywords, limit, offset)
}

async function searchLocalArtists(
  keywords: string,
  limit: number = 30,
  offset: number = 0
): Promise<{ artists: MediaProviderArtistSummary[]; total: number }> {
  return searchLocalStreamingArtists(musicStore.artists.value, keywords, limit, offset)
}

const searchSources = computed<SearchSourceOption[]>(() => {
  const sources: SearchSourceOption[] = [
    {
      id: 'all',
      label: '全部音源',
      icon: 'pi pi-bolt',
      available: true,
      supportedTypes: ['songs', 'playlists', 'artists']
    },
    {
      id: 'local',
      label: '本地音乐',
      icon: 'pi pi-desktop',
      available: musicStore.tracks.value.length > 0,
      supportedTypes: ['songs', 'playlists', 'artists']
    }
  ]
  for (const provider of providerStore.providers.value) {
    const hasSearch = provider.capabilities.includes('search')
    const hasPlaylist = provider.capabilities.includes('playlist')
    const supportedTypes: SearchSourceOption['supportedTypes'] = []
    if (hasSearch) supportedTypes.push('songs', 'artists')
    if (hasPlaylist) supportedTypes.push('playlists')
    if (supportedTypes.length === 0) continue
    sources.push({
      id: provider.id,
      label: provider.name,
      icon: provider.ui?.icon || 'pi pi-cloud',
      available: provider.health?.available !== false,
      supportedTypes
    })
  }
  return sources
})

const {
  searchQuery,
  searchType,
  searchSource,
  searchResults,
  searchPlaylistsResults,
  searchArtistsResults,
  searchTotal,
  searchOffset,
  searchLoading,
  searchError,
  isSearching,
  availableSearchTypes,
  clearSearch,
  performSearch,
  onPageChange,
  onSearchTrackClick
} = useStreamingSearch({
  searchSongs,
  searchUnifiedSongs,
  searchPlaylists,
  searchArtists,
  searchProviderSongs,
  searchProviderPlaylists,
  searchProviderArtists,
  searchLocalSongs,
  searchLocalPlaylists,
  searchLocalArtists,
  searchSources,
  playTrack
})

const discovery = useStreamingDiscovery({
  fetchPlaylistCategories,
  fetchDiscoveryPlaylists,
  fetchHighQualityPlaylists
})

// Like button state
const likingTracks = ref<Set<number>>(new Set())

async function onLikeTrack(track: Track, event: MouseEvent): Promise<void> {
  event.stopPropagation()
  const songId = track.ncmSongId
  if (songId == null || likingTracks.value.has(songId)) return
  const currentlyLiked = isTrackLiked(songId)
  likingTracks.value = new Set([...likingTracks.value, songId])
  try {
    await likeTrack(songId, !currentlyLiked)
  } catch {
    pushNotice({
      kind: 'error',
      message: `${currentlyLiked ? '取消收藏' : '收藏'}「${track.title}」失败，请稍后重试`
    })
  } finally {
    const next = new Set(likingTracks.value)
    next.delete(songId)
    likingTracks.value = next
  }
}

const activeProfile = computed(() =>
  isExternalActive.value ? (activeExternalState.value?.profile ?? null) : profile.value
)
const activeLoggedIn = computed(() =>
  isExternalActive.value ? (activeExternalState.value?.loggedIn ?? false) : isLoggedIn.value
)
const activeProviderAvailable = computed(() =>
  isExternalActive.value
    ? isProviderAvailable(activeProvider.value)
    : ncmNavigationAvailable.value && providerAvailable.value
)
const activeProviderError = computed(() =>
  isExternalActive.value ? (activeExternalState.value?.libraryError ?? '') : providerError.value
)
const activeLibraryLoaded = computed(() =>
  isExternalActive.value ? (activeExternalState.value?.libraryLoaded ?? false) : libraryLoaded.value
)
const activeLibraryError = computed(() =>
  isExternalActive.value ? (activeExternalState.value?.libraryError ?? '') : libraryError.value
)
const activeProviderUnavailable = computed(() => {
  const error = activeProviderError.value
  return /Provider 未启用|provider is disabled|does not implement/i.test(error)
})
const showUnifiedSearch = computed(
  () => hasOnlineNavigationEntries.value && activeProviderAvailable.value && activeLoggedIn.value
)
const trackUnitLabel = computed(() => (isExternalActive.value ? '项' : '首歌曲'))
const profileSignature = computed(() => activeProfile.value?.signature?.trim() || '暂无个人简介')
const unifiedFavoriteTracks = computed(() => musicStore.getPlaylistTracks('我收藏的音乐'))
const showActiveLikedPanel = computed(
  () =>
    !isExternalActive.value ||
    unifiedFavoriteTracks.value.length > 0 ||
    Boolean(activeExternalState.value?.likedPlaylist)
)

const headerTitle = computed(() => {
  if (isExternalActive.value && currentDetail.value?.type === 'playlist')
    return currentDetail.value.playlist.name
  if (isExternalActive.value) return activeProviderLabel.value
  if (isSearching.value) return `搜索: ${searchQuery.value.trim()}`
  if (currentDetail.value?.type === 'rec') return currentDetail.value.section.title
  if (currentDetail.value?.type === 'liked') return '我收藏的歌曲'
  if (currentDetail.value?.type === 'recent') return '最近播放'
  if (currentDetail.value?.type === 'ranking') return '听歌排行'
  if (currentDetail.value?.type === 'playlist') return currentDetail.value.playlist.name
  if (currentDetail.value?.type === 'album') return currentDetail.value.album.name
  return currentView.value?.label ?? '流媒体'
})
const headerSubtitle = computed(() => {
  if (isExternalActive.value)
    return activeLoggedIn.value ? '已登录账号的音乐库' : '登录后展示全部音乐库'
  return timeGreeting.value
})

const timeGreeting = computed(() => resolveTimeGreeting(new Date().getHours()))
const rootLoading = computed(() => {
  if (activeTab.value !== 'library' || currentDetail.value) return false
  return isExternalActive.value
    ? (activeExternalState.value?.libraryLoading ?? false)
    : libraryLoading.value
})

const likedSummary = computed(() => {
  if (isExternalActive.value) {
    const state = activeExternalState.value
    const providerSummary = {
      name: state?.likedPlaylist?.name ?? '我喜欢的音乐',
      cover: state?.likedPlaylist?.cover ?? null,
      coverSource: state?.likedPlaylist?.coverSource ?? null,
      trackCount: state?.likedPlaylist?.trackCount ?? 0
    }
    // Prefer the provider liked playlist; only fall back to local unified
    // favorites when the external source has no liked playlist of its own.
    if (state?.likedPlaylist) return providerSummary
    return summarizeUnifiedFavorites({
      unifiedTracks: unifiedFavoriteTracks.value,
      providerSummary
    })
  }
  // NCM cloud likes are authoritative on the streaming page. Local default
  // favorites ("我收藏的音乐") must not replace or shrink this summary.
  return {
    name: '我收藏的歌曲',
    cover: likedPlaylist.value?.cover ?? null,
    coverSource: likedPlaylist.value?.coverSource ?? null,
    trackCount: likedCount.value ?? likedPlaylist.value?.trackCount ?? 0
  }
})

const userPlaylistEntries = computed(() =>
  isExternalActive.value ? (activeExternalState.value?.playlists ?? []) : userPlaylists.value
)

const currentArtistPlaylists = computed(() =>
  currentDetail.value?.type === 'artist' ? artistPlaylists.value : []
)
const currentArtistAlbums = computed(() =>
  currentDetail.value?.type === 'artist' ? artistAlbums.value : []
)
const artistDetailTabs = computed<Array<{ key: ArtistDetailTab; label: string; count: number }>>(
  () => [
    { key: 'songs', label: '全部歌曲', count: detailTracks.value.length },
    { key: 'albums', label: '专辑', count: currentArtistAlbums.value.length },
    { key: 'playlists', label: '创建的歌单', count: currentArtistPlaylists.value.length }
  ]
)
const hasTrackDetailLoadingSurface = computed(
  () =>
    currentDetail.value?.type === 'liked' ||
    currentDetail.value?.type === 'playlist' ||
    currentDetail.value?.type === 'album' ||
    currentDetail.value?.type === 'artist' ||
    currentDetail.value?.type === 'ranking'
)
const showDetailInitialLoading = computed(
  () =>
    hasTrackDetailLoadingSurface.value &&
    detailLoading.value &&
    detailTracks.value.length === 0 &&
    currentArtistAlbums.value.length === 0 &&
    currentArtistPlaylists.value.length === 0
)
const showTrackDetailStage = computed(() => {
  const detail = currentDetail.value
  if (!detail) return false
  if (detail.type === 'user_list' || detail.type === 'user_playlists') return false
  if (detail.type === 'artist') return false
  return true
})
const showDetailOverlayLoading = computed(() => {
  // Track / social stages own their skeletons; only show sticky overlay for partial reloads.
  if (showTrackDetailStage.value) {
    return detailLoading.value && detailTracks.value.length > 0
  }
  const detail = currentDetail.value
  if (detail?.type === 'user_list') {
    return detailLoading.value && detailUsers.value.length > 0
  }
  if (detail?.type === 'user_playlists') {
    return detailLoading.value && detail.playlists.length > 0
  }
  if (detail?.type === 'artist') {
    return (
      detailLoading.value &&
      (detailTracks.value.length > 0 ||
        currentArtistAlbums.value.length > 0 ||
        currentArtistPlaylists.value.length > 0)
    )
  }
  return detailLoading.value && !showDetailInitialLoading.value
})
const detailTrackCountLabel = computed(() => {
  if (currentDetail.value?.type === 'liked' && likedTracksTotal.value != null) {
    return `${detailTracks.value.length} / ${likedTracksTotal.value} 首`
  }
  return `${detailTracks.value.length} 首`
})

const detailHeaderInfo = computed<DetailHeaderInfo | null>(() => {
  if (!currentDetail.value) return null
  if (currentDetail.value.type === 'liked') {
    return {
      title: '我收藏的歌曲',
      cover: likedSummary.value.cover,
      coverSource: likedSummary.value.coverSource ?? null,
      desc: `共 ${likedSummary.value.trackCount} 首歌曲`,
      icon: 'pi pi-heart-fill'
    }
  }
  if (currentDetail.value.type === 'playlist') {
    return {
      title: currentDetail.value.playlist.name,
      cover: currentDetail.value.playlist.cover,
      coverSource: currentDetail.value.playlist.coverSource ?? null,
      desc: `共 ${currentDetail.value.playlist.trackCount} ${trackUnitLabel.value}`,
      icon: 'pi pi-list'
    }
  }
  if (currentDetail.value.type === 'rec') {
    const firstTrack = currentDetail.value.section.tracks[0]
    return {
      title: currentDetail.value.section.title,
      cover: firstTrack?.cover ?? null,
      coverSource: firstTrack?.coverSource ?? null,
      desc: `共 ${currentDetail.value.section.tracks.length} ${trackUnitLabel.value}`,
      icon: currentDetail.value.section.icon
    }
  }
  if (currentDetail.value.type === 'album') {
    return {
      title: currentDetail.value.album.name,
      cover: currentDetail.value.album.cover,
      coverSource: currentDetail.value.album.coverSource ?? null,
      desc: `共 ${detailTracks.value.length || currentDetail.value.album.trackCount} 首歌曲`,
      icon: 'pi pi-clone'
    }
  }
  if (currentDetail.value.type === 'artist') {
    const songCount = detailTracks.value.length
    const albumCount = artistAlbums.value.length
    const playlistCount = artistPlaylists.value.length
    const descParts: string[] = []
    if (songCount > 0) descParts.push(`${songCount} 首歌曲`)
    if (albumCount > 0) descParts.push(`${albumCount} 张专辑`)
    if (playlistCount > 0) descParts.push(`${playlistCount} 个歌单`)
    return {
      title: currentDetail.value.artist.name,
      cover: currentDetail.value.artist.picUrl,
      desc: descParts.length > 0 ? `共 ${descParts.join('，')}` : '暂无可展示内容',
      intro: artistIntro.value,
      icon: 'pi pi-user'
    }
  }
  if (currentDetail.value.type === 'user_list') {
    return {
      title: currentDetail.value.title,
      cover: null,
      desc: `共 ${currentDetail.value.users.length} 人`,
      icon: 'pi pi-users'
    }
  }
  if (currentDetail.value.type === 'user_playlists') {
    return {
      title: currentDetail.value.user.name + ' 的歌单',
      cover: currentDetail.value.user.picUrl,
      desc: `共 ${currentDetail.value.playlists.length} 个歌单`,
      icon: 'pi pi-user'
    }
  }
  if (currentDetail.value.type === 'recent') {
    const firstTrack = detailTracks.value[0]
    return {
      title: '最近播放',
      cover: firstTrack?.cover ?? null,
      coverSource: firstTrack?.coverSource ?? null,
      desc: `共 ${detailTracks.value.length} 首歌曲`,
      icon: 'pi pi-history'
    }
  }
  if (currentDetail.value.type === 'ranking') {
    const firstTrack = detailTracks.value[0]
    return {
      title: '听歌排行',
      cover: firstTrack?.cover ?? null,
      coverSource: firstTrack?.coverSource ?? null,
      desc: `共 ${detailTracks.value.length} 首歌曲`,
      icon: 'pi pi-chart-bar'
    }
  }
  return null
})

const detailFollowState = computed<boolean>(() => {
  if (currentDetail.value?.type === 'artist') return artistFollowed.value === true
  if (currentDetail.value?.type === 'user_playlists')
    return currentDetail.value.user.followed === true
  return false
})

const showDetailFollowButton = computed(() => {
  if (currentDetail.value?.type === 'user_playlists') return true
  if (currentDetail.value?.type !== 'artist') return false
  return !isExternalActive.value || Boolean(mediaProviders.get(activeProvider.value)?.followArtist)
})

const detailFollowButtonLabel = computed(() => (detailFollowState.value ? '取消关注' : '关注'))

const detailFollowButtonIcon = computed(() =>
  followActionLoading.value
    ? 'pi pi-spin pi-spinner'
    : detailFollowState.value
      ? 'pi pi-user-minus'
      : 'pi pi-user-plus'
)

function selectTab(key: StreamingTab): void {
  if (isExternalActive.value && key !== 'library' && key !== 'recent') return
  if (activeTab.value !== key) {
    const oldIndex = getStreamingTabIndex(visibleTabs.value, activeTab.value)
    const newIndex = getStreamingTabIndex(visibleTabs.value, key)
    streamingTransitionName.value = newIndex > oldIndex ? 'stream-page-down' : 'stream-page-up'
    resetDetail({ animate: false })
  }
  activeTab.value = key
}

function selectProvider(provider: string, persist = true): void {
  if (!persist) {
    fallbackProvider.value = provider
    return
  }
  fallbackProvider.value = null
  if (preferredProvider.value === provider) return
  // Only an explicit user action changes the persisted preference; availability
  // fallbacks never write back, so the choice survives restarts and plugin toggles.
  preferredProvider.value = provider
  void settingsStore.updateSettings({ streamingActiveProvider: provider })
}

function isSidebarItemActive(item: SidebarItem): boolean {
  if (showAggregatePanel.value) return false
  if (item.tab === 'library') {
    return (
      activeTab.value === 'library' &&
      libraryProviders.value.some((provider) => provider.id === activeProvider.value)
    )
  }
  return isSidebarItemActiveForProvider({
    itemProvider: item.provider,
    itemKey: item.key,
    activeProvider: activeProvider.value,
    activeTab: activeTab.value
  })
}

// 聚合歌单在流媒体壳里就地渲染，刻意不走 activeTab —— 它不是某个 provider 的
// 在线导航条目，掺进去会连带改动 buildStreamingSidebarItems 的语义和加载流程。
const showAggregatePanel = ref(false)

function selectAggregatePanel(): void {
  showAggregatePanel.value = true
}

function selectSidebarItem(item: SidebarItem, options: { persistProvider?: boolean } = {}): void {
  showAggregatePanel.value = false
  const persistProvider = options.persistProvider !== false
  if (item.tab === 'recent') {
    selectTab('recent')
    void openRecent()
    return
  }
  if (item.tab === 'library') {
    const provider = getSharedLibraryProviderId(
      activeProvider.value,
      libraryProviders.value.map((libraryProvider) => libraryProvider.id),
      NCM_PROVIDER_ID
    )
    if (activeProvider.value !== provider) {
      selectProvider(provider, persistProvider)
    }
    selectTab('library')
    return
  }
  if (item.tab === 'cloud') {
    clearSearch()
  }
  if (item.provider !== NCM_PROVIDER_ID) {
    selectProvider(item.provider, persistProvider)
    selectTab(item.tab ?? 'library')
    return
  }
  if (activeProvider.value !== NCM_PROVIDER_ID) {
    selectProvider(NCM_PROVIDER_ID, persistProvider)
  }
  if (item.tab) selectTab(item.tab)
}

function clearDetailState(): void {
  detailTracks.value = []
  detailUsers.value = []
  artistAlbums.value = []
  artistPlaylists.value = []
  artistIntro.value = ''
  artistFollowed.value = null
  activeArtistTab.value = 'songs'
  detailLoading.value = false
  detailError.value = ''
  resetLikedTracksPaging()
  followActionLoading.value = false
  followActionError.value = ''
}

function captureDetailState(): DetailSnapshot {
  return {
    tracks: detailTracks.value,
    users: detailUsers.value,
    artistAlbumsList: artistAlbums.value,
    artistPlaylistsList: artistPlaylists.value,
    intro: artistIntro.value,
    followed: artistFollowed.value,
    artistTab: activeArtistTab.value,
    liked: likedCount.value,
    likedPaging: {
      nextOffset: likedTracksNextOffset.value,
      total: likedTracksTotal.value,
      hasMore: likedTracksHasMore.value
    }
  }
}

function applyDetailState(snapshot: DetailSnapshot | undefined): void {
  if (!snapshot) {
    clearDetailState()
    return
  }
  detailTracks.value = snapshot.tracks
  detailUsers.value = snapshot.users
  artistAlbums.value = snapshot.artistAlbumsList
  artistPlaylists.value = snapshot.artistPlaylistsList
  artistIntro.value = snapshot.intro
  artistFollowed.value = snapshot.followed
  activeArtistTab.value = snapshot.artistTab
  likedCount.value = snapshot.liked
  likedTracksNextOffset.value = snapshot.likedPaging.nextOffset
  likedTracksTotal.value = snapshot.likedPaging.total
  likedTracksHasMore.value = snapshot.likedPaging.hasMore
  detailLoading.value = false
  detailError.value = ''
  followActionLoading.value = false
  followActionError.value = ''
}

// Navigates one level deeper. The outgoing level's loaded data is snapshotted
// onto its own entry first, so back-navigation restores instead of refetching.
function pushDetail(view: DetailView): void {
  const top = detailStack.value[detailStack.value.length - 1]
  if (top) top.snapshot = captureDetailState()
  detailStack.value.push({ view })
}

// Replaces the top entry in place (same level, fresher data).
function replaceTopDetail(view: DetailView): void {
  const top = detailStack.value[detailStack.value.length - 1]
  if (top) top.view = view
}

// Pops exactly one level and restores the level underneath, if any.
function popDetail(): void {
  if (detailStack.value.length === 0) return
  detailLoadToken++
  streamingTransitionName.value = 'stream-detail-back'
  const el = streamingContentRef.value
  if (el) el.scrollTop = 0
  detailStack.value.pop()
  const top = detailStack.value[detailStack.value.length - 1]
  applyDetailState(top?.snapshot)
  if (top) top.snapshot = undefined
}

// Drops matching entries wherever they sit in the stack (e.g. a playlist that
// was just deleted), restoring the new top when the visible level went away.
function removeDetailEntries(predicate: (view: DetailView) => boolean): void {
  if (!detailStack.value.some((entry) => predicate(entry.view))) return
  const removedTop = currentDetail.value ? predicate(currentDetail.value) : false
  detailStack.value = detailStack.value.filter((entry) => !predicate(entry.view))
  if (!removedTop) return
  detailLoadToken++
  const top = detailStack.value[detailStack.value.length - 1]
  applyDetailState(top?.snapshot)
  if (top) top.snapshot = undefined
}

function resetDetail(options?: { animate?: boolean }): void {
  detailLoadToken++
  const animate = options?.animate !== false
  if (animate && currentDetail.value) {
    streamingTransitionName.value = 'stream-detail-back'
    const el = streamingContentRef.value
    if (el) el.scrollTop = 0
  }
  detailStack.value = []
  clearDetailState()
}

function resetLikedTracksPaging(): void {
  likedTracksNextOffset.value = 0
  likedTracksTotal.value = null
  likedTracksHasMore.value = false
  likedTracksLoadingMore.value = false
  likedTracksLoadMoreError.value = ''
}

function ensureVisibleSidebarSelection(): void {
  if (!hasOnlineNavigationEntries.value) {
    fallbackProvider.value = null
    resetDetail()
    clearSearch()
    return
  }
  if (sidebarItems.value.some((item) => isSidebarItemActive(item))) {
    return
  }
  const firstTab = getFirstVisibleStreamingTab(sidebarItems.value)
  const nextItem = firstTab
    ? sidebarItems.value.find((item) => item.tab === firstTab)
    : sidebarItems.value[0]
  if (nextItem) {
    selectSidebarItem(nextItem, { persistProvider: false })
  }
}

function beginDetailLoad(): number {
  const token = ++detailLoadToken
  detailTracks.value = []
  detailUsers.value = []
  artistAlbums.value = []
  artistPlaylists.value = []
  artistIntro.value = ''
  artistFollowed.value = null
  detailLoading.value = true
  detailError.value = ''
  resetLikedTracksPaging()
  followActionError.value = ''
  return token
}

function isActiveDetailLoad(token: number): boolean {
  return token === detailLoadToken
}

async function findArtistByUserName(user: NcmUserSummary): Promise<NcmArtistSummary | null> {
  const keyword = user.name.trim()
  if (!keyword) return null
  const { artists } = await searchArtists(keyword, 8, 0)
  return findBestStreamingArtistMatch(keyword, artists)
}

async function ensureLibraryLoaded(force = false): Promise<void> {
  if (isExternalActive.value) {
    await ensureExternalLibraryLoaded(activeProvider.value, force)
    return
  }
  if (!isLoggedIn.value) return
  try {
    await fetchUserLibrary(force)
  } catch {
    // error is already stored in libraryError
  }
}

async function refreshExternalProviderState(id: string): Promise<void> {
  await providerStore.syncProviders().catch(() => undefined)
  const state = ensureExternalState(id)
  if (!isProviderAvailable(id)) {
    state.loggedIn = false
    state.profile = null
    state.playlists = []
    state.likedPlaylist = null
    state.pinnedPlaylistIds = []
    state.libraryLoaded = false
    state.libraryError = ''
    return
  }
  try {
    const loginState = await providerStore.checkLogin(id)
    state.loggedIn = loginState.loggedIn
    state.profile = loginState.profile ?? null
    if (!loginState.loggedIn) {
      state.playlists = []
      state.likedPlaylist = null
      state.pinnedPlaylistIds = []
      state.libraryLoaded = false
    }
    state.libraryError = ''
  } catch (error) {
    state.loggedIn = false
    state.profile = null
    state.libraryError = friendlyStreamingError(
      error,
      `${externalProviderName(id, (providerId) => providerStore.getProvider(providerId)?.name)} 登录状态检查失败`
    )
  }
}

async function ensureExternalLibraryLoaded(id: string, force = false): Promise<void> {
  const state = ensureExternalState(id)
  if (!isProviderAvailable(id) || !state.loggedIn) return
  if (state.libraryLoaded && !force) return
  state.libraryLoading = true
  state.libraryError = ''
  try {
    const library = await providerStore.fetchUserLibrary(id, force)
    state.likedPlaylist = library.likedPlaylist ?? null
    state.playlists = library.playlists
    state.pinnedPlaylistIds = library.playlists
      .filter((playlist) => {
        const playlistWithPinned = playlist as MediaProviderPlaylistSummary & { pinned?: boolean }
        return playlistWithPinned.pinned === true
      })
      .map((playlist) => String(playlist.id))
    state.libraryLoaded = true
  } catch (error) {
    state.libraryError = friendlyStreamingError(
      error,
      `加载 ${externalProviderName(id, (providerId) => providerStore.getProvider(providerId)?.name)} 音乐库失败`
    )
  } finally {
    state.libraryLoading = false
  }
}

async function openLikedTracks(force = false): Promise<void> {
  // External providers (e.g. YouTube Music) expose liked music as a playlist
  // (ytm's "LM"), so open it through the generic playlist path rather than the
  // ncm-only fetchLikedTracks.
  if (isExternalActive.value) {
    const liked = activeExternalState.value?.likedPlaylist
    if (liked) {
      await openPlaylist(liked, force)
      return
    }
    // No provider liked playlist: fall back to local unified favorites only.
    const unifiedTracks = unifiedFavoriteTracks.value
    beginDetailTransition()
    pushDetail({ type: 'liked' })
    detailTracks.value = unifiedTracks
    likedCount.value = unifiedTracks.length
    detailError.value = ''
    detailLoading.value = false
    return
  }

  // NCM: always load cloud liked tracks. Local "我收藏的音乐" is a separate
  // in-app playlist and must not short-circuit the provider liked list.
  beginDetailTransition()
  pushDetail({ type: 'liked' })
  const token = beginDetailLoad()

  try {
    const page = await fetchLikedTracksPage(0, LIKED_TRACKS_PAGE_SIZE, force)
    if (!isActiveDetailLoad(token)) return
    detailTracks.value = page.tracks
    likedCount.value = page.total
    likedTracksTotal.value = page.total
    likedTracksNextOffset.value = page.nextOffset
    likedTracksHasMore.value = page.hasMore
    syncLikedIds(page.tracks)
    await nextTick()
    void ensureLikedTracksScrollable()
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    detailError.value = friendlyStreamingError(error, '加载收藏歌曲失败')
    detailTracks.value = []
  } finally {
    if (isActiveDetailLoad(token)) {
      detailLoading.value = false
    }
  }
}

async function loadMoreLikedTracks(): Promise<void> {
  if (currentDetail.value?.type !== 'liked') return
  if (isExternalActive.value) return
  if (likedTracksLoadingMore.value || !likedTracksHasMore.value) return

  const token = detailLoadToken
  likedTracksLoadingMore.value = true
  likedTracksLoadMoreError.value = ''

  try {
    const page = await fetchLikedTracksPage(
      likedTracksNextOffset.value,
      LIKED_TRACKS_PAGE_SIZE,
      false
    )
    if (!isActiveDetailLoad(token) || currentDetail.value?.type !== 'liked') return
    const existing = new Set(detailTracks.value.map((track) => track.id))
    const nextTracks = page.tracks.filter((track) => !existing.has(track.id))
    detailTracks.value = [...detailTracks.value, ...nextTracks]
    likedCount.value = page.total
    likedTracksTotal.value = page.total
    likedTracksNextOffset.value = page.nextOffset
    likedTracksHasMore.value = page.hasMore
    syncLikedIds(page.tracks)
    await nextTick()
    void ensureLikedTracksScrollable()
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    likedTracksLoadMoreError.value = friendlyStreamingError(error, '继续加载收藏歌曲失败')
  } finally {
    if (isActiveDetailLoad(token)) {
      likedTracksLoadingMore.value = false
    }
  }
}

async function ensureLikedTracksScrollable(): Promise<void> {
  await nextTick()
  const element = streamingContentRef.value
  if (!element) return
  if (currentDetail.value?.type !== 'liked' || !likedTracksHasMore.value) return
  if (likedTracksLoadingMore.value) return
  if (element.scrollHeight > element.clientHeight + 48) return
  await loadMoreLikedTracks()
}

async function openPlaylist(playlist: MediaProviderPlaylistSummary, force = false): Promise<void> {
  beginDetailTransition()
  pushDetail({ type: 'playlist', playlist })
  const token = beginDetailLoad()

  try {
    const tracks = isExternalActive.value
      ? await providerStore.fetchPlaylistTracks(activeProvider.value, playlist.id, force)
      : await fetchPlaylistTracks(playlist.id, force)
    if (!isActiveDetailLoad(token)) return
    detailTracks.value = tracks
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    detailError.value = friendlyStreamingError(error, '加载列表失败')
    detailTracks.value = []
  } finally {
    if (isActiveDetailLoad(token)) {
      detailLoading.value = false
    }
  }
}

async function openAlbum(album: MediaProviderAlbumSummary): Promise<void> {
  beginDetailTransition()
  pushDetail({ type: 'album', album })
  const token = beginDetailLoad()

  try {
    const provider = mediaProviders.get(activeProvider.value)
    const tracks = isExternalActive.value
      ? provider?.fetchAlbumTracks
        ? await provider.fetchAlbumTracks(album.id)
        : []
      : await fetchAlbumTracks(Number(album.id))
    if (!isActiveDetailLoad(token)) return
    detailTracks.value = tracks
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    detailError.value = friendlyStreamingError(error, '加载专辑失败')
    detailTracks.value = []
  } finally {
    if (isActiveDetailLoad(token)) {
      detailLoading.value = false
    }
  }
}

async function openArtist(
  artist: MediaProviderArtistSummary,
  linkedUser?: NcmUserSummary
): Promise<void> {
  beginDetailTransition()
  pushDetail({ type: 'artist', artist, user: linkedUser })
  activeArtistTab.value = 'songs'
  const token = beginDetailLoad()

  try {
    if (isExternalActive.value) {
      const provider = mediaProviders.get(activeProvider.value)
      if (!provider?.fetchArtistTopSongs) {
        throw new Error(`${activeProviderLabel.value} does not implement fetchArtistTopSongs`)
      }
      const [tracks, albums, playlists, intro, followed] = await Promise.all([
        provider.fetchArtistTopSongs(artist.id).catch(() => [] as Track[]),
        provider.fetchArtistAlbums?.(artist.id).catch(() => [] as MediaProviderAlbumSummary[]) ??
          Promise.resolve([] as MediaProviderAlbumSummary[]),
        provider
          .fetchArtistPlaylists?.(artist.id)
          .catch(() => [] as MediaProviderPlaylistSummary[]) ??
          Promise.resolve([] as MediaProviderPlaylistSummary[]),
        provider.fetchArtistIntro?.(artist.id).catch(() => '') ?? Promise.resolve(''),
        provider.fetchArtistFollowState?.(artist.id).catch(() => null) ?? Promise.resolve(null)
      ])
      if (!isActiveDetailLoad(token)) return
      detailTracks.value = tracks
      artistAlbums.value = albums
      artistPlaylists.value = playlists
      artistIntro.value = intro
      artistFollowed.value = followed
      return
    }

    const ncmArtist: NcmArtistSummary = {
      id: Number(artist.id),
      name: artist.name,
      picUrl: artist.picUrl,
      picUrlSource: artist.picUrlSource ?? null,
      albumSize: artist.albumSize ?? 0,
      musicSize: artist.musicSize ?? 0
    }
    let resolvedArtist = await resolveLinkedStreamingArtist(
      ncmArtist,
      linkedUser,
      findArtistByUserName
    )
    let [tracks, albums, artistOwnedPlaylists, userOwnedPlaylists, intro, followed] =
      await Promise.all([
        fetchArtistTopSongs(resolvedArtist.id).catch(() => [] as Track[]),
        fetchArtistAlbums(resolvedArtist.id).catch(() => [] as NcmAlbumSummary[]),
        fetchArtistPlaylists(resolvedArtist.id).catch(() => [] as NcmPlaylistSummary[]),
        linkedUser
          ? fetchUserPlaylistsByUid(linkedUser.id, true).catch(() => [] as NcmPlaylistSummary[])
          : Promise.resolve([] as NcmPlaylistSummary[]),
        fetchArtistIntro(resolvedArtist.id).catch(() => ''),
        fetchArtistFollowState(resolvedArtist.id).catch(() => null)
      ])

    if (linkedUser && resolvedArtist.id === Number(artist.id) && tracks.length === 0) {
      const matchedArtist = await findArtistByUserName(linkedUser).catch(() => null)
      if (matchedArtist && matchedArtist.id !== Number(artist.id)) {
        const [matchedTracks, matchedAlbums, matchedPlaylists, matchedIntro, matchedFollowed] =
          await Promise.all([
            fetchArtistTopSongs(matchedArtist.id).catch(() => [] as Track[]),
            fetchArtistAlbums(matchedArtist.id).catch(() => [] as NcmAlbumSummary[]),
            fetchArtistPlaylists(matchedArtist.id).catch(() => [] as NcmPlaylistSummary[]),
            fetchArtistIntro(matchedArtist.id).catch(() => ''),
            fetchArtistFollowState(matchedArtist.id).catch(() => null)
          ])
        if (matchedTracks.length > 0 || matchedAlbums.length > 0 || matchedPlaylists.length > 0) {
          resolvedArtist = {
            ...matchedArtist,
            picUrl: matchedArtist.picUrl ?? artist.picUrl,
            picUrlSource: matchedArtist.picUrlSource ?? artist.picUrlSource ?? null
          }
          tracks = matchedTracks
          albums = matchedAlbums
          artistOwnedPlaylists = mergePlaylistSummaries(artistOwnedPlaylists, matchedPlaylists)
          intro = matchedIntro
          followed = matchedFollowed
        }
      }
    }

    if (!isActiveDetailLoad(token)) return
    if (currentDetail.value?.type === 'artist') {
      currentDetail.value.artist = resolvedArtist
    }
    detailTracks.value = tracks
    artistAlbums.value = albums
    artistPlaylists.value = mergePlaylistSummaries(artistOwnedPlaylists, userOwnedPlaylists)
    artistIntro.value = intro
    artistFollowed.value = followed
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    detailError.value = friendlyStreamingError(error, '加载歌手页面失败')
    detailTracks.value = []
    artistAlbums.value = []
    artistPlaylists.value = []
  } finally {
    if (isActiveDetailLoad(token)) {
      detailLoading.value = false
    }
  }
}

let artistNavigationToken = 0

async function openRequestedArtist(request: StreamingArtistNavigationRequest): Promise<void> {
  const providerId = request.providerId.trim().toLowerCase()
  const artistName = request.artistName.trim()
  if (!providerId || !artistName) return
  const token = ++artistNavigationToken

  await providerStore.syncProviders().catch(() => undefined)
  const provider = mediaProviders.get(providerId)
  // 带歌手 id 时搜索只用来补头图等展示字段，provider 没有 searchArtists 也能开页；
  // 只有回退到按名字定位才必须能搜。
  if (!provider?.fetchArtistTopSongs || (request.artistId == null && !provider.searchArtists)) {
    if (token !== artistNavigationToken) return
    pushNotice({
      kind: 'error',
      message: `${provider?.name ?? providerId} 暂不支持歌手详情`
    })
    return
  }

  if (activeProvider.value !== providerId) {
    selectProvider(providerId, false)
    await nextTick()
  }

  try {
    const searchResult = provider.searchArtists
      ? await mediaProviders.searchArtists(providerId, artistName, 8, 0).catch((error: unknown) => {
          // 按名字定位时搜不到就彻底无从下手；带 id 时搜索失败只是少了头图。
          if (request.artistId == null) throw error
          return null
        })
      : null
    if (token !== artistNavigationToken) return

    if (request.artistId != null) {
      // 选人只认 id，所以同名歌手里挑出的一定是曲目实际标注的那位。搜索结果仅用于
      // 补 picUrl / albumSize 等展示字段，没有同 id 的候选就用最小信息开页。
      const matched = searchResult
        ? findStreamingArtistById(request.artistId, searchResult.items)
        : null
      await openArtist(matched ?? { id: request.artistId, name: artistName, picUrl: null })
      return
    }

    const candidates = matchStreamingArtistsByName(artistName, searchResult?.items ?? [])
    const artist = candidates[0]
    if (!artist) {
      pushNotice({ kind: 'error', message: `未找到歌手「${artistName}」` })
      return
    }
    if (candidates.length > 1) {
      // 曲目没带歌手 id（旧快照 / provider 未提供），同名候选只能按搜索排序取第一个。
      // 结果可能不是用户想要的那位，明说出来，别装作命中唯一。
      pushNotice({
        kind: 'info',
        message: `有多位歌手叫「${artistName}」，已打开搜索结果中排最前的一位`
      })
    }
    await openArtist(artist)
  } catch (error) {
    if (token !== artistNavigationToken) return
    pushNotice({ kind: 'error', message: friendlyStreamingError(error, '打开歌手页面失败') })
  }
}

async function openUserList(listType: 'follows' | 'followers'): Promise<void> {
  if (!profile.value) return
  beginDetailTransition()
  pushDetail({
    type: 'user_list',
    listType,
    users: [],
    title: listType === 'follows' ? '关注' : '粉丝'
  })
  const token = beginDetailLoad()

  try {
    const uid = profile.value.userId
    const fetchFunc = listType === 'follows' ? fetchUserFollows : fetchUserFolloweds
    const users = await fetchFunc(uid, 100, 0)
    if (!isActiveDetailLoad(token)) return
    detailUsers.value = users
    const userListView = currentDetail.value
    if (userListView?.type === 'user_list') {
      userListView.users = detailUsers.value
    }
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    detailError.value = friendlyStreamingError(
      error,
      `加载${listType === 'follows' ? '关注' : '粉丝'}列表失败`
    )
  } finally {
    if (isActiveDetailLoad(token)) {
      detailLoading.value = false
    }
  }
}

async function openUserPlaylists(user: NcmUserSummary): Promise<void> {
  beginDetailTransition()
  pushDetail({ type: 'user_playlists', user, playlists: [] })
  const token = beginDetailLoad()

  try {
    const playlists = await fetchUserPlaylistsByUid(user.id)
    if (!isActiveDetailLoad(token)) return
    const userPlaylistsView = currentDetail.value
    if (userPlaylistsView?.type === 'user_playlists') {
      userPlaylistsView.playlists = playlists
    }
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    detailError.value = friendlyStreamingError(error, '加载用户歌单失败')
  } finally {
    if (isActiveDetailLoad(token)) {
      detailLoading.value = false
    }
  }
}

async function openRecent(): Promise<void> {
  beginDetailTransition()
  pushDetail({ type: 'recent' })
  const token = beginDetailLoad()

  try {
    const recentStats = getRecentTracks()
    const providerId = activeProvider.value
    const filteredStats = recentStats.filter((stat) =>
      stat.sourceIds?.some((sid) => sid.source === providerId)
    )
    let tracks = resolveUnifiedRecentTracks({
      recentStats: filteredStats,
      localTracks: musicStore.tracks.value
    })
    if (providerId === NCM_PROVIDER_ID) {
      const serverRecent = await fetchRecentSongs().catch(() => [] as Track[])
      const seenIds = new Set(tracks.map((t) => t.id))
      for (const t of serverRecent) {
        if (!seenIds.has(t.id)) {
          tracks.push(t)
          seenIds.add(t.id)
        }
      }
    }

    if (!isActiveDetailLoad(token)) return
    detailTracks.value = tracks
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    detailError.value = friendlyStreamingError(error, '加载最近播放失败')
    detailTracks.value = []
  } finally {
    if (isActiveDetailLoad(token)) {
      detailLoading.value = false
    }
  }
}

async function openRanking(): Promise<void> {
  beginDetailTransition()
  pushDetail({ type: 'ranking' })
  const token = beginDetailLoad()

  try {
    const topStats = getTopTracks()
    let tracks = resolveUnifiedRecentTracks({
      recentStats: topStats,
      localTracks: musicStore.tracks.value
    })
    if (tracks.length === 0) {
      tracks = await fetchPlayRecords(1)
    }
    if (!isActiveDetailLoad(token)) return
    detailTracks.value = tracks
  } catch (error) {
    if (!isActiveDetailLoad(token)) return
    detailError.value = friendlyStreamingError(error, '加载听歌排行失败')
    detailTracks.value = []
  } finally {
    if (isActiveDetailLoad(token)) {
      detailLoading.value = false
    }
  }
}

async function onUserClick(user: NcmUserSummary): Promise<void> {
  const artistId = Number(user.artistId ?? user.id)
  if (
    (user.userType === 2 || user.userType === 4 || user.userType === 6) &&
    Number.isFinite(artistId) &&
    artistId > 0
  ) {
    await openArtist(
      {
        id: artistId,
        name: user.name,
        picUrl: user.picUrl,
        picUrlSource: user.picUrlSource ?? null,
        albumSize: 0,
        musicSize: user.musicSize
      },
      user
    )
  } else {
    await openUserPlaylists(user)
  }
}

async function toggleCurrentDetailFollow(): Promise<void> {
  const detail = currentDetail.value
  if (!detail || followActionLoading.value) return
  const nextFollowState = !detailFollowState.value
  followActionLoading.value = true
  followActionError.value = ''
  try {
    if (detail.type === 'artist') {
      if (isExternalActive.value) {
        const follow = mediaProviders.get(activeProvider.value)?.followArtist
        if (!follow) return
        await follow(detail.artist.id, nextFollowState)
      } else {
        await followArtist(Number(detail.artist.id), nextFollowState)
      }
      artistFollowed.value = nextFollowState
      return
    }
    if (detail.type === 'user_playlists') {
      await followUser(detail.user.id, nextFollowState)
      detail.user.followed = nextFollowState
    }
  } catch (error) {
    followActionError.value = friendlyStreamingError(
      error,
      nextFollowState ? '关注失败' : '取消关注失败'
    )
  } finally {
    followActionLoading.value = false
  }
}

function goBack(): void {
  clearSelection()
  popDetail()
}

// The title-bar back button routes here through the global back stack (App.vue
// registers the page-level layers). One entry covers this page's two deep
// states with the same priority the old header back button had: an open
// detail level first, then an active search. Gated on `active` because this
// page stays mounted (v-show) while hidden behind local mode.
useBackHandler(
  computed(() => props.active !== false && (detailStack.value.length > 0 || isSearching.value)),
  () => {
    if (detailStack.value.length > 0) goBack()
    else clearSearch()
  }
)

const streamingListTracks = computed(() => {
  if (isSearching.value && !currentDetail.value) return searchResults.value
  return detailTracks.value
})

const multiSelectEnabled = computed(
  () =>
    !!currentDetail.value ||
    (isSearching.value && !currentDetail.value && searchType.value === 'songs')
)

const multiSelect = useTrackMultiSelect({
  tracks: streamingListTracks,
  resetSources: [
    currentDetail,
    activeTab,
    searchQuery,
    searchType,
    isSearching,
    () => detailTracks.value.length
  ],
  enabled: multiSelectEnabled
})

const { selectedIds, selectedCount, hasSelection, isSelected, clearSelection, getSelectedTracks } =
  multiSelect

function isStreamingTrackFavorited(track: Track): boolean {
  if (track.ncmSongId != null) return isTrackLiked(track.ncmSongId)
  return musicStore.isFavoriteTrack(track)
}

const selectionAllFavorited = computed(() => {
  const selected = getSelectedTracks()
  return selected.length > 0 && selected.every(isStreamingTrackFavorited)
})

const showStreamingContextMenu = ref(false)
const streamingContextMenuX = ref(0)
const streamingContextMenuY = ref(0)
const showStreamingPlaylistSubmenu = ref(false)
const streamingContextMenuTrack = ref<Track | null>(null)
const streamingContextUsesSelection = computed(() => {
  const track = streamingContextMenuTrack.value
  return !!track && isSelected(track.id) && selectedCount.value > 0
})
const streamingContextActionTracks = computed(() => {
  const track = streamingContextMenuTrack.value
  if (!track) return []
  return streamingContextUsesSelection.value ? getSelectedTracks() : [track]
})
const streamingContextActionCount = computed(() => streamingContextActionTracks.value.length)
const streamingContextActionLabel = computed(() =>
  streamingContextActionCount.value > 1 ? ` (${streamingContextActionCount.value})` : ''
)
const streamingContextAllFavorited = computed(() => {
  const tracks = streamingContextActionTracks.value
  return tracks.length > 0 && tracks.every(isStreamingTrackFavorited)
})

function closeStreamingContextMenu(): void {
  showStreamingContextMenu.value = false
  showStreamingPlaylistSubmenu.value = false
  showStreamingAggregateSubmenu.value = false
  streamingContextMenuTrack.value = null
}

// ─── 添加到聚合歌单 ────────────────────────────────────────────────────────
const showStreamingAggregateSubmenu = ref(false)
const showCreateAggregateDialog = ref(false)
const createAggregateTracks = ref<Track[]>([])

const aggregatePlaylistOptions = computed(() =>
  musicStore.aggregatePlaylists.value.map((playlist) => ({
    id: playlist.id,
    name: playlist.name
  }))
)

function handleContextAddToAggregatePlaylist(playlistId: string): void {
  const tracks = streamingContextActionTracks.value
  const playlistName =
    musicStore.aggregatePlaylists.value.find((playlist) => playlist.id === playlistId)?.name ?? ''
  closeStreamingContextMenu()
  if (tracks.length === 0) return
  const added = musicStore.addTracksToPlaylistById(playlistId, tracks)
  pushNotice({
    kind: added > 0 ? 'success' : 'info',
    message:
      added > 0 ? `已加入「${playlistName}」${added} 首` : `「${playlistName}」里已经有这些歌了`
  })
}

function handleContextCreateAggregatePlaylist(): void {
  createAggregateTracks.value = streamingContextActionTracks.value
  closeStreamingContextMenu()
  showCreateAggregateDialog.value = true
}

function onAggregatePlaylistCreated(_playlistId: string, addedCount: number): void {
  createAggregateTracks.value = []
  pushNotice({
    kind: 'success',
    message: addedCount > 0 ? `已创建聚合歌单并加入 ${addedCount} 首` : '已创建聚合歌单'
  })
}

useEscapeToClose(showStreamingContextMenu, closeStreamingContextMenu)

function onStreamingTrackContextMenu(track: Track, _index: number, event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  streamingContextMenuTrack.value = track
  streamingContextMenuX.value = event.clientX
  streamingContextMenuY.value = event.clientY
  showStreamingPlaylistSubmenu.value = false
  showStreamingAggregateSubmenu.value = false
  showStreamingContextMenu.value = true
  void nextTick(() => {
    const menu = document.querySelector('.streaming-context-menu') as HTMLElement | null
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      streamingContextMenuX.value = Math.max(8, event.clientX - rect.width)
    }
    if (rect.bottom > window.innerHeight) {
      streamingContextMenuY.value = Math.max(8, event.clientY - rect.height)
    }
  })
}

async function handleContextPlayTrack(): Promise<void> {
  const track = streamingContextMenuTrack.value
  if (!track) return
  const list = currentDetail.value ? await resolveDetailPlaybackQueue() : streamingListTracks.value
  playStreamingTrack(track, list)
  closeStreamingContextMenu()
}

async function handleContextFavorite(): Promise<void> {
  const tracks = streamingContextActionTracks.value
  closeStreamingContextMenu()
  await favoriteStreamingTracks(tracks)
}

function handleContextAddToPlaylist(): void {
  const tracks = streamingContextActionTracks.value
  closeStreamingContextMenu()
  openAddToNcmPlaylistDialog(tracks)
}

function handleContextCreatePlaylist(): void {
  const tracks = streamingContextActionTracks.value
  closeStreamingContextMenu()
  openCreateNcmPlaylistDialog(tracks)
}

async function handleContextAddToOwnedPlaylist(
  playlist: MediaProviderPlaylistSummary
): Promise<void> {
  const tracks = streamingContextActionTracks.value
  closeStreamingContextMenu()
  addToNcmPlaylistTracks.value = tracks.filter(
    (track) => track.ncmSongId != null && Number.isFinite(track.ncmSongId) && track.ncmSongId > 0
  )
  if (addToNcmPlaylistTracks.value.length === 0) {
    setStreamingBatchRemovalError('所选曲目没有可写入网易云歌单的歌曲 ID')
    return
  }
  await confirmAddTracksToNcmPlaylist(playlist)
}

async function handleContextRemoveFromPlaylist(): Promise<void> {
  const tracks = streamingContextActionTracks.value
  closeStreamingContextMenu()
  await removeStreamingTracks(tracks)
}

async function handleContextLikeTrack(): Promise<void> {
  const track = streamingContextMenuTrack.value
  if (!track?.ncmSongId) return
  closeStreamingContextMenu()
  if (likingTracks.value.has(track.ncmSongId)) return
  likingTracks.value = new Set([...likingTracks.value, track.ncmSongId])
  try {
    await likeTrack(track.ncmSongId, !isTrackLiked(track.ncmSongId))
  } finally {
    const next = new Set(likingTracks.value)
    next.delete(track.ncmSongId)
    likingTracks.value = next
  }
}

const contextMenuSingleLiked = computed(() => {
  const track = streamingContextMenuTrack.value
  if (!track?.ncmSongId) return false
  return isTrackLiked(track.ncmSongId)
})

const contextMenuCanLike = computed(
  () =>
    !isExternalActive.value &&
    streamingContextMenuTrack.value?.ncmSongId != null &&
    streamingContextActionCount.value === 1
)

// ─── Provider download ───────────────────────────────────────────────
const downloadTasks = ref<ProviderDownloadTaskSnapshot[]>([])
const showDownloadPanel = ref(false)
const downloadQualityMenuOpen = ref(false)
let stopDownloadListener: (() => void) | null = null
const contextMenuDownloadProviderId = computed<string | null>(() => {
  const tracks = streamingContextActionTracks.value
  if (tracks.length === 0) return null
  const providerId = getTrackSource(tracks[0])
  if (providerId === 'local') return null
  if (!providerStore.getProvider(providerId)?.capabilities.includes('download')) return null
  for (const track of tracks) {
    if (getTrackSource(track) !== providerId) return null
  }
  return providerId
})
const contextMenuCanDownload = computed(() => contextMenuDownloadProviderId.value !== null)

onMounted(() => {
  stopDownloadListener = window.api.providerDownloads.onChanged((tasks) => {
    downloadTasks.value = tasks
  })
  void window.api.providerDownloads.list().then((tasks) => {
    downloadTasks.value = tasks
  })
})

onUnmounted(() => {
  stopDownloadListener?.()
})

async function handleContextDownload(quality: ProviderDownloadQuality): Promise<void> {
  const tracks = streamingContextActionTracks.value
  const providerId = contextMenuDownloadProviderId.value
  closeStreamingContextMenu()
  downloadQualityMenuOpen.value = false
  if (!providerId) return
  for (const track of tracks) {
    try {
      await window.api.providerDownloads.create({
        providerId,
        track: {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          cover: track.cover ?? undefined,
          provider: track.source ?? providerId
        },
        quality
      })
    } catch (error) {
      pushNotice({
        kind: 'error',
        message: friendlyStreamingError(error, `下载「${track.title}」失败`)
      })
    }
  }
  showDownloadPanel.value = true
}

async function handleCancelDownload(taskId: string): Promise<void> {
  try {
    await window.api.providerDownloads.cancel(taskId)
  } catch (error) {
    pushNotice({ kind: 'error', message: friendlyStreamingError(error, '取消下载失败') })
  }
}

async function handleRetryDownload(taskId: string): Promise<void> {
  try {
    await window.api.providerDownloads.retry(taskId)
  } catch (error) {
    pushNotice({ kind: 'error', message: friendlyStreamingError(error, '重试下载失败') })
  }
}

onMounted(() => {
  window.addEventListener('click', closeStreamingContextMenu)
})

onUnmounted(() => {
  window.removeEventListener('click', closeStreamingContextMenu)
})

function getHeartModePlaylistId(): number | null {
  // 心动模式只允许在网易云“我喜欢的音乐”收藏歌单中启用：
  // 外部流媒体提供商没有独立的收藏歌单上下文，本地/其他歌单同样不可用。
  if (isExternalActive.value) return null
  if (currentDetail.value?.type !== 'liked') return null
  const id = likedPlaylist.value?.id
  return id != null && Number.isFinite(Number(id)) && Number(id) > 0 ? Number(id) : null
}

function playStreamingTrack(track: Track, tracks: Track[]): void {
  playTrack(track, tracks.length > 0 ? tracks : [track], {
    heartModePlaylistId: getHeartModePlaylistId()
  })
}

async function playTrackFromCurrentDetail(track: Track): Promise<void> {
  const tracks = await resolveDetailPlaybackQueue()
  const resolvedTrack = tracks.find((item) => item.id === track.id) ?? track
  playStreamingTrack(resolvedTrack, tracks)
}

function onTrackClick(track: Track, index: number, event?: MouseEvent): void {
  if (!event) return
  const result = multiSelect.onRowClick(track, index, event)
  if (result !== 'play') return
  if (settingsStore.settings.value.trackActivationMode === 'doubleClick') return
  void playTrackFromCurrentDetail(track)
}

function playDetailTrack(track: Track, _index: number, event?: MouseEvent): void {
  if (event && multiSelect.shouldSuppressRowDoubleClick(event)) return
  void playTrackFromCurrentDetail(track)
}

async function resolveDetailPlaybackQueue(): Promise<Track[]> {
  if (
    currentDetail.value?.type !== 'liked' ||
    isExternalActive.value ||
    !likedTracksHasMore.value
  ) {
    return detailTracks.value
  }

  try {
    const tracks = await fetchLikedTracks()
    if (tracks.length > 0) {
      detailTracks.value = tracks
      likedCount.value = tracks.length
      likedTracksTotal.value = tracks.length
      likedTracksNextOffset.value = tracks.length
      likedTracksHasMore.value = false
      likedTracksLoadMoreError.value = ''
      syncLikedIds(tracks)
      return tracks
    }
  } catch (error) {
    likedTracksLoadMoreError.value = friendlyStreamingError(error, '加载完整收藏列表失败')
  }

  return detailTracks.value
}

async function playAllDetailTracks(): Promise<void> {
  const tracks = await resolveDetailPlaybackQueue()
  if (tracks.length === 0) return
  playStreamingTrack(tracks[0], tracks)
}

async function shufflePlayDetailTracks(): Promise<void> {
  const tracks = await resolveDetailPlaybackQueue()
  if (tracks.length === 0) return
  const shuffled = shuffleArray(tracks)
  playStreamingTrack(shuffled[0], shuffled)
}

function isDetailTrackLiking(ncmSongId?: number | null): boolean {
  return ncmSongId != null && likingTracks.value.has(ncmSongId)
}

function isDetailTrackLiked(ncmSongId?: number | null): boolean {
  if (ncmSongId == null) return false
  return isTrackLiked(ncmSongId)
}

const detailLikedFooter = computed(() => {
  if (currentDetail.value?.type !== 'liked' || isExternalActive.value) return null
  return {
    loadingMore: likedTracksLoadingMore.value,
    hasMore: likedTracksHasMore.value,
    loadMoreError: likedTracksLoadMoreError.value,
    total: likedTracksTotal.value,
    loaded: detailTracks.value.length
  }
})

const socialPeople = computed(() =>
  detailUsers.value.map((user) => ({
    id: user.id,
    name: user.name,
    picUrl: user.picUrl ?? null,
    picUrlSource: user.picUrlSource ?? null
  }))
)

const socialCollections = computed(() => {
  const detail = currentDetail.value
  if (detail?.type === 'user_playlists') {
    return detail.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      cover: playlist.cover,
      coverSource: playlist.coverSource ?? null,
      coverSmall: playlist.coverSmall ?? null,
      coverSmallSource: playlist.coverSmallSource ?? null,
      trackCount: playlist.trackCount
    }))
  }
  if (detail?.type === 'artist') {
    if (activeArtistTab.value === 'albums') {
      return currentArtistAlbums.value.map((album) => ({
        id: album.id,
        name: album.name,
        cover: album.cover,
        coverSource: album.coverSource ?? null,
        coverSmall: album.coverSmall ?? null,
        coverSmallSource: album.coverSmallSource ?? null,
        trackCount: album.trackCount
      }))
    }
    if (activeArtistTab.value === 'playlists') {
      return currentArtistPlaylists.value.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        cover: playlist.cover,
        coverSource: playlist.coverSource ?? null,
        coverSmall: playlist.coverSmall ?? null,
        coverSmallSource: playlist.coverSmallSource ?? null,
        trackCount: playlist.trackCount
      }))
    }
  }
  return []
})

const socialCollectionEmptyHint = computed(() => {
  if (currentDetail.value?.type !== 'artist' || activeArtistTab.value !== 'playlists') return ''
  const name = currentDetail.value.user?.name ?? currentDetail.value.artist.name
  return `${name} 目前没有公开创建的歌单`
})

function onSocialPersonClick(person: {
  id: string | number
  name: string
  picUrl?: string | null
  picUrlSource?: string | null
}): void {
  const user = detailUsers.value.find((item) => String(item.id) === String(person.id))
  if (user) void onUserClick(user)
}

function onArtistTabChange(key: string): void {
  if (key === 'songs' || key === 'albums' || key === 'playlists') {
    activeArtistTab.value = key
  }
}

const socialStageKind = computed(() => currentDetail.value?.type ?? 'user_list')

const socialStageLoading = computed(() => {
  if (!detailLoading.value || !currentDetail.value) return false
  const detail = currentDetail.value
  if (detail.type === 'user_list') return detailUsers.value.length === 0
  if (detail.type === 'user_playlists') return detail.playlists.length === 0
  if (detail.type === 'artist') {
    return (
      detailTracks.value.length === 0 &&
      currentArtistAlbums.value.length === 0 &&
      currentArtistPlaylists.value.length === 0
    )
  }
  return false
})

function onSocialCollectionClick(item: {
  id: string | number
  name: string
  cover?: string | null
  coverSource?: string | null
  trackCount?: number
}): void {
  const detail = currentDetail.value
  if (detail?.type === 'user_playlists') {
    const playlist = detail.playlists.find((entry) => String(entry.id) === String(item.id))
    if (playlist) openPlaylist(playlist, false)
    return
  }
  if (detail?.type === 'artist') {
    if (activeArtistTab.value === 'albums') {
      const album = currentArtistAlbums.value.find((entry) => String(entry.id) === String(item.id))
      if (album) openAlbum(album)
      return
    }
    if (activeArtistTab.value === 'playlists') {
      const playlist = currentArtistPlaylists.value.find(
        (entry) => String(entry.id) === String(item.id)
      )
      if (playlist) openPlaylist(playlist, false)
    }
  }
}

function onSearchTrackClickWithSelect(track: Track, event: MouseEvent): void {
  if (event.type === 'click' && event.detail > 1) return
  const index = Math.max(
    0,
    searchResults.value.findIndex((item) => item.id === track.id)
  )
  const result = multiSelect.onRowClick(track, index, event)
  if (result !== 'play') return
  if (
    settingsStore.settings.value.trackActivationMode === 'doubleClick' &&
    event.type !== 'dblclick'
  ) {
    return
  }
  clearSelection()
  onSearchTrackClick(track)
}

async function favoriteStreamingTracks(tracks: Track[]): Promise<void> {
  if (tracks.length === 0) return
  const allLiked = tracks.every(isStreamingTrackFavorited)
  const actionLabel = allLiked ? '取消收藏' : '收藏'
  let succeeded = 0
  let failed = 0
  // The local favorites playlist can decline a write when an equivalent entry is
  // already there. Reporting that as success is how a silently dropped favorite
  // used to look like it worked.
  let unchanged = 0
  for (const track of tracks) {
    if (track.ncmSongId != null) {
      if (likingTracks.value.has(track.ncmSongId)) continue
      likingTracks.value = new Set([...likingTracks.value, track.ncmSongId])
      try {
        await likeTrack(track.ncmSongId, !allLiked)
        succeeded++
      } catch {
        failed++
      } finally {
        const next = new Set(likingTracks.value)
        next.delete(track.ncmSongId)
        likingTracks.value = next
      }
    } else if (allLiked) {
      if (musicStore.removeFavoriteTrack(track)) succeeded++
      else unchanged++
    } else {
      if (musicStore.addFavoriteTrack(track)) succeeded++
      else unchanged++
    }
  }
  if (failed > 0) {
    pushNotice({
      kind: 'error',
      message: `${actionLabel}完成 ${succeeded}/${succeeded + failed} 首，${failed} 首失败`
    })
  } else if (unchanged > 0 && succeeded === 0) {
    pushNotice({
      kind: 'info',
      message: allLiked ? '这些歌曲不在收藏中' : '这些歌曲已在收藏中'
    })
  } else if (tracks.length > 1) {
    pushNotice({
      kind: 'success',
      message: `已${actionLabel} ${succeeded} 首歌曲${unchanged > 0 ? `，${unchanged} 首无需改动` : ''}`
    })
  }
}

async function handleStreamingBatchFavorite(): Promise<void> {
  await favoriteStreamingTracks(getSelectedTracks())
}

const showCreateNcmPlaylistDialog = ref(false)
const newNcmPlaylistName = ref('')
const createNcmPlaylistBusy = ref(false)
const createNcmPlaylistError = ref('')
const createNcmPlaylistSeedTracks = ref<Track[]>([])
const showAddToNcmPlaylistDialog = ref(false)
const addToNcmPlaylistBusy = ref(false)
const addToNcmPlaylistError = ref('')
const addToNcmPlaylistTracks = ref<Track[]>([])
const deletingNcmPlaylistId = ref<string | number | null>(null)

const ownedUserPlaylists = computed(() =>
  userPlaylistEntries.value.filter((playlist) => playlist.owned === true)
)

const canMutateCurrentNcmPlaylist = computed(() => {
  if (isExternalActive.value) return false
  const detail = currentDetail.value
  if (detail?.type !== 'playlist') return false
  return detail.playlist.owned === true
})

const canManageNcmPlaylists = computed(() => !isExternalActive.value && isLoggedIn.value)

function openCreateNcmPlaylistDialog(seedTracks: Track[] = []): void {
  if (!canManageNcmPlaylists.value) return
  createNcmPlaylistSeedTracks.value = seedTracks
  newNcmPlaylistName.value = ''
  createNcmPlaylistError.value = ''
  showCreateNcmPlaylistDialog.value = true
}

function closeCreateNcmPlaylistDialog(): void {
  if (createNcmPlaylistBusy.value) return
  showCreateNcmPlaylistDialog.value = false
  createNcmPlaylistSeedTracks.value = []
  newNcmPlaylistName.value = ''
  createNcmPlaylistError.value = ''
}

async function confirmCreateNcmPlaylist(): Promise<void> {
  const name = newNcmPlaylistName.value.trim()
  if (!name || createNcmPlaylistBusy.value) return
  createNcmPlaylistBusy.value = true
  createNcmPlaylistError.value = ''
  try {
    const playlist = await createNcmPlaylist(name)
    const seedIds = createNcmPlaylistSeedTracks.value
      .map((track) => track.ncmSongId)
      .filter((id): id is number => id != null && Number.isFinite(id) && id > 0)
    if (seedIds.length > 0) {
      await addNcmTracksToPlaylist(playlist.id, seedIds)
    }
    showCreateNcmPlaylistDialog.value = false
    createNcmPlaylistSeedTracks.value = []
    newNcmPlaylistName.value = ''
    clearSelection()
  } catch (error) {
    createNcmPlaylistError.value = friendlyStreamingError(error, '创建歌单失败')
  } finally {
    createNcmPlaylistBusy.value = false
  }
}

async function handleDeleteNcmPlaylist(playlist: MediaProviderPlaylistSummary): Promise<void> {
  if (!canManageNcmPlaylists.value || deletingNcmPlaylistId.value != null) return
  const label = playlist.owned === false ? '取消收藏该歌单' : '删除该歌单'
  const confirmed = window.confirm(`${label}「${playlist.name}」？此操作不可撤销。`)
  if (!confirmed) return
  deletingNcmPlaylistId.value = playlist.id
  try {
    await deleteNcmPlaylist(playlist.id)
    removeDetailEntries(
      (view) => view.type === 'playlist' && String(view.playlist.id) === String(playlist.id)
    )
  } catch (error) {
    libraryError.value = friendlyStreamingError(error, '删除歌单失败')
  } finally {
    deletingNcmPlaylistId.value = null
  }
}

function openAddToNcmPlaylistDialog(tracks: Track[] = getSelectedTracks()): void {
  if (!canManageNcmPlaylists.value) return
  const ncmTracks = tracks.filter(
    (track) => track.ncmSongId != null && Number.isFinite(track.ncmSongId) && track.ncmSongId > 0
  )
  if (ncmTracks.length === 0) {
    setStreamingBatchRemovalError('所选曲目没有可写入网易云歌单的歌曲 ID')
    return
  }
  addToNcmPlaylistTracks.value = ncmTracks
  addToNcmPlaylistError.value = ''
  showAddToNcmPlaylistDialog.value = true
}

function closeAddToNcmPlaylistDialog(): void {
  if (addToNcmPlaylistBusy.value) return
  showAddToNcmPlaylistDialog.value = false
  addToNcmPlaylistTracks.value = []
  addToNcmPlaylistError.value = ''
}

function convertAddToCreatePlaylist(): void {
  if (addToNcmPlaylistBusy.value) return
  const tracks = [...addToNcmPlaylistTracks.value]
  showAddToNcmPlaylistDialog.value = false
  addToNcmPlaylistTracks.value = []
  addToNcmPlaylistError.value = ''
  openCreateNcmPlaylistDialog(tracks)
}

async function confirmAddTracksToNcmPlaylist(
  playlist: MediaProviderPlaylistSummary
): Promise<void> {
  if (addToNcmPlaylistBusy.value) return
  const trackIds = addToNcmPlaylistTracks.value
    .map((track) => track.ncmSongId)
    .filter((id): id is number => id != null && Number.isFinite(id) && id > 0)
  if (trackIds.length === 0) return
  addToNcmPlaylistBusy.value = true
  addToNcmPlaylistError.value = ''
  try {
    await addNcmTracksToPlaylist(playlist.id, trackIds)
    if (
      currentDetail.value?.type === 'playlist' &&
      String(currentDetail.value.playlist.id) === String(playlist.id)
    ) {
      const existing = new Set(detailTracks.value.map((track) => track.id))
      detailTracks.value = [
        ...detailTracks.value,
        ...addToNcmPlaylistTracks.value.filter((track) => !existing.has(track.id))
      ]
      replaceTopDetail({
        ...currentDetail.value,
        playlist: {
          ...currentDetail.value.playlist,
          trackCount: (currentDetail.value.playlist.trackCount ?? 0) + trackIds.length
        }
      })
    }
    showAddToNcmPlaylistDialog.value = false
    addToNcmPlaylistTracks.value = []
    clearSelection()
  } catch (error) {
    addToNcmPlaylistError.value = friendlyStreamingError(error, '添加到歌单失败')
  } finally {
    addToNcmPlaylistBusy.value = false
  }
}

async function removeStreamingTracks(selected: Track[]): Promise<void> {
  if (selected.length === 0) return

  if (canMutateCurrentNcmPlaylist.value && currentDetail.value?.type === 'playlist') {
    const playlistId = currentDetail.value.playlist.id
    const playlistName = currentDetail.value.playlist.name
    const trackIds = selected
      .map((track) => track.ncmSongId)
      .filter((id): id is number => id != null && Number.isFinite(id) && id > 0)
    if (trackIds.length === 0) {
      setStreamingBatchRemovalError('所选曲目没有可从网易云歌单移除的歌曲 ID')
      return
    }
    if (!window.confirm(`确定从歌单「${playlistName}」移除所选 ${trackIds.length} 首歌曲？`)) {
      return
    }
    try {
      await removeNcmTracksFromPlaylist(playlistId, trackIds)
      const removedSongIds = new Set(trackIds)
      detailTracks.value = detailTracks.value.filter(
        (track) => track.ncmSongId == null || !removedSongIds.has(track.ncmSongId)
      )
      replaceTopDetail({
        ...currentDetail.value,
        playlist: {
          ...currentDetail.value.playlist,
          trackCount: Math.max(0, (currentDetail.value.playlist.trackCount ?? 0) - trackIds.length)
        }
      })
      clearSelection()
      pushNotice({
        kind: 'success',
        message: `已从歌单「${playlistName}」移除 ${trackIds.length} 首歌曲`
      })
    } catch (error) {
      setStreamingBatchRemovalError(friendlyStreamingError(error, '从歌单移除失败'))
    }
    return
  }

  const localCount = selected.filter((track) => getTrackSource(track) === 'local').length
  const providerCount = selected.length - localCount
  const consequences = [
    localCount > 0 ? `${localCount} 首将从本地曲库移除` : '',
    providerCount > 0 ? `${providerCount} 首将取消收藏` : ''
  ]
    .filter(Boolean)
    .join('，')
  if (
    !window.confirm(`确定删除所选 ${selected.length} 首歌曲？${consequences}。此操作不可撤销。`)
  ) {
    return
  }

  try {
    const result = await executeStreamingBatchRemoval(selected, {
      removeLocalTracks: musicStore.removeLocalTracks,
      removeProviderTrack: (track) =>
        removeStreamingProviderFavorite(track, {
          providers: mediaProviders,
          removeNcmFavorite: (songId) => likeTrack(songId, false),
          removeSnapshotFavorite: musicStore.removeFavoriteTrack
        })
    })
    const removed = new Set(result.removedTrackIds)
    detailTracks.value = detailTracks.value.filter((track) => !removed.has(track.id))
    if (isSearching.value) {
      searchResults.value = searchResults.value.filter((track) => !removed.has(track.id))
    }
    if (result.failures.length > 0) {
      setStreamingBatchRemovalError(
        `已删除 ${removed.size}/${selected.length} 首；失败：${result.failures
          .map((failure) => failure.message)
          .join('；')}`
      )
    } else if (removed.size > 0) {
      pushNotice({ kind: 'success', message: `已删除 ${removed.size} 首歌曲` })
    }
    clearSelection()
  } catch (error) {
    setStreamingBatchRemovalError(friendlyStreamingError(error, '移除曲目失败'))
  }
}

async function handleStreamingBatchDelete(): Promise<void> {
  await removeStreamingTracks(getSelectedTracks())
}

function handleStreamingBatchAddToPlaylist(): void {
  openAddToNcmPlaylistDialog(getSelectedTracks())
}

// Batch-action failures go to the app notice channel — never into searchError/detailError,
// which would replace the whole results view with a "search failed" state.
function setStreamingBatchRemovalError(message: string): void {
  if (!message.trim()) return
  pushNotice({ kind: 'error', message })
}

function onStreamingContentScroll(event: Event): void {
  const element = event.currentTarget as HTMLElement | null
  if (!element) return
  const scrollable = element.scrollHeight - element.clientHeight
  if (scrollable <= 0) return
  const ratio = (element.scrollTop + element.clientHeight) / element.scrollHeight

  if (currentDetail.value?.type === 'liked') {
    if (!likedTracksHasMore.value || likedTracksLoadingMore.value) return
    if (ratio >= LIKED_TRACKS_LOAD_THRESHOLD) void loadMoreLikedTracks()
    return
  }

  if (currentDetail.value?.type !== 'rec' || ratio < PERSONALIZED_STREAM_LOAD_THRESHOLD) return
  const key = getPersonalizedStreamKey(currentDetail.value.section)
  if (key) void loadMorePersonalizedStream(key)
}

watch(
  [
    personalizedStreamRemaining,
    personalizedStreamSession,
    () => currentTrack.value?.queueEntryId,
    () => personalizedStreamLoading.fm,
    () => personalizedStreamLoading.radar
  ],
  ([remaining, session]) => {
    if (
      !session ||
      personalizedStreamLoading[session.key] ||
      remaining > PERSONALIZED_STREAM_QUEUE_THRESHOLD
    ) {
      return
    }
    void loadMorePersonalizedStream(session.key, session)
  },
  { flush: 'post' }
)

async function playLikedSongs(): Promise<void> {
  // For external providers the liked view is a playlist detail; detect it so we
  // don't re-open it on every play click.
  const likedId = activeExternalState.value?.likedPlaylist?.id
  const isViewingLiked =
    currentDetail.value?.type === 'liked' ||
    (isExternalActive.value &&
      currentDetail.value?.type === 'playlist' &&
      currentDetail.value.playlist.id === likedId)
  if (!isViewingLiked) {
    await openLikedTracks()
  }
  const tracks = await resolveDetailPlaybackQueue()
  if (tracks.length > 0) {
    playStreamingTrack(tracks[0], tracks)
  }
}

async function retryCurrentView(): Promise<void> {
  if (currentDetail.value?.type === 'liked') {
    await openLikedTracks(true)
    return
  }
  if (currentDetail.value?.type === 'playlist') {
    await openPlaylist(currentDetail.value.playlist, true)
    return
  }
  if (currentDetail.value?.type === 'album') {
    await openAlbum(currentDetail.value.album)
    return
  }
  if (currentDetail.value?.type === 'artist') {
    await openArtist(currentDetail.value.artist)
    return
  }
  if (currentDetail.value?.type === 'recent') {
    await openRecent()
    return
  }
  if (currentDetail.value?.type === 'ranking') {
    await openRanking()
    return
  }
  if (activeTab.value === 'cloud') {
    await refreshCloudSongs()
    return
  }
  await ensureLibraryLoaded(true)
}

watch(isSearching, (searching, wasSearching) => {
  if (
    searching &&
    !wasSearching &&
    activeTab.value === 'discover' &&
    availableSearchTypes.value.includes('playlists')
  ) {
    // Searching from the discover tab implies looking for playlists.
    searchType.value = 'playlists'
  }
  if (currentDetail.value) return
  if (searching && !wasSearching) {
    streamingTransitionName.value = 'stream-detail-forward'
    saveStreamingScrollPosition()
    const el = streamingContentRef.value
    if (el) el.scrollTop = 0
    return
  }
  if (!searching && wasSearching) {
    streamingTransitionName.value = 'stream-detail-back'
    const el = streamingContentRef.value
    if (el) el.scrollTop = 0
  }
})

// Keep preferredProvider in sync with persisted settings (initial load and
// any external change). This is how the app restores the user's last provider
// choice after restart.
watch(
  () => settingsStore.settings.value.streamingActiveProvider,
  (pref) => {
    if (typeof pref === 'string' && pref && pref !== preferredProvider.value) {
      preferredProvider.value = pref
    }
  }
)

watch(
  () => props.artistNavigationRequest?.key,
  () => {
    const request = props.artistNavigationRequest
    if (request) void openRequestedArtist(request)
  },
  { immediate: true }
)

watch(
  () => getSidebarItemsSignature(sidebarItems.value),
  () => {
    ensureVisibleSidebarSelection()
  },
  { flush: 'post' }
)

// Side effects of switching the resolved active provider (user toggle, plugin
// enable/disable, or restore after restart). activeProvider falls back to the
// first provider that can back the current streaming surface, so we only act
// on real changes.
watch(activeProvider, async (provider, oldProvider) => {
  if (provider === oldProvider) return
  resetDetail()
  clearSearch()
  if (provider === NCM_PROVIDER_ID) {
    if (!ncmNavigationAvailable.value) return
    if (activeTab.value === 'home' && isLoggedIn.value) {
      loadRecommendations()
    } else if (activeTab.value === 'discover') {
      void discovery.ensureLoaded()
    } else if (activeTab.value === 'library') {
      await ensureLibraryLoaded()
    } else if (activeTab.value === 'cloud' && isLoggedIn.value && cloudSongs.value.length === 0) {
      await refreshCloudSongs().catch(() => undefined)
    }
    return
  }
  // External provider: default to the library tab and load its state.
  const providerInfo = providerStore.getProvider(provider)
  if (providerInfo?.ui?.streamingLibraryTab !== false) {
    activeTab.value = 'library'
  }
  await refreshExternalProviderState(provider)
  await ensureExternalLibraryLoaded(provider)
})

watch(activeTab, async (tab) => {
  if (isExternalActive.value) {
    if (tab !== 'library') {
      activeTab.value = 'library'
      return
    }
    const state = ensureExternalState(activeProvider.value)
    if (state.loggedIn) await ensureExternalLibraryLoaded(activeProvider.value)
    return
  }
  if (!ncmNavigationAvailable.value) return
  if (tab === 'home' && isLoggedIn.value) {
    loadRecommendations()
  }
  if (tab === 'discover') {
    // Discovery browsing is anonymous-capable — no login gate here.
    void discovery.ensureLoaded()
  }
  if (tab === 'library' && isLoggedIn.value) {
    await ensureLibraryLoaded()
  }
  if (tab === 'cloud' && isLoggedIn.value && cloudSongs.value.length === 0) {
    await refreshCloudSongs().catch(() => undefined)
  }
})

watch(
  () => isLoggedIn.value,
  async (loggedIn) => {
    if (!loggedIn) {
      resetDetail()
      likedCount.value = null
      dailySongs.value = []
      personalFmSongs.value = []
      privateContentSongs.value = []
      return
    }
    if (isExternalActive.value) return
    if (!ncmNavigationAvailable.value) return
    if (activeTab.value === 'home') {
      loadRecommendations()
    }
    if (activeTab.value === 'library') {
      await ensureLibraryLoaded(true)
    }
    if (activeTab.value === 'cloud') {
      await refreshCloudSongs().catch(() => undefined)
    }
  }
)

async function refreshStreamingSurface(): Promise<void> {
  if (activeProvider.value === NCM_PROVIDER_ID) {
    if (!ncmNavigationAvailable.value) return
    await checkLogin()
    if (activeTab.value === 'home' && isLoggedIn.value) {
      loadRecommendations()
    } else if (activeTab.value === 'discover') {
      void discovery.ensureLoaded()
    } else if (activeTab.value === 'library') {
      await ensureLibraryLoaded()
    } else if (activeTab.value === 'cloud' && isLoggedIn.value && cloudSongs.value.length === 0) {
      await refreshCloudSongs().catch(() => undefined)
    }
    return
  }
  // External provider active (e.g. returning from a successful login on the
  // login page): re-check login state and load the library. The provider id
  // didn't change, so the activeProvider watcher won't fire — we must refresh
  // explicitly here, otherwise a just-completed login wouldn't be reflected.
  await refreshExternalProviderState(activeProvider.value)
  if (activeExternalState.value?.loggedIn) {
    await ensureExternalLibraryLoaded(activeProvider.value)
  }
}

// StreamingPage stays mounted for the app session (App.vue v-show) so leaving
// and re-entering restores the last tab/detail. When the surface becomes
// visible again after login/settings, refresh auth-bound data without resetting
// navigation state.
watch(
  () => props.active,
  (active, wasActive) => {
    if (!active || wasActive === true) return
    void refreshStreamingSurface()
  }
)

onMounted(async () => {
  await providerStore.syncProviders().catch(() => undefined)
  // syncProviders may have resolved the preferred external provider, in which
  // case the activeProvider watcher above already handles the initial load.
  await refreshStreamingSurface()
})
</script>

<template>
  <div class="streaming-page" :class="{ 'has-player': hasPlayer }">
    <ProviderSidebar
      :menu-open="menuOpen"
      :items="sidebarItems"
      :is-active="isSidebarItemActive"
      :aggregate-active="showAggregatePanel"
      @select="selectSidebarItem"
      @select-aggregate="selectAggregatePanel"
      @back-to-local="emit('backToLocal')"
    />

    <!-- 聚合歌单就地占据内容区。保留 streaming-content 类名，侧边栏那条相邻兄弟
         规则（.streaming-sidebar.open + .streaming-content）才能继续给出偏移。 -->
    <div v-if="showAggregatePanel" class="streaming-content">
      <AggregatePlaylistPage :has-player="hasPlayer" surface="streaming" :active="active" />
    </div>

    <div
      v-show="!showAggregatePanel"
      ref="streamingContentRef"
      class="streaming-content"
      @scroll="onStreamingContentScroll"
    >
      <StreamingContentHeader
        :is-detail="!!currentDetail"
        :is-searching="isSearching && !currentDetail"
        :show-subtitle="
          (activeTab === 'home' && !currentDetail && !isSearching) ||
          (isExternalActive && !currentDetail && !isSearching)
        "
        :title="headerTitle"
        :subtitle="headerSubtitle"
        :show-unified-search="showUnifiedSearch"
        :search-query="searchQuery"
        :search-loading="searchLoading"
        :logged-in="activeLoggedIn"
        :profile="activeProfile"
        @update:search-query="searchQuery = $event"
        @clear-search="clearSearch"
        @login="emit('login', activeProvider)"
      />

      <!-- Search Type Tabs + Source Selector -->
      <StreamingSearchControls
        v-if="showUnifiedSearch && isSearching && !currentDetail"
        :search-type="searchType"
        :available-search-types="availableSearchTypes"
        :search-sources="searchSources"
        :search-source="searchSource"
        @update:search-type="searchType = $event"
        @select-source="searchSource = $event"
      />

      <Transition
        :name="streamingTransitionName"
        mode="out-in"
        @after-enter="restoreStreamingScrollPosition"
      >
        <div
          v-if="showUnifiedSearch && isSearching && !currentDetail"
          key="search-results"
          class="streaming-content-body stream-view-panel"
          :class="{ 'has-search-tabs': isSearching }"
        >
          <StreamingSearch
            :search-type="searchType"
            :search-results="searchResults"
            :search-playlists-results="searchPlaylistsResults"
            :search-artists-results="searchArtistsResults"
            :search-total="searchTotal"
            :search-offset="searchOffset"
            :search-loading="searchLoading"
            :search-error="searchError"
            :current-track="currentTrack"
            :track-activation-mode="settingsStore.settings.value.trackActivationMode"
            :liking-tracks="likingTracks"
            :is-track-liked="isTrackLiked"
            :format-time="formatTime"
            :selected-ids="selectedIds"
            :has-selection="hasSelection"
            :selected-count="selectedCount"
            :selection-all-favorited="selectionAllFavorited"
            :can-add-to-playlist="canManageNcmPlaylists"
            @search-track-click="onSearchTrackClickWithSelect"
            @like-track="onLikeTrack"
            @open-playlist="openPlaylist"
            @open-artist="openArtist"
            @page-change="onPageChange"
            @retry="performSearch(searchQuery)"
            @batch-favorite="handleStreamingBatchFavorite"
            @batch-add-to-playlist="handleStreamingBatchAddToPlaylist"
            @batch-delete="handleStreamingBatchDelete"
            @clear-selection="clearSelection"
            @track-context-menu="onStreamingTrackContextMenu"
          />
        </div>
        <div v-else :key="streamingViewKey" class="streaming-content-body stream-view-panel">
          <StreamingPlaceholder
            v-if="!hasOnlineNavigationEntries && !currentDetail"
            title="未启用可用的在线音源"
            hint="请在设置的插件页启用网易云音乐或其它音源插件。"
            icon="pi pi-plug"
          />

          <StreamingHome
            v-else-if="activeTab === 'home' && !currentDetail && activeProviderAvailable"
            :is-logged-in="isLoggedIn"
            :recs-loading="recsLoading"
            :recs-error="recsError"
            :rec-sections="recSections"
            :recommend-playlists="recommendPlaylists"
            :current-track-id="currentTrack?.id ?? null"
            @load-recommendations="loadRecommendations"
            @open-rec-section="openRecSection"
            @open-playlist="openPlaylist"
            @play-track="playHomeTrack"
            @request-login="emit('login', activeProvider)"
          />

          <StreamingDiscovery
            v-else-if="
              activeTab === 'discover' &&
              !currentDetail &&
              activeProviderAvailable &&
              !isExternalActive
            "
            :catalogue="discovery.catalogue.value"
            :catalogue-loading="discovery.catalogueLoading.value"
            :catalogue-error="discovery.catalogueError.value"
            :selected-tag="discovery.selectedTag.value"
            :order="discovery.order.value"
            :high-quality="discovery.highQuality.value"
            :panel-expanded="discovery.panelExpanded.value"
            :playlists="discovery.playlists.value"
            :total="discovery.total.value"
            :offset="discovery.offset.value"
            :has-more="discovery.hasMore.value"
            :list-loading="discovery.listLoading.value"
            :list-error="discovery.listError.value"
            :loading-more="discovery.loadingMore.value"
            @select-tag="discovery.selectTag"
            @set-order="discovery.setOrder"
            @toggle-high-quality="discovery.toggleHighQuality"
            @toggle-panel="discovery.togglePanel"
            @page-change="discovery.onPageChange"
            @load-more="discovery.loadMore"
            @open-playlist="openPlaylist"
            @retry="discovery.retry"
          />

          <StreamingPlaceholder
            v-else-if="(!activeProviderAvailable || activeProviderUnavailable) && !currentDetail"
            :title="isExternalActive ? `${activeProviderLabel} 插件已停用` : '网易云音乐插件已停用'"
            :hint="
              activeProviderError ||
              (isExternalActive
                ? `请在设置的插件页重新启用 ${activeProviderLabel}。`
                : '请在设置的插件页重新启用 NetEase Cloud Music。')
            "
            icon="pi pi-ban"
          />

          <StreamingPlaceholder
            v-else-if="!activeLoggedIn && !currentDetail"
            :title="isExternalActive ? `请先登录 ${activeProviderLabel}` : '请先登录网易云音乐'"
            :hint="
              isExternalActive
                ? '登录后即可加载全部音乐库'
                : activeTab === 'cloud'
                  ? '登录后即可管理音乐云盘中的歌曲和传输任务'
                  : '登录后即可加载我收藏的歌曲和在线歌单'
            "
            icon="pi pi-user"
            action-label="账号登录"
            action-icon="pi pi-user"
            @action="emit('login', activeProvider)"
          />

          <StreamingLoadingStage
            v-else-if="rootLoading && !currentDetail"
            :provider-label="activeProviderLabel"
          />

          <StreamingPlaceholder
            v-else-if="activeTab === 'library' && !currentDetail && activeLibraryError"
            title="加载失败"
            :hint="activeLibraryError"
            icon="pi pi-exclamation-triangle"
            danger
            action-label="重试"
            @action="retryCurrentView"
          />

          <div v-else-if="currentDetail" class="detail-view">
            <div v-if="showDetailOverlayLoading" class="detail-loading-overlay" aria-live="polite">
              <i class="pi pi-spin pi-spinner"></i>
              <span>正在加载</span>
            </div>

            <!-- Track playlist / rec / liked / album / recent / ranking: editorial stage -->
            <template v-if="showTrackDetailStage">
              <StreamingPlaceholder
                v-if="detailError"
                title="加载失败"
                :hint="detailError"
                icon="pi pi-exclamation-triangle"
                danger
                detail
                action-label="重试"
                @action="retryCurrentView"
              />

              <StreamingDetailStage
                v-else-if="detailHeaderInfo"
                :kind="currentDetail.type"
                :title="detailHeaderInfo.title"
                :cover="detailHeaderInfo.cover"
                :cover-source="detailHeaderInfo.coverSource"
                :description="detailHeaderInfo.desc"
                :intro="detailHeaderInfo.intro"
                :icon="detailHeaderInfo.icon"
                :track-count-label="detailTrackCountLabel"
                :tracks="detailTracks"
                :current-track-id="currentTrack?.id ?? null"
                :track-activation-mode="settingsStore.settings.value.trackActivationMode"
                :is-external="isExternalActive"
                :loading="detailLoading && detailTracks.length === 0"
                :has-selection="hasSelection"
                :selected-count="selectedCount"
                :selection-all-favorited="selectionAllFavorited"
                :can-add-to-playlist="canManageNcmPlaylists"
                :can-remove-from-playlist="canMutateCurrentNcmPlaylist"
                :is-selected="isSelected"
                :is-track-liked="isDetailTrackLiked"
                :is-liking="isDetailTrackLiking"
                :format-time="formatTime"
                :liked-footer="detailLikedFooter"
                @play-all="playAllDetailTracks"
                @shuffle-play="shufflePlayDetailTracks"
                @play-track="playDetailTrack"
                @track-click="onTrackClick"
                @like-track="onLikeTrack"
                @batch-favorite="handleStreamingBatchFavorite"
                @batch-add-to-playlist="handleStreamingBatchAddToPlaylist"
                @batch-delete="handleStreamingBatchDelete"
                @clear-selection="clearSelection"
                @load-more-liked="loadMoreLikedTracks"
                @track-context-menu="onStreamingTrackContextMenu"
              />
            </template>

            <!-- Artist / social / user playlists: editorial social stage -->
            <StreamingSocialStage
              v-else-if="detailHeaderInfo"
              :kind="socialStageKind"
              :title="detailHeaderInfo.title"
              :cover="detailHeaderInfo.cover"
              :cover-source="detailHeaderInfo.coverSource"
              :description="detailHeaderInfo.desc"
              :intro="detailHeaderInfo.intro"
              :icon="detailHeaderInfo.icon"
              :loading="socialStageLoading"
              :error="detailError"
              :show-follow="showDetailFollowButton"
              :follow-label="detailFollowButtonLabel"
              :follow-icon="detailFollowButtonIcon"
              :follow-active="detailFollowState"
              :follow-loading="followActionLoading"
              :follow-error="followActionError"
              :people="socialPeople"
              :collections="socialCollections"
              :collection-empty-hint="socialCollectionEmptyHint"
              :tabs="socialStageKind === 'artist' ? artistDetailTabs : []"
              :active-tab="socialStageKind === 'artist' ? activeArtistTab : ''"
              :tracks="detailTracks"
              :current-track-id="currentTrack?.id ?? null"
              :track-activation-mode="settingsStore.settings.value.trackActivationMode"
              :is-external="isExternalActive"
              :has-selection="hasSelection"
              :selected-count="selectedCount"
              :selection-all-favorited="selectionAllFavorited"
              :can-add-to-playlist="canManageNcmPlaylists"
              :is-selected="isSelected"
              :is-track-liked="isDetailTrackLiked"
              :is-liking="isDetailTrackLiking"
              :format-time="formatTime"
              :track-count-label="detailTrackCountLabel"
              @follow="toggleCurrentDetailFollow"
              @retry="retryCurrentView"
              @person-click="onSocialPersonClick"
              @collection-click="onSocialCollectionClick"
              @tab-change="onArtistTabChange"
              @play-all="playAllDetailTracks"
              @shuffle-play="shufflePlayDetailTracks"
              @play-track="playDetailTrack"
              @track-click="onTrackClick"
              @like-track="onLikeTrack"
              @batch-favorite="handleStreamingBatchFavorite"
              @batch-add-to-playlist="handleStreamingBatchAddToPlaylist"
              @batch-delete="handleStreamingBatchDelete"
              @clear-selection="clearSelection"
              @track-context-menu="onStreamingTrackContextMenu"
            />
          </div>

          <NcmCloudPanel
            v-else-if="activeTab === 'cloud' && !currentDetail && !isExternalActive"
            :songs="cloudSongs"
            :total="cloudTotal"
            :loading="cloudLoading"
            :loading-more="cloudLoadingMore"
            :has-more="cloudHasMore"
            :error="cloudError"
            :selected-files="cloudSelectedFiles"
            :transfer-tasks="cloudTransferTasks"
            :current-track-id="currentTrack?.id ?? null"
            @refresh="refreshCloudSongs"
            @load-more="loadMoreCloudSongs"
            @choose-files="chooseCloudFiles"
            @upload="startCloudUpload"
            @remove-selected="removeCloudSelectedFile"
            @play="playCloudSong"
            @play-all="playAllCloudSongs"
            @download="startCloudDownload"
            @cancel="cancelCloudTask"
          />

          <StreamingLibrary
            v-else-if="activeTab === 'library' && !currentDetail"
            :is-logged-in="activeLoggedIn"
            :provider-label="activeProviderLabel"
            :profile="activeProfile"
            :profile-signature="profileSignature"
            :liked-summary="likedSummary"
            :library-loaded="activeLibraryLoaded"
            :user-playlist-entries="userPlaylistEntries"
            :show-liked-panel="showActiveLikedPanel"
            :show-social-stats="!isExternalActive"
            :show-feature-cards="!isExternalActive"
            :allow-pin-playlists="false"
            :allow-playlist-mutations="canManageNcmPlaylists"
            :deleting-playlist-id="deletingNcmPlaylistId"
            :pinned-playlist-ids="activeExternalState?.pinnedPlaylistIds ?? []"
            :pinning-playlist-id="activeExternalState?.pinningPlaylistId ?? null"
            :available-providers="libraryProviderOptions"
            :active-provider="activeProvider"
            @switch-provider="selectProvider"
            @open-user-list="openUserList"
            @open-liked-tracks="openLikedTracks"
            @play-liked-songs="playLikedSongs"
            @open-playlist="openPlaylist"
            @create-playlist="openCreateNcmPlaylistDialog()"
            @delete-playlist="handleDeleteNcmPlaylist"
            @open-recent="openRecent"
            @open-ranking="openRanking"
          />
        </div>
      </Transition>
    </div>

    <StreamingContextMenu
      :show="showStreamingContextMenu"
      :x="streamingContextMenuX"
      :y="streamingContextMenuY"
      :all-favorited="streamingContextAllFavorited"
      :action-label="streamingContextActionLabel"
      :can-like="contextMenuCanLike"
      :single-liked="contextMenuSingleLiked"
      :can-manage-playlists="canManageNcmPlaylists"
      :owned-user-playlists="ownedUserPlaylists"
      :show-playlist-submenu="showStreamingPlaylistSubmenu"
      :can-remove-from-playlist="canMutateCurrentNcmPlaylist"
      :can-download="contextMenuCanDownload"
      :show-download-quality-menu="downloadQualityMenuOpen"
      :aggregate-playlists="aggregatePlaylistOptions"
      :show-aggregate-submenu="showStreamingAggregateSubmenu"
      @play="handleContextPlayTrack"
      @favorite="handleContextFavorite"
      @like="handleContextLikeTrack"
      @create-playlist="handleContextCreatePlaylist"
      @add-to-owned-playlist="handleContextAddToOwnedPlaylist"
      @add-to-playlist="handleContextAddToPlaylist"
      @remove-from-playlist="handleContextRemoveFromPlaylist"
      @download="handleContextDownload"
      @close="closeStreamingContextMenu"
      @toggle-playlist-submenu="showStreamingPlaylistSubmenu = $event"
      @toggle-download-quality-menu="downloadQualityMenuOpen = $event"
      @add-to-aggregate-playlist="handleContextAddToAggregatePlaylist"
      @create-aggregate-playlist="handleContextCreateAggregatePlaylist"
      @toggle-aggregate-submenu="showStreamingAggregateSubmenu = $event"
    />

    <CreateAggregatePlaylistDialog
      :show="showCreateAggregateDialog"
      :tracks="createAggregateTracks"
      @close="showCreateAggregateDialog = false"
      @created="onAggregatePlaylistCreated"
    />

    <NcmPlaylistDialogs
      :show-create="showCreateNcmPlaylistDialog"
      :show-add="showAddToNcmPlaylistDialog"
      v-model:new-name="newNcmPlaylistName"
      :create-busy="createNcmPlaylistBusy"
      :create-error="createNcmPlaylistError"
      :add-busy="addToNcmPlaylistBusy"
      :add-error="addToNcmPlaylistError"
      :add-tracks="addToNcmPlaylistTracks"
      :owned-user-playlists="ownedUserPlaylists"
      @close-create="closeCreateNcmPlaylistDialog"
      @confirm-create="confirmCreateNcmPlaylist"
      @close-add="closeAddToNcmPlaylistDialog"
      @convert-add-to-create="convertAddToCreatePlaylist"
      @confirm-add="confirmAddTracksToNcmPlaylist"
    />

    <ProviderDownloadsPanel
      :show="showDownloadPanel"
      :tasks="downloadTasks"
      @close="showDownloadPanel = false"
      @open="showDownloadPanel = true"
      @retry="handleRetryDownload"
      @cancel="handleCancelDownload"
    />
  </div>
</template>

<style scoped src="./streaming-page/StreamingPage.css"></style>

<style scoped>
.provider-download-panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.provider-download-panel {
  width: min(560px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--te-panel-bg, #1e1e2e);
  border-radius: 16px;
  overflow: hidden;
}

.provider-download-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--te-border, rgba(255, 255, 255, 0.08));
}

.provider-download-panel-header h3 {
  margin: 0;
  font-size: 16px;
}

.provider-download-empty {
  padding: 32px 20px;
  text-align: center;
  color: var(--te-muted, rgba(255, 255, 255, 0.5));
  font-size: 13px;
}

.provider-download-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.provider-download-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--te-border, rgba(255, 255, 255, 0.04));
}

.provider-download-item-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.provider-download-item-info strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-download-item-info span {
  font-size: 12px;
  color: var(--te-muted, rgba(255, 255, 255, 0.5));
}

.provider-download-item-info small {
  font-size: 11px;
  color: var(--te-muted, rgba(255, 255, 255, 0.4));
}

.provider-download-item-info small.error {
  color: var(--te-danger, #ef4444);
}

.provider-download-item-info small.path {
  word-break: break-all;
  font-family: monospace;
}

.provider-download-item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.provider-download-fab {
  position: fixed;
  bottom: 80px;
  right: 24px;
  z-index: 900;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: var(--te-accent, #7c3aed);
  color: #fff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s;
}

.provider-download-fab:hover {
  transform: scale(1.05);
}

.fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--te-danger, #ef4444);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
</style>
