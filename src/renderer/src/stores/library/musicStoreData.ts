import type { Track } from '../../types/music'
import type { DerivedTrackGroup, Playlist } from '../useMusicStore.ts'

export function getAlbumIdentity(track: Track): string {
  const albumId = track.albumId?.trim()
  if (albumId) return `id:${albumId}`

  const album = normalizeAlbumIdentityText(track.album || '未知专辑')
  const albumArtist = track.albumArtist?.trim()
  const artist = track.artist?.trim()
  // Older scans copied track artist into albumArtist whenever ALBUMARTIST was
  // missing. Treat that pollution as "no album artist" so guest/feat tracks
  // from the same release still land on one album card.
  const hasDistinctAlbumArtist =
    !!albumArtist && (!artist || albumArtist.toLocaleLowerCase() !== artist.toLocaleLowerCase())

  if (hasDistinctAlbumArtist) {
    return `name:${albumArtist.toLocaleLowerCase()}\u001f${album}`
  }

  // Prefer the exact release directory so multi-artist albums without
  // ALBUMARTIST merge, while same-titled albums in unrelated folders stay separate.
  const dir = track.dir?.trim() || parentDirectoryOf(track.filePath)
  if (dir) {
    return `dir:${normalizeLibraryPath(dir)}\u001f${album}`
  }

  return `name:${(albumArtist || artist || '未知艺术家').trim().toLocaleLowerCase()}\u001f${album}`
}

export function normalizeAlbumIdentityText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function mergeAlbumGroupsByReleaseEvidence(
  albumMap: Map<string, DerivedTrackGroup>
): Map<string, DerivedTrackGroup> {
  const result = new Map<string, DerivedTrackGroup>()
  const fallbackIdByReleaseEvidence = new Map<string, string>()

  for (const [id, group] of albumMap) {
    if (!id.startsWith('dir:')) {
      result.set(id, group)
      continue
    }

    const firstTrack = group.tracks[0]
    const coverTrack = group.tracks.find((track) => !!track.cover)
    const coverIdentity = coverTrack ? getAlbumCoverIdentity(coverTrack) : ''
    if (!firstTrack || !coverIdentity) {
      result.set(id, group)
      continue
    }

    // Local releases are often stored in one directory per track, without an
    // ancestor directory whose name matches the album tag. In that layout the
    // normalized album title plus identical artwork is the strongest shared
    // release evidence available. Explicit album ids and album artists never
    // enter this fallback path, so their authoritative separation is preserved.
    const album = normalizeAlbumIdentityText(firstTrack.album || '未知专辑')
    const evidenceKey = `${coverIdentity}\u001f${album}`
    const targetId = fallbackIdByReleaseEvidence.get(evidenceKey)
    if (!targetId) {
      fallbackIdByReleaseEvidence.set(evidenceKey, id)
      result.set(id, group)
      continue
    }

    const target = result.get(targetId)
    if (!target) {
      result.set(id, group)
      continue
    }
    target.tracks.push(...group.tracks)
    target.cover ||= group.cover
  }

  return result
}

export function getAlbumCoverIdentity(track: Track): string {
  const cover = track.cover?.trim()
  if (!cover) return ''
  const durableSource = track.coverSource?.trim()
  if (/^twilight-media:\/\/image\//i.test(cover) && durableSource) {
    return durableSource.toLocaleLowerCase()
  }
  return cover.toLocaleLowerCase()
}

export function compareAlbumTrackOrder(left: Track, right: Track): number {
  const disc = albumOrderIndex(left.discNumber) - albumOrderIndex(right.discNumber)
  if (disc !== 0) return disc
  const track = albumOrderIndex(left.trackNumber) - albumOrderIndex(right.trackNumber)
  if (track !== 0) return track
  const byFile = (left.fileName || '').localeCompare(right.fileName || '', 'zh', {
    numeric: true,
    sensitivity: 'base'
  })
  if (byFile !== 0) return byFile
  return (left.title || '').localeCompare(right.title || '', 'zh')
}

export function albumOrderIndex(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : Number.MAX_SAFE_INTEGER
}

export function parentDirectoryOf(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  const separator = normalized.lastIndexOf('\\')
  if (separator <= 0) return ''
  return normalized.slice(0, separator)
}

export function deduplicateLibraryPaths(paths: readonly string[]): string[] {
  const values = new Map<string, string>()
  for (const path of paths) {
    const trimmed = path.trim()
    const normalized = normalizeLibraryPath(trimmed)
    if (trimmed && normalized && !values.has(normalized)) values.set(normalized, trimmed)
  }
  return [...values.values()]
}

export function normalizeLibraryPath(path: string): string {
  return path
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLocaleLowerCase()
}

