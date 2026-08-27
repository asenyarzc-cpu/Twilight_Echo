import type { LocalLibraryExclusion, LocalMusicLibraryDocument } from './localLibrary.ts'

export const LOCAL_LIBRARY_FILE_INDEX_SCHEMA_VERSION = 1 as const

export type LocalLibraryScanMode = 'startup' | 'full' | 'watch'
export type LocalLibraryScanState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface LocalLibraryFileIdentity {
  filePath: string
  size: number
  mtimeMs: number
  /** Hash of sibling CUE names/sizes/mtimes; omitted when the directory has no CUE sheet. */
  cueSignature?: string
}

export interface LocalLibraryFileIndexDocument {
  version: typeof LOCAL_LIBRARY_FILE_INDEX_SCHEMA_VERSION
  libraryRevision: number
  updatedAt: string
  entries: LocalLibraryFileIdentity[]
}

export interface LocalLibraryWatchChange {
  /** File add/remove, or a directory/root reconcile that needs a complete identity snapshot. */
  kind: 'add' | 'remove' | 'reconcile'
  path: string
}

export interface LocalLibraryWorkerScanRequest {
  mode: LocalLibraryScanMode
  roots: string[]
  knownIdentities: LocalLibraryFileIdentity[]
  knownTrackPaths: string[]
  excludedPaths: string[]
  coverCacheDir: string
  // A missing or stale file index cannot prove that a persisted Track still
  // represents the bytes currently present at its path. Reconcile once.
  forceParse?: boolean
  changes?: LocalLibraryWatchChange[]
}

export interface LocalLibraryWorkerScanResult {
  mode: LocalLibraryScanMode
  completeIdentitySnapshot: boolean
  identities: LocalLibraryFileIdentity[]
  parsedTracks: unknown[]
  parsedFilePaths: string[]
  removedFilePaths: string[]
  skippedUnchanged: number
  parsedFileCount: number
  cancelled: boolean
}

export interface LocalLibraryScanProgress {
  jobId: string
  mode: LocalLibraryScanMode
  phase: 'enumerating' | 'parsing'
  current: number
  total: number
  parsedFileCount: number
  skippedUnchanged: number
}

export interface LocalLibraryScanStatus {
  jobId: string | null
  mode: LocalLibraryScanMode | null
  state: LocalLibraryScanState
  current: number
  total: number
  parsedFileCount: number
  skippedUnchanged: number
  error: string
}

export interface LocalLibraryScanResult {
  jobId: string
  mode: LocalLibraryScanMode
  state: Extract<LocalLibraryScanState, 'completed' | 'cancelled'>
  library: LocalMusicLibraryDocument
  addedTracks: unknown[]
  updatedTracks: unknown[]
  removedFilePaths: string[]
  parsedFileCount: number
  skippedUnchanged: number
}

export interface LocalLibraryScanUpdate {
  jobId: string
  mode: LocalLibraryScanMode
  state: Extract<LocalLibraryScanState, 'completed' | 'cancelled'>
  libraryRevision: number
  exclusions: LocalLibraryExclusion[]
  addedTracks: unknown[]
  updatedTracks: unknown[]
  removedFilePaths: string[]
  parsedFileCount: number
  skippedUnchanged: number
}

export type LocalLibraryScanWorkerRequest =
  | {
      kind: 'scan'
      requestId: string
      request: LocalLibraryWorkerScanRequest
    }
  | { kind: 'pause'; requestId: string }
  | { kind: 'resume'; requestId: string }
  | { kind: 'cancel'; requestId: string }

export type LocalLibraryScanWorkerMessage =
  | { kind: 'ready' }
  | {
      kind: 'progress'
      requestId: string
      progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>
    }
  | { kind: 'response'; requestId: string; ok: true; value: LocalLibraryWorkerScanResult }
  | { kind: 'response'; requestId: string; ok: false; error: string }

export type LibraryWatcherState = 'active' | 'degraded' | 'failed' | 'disabled'
export type LibraryWatcherMode = 'recursive' | 'polling' | 'none'

export interface LibraryWatcherFolderStatus {
  folder: string
  state: LibraryWatcherState
  mode: LibraryWatcherMode
  lastError: string | null
  lastEventAt: string | null
  lastReconcileAt: string | null
}

export interface LibraryWatcherStatusSnapshot {
  enabled: boolean
  folders: LibraryWatcherFolderStatus[]
}
