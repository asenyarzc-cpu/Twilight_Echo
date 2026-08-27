let contextRef = null
let ncmApi = null

const PROVIDER_ID = 'ncm'
const COOKIE_KEY = 'cookie'
const PC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0'
const TRANSIENT_LOGIN_ERROR_CODES = new Set([301, 502, 503, 460])
const NCM_PLAYBACK_QUALITY_FALLBACKS = {
  auto: ['hires', 'lossless', 'exhigh', 'standard'],
  hires: ['hires', 'lossless', 'exhigh', 'standard'],
  lossless: ['lossless', 'exhigh', 'standard'],
  exhigh: ['exhigh', 'standard'],
  standard: ['standard']
}
const playlistTrackCache = new Map()
const streamUrlCache = new Map()
// CDN 签发地址会过期：无 TTL 的缓存会把 403 回放成多提供方大恢复，20 分钟
// 内命中即可，超时强制重解析（批量 8.2）。
const STREAM_URL_CACHE_TTL_MS = 20 * 60_000
const providerWriteResults = new Map()
const PROVIDER_WRITE_IDEMPOTENCY_TTL_MS = 5 * 60_000
const MAX_PROVIDER_WRITE_IDEMPOTENCY_RECORDS = 256
const MAX_PERSISTED_PROVIDER_WRITE_IDEMPOTENCY_RECORDS = 128
const PROVIDER_WRITE_IDEMPOTENCY_SETTINGS_KEY = 'providerWriteIdempotency'
const MAX_PLAYLIST_TRACKS = 5000
const PLAYLIST_TRACK_PAGE_SIZE = 1000
const PERSONAL_FM_TARGET_TRACKS = 30
const PERSONAL_FM_MAX_FALLBACK_BATCHES = 10
const PERSONAL_RADAR_PLAYLIST_ID = 3136952023
let likedTracksCache = null
let playlistCatalogueCache = null
let likedSongIdListCache = null
let cachedUserId = null
let likedIdsFreshAt = 0
let likedIdsRefreshInFlight = null
let likedIdsRefreshRetryAt = 0
let likedIdsRevision = 0
const LIKED_IDS_REFRESH_TTL_MS = 60_000
const LIKED_IDS_REFRESH_FAIL_BACKOFF_MS = 15_000
let personalFmSeenSongIds = new Set()
let likedSongIds = new Set()
let ownedPlaylistIds = new Set()
let providerWriteRecordsLoaded = false
let providerWritePersistenceTail = Promise.resolve()
const PROFILE_CACHE_TTL_MS = 90 * 1000
const LYRICS_CACHE_CAPACITY = 200
const DETAIL_REQUEST_CONCURRENCY = 3
let profileCache = null
const lyricsCache = new Map()

export async function activate(context) {
  contextRef = context
  ncmApi = context.twilight.internal?.ncm
  if (!ncmApi) {
    throw new Error('Built-in NetEase provider requires the internal NCM gateway')
  }
  await loadProviderWriteResults()

  await context.twilight.providers.register({
    id: PROVIDER_ID,
    name: 'NetEase Cloud Music',
    capabilities: ['search', 'playbackUrl', 'lyrics', 'cover', 'playlist', 'library', 'login'],
    ui: {
      icon: 'pi pi-cloud',
      color: '#c20c0c',
      description: '内置基础音源',
      authType: 'qr',
      loginInstructions: '请使用网易云音乐 App 扫码登录',
      qrStatusCodes: { waiting: 801, scanned: 802, expired: 800, success: 803 },
      loginExtraActions: [
        { label: '使用官方网页登录', icon: 'pi pi-external-link', method: 'openOfficialLogin' }
      ],
      streamingSections: [
        { id: 'daily', title: '每日推荐', icon: 'pi pi-calendar', method: 'fetchRecommendSongs' },
        { id: 'fm', title: '私人漫游', icon: 'pi pi-compass', method: 'fetchPersonalFm' },
        { id: 'radar', title: '私人雷达', icon: 'pi pi-send', method: 'fetchPrivateContent' }
      ],
      streamingLibraryTab: true,
      streamingSearch: true
    },
    getPlaybackUrl,
    getLyrics,
    searchSongs,
    searchPlaylists,
    searchArtists,
    fetchPlaylistTracks,
    checkLogin,
    getProfile,
    logout,
    openOfficialLogin,
    sendCaptcha,
    loginByPhonePassword,
    loginByPhoneCaptcha,
    loginByEmailPassword,
    getQrLogin,
    getQrKey,
    getQrImage,
    checkQrLogin,
    fetchUserLibrary,
    fetchLikedTracks,
    fetchLikedTracksPage,
    fetchCloudSongsPage,
    prepareCloudUpload,
    completeCloudUpload,
    getCloudDownloadUrl,
    fetchRecommendSongs,
    fetchRecommendPlaylists,
    fetchPlaylistCategories,
    fetchDiscoveryPlaylists,
    fetchHighQualityPlaylists,
    fetchPersonalFm,
    fetchPrivateContent,
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
    createPlaylist,
    deletePlaylist,
    addTracksToPlaylist,
    removeTracksFromPlaylist
  })

  context.logger.info('Built-in NetEase Cloud Music provider registered')
}

export function deactivate() {
  contextRef = null
  ncmApi = null
  resetCaches()
}

function appendQueryParam(path, key, value) {
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
}

function appendQueryParams(path, params) {
  return Object.entries(params).reduce(
    (nextPath, [key, value]) => appendQueryParam(nextPath, key, value),
    path
  )
}

function withPcUa(path) {
  return appendQueryParam(path, 'ua', PC_UA)
}

function withQrLoginParams(path) {
  return appendQueryParams(path, { ua: 'pc' })
}

function shouldUsePcUa(path) {
  if (path.startsWith('/song/url')) return false
  return !path.startsWith('/login/')
}

function normalizeApiMessage(data, fallback) {
  const message = data?.message ?? data?.msg ?? data?.data?.message ?? data?.body?.message
  return typeof message === 'string' && message.trim() ? message.trim() : fallback
}

function isRiskControlMessage(message) {
  return /安全风险|设备环境异常|操作已拦截|高频|风控|ip 高频|IP 高频/i.test(message)
}

