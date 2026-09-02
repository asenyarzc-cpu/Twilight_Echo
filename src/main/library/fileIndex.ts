import { dirname, join } from 'path'
import {
  LOCAL_LIBRARY_FILE_INDEX_SCHEMA_VERSION,
  type LocalLibraryFileIdentity,
  type LocalLibraryFileIndexDocument
} from '../../shared/localLibraryScan.ts'
import {
  loadJsonFileWithBackup,
  writeJsonValueAtomic,
  type JsonFileLoadResult,
  type JsonFileOptions
} from '../persistence/jsonFile.ts'
import { normalizeLibraryFilePath } from './libraryRepository.ts'

const MAX_LIBRARY_FILE_INDEX_BYTES = 64 * 1024 * 1024

export interface LoadedLocalLibraryFileIndex {
  status: JsonFileLoadResult<LocalLibraryFileIndexDocument>['status']
  document: LocalLibraryFileIndexDocument
  migrated: boolean
  recovery?: Extract<JsonFileLoadResult<LocalLibraryFileIndexDocument>, { status: 'recovered' }>
}

const LOCAL_LIBRARY_FILE_INDEX_OPTIONS: JsonFileOptions<LocalLibraryFileIndexDocument> = {
  label: 'music library file index',
  maxBytes: MAX_LIBRARY_FILE_INDEX_BYTES,
  validate: isLocalLibraryFileIndexDocument
}

export function getLocalLibraryFileIndexPath(libraryFilePath: string): string {
  return join(dirname(libraryFilePath), 'music-library-file-index.json')
}

export function createEmptyLocalLibraryFileIndex(
  libraryRevision = 0
): LocalLibraryFileIndexDocument {
  return {
    version: LOCAL_LIBRARY_FILE_INDEX_SCHEMA_VERSION,
    libraryRevision: normalizeRevision(libraryRevision),
    updatedAt: new Date(0).toISOString(),
    entries: []
  }
}

export function loadLocalLibraryFileIndex(libraryFilePath: string): LoadedLocalLibraryFileIndex {
  const filePath = getLocalLibraryFileIndexPath(libraryFilePath)
  const loaded = loadJsonFileWithBackup(filePath, LOCAL_LIBRARY_FILE_INDEX_OPTIONS)
  if (loaded.status === 'missing') {
    return {
      status: 'missing',
      document: createEmptyLocalLibraryFileIndex(),
      migrated: false
    }
  }

  const document = normalizeLocalLibraryFileIndex(loaded.value)
  return {
    status: loaded.status,
    document,
    migrated: !sameFileIndexDocument(loaded.value, document),
    recovery: loaded.status === 'recovered' ? loaded : undefined
  }
}

export function persistLocalLibraryFileIndex(
  libraryFilePath: string,
  document: LocalLibraryFileIndexDocument
): void {
  const normalized = normalizeLocalLibraryFileIndex(document)
  writeJsonValueAtomic(
    getLocalLibraryFileIndexPath(libraryFilePath),
    normalized,
    LOCAL_LIBRARY_FILE_INDEX_OPTIONS
  )
}

export function synchronizeLocalLibraryFileIndexRevision(
  libraryFilePath: string,
  libraryRevision: number
): void {
  const loaded = loadLocalLibraryFileIndex(libraryFilePath)
  if (loaded.status === 'missing') return
  const nextRevision = normalizeRevision(libraryRevision)
  if (!loaded.migrated && loaded.document.libraryRevision === nextRevision) return
  persistLocalLibraryFileIndex(libraryFilePath, {
    ...loaded.document,
    libraryRevision: nextRevision,
    updatedAt: new Date().toISOString()
  })
}

export function resetLocalLibraryFileIndex(libraryFilePath: string, libraryRevision: number): void {
  persistLocalLibraryFileIndex(libraryFilePath, {
    ...createEmptyLocalLibraryFileIndex(libraryRevision),
    updatedAt: new Date().toISOString()
  })
}

export function normalizeLocalLibraryFileIndex(value: unknown): LocalLibraryFileIndexDocument {
  const record = isRecord(value) ? value : {}
  const entries = Array.isArray(record.entries) ? record.entries : []
  const byPath = new Map<string, LocalLibraryFileIdentity>()
  for (const value of entries) {
    const identity = normalizeFileIdentity(value)
    if (!identity) continue
    byPath.set(normalizeLibraryFilePath(identity.filePath), identity)
  }
  return {
    version: LOCAL_LIBRARY_FILE_INDEX_SCHEMA_VERSION,
    libraryRevision: normalizeRevision(record.libraryRevision),
    updatedAt:
      typeof record.updatedAt === 'string' && record.updatedAt
        ? record.updatedAt
        : new Date(0).toISOString(),
    entries: Array.from(byPath.values())
  }
}

export function createLocalLibraryFileIndexMap(
  entries: LocalLibraryFileIdentity[]
): Map<string, LocalLibraryFileIdentity> {
  return new Map(entries.map((entry) => [normalizeLibraryFilePath(entry.filePath), entry] as const))
}

export function sameLocalLibraryFileIdentity(
  left: LocalLibraryFileIdentity | undefined,
  right: LocalLibraryFileIdentity | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.cueSignature === right.cueSignature
  )
}

export function isLocalLibraryFileIndexDocument(
  value: unknown
): value is LocalLibraryFileIndexDocument {
  if (!isRecord(value) || value.version !== LOCAL_LIBRARY_FILE_INDEX_SCHEMA_VERSION) return false
  if (
    typeof value.libraryRevision !== 'number' ||
    !Number.isSafeInteger(value.libraryRevision) ||
    value.libraryRevision < 0
  ) {
    return false
  }
  if (typeof value.updatedAt !== 'string' || !Array.isArray(value.entries)) return false
  return value.entries.every((entry) => normalizeFileIdentity(entry) !== null)
}

function normalizeFileIdentity(value: unknown): LocalLibraryFileIdentity | null {
  if (!isRecord(value) || typeof value.filePath !== 'string' || !value.filePath) return null
  const size = Number(value.size)
  const mtimeMs = Number(value.mtimeMs)
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtimeMs) || mtimeMs < 0)
    return null
  const identity: LocalLibraryFileIdentity = {
    filePath: value.filePath,
    size,
    mtimeMs
  }
  if (typeof value.cueSignature === 'string' && value.cueSignature) {
    identity.cueSignature = value.cueSignature
  }
  return identity
}

function normalizeRevision(value: unknown): number {
  const revision = Number(value)
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
}

function sameFileIndexDocument(
  left: LocalLibraryFileIndexDocument,
  right: LocalLibraryFileIndexDocument
): boolean {
  if (
    left.version !== right.version ||
    left.libraryRevision !== right.libraryRevision ||
    left.updatedAt !== right.updatedAt ||
    left.entries.length !== right.entries.length
  ) {
    return false
  }
  return left.entries.every((entry, index) => {
    const other = right.entries[index]
    return (
      other?.filePath === entry.filePath &&
      other.size === entry.size &&
      other.mtimeMs === entry.mtimeMs &&
      other.cueSignature === entry.cueSignature
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
