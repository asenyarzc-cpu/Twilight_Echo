import { IPC } from '../../shared/ipcChannels.ts'
import { app, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { createTagWriteIpcHandlers } from '../library/tagWriteIpc.ts'
import { createDuplicateDetectionIpcHandlers } from '../library/duplicateDetectionIpc.ts'
import {
  LocalLibraryIndexCoordinator,
  toLocalLibraryScanUpdate
} from '../library/libraryIndexCoordinator.ts'
import { getLibraryWatcherStatusSnapshot } from '../library/watcher.ts'
import {
  resetLocalLibraryFileIndex,
  synchronizeLocalLibraryFileIndexRevision
} from '../library/fileIndex.ts'
import type { LocalLibraryScanRunner } from '../library/libraryScanServiceClient.ts'
import {
  MAX_MUSIC_LIBRARY_BYTES,
  assertMusicLibraryRevision,
  beginLibraryPathMutation,
  collectLibraryTrackPathKeys,
  createMusicLibraryDocument,
  loadMusicLibraryDocument,
  normalizeLibraryFilePath,
  persistMusicLibraryDocument,
  replaceActiveLibraryExclusions,
  restoreLibraryExclusions,
  type LoadedMusicLibraryDocument
} from '../library/libraryRepository.ts'
import {
  commitLocalLibraryRemoval,
  createLocalLibraryRemovalJournal,
  getLocalLibraryRemovalJournalPath,
  recoverLocalLibraryRemoval,
  recoverLocalLibraryRemovalResult
} from '../library/removal.ts'
import type {
  LocalLibraryRemoveRequest,
  LocalLibraryRemoveResult,
  LocalLibraryRemovalMode,
  LocalLibraryResetResult,
  LocalLibraryRestoreRequest,
  LocalLibrarySnapshotInput,
  LocalLibraryTrackSelection,
  LocalMusicLibraryDocument
} from '../../shared/localLibrary.ts'
import type {
  LocalLibraryScanStatus,
  LocalLibraryWorkerScanRequest
} from '../../shared/localLibraryScan.ts'
import { runtime } from '../core/runtime'
import { getCoverCacheDir } from '../library/coverCache'
import { redactSensitiveText } from '../security/secureStorage.ts'
import { normalizeLocalPath, stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import {
  filterAuthorizedLibraryRoots,
  resolveAuthorizedAudioFile,
  resolveAuthorizedLibraryDirectory
} from '../security/localPaths'
import {
  errorMessage,
  reportLocalLibraryRemovalRecovery,
  reportPersistentDataFailure,
  reportPersistentDataRecovery,
  showPersistenceMessage
} from './persistenceReporting.ts'

const MAX_LIBRARY_MUTATION_ITEMS = 10_000

let musicLibraryTransactionChain: Promise<void> = Promise.resolve()
let musicLibraryFilePath: string | null = null
let musicLibraryExclusionsPromise: Promise<void> | null = null
let warmedMusicLibrary: { filePath: string; loaded: LoadedMusicLibraryDocument } | null = null
let activeLibraryExclusionPaths: string[] = []

export function registerLibraryIpc(ipcMain: IpcMain): void {
  const userDataPath = app.getPath('userData')
  const MUSIC_LIBRARY_FILE = join(userDataPath, 'music-library.json')
  musicLibraryFilePath = MUSIC_LIBRARY_FILE
  musicLibraryExclusionsPromise = null
  warmedMusicLibrary = null
  activeLibraryExclusionPaths = []

  ipcMain.handle('fs:scanMusicFiles', async (event, folderPath: string) => {
    assertTrustedIpcSender(event, 'filesystem IPC')
    const resolvedPath = await resolveAuthorizedLibraryDirectory(
      normalizeLocalPath(folderPath, 'music folder path')
    )
    const scanService = runtime.localLibraryScanService
    if (!scanService) throw new Error('Local library scan service is unavailable')
    const exclusions = await ensureLibraryExclusionsLoaded()
    const request: LocalLibraryWorkerScanRequest = {
      mode: 'full',
      roots: [resolvedPath],
      knownIdentities: [],
      knownTrackPaths: [],
      excludedPaths: exclusions,
      coverCacheDir: getCoverCacheDir()
    }
    const result = await scanService.scan(randomUUID(), request, (progress) => {
      event.sender.send('fs:scanProgress', {
        current: progress.current,
        total: progress.total,
        phase: progress.phase
      })
    })
    if (result.cancelled) return []
    return result.parsedTracks
  })

  const tagWriteIpc = createTagWriteIpcHandlers({
    backupRoot: join(userDataPath, 'tag-backups'),
    assertTrustedSender: (event) =>
      assertTrustedIpcSender(event as IpcMainInvokeEvent, 'library tag mutation IPC'),
    authorizeAudioFile: async (filePath) =>
      await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'tag audio file path')),
    redactError: (error) =>
      redactSensitiveText(error instanceof Error ? error.message : String(error))
  })
  const duplicateDetectionIpc = createDuplicateDetectionIpcHandlers({
    assertTrustedSender: (event) =>
      assertTrustedIpcSender(event as IpcMainInvokeEvent, 'library duplicate detection IPC'),
    loadTracks: () => loadMusicLibraryDocument(MUSIC_LIBRARY_FILE).document.tracks,
    authorizeAudioFile: async (filePath) =>
      await resolveAuthorizedAudioFile(
        normalizeLocalPath(filePath, 'duplicate detection audio file')
      )
  })

  const localLibraryIndexCoordinator = new LocalLibraryIndexCoordinator({
    libraryFilePath: MUSIC_LIBRARY_FILE,
    scanRunner: runtime.localLibraryScanService ?? unavailableLocalLibraryScanRunner(),
    enqueueTransaction: enqueueMusicLibraryTransaction,
    loadDocument: () => loadMusicLibraryForTransaction(MUSIC_LIBRARY_FILE, { consumeWarm: false }),
    persistDocument: (document) => {
      persistMusicLibraryDocument(MUSIC_LIBRARY_FILE, document)
      invalidateWarmedMusicLibrary()
    },
    resolveRoots: async () =>
      await filterAuthorizedLibraryRoots(runtime.appSettings.libraryFolders),
    getCoverCacheDir,
    watcherDebounceMs: runtime.libraryWatcherDebounceMs
  })
  runtime.localLibraryIndexCoordinator = localLibraryIndexCoordinator
  runtime.localLibraryScanService?.on('service-error', (error) => {
    const message = redactSensitiveText(errorMessage(error))
    console.error('[library] background scan worker failed:', message)
    localLibraryIndexCoordinator.reportServiceError(new Error(message))
  })
  localLibraryIndexCoordinator.on('progress', (progress) => {
    runtime.mainWindow?.webContents.send(IPC.library.scanProgress, progress)
  })
  localLibraryIndexCoordinator.on('status', (status: LocalLibraryScanStatus) => {
    runtime.mainWindow?.webContents.send(IPC.library.scanStatus, {
      ...status,
      error: redactSensitiveText(status.error)
    })
  })
  localLibraryIndexCoordinator.on('watch-result', (result) => {
    runtime.mainWindow?.webContents.send(IPC.library.changed, {
      kind: 'scan',
      update: toLocalLibraryScanUpdate(result)
    })
  })
  localLibraryIndexCoordinator.on('scan-error', (error) => {
    console.warn(
      '[library] incremental watcher scan failed:',
      redactSensitiveText(errorMessage(error))
    )
  })

  ipcMain.handle(IPC.library.scanStartup, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    await ensureLibraryExclusionsLoaded()
    return await runLocalLibraryScanOperation(async () =>
      toLocalLibraryScanUpdate(await localLibraryIndexCoordinator.scanStartup())
    )
  })

  ipcMain.handle(IPC.library.scanFull, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    await ensureLibraryExclusionsLoaded()
    return await runLocalLibraryScanOperation(async () =>
      toLocalLibraryScanUpdate(await localLibraryIndexCoordinator.scanFull())
    )
  })

  ipcMain.handle(IPC.library.getScanStatus, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    const status = localLibraryIndexCoordinator.getStatus()
    return { ...status, error: redactSensitiveText(status.error) }
  })

  ipcMain.handle(IPC.library.getWatcherStatus, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return getLibraryWatcherStatusSnapshot(
      runtime.appSettings.libraryFolders,
      runtime.appSettings.watchLibrary
    )
  })

  ipcMain.handle(IPC.library.pauseScan, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return localLibraryIndexCoordinator.pause()
  })

  ipcMain.handle(IPC.library.resumeScan, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return localLibraryIndexCoordinator.resume()
  })

  ipcMain.handle(IPC.library.cancelScan, async (event) => {
    assertTrustedIpcSender(event, 'library scan IPC')
    return localLibraryIndexCoordinator.cancel()
  })

  ipcMain.handle(
    'data:saveMusicLibrary',
    async (event, library: LocalLibrarySnapshotInput | unknown[]) => {
      assertTrustedIpcSender(event, 'data IPC')
      const snapshot = normalizeMusicLibrarySnapshot(library)
      snapshot.folders = await filterAuthorizedLibraryRoots(snapshot.folders)
      stringifyJsonForIpcStorage(snapshot, 'music library', MAX_MUSIC_LIBRARY_BYTES)
      return await enqueueMusicLibraryTransaction(async () => {
        const loaded = loadMusicLibraryForTransaction(MUSIC_LIBRARY_FILE, { consumeWarm: false })
        assertMusicLibraryRevision(snapshot.revision, loaded.document.revision)
        const nextDocument = createMusicLibraryDocument(snapshot, loaded.document.exclusions)
        nextDocument.revision = loaded.document.revision + 1
        persistMusicLibraryDocumentWithIndex(MUSIC_LIBRARY_FILE, nextDocument)
        invalidateWarmedMusicLibrary()
        return nextDocument
      })
    }
  )

  ipcMain.handle('data:loadMusicLibrary', async (event) => {
    assertTrustedIpcSender(event, 'data IPC')
    return await enqueueMusicLibraryTransaction(async () => {
      const loaded = loadMusicLibraryForTransaction(MUSIC_LIBRARY_FILE)
      const document = loaded.document

      const authorizedFolders = await filterAuthorizedLibraryRoots(document.folders)
      let changed =
        loaded.migrated ||
        authorizedFolders.length !== document.folders.length ||
        authorizedFolders.some((folder, index) => folder !== document.folders[index])
      document.folders = authorizedFolders

      // Lyrics stay lazy-loaded; persisted records only keep lightweight metadata.
      // Metadata and cover processing are performed only by the background scan
      // worker. A full rescan is the explicit repair path for legacy/missing covers.
      const tracks = document.tracks
      for (const track of tracks) {
        if (!track || typeof track !== 'object' || Array.isArray(track)) continue
        const t = track as Record<string, unknown>
        if (t.lyrics) {
          t.lyrics = null
          changed = true
        }
      }

      if (changed) {
        const nextDocument = { ...document, revision: document.revision + 1 }
        persistMusicLibraryDocumentWithIndex(MUSIC_LIBRARY_FILE, nextDocument)
        invalidateWarmedMusicLibrary()
        return nextDocument
      } else {
        replaceActiveLibraryExclusions(document.exclusions)
      }
      return document
    })
  })

  ipcMain.handle(IPC.library.removeTracks, async (event, rawRequest: unknown) => {
    assertTrustedIpcSender(event, 'library mutation IPC')
    const request = normalizeLocalLibraryRemoveRequest(rawRequest)
    request.library.folders = await filterAuthorizedLibraryRoots(request.library.folders)
    stringifyJsonForIpcStorage(request, 'library removal request', MAX_MUSIC_LIBRARY_BYTES)

    return await enqueueMusicLibraryTransaction(async () => {
      const loaded = loadMusicLibraryForTransaction(MUSIC_LIBRARY_FILE, { consumeWarm: false })
      assertMusicLibraryRevision(request.library.revision, loaded.document.revision)
      const persistedPaths = collectLibraryTrackPathKeys(loaded.document)
      const presentItems = request.items.filter((item) =>
        persistedPaths.has(normalizeLibraryFilePath(item.filePath))
      )
      const missingFailures = request.items
        .filter((item) => !persistedPaths.has(normalizeLibraryFilePath(item.filePath)))
        .map((item) => ({ filePath: item.filePath, message: '曲目不在当前持久化音乐库中' }))
      const authorized = await authorizeLocalLibrarySelections(presentItems, request.mode)
      const document = createMusicLibraryDocument(request.library, loaded.document.exclusions)
      const endPathMutation = beginLibraryPathMutation(
        request.mode === 'trash' ? authorized.items.map((item) => item.filePath) : []
      )
      let result: LocalLibraryRemoveResult
      try {
        try {
          result = await commitLocalLibraryRemoval({
            document,
            items: authorized.items,
            mode: request.mode,
            trashItem: async (filePath) => {
              const authorizedPath = await resolveAuthorizedAudioFile(
                normalizeLocalPath(filePath, 'trash item path')
              )
              await shell.trashItem(authorizedPath)
            },
            persist: (nextDocument) => {
              nextDocument.revision = loaded.document.revision + 1
              persistMusicLibraryDocumentWithIndex(MUSIC_LIBRARY_FILE, nextDocument)
            },
            journal:
              request.mode === 'trash'
                ? createLocalLibraryRemovalJournal(MUSIC_LIBRARY_FILE)
                : undefined
          })
        } catch (error) {
          if (request.mode !== 'trash') throw error
          const recovered = recoverLocalLibraryRemovalResult(
            MUSIC_LIBRARY_FILE,
            document,
            authorized.items
          )
          if (!recovered) throw error
          result = recovered
          reportLocalLibraryRemovalRecovery(MUSIC_LIBRARY_FILE, result.removedFilePaths)
        }
      } finally {
        endPathMutation()
      }
      result.failures.unshift(...missingFailures, ...authorized.failures)
      if (result.removedFilePaths.length === 0) {
        result.library = loaded.document
      }
      return result
    })
  })

  ipcMain.handle(IPC.library.reset, async (event): Promise<LocalLibraryResetResult> => {
    assertTrustedIpcSender(event, 'library reset IPC')
    return await enqueueMusicLibraryTransaction(async () => {
      const loaded = loadMusicLibraryForTransaction(MUSIC_LIBRARY_FILE, { consumeWarm: false })
      const removedTrackIds = loaded.document.tracks.flatMap((track) => {
        if (!track || typeof track !== 'object' || Array.isArray(track)) return []
        const id = (track as Record<string, unknown>).id
        return typeof id === 'string' && id ? [id] : []
      })
      const removedFilePaths = loaded.document.tracks.flatMap((track) => {
        if (!track || typeof track !== 'object' || Array.isArray(track)) return []
        const filePath = (track as Record<string, unknown>).filePath
        return typeof filePath === 'string' && filePath ? [filePath] : []
      })
      const nextDocument: LocalMusicLibraryDocument = {
        version: 2,
        revision: loaded.document.revision + 1,
        tracks: [],
        folders: loaded.document.folders,
        exclusions: loaded.document.exclusions
      }
      persistMusicLibraryDocument(MUSIC_LIBRARY_FILE, nextDocument)
      invalidateWarmedMusicLibrary()
      activeLibraryExclusionPaths = nextDocument.exclusions.map((exclusion) => exclusion.filePath)
      resetLocalLibraryFileIndex(MUSIC_LIBRARY_FILE, nextDocument.revision)
      return { library: nextDocument, removedTrackIds, removedFilePaths }
    })
  })

  ipcMain.handle(IPC.library.restoreExclusions, async (event, rawRequest: unknown) => {
    assertTrustedIpcSender(event, 'library mutation IPC')
    const request = normalizeLocalLibraryRestoreRequest(rawRequest)
    request.library.folders = await filterAuthorizedLibraryRoots(request.library.folders)
    stringifyJsonForIpcStorage(
      request,
      'library exclusion restore request',
      MAX_MUSIC_LIBRARY_BYTES
    )

    return await enqueueMusicLibraryTransaction(async () => {
      const loaded = loadMusicLibraryForTransaction(MUSIC_LIBRARY_FILE, { consumeWarm: false })
      assertMusicLibraryRevision(request.library.revision, loaded.document.revision)
      const document = createMusicLibraryDocument(request.library, loaded.document.exclusions)
      const restored = restoreLibraryExclusions(document, request.filePaths)
      if (restored.restoredFilePaths.length > 0) {
        restored.document.revision = loaded.document.revision + 1
        persistMusicLibraryDocumentWithIndex(MUSIC_LIBRARY_FILE, restored.document)
      }
      return {
        library: restored.restoredFilePaths.length > 0 ? restored.document : loaded.document,
        restoredFilePaths: restored.restoredFilePaths
      }
    })
  })

  ipcMain.handle(
    IPC.library.detectDuplicates,
    async (event) => await duplicateDetectionIpc.detect(event)
  )

  ipcMain.handle(
    IPC.library.writeTags,
    async (event, rawRequest: unknown) => await tagWriteIpc.write(event, rawRequest)
  )

  ipcMain.handle(
    IPC.library.restoreTags,
    async (event, rawRequest: unknown) => await tagWriteIpc.restore(event, rawRequest)
  )
}