function describeApiError(code, data) {
  const rawMessage = normalizeApiMessage(data, '')
  if (rawMessage && isRiskControlMessage(rawMessage)) {
    if (/安全风险|设备环境异常|操作已拦截/i.test(rawMessage)) {
      return `网易云拦截了当前网络或设备环境：${rawMessage}。请停止频繁重试，切换网络/设备或按官方提示 24 小时后再试。`
    }
    return `网易云登录接口触发高频或风控限制：${rawMessage}。请等待几分钟后再试。`
  }
  if (code === 301) return '网易云登录态无效或接口缓存了未登录结果，请重新登录或等待 2 分钟后重试。'
  if (code === 400)
    return normalizeApiMessage(data, '网易云登录参数无效，请检查账号、密码或验证码。')
  if (code === 502) return '网易云二维码状态检查失败，已尝试无 Cookie 模式，请刷新二维码后重试。'
  if (code === 503) return '网易云登录接口触发高频/风控限制，请等待几分钟后再试。'
  if (code === 460) return '网易云限制了当前网络环境，请切换到国内网络或稍后重试。'
  return normalizeApiMessage(data, 'NetEase API request failed')
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName}不能为空`)
  }
  return value.trim()
}

function normalizeCountryCode(countrycode) {
  const normalized =
    typeof countrycode === 'string' && countrycode.trim() ? countrycode.trim() : '86'
  return /^[0-9]{1,6}$/.test(normalized) ? normalized : '86'
}

function resetCaches() {
  playlistTrackCache.clear()
  streamUrlCache.clear()
  providerWriteResults.clear()
  likedTracksCache = null
  playlistCatalogueCache = null
  likedSongIdListCache = null
  cachedUserId = null
  likedIdsFreshAt = 0
  likedIdsRefreshInFlight = null
  likedIdsRefreshRetryAt = 0
  likedIdsRevision += 1
  profileCache = null
  lyricsCache.clear()
  personalFmSeenSongIds = new Set()
  likedSongIds = new Set()
  ownedPlaylistIds = new Set()
  providerWriteRecordsLoaded = false
  providerWritePersistenceTail = Promise.resolve()
  // 令牌桶随会话一起重置：排队中的 acquire 取的是新桶令牌，语义不受影响。
  requestTokenCount = REQUEST_TOKEN_BUCKET_CAPACITY
  requestTokenRefillAt = Date.now()
}

function runIdempotentProviderWrite(scope, args, requestContext, operation, replaySuccess) {
  throwIfRequestAborted(requestContext)
  const idempotencyKey = requestContext?.idempotencyKey
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) return operation()

  pruneProviderWriteResults()
  const cacheKey = `${scope}\u0000${idempotencyKey}`
  const fingerprint = JSON.stringify(args)
  const existing = providerWriteResults.get(cacheKey)
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error('Provider idempotency key was reused for a different write payload')
    }
    if (existing.settled) replaySuccess?.()
    return existing.promise
  }

  makeProviderWriteResultRoom()
  const record = {
    fingerprint,
    promise: null,
    expiresAt: Number.POSITIVE_INFINITY,
    settled: false
  }
  record.promise = Promise.resolve()
    .then(operation)
    .then(
      async (value) => {
        if (providerWriteResults.get(cacheKey) !== record) return value
        record.settled = true
        record.expiresAt = Date.now() + PROVIDER_WRITE_IDEMPOTENCY_TTL_MS
        await persistProviderWriteResults()
        return value
      },
      async (error) => {
        if (providerWriteResults.get(cacheKey) === record) {
          providerWriteResults.delete(cacheKey)
          await persistProviderWriteResults()
        }
        throw error
      }
    )
  providerWriteResults.set(cacheKey, record)
  return record.promise
}

function pruneProviderWriteResults() {
  const now = Date.now()
  let changed = false
  for (const [cacheKey, record] of providerWriteResults) {
    if (record.settled && record.expiresAt <= now) {
      providerWriteResults.delete(cacheKey)
      changed = true
    }
  }
  if (changed) void persistProviderWriteResults()
}

function makeProviderWriteResultRoom() {
  if (providerWriteResults.size < MAX_PROVIDER_WRITE_IDEMPOTENCY_RECORDS) return
  for (const [cacheKey, record] of providerWriteResults) {
    if (!record.settled) continue
    providerWriteResults.delete(cacheKey)
    if (providerWriteResults.size < MAX_PROVIDER_WRITE_IDEMPOTENCY_RECORDS) return
  }
  throw new Error('Provider idempotency registry is full of in-flight writes')
}

async function loadProviderWriteResults() {
  if (providerWriteRecordsLoaded) return
  providerWriteRecordsLoaded = true
  const persisted = await getContext().settings.get(PROVIDER_WRITE_IDEMPOTENCY_SETTINGS_KEY)
  if (!persisted || typeof persisted !== 'object' || !Array.isArray(persisted.records)) return

  const now = Date.now()
  for (const entry of persisted.records.slice(-MAX_PERSISTED_PROVIDER_WRITE_IDEMPOTENCY_RECORDS)) {
    if (!entry || typeof entry !== 'object') continue
    const { scope, key, fingerprint, expiresAt } = entry
    if (
      typeof scope !== 'string' ||
      !scope ||
      typeof key !== 'string' ||
      !key ||
      typeof fingerprint !== 'string' ||
      !fingerprint ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + PROVIDER_WRITE_IDEMPOTENCY_TTL_MS
    ) {
      continue
    }
    providerWriteResults.set(`${scope}\u0000${key}`, {
      fingerprint,
      promise: Promise.resolve(),
      expiresAt,
      settled: true
    })
  }
  pruneProviderWriteResults()
}

async function persistProviderWriteResults() {
  const records = [...providerWriteResults.entries()]
    .filter(([, record]) => record.settled && Number.isFinite(record.expiresAt))
    .slice(-MAX_PERSISTED_PROVIDER_WRITE_IDEMPOTENCY_RECORDS)
    .flatMap(([cacheKey, record]) => {
      const separator = cacheKey.indexOf('\u0000')
      if (separator <= 0 || separator === cacheKey.length - 1) return []
      return [
        {
          scope: cacheKey.slice(0, separator),
          key: cacheKey.slice(separator + 1),
          fingerprint: record.fingerprint,
          expiresAt: record.expiresAt
        }
      ]
    })
  providerWritePersistenceTail = providerWritePersistenceTail
    .catch(() => undefined)
    .then(() => getContext().settings.set(PROVIDER_WRITE_IDEMPOTENCY_SETTINGS_KEY, { records }))
    .catch((error) => {
      getContext().logger.warn(
        `Unable to persist provider idempotency records: ${getErrorMessage(error)}`
      )
    })
  await providerWritePersistenceTail
}

function getContext() {
  if (!contextRef || !ncmApi) throw new Error('NetEase provider is not active')
  return contextRef
}

async function getCookie() {
  const value = await getContext().settings.get(COOKIE_KEY)
  return typeof value === 'string' ? value : ''
}

async function saveCookie(cookie) {
  profileCache = null
  if (cookie) {
    await getContext().settings.set(COOKIE_KEY, cookie)
  } else {
    await getContext().settings.delete(COOKIE_KEY)
  }
}

function throwIfRequestAborted(requestContext) {
  if (!requestContext?.signal?.aborted) return
  const reason = requestContext.signal.reason
  throw reason instanceof Error ? reason : new Error('Provider request was cancelled')
}

// 全局请求令牌桶（批量 8.6）：所有上游请求统一经 request() 出口，突发容量
// 5、回灌速率 ~5 req/s。为批次 9 的并行化配安全带，同时降低风控触发概率。
const REQUEST_TOKEN_BUCKET_CAPACITY = 5
const REQUEST_TOKEN_REFILL_PER_MS = 5 / 1000
let requestTokenCount = REQUEST_TOKEN_BUCKET_CAPACITY
let requestTokenRefillAt = Date.now()
let requestTokenTail = Promise.resolve()

function acquireRequestToken(signal) {
  const acquire = requestTokenTail.then(
    () =>
      new Promise((resolve, reject) => {
        const attempt = () => {
          if (signal?.aborted) {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Provider request was cancelled')
            )
            return
          }
          const now = Date.now()
          if (now < requestTokenRefillAt) {
            // 系统时钟回拨（NTP 校时）：原地重置回灌基准，令牌不增不减，避免
            // 回灌窗口永不可达导致全部请求挂死。
            requestTokenRefillAt = now
          } else {
            requestTokenCount = Math.min(
              REQUEST_TOKEN_BUCKET_CAPACITY,
              requestTokenCount + (now - requestTokenRefillAt) * REQUEST_TOKEN_REFILL_PER_MS
            )
            requestTokenRefillAt = now
          }
          if (requestTokenCount >= 1) {
            requestTokenCount -= 1
            resolve()
            return
          }
          setTimeout(
            attempt,
            Math.max(5, Math.ceil((1 - requestTokenCount) / REQUEST_TOKEN_REFILL_PER_MS))
          )
        }
        attempt()
      })
  )
  requestTokenTail = acquire.catch(() => undefined)
  return acquire
}

async function request(path, cookie, requestContext) {
  throwIfRequestAborted(requestContext)
  await acquireRequestToken(requestContext?.signal)
  const data = await ncmApi.request(shouldUsePcUa(path) ? withPcUa(path) : path, cookie, {
    signal: requestContext?.signal,
    idempotencyKey: requestContext?.idempotencyKey
  })
  throwIfRequestAborted(requestContext)
  if (data && typeof data === 'object' && data.code === -1) {
    throw new Error(data.message || 'NetEase API request failed')
  }
  return data && typeof data === 'object' ? data : {}
}

function assertSuccessfulLoginResponse(data) {
  const code = Number(data?.code ?? data?.body?.code)
  if (code !== 200 || typeof data?.cookie !== 'string' || !data.cookie.includes('MUSIC_U=')) {
    throw new Error(describeApiError(Number.isFinite(code) ? code : -1, data))
  }
  return data.cookie
}

async function requestAuthed(path, requestContext) {
  const cookie = await getCookie()
  if (!cookie) throw new Error('请先登录网易云音乐')
  return request(path, cookie, requestContext)
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isReadApiTransientError(error) {
  const message = getErrorMessage(error)
  return /Unexpected|JSON|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|502|503|504/i.test(
    message
  )
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestAuthedRead(path, { attempts = 2, label = path } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestAuthed(path)
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isReadApiTransientError(error)) break
      await wait(250 * attempt)
    }
  }
  getContext().logger.warn(`网易云读取接口失败：${label}：${getErrorMessage(lastError)}`)
  throw lastError
}

async function requestOptionalAuth(path, requestContext) {
  // Anonymous-capable read: attaches the cookie when logged in, but never requires one.
  return request(path, await getCookie(), requestContext)
}

async function requestOptionalAuthRead(path, { attempts = 2, label = path, signal } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOptionalAuth(path, { signal })
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isReadApiTransientError(error)) break
      await waitWithAbort(250 * attempt, signal)
    }
  }
  getContext().logger.warn(`网易云读取接口失败：${label}：${getErrorMessage(lastError)}`)
  throw lastError
}

async function ensureProfile() {
  const login = await checkLogin()
  if (!login.loggedIn || !login.profile) throw new Error('请先登录网易云音乐')
  return login.profile
}

function getCachedProfile() {
  if (!profileCache) return null
  if (Date.now() - profileCache.at >= PROFILE_CACHE_TTL_MS) {
    profileCache = null
    return null
  }
  return profileCache.profile
}

function cacheProfile(profile) {
  profileCache = { profile, at: Date.now() }
}

function getPagedTotal(data) {
  const candidates = [
    data?.total,
    data?.count,
    data?.data?.total,
    data?.data?.count,
    data?.artist?.songCount,
    data?.artist?.albumCount
  ]
  const total = Number(candidates.find((candidate) => Number.isFinite(Number(candidate))))
  return Number.isFinite(total) && total >= 0 ? total : null
}

async function mapWithConcurrency(values, limit, operation) {
  if (values.length === 0) return []
  const results = new Array(values.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++
        results[index] = await operation(values[index], index)
      }
    })
  )
  return results
}

function formatDuration(rawDuration) {
  if (typeof rawDuration !== 'number' || !isFinite(rawDuration) || rawDuration <= 0) return 0
  return rawDuration > 1000 ? Math.round(rawDuration / 1000) : Math.round(rawDuration)
}

function normalizeNcmFormat(rawFormat) {
  if (typeof rawFormat !== 'string' || !rawFormat.trim()) return undefined
  const format = rawFormat.trim().toLowerCase()
  return format === 'mp4' ? 'm4a' : format
}

function normalizeBpm(value) {
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(numeric) || numeric < 30 || numeric > 300) return undefined
  return Math.round(numeric * 10) / 10
}

function normalizeRemoteAssetUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  return trimmed
}

const NCM_COVER_PARAM = 'param=600y600'
const NCM_COVER_SMALL_PARAM = 'param=140y140'

function normalizeNcmCoverSize(value, size) {
  const url = normalizeRemoteAssetUrl(value)
  if (!url) return null
  if (!/^https?:\/\//i.test(url) || !/music\.126\.net/i.test(url)) return url
  const param = size === 140 ? NCM_COVER_SMALL_PARAM : NCM_COVER_PARAM
  if (/[?&]param=/i.test(url)) {
    return url.replace(/([?&])param=[^&#]*/i, `$1${param}`)
  }
  return `${url}${url.includes('?') ? '&' : '?'}${param}`
}

function normalizePlaylistCoverUrl(value) {
  // NetEase serves resized thumbnails via ?param=WxH; request a larger square
  // so playlist-list covers stay sharp when displayed bigger.
  return normalizeNcmCoverSize(value, 600)
}

function getSongAudioMeta(song) {
  const candidates = [
    song.sq,
    song.hr,
    song.h,
    song.m,
    song.l,
    song.mainSong?.sq,
    song.mainSong?.h
  ].filter(Boolean)
  const source = candidates.find((item) => item.br || item.bitrate || item.sr || item.size) ?? {}
  const bitrate = Number(source.br ?? source.bitrate ?? song.br ?? song.bitrate)
  const sampleRate = Number(source.sr ?? source.sampleRate ?? song.sr ?? song.sampleRate)
  const size = Number(source.size ?? song.size)
  const format =
    normalizeNcmFormat(
      source.type ?? source.encodeType ?? source.format ?? song.type ?? song.encodeType
    ) ?? undefined

  return {
    format,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined,
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : undefined,
    size: Number.isFinite(size) && size > 0 ? size : undefined
  }
}

/**
 * 收集结构化歌手身份。name 与 id 必须成对同序输出：歌手页跳转按 id 打开，而
 * 展示串只能给出首位歌手的名字，两个数组一旦错位就会跳到另一位歌手身上。
 * 所以 name 为空的条目整体丢弃，id 缺失的条目保留（只留 name）占住位置。
 * `song.ar` 是 cloudsearch / song detail 的字段，老接口只给 `song.artists`。
 */
function normalizeTrackArtists(song) {
  const source =
    Array.isArray(song.ar) && song.ar.length > 0
      ? song.ar
      : Array.isArray(song.artists)
        ? song.artists
        : []
  const refs = []
  for (const item of source) {
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    if (!name) continue
    const id = Number(item?.id)
    refs.push(Number.isFinite(id) && id > 0 ? { id, name } : { name })
  }
  return refs
}

function normalizeTrack(song) {
  const songId = Number(song.id)
  const artistRefs = normalizeTrackArtists(song)
  // 展示串由 artistRefs 拼出，两者同源同序。结构化数组优先于遗留的 song.artist
  // 字符串，后者拿不到歌手 id，同名歌手就只能靠名字搜索去猜。
  const artist = artistRefs.map((item) => item.name).join(' / ') || song.artist || '未知艺术家'
  const title = song.name || song.title || '未知歌曲'
  const album = song.al?.name || song.album?.name || '未知专辑'
  const rawCover = song.al?.picUrl || song.album?.picUrl || song.picUrl || song.coverImgUrl || null
  const cover = normalizeRemoteAssetUrl(rawCover)
  const coverSmall = normalizeNcmCoverSize(rawCover, 140)
  const audioMeta = getSongAudioMeta(song)
  const bpm = normalizeBpm(song.bpm ?? song.tempo ?? song.mainSong?.bpm)

  const track = {
    id: `ncm:${songId}`,
    title,
    artist,
    album,
    filePath: `ncm:${songId}`,
    fileName: `${artist} - ${title}`,
    duration: formatDuration(song.dt ?? song.duration),
    size: audioMeta.size ?? 0,
    cover,
    coverSmall,
    lyrics: null,
    translatedLyrics: null,
    source: 'ncm',
    ncmSongId: songId,
    streamUrl: null,
    format: audioMeta.format,
    sampleRate: audioMeta.sampleRate,
    bitrate: audioMeta.bitrate
  }
  if (artistRefs.length > 0) track.artists = artistRefs
  if (bpm !== undefined) track.bpm = bpm
  return track
}

function rememberStreamAudioMeta(songId, item) {
  const format = normalizeNcmFormat(item.type ?? item.encodeType ?? item.format)
  const bitrate = Number(item.br ?? item.bitrate)
  const sampleRate = Number(item.sr ?? item.sampleRate)
  const size = Number(item.size)
  for (const tracks of playlistTrackCache.values()) {
    const track = tracks.find((candidate) => candidate.ncmSongId === songId)
    if (!track) continue
    if (format) track.format = format
    if (Number.isFinite(bitrate) && bitrate > 0) track.bitrate = bitrate
    if (Number.isFinite(sampleRate) && sampleRate > 0) track.sampleRate = sampleRate
    if (Number.isFinite(size) && size > 0) track.size = size
  }
  if (likedTracksCache) {
    const track = likedTracksCache.find((candidate) => candidate.ncmSongId === songId)
    if (!track) return
    if (format) track.format = format
    if (Number.isFinite(bitrate) && bitrate > 0) track.bitrate = bitrate
    if (Number.isFinite(sampleRate) && sampleRate > 0) track.sampleRate = sampleRate
    if (Number.isFinite(size) && size > 0) track.size = size
  }
}

function normalizePlaylist(playlist, ownerUid) {
  const creatorId = Number(playlist.userId ?? playlist.creator?.userId)
  const ownerId = Number(ownerUid)
  const owned =
    Number.isFinite(ownerId) && Number.isFinite(creatorId) ? creatorId === ownerId : undefined
  const rawCover = playlist.coverImgUrl || playlist.picUrl || null
  return {
    id: Number(playlist.id),
    name: playlist.name || '未命名歌单',
    cover: normalizePlaylistCoverUrl(rawCover),
    coverSmall: normalizeNcmCoverSize(rawCover, 140),
    trackCount: typeof playlist.trackCount === 'number' ? playlist.trackCount : 0,
    creatorName:
      typeof playlist.creator?.nickname === 'string'
        ? playlist.creator.nickname
        : typeof playlist.creatorName === 'string'
          ? playlist.creatorName
          : undefined,
    owned
  }
}

function normalizeAlbum(album) {
  const rawCover = album.picUrl || album.blurPicUrl || null
  return {
    id: Number(album.id),
    name: album.name || '未命名专辑',
    cover: normalizeRemoteAssetUrl(rawCover),
    coverSmall: normalizeNcmCoverSize(rawCover, 140),
    trackCount: typeof album.size === 'number' ? album.size : (album.songCount ?? 0),
    publishTime:
      typeof album.publishTime === 'number'
        ? album.publishTime
        : typeof album.publishTime === 'string'
          ? Number(album.publishTime)
          : undefined
  }
}

function normalizeArtist(item) {
  const rawPicUrl = item.picUrl || item.img1v1Url || item.avatarUrl || null
  return {
    id: Number(item.id),
    name: item.name || item.artistName || '未知歌手',
    picUrl: normalizeRemoteAssetUrl(rawPicUrl),
    picUrlSmall: normalizeNcmCoverSize(rawPicUrl, 140),
    albumSize: item.albumSize || 0,
    musicSize: item.musicSize || 0
  }
}

function getPlaylistItems(data) {
  if (Array.isArray(data.playlist)) return data.playlist
  // /api/playlist/list and /api/playlist/highquality/list use the plural key.
  if (Array.isArray(data.playlists)) return data.playlists
  if (Array.isArray(data.data?.playlist)) return data.data.playlist
  if (Array.isArray(data.data?.playlists)) return data.data.playlists
  return []
}

function getAlbumItems(data) {
  if (Array.isArray(data.hotAlbums)) return data.hotAlbums
  if (Array.isArray(data.albums)) return data.albums
  if (Array.isArray(data.data?.hotAlbums)) return data.data.hotAlbums
  if (Array.isArray(data.data?.albums)) return data.data.albums
  return []
}

function getArtistItems(data) {
  if (Array.isArray(data.artists)) return data.artists
  if (Array.isArray(data.data?.artists)) return data.data.artists
  if (Array.isArray(data.data)) return data.data
  if (Array.isArray(data.data?.data)) return data.data.data
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.data?.list)) return data.data.list
  return []
}

function getSongItems(data) {
  if (Array.isArray(data.songs)) return data.songs
  if (Array.isArray(data.data?.songs)) return data.data.songs
  if (Array.isArray(data.result?.songs)) return data.result.songs
  if (Array.isArray(data.data?.result?.songs)) return data.data.result.songs
  if (Array.isArray(data.playlist?.tracks)) return data.playlist.tracks
  if (Array.isArray(data.playlist?.songs)) return data.playlist.songs
  if (Array.isArray(data.data?.playlist?.tracks)) return data.data.playlist.tracks
  if (Array.isArray(data.data?.artist?.hotSongs)) return data.data.artist.hotSongs
  if (Array.isArray(data.artist?.hotSongs)) return data.artist.hotSongs
  if (Array.isArray(data.hotSongs)) return data.hotSongs
  if (Array.isArray(data.data)) return data.data
  return []
}

function getIntelligenceSongItems(data) {
  // 心动模式/智能播放接口返回 { data: { data: [song...], songInfo } }，
  // 兼容其余常见的歌曲列表结构，避免上游接口结构调整时丢失列表。
  const candidates = [
    data?.data?.data,
    data?.data?.songs,
    data?.data?.songList,
    data?.data,
    data?.songs
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return getSongItems(data)
}

function getPagedMoreFlag(data) {
  const candidates = [data?.more, data?.hasMore, data?.data?.more, data?.data?.hasMore]
  const value = candidates.find((candidate) => typeof candidate === 'boolean')
  return typeof value === 'boolean' ? value : undefined
}

async function fetchPagedItems({ makePath, getItems, limit = 100, maxPages = 100 }) {
  const items = []
  const seen = new Set()

  const appendPage = (pageItems, pageOffset) => {
    let added = 0
    for (const item of pageItems) {
      const key = String(item?.id ?? `${pageOffset}:${added}`)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
      added += 1
    }
    return added
  }

  const firstData = await requestAuthed(makePath(limit, 0))
  const firstItems = getItems(firstData)
  if (!Array.isArray(firstItems) || firstItems.length === 0 || appendPage(firstItems, 0) === 0) {
    return items
  }

  const firstHasMore = getPagedMoreFlag(firstData)
  if (firstHasMore === false || (firstItems.length < limit && firstHasMore !== true)) {
    return items
  }

  const pageSize = firstItems.length || limit
  const declaredTotal = getPagedTotal(firstData)
  const declaredPages = Math.min(maxPages, Math.ceil(declaredTotal / pageSize))
  const offsets = []
  for (
    let offset = pageSize;
    offsets.length < (declaredPages ?? maxPages) - 1;
    offset += pageSize
  ) {
    offsets.push(offset)
  }

  const fetchPage = async (offset) => {
    const data = await requestAuthed(makePath(limit, offset))
    const pageItems = getItems(data)
    return {
      offset,
      items: Array.isArray(pageItems) ? pageItems : [],
      hasMore: getPagedMoreFlag(data)
    }
  }

  if (declaredTotal == null) {
    let offset = pageSize
    while (offset < pageSize * maxPages) {
      const page = await fetchPage(offset)
      if (
        page.items.length === 0 ||
        appendPage(page.items, page.offset) === 0 ||
        page.hasMore === false ||
        (page.items.length < limit && page.hasMore !== true)
      )
        break
      offset += pageSize
    }
    return items
  }

  for (let index = 0; index < offsets.length; index += DETAIL_REQUEST_CONCURRENCY) {
    const wave = offsets.slice(index, index + DETAIL_REQUEST_CONCURRENCY)
    const pages = (await Promise.all(wave.map(fetchPage))).sort(
      (left, right) => left.offset - right.offset
    )
    let shouldContinue = true
    for (const page of pages) {
      if (page.items.length === 0 || appendPage(page.items, page.offset) === 0) {
        shouldContinue = false
        break
      }
      if (page.hasMore === false || (page.items.length < limit && page.hasMore !== true)) {
        shouldContinue = false
        break
      }
    }
    if (!shouldContinue) break
  }

  return items
}

function addPositiveId(target, value) {
  const normalized = Number(value)
  if (Number.isFinite(normalized) && normalized > 0) target.add(normalized)
}

function normalizeFollowed(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  return undefined
}

function mergePlaylists(...groups) {
  const seen = new Set()
  const merged = []
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const playlist of group) {
      const key = String(playlist?.id ?? '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(playlist)
    }
  }
  return merged
}

function getLikelistIds(data) {
  const rawIds = Array.isArray(data.ids)
    ? data.ids
    : Array.isArray(data.data?.ids)
      ? data.data.ids
      : []
  return rawIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
}

function getPlaylistTrackIds(data) {
  const rawTrackIds = Array.isArray(data.playlist?.trackIds)
    ? data.playlist.trackIds
    : Array.isArray(data.data?.playlist?.trackIds)
      ? data.data.playlist.trackIds
      : []
  return rawTrackIds
    .map((item) => Number(item?.id ?? item))
    .filter((id) => Number.isFinite(id) && id > 0)
}

function normalizePageNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function isLikedPlaylistItem(item) {
  return item.specialType === 5 || item.specialType === '5' || item.name === '喜欢的音乐'
}

async function fetchUserDetailInfo(userId) {
  try {
    const data = await requestAuthed(`/user/detail?uid=${userId}`)
    return {
      signature:
        data.profile?.signature || data.userPoint?.signature || data.data?.profile?.signature || '',
      follows: data.profile?.follows || 0,
      followeds: data.profile?.followeds || 0
    }
  } catch {
    return { signature: '', follows: 0, followeds: 0 }
  }
}

async function buildProfile(prof) {
  const detail =
    prof.signature === undefined || prof.follows === undefined
      ? await fetchUserDetailInfo(prof.userId)
      : null
  return {
    userId: prof.userId,
    nickname: prof.nickname,
    avatarUrl: normalizeRemoteAssetUrl(prof.avatarUrl),
    signature: prof.signature ?? detail?.signature ?? '',
    follows: prof.follows ?? detail?.follows ?? 0,
    followeds: prof.followeds ?? detail?.followeds ?? 0
  }
}

async function checkLogin() {
  try {
    const cookie = await getCookie()
    if (!cookie) {
      resetCaches()
      return { loggedIn: false, profile: null }
    }
    const cachedProfile = getCachedProfile()
    if (cachedProfile) return { loggedIn: true, profile: cachedProfile }
    const data = await request(`/login/status?timestamp=${Date.now()}`, cookie)
    const profileData = data.data?.profile || data.profile
    if ((data.data?.code === 200 || data.code === 200) && profileData) {
      const profile = await buildProfile({
        userId: profileData.userId,
        nickname: profileData.nickname,
        avatarUrl: profileData.avatarUrl,
        signature: profileData.signature
      })
      cachedUserId = profileData.userId
      cacheProfile(profile)
      return { loggedIn: true, profile }
    }
    await saveCookie('')
    resetCaches()
    return { loggedIn: false, profile: null }
  } catch {
    resetCaches()
    return { loggedIn: false, profile: null }
  }
}

async function getProfile() {
  return (await checkLogin()).profile
}

function cacheLyrics(songId, lyrics) {
  lyricsCache.delete(songId)
  lyricsCache.set(songId, lyrics)
  if (lyricsCache.size > LYRICS_CACHE_CAPACITY) {
    lyricsCache.delete(lyricsCache.keys().next().value)
  }
}

async function logout() {
  await saveCookie('')
  resetCaches()
}

async function openOfficialLogin() {
  const cookie = await ncmApi.officialLogin()
  if (!cookie || typeof cookie !== 'string' || !cookie.includes('MUSIC_U=')) {
    throw new Error('网易云官方登录未返回有效 Cookie')
  }
  await saveCookie(cookie)
  return await checkLogin()
}

function isPlaylistCreatedByUid(playlist, uid) {
  const ownerId = Number(playlist.userId ?? playlist.creator?.userId)
  const targetUid = Number(uid)
  return Number.isFinite(ownerId) && Number.isFinite(targetUid) && ownerId === targetUid
}

async function sendCaptcha(phone, countrycode = '86') {
  const normalizedPhone = requireNonEmptyString(phone, '手机号')
  const data = await request(
    `/captcha/sent?phone=${encodeURIComponent(normalizedPhone)}&ctcode=${encodeURIComponent(
      normalizeCountryCode(countrycode)
    )}`
  )
  const code = Number(data.code)
  if (code !== 200) {
    return { code: Number.isFinite(code) ? code : -1, message: describeApiError(code, data) }
  }
  return { code: 200, message: normalizeApiMessage(data, '验证码已发送') }
}

async function finishAccountLogin(data) {
  const cookie = assertSuccessfulLoginResponse(data)
  await saveCookie(cookie)
  return await checkLogin()
}

async function loginByPhonePassword(phone, password, countrycode = '86') {
  const normalizedPhone = requireNonEmptyString(phone, '手机号')
  const normalizedPassword = requireNonEmptyString(password, '密码')
  const data = await request(
    `/login/cellphone?phone=${encodeURIComponent(normalizedPhone)}&password=${encodeURIComponent(
      normalizedPassword
    )}&countrycode=${encodeURIComponent(normalizeCountryCode(countrycode))}`
  )
  return await finishAccountLogin(data)
}

async function loginByPhoneCaptcha(phone, captcha, countrycode = '86') {
  const normalizedPhone = requireNonEmptyString(phone, '手机号')
  const normalizedCaptcha = requireNonEmptyString(captcha, '验证码')
  const data = await request(
    `/login/cellphone?phone=${encodeURIComponent(normalizedPhone)}&captcha=${encodeURIComponent(
      normalizedCaptcha
    )}&countrycode=${encodeURIComponent(normalizeCountryCode(countrycode))}`
  )
  return await finishAccountLogin(data)
}

async function loginByEmailPassword(email, password) {
  const normalizedEmail = requireNonEmptyString(email, '邮箱')
  const normalizedPassword = requireNonEmptyString(password, '密码')
  const data = await request(
    `/login?email=${encodeURIComponent(normalizedEmail)}&password=${encodeURIComponent(normalizedPassword)}`
  )
  return await finishAccountLogin(data)
}

async function getQrKey() {
  const data = await request('/login/qr/key')
  return data.code === 200 && data.data?.unikey ? data.data.unikey : null
}

async function getQrImage(key) {
  const data = await request(
    withQrLoginParams(
      `/login/qr/create?key=${encodeURIComponent(String(key))}&platform=web&qrimg=true`
    )
  )
  if (data.code !== 200 || !data.data?.qrimg) return null
  const raw = data.data.qrimg
  return raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`
}