export function isTrackUnderLibraryRoot(filePath: string, normalizedRoot: string): boolean {
  const normalizedFilePath = normalizeLibraryPath(filePath)
  return (
    normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}\\`)
  )
}

export function toPlaylistTrackSnapshot(track: Track): Track {
  if (track.source && track.source !== 'local') {
    const { streamUrl: _streamUrl, ...snapshot } = track
    return snapshot
  }
  return {
    ...track
  }
}

/**
 * Replays one local playlist transaction onto the latest authoritative state.
 * The caller supplies the state just before and just after the local action;
 * unrelated concurrent playlists and track additions remain untouched.
 */
export function replayPlaylistTransaction(
  base: Playlist[],
  local: Playlist[],
  authoritative: Playlist[]
): Playlist[] {
  const baseById = new Map(base.map((playlist) => [playlist.id, playlist]))
  const localById = new Map(local.map((playlist) => [playlist.id, playlist]))
  const merged = new Map(authoritative.map((playlist) => [playlist.id, clonePlaylist(playlist)]))

  // An id present in the base but absent locally was explicitly deleted.
  for (const playlist of base) {
    if (!localById.has(playlist.id)) merged.delete(playlist.id)
  }

  for (const localPlaylist of local) {
    const basePlaylist = baseById.get(localPlaylist.id)
    const current = merged.get(localPlaylist.id)
    if (!basePlaylist) {
      // Playlist ids are generated locally; an id collision is extraordinarily
      // unlikely, but local creation still wins rather than silently dropping it.
      merged.set(localPlaylist.id, clonePlaylist(localPlaylist))
      continue
    }
    if (!current) {
      // Preserve an authoritative deletion when the local playlist did not
      // change. Restore it only when this transaction actually changed it.
      if (!playlistDataEqual(basePlaylist, localPlaylist)) {
        merged.set(localPlaylist.id, clonePlaylist(localPlaylist))
      }
      continue
    }
    merged.set(localPlaylist.id, replayPlaylistRecord(basePlaylist, localPlaylist, current))
  }

  const ordered = authoritative
    .map((playlist) => merged.get(playlist.id))
    .filter((playlist): playlist is Playlist => !!playlist)
  const known = new Set(ordered.map((playlist) => playlist.id))
  for (const playlist of local) {
    const next = merged.get(playlist.id)
    if (next && !known.has(next.id)) {
      ordered.push(next)
      known.add(next.id)
    }
  }
  return ordered
}

export function replayPlaylistRecord(base: Playlist, local: Playlist, current: Playlist): Playlist {
  const next: Playlist = clonePlaylist(current)
  if (base.name !== local.name) next.name = local.name
  if (base.isDefault !== local.isDefault) next.isDefault = local.isDefault
  if (base.createdAt !== local.createdAt) next.createdAt = local.createdAt
  if (base.cover !== local.cover) next.cover = local.cover
  if (base.updatedAt !== local.updatedAt) next.updatedAt = local.updatedAt

  const baseIds = new Set(base.trackIds)
  const localIds = new Set(local.trackIds)
  const locallyRemoved = new Set(base.trackIds.filter((id) => !localIds.has(id)))
  const locallyAdded = local.trackIds.filter((id) => !baseIds.has(id))
  let nextIds = current.trackIds.filter((id) => !locallyRemoved.has(id))
  const nextIdSet = new Set(nextIds)
  for (const id of locallyAdded) {
    if (!nextIdSet.has(id)) {
      nextIds.push(id)
      nextIdSet.add(id)
    }
  }
  // A deliberate local reordering is a full order intent for the ids that
  // existed at transaction start. Keep concurrently-added ids, but append
  // them after the locally ordered stable sequence rather than dropping them.
  const baseSet = new Set(base.trackIds)
  const localBaseOrder = local.trackIds.filter((id) => baseSet.has(id) && nextIdSet.has(id))
  const baseOrder = base.trackIds.filter((id) => nextIdSet.has(id))
  if (!playlistDataEqual(localBaseOrder, baseOrder)) {
    const orderedIds = new Set(localBaseOrder)
    nextIds = [
      ...localBaseOrder,
      ...nextIds.filter((id) => !baseSet.has(id) && !orderedIds.has(id))
    ]
  }
  next.trackIds = nextIds

  const baseSnapshots = base.trackSnapshots ?? {}
  const localSnapshots = local.trackSnapshots ?? {}
  const snapshots: Record<string, Track> = { ...(current.trackSnapshots ?? {}) }
  for (const id of locallyRemoved) delete snapshots[id]
  for (const [id, snapshot] of Object.entries(localSnapshots)) {
    const before = baseSnapshots[id]
    if (!before || !playlistDataEqual(before, snapshot)) snapshots[id] = clonePlaylist(snapshot)
  }
  for (const id of Object.keys(baseSnapshots)) {
    if (!localSnapshots[id] && localIds.has(id)) delete snapshots[id]
  }
  for (const id of Object.keys(snapshots)) {
    if (!nextIdSet.has(id)) delete snapshots[id]
  }
  next.trackSnapshots = Object.keys(snapshots).length > 0 ? snapshots : undefined
  return next
}

export function clonePlaylist<T>(value: T): T {
  // Callers may pass Vue reactive sources; the JSON round-trip reads through
  // proxy traps, which structuredClone rejects in Chromium.
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Structural equality with JSON semantics: undefined-valued properties compare
 * equal to absent properties, so snapshots cloned in memory match their
 * JSON-persisted counterparts without building comparison strings.
 */
export function playlistDataEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!playlistDataEqual(left[index], right[index])) return false
    }
    return true
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return left === right
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  for (const key of Object.keys(leftRecord)) {
    if (leftRecord[key] === undefined) continue
    if (!playlistDataEqual(leftRecord[key], rightRecord[key])) return false
  }
  for (const key of Object.keys(rightRecord)) {
    if (rightRecord[key] === undefined) continue
    if (leftRecord[key] === undefined) return false
  }
  return true
}

export function normalizePortableLibraryPath(filePath: string): string {
  const normalized = filePath.replace(/\//g, '\\').replace(/\\+/g, '\\')
  return /^[a-zA-Z]:\\/.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function isLocalLibraryTrack(value: unknown): value is Track {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const track = value as Partial<Track>
  return (
    typeof track.id === 'string' &&
    track.id.length > 0 &&
    typeof track.filePath === 'string' &&
    track.filePath.length > 0 &&
    typeof track.title === 'string' &&
    typeof track.artist === 'string' &&
    typeof track.album === 'string' &&
    (track.source === undefined || track.source === 'local')
  )
}