async function ensureLibraryExclusionsLoaded(): Promise<string[]> {
  const filePath = musicLibraryFilePath
  if (!filePath) throw new Error('Music library is unavailable')
  if (!musicLibraryExclusionsPromise) {
    const loading = enqueueMusicLibraryTransaction(async () => {
      try {
        const removalRecovery = recoverLocalLibraryRemoval(filePath)
        if (removalRecovery.recovered) {
          reportLocalLibraryRemovalRecovery(filePath, removalRecovery.removedFilePaths)
        }
        const initialLibrary = loadMusicLibraryDocument(filePath)
        warmedMusicLibrary = { filePath, loaded: initialLibrary }
        activeLibraryExclusionPaths = initialLibrary.document.exclusions.map(
          (exclusion) => exclusion.filePath
        )
        replaceActiveLibraryExclusions(initialLibrary.document.exclusions)
        if (initialLibrary.migrated) {
          persistMusicLibraryDocumentWithIndex(filePath, initialLibrary.document)
          invalidateWarmedMusicLibrary()
        }
        if (initialLibrary.recovery) {
          reportPersistentDataRecovery('Music library', filePath, initialLibrary.recovery)
        }
      } catch (error) {
        console.error(
          '[persistence] failed to initialize music library exclusions:',
          redactSensitiveText(errorMessage(error))
        )
        showPersistenceMessage(
          `failed:${getLocalLibraryRemovalJournalPath(filePath)}`,
          'error',
          '音乐库回收站恢复失败',
          `${redactSensitiveText(errorMessage(error))}\n\n恢复日志：${getLocalLibraryRemovalJournalPath(
            filePath
          )}`
        )
        throw error
      }
    })
    musicLibraryExclusionsPromise = loading
    void loading.catch(() => {
      if (musicLibraryExclusionsPromise === loading) musicLibraryExclusionsPromise = null
    })
  }
  await musicLibraryExclusionsPromise
  return [...activeLibraryExclusionPaths]
}

