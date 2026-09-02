import { normalize, resolve } from 'path'
import {
  loadJsonFileWithBackup,
  writeJsonValueAtomic,
  type JsonFileLoadResult,
  type JsonFileOptions
} from '../persistence/jsonFile.ts'
import {
  LOCAL_MUSIC_LIBRARY_SCHEMA_VERSION,
  type LocalLibraryExclusion,
  type LocalLibrarySnapshotInput,
  type LocalLibraryTrackSelection,
  type LocalMusicLibraryDocument
} from '../../shared/localLibrary.ts'

export const MAX_MUSIC_LIBRARY_BYTES = 100 * 1024 * 1024

export type PersistedMusicLibraryFile =
  | unknown[]
  | {
      version?: unknown
      revision?: unknown
      tracks: unknown[]
      folders?: unknown[]
      exclusions?: unknown[]
    }

export interface LoadedMusicLibraryDocument {
  status: JsonFileLoadResult<PersistedMusicLibraryFile>['status']
  document: LocalMusicLibraryDocument
  migrated: boolean
  recovery?: Extract<JsonFileLoadResult<PersistedMusicLibraryFile>, { status: 'recovered' }>
}

export const MUSIC_LIBRARY_JSON_OPTIONS: JsonFileOptions<PersistedMusicLibraryFile> = {
  label: 'music library',
  maxBytes: MAX_MUSIC_LIBRARY_BYTES,
  validate: isPersistedMusicLibraryFile
}

let activeExclusionKeys = new Set<string>()
const activeMutationPathCounts = new Map<string, number>()

export function createEmptyMusicLibraryDocument(): LocalMusicLibraryDocument {
  return {
    version: LOCAL_MUSIC_LIBRARY_SCHEMA_VERSION,
    revision: 0,
    tracks: [],
    folders: [],
    exclusions: []
  }
}

export function isPersistedMusicLibraryFile(value: unknown): value is PersistedMusicLibraryFile {
  if (Array.isArray(value)) return true
  if (!isRecord(value) || !Array.isArray(value.tracks)) return false
  if (value.folders !== undefined && !Array.isArray(value.folders)) return false
  if (value.exclusions !== undefined && !Array.isArray(value.exclusions)) return false
  return (
    value.version === undefined ||
    value.version === 1 ||
    value.version === LOCAL_MUSIC_LIBRARY_SCHEMA_VERSION
  )
}

export function migrateMusicLibraryFile(value: PersistedMusicLibraryFile): {
  document: LocalMusicLibraryDocument
  migrated: boolean
} {
  if (Array.isArray(value)) {
    return {
      document: {
        version: LOCAL_MUSIC_LIBRARY_SCHEMA_VERSION,
        revision: 0,
        tracks: value,
        folders: [],
        exclusions: []
      },
      migrated: true
    }
  }

  const folders =
    value.folders?.filter((folder): folder is string => typeof folder === 'string') ?? []
  const exclusions = normalizeLibraryExclusions(value.exclusions ?? [])
  const revision = normalizeLibraryRevision(value.revision)
  const hasNormalizedFolders = folders.length === (value.folders?.length ?? 0)
  const hasNormalizedExclusions = exclusions.length === (value.exclusions?.length ?? 0)
  const invariant = enforceMusicLibraryExclusionInvariant({
    version: LOCAL_MUSIC_LIBRARY_SCHEMA_VERSION,
    revision,
    tracks: value.tracks,
    folders,
    exclusions
  })

  return {
    document: invariant.document,
    migrated:
      value.version !== LOCAL_MUSIC_LIBRARY_SCHEMA_VERSION ||
      value.revision !== revision ||
      !hasNormalizedFolders ||
      !hasNormalizedExclusions ||
      invariant.changed
  }
}

/**
 * Convert legacy embedded cover data without coupling the repository module to
 * Electron/nativeImage. The main-process IPC layer supplies the cache writer.
 */
export function migrateMusicLibraryCovers(
  document: LocalMusicLibraryDocument,
  migrateCover: (dataUrl: string) => string | null
): boolean {
  let changed = false
  document.tracks = document.tracks.map((track) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) return track
    const record = track as Record<string, unknown>
    if (typeof record.cover !== 'string' || !/^data:image\//i.test(record.cover)) return track
    const handle = migrateCover(record.cover)
    if (!handle) return track
    changed = true
    return { ...record, cover: handle }
  })
  return changed
}

