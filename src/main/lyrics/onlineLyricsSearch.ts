/**
 * LRCLIB (https://lrclib.net) online lyrics fallback.
 * No auth required. Ranking reuses the same title/artist/duration heuristics as
 * local metadata matching so results stay consistent with library enrichment.
 */
import { parseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import type {
  OnlineLyricsCandidate,
  OnlineLyricsQuery,
  OnlineLyricsSearchResult
} from '../../shared/lyricsManagement.ts'

export type {
  OnlineLyricsCandidate,
  OnlineLyricsQuery,
  OnlineLyricsSearchResult
} from '../../shared/lyricsManagement.ts'

export const LRCLIB_BASE_URL = 'https://lrclib.net/api'
export const ONLINE_LYRICS_TIMEOUT_MS = 8_000
export const MAX_ONLINE_LYRICS_BYTES = 1_024 * 1_024
export const ONLINE_LYRICS_CACHE_TTL_MS = 10 * 60 * 1000
export const ONLINE_LYRICS_CACHE_MAX_ENTRIES = 64
export const ONLINE_LYRICS_MIN_INTERVAL_MS = 800
export const ONLINE_LYRICS_MAX_REQUESTS_PER_WINDOW = 20
export const ONLINE_LYRICS_RATE_WINDOW_MS = 60_000

type LrclibHit = {
  id?: number
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

type OnlineLyricsCacheEntry = {
  result: OnlineLyricsSearchResult
  expiresAt: number
}

const onlineLyricsCache = new Map<string, OnlineLyricsCacheEntry>()
let lastOnlineLyricsSearchAt = 0
let onlineLyricsRequestTimestamps: number[] = []

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildOnlineLyricsCacheKey(query: OnlineLyricsQuery): string {
  return [
    normalizeText(query.title),
    normalizeText(query.artist),
    normalizeText(query.album ?? ''),
    query.durationSeconds != null ? String(query.durationSeconds) : ''
  ].join('|')
}

export function clearOnlineLyricsCache(): void {
  onlineLyricsCache.clear()
}

export function clearOnlineLyricsRateLimit(): void {
  lastOnlineLyricsSearchAt = 0
  onlineLyricsRequestTimestamps = []
}

/**
 * Gateway guard for IPC: min interval + rolling window.
 * Call before searchOnlineLyrics from trusted IPC handlers only.
 */
export function assertOnlineLyricsRateLimit(nowMs: number = Date.now()): void {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  onlineLyricsRequestTimestamps = onlineLyricsRequestTimestamps.filter(
    (timestamp) => now - timestamp < ONLINE_LYRICS_RATE_WINDOW_MS
  )
  if (onlineLyricsRequestTimestamps.length >= ONLINE_LYRICS_MAX_REQUESTS_PER_WINDOW) {
    throw new Error(
      `Online lyrics rate limit exceeded: max ${ONLINE_LYRICS_MAX_REQUESTS_PER_WINDOW} requests per ${ONLINE_LYRICS_RATE_WINDOW_MS / 1000}s`
    )
  }
  if (
    lastOnlineLyricsSearchAt > 0 &&
    now - lastOnlineLyricsSearchAt < ONLINE_LYRICS_MIN_INTERVAL_MS
  ) {
    throw new Error(
      `Online lyrics rate limit exceeded: minimum ${ONLINE_LYRICS_MIN_INTERVAL_MS}ms between searches`
    )
  }
  lastOnlineLyricsSearchAt = now
  onlineLyricsRequestTimestamps.push(now)
}

function readOnlineLyricsCache(
  key: string,
  nowMs: number = Date.now()
): OnlineLyricsSearchResult | null {
  const entry = onlineLyricsCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= nowMs) {
    onlineLyricsCache.delete(key)
    return null
  }
  return entry.result
}

function writeOnlineLyricsCache(
  key: string,
  result: OnlineLyricsSearchResult,
  nowMs: number = Date.now()
): void {
  if (onlineLyricsCache.has(key)) onlineLyricsCache.delete(key)
  onlineLyricsCache.set(key, {
    result,
    expiresAt: nowMs + ONLINE_LYRICS_CACHE_TTL_MS
  })
  while (onlineLyricsCache.size > ONLINE_LYRICS_CACHE_MAX_ENTRIES) {
    const oldest = onlineLyricsCache.keys().next().value
    if (oldest == null) break
    onlineLyricsCache.delete(oldest)
  }
}

function scoreCandidate(query: OnlineLyricsQuery, hit: LrclibHit): number {
  const titleQ = normalizeText(query.title)
  const artistQ = normalizeText(query.artist)
  const titleH = normalizeText(hit.trackName ?? '')
  const artistH = normalizeText(hit.artistName ?? '')
  if (!titleQ || !titleH) return 0

  let score = 0
  if (titleQ === titleH) score += 50
  else if (titleH.includes(titleQ) || titleQ.includes(titleH)) score += 28
  else return 0

  if (artistQ && artistH) {
    if (artistQ === artistH) score += 35
    else if (artistH.includes(artistQ) || artistQ.includes(artistH)) score += 18
  }

  const duration = typeof hit.duration === 'number' && Number.isFinite(hit.duration) ? hit.duration : null
  if (duration != null && query.durationSeconds != null && Number.isFinite(query.durationSeconds)) {
    const delta = Math.abs(duration - query.durationSeconds)
    if (delta <= 3) score += 20
    else if (delta <= 8) score += 12
    else if (delta <= 20) score += 4
    else score -= 10
  }

  if (typeof hit.syncedLyrics === 'string' && hit.syncedLyrics.trim()) score += 8
  else if (typeof hit.plainLyrics === 'string' && hit.plainLyrics.trim()) score += 2

  if (query.album) {
    const albumQ = normalizeText(query.album)
    const albumH = normalizeText(hit.albumName ?? '')
    if (albumQ && albumH && (albumQ === albumH || albumH.includes(albumQ) || albumQ.includes(albumH))) {
      score += 6
    }
  }

  return score
}

function toCandidate(query: OnlineLyricsQuery, hit: LrclibHit): OnlineLyricsCandidate | null {
  const score = scoreCandidate(query, hit)
  if (score < 40) return null
  const synced =
    typeof hit.syncedLyrics === 'string' && hit.syncedLyrics.trim() ? hit.syncedLyrics : null
  const plain =
    typeof hit.plainLyrics === 'string' && hit.plainLyrics.trim() ? hit.plainLyrics : null
  if (!synced && !plain) return null
  return {
    id: hit.id ?? `${hit.trackName ?? ''}:${hit.artistName ?? ''}`,
    title: hit.trackName ?? query.title,
    artist: hit.artistName ?? query.artist,
    album: hit.albumName ?? query.album ?? '',
    durationSeconds:
      typeof hit.duration === 'number' && Number.isFinite(hit.duration) ? hit.duration : null,
    score,
    syncedLyrics: synced,
    plainLyrics: plain,
    source: 'lrclib'
  }
}

export function rankOnlineLyricsCandidates(
  query: OnlineLyricsQuery,
  hits: readonly LrclibHit[]
): OnlineLyricsCandidate[] {
  return hits
    .map((hit) => toCandidate(query, hit))
    .filter((item): item is OnlineLyricsCandidate => item != null)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh'))
}

export function normalizeOnlineLyricsQuery(input: unknown): OnlineLyricsQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Online lyrics query must be an object')
  }
  const record = input as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const artist = typeof record.artist === 'string' ? record.artist.trim() : ''
  if (!title || !artist) throw new Error('Online lyrics query requires title and artist')
  if (title.length > 512 || artist.length > 512) throw new Error('Online lyrics query is too long')
  const album =
    typeof record.album === 'string' && record.album.trim() ? record.album.trim().slice(0, 512) : undefined
  const durationSeconds =
    typeof record.durationSeconds === 'number' && Number.isFinite(record.durationSeconds)
      ? Math.max(0, Math.round(record.durationSeconds))
      : undefined
  return { title, artist, album, durationSeconds }
}