export async function ensureActiveLibraryExclusionsLoaded(): Promise<void> {
  if (!musicLibraryFilePath) return
  await ensureLibraryExclusionsLoaded()
}

function invalidateWarmedMusicLibrary(): void {
  warmedMusicLibrary = null
}

function enqueueMusicLibraryTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = musicLibraryTransactionChain.catch(() => {}).then(operation)
  musicLibraryTransactionChain = result.then(
    () => {},
    () => {}
  )
  return result
}

async function runLocalLibraryScanOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const message = redactSensitiveText(errorMessage(error))
    console.error('[library] background scan operation failed:', message)
    throw new Error(message)
  }
}

function unavailableLocalLibraryScanRunner(): LocalLibraryScanRunner {
  const unavailable = (): never => {
    throw new Error('Local library scan service is unavailable')
  }
  return {
    scan: async () => unavailable(),
    pause: () => {},
    resume: () => {},
    cancel: () => {},
    destroy: () => {}
  }
}

function persistMusicLibraryDocumentWithIndex(
  libraryFilePath: string,
  document: LocalMusicLibraryDocument
): void {
  persistMusicLibraryDocument(libraryFilePath, document)
  invalidateWarmedMusicLibrary()
  if (libraryFilePath === musicLibraryFilePath) {
    activeLibraryExclusionPaths = document.exclusions.map((exclusion) => exclusion.filePath)
  }
  try {
    synchronizeLocalLibraryFileIndexRevision(libraryFilePath, document.revision)
  } catch (error) {
    // The file index is derived data. A later startup scan will reconcile it.
    console.warn(
      '[library] failed to align the local file index:',
      redactSensitiveText(errorMessage(error))
    )
  }
}

