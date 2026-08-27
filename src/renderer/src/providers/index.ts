import { MediaProviderRegistry, toProviderIpcArgs } from './mediaProvider.ts'
import type {
  MediaProviderArtistSummary,
  MediaProviderAlbumSummary,
  MediaProviderHealth,
  MediaProviderPlaylistSummary,
  MediaProviderProfile,
  MediaProviderSearchResult,
  MediaProviderUserSummary
} from './mediaProvider.ts'
import type { Track } from '../types/music'

const mediaProviders = new MediaProviderRegistry()
let defaultsRegistered = false
let pluginProvidersSyncing: Promise<void> | null = null
let pluginProviderHealthRefreshing: Promise<void> | null = null
let pluginProviderHealthRefreshedAt = 0
const PLUGIN_PROVIDER_HEALTH_REFRESH_INTERVAL_MS = 5_000

export function useMediaProviders(): MediaProviderRegistry {
  registerDefaultProviders()
  void syncPluginProviders()
  return mediaProviders
}

export function registerDefaultProviders(): void {
  if (defaultsRegistered) return
  defaultsRegistered = true
}

async function refreshPluginProviderHealth(): Promise<void> {
  if (Date.now() - pluginProviderHealthRefreshedAt < PLUGIN_PROVIDER_HEALTH_REFRESH_INTERVAL_MS) {
    return
  }
  if (pluginProviderHealthRefreshing) return pluginProviderHealthRefreshing
  const api = window.api?.providers
  if (!api) return

  pluginProviderHealthRefreshing = (async () => {
    try {
      const providers = await api.list()
      for (const provider of providers) {
        if (!mediaProviders.get(provider.id)) continue
        mediaProviders.update(provider.id, {
          name: provider.name,
          capabilities: provider.capabilities,
          health: provider.health as MediaProviderHealth | undefined,
          isEnabled: () => provider.health?.available !== false
        })
      }
    } catch {
      // Health refresh follows provider calls opportunistically; callers should keep their result.
    } finally {
      pluginProviderHealthRefreshing = null
      pluginProviderHealthRefreshedAt = Date.now()
    }
  })()

  return pluginProviderHealthRefreshing
}

