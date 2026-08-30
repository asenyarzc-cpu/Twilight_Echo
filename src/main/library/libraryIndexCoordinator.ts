import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type {
  LocalLibraryFileIdentity,
  LocalLibraryScanMode,
  LocalLibraryScanProgress,
  LocalLibraryScanResult,
  LocalLibraryScanStatus,
  LocalLibraryScanUpdate,
  LocalLibraryWatchChange,
  LocalLibraryWorkerScanResult
} from '../../shared/localLibraryScan.ts'
import type { LocalMusicLibraryDocument } from '../../shared/localLibrary.ts'
import {
  createMusicLibraryDocument,
  normalizeLibraryFilePath,
  replaceActiveLibraryExclusions,
  type LoadedMusicLibraryDocument
} from './libraryRepository.ts'
import {
  createLocalLibraryFileIndexMap,
  loadLocalLibraryFileIndex,
  persistLocalLibraryFileIndex
} from './fileIndex.ts'
import type { LocalLibraryScanRunner } from './libraryScanServiceClient.ts'

type LibraryTransaction = <T>(operation: () => Promise<T> | T) => Promise<T>

export interface LocalLibraryIndexCoordinatorOptions {
  libraryFilePath: string
  scanRunner: LocalLibraryScanRunner
  enqueueTransaction: LibraryTransaction
  loadDocument: () => LoadedMusicLibraryDocument
  persistDocument: (document: LocalMusicLibraryDocument) => void
  resolveRoots: (folders: string[]) => Promise<string[]>
  getCoverCacheDir: () => string
  watcherDebounceMs?: number
  now?: () => Date
}

type ActiveJob = {
  id: string
  mode: LocalLibraryScanMode
  cancelled: boolean
}

const DEFAULT_WATCHER_DEBOUNCE_MS = 350
const MAX_RECONCILE_ATTEMPTS = 3

export class LocalLibraryIndexCoordinator extends EventEmitter {
  private readonly options: LocalLibraryIndexCoordinatorOptions
  private readonly watcherDebounceMs: number
  private readonly now: () => Date
  private chain: Promise<void> = Promise.resolve()
  private activeJob: ActiveJob | null = null
  private readonly watcherChanges = new Map<string, LocalLibraryWatchChange>()
  private watcherTimer: NodeJS.Timeout | null = null
  private watcherScanQueued = false
  private destroyed = false
  private status: LocalLibraryScanStatus = {
    jobId: null,
    mode: null,
    state: 'idle',
    current: 0,
    total: 0,
    parsedFileCount: 0,
    skippedUnchanged: 0,
    error: ''
  }

  constructor(options: LocalLibraryIndexCoordinatorOptions) {
    super()
    this.options = options
    this.watcherDebounceMs = Math.max(25, options.watcherDebounceMs ?? DEFAULT_WATCHER_DEBOUNCE_MS)
    this.now = options.now ?? (() => new Date())
  }

  getStatus(): LocalLibraryScanStatus {
    return { ...this.status }
  }

  scanStartup(): Promise<LocalLibraryScanResult> {
    return this.enqueue('startup')
  }

  scanFull(): Promise<LocalLibraryScanResult> {
    return this.enqueue('full')
  }

  enqueueWatcherChanges(changes: LocalLibraryWatchChange[]): void {
    if (this.destroyed) return
    for (const change of changes) {
      if (!change.path) continue
      this.watcherChanges.set(normalizeLibraryFilePath(change.path), change)
    }
    if (this.watcherChanges.size === 0) return
    this.armWatcherTimer()
  }

  pause(): boolean {
    if (!this.activeJob || this.status.state !== 'running') return false
    this.options.scanRunner.pause(this.activeJob.id)
    this.setStatus({ state: 'paused' })
    return true
  }

  resume(): boolean {
    if (!this.activeJob || this.status.state !== 'paused') return false
    this.options.scanRunner.resume(this.activeJob.id)
    this.setStatus({ state: 'running' })
    return true
  }

