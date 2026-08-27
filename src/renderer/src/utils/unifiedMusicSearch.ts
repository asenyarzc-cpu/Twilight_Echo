import type { MediaProviderCapability, MediaProviderSearchResult } from '../providers/mediaProvider'
import type { Track, TrackSource } from '../types/music'
import type { NetworkEntry } from '../../../shared/networkSources.ts'
import {
  buildLogicalTracks,
  clampReliability,
  compareSourceVariantPriority,
  getTrackSource,
  isLosslessTrack,
  type LogicalTrack,
  type SourceVariant
} from './logicalTrackModel.ts'
import {
  getTrackSearchBlob,
  normalizeSearchText as normalizeLocalSearchText
} from './localLibrarySearch.ts'

export interface UnifiedSearchProvider {
  id: string
  name: string
  capabilities: string[] | MediaProviderCapability[]
  available?: boolean
  health?: UnifiedSearchProviderReliabilityInput
}

export interface UnifiedSearchProviderReliabilityInput {
  available?: boolean
  pluginStatus?: string
  successRate?: number
  methodStats?: Record<string, { successRate?: number; lastError?: string | null } | undefined>
  lastError?: string | null
  lastCheckedAt?: string | null
}

export interface UnifiedSearchProviderHealth {
  providerId: string
  providerName: string
  available: boolean
  searchable: boolean
  resultCount: number
  lastError: string | null
  pluginStatus: string | null
  successRate: number | null
  playbackUrlSuccessRate: number | null
  playbackUrlLastError: string | null
  lastCheckedAt: string | null
}

export interface UnifiedSearchTrackItem {
  kind: 'track'
  track: Track
  source: TrackSource
  sourceName: string
  local: boolean
  lossless: boolean
  providerAvailable: boolean
  providerReliability: number
}

export type LogicalMusicVariant = SourceVariant
export type LogicalMusicItem = LogicalTrack

