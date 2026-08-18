import type {
  TwilightMediaProviderHealth,
  TwilightMediaProviderMethod,
  TwilightMediaProviderRegistration,
  TwilightProviderStreamingSection,
  TwilightProviderUiMetadata
} from './types'

const PLUGIN_PROVIDER_DEFAULT_TIMEOUT_MS = 15000
const PLUGIN_PROVIDER_MEDIUM_TIMEOUT_MS = 30000
const PLUGIN_PROVIDER_SLOW_TIMEOUT_MS = 120000

export function getProviderCallTimeoutMs(method: TwilightMediaProviderMethod): number {
  if (
    [
      'fetchPlaylistTracks',
      'fetchLikedTracks',
      'fetchLikedTracksPage',
      'fetchCloudSongsPage',
      'fetchUserLibrary',
      'fetchRecommendSongs',
      'fetchRecommendPlaylists',
      'fetchPersonalFm',
      'fetchPrivateContent',
      'fetchArtistTopSongs',
      'fetchArtistAlbums',
      'fetchAlbumTracks',
      'fetchArtistPlaylists',
      'fetchUserPlaylistsByUid',
      'fetchUserFollows',
      'fetchUserFolloweds',
      'fetchPlayRecords',
      'fetchRecentSongs'
    ].includes(method)
  ) {
    return PLUGIN_PROVIDER_SLOW_TIMEOUT_MS
  }
  if (
    [
      'getPlaybackUrl',
      'getLyrics',
      'searchSongs',
      'searchPlaylists',
      'searchArtists',
      'fetchPlaylistCategories',
      'fetchDiscoveryPlaylists',
      'fetchHighQualityPlaylists'
    ].includes(method)
  ) {
    return PLUGIN_PROVIDER_MEDIUM_TIMEOUT_MS
  }
  return PLUGIN_PROVIDER_DEFAULT_TIMEOUT_MS
}

export interface ProviderHealthRecord {
  providerId: string
  pluginId: string
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  methodStats: Partial<Record<TwilightMediaProviderMethod, ProviderMethodHealthRecord>>
  lastError: string | null
  lastCheckedAt: string | null
}

export interface ProviderMethodHealthRecord {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  lastError: string | null
  lastCheckedAt: string | null
}

export function normalizeProviderHealth(
  raw: unknown,
  providerId: string,
  pluginId: string
): ProviderHealthRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const totalCalls = normalizeCount(record.totalCalls)
  const successfulCalls = normalizeCount(record.successfulCalls)
  const failedCalls = normalizeCount(record.failedCalls)
  const methodStats: ProviderHealthRecord['methodStats'] = {}
  if (record.methodStats && typeof record.methodStats === 'object') {
    for (const [method, value] of Object.entries(record.methodStats as Record<string, unknown>)) {
      if (!isTwilightMediaProviderMethod(method) || !value || typeof value !== 'object') continue
      const methodRecord = value as Record<string, unknown>
      methodStats[method] = {
        totalCalls: normalizeCount(methodRecord.totalCalls),
        successfulCalls: normalizeCount(methodRecord.successfulCalls),
        failedCalls: normalizeCount(methodRecord.failedCalls),
        lastError: normalizeNullableString(methodRecord.lastError),
        lastCheckedAt: normalizeNullableString(methodRecord.lastCheckedAt)
      }
    }
  }
  return {
    providerId,
    pluginId,
    totalCalls,
    successfulCalls,
    failedCalls,
    methodStats,
    lastError: normalizeNullableString(record.lastError),
    lastCheckedAt: normalizeNullableString(record.lastCheckedAt)
  }
}

export function getProviderMethodStats(
  health: ProviderHealthRecord | undefined
): TwilightMediaProviderHealth['methodStats'] {
  if (!health) return {}
  const stats: TwilightMediaProviderHealth['methodStats'] = {}
  for (const [method, record] of Object.entries(health.methodStats)) {
    const totalCalls = record?.totalCalls ?? 0
    const successfulCalls = record?.successfulCalls ?? 0
    const failedCalls = record?.failedCalls ?? 0
    stats[method as TwilightMediaProviderMethod] = {
      totalCalls,
      successfulCalls,
      failedCalls,
      successRate: totalCalls > 0 ? successfulCalls / totalCalls : 1,
      lastError: record?.lastError ?? null,
      lastCheckedAt: record?.lastCheckedAt ?? null
    }
  }
  return stats
}

