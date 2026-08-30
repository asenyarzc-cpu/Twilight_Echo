import type { Track } from '../types/music'

export type LogicalTrackIdentityInput = Pick<Track, 'id' | 'title' | 'artist'>

export function getLogicalTrackKey(track: LogicalTrackIdentityInput): string {
  const title = normalizeLogicalTrackText(track.title)
  const artist = normalizeLogicalTrackText(track.artist)
  if (!title || !artist) return track.id
  return `logic:${title}::${artist}`
}

export function normalizeLogicalTrackText(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}