export function createMusicLibraryDocument(
  library: LocalLibrarySnapshotInput,
  exclusions: LocalLibraryExclusion[]
): LocalMusicLibraryDocument {
  return enforceMusicLibraryExclusionInvariant({
    version: LOCAL_MUSIC_LIBRARY_SCHEMA_VERSION,
    revision: normalizeLibraryRevision(library.revision),
    tracks: Array.isArray(library.tracks) ? library.tracks : [],
    folders: Array.isArray(library.folders)
      ? library.folders.filter((folder): folder is string => typeof folder === 'string')
      : [],
    exclusions: normalizeLibraryExclusions(exclusions)
  }).document
}

export function enforceMusicLibraryExclusionInvariant(document: LocalMusicLibraryDocument): {
  document: LocalMusicLibraryDocument
  removedTrackIds: string[]
  changed: boolean
} {
  const excludedPaths = new Set(
    document.exclusions.map((exclusion) => normalizeLibraryFilePath(exclusion.filePath))
  )
  if (excludedPaths.size === 0) {
    return { document, removedTrackIds: [], changed: false }
  }

  const removedTrackIds: string[] = []
  const tracks = document.tracks.filter((track) => {
    if (!isRecord(track) || typeof track.filePath !== 'string' || !track.filePath) return true
    if (!excludedPaths.has(normalizeLibraryFilePath(track.filePath))) return true
    if (typeof track.id === 'string') removedTrackIds.push(track.id)
    return false
  })
  if (tracks.length === document.tracks.length) {
    return { document, removedTrackIds, changed: false }
  }
  return {
    document: { ...document, tracks },
    removedTrackIds,
    changed: true
  }
}

export function loadMusicLibraryDocument(filePath: string): LoadedMusicLibraryDocument {
  const loaded = loadJsonFileWithBackup(filePath, MUSIC_LIBRARY_JSON_OPTIONS)
  if (loaded.status === 'missing') {
    return {
      status: 'missing',
      document: createEmptyMusicLibraryDocument(),
      migrated: false
    }
  }

  const migrated = migrateMusicLibraryFile(loaded.value)
  return {
    status: loaded.status,
    document: migrated.document,
    migrated: migrated.migrated,
    recovery: loaded.status === 'recovered' ? loaded : undefined
  }
}

export function persistMusicLibraryDocument(
  filePath: string,
  document: LocalMusicLibraryDocument
): void {
  const normalized = createMusicLibraryDocument(document, document.exclusions)
  writeJsonValueAtomic(filePath, normalized, MUSIC_LIBRARY_JSON_OPTIONS)
  replaceActiveLibraryExclusions(normalized.exclusions)
}

