import { ref, type Ref } from 'vue'
import type { NcmCloudSelectedFile, NcmCloudTransferProgress } from '../../../shared/ncmCloud.ts'
import type { Track } from '../types/music'
import { useMediaProviders } from '../providers'

export interface NcmProfile {
  userId: number
  nickname: string
  avatarUrl: string
  avatarUrlSource?: string | null
  signature: string
  follows: number
  followeds: number
}

export interface NcmPlaylistSummary {
  id: number
  name: string
  cover: string | null
  /** Durable remote origin when `cover` is a session-scoped twilight-media grant. */
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount: number
  creatorName?: string
  /** True when the signed-in user owns (created) the playlist. */
  owned?: boolean
  /** Play count surfaced by discovery endpoints (top/highquality playlists). */
  playCount?: number
}

export interface NcmPlaylistCategoryTag {
  name: string
  hot: boolean
}

export interface NcmPlaylistCategoryGroup {
  id: number
  name: string
  tags: NcmPlaylistCategoryTag[]
}

export interface NcmPlaylistCatalogue {
  hotTags: string[]
  groups: NcmPlaylistCategoryGroup[]
}

export interface NcmDiscoveryPlaylistPage {
  items: NcmPlaylistSummary[]
  total: number
  hasMore: boolean
  offset: number
  limit: number
}

export interface NcmHighQualityPlaylistPage {
  items: NcmPlaylistSummary[]
  total: number
  hasMore: boolean
  lasttime: number
}

export interface NcmAlbumSummary {
  id: number
  name: string
  cover: string | null
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount: number
  publishTime?: number
}

export interface NcmArtistSummary {
  id: number
  name: string
  picUrl: string | null
  picUrlSource?: string | null
  picUrlSmall?: string | null
  picUrlSmallSource?: string | null
  albumSize: number
  musicSize: number
}

export interface NcmUserSummary {
  id: number
  name: string
  picUrl: string | null
  picUrlSource?: string | null
  picUrlSmall?: string | null
  picUrlSmallSource?: string | null
  musicSize: number
  userType: number
  artistId?: number
  followed?: boolean
}

export interface NcmLoginState {
  loggedIn: boolean
  profile: NcmProfile | null
}

export interface NcmLikedTracksPage {
  tracks: Track[]
  total: number
  offset: number
  limit: number
  nextOffset: number
  hasMore: boolean
}

export interface NcmCloudSong {
  cloudSongId: string | number
  songId: string | number
  fileName: string
  addTime?: number
  track: Track
}

export interface NcmCloudSongsPage {
  items: NcmCloudSong[]
  total: number
  offset: number
  limit: number
  nextOffset: number
  hasMore: boolean
}

export interface NcmCloudTransferTask extends NcmCloudTransferProgress {}