async function getQrLogin() {
  const key = await getQrKey()
  if (!key) return null
  const imageDataUrl = await getQrImage(key)
  return { key, imageDataUrl }
}

async function checkQrLogin(key) {
  const encodedKey = encodeURIComponent(String(key))
  let data = await request(withQrLoginParams(`/login/qr/check?key=${encodedKey}`))
  let code = Number(data.code)

  if (code === 502) {
    data = await request(withQrLoginParams(`/login/qr/check?key=${encodedKey}&noCookie=true`))
    code = Number(data.code)
  }

  if (TRANSIENT_LOGIN_ERROR_CODES.has(code)) {
    return {
      code,
      message: describeApiError(code, data),
      retryAfterSeconds: code === 503 || code === 460 ? 180 : 120
    }
  }

  if (code === 803 && data.cookie) {
    await saveCookie(data.cookie)
  }
  return {
    code: Number.isFinite(code) ? code : -1,
    message: Number.isFinite(code) ? undefined : normalizeApiMessage(data, '二维码登录状态异常')
  }
}

async function fetchUserLibrary(force = false) {
  if (force) {
    playlistTrackCache.clear()
    likedTracksCache = null
  }
  const currentProfile = await ensureProfile()
  const data = await requestAuthedRead(`/user/playlist?uid=${currentProfile.userId}&limit=1000`, {
    attempts: 3,
    label: 'user playlists'
  })
  const items = getPlaylistItems(data)
  const likedItem = items.find(isLikedPlaylistItem) ?? null
  const nextOwned = new Set()
  for (const item of items) {
    if (isPlaylistCreatedByUid(item, currentProfile.userId) && !isLikedPlaylistItem(item)) {
      nextOwned.add(Number(item.id))
    }
  }
  ownedPlaylistIds = nextOwned
  return {
    likedPlaylist: likedItem ? normalizePlaylist(likedItem, currentProfile.userId) : null,
    playlists: items
      .filter((item) => Number(item.id) !== Number(likedItem?.id))
      .map((item) => normalizePlaylist(item, currentProfile.userId))
  }
}