export function normalizeLibraryFilePath(filePath: string): string {
  const normalized = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function replaceActiveLibraryExclusions(exclusions: LocalLibraryExclusion[]): void {
  activeExclusionKeys = new Set(
    exclusions.map((exclusion) => normalizeLibraryFilePath(exclusion.filePath))
  )
}

export function isActiveLibraryPathExcluded(filePath: string): boolean {
  return activeExclusionKeys.has(normalizeLibraryFilePath(filePath))
}

export function beginLibraryPathMutation(filePaths: string[]): () => void {
  const keys = Array.from(new Set(filePaths.map(normalizeLibraryFilePath)))
  for (const key of keys) {
    activeMutationPathCounts.set(key, (activeMutationPathCounts.get(key) ?? 0) + 1)
  }
  return () => {
    for (const key of keys) {
      const remaining = (activeMutationPathCounts.get(key) ?? 1) - 1
      if (remaining > 0) activeMutationPathCounts.set(key, remaining)
      else activeMutationPathCounts.delete(key)
    }
  }
}

export function isLibraryPathMutationInProgress(filePath: string): boolean {
  return activeMutationPathCounts.has(normalizeLibraryFilePath(filePath))
}

export function collectLibraryTrackPathKeys(document: LocalMusicLibraryDocument): Set<string> {
  const paths = new Set<string>()
  for (const track of document.tracks) {
    if (!isRecord(track) || typeof track.filePath !== 'string' || !track.filePath) continue
    paths.add(normalizeLibraryFilePath(track.filePath))
  }
  return paths
}

export function assertMusicLibraryRevision(expected: number, actual: number): void {
  if (expected === actual) return
  const error = new Error(
    `Music library changed concurrently (expected revision ${expected}, current ${actual})`
  )
  error.name = 'MusicLibraryRevisionConflictError'
  throw error
}

export function applySuccessfulLibraryRemoval(
  document: LocalMusicLibraryDocument,
  successfulItems: LocalLibraryTrackSelection[],
  addExclusions: boolean,
  excludedAt = new Date().toISOString()
): {
  document: LocalMusicLibraryDocument
  removedTrackIds: string[]
  removedFilePaths: string[]
} {
  const selectedByPath = new Map<string, LocalLibraryTrackSelection>()
  for (const item of successfulItems) {
    if (!item.filePath) continue
    selectedByPath.set(normalizeLibraryFilePath(item.filePath), item)
  }

  const removedTrackIds: string[] = []
  const removedPathValues = new Map<string, string>()
  const remainingTracks = document.tracks.filter((track) => {
    const record = isRecord(track) ? track : null
    const filePath = typeof record?.filePath === 'string' ? record.filePath : ''
    if (!filePath) return true
    const key = normalizeLibraryFilePath(filePath)
    if (!selectedByPath.has(key)) return true
    if (typeof record?.id === 'string') removedTrackIds.push(record.id)
    removedPathValues.set(key, filePath)
    return false
  })

  let exclusions = document.exclusions
  if (addExclusions && removedPathValues.size > 0) {
    const byPath = new Map(
      document.exclusions.map((exclusion) => [
        normalizeLibraryFilePath(exclusion.filePath),
        exclusion
      ])
    )
    for (const [key, filePath] of removedPathValues) {
      const item = selectedByPath.get(key)
      byPath.set(key, {
        filePath,
        title: item?.title || fileNameFromPath(filePath),
        artist: item?.artist || '',
        excludedAt
      })
    }
    exclusions = Array.from(byPath.values())
  }

  return {
    document: {
      version: LOCAL_MUSIC_LIBRARY_SCHEMA_VERSION,
      revision: document.revision,
      tracks: remainingTracks,
      folders: document.folders,
      exclusions
    },
    removedTrackIds,
    removedFilePaths: Array.from(removedPathValues.values())
  }
}

export function restoreLibraryExclusions(
  document: LocalMusicLibraryDocument,
  filePaths: string[]
): { document: LocalMusicLibraryDocument; restoredFilePaths: string[] } {
  const requested = new Set(filePaths.map(normalizeLibraryFilePath))
  const restoredFilePaths: string[] = []
  const exclusions = document.exclusions.filter((exclusion) => {
    if (!requested.has(normalizeLibraryFilePath(exclusion.filePath))) return true
    restoredFilePaths.push(exclusion.filePath)
    return false
  })
  return {
    document: {
      ...document,
      exclusions
    },
    restoredFilePaths
  }
}

function normalizeLibraryExclusions(value: unknown[]): LocalLibraryExclusion[] {
  const result = new Map<string, LocalLibraryExclusion>()
  for (const raw of value) {
    const exclusion = normalizeLibraryExclusion(raw)
    if (!exclusion) continue
    result.set(normalizeLibraryFilePath(exclusion.filePath), exclusion)
  }
  return Array.from(result.values())
}

function normalizeLibraryRevision(value: unknown): number {
  const revision = Number(value)
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
}

function normalizeLibraryExclusion(value: unknown): LocalLibraryExclusion | null {
  if (typeof value === 'string' && value) {
    return {
      filePath: value,
      title: fileNameFromPath(value),
      artist: '',
      excludedAt: new Date(0).toISOString()
    }
  }
  if (!isRecord(value) || typeof value.filePath !== 'string' || !value.filePath) return null
  return {
    filePath: value.filePath,
    title:
      typeof value.title === 'string' && value.title
        ? value.title
        : fileNameFromPath(value.filePath),
    artist: typeof value.artist === 'string' ? value.artist : '',
    excludedAt:
      typeof value.excludedAt === 'string' && value.excludedAt
        ? value.excludedAt
        : new Date(0).toISOString()
  }
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
