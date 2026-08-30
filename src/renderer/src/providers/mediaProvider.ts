import { toRaw } from 'vue'
import type { Track } from '../types/music'
import { getNcmSongId } from './ncmTrack.ts'
import { unifiedSearchSongs, type UnifiedSearchResult } from '../utils/unifiedMusicSearch.ts'
import type { NetworkEntry } from '../../../shared/networkSources.ts'

export type MediaProviderCapability =
  | 'search'
  | 'playbackUrl'
  | 'lyrics'
  | 'cover'
  | 'playlist'
  | 'library'
  | 'login'
  | 'download'

export interface MediaProviderLyrics {
  lyrics: string | null
  translatedLyrics: string | null
  /** Optional word-level payload (e.g. NetEase YRC). Prefer for timed display when present. */
  wordLyrics?: string | null
}

export interface MediaProviderCallOptions {
  signal?: AbortSignal
}

interface ProviderLyricsSearchResult {
  lyrics: MediaProviderLyrics | null
  failure: unknown | null
}

export interface PlaybackUrlOptions {
  force?: boolean
  quality?: string
}

export interface MediaProviderSearchResult<T> {
  items: T[]
  total: number
}

export interface MediaProviderPlaylistSummary {
  id: number | string
  name: string
  cover: string | null
  /** Durable remote origin when `cover` is a session-scoped twilight-media grant. */
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount: number
  playCount?: number
  creatorName?: string
  /** True when the signed-in user owns (created) the playlist. */
  owned?: boolean
}

export interface MediaProviderPlaylistCatalogue {
  hotTags: string[]
  groups: Array<{
    id: number
    name: string
    tags: Array<{ name: string; hot: boolean }>
  }>
}

export interface MediaProviderDiscoveryPlaylistPage {
  items: MediaProviderPlaylistSummary[]
  total: number
  hasMore: boolean
  offset: number
  limit: number
}

export interface MediaProviderHighQualityPlaylistPage {
  items: MediaProviderPlaylistSummary[]
  total: number
  hasMore: boolean
  lasttime: number
}

export interface MediaProviderAlbumSummary {
  id: number | string
  name: string
  cover: string | null
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  trackCount: number
  publishTime?: number
}

export interface MediaProviderArtistSummary {
  id: number | string
  name: string
  picUrl: string | null
  /** Durable origin paired with a session-scoped image grant. */
  picUrlSource?: string | null
  picUrlSmall?: string | null
  picUrlSmallSource?: string | null
  albumSize?: number
  musicSize?: number
}

export interface MediaProviderProfile {
  userId: number | string
  nickname: string
  avatarUrl: string
  avatarUrlSource?: string | null
  signature?: string
  follows?: number
  followeds?: number
}

export interface MediaProviderQrLogin {
  key: string
  qrContent?: string
  imageDataUrl?: string
  expiresInSeconds?: number
}

export interface MediaProviderHealth {
  providerId: string
  pluginId: string
  pluginStatus: string
  available: boolean
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  methodStats?: Record<string, MediaProviderMethodHealth | undefined>
  lastError: string | null
  lastCheckedAt: string | null
}

export interface MediaProviderMethodHealth {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  lastError: string | null
  lastCheckedAt: string | null
}

export interface MediaProviderUserSummary {
  id: number | string
  name: string
  picUrl: string | null
  picUrlSource?: string | null
  picUrlSmall?: string | null
  picUrlSmallSource?: string | null
  musicSize?: number
  userType?: number
  artistId?: number | string
  followed?: boolean
}