export function normalizeProviderUi(raw: unknown): TwilightMediaProviderRegistration['ui'] {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const icon = typeof record.icon === 'string' ? record.icon.trim() : ''
  const authType =
    record.authType === 'qr' ||
    record.authType === 'oauth' ||
    record.authType === 'cookie' ||
    record.authType === 'settings'
      ? record.authType
      : 'qr'
  // 解析 qrStatusCodes
  let qrStatusCodes: TwilightProviderUiMetadata['qrStatusCodes'] | undefined
  if (record.qrStatusCodes && typeof record.qrStatusCodes === 'object') {
    const codes = record.qrStatusCodes as Record<string, unknown>
    qrStatusCodes = {
      waiting: typeof codes.waiting === 'number' ? codes.waiting : -1,
      scanned: typeof codes.scanned === 'number' ? codes.scanned : null,
      expired: typeof codes.expired === 'number' ? codes.expired : -1,
      denied: typeof codes.denied === 'number' ? codes.denied : undefined,
      success: typeof codes.success === 'number' ? codes.success : 0
    }
  }
  // 解析 streamingSections
  let streamingSections: TwilightProviderStreamingSection[] | undefined
  if (Array.isArray(record.streamingSections)) {
    streamingSections = record.streamingSections
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        title: typeof item.title === 'string' ? item.title : '',
        icon: typeof item.icon === 'string' ? item.icon : 'pi pi-music',
        method: typeof item.method === 'string' ? item.method : '',
        args: Array.isArray(item.args) ? item.args : undefined
      }))
      .filter((section) => section.id && section.title && section.method)
  }
  return {
    icon,
    color: typeof record.color === 'string' ? record.color : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    authType,
    loginInstructions:
      typeof record.loginInstructions === 'string' ? record.loginInstructions : undefined,
    qrStatusCodes,
    showBrowserButton:
      typeof record.showBrowserButton === 'boolean' ? record.showBrowserButton : undefined,
    loginExtraActions: Array.isArray(record.loginExtraActions)
      ? record.loginExtraActions
          .filter(
            (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object'
          )
          .map((item) => ({
            label: typeof item.label === 'string' ? item.label : '',
            icon: typeof item.icon === 'string' ? item.icon : 'pi pi-external-link',
            method: typeof item.method === 'string' ? item.method : ''
          }))
          .filter((action) => action.label && action.method)
      : undefined,
    streamingSections,
    streamingLibraryTab:
      typeof record.streamingLibraryTab === 'boolean' ? record.streamingLibraryTab : undefined,
    streamingSearch:
      typeof record.streamingSearch === 'boolean' ? record.streamingSearch : undefined,
    unifiedLibrary: typeof record.unifiedLibrary === 'boolean' ? record.unifiedLibrary : undefined
  }
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, 500) : null
}

export const TWILIGHT_MEDIA_PROVIDER_METHODS = [
  'getPlaybackUrl',
  'getLyrics',
  'searchSongs',
  'searchPlaylists',
  'searchArtists',
  'fetchPlaylistTracks',
  'createDownload',
  'getDownloadStatus',
  'getDownloadFile',
  'cancelDownload',
  'checkLogin',
  'getProfile',
  'logout',
  'openOfficialLogin',
  'sendCaptcha',
  'loginByPhonePassword',
  'loginByPhoneCaptcha',
  'loginByEmailPassword',
  'getQrLogin',
  'getQrKey',
  'getQrImage',
  'checkQrLogin',
  'fetchUserLibrary',
  'fetchLikedTracks',
  'fetchLikedTracksPage',
  'fetchCloudSongsPage',
  'prepareCloudUpload',
  'completeCloudUpload',
  'getCloudDownloadUrl',
  'fetchRecommendSongs',
  'fetchRecommendPlaylists',
  'fetchPlaylistCategories',
  'fetchDiscoveryPlaylists',
  'fetchHighQualityPlaylists',
  'fetchPersonalFm',
  'fetchPrivateContent',
  'fetchArtistTopSongs',
  'fetchArtistAlbums',
  'fetchArtistIntro',
  'fetchArtistFollowState',
  'fetchAlbumTracks',
  'fetchArtistPlaylists',
  'fetchUserPlaylistsByUid',
  'fetchUserFollows',
  'fetchUserFolloweds',
  'fetchPlayRecords',
  'fetchRecentSongs',
  'fetchIntelligenceList',
  'followArtist',
  'followUser',
  'likeTrack',
  'isTrackLiked',
  'createPlaylist',
  'deletePlaylist',
  'addTracksToPlaylist',
  'removeTracksFromPlaylist'
] as const satisfies readonly TwilightMediaProviderMethod[]

