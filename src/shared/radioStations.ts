/**
 * User-managed internet radio stations.
 * Stored outside the library index so rescans never wipe favorites.
 */

export const RADIO_STATIONS_SCHEMA_VERSION = 1 as const
export const MAX_RADIO_STATIONS = 500
export const MAX_RADIO_NAME_LENGTH = 120
export const MAX_RADIO_URL_LENGTH = 2048
export const MAX_RADIO_HOMEPAGE_LENGTH = 2048
export const MAX_RADIO_TAGS = 16
export const MAX_RADIO_TAG_LENGTH = 40

export interface RadioStation {
  id: string
  name: string
  /** Stream URL (http or https). Plain http requires allowInsecureHttp. */
  streamUrl: string
  homepage?: string
  favicon?: string
  tags?: string[]
  /** User explicitly allowed an http:// stream when adding/importing. */
  allowInsecureHttp: boolean
  createdAt: string
  updatedAt: string
}

export interface RadioStationsDocument {
  schemaVersion: typeof RADIO_STATIONS_SCHEMA_VERSION
  stations: RadioStation[]
}

export const DEFAULT_RADIO_STATIONS: RadioStationsDocument = {
  schemaVersion: RADIO_STATIONS_SCHEMA_VERSION,
  stations: []
}

export function isHttpOrHttpsUrl(value: string, maxLength = MAX_RADIO_URL_LENGTH): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || /[\0\r\n]/.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    return true
  } catch {
    return false
  }
}

export function isInsecureHttpUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'http:'
  } catch {
    return false
  }
}

export function isRadioStation(value: unknown): value is RadioStation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id.trim()) return false
  if (typeof record.name !== 'string' || !record.name.trim()) return false
  if (record.name.length > MAX_RADIO_NAME_LENGTH) return false
  if (typeof record.streamUrl !== 'string' || !isHttpOrHttpsUrl(record.streamUrl)) return false
  if (typeof record.allowInsecureHttp !== 'boolean') return false
  if (isInsecureHttpUrl(record.streamUrl) && !record.allowInsecureHttp) return false
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return false
  if (record.homepage !== undefined && record.homepage !== null) {
    if (
      typeof record.homepage !== 'string' ||
      !isHttpOrHttpsUrl(record.homepage, MAX_RADIO_HOMEPAGE_LENGTH)
    ) {
      return false
    }
  }
  if (record.favicon !== undefined && record.favicon !== null) {
    if (
      typeof record.favicon !== 'string' ||
      !isHttpOrHttpsUrl(record.favicon, MAX_RADIO_HOMEPAGE_LENGTH)
    ) {
      return false
    }
  }
  if (record.tags !== undefined && record.tags !== null) {
    if (!Array.isArray(record.tags) || record.tags.length > MAX_RADIO_TAGS) return false
    if (
      !record.tags.every(
        (tag) =>
          typeof tag === 'string' && tag.trim().length > 0 && tag.length <= MAX_RADIO_TAG_LENGTH
      )
    ) {
      return false
    }
  }
  return true
}

export function isRadioStationsDocument(value: unknown): value is RadioStationsDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== RADIO_STATIONS_SCHEMA_VERSION) return false
  if (!Array.isArray(record.stations)) return false
  if (record.stations.length > MAX_RADIO_STATIONS) return false
  return record.stations.every(isRadioStation)
}

export function cloneRadioStationsDocument(document: RadioStationsDocument): RadioStationsDocument {
  return {
    schemaVersion: RADIO_STATIONS_SCHEMA_VERSION,
    stations: document.stations.map((station) => ({
      ...station,
      tags: station.tags ? [...station.tags] : undefined
    }))
  }
}

export function normalizeRadioStationName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name.trim().slice(0, MAX_RADIO_NAME_LENGTH)
}

export function normalizeRadioStreamUrl(url: unknown): string {
  if (typeof url !== 'string') return ''
  return url.trim().slice(0, MAX_RADIO_URL_LENGTH)
}