export interface NcmStore {
  providerAvailable: Ref<boolean>
  providerError: Ref<string>
  isLoggedIn: Ref<boolean>
  profile: Ref<NcmProfile | null>
  libraryLoading: Ref<boolean>
  libraryLoaded: Ref<boolean>
  libraryError: Ref<string>
  likedPlaylist: Ref<NcmPlaylistSummary | null>
  userPlaylists: Ref<NcmPlaylistSummary[]>
  likedSongIds: Ref<Set<number>>
  cloudSongs: Ref<NcmCloudSong[]>
  cloudTotal: Ref<number>
  cloudHasMore: Ref<boolean>
  cloudLoading: Ref<boolean>
  cloudLoadingMore: Ref<boolean>
  cloudError: Ref<string>
  cloudSelectedFiles: Ref<NcmCloudSelectedFile[]>
  cloudTransferTasks: Ref<Record<string, NcmCloudTransferTask>>
  buildProfile: (prof: {
    userId: number
    nickname: string
    avatarUrl: string
    avatarUrlSource?: string | null
    signature?: string
    follows?: number
    followeds?: number
  }) => Promise<NcmProfile>
  checkLogin: () => Promise<boolean>
  setLogin: (prof: NcmProfile) => void
  logout: () => Promise<void>
  openOfficialLogin: () => Promise<boolean>
  getQrKey: () => Promise<string | null>
  getQrImage: (key: string) => Promise<string | null>
  checkQrLogin: (key: string) => Promise<{ code: number }>
  fetchUserLibrary: (force?: boolean) => Promise<{
    likedPlaylist: NcmPlaylistSummary | null
    playlists: NcmPlaylistSummary[]
  }>
  fetchPlaylistTracks: (playlistId: number | string, force?: boolean) => Promise<Track[]>
  fetchLikedTracks: (force?: boolean) => Promise<Track[]>
  fetchLikedTracksPage: (
    offset?: number,
    limit?: number,
    force?: boolean
  ) => Promise<NcmLikedTracksPage>
  fetchCloudSongsPage: (
    offset?: number,
    limit?: number,
    append?: boolean
  ) => Promise<NcmCloudSongsPage>
  refreshCloudSongs: () => Promise<NcmCloudSongsPage>
  loadMoreCloudSongs: () => Promise<NcmCloudSongsPage | null>
  chooseCloudUploadFiles: () => Promise<NcmCloudSelectedFile[]>
  uploadCloudFile: (handle: string) => Promise<string>
  downloadCloudSong: (song: NcmCloudSong) => Promise<string | null>
  cancelCloudTransfer: (transferId: string) => Promise<boolean>
  removeCloudSelectedFile: (handle: string) => void
  getSongStreamUrl: (songId: number, force?: boolean) => Promise<string | null>
  fetchRecommendSongs: () => Promise<Track[]>
  fetchRecommendPlaylists: () => Promise<NcmPlaylistSummary[]>
  fetchPlaylistCategories: () => Promise<NcmPlaylistCatalogue>
  fetchDiscoveryPlaylists: (
    cat?: string,
    order?: 'hot' | 'new',
    limit?: number,
    offset?: number
  ) => Promise<NcmDiscoveryPlaylistPage>
  fetchHighQualityPlaylists: (
    cat?: string,
    limit?: number,
    before?: number
  ) => Promise<NcmHighQualityPlaylistPage>
  fetchPersonalFm: () => Promise<Track[]>
  fetchPrivateContent: () => Promise<Track[]>
  fetchLyric: (songId: number) => Promise<{
    lyrics: string | null
    translatedLyrics: string | null
  }>
  searchSongs: (
    keywords: string,
    limit?: number,
    offset?: number
  ) => Promise<{ tracks: Track[]; total: number }>
  searchPlaylists: (
    keywords: string,
    limit?: number,
    offset?: number
  ) => Promise<{ playlists: NcmPlaylistSummary[]; total: number }>
  searchArtists: (
    keywords: string,
    limit?: number,
    offset?: number
  ) => Promise<{ artists: NcmArtistSummary[]; total: number }>
  fetchArtistTopSongs: (artistId: number) => Promise<Track[]>
  fetchArtistAlbums: (artistId: number) => Promise<NcmAlbumSummary[]>
  fetchArtistIntro: (artistId: number) => Promise<string>
  fetchArtistFollowState: (artistId: number) => Promise<boolean | null>
  fetchAlbumTracks: (albumId: number) => Promise<Track[]>
  fetchArtistPlaylists: (artistId: number) => Promise<NcmPlaylistSummary[]>
  fetchUserPlaylistsByUid: (uid: number, createdOnly?: boolean) => Promise<NcmPlaylistSummary[]>
  fetchUserFollows: (uid: number, limit?: number, offset?: number) => Promise<NcmUserSummary[]>
  fetchUserFolloweds: (uid: number, limit?: number, offset?: number) => Promise<NcmUserSummary[]>
  fetchPlayRecords: (type?: number) => Promise<Track[]>
  fetchRecentSongs: (limit?: number) => Promise<Track[]>
  fetchIntelligenceList: (options: {
    songId: number
    playlistId: number
    startSongId?: number
    count?: number
  }) => Promise<Track[]>
  followArtist: (artistId: number, follow: boolean) => Promise<void>
  followUser: (userId: number, follow: boolean) => Promise<void>
  likeTrack: (songId: number, like: boolean) => Promise<void>
  isTrackLiked: (ncmSongId: number | undefined) => boolean
  syncLikedIds: (tracks: Track[]) => void
  createPlaylist: (name: string, options?: { privacy?: 0 | 10 }) => Promise<NcmPlaylistSummary>
  deletePlaylist: (playlistId: number | string) => Promise<void>
  addTracksToPlaylist: (
    playlistId: number | string,
    trackIds: Array<number | string>
  ) => Promise<void>
  removeTracksFromPlaylist: (
    playlistId: number | string,
    trackIds: Array<number | string>
  ) => Promise<void>
}

