import type { Track } from '../../types/music'
import type {
  MediaProviderArtistSummary,
  MediaProviderPlaylistSummary
} from '../../providers/mediaProvider'
import { getTrackSearchBlob } from '../../utils/localLibrarySearch.ts'

export interface LocalPlaylistSearchItem {
  id: number | string
  name: string
  trackIds: readonly string[]
}

export interface LocalArtistSearchItem {
  name: string
  cover: string | null
  trackCount: number
}

interface PageBounds {
  limit: number
  offset: number
}

export function normalizeLocalStreamingQuery(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizePageBounds(limit: number = 30, offset: number = 0): PageBounds {
  return {
    limit: Math.max(0, limit),
    offset: Math.max(0, offset)
  }
}

function collectPagedMatches<T, R>(
  items: readonly T[],
  query: string,
  limit: number | undefined,
  offset: number | undefined,
  matches: (item: T, query: string) => boolean,
  mapResult: (item: T) => R
): { items: R[]; total: number } {
  const page: R[] = []
  const bounds = normalizePageBounds(limit, offset)
  let total = 0

  for (const item of items) {
    if (!matches(item, query)) continue
    if (total >= bounds.offset && page.length < bounds.limit) {
      page.push(mapResult(item))
    }
    total++
  }

  return { items: page, total }
}

export function searchLocalStreamingSongs(
  tracks: readonly Track[],
  keywords: string,
  limit?: number,
  offset?: number
): { tracks: Track[]; total: number } {
  const query = normalizeLocalStreamingQuery(keywords.trim())
  if (!query) return { tracks: [], total: 0 }

  const result = collectPagedMatches(
    tracks,
    query,
    limit,
    offset,
    (track, q) => getTrackSearchBlob(track).includes(q),
    (track) => track
  )

  return { tracks: result.items, total: result.total }
}

export function searchLocalStreamingPlaylists(
  playlists: readonly LocalPlaylistSearchItem[],
  keywords: string,
  limit?: number,
  offset?: number
): { playlists: MediaProviderPlaylistSummary[]; total: number } {
  const query = normalizeLocalStreamingQuery(keywords.trim())
  if (!query) return { playlists: [], total: 0 }

  const result = collectPagedMatches(
    playlists,
    query,
    limit,
    offset,
    (playlist, q) => normalizeLocalStreamingQuery(playlist.name).includes(q),
    (playlist): MediaProviderPlaylistSummary => ({
      id: playlist.id,
      name: playlist.name,
      cover: null,
      trackCount: playlist.trackIds.length
    })
  )

  return { playlists: result.items, total: result.total }
}

export function searchLocalStreamingArtists(
  artists: readonly LocalArtistSearchItem[],
  keywords: string,
  limit?: number,
  offset?: number
): { artists: MediaProviderArtistSummary[]; total: number } {
  const query = normalizeLocalStreamingQuery(keywords.trim())
  if (!query) return { artists: [], total: 0 }

  const result = collectPagedMatches(
    artists,
    query,
    limit,
    offset,
    (artist, q) => normalizeLocalStreamingQuery(artist.name).includes(q),
    (artist): MediaProviderArtistSummary => ({
      id: artist.name,
      name: artist.name,
      picUrl: artist.cover,
      musicSize: artist.trackCount
    })
  )

  return { artists: result.items, total: result.total }
}
