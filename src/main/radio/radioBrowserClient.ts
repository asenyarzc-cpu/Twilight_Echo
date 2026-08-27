/**
 * radio-browser.info community directory client.
 * Only used when the user explicitly searches; never auto-polls.
 * Docs: https://api.radio-browser.info/
 */
import { parseJsonWithNestingLimit } from '../security/jsonSafety.ts'

export interface RadioBrowserStation {
  stationuuid: string
  name: string
  url: string
  urlResolved: string
  homepage?: string
  favicon?: string
  tags: string[]
  countryCode?: string
  bitrate?: number
  codec?: string
  votes?: number
}

export interface RadioBrowserSearchOptions {
  query: string
  limit?: number
  offset?: number
  /** Injected for tests. */
  fetchJson?: (url: string) => Promise<unknown>
  /** Prefer a specific host; default rotates known mirrors. */
  baseUrl?: string
}

const DEFAULT_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info'
] as const

const MAX_QUERY_LENGTH = 120
const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 8_000
const USER_AGENT =
  'TwilightEcho/1.0 (radio-browser client; +https://github.com/asenyarzc-cpu/Twilight_Echo)'

export async function searchRadioBrowserStations(
  options: RadioBrowserSearchOptions
): Promise<RadioBrowserStation[]> {
  const query = options.query.trim().slice(0, MAX_QUERY_LENGTH)
  if (!query) return []
  const limit = clampInt(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT)
  const offset = clampInt(options.offset ?? 0, 0, 10_000)
  const path = `/json/stations/byname/${encodeURIComponent(query)}?limit=${limit}&offset=${offset}&hidebroken=true&order=votes&reverse=true`
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const bases = options.baseUrl ? [options.baseUrl.replace(/\/$/, '')] : [...DEFAULT_MIRRORS]

  let lastError: Error | null = null
  for (const base of bases) {
    try {
      const raw = await fetchJson(`${base}${path}`)
      return normalizeStations(raw)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw lastError ?? new Error('Radio directory search failed')
}

function normalizeStations(raw: unknown): RadioBrowserStation[] {
  if (!Array.isArray(raw)) throw new Error('Radio directory response is invalid')
  const out: RadioBrowserStation[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const url =
      (typeof row.url_resolved === 'string' && row.url_resolved.trim()) ||
      (typeof row.url === 'string' && row.url.trim()) ||
      ''
    if (!name || !url || !/^https?:\/\//i.test(url)) continue
    const stationuuid =
      typeof row.stationuuid === 'string' && row.stationuuid.trim()
        ? row.stationuuid.trim()
        : `rb_${out.length}`
    const tagsRaw = typeof row.tags === 'string' ? row.tags : ''
    const tags = tagsRaw
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12)
    out.push({
      stationuuid,
      name: name.slice(0, 200),
      url: typeof row.url === 'string' ? row.url.trim() : url,
      urlResolved: url.slice(0, 2048),
      homepage:
        typeof row.homepage === 'string' && /^https?:\/\//i.test(row.homepage)
          ? row.homepage.trim().slice(0, 2048)
          : undefined,
      favicon:
        typeof row.favicon === 'string' && /^https?:\/\//i.test(row.favicon)
          ? row.favicon.trim().slice(0, 2048)
          : undefined,
      tags,
      countryCode:
        typeof row.countrycode === 'string' ? row.countrycode.trim().slice(0, 8) : undefined,
      bitrate:
        typeof row.bitrate === 'number' && Number.isFinite(row.bitrate) ? row.bitrate : undefined,
      codec: typeof row.codec === 'string' ? row.codec.trim().slice(0, 32) : undefined,
      votes: typeof row.votes === 'number' && Number.isFinite(row.votes) ? row.votes : undefined
    })
    if (out.length >= MAX_LIMIT) break
  }
  return out
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      },
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`Radio directory HTTP ${response.status}`)
    }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Radio directory response is too large')
    }
    return parseJsonWithNestingLimit(text) as unknown
  } finally {
    clearTimeout(timer)
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}