  cancel(): boolean {
    if (!this.activeJob || (this.status.state !== 'running' && this.status.state !== 'paused')) {
      return false
    }
    this.activeJob.cancelled = true
    this.options.scanRunner.cancel(this.activeJob.id)
    return true
  }

  reportServiceError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.setStatus({ state: 'failed', error: message })
  }

  destroy(): void {
    this.destroyed = true
    if (this.watcherTimer) clearTimeout(this.watcherTimer)
    this.watcherTimer = null
    this.watcherChanges.clear()
    this.cancel()
  }

  private armWatcherTimer(): void {
    if (this.destroyed || this.watcherScanQueued || this.watcherChanges.size === 0) return
    if (this.watcherTimer) clearTimeout(this.watcherTimer)
    this.watcherTimer = setTimeout(() => {
      this.watcherTimer = null
      this.scheduleWatcherQueue()
    }, this.watcherDebounceMs)
  }

  private scheduleWatcherQueue(): void {
    if (this.destroyed || this.watcherScanQueued || this.watcherChanges.size === 0) return
    this.watcherScanQueued = true
    const operation = this.chain
      .catch(() => {})
      .then(async () => {
        if (this.destroyed || this.watcherChanges.size === 0) return
        const pending = Array.from(this.watcherChanges.values())
        this.watcherChanges.clear()
        const result = await this.execute('watch', pending)
        this.emit('watch-result', result)
      })
    this.chain = operation.then(
      () => {},
      () => {}
    )
    void operation
      .catch((error) => this.emit('scan-error', error))
      .finally(() => {
        this.watcherScanQueued = false
        this.armWatcherTimer()
      })
  }

  private enqueue(
    mode: LocalLibraryScanMode,
    changes?: LocalLibraryWatchChange[]
  ): Promise<LocalLibraryScanResult> {
    const operation = this.chain.catch(() => {}).then(() => this.execute(mode, changes))
    this.chain = operation.then(
      () => {},
      () => {}
    )
    return operation
  }

  private async execute(
    mode: LocalLibraryScanMode,
    changes?: LocalLibraryWatchChange[]
  ): Promise<LocalLibraryScanResult> {
    const job: ActiveJob = { id: randomUUID(), mode, cancelled: false }
    this.activeJob = job
    this.setStatus({
      jobId: job.id,
      mode,
      state: 'running',
      current: 0,
      total: 0,
      parsedFileCount: 0,
      skippedUnchanged: 0,
      error: ''
    })

    try {
      for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          this.setStatus({
            current: 0,
            total: 0,
            parsedFileCount: 0,
            skippedUnchanged: 0
          })
        }
        const snapshot = await this.options.enqueueTransaction(async () => {
          const loaded = this.options.loadDocument()
          const loadedIndex = loadLocalLibraryFileIndex(this.options.libraryFilePath)
          return {
            document: loaded.document,
            index: loadedIndex.document,
            forceParse:
              loadedIndex.status === 'missing' ||
              loadedIndex.migrated ||
              loadedIndex.document.libraryRevision !== loaded.document.revision
          }
        })
        const roots = await this.options.resolveRoots(snapshot.document.folders)
        if (roots.length === 0 && mode !== 'watch') {
          const committed = await this.options.enqueueTransaction(async () => {
            const current = this.options.loadDocument().document
            const currentRoots = await this.options.resolveRoots(current.folders)
            if (
              current.revision !== snapshot.document.revision ||
              !sameRootSet(roots, currentRoots)
            ) {
              return { drifted: true as const, library: current, removedFilePaths: [] }
            }

            const removedFilePaths = collectTrackPaths(current)
            const changed = current.tracks.length > 0 || current.folders.length > 0
            const nextDocument = changed
              ? {
                  ...current,
                  revision: current.revision + 1,
                  tracks: [],
                  folders: currentRoots
                }
              : current
            if (changed) this.options.persistDocument(nextDocument)
            else replaceActiveLibraryExclusions(nextDocument.exclusions)
            persistLocalLibraryFileIndex(this.options.libraryFilePath, {
              version: 1,
              libraryRevision: nextDocument.revision,
              updatedAt: this.now().toISOString(),
              entries: []
            })
            return {
              drifted: false as const,
              library: nextDocument,
              removedFilePaths
            }
          })
          if (committed.drifted) {
            if (attempt + 1 < MAX_RECONCILE_ATTEMPTS) continue
            throw new Error('Local library roots changed repeatedly while the scan was reconciling')
          }
          const result = {
            ...completeNoopResult(job.id, mode, committed.library),
            removedFilePaths: committed.removedFilePaths
          }
          this.setStatus({ state: 'completed' })
          return result
        }

        const workerResult = await this.options.scanRunner.scan(
          job.id,
          {
            mode,
            roots,
            knownIdentities: snapshot.index.entries,
            knownTrackPaths: collectTrackPaths(snapshot.document),
            excludedPaths: snapshot.document.exclusions.map((entry) => entry.filePath),
            coverCacheDir: this.options.getCoverCacheDir(),
            forceParse: snapshot.forceParse,
            changes
          },
          (progress) => this.applyProgress(job, progress)
        )
        if (workerResult.cancelled || job.cancelled) {
          const current = await this.options.enqueueTransaction(
            async () => this.options.loadDocument().document
          )
          const result = completeCancelledResult(job.id, mode, current)
          this.setStatus({ state: 'cancelled' })
          return result
        }

        const committed = await this.options.enqueueTransaction(async () => {
          const current = this.options.loadDocument().document
          const currentRoots = await this.options.resolveRoots(current.folders)
          if (
            current.revision !== snapshot.document.revision ||
            !sameRootSet(roots, currentRoots)
          ) {
            return { drifted: true as const, library: current }
          }

          const applied = applyWorkerResult(current, workerResult)
          const nextDocument = applied.changed
            ? { ...applied.document, revision: current.revision + 1 }
            : current
          if (applied.changed) this.options.persistDocument(nextDocument)
          else replaceActiveLibraryExclusions(nextDocument.exclusions)

          const nextIndex = mergeFileIndex(
            loadLocalLibraryFileIndex(this.options.libraryFilePath).document.entries,
            workerResult,
            currentRoots
          )
          persistLocalLibraryFileIndex(this.options.libraryFilePath, {
            version: 1,
            libraryRevision: nextDocument.revision,
            updatedAt: this.now().toISOString(),
            entries: nextIndex
          })
          return {
            drifted: false as const,
            library: nextDocument,
            addedTracks: applied.addedTracks,
            updatedTracks: applied.updatedTracks,
            removedFilePaths: applied.removedFilePaths
          }
        })
        if (committed.drifted) {
          if (attempt + 1 < MAX_RECONCILE_ATTEMPTS) continue
          throw new Error('Local library changed repeatedly while the scan was reconciling')
        }

        const result: LocalLibraryScanResult = {
          jobId: job.id,
          mode,
          state: 'completed',
          library: committed.library,
          addedTracks: committed.addedTracks,
          updatedTracks: committed.updatedTracks,
          removedFilePaths: committed.removedFilePaths,
          parsedFileCount: workerResult.parsedFileCount,
          skippedUnchanged: workerResult.skippedUnchanged
        }
        this.setStatus({
          state: 'completed',
          parsedFileCount: workerResult.parsedFileCount,
          skippedUnchanged: workerResult.skippedUnchanged
        })
        return result
      }
      throw new Error('Local library reconciliation attempts were exhausted')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: 'failed', error: message })
      throw error
    } finally {
      if (this.activeJob?.id === job.id) this.activeJob = null
    }
  }

  private applyProgress(
    job: ActiveJob,
    progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>
  ): void {
    if (this.activeJob?.id !== job.id) return
    this.setStatus({
      current: progress.current,
      total: progress.total,
      parsedFileCount: progress.parsedFileCount,
      skippedUnchanged: progress.skippedUnchanged
    })
    this.emit('progress', {
      jobId: job.id,
      mode: job.mode,
      ...progress
    } satisfies LocalLibraryScanProgress)
  }

  private setStatus(patch: Partial<LocalLibraryScanStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.getStatus())
  }
}