function loadMusicLibraryForTransaction(
  filePath: string,
  options: { consumeWarm?: boolean } = {}
): LoadedMusicLibraryDocument {
  if (options.consumeWarm !== false && warmedMusicLibrary?.filePath === filePath) {
    const warmed = warmedMusicLibrary.loaded
    warmedMusicLibrary = null
    return warmed
  }
  try {
    const removalRecovery = recoverLocalLibraryRemoval(filePath)
    if (removalRecovery.recovered) {
      reportLocalLibraryRemovalRecovery(filePath, removalRecovery.removedFilePaths)
    }
  } catch (error) {
    reportPersistentDataFailure(
      '音乐库回收站恢复日志',
      getLocalLibraryRemovalJournalPath(filePath),
      error
    )
  }
  let loaded: LoadedMusicLibraryDocument
  try {
    loaded = loadMusicLibraryDocument(filePath)
  } catch (error) {
    reportPersistentDataFailure('音乐库', filePath, error)
  }
  if (loaded.recovery) {
    reportPersistentDataRecovery('音乐库', filePath, loaded.recovery)
  }
  return loaded
}

function normalizeMusicLibrarySnapshot(value: unknown): LocalLibrarySnapshotInput {
  if (Array.isArray(value)) return { revision: 0, tracks: value, folders: [] }
  if (!value || typeof value !== 'object') {
    throw new Error('Music library must be an array or object')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.tracks)) throw new Error('Music library tracks must be an array')
  if (record.folders !== undefined && !Array.isArray(record.folders)) {
    throw new Error('Music library folders must be an array')
  }
  return {
    revision:
      typeof record.revision === 'number' &&
      Number.isSafeInteger(record.revision) &&
      record.revision >= 0
        ? record.revision
        : 0,
    tracks: record.tracks,
    folders: (record.folders ?? []).filter((folder): folder is string => typeof folder === 'string')
  }
}

