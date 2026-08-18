import type { ListeningTrackStat } from '../stores/useListeningStatsStore'
import type { Track } from '../types/music'
import { getLogicalTrackKey } from './logicalTrackIdentity.ts'
import { buildLogicalTracks, getTrackSource, type LogicalTrack } from './logicalTrackModel.ts'

export type UnifiedRecentStat = ListeningTrackStat & { id: string }

export function resolveUnifiedRecentTracks({
  recentStats,
  localTracks
}: {
  recentStats: UnifiedRecentStat[]
  localTracks: Track[]
}): Track[] {
  const resolveTrack = createUnifiedRecentTrackResolver(localTracks)
  const tracks: Track[] = []
  const seen = new Set<string>()

  for (const stat of recentStats) {
    const resolved = resolveTrack(stat)
    const seenKey = getLogicalTrackKey(stat)
    if (!resolved || seen.has(seenKey)) continue
    seen.add(seenKey)
    tracks.push(resolved)
  }

  return tracks
}

interface UnifiedRecentResolverIndexes {
  tracks: Track[]
  localById: Map<string, Track>
  localByLogicalKey: Map<string, LogicalTrack>
}

let cachedResolverIndexes: UnifiedRecentResolverIndexes | null = null
let resolverRebuildCount = 0

/**
 * The music store replaces `tracks` wholesale (`setTracks` is its only write
 * point), so array identity is a valid cache key: one full logical-track merge
 * per library revision, shared by every component that resolves recent stats.
 */
export function createUnifiedRecentTrackResolver(
  localTracks: Track[]
): (stat: UnifiedRecentStat) => Track | null {
  if (cachedResolverIndexes?.tracks !== localTracks) {
    cachedResolverIndexes = {
      tracks: localTracks,
      localById: buildLocalTrackIdMap(localTracks),
      localByLogicalKey: buildLocalLogicalTrackMap(localTracks)
    }
    resolverRebuildCount += 1
  }
  const indexes = cachedResolverIndexes
  return (stat) => resolveRecentTrack(stat, indexes.localById, indexes.localByLogicalKey)
}

export function getUnifiedRecentResolverRebuildCount(): number {
  return resolverRebuildCount
}

export function resetUnifiedRecentResolverCacheForTests(): void {
  cachedResolverIndexes = null
  resolverRebuildCount = 0
}

function resolveRecentTrack(
  stat: UnifiedRecentStat,
  localById: Map<string, Track>,
  localByLogicalKey: Map<string, LogicalTrack>
): Track | null {
  for (const source of stat.sourceIds ?? []) {
    const localTrack = localById.get(source.trackId)
    const localLogicalTrack = localTrack
      ? localByLogicalKey.get(getLogicalTrackKey(localTrack))
      : undefined
    if (localLogicalTrack) return localLogicalTrack.preferredTrack
    if (localTrack) return localTrack
  }

  const localVariant = localByLogicalKey.get(getLogicalTrackKey(stat))
  if (localVariant) return localVariant.preferredTrack

  if (!stat.track) return null
  return getTrackSource(stat.track) === 'local' ? null : stat.track
}

function buildLocalTrackIdMap(localTracks: Track[]): Map<string, Track> {
  const result = new Map<string, Track>()
  for (const track of localTracks) {
    result.set(track.id, track)
  }
  return result
}

function* localLogicalTrackInputs(localTracks: Track[]) {
  for (const track of localTracks) {
    yield {
      track,
      source: 'local' as const,
      sourceName: '本地音乐',
      providerAvailable: true
    }
  }
}

function buildLocalLogicalTrackMap(localTracks: Track[]): Map<string, LogicalTrack> {
  const result = new Map<string, LogicalTrack>()
  for (const logicalTrack of buildLogicalTracks(localLogicalTrackInputs(localTracks))) {
    if (!result.has(logicalTrack.id)) result.set(logicalTrack.id, logicalTrack)
  }
  return result
}