async function fetchSongDetailsByIds(ids, label) {
  const chunkSize = 100
  const chunks = []
  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize))
  }
  const songs = await mapWithConcurrency(chunks, DETAIL_REQUEST_CONCURRENCY, (chunk, index) => {
    const startIndex = index * chunkSize
    const endIndex = startIndex + chunk.length - 1
    return fetchSongDetailChunk(chunk, `${label} ${startIndex}-${endIndex}`)
  })
  return songs.flat()
}

async function fetchSongDetailChunk(ids, label) {
  if (ids.length === 0) return []
  try {
    const detail = await requestOptionalAuthRead(`/song/detail?ids=${ids.join(',')}`, {
      attempts: 3,
      label: `${label} song detail`
    })
    return getSongItems(detail)
  } catch (error) {
    if (ids.length > 25) {
      const middle = Math.ceil(ids.length / 2)
      const left = await fetchSongDetailChunk(ids.slice(0, middle), `${label}a`)
      const right = await fetchSongDetailChunk(ids.slice(middle), `${label}b`)
      return [...left, ...right]
    }
    getContext().logger.warn(`网易云歌曲详情分片跳过：${label}：${getErrorMessage(error)}`)
    return []
  }
}

async function fetchPlaylistTracksViaTrackAll(playlistId) {
  const songs = []
  const seen = new Set()
  let offset = 0

  while (songs.length < MAX_PLAYLIST_TRACKS) {
    const remaining = MAX_PLAYLIST_TRACKS - songs.length
    const limit = Math.min(PLAYLIST_TRACK_PAGE_SIZE, remaining)
    let pageSongs = []
    try {
      const trackAllData = await requestOptionalAuthRead(
        `/playlist/track/all?id=${encodeURIComponent(String(playlistId))}&limit=${limit}&offset=${offset}`,
        { attempts: 3, label: `playlist ${playlistId} track/all ${offset}` }
      )
      pageSongs = getSongItems(trackAllData)
    } catch (error) {
      if (songs.length > 0) {
        getContext().logger.warn(
          `网易云歌单 track/all 分页中断（已取 ${songs.length} 首）：${getErrorMessage(error)}`
        )
        break
      }
      throw error
    }
    if (!Array.isArray(pageSongs) || pageSongs.length === 0) break

    let added = 0
    for (const song of pageSongs) {
      const key = Number(song?.id)
      const dedupeKey = Number.isFinite(key) && key > 0 ? key : `idx:${offset + added}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      songs.push(song)
      added += 1
      if (songs.length >= MAX_PLAYLIST_TRACKS) break
    }

    if (added === 0 || pageSongs.length < limit) break
    offset += pageSongs.length
  }

  return songs
}

async function fetchPlaylistTracksViaDetail(playlistId) {
  const detailData = await requestOptionalAuthRead(
    `/playlist/detail?id=${encodeURIComponent(String(playlistId))}`,
    { attempts: 3, label: `playlist ${playlistId} detail` }
  )
  const ids = getPlaylistTrackIds(detailData)
  if (ids.length > 0) {
    return fetchSongDetailsByIds(ids.slice(0, MAX_PLAYLIST_TRACKS), `playlist ${playlistId}`)
  }
  // playlist.tracks is often truncated (~200); only use it when trackIds are absent.
  return getSongItems(detailData).slice(0, MAX_PLAYLIST_TRACKS)
}

async function fetchPlaylistTracks(playlistId, force = false) {
  const cacheKey = String(playlistId)
  if (!force && playlistTrackCache.has(cacheKey)) return playlistTrackCache.get(cacheKey) ?? []

  let songs = []
  try {
    songs = await fetchPlaylistTracksViaTrackAll(playlistId)
  } catch (error) {
    getContext().logger.warn(
      `网易云歌单 track/all 分页失败，将回退 detail：${getErrorMessage(error)}`
    )
    songs = []
  }

  if (songs.length === 0) {
    try {
      songs = await fetchPlaylistTracksViaDetail(playlistId)
    } catch {
      songs = []
    }
  }

  const tracks = songs.slice(0, MAX_PLAYLIST_TRACKS).map(normalizeTrack)
  playlistTrackCache.set(cacheKey, tracks)
  return tracks
}

async function fetchLikedTracks(force = false) {
  if (!force && likedTracksCache) return likedTracksCache

  let library = { likedPlaylist: null, playlists: [] }
  try {
    library = await fetchUserLibrary(force)
  } catch (error) {
    getContext().logger.warn(
      `网易云音乐库列表读取失败，将尝试 likelist 兜底：${getErrorMessage(error)}`
    )
  }

  if (library.likedPlaylist) {
    const tracks = await fetchPlaylistTracks(library.likedPlaylist.id, force)
    if (tracks.length > 0) {
      likedTracksCache = tracks
      syncLikedIds(tracks)
      return tracks
    }
  }

  const currentProfile = await ensureProfile()
  let data = null
  try {
    data = await requestAuthedRead(`/likelist?uid=${currentProfile.userId}`, {
      attempts: 3,
      label: 'liked song ids'
    })
  } catch (error) {
    getContext().logger.warn(`网易云喜欢歌曲 ID 读取失败：${getErrorMessage(error)}`)
    likedTracksCache = likedTracksCache ?? []
    return likedTracksCache
  }

  const ids = getLikelistIds(data)
  if (ids.length === 0) {
    likedTracksCache = []
    likedSongIdListCache = []
    replaceLikedSongIds([])
    return []
  }
  replaceLikedSongIds(ids)

  const songs = await fetchSongDetailsByIds(ids, 'liked songs')

  const normalized = songs.map(normalizeTrack)
  const trackBySongId = new Map()
  for (const track of normalized) {
    if (track.ncmSongId) trackBySongId.set(track.ncmSongId, track)
  }

  likedTracksCache = ids.map((id) => trackBySongId.get(id)).filter(Boolean)
  if (likedTracksCache.length === 0) likedTracksCache = normalized
  syncLikedIds(likedTracksCache)
  return likedTracksCache
}

async function fetchIntelligenceList(options = {}) {
  const songId = Number(options?.songId)
  const playlistId = Number(options?.playlistId)
  if (!Number.isFinite(songId) || songId <= 0 || !Number.isFinite(playlistId) || playlistId <= 0) {
    throw new Error('心动模式需要有效的歌曲 ID 与歌单 ID')
  }
  const startSongId = Number(options?.startSongId)
  const requestedCount = Number(options?.count)
  const path = appendQueryParams('/playmode/intelligence/list', {
    id: songId,
    pid: playlistId,
    sid: Number.isFinite(startSongId) && startSongId > 0 ? startSongId : songId,
    count: Number.isFinite(requestedCount) && requestedCount > 0 ? Math.min(50, requestedCount) : 20
  })
  const data = await requestAuthedRead(path, {
    attempts: 2,
    label: `心动模式智能播放列表 ${songId}`
  })
  const items = getIntelligenceSongItems(data)
  const tracks = items
    .map((item) => {
      // 心动模式列表项是推荐包装：{ id, alg, recommended, songInfo }，
      // 歌曲元数据（name/ar/al/封面）位于 item.songInfo 内。
      // 少数条目 songInfo 为 null 且没有顶层歌曲字段，直接跳过。
      const song =
        item && typeof item === 'object' && item.songInfo && typeof item.songInfo === 'object'
          ? item.songInfo
          : item &&
              typeof item === 'object' &&
              item.songInfo === null &&
              typeof item.name !== 'string'
            ? null
            : item
      if (!song) return null
      try {
        return normalizeTrack(song)
      } catch {
        return null
      }
    })
    .filter(
      (track) =>
        track &&
        Number.isFinite(track.ncmSongId) &&
        track.ncmSongId > 0 &&
        (track.title ?? '') !== '未知歌曲'
    )
  return tracks
}

async function fetchLikedTrackIds(force = false) {
  if (!force && likedSongIdListCache && likedSongIdListCache.length > 0) {
    // The raw /likelist refresh keeps `likedSongIds` live for like-state checks
    // but must never replace the ORDER cache: its order differs from the liked
    // playlist order and would scramble the playlist page. Detect a recently
    // liked/unliked song and refresh the ordered list instead of returning a
    // stale one.
    const cachedIds = new Set(likedSongIdListCache)
    const missingFromCache = [...likedSongIds].some((id) => !cachedIds.has(id))
    const removedFromSet = likedSongIdListCache.some((id) => !likedSongIds.has(id))
    if (!missingFromCache && !removedFromSet) return likedSongIdListCache
  }

  try {
    const library = await fetchUserLibrary(force)
    if (library.likedPlaylist) {
      const detailData = await requestAuthedRead(
        `/playlist/detail?id=${encodeURIComponent(String(library.likedPlaylist.id))}`,
        { attempts: 3, label: `liked playlist ${library.likedPlaylist.id} detail` }
      )
      const ids = getPlaylistTrackIds(detailData)
      likedSongIdListCache = ids
      replaceLikedSongIds(ids)
      return ids
    }
  } catch (error) {
    getContext().logger.warn(
      `网易云喜欢歌单详情读取失败，将尝试 likelist 兜底：${getErrorMessage(error)}`
    )
  }

  const currentProfile = await ensureProfile()
  try {
    const data = await requestAuthedRead(`/likelist?uid=${currentProfile.userId}`, {
      attempts: 3,
      label: 'liked song ids'
    })
    const ids = getLikelistIds(data)
    if (ids.length > 0) {
      replaceLikedSongIds(ids)
      return ids
    }
  } catch (error) {
    getContext().logger.warn(`网易云喜欢歌曲 ID 读取失败：${getErrorMessage(error)}`)
  }

  likedSongIdListCache = []
  replaceLikedSongIds([])
  return []
}

async function fetchLikedTracksPage(offset = 0, limit = 100, force = false) {
  const normalizedOffset = normalizePageNumber(offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const normalizedLimit = normalizePageNumber(limit, 100, 1, 200)
  const ids = await fetchLikedTrackIds(force && normalizedOffset === 0)
  const pageIds = ids.slice(normalizedOffset, normalizedOffset + normalizedLimit)
  const songs = await fetchSongDetailsByIds(pageIds, `liked songs ${normalizedOffset}`)
  const normalized = songs.map(normalizeTrack)
  const trackBySongId = new Map()
  for (const track of normalized) {
    if (track.ncmSongId) trackBySongId.set(track.ncmSongId, track)
  }
  const tracks = pageIds.map((id) => trackBySongId.get(id)).filter(Boolean)
  const nextOffset = Math.min(ids.length, normalizedOffset + normalizedLimit)
  return {
    tracks,
    total: ids.length,
    offset: normalizedOffset,
    limit: normalizedLimit,
    nextOffset,
    hasMore: nextOffset < ids.length
  }
}

function normalizeCloudSong(item) {
  const cloudSongId = item?.songId ?? item?.id
  const rawSong = item?.simpleSong ?? item?.song ?? item
  const playbackSongId = rawSong?.id ?? cloudSongId
  const numericPlaybackSongId = Number(playbackSongId)
  if (
    cloudSongId == null ||
    !Number.isFinite(numericPlaybackSongId) ||
    numericPlaybackSongId <= 0
  ) {
    return null
  }

  const track = normalizeTrack({
    ...rawSong,
    id: numericPlaybackSongId,
    name: rawSong?.name ?? item?.songName,
    artist: rawSong?.artist ?? item?.artist,
    album: rawSong?.album ?? (item?.album ? { name: item.album } : undefined),
    size: rawSong?.size ?? item?.fileSize,
    bitrate: rawSong?.bitrate ?? item?.bitrate,
    type: rawSong?.type ?? item?.fileName?.split('.').pop()
  })
  const fileName =
    typeof item?.fileName === 'string' && item.fileName.trim()
      ? item.fileName.trim()
      : `${track.artist} - ${track.title}`
  const addTime = Number(item?.addTime)
  return {
    cloudSongId,
    songId: numericPlaybackSongId,
    fileName,
    ...(Number.isFinite(addTime) && addTime > 0 ? { addTime } : {}),
    track
  }
}

async function fetchCloudSongsPage(offset = 0, limit = 50, requestContext) {
  const normalizedOffset = normalizePageNumber(offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const normalizedLimit = normalizePageNumber(limit, 50, 1, 200)
  const data = await requestAuthed(
    `/user/cloud?limit=${normalizedLimit}&offset=${normalizedOffset}`,
    requestContext
  )
  const rawItems = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.data?.data)
      ? data.data.data
      : []
  const items = rawItems.map(normalizeCloudSong).filter(Boolean)
  const declaredTotal = Number(data?.count ?? data?.data?.count)
  const total = Number.isFinite(declaredTotal)
    ? Math.max(0, Math.floor(declaredTotal))
    : normalizedOffset + rawItems.length
  const explicitHasMore = [data?.hasMore, data?.data?.hasMore].find(
    (value) => typeof value === 'boolean'
  )
  const nextOffset = normalizedOffset + rawItems.length
  return {
    items,
    total,
    offset: normalizedOffset,
    limit: normalizedLimit,
    nextOffset,
    hasMore:
      typeof explicitHasMore === 'boolean'
        ? explicitHasMore
        : rawItems.length >= normalizedLimit && nextOffset < total
  }
}

function assertCloudApiSuccess(data, fallback) {
  const code = Number(data?.code ?? data?.body?.code)
  if (Number.isFinite(code) && code !== 200) {
    throw new Error(normalizeApiMessage(data?.body ?? data, fallback))
  }
}

function normalizeCloudUploadPreparation(data, input) {
  assertCloudApiSuccess(data, '获取云盘上传凭证失败')
  const payload = data?.data ?? data?.body?.data
  const songId = payload?.songId
  const resourceId = payload?.resourceId
  const needUpload = payload?.needUpload === true
  if (songId == null || resourceId == null) {
    throw new Error('网易云上传凭证响应缺少 songId 或 resourceId')
  }
  if (needUpload && (!payload?.uploadToken || !payload?.uploadUrl)) {
    throw new Error('网易云上传凭证响应缺少 uploadToken 或 uploadUrl')
  }
  const uploadUrl = needUpload ? normalizePlaybackStreamUrl(payload.uploadUrl) : ''
  if (needUpload && !uploadUrl) throw new Error('网易云上传地址不是有效的 HTTP(S) URL')
  return {
    needUpload,
    songId,
    uploadToken: needUpload ? String(payload.uploadToken) : '',
    uploadUrl,
    resourceId: String(resourceId),
    md5: String(payload?.md5 ?? input.md5),
    fileSize: Number(payload?.fileSize ?? input.fileSize),
    filename: String(payload?.filename ?? input.filename)
  }
}

async function prepareCloudUpload(input, requestContext) {
  const md5 = typeof input?.md5 === 'string' ? input.md5.trim().toLowerCase() : ''
  const fileSize = Number(input?.fileSize)
  const filename = typeof input?.filename === 'string' ? input.filename.trim() : ''
  const bitrate = normalizePageNumber(input?.bitrate, 999000, 1, 10_000_000)
  if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error('云盘上传 MD5 无效')
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('云盘上传文件大小无效')
  if (!filename || filename.length > 255) throw new Error('云盘上传文件名无效')
  const path = appendQueryParams('/cloud/upload/token', { md5, fileSize, filename, bitrate })
  const data = await requestAuthed(path, requestContext)
  return normalizeCloudUploadPreparation(data, { md5, fileSize, filename })
}

async function completeCloudUpload(input, requestContext) {
  const required = ['songId', 'resourceId', 'md5', 'filename']
  for (const key of required) {
    if (input?.[key] == null || String(input[key]).trim() === '') {
      throw new Error(`云盘上传完成参数缺少 ${key}`)
    }
  }
  const params = {
    songId: input.songId,
    resourceId: input.resourceId,
    md5: input.md5,
    filename: input.filename,
    ...(input.song ? { song: input.song } : {}),
    ...(input.artist ? { artist: input.artist } : {}),
    ...(input.album ? { album: input.album } : {}),
    ...(input.bitrate ? { bitrate: input.bitrate } : {})
  }
  return runIdempotentProviderWrite('completeCloudUpload', [params], requestContext, async () => {
    const data = await requestAuthed(
      appendQueryParams('/cloud/upload/complete', params),
      requestContext
    )
    assertCloudApiSuccess(data, '导入网易云云盘失败')
    return { songId: input.songId }
  })
}

function extractCloudDownloadUrl(data) {
  const candidates = [data?.data?.url, data?.url, data?.body?.data?.url, data?.data?.data?.url]
  for (const candidate of candidates) {
    const normalized = normalizePlaybackStreamUrl(candidate)
    if (normalized) return normalized
  }
  return null
}

async function getCloudDownloadUrl(cloudSongId, requestContext) {
  if (cloudSongId == null || !String(cloudSongId).trim()) throw new Error('云盘歌曲 ID 无效')
  const data = await requestAuthed(
    `/song/cloud/download?id=${encodeURIComponent(String(cloudSongId))}`,
    requestContext
  )
  assertCloudApiSuccess(data, '获取云盘下载地址失败')
  const url = extractCloudDownloadUrl(data)
  if (!url) throw new Error('网易云下载响应缺少有效的 HTTP(S) URL')
  return url
}

function getSongIdFromTrack(track) {
  if (track?.ncmSongId != null) return Number(track.ncmSongId)
  if (typeof track?.id !== 'string' || !track.id.startsWith('ncm:')) return null
  const songId = Number(track.id.slice('ncm:'.length))
  return Number.isFinite(songId) && songId > 0 ? songId : null
}

function normalizePlaybackQuality(value) {
  return typeof value === 'string' && value in NCM_PLAYBACK_QUALITY_FALLBACKS ? value : 'auto'
}

function getPlaybackQualityFallbacks(quality) {
  return NCM_PLAYBACK_QUALITY_FALLBACKS[normalizePlaybackQuality(quality)]
}

function getPlaybackUrlRequestPaths(songId, quality) {
  const encodedId = encodeURIComponent(String(songId))
  const levelPaths = getPlaybackQualityFallbacks(quality).map(
    (level) => `/song/url/v1?id=${encodedId}&level=${encodeURIComponent(level)}&encodeType=flac`
  )
  // Classic bitrate endpoints remain as a compatibility fallback when the
  // level-based player API returns no official URL for the signed-in account.
  const bitratePaths = [
    `/song/url?id=${encodedId}&br=999000`,
    `/song/url?id=${encodedId}&br=320000`,
    `/song/url?id=${encodedId}&br=128000`
  ]
  return [...levelPaths, ...bitratePaths]
}

function getUnblockedPlaybackUrlPath(songId) {
  return `/song/url/match?id=${encodeURIComponent(String(songId))}`
}

function getPlaybackStreamItems(data) {
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.urls)) return data.urls
  if (Array.isArray(data?.url)) return data.url
  return []
}

function getPlaybackFailureMessage(data, streamItem) {
  const message = streamItem?.msg ?? streamItem?.message ?? data?.msg ?? data?.message
  return typeof message === 'string' && message.trim() ? message.trim() : ''
}

function normalizePlaybackStreamUrl(url) {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed) return null
  // NetEase occasionally returns protocol-relative stream hosts.
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return null
}

function getOfficialPlaybackUrl(data, streamItem) {
  // Prefer per-item status, but only reject concrete non-200 values. Some
  // successful payloads omit item.code and only provide a stream url.
  const itemCode = Number(streamItem?.code)
  if (Number.isFinite(itemCode) && itemCode !== 200) return null
  const topCode = Number(data?.code)
  if (Number.isFinite(topCode) && topCode !== 200 && !Number.isFinite(itemCode)) return null
  return normalizePlaybackStreamUrl(streamItem?.url)
}

function getUnblockedPlaybackUrl(data) {
  const topCode = Number(data?.code ?? data?.body?.code)
  if (!Number.isFinite(topCode) || topCode !== 200) return null

  // `/song/url/match` documents data as the matched URL string. Retain
  // defensive compatibility for wrapped payloads and the optional proxy URL.
  const candidates = [
    data?.data,
    data?.data?.url,
    data?.body?.data,
    data?.body?.data?.url,
    data?.proxyUrl,
    data?.body?.proxyUrl
  ]
  for (const candidate of candidates) {
    const url = normalizePlaybackStreamUrl(candidate)
    if (url) return url
  }
  return null
}

function rememberStreamUrl(cacheKey, url) {
  streamUrlCache.set(cacheKey, { url, expiresAt: Date.now() + STREAM_URL_CACHE_TTL_MS })
}

async function getPlaybackUrl(track, options = {}, requestContext) {
  const songId = getSongIdFromTrack(track)
  if (songId == null) throw new Error('Missing NetEase song ID, cannot play')
  const force = options?.force === true
  const quality = normalizePlaybackQuality(options?.quality)
  const cacheKey = `${songId}:${quality}`

  // Basic cache-on-play: prefer a completed disk file so repeat plays skip the
  // network. Host gates this with cachePolicy.streamingAudio; force always refreshes.
  if (!force && typeof ncmApi?.getCachedSong === 'function') {
    try {
      const cachedPath = await ncmApi.getCachedSong(songId)
      if (typeof cachedPath === 'string' && cachedPath.trim()) return cachedPath
    } catch {
      // A failed cache probe never blocks online resolution.
    }
  }

  const cachedStreamEntry = force ? null : streamUrlCache.get(cacheKey)
  if (cachedStreamEntry) {
    if (cachedStreamEntry.expiresAt > Date.now()) return cachedStreamEntry.url
    streamUrlCache.delete(cacheKey)
  }

  let lastFailureMessage = ''
  let riskControlMessage = ''
  const requestPaths = getPlaybackUrlRequestPaths(songId, quality)
  for (let attempt = 0; attempt < requestPaths.length; attempt += 1) {
    // 回退阶梯步间退避（250ms 起步、封顶 500ms）：连续失败的连打既放大风控
    // 概率也让低级音质的响应无意义地挤占带宽（批量 8.5）。
    if (attempt > 0) {
      await waitWithAbort(Math.min(500, 250 * attempt), requestContext?.signal)
    }
    const path = requestPaths[attempt]
    try {
      const data = await requestAuthed(path, requestContext)
      const streamItems = getPlaybackStreamItems(data)
      const streamItem = streamItems[0] ?? {}
      // Only use a URL explicitly authorized by the signed-in account's official endpoint.
      const url = getOfficialPlaybackUrl(data, streamItem)
      if (url) {
        rememberStreamAudioMeta(songId, streamItem)
        rememberStreamUrl(cacheKey, url)
        void ncmApi.cacheSong(songId, url, track?.fileName).catch(() => {})
        return url
      }
      lastFailureMessage = getPlaybackFailureMessage(data, streamItem) || lastFailureMessage
    } catch (error) {
      throwIfRequestAborted(requestContext)
      lastFailureMessage = getErrorMessage(error)
    }
    // 风控提示命中即终止整条阶梯：继续连打只会加深风控（批量 8.5）。
    if (isRiskControlMessage(lastFailureMessage)) {
      riskControlMessage = lastFailureMessage
      break
    }
  }

  // 风控命中后连灰色解锁也不再试——它同样是上游请求，会把风控窗口越拉越长。
  if (!riskControlMessage) {
    try {
      const data = await requestAuthed(getUnblockedPlaybackUrlPath(songId), requestContext)
      const url = getUnblockedPlaybackUrl(data)
      if (url) {
        rememberStreamUrl(cacheKey, url)
        void ncmApi.cacheSong(songId, url, track?.fileName).catch(() => {})
        return url
      }
      lastFailureMessage =
        getPlaybackFailureMessage(data, {}) || '灰色歌曲解锁响应缺少有效的 HTTP(S) URL'
    } catch (error) {
      throwIfRequestAborted(requestContext)
      lastFailureMessage = getErrorMessage(error)
    }
  }

  if (riskControlMessage) {
    getContext().logger.warn(`网易云播放地址解析命中风控，已提前终止回退：${riskControlMessage}`)
  } else if (lastFailureMessage) {
    getContext().logger.warn(`网易云播放地址解析失败：${lastFailureMessage}`)
  }
  return null
}

async function fetchRecommendSongs() {
  const data = await requestAuthed('/recommend/songs')
  const dailySongs = Array.isArray(data.data?.dailySongs)
    ? data.data.dailySongs
    : Array.isArray(data.dailySongs)
      ? data.dailySongs
      : []
  if (dailySongs.length > 0) return dailySongs.map(normalizeTrack)
  return getSongItems(data).map(normalizeTrack)
}

function getPersonalFmItems(data) {
  if (Array.isArray(data.data)) return data.data
  if (Array.isArray(data.result)) return data.result
  return getSongItems(data)
}

function appendUniqueSongs(target, seen, songs) {
  let added = 0
  for (const song of songs) {
    const songId = Number(song?.id)
    if (!Number.isFinite(songId) || songId <= 0 || seen.has(songId)) continue
    seen.add(songId)
    target.push(song)
    added += 1
    if (target.length >= PERSONAL_FM_TARGET_TRACKS) break
  }
  return added
}

async function fetchPersonalFm() {
  const songs = []
  try {
    const data = await requestAuthed(
      `/personal/fm/mode?mode=DEFAULT&limit=${PERSONAL_FM_TARGET_TRACKS}`
    )
    appendUniqueSongs(songs, personalFmSeenSongIds, getPersonalFmItems(data))
  } catch (error) {
    getContext().logger.warn(`网易云私人漫游批量接口失败，将回退经典 FM：${getErrorMessage(error)}`)
  }

  for (
    let batch = 0;
    songs.length < PERSONAL_FM_TARGET_TRACKS && batch < PERSONAL_FM_MAX_FALLBACK_BATCHES;
    batch += 1
  ) {
    const data = await requestAuthed('/personal_fm')
    appendUniqueSongs(songs, personalFmSeenSongIds, getPersonalFmItems(data))
  }
  return songs.map(normalizeTrack)
}

async function fetchPrivateContent() {
  return fetchPlaylistTracks(PERSONAL_RADAR_PLAYLIST_ID, true)
}

async function fetchRecommendPlaylists() {
  try {
    const data = await requestAuthed('/recommend/resource')
    const recommend = Array.isArray(data.recommend)
      ? data.recommend
      : Array.isArray(data.data)
        ? data.data
        : []
    return recommend.map((item) => ({
      id: Number(item.id),
      name: item.name || '未命名歌单',
      cover: normalizePlaylistCoverUrl(item.picUrl || item.coverImgUrl || null),
      coverSmall: normalizeNcmCoverSize(item.picUrl || item.coverImgUrl || null, 140),
      trackCount: item.trackCount || 0
    }))
  } catch {
    return []
  }
}

function getCatalogueSubItems(data) {
  if (Array.isArray(data.sub)) return data.sub
  if (Array.isArray(data.data?.sub)) return data.data.sub
  return []
}

function getCatalogueCategoryMap(data) {
  const categories = data.categories ?? data.data?.categories
  return categories && typeof categories === 'object' ? categories : {}
}

function getHotTagNames(data) {
  const tags = Array.isArray(data.tags)
    ? data.tags
    : Array.isArray(data.data?.tags)
      ? data.data.tags
      : []
  return tags.map((tag) => tag?.name).filter((name) => typeof name === 'string' && name.trim())
}

function normalizeDiscoveryPlaylist(item) {
  const playCount = Number(item.playCount ?? item.playcount)
  const summary = normalizePlaylist(item)
  if (Number.isFinite(playCount) && playCount > 0) summary.playCount = playCount
  return summary
}

async function fetchPlaylistCategories() {
  if (playlistCatalogueCache) return playlistCatalogueCache
  const [catData, hotData] = await Promise.all([
    requestOptionalAuthRead('/playlist/catlist', { attempts: 3, label: 'playlist catlist' }),
    requestOptionalAuthRead('/playlist/hot', { label: 'playlist hot tags' }).catch(() => ({}))
  ])

  const categoryMap = getCatalogueCategoryMap(catData)
  const subItems = getCatalogueSubItems(catData)
  const groups = Object.entries(categoryMap)
    .map(([id, name]) => ({
      id: Number(id),
      name: typeof name === 'string' ? name : String(name ?? ''),
      tags: subItems
        .filter((item) => Number(item?.category) === Number(id) && typeof item?.name === 'string')
        .map((item) => ({ name: item.name, hot: item.hot === true }))
    }))
    .filter((group) => group.name && group.tags.length > 0)

  let hotTags = getHotTagNames(hotData)
  if (hotTags.length === 0) {
    hotTags = subItems
      .filter((item) => item?.hot === true && typeof item?.name === 'string')
      .map((item) => item.name)
  }

  const result = { hotTags, groups }
  playlistCatalogueCache = result
  return result
}

async function fetchDiscoveryPlaylists(cat = '全部', order = 'hot', limit = 30, offset = 0) {
  const normalizedCat = typeof cat === 'string' && cat.trim() ? cat.trim() : '全部'
  const normalizedOrder = order === 'new' ? 'new' : 'hot'
  const normalizedLimit = normalizePageNumber(limit, 30, 1, 100)
  const normalizedOffset = normalizePageNumber(offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const data = await requestOptionalAuthRead(
    `/top/playlist?cat=${encodeURIComponent(normalizedCat)}&order=${normalizedOrder}&limit=${normalizedLimit}&offset=${normalizedOffset}`,
    { attempts: 3, label: `top playlists ${normalizedCat} ${normalizedOffset}` }
  )
  const items = getPlaylistItems(data).map(normalizeDiscoveryPlaylist)
  const total = typeof data.total === 'number' ? data.total : normalizedOffset + items.length
  const more = getPagedMoreFlag(data)
  return {
    items,
    total,
    hasMore: typeof more === 'boolean' ? more : normalizedOffset + items.length < total,
    offset: normalizedOffset,
    limit: normalizedLimit
  }
}

async function fetchHighQualityPlaylists(cat = '全部', limit = 30, before = 0) {
  const normalizedCat = typeof cat === 'string' && cat.trim() ? cat.trim() : '全部'
  const normalizedLimit = normalizePageNumber(limit, 30, 1, 100)
  const normalizedBefore = Number(before)
  const beforeParam =
    Number.isFinite(normalizedBefore) && normalizedBefore > 0 ? `&before=${normalizedBefore}` : ''
  const data = await requestOptionalAuthRead(
    `/top/playlist/highquality?cat=${encodeURIComponent(normalizedCat)}&limit=${normalizedLimit}${beforeParam}`,
    { attempts: 3, label: `highquality playlists ${normalizedCat}` }
  )
  const rawItems = getPlaylistItems(data)
  const lastUpdateTime = Number(rawItems[rawItems.length - 1]?.updateTime)
  const lasttime = Number(data.lasttime ?? data.data?.lasttime)
  return {
    items: rawItems.map(normalizeDiscoveryPlaylist),
    total: typeof data.total === 'number' ? data.total : rawItems.length,
    hasMore: getPagedMoreFlag(data) === true,
    lasttime:
      Number.isFinite(lasttime) && lasttime > 0
        ? lasttime
        : Number.isFinite(lastUpdateTime) && lastUpdateTime > 0
          ? lastUpdateTime
          : 0
  }
}

function extractLyricText(data, key) {
  return data[key]?.lyric || data.data?.[key]?.lyric || null
}

function waitWithAbort(ms, signal) {
  if (!signal) return wait(ms)
  throwIfRequestAborted({ signal })
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Provider request was cancelled')
      )
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function assertLyricsEndpointSuccess(data, endpoint) {
  const code = Number(data?.code ?? data?.body?.code)
  if (Number.isFinite(code) && code !== 200) {
    throw new Error(
      `${endpoint} returned NetEase code ${code}: ${normalizeApiMessage(data, 'lyrics request failed')}`
    )
  }
}

async function getLegacyLyrics(songId, requestContext) {
  const legacy = await requestOptionalAuthRead(`/lyric?id=${songId}`, {
    attempts: 2,
    label: `legacy lyrics ${songId}`,
    signal: requestContext?.signal
  })
  assertLyricsEndpointSuccess(legacy, '/lyric')
  return {
    lyrics: extractLyricText(legacy, 'lrc'),
    translatedLyrics: extractLyricText(legacy, 'tlyric'),
    wordLyrics: null
  }
}

async function getLyrics(track, requestContext) {
  const songId = getSongIdFromTrack(track)
  if (songId == null) return { lyrics: null, translatedLyrics: null, wordLyrics: null }
  const cachedLyrics = lyricsCache.get(songId)
  if (cachedLyrics) return cachedLyrics
  let data
  try {
    data = await requestOptionalAuthRead(`/lyric/new?id=${songId}`, {
      attempts: 3,
      label: `lyrics ${songId}`,
      signal: requestContext?.signal
    })
    assertLyricsEndpointSuccess(data, '/lyric/new')
  } catch {
    throwIfRequestAborted(requestContext)
    return getLegacyLyrics(songId, requestContext)
  }
  const yrc = extractLyricText(data, 'yrc')
  const lrc = extractLyricText(data, 'lrc')
  const translatedLyrics = extractLyricText(data, 'tlyric')
  // Prefer YRC as the timed display payload when available (word-level timings).
  if (yrc || lrc || translatedLyrics) {
    const lyrics = {
      lyrics: yrc || lrc,
      translatedLyrics,
      wordLyrics: yrc || null
    }
    cacheLyrics(songId, lyrics)
    return lyrics
  }
  return getLegacyLyrics(songId, requestContext)
}

async function searchSongs(keywords, limit = 30, offset = 0) {
  const data = await requestOptionalAuth(
    `/cloudsearch?keywords=${encodeURIComponent(keywords)}&type=1&limit=${limit}&offset=${offset}`
  )
  const result = data.result || data.data?.result || {}
  const songs = Array.isArray(result.songs) ? result.songs : []
  const total = typeof result.songCount === 'number' ? result.songCount : songs.length
  return { items: songs.map(normalizeTrack), total }
}

async function searchPlaylists(keywords, limit = 30, offset = 0) {
  const data = await requestAuthed(
    `/cloudsearch?keywords=${encodeURIComponent(keywords)}&type=1000&limit=${limit}&offset=${offset}`
  )
  const result = data.result || data.data?.result || {}
  const playlists = Array.isArray(result.playlists) ? result.playlists : []
  const total = typeof result.playlistCount === 'number' ? result.playlistCount : playlists.length
  return { items: playlists.map(normalizePlaylist), total }
}

async function searchArtists(keywords, limit = 30, offset = 0) {
  const data = await requestAuthed(
    `/cloudsearch?keywords=${encodeURIComponent(keywords)}&type=100&limit=${limit}&offset=${offset}`
  )
  const result = data.result || data.data?.result || {}
  const artists = Array.isArray(result.artists) ? result.artists : []
  const total = typeof result.artistCount === 'number' ? result.artistCount : artists.length
  return {
    items: artists.map(normalizeArtist),
    total
  }
}

async function fetchArtistTopSongs(artistId) {
  const encodedId = encodeURIComponent(String(artistId))
  try {
    const songs = await fetchPagedItems({
      makePath: (limit, offset) =>
        `/artist/songs?id=${encodedId}&order=hot&limit=${limit}&offset=${offset}`,
      getItems: getSongItems,
      limit: 100
    })
    if (songs.length > 0) return songs.map(normalizeTrack)
  } catch (error) {
    const fallbackEndpoints = [`/artist/top/song?id=${encodedId}`, `/artists?id=${encodedId}`]
    for (const endpoint of fallbackEndpoints) {
      try {
        const data = await requestAuthed(endpoint)
        const songs = getSongItems(data)
        if (songs.length > 0) return songs.map(normalizeTrack)
      } catch {
        // Continue to the next fallback endpoint.
      }
    }
    throw error
  }

  return []
}

async function fetchArtistAlbums(artistId) {
  const encodedId = encodeURIComponent(String(artistId))
  const albums = await fetchPagedItems({
    makePath: (limit, offset) => `/artist/album?id=${encodedId}&limit=${limit}&offset=${offset}`,
    getItems: getAlbumItems,
    limit: 100
  })
  return albums.map(normalizeAlbum)
}

async function fetchArtistIntro(artistId) {
  const data = await requestAuthed(`/artist/desc?id=${encodeURIComponent(String(artistId))}`)
  const candidates = [
    data.briefDesc,
    data.data?.briefDesc,
    data.introduction?.[0]?.txt,
    data.data?.introduction?.[0]?.txt
  ]
  const intro = candidates.find((value) => typeof value === 'string' && value.trim())
  return typeof intro === 'string' ? intro.trim() : ''
}

async function fetchArtistFollowState(artistId) {
  const data = await requestAuthed(
    `/artist/detail/dynamic?id=${encodeURIComponent(String(artistId))}`
  )
  const candidates = [
    data.followed,
    data.isSub,
    data.sub,
    data.data?.followed,
    data.data?.isSub,
    data.data?.sub
  ]
  for (const candidate of candidates) {
    const followed = normalizeFollowed(candidate)
    if (typeof followed === 'boolean') return followed
  }
  return null
}

async function fetchAlbumTracks(albumId) {
  const data = await requestAuthed(`/album?id=${encodeURIComponent(String(albumId))}`)
  return getSongItems(data).map(normalizeTrack)
}

async function fetchArtistPlaylists(artistId) {
  const candidateUserIds = new Set()
  try {
    const detail = await requestAuthed(`/artist/detail?id=${encodeURIComponent(String(artistId))}`)
    const ids = [
      detail.data?.artist?.accountId,
      detail.data?.artist?.userId,
      detail.data?.artist?.profile?.userId,
      detail.data?.user?.userId,
      detail.data?.userProfile?.userId,
      detail.artist?.accountId,
      detail.artist?.userId,
      detail.artist?.profile?.userId,
      detail.user?.userId,
      detail.userProfile?.userId
    ]
    ids.forEach((id) => addPositiveId(candidateUserIds, id))
  } catch {
    // Some artists do not expose a linked user account.
  }

  const playlistGroups = await Promise.allSettled(
    [...candidateUserIds].map((uid) => fetchUserPlaylistsByUid(uid, true))
  )
  const successfulGroups = playlistGroups.flatMap((group) =>
    group.status === 'fulfilled' && group.value.length > 0 ? [group.value] : []
  )
  return mergePlaylists(...successfulGroups)
}

async function fetchUserPlaylistsByUid(uid, createdOnly = false) {
  const data = await requestAuthed(
    `/user/playlist?uid=${encodeURIComponent(String(uid))}&limit=1000`
  )
  const playlists = getPlaylistItems(data)
  const visiblePlaylists = createdOnly
    ? playlists.filter((playlist) => isPlaylistCreatedByUid(playlist, uid))
    : playlists
  return visiblePlaylists.map(normalizePlaylist)
}

async function fetchUserFollows(uid, limit = 30, offset = 0) {
  const data = await requestAuthed(`/artist/sublist?limit=${limit}&offset=${offset}`)
  const artists = getArtistItems(data)
  return artists.map((item) => {
    const artist = normalizeArtist(item)
    return {
      id: artist.id,
      name: artist.name,
      picUrl: artist.picUrl,
      picUrlSmall: artist.picUrlSmall,
      musicSize: artist.musicSize,
      userType: 2,
      artistId: artist.id,
      followed: true
    }
  })
}

async function fetchUserFolloweds(uid, limit = 30, offset = 0) {
  const data = await requestAuthed(`/user/followeds?uid=${uid}&limit=${limit}&offset=${offset}`)
  const followeds = Array.isArray(data.followeds) ? data.followeds : []
  return followeds.map((item) => ({
    // Keep the grid thumbnail bounded while retaining the full URL for detail views.
    picUrlSmall: normalizeNcmCoverSize(item.avatarUrl || null, 140),
    id: Number(item.userId),
    name: item.nickname || '未知用户',
    picUrl: normalizeRemoteAssetUrl(item.avatarUrl || null),
    musicSize: item.playlistCount || 0,
    userType: item.userType || 0,
    followed: normalizeFollowed(item.followed ?? item.followMe ?? item.mutual)
  }))
}

async function followArtist(artistId, follow, requestContext) {
  return runIdempotentProviderWrite(
    'followArtist',
    [artistId, follow],
    requestContext,
    async () => {
      const data = await requestAuthed(
        `/artist/sub?id=${encodeURIComponent(String(artistId))}&t=${follow ? '1' : '0'}`,
        requestContext
      )
      throwIfRequestAborted(requestContext)
      const code = Number(data.code)
      if (Number.isFinite(code) && code !== 200) {
        throw new Error(normalizeApiMessage(data, follow ? '关注歌手失败' : '取消关注歌手失败'))
      }
    }
  )
}

async function followUser(userId, follow, requestContext) {
  return runIdempotentProviderWrite('followUser', [userId, follow], requestContext, async () => {
    const data = await requestAuthed(
      `/follow?id=${encodeURIComponent(String(userId))}&t=${follow ? '1' : '0'}`,
      requestContext
    )
    throwIfRequestAborted(requestContext)
    const code = Number(data.code)
    if (Number.isFinite(code) && code !== 200) {
      throw new Error(normalizeApiMessage(data, follow ? '关注用户失败' : '取消关注用户失败'))
    }
  })
}

async function likeTrack(songId, like, requestContext) {
  const updateLikedState = () => {
    if (like) {
      replaceLikedSongIds([...likedSongIds, Number(songId)])
    } else {
      const next = new Set(likedSongIds)
      next.delete(Number(songId))
      replaceLikedSongIds(next)
    }
    // 本地刚完成的点赞/取消是权威状态，避免紧接着的刷新把它冲掉。
    likedIdsFreshAt = Date.now()
    likedIdsRefreshRetryAt = 0
  }
  return runIdempotentProviderWrite(
    'likeTrack',
    [songId, like],
    requestContext,
    async () => {
      await requestAuthed(`/like?id=${songId}&like=${String(like)}`, requestContext)
      throwIfRequestAborted(requestContext)
      updateLikedState()
    },
    updateLikedState
  )
}

async function refreshLikedIdsIfStale() {
  const now = Date.now()
  if (now < likedIdsRefreshRetryAt) return
  if (now - likedIdsFreshAt < LIKED_IDS_REFRESH_TTL_MS) return
  if (likedIdsRefreshInFlight) return likedIdsRefreshInFlight
  const refreshRevision = likedIdsRevision

  likedIdsRefreshInFlight = (async () => {
    try {
      const userId = cachedUserId ?? (await ensureProfile()).userId
      const data = await requestAuthedRead(`/likelist?uid=${userId}`, {
        attempts: 2,
        label: 'liked ids refresh'
      })
      const ids = getLikelistIds(data)
      if (refreshRevision !== likedIdsRevision) return
      // 空列表同样是权威结果（用户当前没有任何喜欢的歌曲）。
      replaceLikedSongIds(ids)
      likedIdsFreshAt = Date.now()
      likedIdsRefreshRetryAt = 0
      cachedUserId = userId
    } catch (error) {
      getContext().logger.warn(`网易云喜欢状态刷新失败，回退到本地缓存：${getErrorMessage(error)}`)
      if (refreshRevision === likedIdsRevision) {
        likedIdsRefreshRetryAt = now + LIKED_IDS_REFRESH_FAIL_BACKOFF_MS
      }
    } finally {
      likedIdsRefreshInFlight = null
    }
  })()

  return likedIdsRefreshInFlight
}

async function isTrackLiked(ncmSongId) {
  const songId = Number(ncmSongId)
  if (!Number.isFinite(songId) || songId <= 0) return false
  // 按歌曲实时校验：先以短 TTL 刷新云端喜欢集合，再判断是否喜欢，
  // 避免其他设备改过喜欢状态后本应用仍显示旧状态。
  await refreshLikedIdsIfStale()
  return likedSongIds.has(songId)
}

function requirePlaylistId(playlistId) {
  const id = Number(playlistId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('歌单 ID 无效')
  return id
}

function normalizeTrackIdList(trackIds) {
  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    throw new Error('歌曲列表不能为空')
  }
  const ids = trackIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) throw new Error('歌曲列表不能为空')
  return [...new Set(ids)]
}

function assertWriteOk(data, fallback) {
  const code = Number(data?.code ?? data?.body?.code)
  if (Number.isFinite(code) && code !== 200) {
    throw new Error(normalizeApiMessage(data?.body ?? data, fallback))
  }
}

function invalidatePlaylistCaches(playlistId) {
  if (playlistId != null) playlistTrackCache.delete(String(playlistId))
  likedTracksCache = null
  likedSongIdListCache = null
}

async function createPlaylist(name, options = {}, requestContext) {
  const playlistName = requireNonEmptyString(name, '歌单名称')
  const privacy = Number(options?.privacy) === 10 ? 10 : 0
  return runIdempotentProviderWrite(
    'createPlaylist',
    [playlistName, privacy],
    requestContext,
    async () => {
      const data = await requestAuthed(
        `/playlist/create?name=${encodeURIComponent(playlistName)}&privacy=${privacy}&timestamp=${Date.now()}`,
        requestContext
      )
      throwIfRequestAborted(requestContext)
      assertWriteOk(data, '创建歌单失败')
      const raw = data.playlist ?? data.data?.playlist ?? data
      const currentProfile = await ensureProfile().catch(() => null)
      const summary = normalizePlaylist(
        {
          id: raw.id ?? raw.playlistId,
          name: raw.name ?? playlistName,
          coverImgUrl: raw.coverImgUrl ?? raw.picUrl ?? null,
          trackCount: typeof raw.trackCount === 'number' ? raw.trackCount : 0,
          userId: raw.userId ?? currentProfile?.userId,
          creator: raw.creator ?? currentProfile
        },
        currentProfile?.userId
      )
      if (Number.isFinite(summary.id) && summary.id > 0) {
        ownedPlaylistIds = new Set([...ownedPlaylistIds, Number(summary.id)])
      }
      return { ...summary, owned: true }
    }
  )
}

async function deletePlaylist(playlistId, requestContext) {
  const id = requirePlaylistId(playlistId)
  return runIdempotentProviderWrite('deletePlaylist', [id], requestContext, async () => {
    const owned = ownedPlaylistIds.has(id)
    const path = owned
      ? `/playlist/delete?id=${encodeURIComponent(String(id))}&timestamp=${Date.now()}`
      : `/playlist/subscribe?t=2&id=${encodeURIComponent(String(id))}&timestamp=${Date.now()}`
    const data = await requestAuthed(path, requestContext)
    throwIfRequestAborted(requestContext)
    assertWriteOk(data, owned ? '删除歌单失败' : '取消收藏歌单失败')
    ownedPlaylistIds = new Set([...ownedPlaylistIds].filter((entry) => entry !== id))
    invalidatePlaylistCaches(id)
  })
}

async function manipulatePlaylistTracks(playlistId, trackIds, op, requestContext) {
  const pid = requirePlaylistId(playlistId)
  const ids = normalizeTrackIdList(trackIds)
  const tracks = ids.join(',')
  return runIdempotentProviderWrite(
    op === 'add' ? 'addTracksToPlaylist' : 'removeTracksFromPlaylist',
    [pid, tracks, op],
    requestContext,
    async () => {
      let data = await requestAuthed(
        `/playlist/tracks?op=${encodeURIComponent(op)}&pid=${encodeURIComponent(String(pid))}&tracks=${encodeURIComponent(tracks)}&timestamp=${Date.now()}`,
        requestContext
      )
      throwIfRequestAborted(requestContext)
      let code = Number(data?.code ?? data?.body?.code)
      // NetEase may return 512 for cloud-disk collisions; retry with duplicated ids (upstream workaround).
      if (code === 512 && op === 'add') {
        const doubled = [...ids, ...ids].join(',')
        data = await requestAuthed(
          `/playlist/tracks?op=add&pid=${encodeURIComponent(String(pid))}&tracks=${encodeURIComponent(doubled)}&timestamp=${Date.now()}`,
          requestContext
        )
        throwIfRequestAborted(requestContext)
        code = Number(data?.code ?? data?.body?.code)
      }
      if (Number.isFinite(code) && code !== 200) {
        throw new Error(
          normalizeApiMessage(
            data?.body ?? data,
            op === 'add' ? '添加歌曲到歌单失败' : '从歌单移除歌曲失败'
          )
        )
      }
      invalidatePlaylistCaches(pid)
    }
  )
}

async function addTracksToPlaylist(playlistId, trackIds, requestContext) {
  return manipulatePlaylistTracks(playlistId, trackIds, 'add', requestContext)
}

async function removeTracksFromPlaylist(playlistId, trackIds, requestContext) {
  return manipulatePlaylistTracks(playlistId, trackIds, 'del', requestContext)
}

function syncLikedIds(tracks) {
  replaceLikedSongIds(
    tracks.map((track) => Number(track.ncmSongId)).filter((id) => Number.isFinite(id) && id > 0)
  )
}

function replaceLikedSongIds(ids) {
  likedSongIds = new Set(ids)
  likedIdsRevision += 1
}

// ── 听歌排行 (user/record) ──────────────────────────────────────────
// type: 0 = 全部时间, 1 = 最近一周
async function fetchPlayRecords(type = 1) {
  const currentProfile = await ensureProfile()
  const data = await requestAuthed(`/user/record?uid=${currentProfile.userId}&type=${type}`)
  const list = Array.isArray(data.weekData)
    ? data.weekData
    : Array.isArray(data.allData)
      ? data.allData
      : Array.isArray(data.data?.weekData)
        ? data.data.weekData
        : Array.isArray(data.data?.allData)
          ? data.data.allData
          : []
  return list.map((item) => {
    const track = normalizeTrack(item.song || item)
    track.playCount = Number(item.playCount ?? item.playcount ?? 0) || 0
    track.score = Number(item.score ?? 0) || 0
    return track
  })
}

// ── 最近播放歌曲 (record/recent/song) ────────────────────────────────
async function fetchRecentSongs(limit = 100) {
  const data = await requestAuthed(`/record/recent/song?limit=${limit}`)
  const list = Array.isArray(data.data?.list)
    ? data.data.list
    : Array.isArray(data.list)
      ? data.list
      : []
  return list.map((item) => {
    // /record/recent/song 返回结构: { resourceId, playTime, resourceType, data: { song fields } }
    const song = item.data ?? item.song ?? item
    const track = normalizeTrack(song)
    track.playTime = Number(item.playTime ?? 0) || 0
    return track
  })
}
