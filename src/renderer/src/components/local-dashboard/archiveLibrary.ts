import type { Track } from '@renderer/types/music'

export function buildArchiveLibrary(tracks: readonly Track[], limit = 30) {
  const indexById = new Map<string, number>()
  const latest: Array<{ track: Track; position: number; addedAt: number }> = []
  let totalSeconds = 0
  for (let position = 0; position < tracks.length; position += 1) {
    const track = tracks[position]
    indexById.set(track.id, position)
    totalSeconds += Math.max(0, track.duration || 0)
    const entry = { track, position, addedAt: track.addedAt || 0 }
    let low = 0
    let high = latest.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const candidate = latest[middle]
      if (
        candidate.addedAt > entry.addedAt ||
        (candidate.addedAt === entry.addedAt && candidate.position > entry.position)
      ) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    if (low < limit) {
      latest.splice(low, 0, entry)
      if (latest.length > limit) latest.pop()
    }
  }
  return { indexById, totalSeconds, recentlyAdded: latest.map((entry) => entry.track) }
}

export function archivePlaybackQueue(
  tracks: readonly Track[],
  indexById: ReadonlyMap<string, number>,
  track: Track
): Track[] {
  const index = indexById.get(track.id)
  if (index === undefined) return [track]
  const start = Math.max(0, Math.min(index - 100, tracks.length - 200))
  return tracks.slice(start, start + 200)
}