async function authorizeLocalLibrarySelections(
  items: LocalLibraryTrackSelection[],
  mode: LocalLibraryRemovalMode
): Promise<{
  items: LocalLibraryTrackSelection[]
  failures: Array<{ filePath: string; message: string }>
}> {
  const authorizedItems: LocalLibraryTrackSelection[] = []
  const failures: Array<{ filePath: string; message: string }> = []
  for (const item of items) {
    try {
      const requestedPath = normalizeLocalPath(item.filePath, 'library removal item path')
      if (mode === 'trash') {
        await resolveAuthorizedAudioFile(requestedPath)
      }
      authorizedItems.push(item)
    } catch (error) {
      failures.push({
        filePath: item.filePath,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return { items: authorizedItems, failures }
}

function normalizeLocalLibraryRemoveRequest(value: unknown): LocalLibraryRemoveRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Library removal request must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.mode !== 'library' && record.mode !== 'trash') {
    throw new Error('Library removal mode must be library or trash')
  }
  if (!Array.isArray(record.items) || record.items.length > MAX_LIBRARY_MUTATION_ITEMS) {
    throw new Error(`Library removal supports at most ${MAX_LIBRARY_MUTATION_ITEMS} items`)
  }
  return {
    mode: record.mode,
    items: record.items.map(normalizeLocalLibraryTrackSelection),
    library: normalizeMusicLibrarySnapshot(record.library)
  }
}

function normalizeLocalLibraryTrackSelection(value: unknown): LocalLibraryTrackSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Library removal item must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id) {
    throw new Error('Library removal item id is required')
  }
  return {
    id: record.id,
    filePath: normalizeLocalPath(record.filePath, 'library removal item path'),
    title: typeof record.title === 'string' ? record.title.slice(0, 1024) : '',
    artist: typeof record.artist === 'string' ? record.artist.slice(0, 1024) : ''
  }
}

function normalizeLocalLibraryRestoreRequest(value: unknown): LocalLibraryRestoreRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Library exclusion restore request must be an object')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.filePaths) || record.filePaths.length > MAX_LIBRARY_MUTATION_ITEMS) {
    throw new Error(
      `Library exclusion restore supports at most ${MAX_LIBRARY_MUTATION_ITEMS} items`
    )
  }
  return {
    filePaths: record.filePaths.map((filePath) =>
      normalizeLocalPath(filePath, 'library exclusion path')
    ),
    library: normalizeMusicLibrarySnapshot(record.library)
  }
}