export function toLocalLibraryScanUpdate(result: LocalLibraryScanResult): LocalLibraryScanUpdate {
  return {
    jobId: result.jobId,
    mode: result.mode,
    state: result.state,
    libraryRevision: result.library.revision,
    exclusions: result.library.exclusions,
    addedTracks: result.addedTracks,
    updatedTracks: result.updatedTracks,
    removedFilePaths: result.removedFilePaths,
    parsedFileCount: result.parsedFileCount,
    skippedUnchanged: result.skippedUnchanged
  }
}

function applyWorkerResult(
  document: LocalMusicLibraryDocument,
  workerResult: LocalLibraryWorkerScanResult
): {
  document: LocalMusicLibraryDocument
  addedTracks: unknown[]
  updatedTracks: unknown[]
  removedFilePaths: string[]
  changed: boolean
} {
  const excluded = new Set(
    document.exclusions.map((entry) => normalizeLibraryFilePath(entry.filePath))
  )
  const parsedByPath = new Map<string, Record<string, unknown>[]>()
  for (const track of workerResult.parsedTracks) {
    if (!isTrackRecord(track) || typeof track.filePath !== 'string' || !track.filePath) continue
    const key = normalizeLibraryFilePath(track.filePath)
    if (excluded.has(key)) continue
    const tracks = parsedByPath.get(key) ?? []
    tracks.push(track)
    parsedByPath.set(key, tracks)
  }

  const replacePaths = new Set(workerResult.parsedFilePaths.map(normalizeLibraryFilePath))
  const removePaths = new Set(workerResult.removedFilePaths.map(normalizeLibraryFilePath))
  const previousByPath = new Map<string, Record<string, unknown>[]>()
  for (const track of document.tracks) {
    if (!isTrackRecord(track) || typeof track.filePath !== 'string' || !track.filePath) continue
    const key = normalizeLibraryFilePath(track.filePath)
    const entries = previousByPath.get(key) ?? []
    entries.push(track)
    previousByPath.set(key, entries)
  }

  const addedTracks: unknown[] = []
  const updatedTracks: unknown[] = []
  const retained = document.tracks.filter((track) => {
    if (!isTrackRecord(track) || typeof track.filePath !== 'string' || !track.filePath) return true
    const key = normalizeLibraryFilePath(track.filePath)
    return !replacePaths.has(key) && !removePaths.has(key)
  })
  let changed = retained.length !== document.tracks.length

  for (const path of replacePaths) {
    const parsed = preserveTrackIdentifiers(
      previousByPath.get(path) ?? [],
      parsedByPath.get(path) ?? []
    )
    const previous = previousByPath.get(path) ?? []
    if (parsed.length > 0) {
      if (previous.length === 0) addedTracks.push(...parsed)
      else updatedTracks.push(...parsed)
      retained.push(...parsed)
    }
    if (!sameTrackCollection(previous, parsed)) changed = true
  }

  const next = createMusicLibraryDocument(
    {
      revision: document.revision,
      tracks: retained,
      folders: document.folders
    },
    document.exclusions
  )
  changed = changed || next.tracks.length !== retained.length
  return {
    document: next,
    addedTracks,
    updatedTracks,
    removedFilePaths: Array.from(removePaths).map((key) => {
      const matching = workerResult.removedFilePaths.find(
        (filePath) => normalizeLibraryFilePath(filePath) === key
      )
      return matching ?? key
    }),
    changed
  }
}

