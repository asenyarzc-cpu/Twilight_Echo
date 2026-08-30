import { createHash, randomUUID } from 'node:crypto'

export type RemoteMediaKind = 'audio' | 'image'

export interface RemoteMediaGrant {
  source: string
  kind: RemoteMediaKind
}

export interface RemoteMediaGrantServiceOptions {
  now?: () => number
  createToken?: () => string
  /** Use a stable source-derived image token so Chromium can reuse its cache. */
  deterministicImageTokens?: boolean
}

export interface RemoteMediaRequestHandlerOptions {
  grants?: RemoteMediaGrantService
  fetch: (source: string, init: RequestInit) => Promise<Response>
}

interface StoredGrant extends RemoteMediaGrant {
  lastAccessAt: number
}

const AUDIO_IDLE_TTL_MS = 30 * 60 * 1000
const IMAGE_IDLE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_IMAGE_RESPONSE_BYTES = 25 * 1024 * 1024
const MAX_AUDIO_RESPONSE_BYTES = 1024 * 1024 * 1024
// Provider CDNs (especially NetEase album art) routinely 302 to edge hosts.
// Follow a short, credential-free hop chain instead of failing every cover load.
const MAX_REMOTE_MEDIA_REDIRECTS = 5

export class RemoteMediaGrantService {
  private readonly grants = new Map<string, StoredGrant>()
  private readonly now: () => number
  private readonly createToken: () => string
  private readonly deterministicImageTokens: boolean

  constructor(options: RemoteMediaGrantServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.createToken = options.createToken ?? randomUUID
    this.deterministicImageTokens =
      options.deterministicImageTokens ?? options.createToken === undefined
  }

  grant(source: string, kind: RemoteMediaKind): string {
    const normalized = normalizeRemoteMediaSource(source)
    const token =
      kind === 'image' && this.deterministicImageTokens
        ? deterministicImageToken(normalized)
        : this.createToken()
    if (!token || /[/?#]/.test(token)) throw new Error('Remote media grant token is invalid')
    this.grants.set(token, { source: normalized, kind, lastAccessAt: this.now() })
    return `twilight-media://${kind}/${token}`
  }

  resolve(url: string, expectedKind?: RemoteMediaKind): RemoteMediaGrant {
    const { token, kind } = parseGrantToken(url)
    const grant = this.grants.get(token)
    if (!grant) throw new Error('Remote media grant is unknown')
    if (grant.kind !== kind) throw new Error('Remote media grant kind is not authorized')
    if (expectedKind && grant.kind !== expectedKind) {
      throw new Error('Remote media grant kind is not authorized')
    }
    if (this.now() - grant.lastAccessAt > ttlFor(grant.kind)) {
      this.grants.delete(token)
      throw new Error('Remote media grant has expired')
    }
    grant.lastAccessAt = this.now()
    return { source: grant.source, kind: grant.kind }
  }

  revokeAll(): void {
    this.grants.clear()
  }
}

export const remoteMediaGrants = new RemoteMediaGrantService()

export function createRemoteMediaRequestHandler(
  options: RemoteMediaRequestHandlerOptions
): (request: Request) => Promise<Response> {
  const grants = options.grants ?? remoteMediaGrants
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return failedRemoteMediaResponse(405, 'Method not allowed')
    }

    let grant: RemoteMediaGrant
    try {
      grant = grants.resolve(request.url)
    } catch {
      return failedRemoteMediaResponse(403, 'Remote media authorization failed')
    }

    const range = request.headers.get('range')
    if (range && !isSingleByteRange(range)) {
      return failedRemoteMediaResponse(416, 'Requested range is not supported')
    }

    let upstream: Response
    try {
      upstream = await fetchRemoteMediaWithRedirects(options.fetch, grant.source, {
        method: request.method,
        headers: buildUpstreamRequestHeaders(grant.source, grant.kind, range)
      })
    } catch {
      return failedRemoteMediaResponse(502, 'Remote media request failed')
    }

    if (!upstream.ok && upstream.status !== 206) {
      return failedRemoteMediaResponse(502, 'Remote media request failed')
    }
    if (!isExpectedMediaType(upstream.headers.get('content-type'), grant.kind)) {
      return failedRemoteMediaResponse(415, 'Remote media type is not authorized')
    }

    const maximumBytes = maxResponseBytesFor(grant.kind)
    const contentLength = parseContentLength(upstream.headers.get('content-length'))
    if (contentLength !== null && contentLength > maximumBytes) {
      return failedRemoteMediaResponse(413, 'Remote media response is too large')
    }

    return new Response(limitResponseBody(upstream.body, maximumBytes), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: filteredResponseHeaders(upstream.headers)
    })
  }
}

export function protectProviderMedia<T>(
  value: T,
  method: string,
  grants: RemoteMediaGrantService = remoteMediaGrants
): T {
  if (typeof value === 'string') {
    return (method === 'getPlaybackUrl' ? grantIfRemote(value, 'audio', grants) : value) as T
  }
  return protectValue(value, method, grants) as T
}