const NCM_PROVIDER_ID = 'ncm'

const providerAvailable = ref(true)
const providerError = ref('')
const isLoggedIn = ref(false)
const profile = ref<NcmProfile | null>(null)
const libraryLoading = ref(false)
const libraryLoaded = ref(false)
const libraryError = ref('')
const likedPlaylist = ref<NcmPlaylistSummary | null>(null)
const userPlaylists = ref<NcmPlaylistSummary[]>([])
const likedSongIds = ref<Set<number>>(new Set())
const cloudSongs = ref<NcmCloudSong[]>([])
const cloudTotal = ref(0)
const cloudNextOffset = ref(0)
const cloudHasMore = ref(false)
const cloudLoading = ref(false)
const cloudLoadingMore = ref(false)
const cloudError = ref('')
const cloudSelectedFiles = ref<NcmCloudSelectedFile[]>([])
const cloudTransferTasks = ref<Record<string, NcmCloudTransferTask>>({})
let cloudProgressUnsubscribe: (() => void) | null = null
let cloudStateRevision = 0
let cloudRefreshTimer: ReturnType<typeof setTimeout> | null = null
const retiredCloudTransferIds = new Set<string>()

function scheduleCloudRefresh(): void {
  if (cloudRefreshTimer || !isLoggedIn.value) return
  const revision = cloudStateRevision
  const userId = profile.value?.userId
  cloudRefreshTimer = setTimeout(() => {
    cloudRefreshTimer = null
    if (!isLoggedIn.value || cloudStateRevision !== revision || profile.value?.userId !== userId)
      return
    void callNcmProvider<NcmCloudSongsPage>('fetchCloudSongsPage', [0, 50])
      .then((page) => {
        if (
          !isLoggedIn.value ||
          cloudStateRevision !== revision ||
          profile.value?.userId !== userId
        )
          return
        cloudSongs.value = page.items
        cloudTotal.value = page.total
        cloudNextOffset.value = page.nextOffset
        cloudHasMore.value = page.hasMore
      })
      .catch(() => undefined)
  }, 150)
}

function ensureCloudProgressListener(): void {
  if (cloudProgressUnsubscribe) return
  cloudProgressUnsubscribe = window.api.ncmCloud.onProgress((progress) => {
    if (retiredCloudTransferIds.has(progress.transferId)) {
      if (['completed', 'failed', 'cancelled'].includes(progress.stage)) {
        retiredCloudTransferIds.delete(progress.transferId)
      }
      return
    }
    cloudTransferTasks.value = {
      ...cloudTransferTasks.value,
      [progress.transferId]: progress
    }
    if (progress.kind === 'upload' && progress.stage === 'completed') {
      cloudSelectedFiles.value = cloudSelectedFiles.value.filter(
        (file) => file.handle !== progress.handle
      )
      scheduleCloudRefresh()
    }
  })
}