function preserveTrackIdentifiers(
  previous: Record<string, unknown>[],
  parsed: Record<string, unknown>[]
): Record<string, unknown>[] {
  const previousBySubTrack = new Map<string, Record<string, unknown>>()
  const previousByCueRange = new Map<string, Record<string, unknown>>()
  for (const track of previous) {
    const key = typeof track.subTrack === 'string' ? track.subTrack : ''
    if (key) previousBySubTrack.set(key, track)
    const cueKey = cueTrackIdentity(track)
    if (cueKey) previousByCueRange.set(cueKey, track)
  }
  return parsed.map((track, index) => {
    const subTrack = typeof track.subTrack === 'string' ? track.subTrack : ''
    const cueKey = cueTrackIdentity(track)
    const match =
      (cueKey ? previousByCueRange.get(cueKey) : undefined) ??
      (subTrack ? previousBySubTrack.get(subTrack) : undefined) ??
      previous[index]
    if (!match) return track
    const id = typeof match.id === 'string' && match.id ? match.id : track.id
    const addedAt =
      typeof match.addedAt === 'number' && Number.isFinite(match.addedAt) && match.addedAt > 0
        ? match.addedAt
        : track.addedAt
    return { ...track, id, ...(addedAt ? { addedAt } : {}) }
  })
}