export async function syncPluginProviders(): Promise<void> {
  if (pluginProvidersSyncing) return pluginProvidersSyncing
  const api = window.api?.providers
  if (!api) return

  pluginProvidersSyncing = (async () => {
    try {
      const providers = await api.list()
      const activePluginProviderIds = new Set(providers.map((provider) => provider.id))
      mediaProviders.unregisterWhere(
        (provider) => provider.source === 'plugin' && !activePluginProviderIds.has(provider.id)
      )
      for (const provider of providers) {
        if (mediaProviders.get(provider.id)) {
          mediaProviders.update(provider.id, {
            name: provider.name,
            capabilities: provider.capabilities,
            health: provider.health as MediaProviderHealth | undefined,
            isEnabled: () => provider.health?.available !== false
          })
          continue
        }
        const callProvider = async <T>(
          method: string,
          args: unknown[] = [],
          options?: { signal?: AbortSignal }
        ): Promise<T> => {
          if (options?.signal?.aborted) throw new Error('Provider call was cancelled')
          // AbortSignal instances cannot cross the contextBridge, so the
          // preload never sees the real signal. Generate a request id here and
          // cancel the in-flight main-process call from the renderer instead.
          let requestId: string | undefined
          let onAbort: (() => void) | undefined
          if (options?.signal) {
            requestId = `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
            onAbort = (): void => {
              if (requestId) void api.cancel(requestId)
            }
            options.signal.addEventListener('abort', onAbort, { once: true })
          }
          try {
            return (await api.call(
              provider.id,
              method as never,
              toProviderIpcArgs(args),
              requestId ? { requestId } : undefined
            )) as T
          } finally {
            void refreshPluginProviderHealth()
            if (options?.signal && onAbort) {
              options.signal.removeEventListener('abort', onAbort)
            }
          }
        }
        mediaProviders.register({
          id: provider.id,
          name: provider.name,
          source: 'plugin',
          capabilities: provider.capabilities,
          health: provider.health as MediaProviderHealth | undefined,
          isEnabled: () => provider.health?.available !== false,
          getPlaybackUrl: provider.capabilities.includes('playbackUrl')
            ? (track, options) => callProvider<string | null>('getPlaybackUrl', [track, options])
            : undefined,
          getLyrics: provider.capabilities.includes('lyrics')
            ? (track, options) =>
                callProvider<{
                  lyrics: string | null
                  translatedLyrics: string | null
                  wordLyrics?: string | null
                }>('getLyrics', [track], options)
            : undefined,
          searchSongs: provider.capabilities.includes('search')
            ? (keywords, limit, offset, options) =>
                callProvider<MediaProviderSearchResult<Track>>(
                  'searchSongs',
                  [keywords, limit, offset],
                  options
                )
            : undefined,
          searchPlaylists: provider.capabilities.includes('playlist')
            ? (keywords, limit, offset) =>
                callProvider<MediaProviderSearchResult<MediaProviderPlaylistSummary>>(
                  'searchPlaylists',
                  [keywords, limit, offset]
                )
            : undefined,
          searchArtists: provider.capabilities.includes('search')
            ? (keywords, limit, offset) =>
                callProvider<MediaProviderSearchResult<MediaProviderArtistSummary>>(
                  'searchArtists',
                  [keywords, limit, offset]
                )
            : undefined,
          fetchPlaylistTracks: provider.capabilities.includes('playlist')
            ? (playlistId, force) =>
                callProvider<Track[]>('fetchPlaylistTracks', [playlistId, force])
            : undefined,
          checkLogin: provider.capabilities.includes('login')
            ? () =>
                callProvider<{ loggedIn: boolean; profile: MediaProviderProfile | null }>(
                  'checkLogin'
                )
            : undefined,
          getProfile: provider.capabilities.includes('login')
            ? () => callProvider<MediaProviderProfile | null>('getProfile')
            : undefined,
          logout: provider.capabilities.includes('login')
            ? () => callProvider<void>('logout')
            : undefined,
          getQrLogin: provider.capabilities.includes('login')
            ? () =>
                callProvider<{
                  key: string
                  qrContent?: string
                  imageDataUrl?: string
                  expiresInSeconds?: number
                } | null>('getQrLogin')
            : undefined,
          getQrKey: provider.capabilities.includes('login')
            ? () => callProvider<string | null>('getQrKey')
            : undefined,
          getQrImage: provider.capabilities.includes('login')
            ? (key) => callProvider<string | null>('getQrImage', [key])
            : undefined,
          checkQrLogin: provider.capabilities.includes('login')
            ? (key) => callProvider<{ code: number }>('checkQrLogin', [key])
            : undefined,
          fetchUserLibrary: provider.capabilities.includes('library')
            ? (force) =>
                callProvider<{
                  likedPlaylist: MediaProviderPlaylistSummary | null
                  playlists: MediaProviderPlaylistSummary[]
                }>('fetchUserLibrary', [force])
            : undefined,
          fetchLikedTracks: provider.capabilities.includes('library')
            ? (force) => callProvider<Track[]>('fetchLikedTracks', [force])
            : undefined,
          fetchRecommendSongs: provider.capabilities.includes('library')
            ? () => callProvider<Track[]>('fetchRecommendSongs')
            : undefined,
          fetchRecommendPlaylists: provider.capabilities.includes('library')
            ? () => callProvider<MediaProviderPlaylistSummary[]>('fetchRecommendPlaylists')
            : undefined,
          fetchPersonalFm: provider.capabilities.includes('library')
            ? () => callProvider<Track[]>('fetchPersonalFm')
            : undefined,
          fetchPrivateContent: provider.capabilities.includes('library')
            ? () => callProvider<Track[]>('fetchPrivateContent')
            : undefined,
          fetchArtistTopSongs: provider.capabilities.includes('search')
            ? (artistId) => callProvider<Track[]>('fetchArtistTopSongs', [artistId])
            : undefined,
          fetchArtistAlbums: provider.capabilities.includes('library')
            ? (artistId) =>
                callProvider<MediaProviderAlbumSummary[]>('fetchArtistAlbums', [artistId])
            : undefined,
          fetchArtistIntro: provider.capabilities.includes('library')
            ? (artistId) => callProvider<string>('fetchArtistIntro', [artistId])
            : undefined,
          fetchArtistFollowState: provider.capabilities.includes('library')
            ? (artistId) => callProvider<boolean | null>('fetchArtistFollowState', [artistId])
            : undefined,
          fetchAlbumTracks: provider.capabilities.includes('playlist')
            ? (albumId) => callProvider<Track[]>('fetchAlbumTracks', [albumId])
            : undefined,
          fetchArtistPlaylists: provider.capabilities.includes('playlist')
            ? (artistId) =>
                callProvider<MediaProviderPlaylistSummary[]>('fetchArtistPlaylists', [artistId])
            : undefined,
          fetchUserPlaylistsByUid: provider.capabilities.includes('library')
            ? (uid, createdOnly) =>
                callProvider<MediaProviderPlaylistSummary[]>('fetchUserPlaylistsByUid', [
                  uid,
                  createdOnly
                ])
            : undefined,
          fetchUserFollows: provider.capabilities.includes('library')
            ? (uid, limit, offset) =>
                callProvider<MediaProviderUserSummary[]>('fetchUserFollows', [uid, limit, offset])
            : undefined,
          fetchUserFolloweds: provider.capabilities.includes('library')
            ? (uid, limit, offset) =>
                callProvider<MediaProviderUserSummary[]>('fetchUserFolloweds', [uid, limit, offset])
            : undefined,
          fetchPlayRecords: provider.capabilities.includes('library')
            ? (type) => callProvider<Track[]>('fetchPlayRecords', [type])
            : undefined,
          fetchRecentSongs: provider.capabilities.includes('library')
            ? (limit) => callProvider<Track[]>('fetchRecentSongs', [limit])
            : undefined,
          followArtist: provider.capabilities.includes('library')
            ? (artistId, follow) => callProvider<void>('followArtist', [artistId, follow])
            : undefined,
          followUser: provider.capabilities.includes('library')
            ? (userId, follow) => callProvider<void>('followUser', [userId, follow])
            : undefined,
          likeTrack: provider.capabilities.includes('library')
            ? (trackId, like) => callProvider<void>('likeTrack', [trackId, like])
            : undefined,
          isTrackLiked: provider.capabilities.includes('library')
            ? (trackId) => callProvider<boolean>('isTrackLiked', [trackId])
            : undefined,
          createPlaylist: provider.capabilities.includes('library')
            ? (name, options) =>
                callProvider<MediaProviderPlaylistSummary>('createPlaylist', [name, options])
            : undefined,
          deletePlaylist: provider.capabilities.includes('library')
            ? (playlistId) => callProvider<void>('deletePlaylist', [playlistId])
            : undefined,
          addTracksToPlaylist: provider.capabilities.includes('library')
            ? (playlistId, trackIds) =>
                callProvider<void>('addTracksToPlaylist', [playlistId, trackIds])
            : undefined,
          removeTracksFromPlaylist: provider.capabilities.includes('library')
            ? (playlistId, trackIds) =>
                callProvider<void>('removeTracksFromPlaylist', [playlistId, trackIds])
            : undefined
        })
      }
    } finally {
      pluginProvidersSyncing = null
    }
  })()

  return pluginProvidersSyncing
}

export * from './mediaProvider.ts'
export * from './ncmTrack.ts'