function resetCloudState(): void {
  cloudStateRevision += 1
  for (const task of Object.values(cloudTransferTasks.value)) {
    if (['completed', 'failed', 'cancelled'].includes(task.stage)) continue
    retiredCloudTransferIds.add(task.transferId)
    void window.api.ncmCloud
      .cancel(task.transferId)
      .then((cancelled) => {
        if (!cancelled) retiredCloudTransferIds.delete(task.transferId)
      })
      .catch(() => retiredCloudTransferIds.delete(task.transferId))
  }
  if (cloudRefreshTimer) {
    clearTimeout(cloudRefreshTimer)
    cloudRefreshTimer = null
  }
  cloudSongs.value = []
  cloudTotal.value = 0
  cloudNextOffset.value = 0
  cloudHasMore.value = false
  cloudLoading.value = false
  cloudLoadingMore.value = false
  cloudError.value = ''
  cloudSelectedFiles.value = []
  cloudTransferTasks.value = {}
}

function resetLibraryState(): void {
  libraryLoading.value = false
  libraryLoaded.value = false
  libraryError.value = ''
  likedPlaylist.value = null
  userPlaylists.value = []
  likedSongIds.value = new Set()
  resetCloudState()
}

function markProviderAvailable(): void {
  providerAvailable.value = true
  providerError.value = ''
}

function markProviderUnavailable(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  providerAvailable.value = false
  providerError.value = message || '网易云音乐插件未启用'
  isLoggedIn.value = false
  profile.value = null
  resetLibraryState()
}

async function callNcmProvider<T>(
  method: string,
  args: unknown[] = [],
  options?: { signal?: AbortSignal }
): Promise<T> {
  try {
    const value = await useMediaProviders().call<T>(NCM_PROVIDER_ID, method, args, options)
    markProviderAvailable()
    return value
  } catch (error) {
    if (
      error instanceof Error &&
      /Provider 未启用|provider is disabled|does not implement/i.test(error.message)
    ) {
      markProviderUnavailable(error)
    }
    throw error
  }
}

function syncLikedIds(tracks: Track[]): void {
  const ids = new Set<number>()
  for (const track of tracks) {
    if (track.ncmSongId != null) ids.add(track.ncmSongId)
  }
  likedSongIds.value = ids
}

function applyLoginState(state: NcmLoginState): boolean {
  isLoggedIn.value = state.loggedIn
  profile.value = state.profile
  if (!state.loggedIn) resetLibraryState()
  return state.loggedIn
}