export interface MediaProvider {
  id: string
  name: string
  source: 'internal' | 'plugin'
  capabilities: MediaProviderCapability[]
  health?: MediaProviderHealth
  isEnabled?: () => boolean | Promise<boolean>
  getPlaybackUrl?: (track: Track, options?: PlaybackUrlOptions) => Promise<string | null>
  getLyrics?: (track: Track, options?: MediaProviderCallOptions) => Promise<MediaProviderLyrics>
  searchSongs?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<Track>>
  searchPlaylists?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<MediaProviderPlaylistSummary>>
  searchArtists?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<MediaProviderArtistSummary>>
  fetchPlaylistTracks?: (playlistId: number | string, force?: boolean) => Promise<Track[]>
  checkLogin?: () => Promise<{ loggedIn: boolean; profile: MediaProviderProfile | null }>
  getProfile?: () => Promise<MediaProviderProfile | null>
  logout?: () => Promise<void>
  getQrLogin?: () => Promise<MediaProviderQrLogin | null>
  getQrKey?: () => Promise<string | null>
  getQrImage?: (key: string) => Promise<string | null>
  checkQrLogin?: (key: string) => Promise<{ code: number }>
  fetchUserLibrary?: (force?: boolean) => Promise<{
    likedPlaylist: MediaProviderPlaylistSummary | null
    playlists: MediaProviderPlaylistSummary[]
  }>
  fetchLikedTracks?: (force?: boolean) => Promise<Track[]>
  fetchRecommendSongs?: () => Promise<Track[]>
  fetchRecommendPlaylists?: () => Promise<MediaProviderPlaylistSummary[]>
  fetchPlaylistCategories?: () => Promise<MediaProviderPlaylistCatalogue>
  fetchDiscoveryPlaylists?: (
    cat?: string,
    order?: 'hot' | 'new',
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderDiscoveryPlaylistPage>
  fetchHighQualityPlaylists?: (
    cat?: string,
    limit?: number,
    before?: number
  ) => Promise<MediaProviderHighQualityPlaylistPage>
  fetchPersonalFm?: () => Promise<Track[]>
  fetchPrivateContent?: () => Promise<Track[]>
  fetchArtistTopSongs?: (artistId: number | string) => Promise<Track[]>
  fetchArtistAlbums?: (artistId: number | string) => Promise<MediaProviderAlbumSummary[]>
  fetchArtistIntro?: (artistId: number | string) => Promise<string>
  fetchArtistFollowState?: (artistId: number | string) => Promise<boolean | null>
  fetchAlbumTracks?: (albumId: number | string) => Promise<Track[]>
  fetchArtistPlaylists?: (artistId: number | string) => Promise<MediaProviderPlaylistSummary[]>
  fetchUserPlaylistsByUid?: (
    uid: number | string,
    createdOnly?: boolean
  ) => Promise<MediaProviderPlaylistSummary[]>
  fetchUserFollows?: (
    uid: number | string,
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderUserSummary[]>
  fetchUserFolloweds?: (
    uid: number | string,
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderUserSummary[]>
  fetchPlayRecords?: (type?: number) => Promise<Track[]>
  fetchRecentSongs?: (limit?: number) => Promise<Track[]>
  followArtist?: (artistId: number | string, follow: boolean) => Promise<void>
  followUser?: (userId: number | string, follow: boolean) => Promise<void>
  likeTrack?: (trackId: number | string, like: boolean) => Promise<void>
  isTrackLiked?: (trackId: number | string | undefined) => boolean | Promise<boolean>
  createPlaylist?: (
    name: string,
    options?: { privacy?: 0 | 10 }
  ) => Promise<MediaProviderPlaylistSummary>
  deletePlaylist?: (playlistId: number | string) => Promise<void>
  addTracksToPlaylist?: (
    playlistId: number | string,
    trackIds: Array<number | string>
  ) => Promise<void>
  removeTracksFromPlaylist?: (
    playlistId: number | string,
    trackIds: Array<number | string>
  ) => Promise<void>
}

export class MediaProviderRegistry {
  private providers = new Map<string, MediaProvider>()

  register(provider: MediaProvider): void {
    const id = normalizeProviderId(provider.id)
    if (!id) throw new Error('MediaProvider id is required')
    if (this.providers.has(id)) throw new Error(`MediaProvider already registered: ${id}`)
    this.providers.set(id, { ...provider, id })
  }

  update(id: string, patch: Partial<MediaProvider>): boolean {
    const normalizedId = normalizeProviderId(id)
    const current = this.providers.get(normalizedId)
    if (!current) return false
    this.providers.set(normalizedId, {
      ...current,
      ...patch,
      id: normalizedId
    })
    return true
  }

  unregister(id: string): void {
    this.providers.delete(normalizeProviderId(id))
  }

  unregisterWhere(predicate: (provider: MediaProvider) => boolean): void {
    for (const provider of this.providers.values()) {
      if (predicate(provider)) {
        this.providers.delete(provider.id)
      }
    }
  }

  list(): MediaProvider[] {
    return [...this.providers.values()]
  }

  get(id: string): MediaProvider | null {
    return this.providers.get(normalizeProviderId(id)) ?? null
  }

  getForTrack(track: Track): MediaProvider | null {
    const providerId = getTrackProviderId(track)
    return providerId ? this.get(providerId) : null
  }

  async resolvePlaybackUrl(track: Track, options?: PlaybackUrlOptions): Promise<string | null> {
    const provider = this.getForTrack(track)
    if (!provider?.getPlaybackUrl) return null
    await assertProviderEnabled(provider)
    return provider.getPlaybackUrl(track, options)
  }

  async searchSongs(
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ): Promise<MediaProviderSearchResult<Track>> {
    const provider = this.get(providerId)
    if (!provider?.searchSongs) return { items: [], total: 0 }
    await assertProviderEnabled(provider)
    return provider.searchSongs(keywords, limit, offset, options)
  }

  async searchPlaylists(
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ): Promise<MediaProviderSearchResult<MediaProviderPlaylistSummary>> {
    const provider = this.get(providerId)
    if (!provider?.searchPlaylists) return { items: [], total: 0 }
    await assertProviderEnabled(provider)
    return provider.searchPlaylists(keywords, limit, offset, options)
  }

  async searchArtists(
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ): Promise<MediaProviderSearchResult<MediaProviderArtistSummary>> {
    const provider = this.get(providerId)
    if (!provider?.searchArtists) return { items: [], total: 0 }
    await assertProviderEnabled(provider)
    return provider.searchArtists(keywords, limit, offset, options)
  }

  async resolveLyrics(
    track: Track,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<MediaProviderLyrics> {
    return this.resolveLyricsAcrossProviders(track, options)
  }

  /**
   * Prefer the track's own provider, then search every enabled lyric provider
   * by title and artist. Fallback searches run concurrently against one shared
   * deadline, so an unavailable provider cannot serially block later sources.
   * Never throws: individual provider failures are ignored so online fallback
   * can still run.
   */
  async resolveLyricsAcrossProviders(
    track: Track,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<MediaProviderLyrics> {
    const timeoutMs = options?.timeoutMs ?? 8_000
    const empty: MediaProviderLyrics = { lyrics: null, translatedLyrics: null, wordLyrics: null }
    const deadline = Date.now() + timeoutMs
    const remainingTimeout = (): number => Math.max(0, deadline - Date.now())

    const direct = this.getForTrack(track)
    let directFailure: unknown = null
    if (direct?.getLyrics) {
      try {
        await assertProviderEnabled(direct)
        const directTimeoutMs = Math.min(5_000, remainingTimeout())
        if (directTimeoutMs <= 0) return empty
        const lyrics = await withTimeout(
          direct.getLyrics(track, { signal: options?.signal }),
          directTimeoutMs,
          options?.signal
        )
        if (hasAnyLyrics(lyrics)) return lyrics
      } catch (error) {
        directFailure = error
        // continue fan-out
      }
    }

    // Local / unmatched tracks: try lyric-capable providers by title search.
    const query = [track.title, track.artist]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join(' ')
    if (!query) return empty

    const candidates = this.list()
      .filter((provider) => provider.getLyrics && provider.searchSongs)
      .filter((provider) => provider.id !== direct?.id)
      .sort((a, b) => providerLyricPriority(a.id) - providerLyricPriority(b.id))

    const fallbackTimeoutMs = remainingTimeout()
    if (fallbackTimeoutMs <= 0 || options?.signal?.aborted) {
      if (directFailure) throw directFailure
      return empty
    }

    const fallback = await resolveFirstProviderLyrics(
      candidates.map((provider) =>
        resolveLyricsFromProviderSearch(provider, query, track, remainingTimeout, options?.signal)
      ),
      fallbackTimeoutMs,
      options?.signal
    )
    if (fallback.lyrics) return fallback.lyrics
    if (fallback.failure) throw fallback.failure
    if (directFailure) throw directFailure
    return empty
  }

  async searchAllSongs(options: {
    query: string
    localTracks: Track[]
    networkEntries?: Array<{ profileName: string; entry: NetworkEntry }>
    limit?: number
    offset?: number
    signal?: AbortSignal
  }): Promise<UnifiedSearchResult> {
    const providers = this.list()
    return unifiedSearchSongs({
      ...options,
      providers: await Promise.all(
        providers.map(async (provider) => ({
          id: provider.id,
          name: provider.name,
          capabilities: provider.capabilities,
          available: await isProviderAvailable(provider),
          health: provider.health
        }))
      ),
      searchProviderSongs: (providerId, keywords, limit, offset) =>
        this.searchSongs(providerId, keywords, limit, offset, { signal: options.signal })
    })
  }

  async call<T>(
    providerId: string,
    method: string,
    args: unknown[] = [],
    options?: MediaProviderCallOptions & { requestId?: string }
  ): Promise<T> {
    const provider = this.get(providerId)
    if (!provider) throw new Error('Provider 未启用')
    await assertProviderEnabled(provider)
    const api = window.api?.providers
    if (!api) throw new Error('Provider bridge is unavailable')
    if (options?.signal?.aborted) throw new Error('Provider call was cancelled')
    let requestId = options?.requestId
    let onAbort: (() => void) | undefined
    if (options?.signal && !requestId) {
      requestId = `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
      onAbort = (): void => {
        if (requestId) void api.cancel(requestId)
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      return (await api.call(
        providerId,
        method as never,
        toProviderIpcArgs(args),
        requestId ? { requestId } : undefined
      )) as T
    } finally {
      if (options?.signal && onAbort) {
        options.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

export function getTrackProviderId(track: Pick<Track, 'id' | 'source'>): string | null {
  if (track.source) return normalizeProviderId(track.source)
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return null
  const separatorIndex = track.id.indexOf(':')
  if (separatorIndex <= 0) return null
  return normalizeProviderId(track.id.slice(0, separatorIndex))
}

export function getProviderLocalId(trackId: string, providerId: string): string | null {
  const prefix = `${normalizeProviderId(providerId)}:`
  return trackId.startsWith(prefix) ? trackId.slice(prefix.length) : null
}

/**
 * Remote track id a provider's library writes (favorites, playlist adds) expect.
 * NetEase carries a numeric song id; other providers keep it in the `<provider>:`
 * prefixed track id.
 */
export function resolveProviderTrackId(
  track: Pick<Track, 'id' | 'ncmSongId'>,
  providerId: string
): string | number | null {
  if (normalizeProviderId(providerId) === 'ncm') return getNcmSongId(track)
  const localId = getProviderLocalId(track.id, providerId)?.trim()
  return localId || null
}

export function toProviderIpcArgs(args: unknown[]): unknown[] {
  return args.map((arg) => toProviderIpcValue(arg))
}

function toProviderIpcValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value

  const raw = toRaw(value) as object
  if (seen.has(raw)) return null
  seen.add(raw)

  if (Array.isArray(raw)) {
    return raw.map((item) => toProviderIpcValue(item, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(raw)) {
    if (typeof nestedValue === 'function' || typeof nestedValue === 'symbol') continue
    output[key] = toProviderIpcValue(nestedValue, seen)
  }
  return output
}

function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase()
}

async function assertProviderEnabled(provider: MediaProvider): Promise<void> {
  if (!provider.isEnabled) return
  if (!(await provider.isEnabled())) {
    throw new Error(`${provider.name} provider is disabled or not logged in`)
  }
}

async function isProviderAvailable(provider: MediaProvider): Promise<boolean> {
  if (!provider.isEnabled) return true
  try {
    return await provider.isEnabled()
  } catch {
    return false
  }
}

function providerLyricPriority(id: string): number {
  const normalized = normalizeProviderId(id)
  if (normalized === 'ncm') return 0
  if (normalized === 'bili') return 2
  return 1
}

function hasAnyLyrics(lyrics: MediaProviderLyrics | null | undefined): boolean {
  if (!lyrics) return false
  return Boolean(lyrics.lyrics || lyrics.translatedLyrics || lyrics.wordLyrics)
}

async function resolveLyricsFromProviderSearch(
  provider: MediaProvider,
  query: string,
  track: Track,
  remainingTimeout: () => number,
  signal?: AbortSignal
): Promise<ProviderLyricsSearchResult> {
  try {
    const availableTimeoutMs = remainingTimeout()
    if (availableTimeoutMs <= 0) return { lyrics: null, failure: null }
    if (!(await withTimeout(isProviderAvailable(provider), availableTimeoutMs, signal))) {
      return { lyrics: null, failure: null }
    }

    const searchTimeoutMs = remainingTimeout()
    if (searchTimeoutMs <= 0) return { lyrics: null, failure: null }
    const search = await withTimeout(
      provider.searchSongs!(query, 5, 0, { signal }),
      searchTimeoutMs,
      signal
    )
    const match = pickBestLyricSearchMatch(track, search.items)
    if (!match || !provider.getLyrics) return { lyrics: null, failure: null }

    const lyricsTimeoutMs = remainingTimeout()
    if (lyricsTimeoutMs <= 0) return { lyrics: null, failure: null }
    const lyrics = await withTimeout(provider.getLyrics(match, { signal }), lyricsTimeoutMs, signal)
    return { lyrics: hasAnyLyrics(lyrics) ? lyrics : null, failure: null }
  } catch (error) {
    return { lyrics: null, failure: error }
  }
}

async function resolveFirstProviderLyrics(
  requests: Array<Promise<ProviderLyricsSearchResult>>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProviderLyricsSearchResult> {
  const empty: ProviderLyricsSearchResult = { lyrics: null, failure: null }
  if (requests.length === 0 || timeoutMs <= 0) return empty
  let firstFailure: unknown = null
  try {
    const result = await withTimeout(
      Promise.any(
        requests.map(async (request) => {
          const outcome = await request
          if (outcome.lyrics) return outcome
          if (outcome.failure && firstFailure == null) firstFailure = outcome.failure
          throw new Error('Provider did not return lyrics')
        })
      ),
      timeoutMs,
      signal
    )
    return result
  } catch (error) {
    if (signal?.aborted) return empty
    if (error instanceof AggregateError && firstFailure == null) return empty
    return { lyrics: null, failure: firstFailure ?? new Error('Lyrics provider timed out') }
  }
}

function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function pickBestLyricSearchMatch(local: Track, candidates: Track[]): Track | null {
  const localTitle = normalizeMatchText(local.title)
  const localArtist = normalizeMatchText(local.artist)
  if (!localTitle) return null
  const localCompactTitle = compactLyricMatchText(localTitle)
  const localArtistTokens = lyricArtistTokens(localArtist)
  let best: Track | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    const title = normalizeMatchText(candidate.title)
    const compactTitle = compactLyricMatchText(title)
    if (!title || !compactTitle) continue
    const titleScore =
      title === localTitle
        ? 24
        : compactTitle === localCompactTitle
          ? 20
          : lyricTitleScore(compactTitle, localCompactTitle)
    if (titleScore === 0) continue
    const artist = normalizeMatchText(candidate.artist)
    let artistScore = 0
    if (localArtist && artist) {
      if (artist === localArtist) artistScore = 10
      else if (lyricArtistTokens(artist).some((token) => localArtistTokens.includes(token)))
        artistScore = 8
      else if (artist.includes(localArtist) || localArtist.includes(artist)) artistScore = 4
    }
    let durationScore = 0
    if (
      typeof local.duration === 'number' &&
      local.duration > 0 &&
      typeof candidate.duration === 'number' &&
      candidate.duration > 0
    ) {
      const delta = Math.abs(local.duration - candidate.duration)
      if (delta <= 3) durationScore = 5
      else if (delta <= 8) durationScore = 2
      else if (delta > 30) continue
    }
    if (artistScore === 0 && durationScore === 0) continue
    const score = titleScore + artistScore + durationScore
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return bestScore >= 16 ? best : null
}

function compactLyricMatchText(value: string): string {
  return value
    .replace(/[（(][^）)]*(?:feat|ft|with)[^）)]*[）)]/giu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function lyricTitleScore(candidate: string, local: string): number {
  if (candidate.length < 4 || local.length < 4) return 0
  return candidate.includes(local) || local.includes(candidate) ? 14 : 0
}

function lyricArtistTokens(value: string): string[] {
  return value
    .split(/[\\/＆&、,，;；]/u)
    .map((part) => compactLyricMatchText(part))
    .filter((part) => part.length >= 2)
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw new Error('Aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectTimeout: ((reason?: unknown) => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject
    timer = setTimeout(() => reject(new Error('Lyrics provider timed out')), timeoutMs)
  })
  const onAbort = (): void => {
    if (timer) clearTimeout(timer)
    rejectTimeout?.(new Error('Aborted'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