/**
 * Issue (or re-issue) an image grant for a durable remote cover URL.
 * Used when the renderer restores a track whose previous twilight-media token
 * is no longer in the main-process grant map.
 */
export function grantRemoteImageUrl(
  source: string,
  grants: RemoteMediaGrantService = remoteMediaGrants
): string {
  const normalized = normalizeProviderRemoteUrl(source)
  if (!normalized) throw new Error('Remote image source is invalid')
  return grants.grant(normalized, 'image')
}

function protectValue(value: unknown, method: string, grants: RemoteMediaGrantService): unknown {
  if (Array.isArray(value)) return value.map((entry) => protectValue(entry, method, grants))
  if (!value || typeof value !== 'object') return value

  const protectedValue: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && isImageField(key, method)) {
      const normalized = normalizeProviderRemoteUrl(entry)
      if (normalized) {
        protectedValue[key] = grants.grant(normalized, 'image')
        // Keep a durable origin so session restore / listening stats can re-grant
        // after the in-memory twilight-media token is gone.
        const sourceKey = durableImageSourceKey(key)
        if (sourceKey && protectedValue[sourceKey] === undefined) {
          protectedValue[sourceKey] = normalized
        }
      } else {
        protectedValue[key] = entry
      }
    } else if (typeof entry === 'string' && isAudioField(key)) {
      protectedValue[key] = grantIfRemote(entry, 'audio', grants)
    } else {
      protectedValue[key] = protectValue(entry, method, grants)
    }
  }
  return protectedValue
}

/**
 * Sibling field names that store the original http(s) image URL alongside a
 * twilight-media grant. Only `cover` drives LocalDashboard + PlayerBar.
 */
function durableImageSourceKey(key: string): string | null {
  if (key === 'cover' || key === 'coverUrl') return 'coverSource'
  if (key === 'coverSmall') return 'coverSmallSource'
  if (key === 'picUrl') return 'picUrlSource'
  if (key === 'picUrlSmall') return 'picUrlSmallSource'
  if (key === 'avatarUrl') return 'avatarUrlSource'
  if (key === 'avatarUrlSmall') return 'avatarUrlSmallSource'
  return null
}

function deterministicImageToken(source: string): string {
  return `img-${createHash('sha256').update(source).digest('hex').slice(0, 48)}`
}

function isImageField(key: string, method: string): boolean {
  return (
    key === 'cover' ||
    key === 'coverUrl' ||
    key === 'coverSmall' ||
    key === 'imageUrl' ||
    key === 'picUrl' ||
    key === 'picUrlSmall' ||
    key === 'avatarUrl' ||
    key === 'avatarUrlSmall' ||
    key === 'coverImgUrl' ||
    key === 'blurPicUrl' ||
    (key === 'url' && method === 'getQrImage')
  )
}

function isAudioField(key: string): boolean {
  return key === 'streamUrl' || key === 'audioUrl'
}

function grantIfRemote(
  source: string,
  kind: RemoteMediaKind,
  grants: RemoteMediaGrantService
): string {
  const normalized = normalizeProviderRemoteUrl(source)
  return normalized ? grants.grant(normalized, kind) : source
}

/**
 * Accepts absolute http(s) URLs and protocol-relative `//host/path` values that
 * NetEase (and some other providers) return for cover/stream assets.
 */