export function isTwilightMediaProviderMethod(
  method: string
): method is TwilightMediaProviderMethod {
  return (TWILIGHT_MEDIA_PROVIDER_METHODS as readonly string[]).includes(method)
}

const PROVIDER_METHOD_CAPABILITIES: Partial<
  Record<TwilightMediaProviderMethod, TwilightMediaProviderRegistration['capabilities'][number]>
> = {
  getPlaybackUrl: 'playbackUrl',
  getLyrics: 'lyrics',
  searchSongs: 'search',
  searchPlaylists: 'search',
  searchArtists: 'search',
  fetchPlaylistTracks: 'playlist',
  createDownload: 'download',
  getDownloadStatus: 'download',
  getDownloadFile: 'download',
  cancelDownload: 'download',
  checkLogin: 'login',
  getProfile: 'login',
  logout: 'login',
  openOfficialLogin: 'login',
  sendCaptcha: 'login',
  loginByPhonePassword: 'login',
  loginByPhoneCaptcha: 'login',
  loginByEmailPassword: 'login',
  getQrLogin: 'login',
  getQrKey: 'login',
  getQrImage: 'login',
  checkQrLogin: 'login',
  fetchUserLibrary: 'library',
  fetchLikedTracks: 'library',
  fetchLikedTracksPage: 'library',
  fetchCloudSongsPage: 'library',
  prepareCloudUpload: 'library',
  completeCloudUpload: 'library',
  getCloudDownloadUrl: 'library',
  fetchRecommendSongs: 'library',
  fetchRecommendPlaylists: 'library',
  fetchPlaylistCategories: 'playlist',
  fetchDiscoveryPlaylists: 'playlist',
  fetchHighQualityPlaylists: 'playlist',
  fetchPersonalFm: 'library',
  fetchPrivateContent: 'library',
  fetchArtistTopSongs: 'library',
  fetchArtistAlbums: 'library',
  fetchArtistIntro: 'library',
  fetchArtistFollowState: 'library',
  fetchAlbumTracks: 'playlist',
  fetchArtistPlaylists: 'library',
  fetchUserPlaylistsByUid: 'library',
  fetchUserFollows: 'library',
  fetchUserFolloweds: 'library',
  fetchPlayRecords: 'library',
  fetchRecentSongs: 'library',
  fetchIntelligenceList: 'playlist',
  followArtist: 'library',
  followUser: 'library',
  likeTrack: 'library',
  isTrackLiked: 'library',
  createPlaylist: 'library',
  deletePlaylist: 'library',
  addTracksToPlaylist: 'library',
  removeTracksFromPlaylist: 'library'
}

export function providerSupportsMethod(
  provider: TwilightMediaProviderRegistration,
  method: TwilightMediaProviderMethod
): boolean {
  const requiredCapability = PROVIDER_METHOD_CAPABILITIES[method]
  return !requiredCapability || provider.capabilities.includes(requiredCapability)
}

export function findProviderRoute<T extends { providers: TwilightMediaProviderRegistration[] }>(
  runningPlugins: Iterable<T>,
  providerId: string,
  method: TwilightMediaProviderMethod
): T | null {
  const normalizedProviderId = providerId.trim().toLowerCase()
  const candidates = [...runningPlugins]
  for (const running of candidates.reverse()) {
    if (
      running.providers.some(
        (provider) =>
          provider.id === normalizedProviderId && providerSupportsMethod(provider, method)
      )
    ) {
      return running
    }
  }
  return null
}

export function dedupeProviderRegistrations<
  T extends { providers: TwilightMediaProviderRegistration[] }
>(runningPlugins: Iterable<T>): TwilightMediaProviderRegistration[] {
  const providers = new Map<string, TwilightMediaProviderRegistration>()
  for (const running of runningPlugins) {
    for (const provider of running.providers) {
      providers.set(provider.id, provider)
    }
  }
  return [...providers.values()]
}