export async function searchOnlineLyrics(
  queryInput: unknown,
  options: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    timeoutMs?: number
    bypassCache?: boolean
  } = {}
): Promise<OnlineLyricsSearchResult> {
  const query = normalizeOnlineLyricsQuery(queryInput)
  const cacheKey = buildOnlineLyricsCacheKey(query)
  if (!options.bypassCache) {
    const cached = readOnlineLyricsCache(cacheKey)
    if (cached) return cached
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? ONLINE_LYRICS_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const params = new URLSearchParams({
      track_name: query.title,
      artist_name: query.artist
    })
    if (query.album) params.set('album_name', query.album)
    if (query.durationSeconds != null) params.set('duration', String(query.durationSeconds))

    const response = await fetchImpl(`${LRCLIB_BASE_URL}/search?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`LRCLIB search failed with HTTP ${response.status}`)
    }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf-8') > MAX_ONLINE_LYRICS_BYTES) {
      throw new Error('Online lyrics response exceeds size limit')
    }
    const parsed = parseJsonWithNestingLimit(text) as unknown
    const hits = Array.isArray(parsed) ? (parsed as LrclibHit[]) : []
    const candidates = rankOnlineLyricsCandidates(query, hits).slice(0, 12)
    const result: OnlineLyricsSearchResult = {
      query,
      candidates,
      best: candidates[0] ?? null
    }
    writeOnlineLyricsCache(cacheKey, result)
    return result
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export function pickOnlineLyricsText(candidate: OnlineLyricsCandidate | null | undefined): string | null {
  if (!candidate) return null
  return candidate.syncedLyrics ?? candidate.plainLyrics ?? null
}
