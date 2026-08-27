import { existsSync, watch, type FSWatcher } from 'fs'
import { extname, join } from 'path'
import { runtime } from '../core/runtime'
import {
  isActiveLibraryPathExcluded,
  isLibraryPathMutationInProgress
} from './libraryRepository.ts'
import type { LocalLibraryWatchChange } from '../../shared/localLibraryScan.ts'
import {
  isWatchableFileExtension,
  looksLikeDirectoryEvent,
  LIBRARY_WATCH_EXTENSIONS
} from './watcherExtensions.ts'

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

export { LIBRARY_WATCH_EXTENSIONS }

type WatcherEntry = {
  watcher: FSWatcher | null
  debounce: NodeJS.Timeout | null
  changes: Map<string, LocalLibraryWatchChange>
  mode: LibraryWatcherMode
  state: LibraryWatcherState
  lastError: string | null
  lastEventAt: string | null
  lastReconcileAt: string | null
  recreateTimer: NodeJS.Timeout | null
  recreateAttempts: number
  pollingTimer: NodeJS.Timeout | null
}

const libraryWatchers = new Map<string, WatcherEntry>()
const RECREATE_BASE_DELAY_MS = 1_000
const RECREATE_MAX_DELAY_MS = 30_000
const POLL_INTERVAL_MS = 15_000
const LINUX_FORCE_POLLING = process.platform === 'linux'

function notifyLibraryChanged(change?: {
  kind: 'add' | 'remove' | 'unknown'
  path?: string
}): void {
  runtime.mainWindow?.webContents.send('library:changed', change)
}

function changeKey(change: LocalLibraryWatchChange): string {
  return `${change.kind}:${change.path.replace(/\//g, '\\').toLocaleLowerCase('en-US')}`
}