export interface UnifiedSearchOptions {
  query: string
  localTracks: Track[]
  networkEntries?: Array<{ profileName: string; entry: NetworkEntry }>
  providers: UnifiedSearchProvider[]
  limit?: number
  offset?: number
  searchProviderSongs: (
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderSearchResult<Track>>
}

export interface UnifiedSearchResult {
  items: UnifiedSearchTrackItem[]
  logicalItems: LogicalMusicItem[]
  health: Record<string, UnifiedSearchProviderHealth>
  total: number
}

export async function unifiedSearchSongs(
  options: UnifiedSearchOptions
): Promise<UnifiedSearchResult> {
  const query = options.query.trim()
  const limit = options.limit ?? 30
  const offset = options.offset ?? 0
  const localItems = searchLocalTracks(options.localTracks, query).map((track) =>
    toSearchItem(track, {
      sourceName: '本地音乐',
      providerAvailable: true
    })
  )
  const networkItems = (options.networkEntries ?? [])
    .filter(({ entry }) => searchNetworkEntry(entry, query))
    .map(({ profileName, entry }) =>
      toSearchItem(buildNetworkTrack(profileName, entry), {
        sourceName: '网络源',
        providerAvailable: true
      })
    )
  const health: Record<string, UnifiedSearchProviderHealth> = {}
  let total = localItems.length + networkItems.length

  const providerItems = (
    await Promise.all(
      options.providers.map(async (provider) => {
        const providerAvailable =
          provider.available !== false && provider.health?.available !== false
        const providerReliability = getProviderReliability(provider)
        const searchable = provider.capabilities.includes('search')
        const playbackUrlHealth = provider.health?.methodStats?.getPlaybackUrl
        const baseHealth: UnifiedSearchProviderHealth = {
          providerId: provider.id,
          providerName: provider.name,
          available: providerAvailable,
          searchable,
          resultCount: 0,
          lastError: provider.health?.lastError ?? null,
          pluginStatus: provider.health?.pluginStatus ?? null,
          successRate:
            typeof provider.health?.successRate === 'number' ? provider.health.successRate : null,
          playbackUrlSuccessRate:
            typeof playbackUrlHealth?.successRate === 'number'
              ? playbackUrlHealth.successRate
              : null,
          playbackUrlLastError: playbackUrlHealth?.lastError ?? null,
          lastCheckedAt: provider.health?.lastCheckedAt ?? null
        }
        health[provider.id] = baseHealth
        if (!query || !searchable || !providerAvailable) return []

        try {
          const result = await options.searchProviderSongs(provider.id, query, limit, offset)
          baseHealth.resultCount = result.items.length
          total += result.total
          return result.items.map((track) =>
            toSearchItem(track, {
              sourceName: provider.name,
              providerAvailable: true,
              providerReliability,
              source: provider.id
            })
          )
        } catch (error) {
          baseHealth.available = false
          baseHealth.lastError = error instanceof Error ? error.message : String(error)
          return []
        }
      })
    )
  ).flat()

  const items = [...localItems, ...networkItems, ...providerItems].sort(compareSearchItems)
  return {
    items,
    logicalItems: buildLogicalMusicItemsFromSearchItems(items),
    health,
    total
  }
}

export function buildLogicalMusicItems(tracks: Track[]): LogicalMusicItem[] {
  return buildLogicalMusicItemsFromSearchItems(
    tracks.map((track) =>
      toSearchItem(track, {
        sourceName: getTrackSource(track) === 'local' ? '本地音乐' : getTrackSource(track),
        providerAvailable: true
      })
    )
  )
}

function buildLogicalMusicItemsFromSearchItems(
  searchItems: UnifiedSearchTrackItem[]
): LogicalMusicItem[] {
  return buildLogicalTracks(searchItems)
}

function searchLocalTracks(tracks: Track[], query: string): Track[] {
  if (!query) return []
  const q = normalizeLocalSearchText(query.trim())
  if (!q) return []
  return tracks.filter(
    (track) =>
      getTrackSearchBlob(track).includes(q) || normalizeLocalSearchText(track.fileName).includes(q)
  )
}

function buildNetworkTrack(profileName: string, entry: NetworkEntry): Track {
  const metadata = entry.metadata
  return {
    id: entry.id,
    title: metadata?.title ?? entry.name.replace(/\.[^.]+$/, ''),
    artist: metadata?.artist ?? profileName,
    album: metadata?.album ?? profileName,
    filePath: '',
    fileName: entry.name,
    duration: metadata?.duration ?? 0,
    size: entry.sizeBytes ?? 0,
    cover: null,
    lyrics: null,
    source: 'network',
    format: metadata?.format,
    networkSource: { profileId: entry.profileId, entry }
  }
}

function searchNetworkEntry(entry: NetworkEntry, query: string): boolean {
  if (!query) return false
  const normalizedQuery = normalizeSearchText(query)
  const metadata = entry.metadata
  return (
    normalizedTrackFieldIncludes(metadata?.title ?? '', normalizedQuery) ||
    normalizedTrackFieldIncludes(metadata?.artist ?? '', normalizedQuery) ||
    normalizedTrackFieldIncludes(metadata?.album ?? '', normalizedQuery) ||
    normalizedTrackFieldIncludes(entry.name, normalizedQuery)
  )
}

function toSearchItem(
  track: Track,
  options: {
    sourceName: string
    providerAvailable: boolean
    providerReliability?: number
    source?: string
  }
): UnifiedSearchTrackItem {
  const source = getTrackSource(track, options.source)
  const local = source === 'local'
  return {
    kind: 'track',
    track: { ...track, source },
    source,
    sourceName: options.sourceName,
    local,
    lossless: isLosslessTrack(track),
    providerAvailable: options.providerAvailable,
    providerReliability: local ? 1 : clampReliability(options.providerReliability ?? 1)
  }
}

function compareSearchItems(left: UnifiedSearchTrackItem, right: UnifiedSearchTrackItem): number {
  return (
    compareSourceVariantPriority(left, right) ||
    left.track.title.localeCompare(right.track.title, 'zh') ||
    left.track.artist.localeCompare(right.track.artist, 'zh') ||
    left.track.id.localeCompare(right.track.id)
  )
}

function getProviderReliability(provider: UnifiedSearchProvider): number {
  const playbackUrlSuccessRate = provider.health?.methodStats?.getPlaybackUrl?.successRate
  if (typeof playbackUrlSuccessRate === 'number') return clampReliability(playbackUrlSuccessRate)
  if (typeof provider.health?.successRate === 'number')
    return clampReliability(provider.health.successRate)
  return provider.available === false || provider.health?.available === false ? 0 : 1
}

function normalizeSearchText(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizedTrackFieldIncludes(value: string | undefined, normalizedQuery: string): boolean {
  return normalizeSearchText(value).includes(normalizedQuery)
}