export function useNcmStore(): NcmStore {
  ensureCloudProgressListener()

  async function buildProfile(prof: {
    userId: number
    nickname: string
    avatarUrl: string
    avatarUrlSource?: string | null
    signature?: string
    follows?: number
    followeds?: number
  }): Promise<NcmProfile> {
    return {
      userId: prof.userId,
      nickname: prof.nickname,
      avatarUrl: prof.avatarUrl,
      avatarUrlSource: prof.avatarUrlSource ?? null,
      signature: prof.signature ?? '',
      follows: prof.follows ?? 0,
      followeds: prof.followeds ?? 0
    }
  }

  async function checkLogin(): Promise<boolean> {
    try {
      const state = await callNcmProvider<NcmLoginState>('checkLogin')
      return applyLoginState(state)
    } catch {
      isLoggedIn.value = false
      profile.value = null
      resetLibraryState()
      return false
    }
  }

  function setLogin(prof: NcmProfile): void {
    if (profile.value?.userId !== prof.userId) resetLibraryState()
    isLoggedIn.value = true
    profile.value = prof
    markProviderAvailable()
  }

  async function logout(): Promise<void> {
    await callNcmProvider<void>('logout')
    isLoggedIn.value = false
    profile.value = null
    resetLibraryState()
  }

  async function openOfficialLogin(): Promise<boolean> {
    const state = await callNcmProvider<NcmLoginState>('openOfficialLogin')
    return applyLoginState(state)
  }

  async function getQrKey(): Promise<string | null> {
    return callNcmProvider<string | null>('getQrKey')
  }

  async function getQrImage(key: string): Promise<string | null> {
    return callNcmProvider<string | null>('getQrImage', [key])
  }

  async function checkQrLogin(key: string): Promise<{ code: number }> {
    return callNcmProvider<{ code: number }>('checkQrLogin', [key])
  }

  async function fetchUserLibrary(force = false): Promise<{
    likedPlaylist: NcmPlaylistSummary | null
    playlists: NcmPlaylistSummary[]
  }> {
    libraryLoading.value = true
    libraryError.value = ''
    try {
      const library = await callNcmProvider<{
        likedPlaylist: NcmPlaylistSummary | null
        playlists: NcmPlaylistSummary[]
      }>('fetchUserLibrary', [force])
      likedPlaylist.value = library.likedPlaylist
      userPlaylists.value = library.playlists
      libraryLoaded.value = true
      return library
    } catch (error) {
      libraryError.value = error instanceof Error ? error.message : '加载网易云音乐库失败'
      throw error
    } finally {
      libraryLoading.value = false
    }
  }

  async function fetchPlaylistTracks(playlistId: number | string, force = false): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchPlaylistTracks', [playlistId, force])
  }

  async function fetchLikedTracks(force = false): Promise<Track[]> {
    const tracks = await callNcmProvider<Track[]>('fetchLikedTracks', [force])
    syncLikedIds(tracks)
    return tracks
  }

  async function fetchLikedTracksPage(
    offset = 0,
    limit = 100,
    force = false
  ): Promise<NcmLikedTracksPage> {
    const page = await callNcmProvider<NcmLikedTracksPage>('fetchLikedTracksPage', [
      offset,
      limit,
      force
    ])
    syncLikedIds(page.tracks)
    return page
  }

  async function fetchCloudSongsPage(
    offset = 0,
    limit = 50,
    append = false
  ): Promise<NcmCloudSongsPage> {
    if (!isLoggedIn.value) throw new Error('请先登录网易云音乐')
    const revision = cloudStateRevision
    const userId = profile.value?.userId
    const isCurrentCloudSession = (): boolean =>
      isLoggedIn.value && cloudStateRevision === revision && profile.value?.userId === userId
    if (append) cloudLoadingMore.value = true
    else cloudLoading.value = true
    cloudError.value = ''
    try {
      const page = await callNcmProvider<NcmCloudSongsPage>('fetchCloudSongsPage', [offset, limit])
      if (!isCurrentCloudSession()) return page
      cloudSongs.value = append ? [...cloudSongs.value, ...page.items] : page.items
      cloudTotal.value = page.total
      cloudNextOffset.value = page.nextOffset
      cloudHasMore.value = page.hasMore
      return page
    } catch (error) {
      if (!isCurrentCloudSession()) throw error
      cloudError.value = error instanceof Error ? error.message : '加载网易云云盘失败'
      if (/请先登录|未登录|登录.*失效/i.test(cloudError.value)) {
        isLoggedIn.value = false
        profile.value = null
        resetLibraryState()
        cloudError.value = '登录状态已失效，请重新登录网易云音乐'
      }
      throw error
    } finally {
      if (isCurrentCloudSession()) {
        cloudLoading.value = false
        cloudLoadingMore.value = false
      }
    }
  }

  async function refreshCloudSongs(): Promise<NcmCloudSongsPage> {
    return fetchCloudSongsPage(0, 50, false)
  }

  async function loadMoreCloudSongs(): Promise<NcmCloudSongsPage | null> {
    if (!cloudHasMore.value || cloudLoading.value || cloudLoadingMore.value) return null
    return fetchCloudSongsPage(cloudNextOffset.value, 50, true)
  }

  async function chooseCloudUploadFiles(): Promise<NcmCloudSelectedFile[]> {
    if (!isLoggedIn.value) throw new Error('请先登录网易云音乐')
    const files = await window.api.ncmCloud.chooseUploadFiles()
    const existing = new Set(cloudSelectedFiles.value.map((file) => file.handle))
    cloudSelectedFiles.value = [
      ...cloudSelectedFiles.value,
      ...files.filter((file) => !existing.has(file.handle))
    ]
    return files
  }

  async function uploadCloudFile(handle: string): Promise<string> {
    if (!isLoggedIn.value) throw new Error('请先登录网易云音乐')
    ensureCloudProgressListener()
    const result = await window.api.ncmCloud.upload(handle)
    return result.transferId
  }

  async function downloadCloudSong(song: NcmCloudSong): Promise<string | null> {
    if (!isLoggedIn.value) throw new Error('请先登录网易云音乐')
    ensureCloudProgressListener()
    const result = await window.api.ncmCloud.download({
      cloudSongId: song.cloudSongId,
      fileName:
        song.fileName || song.track.fileName || `${song.track.title}.${song.track.format || 'mp3'}`
    })
    return result.accepted ? result.transferId : null
  }

  async function cancelCloudTransfer(transferId: string): Promise<boolean> {
    return window.api.ncmCloud.cancel(transferId)
  }

  function removeCloudSelectedFile(handle: string): void {
    const active = Object.values(cloudTransferTasks.value).some(
      (task) => task.handle === handle && !['completed', 'failed', 'cancelled'].includes(task.stage)
    )
    if (!active) {
      cloudSelectedFiles.value = cloudSelectedFiles.value.filter((file) => file.handle !== handle)
    }
  }

  async function getSongStreamUrl(songId: number, force = false): Promise<string | null> {
    return callNcmProvider<string | null>('getPlaybackUrl', [
      { id: `ncm:${songId}`, filePath: `ncm:${songId}`, source: 'ncm', ncmSongId: songId },
      { force }
    ])
  }

  async function fetchRecommendSongs(): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchRecommendSongs')
  }

  async function fetchRecommendPlaylists(): Promise<NcmPlaylistSummary[]> {
    return callNcmProvider<NcmPlaylistSummary[]>('fetchRecommendPlaylists')
  }

  async function fetchPlaylistCategories(): Promise<NcmPlaylistCatalogue> {
    return callNcmProvider<NcmPlaylistCatalogue>('fetchPlaylistCategories')
  }

  async function fetchDiscoveryPlaylists(
    cat = '全部',
    order: 'hot' | 'new' = 'hot',
    limit = 30,
    offset = 0
  ): Promise<NcmDiscoveryPlaylistPage> {
    return callNcmProvider<NcmDiscoveryPlaylistPage>('fetchDiscoveryPlaylists', [
      cat,
      order,
      limit,
      offset
    ])
  }

  async function fetchHighQualityPlaylists(
    cat = '全部',
    limit = 30,
    before = 0
  ): Promise<NcmHighQualityPlaylistPage> {
    return callNcmProvider<NcmHighQualityPlaylistPage>('fetchHighQualityPlaylists', [
      cat,
      limit,
      before
    ])
  }

  async function fetchPersonalFm(): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchPersonalFm')
  }

  async function fetchPrivateContent(): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchPrivateContent')
  }

  async function fetchLyric(songId: number): Promise<{
    lyrics: string | null
    translatedLyrics: string | null
  }> {
    return callNcmProvider<{ lyrics: string | null; translatedLyrics: string | null }>(
      'getLyrics',
      [{ id: `ncm:${songId}`, filePath: `ncm:${songId}`, source: 'ncm', ncmSongId: songId }]
    )
  }

  async function searchSongs(
    keywords: string,
    limit = 30,
    offset = 0,
    options?: { signal?: AbortSignal }
  ): Promise<{ tracks: Track[]; total: number }> {
    const result = await callNcmProvider<{ items: Track[]; total: number }>(
      'searchSongs',
      [keywords, limit, offset],
      options
    )
    return { tracks: result.items, total: result.total }
  }

  async function searchPlaylists(
    keywords: string,
    limit = 30,
    offset = 0,
    options?: { signal?: AbortSignal }
  ): Promise<{ playlists: NcmPlaylistSummary[]; total: number }> {
    const result = await callNcmProvider<{ items: NcmPlaylistSummary[]; total: number }>(
      'searchPlaylists',
      [keywords, limit, offset],
      options
    )
    return { playlists: result.items, total: result.total }
  }

  async function searchArtists(
    keywords: string,
    limit = 30,
    offset = 0,
    options?: { signal?: AbortSignal }
  ): Promise<{ artists: NcmArtistSummary[]; total: number }> {
    const result = await callNcmProvider<{ items: NcmArtistSummary[]; total: number }>(
      'searchArtists',
      [keywords, limit, offset],
      options
    )
    return { artists: result.items, total: result.total }
  }

  async function fetchArtistTopSongs(artistId: number): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchArtistTopSongs', [artistId])
  }

  async function fetchArtistAlbums(artistId: number): Promise<NcmAlbumSummary[]> {
    return callNcmProvider<NcmAlbumSummary[]>('fetchArtistAlbums', [artistId])
  }

  async function fetchArtistIntro(artistId: number): Promise<string> {
    return callNcmProvider<string>('fetchArtistIntro', [artistId])
  }

  async function fetchArtistFollowState(artistId: number): Promise<boolean | null> {
    return callNcmProvider<boolean | null>('fetchArtistFollowState', [artistId])
  }

  async function fetchAlbumTracks(albumId: number): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchAlbumTracks', [albumId])
  }

  async function fetchArtistPlaylists(artistId: number): Promise<NcmPlaylistSummary[]> {
    return callNcmProvider<NcmPlaylistSummary[]>('fetchArtistPlaylists', [artistId])
  }

  async function fetchUserPlaylistsByUid(
    uid: number,
    createdOnly = false
  ): Promise<NcmPlaylistSummary[]> {
    return callNcmProvider<NcmPlaylistSummary[]>('fetchUserPlaylistsByUid', [uid, createdOnly])
  }

  async function fetchUserFollows(uid: number, limit = 30, offset = 0): Promise<NcmUserSummary[]> {
    return callNcmProvider<NcmUserSummary[]>('fetchUserFollows', [uid, limit, offset])
  }

  async function fetchUserFolloweds(
    uid: number,
    limit = 30,
    offset = 0
  ): Promise<NcmUserSummary[]> {
    return callNcmProvider<NcmUserSummary[]>('fetchUserFolloweds', [uid, limit, offset])
  }

  async function likeTrack(songId: number, like: boolean): Promise<void> {
    await callNcmProvider<void>('likeTrack', [songId, like])
    if (like) {
      likedSongIds.value = new Set([...likedSongIds.value, songId])
    } else {
      const next = new Set(likedSongIds.value)
      next.delete(songId)
      likedSongIds.value = next
    }
  }

  function isTrackLiked(ncmSongId: number | undefined): boolean {
    return ncmSongId != null && likedSongIds.value.has(ncmSongId)
  }

  async function fetchPlayRecords(type = 0): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchPlayRecords', [type])
  }

  async function fetchRecentSongs(limit = 100): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchRecentSongs', [limit])
  }

  async function fetchIntelligenceList(options: {
    songId: number
    playlistId: number
    startSongId?: number
    count?: number
  }): Promise<Track[]> {
    return callNcmProvider<Track[]>('fetchIntelligenceList', [options])
  }

  async function followArtist(artistId: number, follow: boolean): Promise<void> {
    await callNcmProvider<void>('followArtist', [artistId, follow])
  }

  async function followUser(userId: number, follow: boolean): Promise<void> {
    await callNcmProvider<void>('followUser', [userId, follow])
  }

  async function createPlaylist(
    name: string,
    options?: { privacy?: 0 | 10 }
  ): Promise<NcmPlaylistSummary> {
    const playlist = await callNcmProvider<NcmPlaylistSummary>('createPlaylist', [name, options])
    const summary: NcmPlaylistSummary = {
      id: Number(playlist.id),
      name: playlist.name || name,
      cover: playlist.cover ?? null,
      coverSource: playlist.coverSource ?? null,
      coverSmall: playlist.coverSmall ?? null,
      coverSmallSource: playlist.coverSmallSource ?? null,
      trackCount: typeof playlist.trackCount === 'number' ? playlist.trackCount : 0,
      creatorName: playlist.creatorName,
      owned: playlist.owned !== false
    }
    userPlaylists.value = [summary, ...userPlaylists.value.filter((item) => item.id !== summary.id)]
    libraryLoaded.value = true
    return summary
  }

  async function deletePlaylist(playlistId: number | string): Promise<void> {
    await callNcmProvider<void>('deletePlaylist', [playlistId])
    const id = String(playlistId)
    userPlaylists.value = userPlaylists.value.filter((item) => String(item.id) !== id)
  }

  async function addTracksToPlaylist(
    playlistId: number | string,
    trackIds: Array<number | string>
  ): Promise<void> {
    await callNcmProvider<void>('addTracksToPlaylist', [playlistId, trackIds])
    const id = String(playlistId)
    userPlaylists.value = userPlaylists.value.map((item) =>
      String(item.id) === id
        ? { ...item, trackCount: (item.trackCount ?? 0) + trackIds.length }
        : item
    )
  }

  async function removeTracksFromPlaylist(
    playlistId: number | string,
    trackIds: Array<number | string>
  ): Promise<void> {
    await callNcmProvider<void>('removeTracksFromPlaylist', [playlistId, trackIds])
    const id = String(playlistId)
    const removed = trackIds.length
    userPlaylists.value = userPlaylists.value.map((item) =>
      String(item.id) === id
        ? { ...item, trackCount: Math.max(0, (item.trackCount ?? 0) - removed) }
        : item
    )
  }

  return {
    providerAvailable,
    providerError,
    isLoggedIn,
    profile,
    libraryLoading,
    libraryLoaded,
    libraryError,
    likedPlaylist,
    userPlaylists,
    likedSongIds,
    cloudSongs,
    cloudTotal,
    cloudHasMore,
    cloudLoading,
    cloudLoadingMore,
    cloudError,
    cloudSelectedFiles,
    cloudTransferTasks,
    buildProfile,
    checkLogin,
    setLogin,
    logout,
    openOfficialLogin,
    getQrKey,
    getQrImage,
    checkQrLogin,
    fetchUserLibrary,
    fetchPlaylistTracks,
    fetchLikedTracks,
    fetchLikedTracksPage,
    fetchCloudSongsPage,
    refreshCloudSongs,
    loadMoreCloudSongs,
    chooseCloudUploadFiles,
    uploadCloudFile,
    downloadCloudSong,
    cancelCloudTransfer,
    removeCloudSelectedFile,
    getSongStreamUrl,
    fetchRecommendSongs,
    fetchRecommendPlaylists,
    fetchPlaylistCategories,
    fetchDiscoveryPlaylists,
    fetchHighQualityPlaylists,
    fetchPersonalFm,
    fetchPrivateContent,
    fetchLyric,
    searchSongs,
    searchPlaylists,
    searchArtists,
    fetchArtistTopSongs,
    fetchArtistAlbums,
    fetchArtistIntro,
    fetchArtistFollowState,
    fetchAlbumTracks,
    fetchArtistPlaylists,
    fetchUserPlaylistsByUid,
    fetchUserFollows,
    fetchUserFolloweds,
    fetchPlayRecords,
    fetchRecentSongs,
    fetchIntelligenceList,
    followArtist,
    followUser,
    likeTrack,
    isTrackLiked,
    syncLikedIds,
    createPlaylist,
    deletePlaylist,
    addTracksToPlaylist,
    removeTracksFromPlaylist
  }
}