function cueTrackIdentity(track: Record<string, unknown>): string {
  const cueSheetPath = typeof track.cueSheetPath === 'string' ? track.cueSheetPath : ''
  const range = track.cueRange
  if (!cueSheetPath || !range || typeof range !== 'object') return ''
  const start = Number((range as { startSeconds?: unknown }).startSeconds)
  const end = Number((range as { endSeconds?: unknown }).endSeconds)
  return Number.isFinite(start) && Number.isFinite(end)
    ? `${cueSheetPath}\u0000${start}\u0000${end}`
    : ''
}

function sameTrackCollection(
  left: Record<string, unknown>[],
  right: Record<string, unknown>[]
): boolean {
  if (left.length !== right.length) return false
  return left.every((track, index) => JSON.stringify(track) === JSON.stringify(right[index]))
}

function mergeFileIndex(
  current: LocalLibraryFileIdentity[],
  workerResult: LocalLibraryWorkerScanResult,
  roots: string[]
): LocalLibraryFileIdentity[] {
  const byPath = createLocalLibraryFileIndexMap(current)
  if (workerResult.completeIdentitySnapshot) {
    for (const [key, identity] of byPath) {
      if (roots.some((root) => isWithinRoot(identity.filePath, root))) byPath.delete(key)
    }
  }
  for (const filePath of workerResult.removedFilePaths) {
    byPath.delete(normalizeLibraryFilePath(filePath))
  }
  for (const identity of workerResult.identities) {
    byPath.set(normalizeLibraryFilePath(identity.filePath), identity)
  }
  return Array.from(byPath.values())
}

function collectTrackPaths(document: LocalMusicLibraryDocument): string[] {
  return document.tracks.flatMap((track) =>
    isTrackRecord(track) && typeof track.filePath === 'string' && track.filePath
      ? [track.filePath]
      : []
  )
}

function completeNoopResult(
  jobId: string,
  mode: LocalLibraryScanMode,
  document: LocalMusicLibraryDocument
): LocalLibraryScanResult {
  return {
    jobId,
    mode,
    state: 'completed',
    library: document,
    addedTracks: [],
    updatedTracks: [],
    removedFilePaths: [],
    parsedFileCount: 0,
    skippedUnchanged: 0
  }
}

function completeCancelledResult(
  jobId: string,
  mode: LocalLibraryScanMode,
  document: LocalMusicLibraryDocument
): LocalLibraryScanResult {
  return {
    ...completeNoopResult(jobId, mode, document),
    state: 'cancelled'
  }
}

function isWithinRoot(filePath: string, root: string): boolean {
  const file = normalizeLibraryFilePath(filePath)
  const normalizedRoot = normalizeLibraryFilePath(root).replace(/[\\/]+$/, '')
  return (
    file === normalizedRoot ||
    file.startsWith(`${normalizedRoot}\\`) ||
    file.startsWith(`${normalizedRoot}/`)
  )
}

function sameRootSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left.map(normalizeLibraryFilePath))
  const rightSet = new Set(right.map(normalizeLibraryFilePath))
  if (leftSet.size !== rightSet.size) return false
  return Array.from(leftSet).every((root) => rightSet.has(root))
}

function isTrackRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
