import type { Track } from '../types/music'

export interface LocalGridSearchItem {
  name: string
  path?: string
  artist?: string
  tracks?: Track[]
}

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

const searchBlobByTrack = new WeakMap<Track, string>()

/**
 * Per-track normalized search blob (`title\0artist\0album`), cached by track
 * identity. Tracks are immutable snapshots replaced wholesale by the store, so
 * identity-keyed caching stays valid for the track's lifetime. The \u0000
 * separator cannot appear in a normalized query, which blocks cross-field
 * substring matches.
 */
export function getTrackSearchBlob(track: Track): string {
  let blob = searchBlobByTrack.get(track)
  if (blob === undefined) {
    blob = [
      normalizeSearchText(track.title),
      normalizeSearchText(track.artist),
      normalizeSearchText(track.album)
    ].join('\u0000')
    searchBlobByTrack.set(track, blob)
  }
  return blob
}

function includesQuery(value: string | undefined | null, query: string): boolean {
  return typeof value === 'string' && normalizeSearchText(value).includes(query)
}

export function filterLocalGridItems<T extends LocalGridSearchItem>(
  items: T[],
  query: string
): T[] {
  const q = normalizeSearchText(query.trim())
  if (!q) return items

  return items.filter((item) => {
    if (
      includesQuery(item.name, q) ||
      includesQuery(item.path, q) ||
      includesQuery(item.artist, q)
    ) {
      return true
    }

    return (
      item.tracks?.some(
        (track) =>
          includesQuery(track.title, q) ||
          includesQuery(track.artist, q) ||
          includesQuery(track.album, q) ||
          includesQuery(track.fileName, q) ||
          includesQuery(track.filePath, q)
      ) === true
    )
  })
}