function pathKey(filePath: string): string {
  return filePath.replace(/\//g, '\\').toLocaleLowerCase('en-US')
}

function enqueueChange(folder: string, change: LocalLibraryWatchChange): void {
  const entry = libraryWatchers.get(folder)
  if (!entry) return
  entry.lastEventAt = new Date().toISOString()
  entry.changes.set(changeKey(change), change)
  if (entry.debounce) clearTimeout(entry.debounce)
  entry.debounce = setTimeout(() => {
    entry.debounce = null
    flushWatcherChanges(folder)
  }, runtime.libraryWatcherDebounceMs)
}

function flushWatcherChanges(folder: string): void {
  const entry = libraryWatchers.get(folder)
  if (!entry || entry.changes.size === 0) return
  const changes = Array.from(entry.changes.values())
  entry.changes.clear()
  entry.lastReconcileAt = new Date().toISOString()
  const coordinator = runtime.localLibraryIndexCoordinator
  if (coordinator) {
    coordinator.enqueueWatcherChanges(changes)
  } else if (changes.some((change) => change.kind === 'reconcile')) {
    notifyLibraryChanged({ kind: 'unknown' })
  } else if (changes.length === 1) {
    const only = changes[0]
    if (only.kind === 'add' || only.kind === 'remove') {
      notifyLibraryChanged({ kind: only.kind, path: only.path })
    } else {
      notifyLibraryChanged({ kind: 'unknown' })
    }
  } else {
    notifyLibraryChanged({ kind: 'unknown' })
  }
}

function forceRootReconcile(folder: string, reason: string): void {
  const entry = libraryWatchers.get(folder)
  if (!entry) return
  entry.lastError = reason || entry.lastError
  entry.lastEventAt = new Date().toISOString()
  enqueueChange(folder, { kind: 'reconcile', path: folder })
}

function clearRecreateTimer(entry: WatcherEntry): void {
  if (entry.recreateTimer) {
    clearTimeout(entry.recreateTimer)
    entry.recreateTimer = null
  }
}

function clearPollingTimer(entry: WatcherEntry): void {
  if (entry.pollingTimer) {
    clearInterval(entry.pollingTimer)
    entry.pollingTimer = null
  }
}

function closeWatcherHandle(entry: WatcherEntry): void {
  if (!entry.watcher) return
  try {
    entry.watcher.close()
  } catch (error) {
    console.warn('[library] unable to close a library folder watcher:', watcherErrorCode(error))
  }
  entry.watcher = null
}

function startPollingFallback(folder: string, reason: string): void {
  const entry = libraryWatchers.get(folder)
  if (!entry) return
  clearPollingTimer(entry)
  entry.mode = 'polling'
  entry.state = 'degraded'
  entry.lastError = reason
  entry.pollingTimer = setInterval(() => {
    forceRootReconcile(folder, reason)
  }, POLL_INTERVAL_MS)
  // Immediate reconcile so Linux / failed recursive watchers catch up without waiting.
  forceRootReconcile(folder, reason)
}

function scheduleWatcherRecreate(folder: string, reason: string): void {
  const entry = libraryWatchers.get(folder)
  if (!entry) return
  closeWatcherHandle(entry)
  clearRecreateTimer(entry)
  entry.state = entry.mode === 'polling' ? 'degraded' : 'failed'
  entry.lastError = reason

  const attempt = entry.recreateAttempts
  const delay = Math.min(RECREATE_MAX_DELAY_MS, RECREATE_BASE_DELAY_MS * 2 ** attempt)
  entry.recreateAttempts = attempt + 1
  entry.recreateTimer = setTimeout(() => {
    entry.recreateTimer = null
    // Drop the map entry so createFolderWatcher can re-arm cleanly.
    const current = libraryWatchers.get(folder)
    if (!current) return
    const preserved: WatcherEntry = {
      ...current,
      watcher: null
    }
    libraryWatchers.set(folder, preserved)
    createFolderWatcher(folder, { resume: true })
  }, delay)
}

function attachWatcherHandlers(folder: string, watcher: FSWatcher): void {
  watcher.on('error', (error) => {
    const code = watcherErrorCode(error)
    console.warn('[library] library folder watcher error:', code)
    if (LINUX_FORCE_POLLING) {
      startPollingFallback(folder, code)
      return
    }
    scheduleWatcherRecreate(folder, code)
    forceRootReconcile(folder, code)
  })
}

function createFolderWatcher(folder: string, options: { resume?: boolean } = {}): void {
  const existing = libraryWatchers.get(folder)
  if (existing && existing.watcher && !options.resume) return

  const entry: WatcherEntry = existing ?? {
    watcher: null,
    debounce: null,
    changes: new Map(),
    mode: 'none',
    state: 'failed',
    lastError: null,
    lastEventAt: null,
    lastReconcileAt: null,
    recreateTimer: null,
    recreateAttempts: 0,
    pollingTimer: null
  }
  libraryWatchers.set(folder, entry)

  if (LINUX_FORCE_POLLING) {
    startPollingFallback(folder, 'linux-recursive-watch-unsupported')
    return
  }

  try {
    const watcher = watch(folder, { recursive: true }, (_eventType, filename) => {
      if (!filename) {
        // Some platforms emit empty names for directory-level churn.
        forceRootReconcile(folder, 'empty-watch-event')
        return
      }
      const fullPath = join(folder, filename)
      if (isActiveLibraryPathExcluded(fullPath) || isLibraryPathMutationInProgress(fullPath)) return

      if (looksLikeDirectoryEvent(filename, fullPath)) {
        // Directory move/rename: scoped root reconcile (complete identity snapshot).
        enqueueChange(folder, { kind: 'reconcile', path: folder })
        return
      }

      const ext = extname(filename).toLowerCase()
      if (!isWatchableFileExtension(ext)) return

      const kind: 'add' | 'remove' = existsSync(fullPath) ? 'add' : 'remove'
      // Coalesce by path so rename+change collapses; latest kind wins.
      const current = libraryWatchers.get(folder)
      if (!current) return
      current.lastEventAt = new Date().toISOString()
      current.changes.set(pathKey(fullPath), { kind, path: fullPath })
      if (current.debounce) clearTimeout(current.debounce)
      current.debounce = setTimeout(() => {
        current.debounce = null
        flushWatcherChanges(folder)
      }, runtime.libraryWatcherDebounceMs)
    })
    attachWatcherHandlers(folder, watcher)
    entry.watcher = watcher
    entry.mode = 'recursive'
    entry.state = 'active'
    entry.lastError = null
    entry.recreateAttempts = 0
    clearPollingTimer(entry)
  } catch (error) {
    const code = watcherErrorCode(error)
    console.warn('[library] unable to watch a configured library folder:', code)
    startPollingFallback(folder, code)
  }
}

function removeFolderWatcher(folder: string): void {
  const entry = libraryWatchers.get(folder)
  if (!entry) return
  if (entry.debounce) clearTimeout(entry.debounce)
  clearRecreateTimer(entry)
  clearPollingTimer(entry)
  entry.changes.clear()
  closeWatcherHandle(entry)
  libraryWatchers.delete(folder)
}

export function applyLibraryWatchers(folders: string[], enabled: boolean): void {
  for (const folder of libraryWatchers.keys()) {
    if (!folders.includes(folder)) removeFolderWatcher(folder)
  }
  if (!enabled) {
    for (const folder of libraryWatchers.keys()) removeFolderWatcher(folder)
    return
  }
  for (const folder of folders) {
    if (!libraryWatchers.has(folder)) createFolderWatcher(folder)
  }
}

export function getLibraryWatcherStatus(): LibraryWatcherFolderStatus[] {
  return Array.from(libraryWatchers.entries())
    .map(([folder, entry]) => ({
      folder,
      state: entry.state,
      mode: entry.mode,
      lastError: entry.lastError,
      lastEventAt: entry.lastEventAt,
      lastReconcileAt: entry.lastReconcileAt
    }))
    .sort((left, right) => left.folder.localeCompare(right.folder))
}

export function getLibraryWatcherStatusSnapshot(
  folders: string[],
  enabled: boolean
): {
  enabled: boolean
  folders: LibraryWatcherFolderStatus[]
} {
  if (!enabled) {
    return {
      enabled: false,
      folders: folders.map((folder) => ({
        folder,
        state: 'disabled',
        mode: 'none',
        lastError: null,
        lastEventAt: null,
        lastReconcileAt: null
      }))
    }
  }
  const live = new Map(getLibraryWatcherStatus().map((item) => [item.folder, item]))
  return {
    enabled: true,
    folders: folders.map((folder) => {
      const current = live.get(folder)
      if (current) return current
      return {
        folder,
        state: 'failed',
        mode: 'none',
        lastError: 'not-started',
        lastEventAt: null,
        lastReconcileAt: null
      }
    })
  }
}

function watcherErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown'
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'unknown'
}