function normalizeProviderRemoteUrl(source: string): string | null {
  if (typeof source !== 'string') return null
  const trimmed = source.trim()
  if (!trimmed) return null
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  if (!/^https?:\/\//i.test(candidate)) return null
  try {
    return normalizeRemoteMediaSource(candidate)
  } catch {
    return null
  }
}

/**
 * NetEase (and many CDNs) reject bare Electron net.fetch without a browser-like
 * UA/Referer. Missing headers yield 403 HTML, which then fails the image
 * content-type gate and leaves PlayerBar/LocalDashboard with a broken <img>.
 */
function buildUpstreamRequestHeaders(
  source: string,
  kind: RemoteMediaKind,
  range: string | null
): Record<string, string> {
  // Return a plain object so Electron net.fetch always receives string headers.
  // Passing a WHATWG Headers instance can drop fields under some Electron builds.
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: kind === 'image' ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' : '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
  const referer = refererForRemoteMediaSource(source)
  if (referer) headers.Referer = referer
  if (range) headers.Range = range
  return headers
}

function refererForRemoteMediaSource(source: string): string | null {
  try {
    const host = new URL(source).hostname.toLowerCase()
    if (
      host === 'music.163.com' ||
      host.endsWith('.music.163.com') ||
      host.endsWith('.126.net') ||
      host.endsWith('.163.com')
    ) {
      return 'https://music.163.com/'
    }
  } catch {
    // ignore parse failures
  }
  return null
}

async function fetchRemoteMediaWithRedirects(
  fetchImpl: RemoteMediaRequestHandlerOptions['fetch'],
  source: string,
  init: { method: string; headers?: HeadersInit }
): Promise<Response> {
  let current = source
  const baseHeaders = headersInitToRecord(init.headers)
  for (let hop = 0; hop <= MAX_REMOTE_MEDIA_REDIRECTS; hop += 1) {
    // Refresh Referer for each hop so edge hosts still look browser-like.
    const hopHeaders: Record<string, string> = { ...baseHeaders }
    const hopReferer = refererForRemoteMediaSource(current)
    if (hopReferer) hopHeaders.Referer = hopReferer
    const response = await fetchImpl(current, {
      method: init.method,
      headers: hopHeaders,
      credentials: 'omit',
      redirect: 'manual'
    })
    if (response.status < 300 || response.status >= 400) return response
    if (hop === MAX_REMOTE_MEDIA_REDIRECTS) {
      throw new Error('Remote media redirect limit exceeded')
    }
    const location = response.headers.get('location')
    if (!location) throw new Error('Remote media redirect is missing a location')
    let next: string
    try {
      next = normalizeRemoteMediaSource(new URL(location, current).toString())
    } catch {
      throw new Error('Remote media redirect target is not authorized')
    }
    // Drop the body so sockets are not held while hopping CDN edge hosts.
    try {
      await response.body?.cancel()
    } catch {
      // ignore cancel failures
    }
    current = next
  }
  throw new Error('Remote media redirect limit exceeded')
}

function headersInitToRecord(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (typeof key === 'string' && typeof value === 'string') result[key] = value
    }
    return result
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

function normalizeRemoteMediaSource(source: string): string {
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    throw new Error('Remote media source is invalid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Remote media source protocol is not authorized')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Remote media source must not include credentials')
  }
  return parsed.toString()
}

function parseGrantToken(url: string): { token: string; kind: RemoteMediaKind } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Remote media grant URL is invalid')
  }
  const token = parsed.pathname.replace(/^\/+/, '')
  const kind = parsed.hostname
  if (
    parsed.protocol !== 'twilight-media:' ||
    (kind !== 'audio' && kind !== 'image') ||
    !token ||
    token.includes('/') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Remote media grant URL is invalid')
  }
  return { token, kind }
}

function ttlFor(kind: RemoteMediaKind): number {
  return kind === 'audio' ? AUDIO_IDLE_TTL_MS : IMAGE_IDLE_TTL_MS
}

function isSingleByteRange(value: string): boolean {
  return /^bytes=(?:\d+-\d*|\d*-\d+)$/i.test(value)
}

function isExpectedMediaType(contentType: string | null, kind: RemoteMediaKind): boolean {
  // NetEase occasionally emits `image/jpg; charset=UTF-8` — strip params first.
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (kind === 'image') {
    // Some CDNs omit content-type, serve covers as generic binary, or use the
    // non-standard `image/jpg` subtype (still starts with image/).
    return (
      !normalized ||
      normalized.startsWith('image/') ||
      normalized === 'application/octet-stream' ||
      normalized === 'binary/octet-stream'
    )
  }
  // NetEase stream edges often omit Content-Type, label FLAC/MP3 as
  // application/octet-stream, or mis-tag AAC as video/mp4 / application/mp4.
  return (
    !normalized ||
    normalized.startsWith('audio/') ||
    normalized === 'application/ogg' ||
    normalized === 'application/octet-stream' ||
    normalized === 'binary/octet-stream' ||
    normalized === 'application/mp4' ||
    normalized === 'video/mp4' ||
    normalized === 'application/x-mpegurl' ||
    normalized === 'application/vnd.apple.mpegurl'
  )
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function maxResponseBytesFor(kind: RemoteMediaKind): number {
  return kind === 'audio' ? MAX_AUDIO_RESPONSE_BYTES : MAX_IMAGE_RESPONSE_BYTES
}

function filteredResponseHeaders(headers: Headers): Headers {
  const filtered = new Headers()
  for (const name of [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type'
  ]) {
    const value = headers.get(name)
    if (value) filtered.set(name, value)
  }
  // Allow renderer canvas sampling (cover theme) and CORS-mode <img> loads.
  // Origins stay opaque tokens; no credentials are ever forwarded upstream.
  filtered.set('Access-Control-Allow-Origin', '*')
  filtered.set('Access-Control-Allow-Methods', 'GET, HEAD')
  return filtered
}

function limitResponseBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number
): ReadableStream<Uint8Array> | null {
  if (!body) return null
  const reader = body.getReader()
  let bytesRead = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) {
        controller.close()
        return
      }
      bytesRead += next.value.byteLength
      if (bytesRead > maximumBytes) {
        await reader.cancel('Remote media response exceeded its size limit')
        controller.error(new Error('Remote media response exceeded its size limit'))
        return
      }
      controller.enqueue(next.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
}

function failedRemoteMediaResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD'
    }
  })
}
