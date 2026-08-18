import { ref, shallowRef, toRaw, type Ref } from 'vue'
import type { Track } from '../types/music'
import type {
  LocalLibraryExclusion,
  LocalLibraryRemoveResult,
  LocalLibraryRemovalMode,
  LocalMusicLibraryDocument
} from '../../../shared/localLibrary.ts'
import type {
  LocalLibraryScanProgress,
  LocalLibraryScanStatus,
  LocalLibraryScanUpdate
} from '../../../shared/localLibraryScan.ts'
import type { LocalLibraryTagPatch } from '../../../shared/localLibraryTags.ts'
import {
  isVersionedDataEnvelope,
  isPersistentDataRevisionConflict,
  type VersionedDataEnvelope
} from '../../../shared/versionedPersistence.ts'
import { syncPluginProviders, useMediaProviders } from '../providers/index.ts'
import {
  LibraryMetadataEnrichmentQueue,
  type LibraryMetadataEnrichmentStatus,
  type LibraryMetadataEnrichmentTrackUpdate
} from '../utils/libraryMetadataEnrichment.ts'
import { getLogicalTrackKey } from '../utils/logicalTrackIdentity.ts'
import {
  buildLogicalTracks,
  getTrackSource,
  type LogicalTrack
} from '../utils/logicalTrackModel.ts'
import {
  enrichLocalTrackMetadata,
  type MetadataMatchConfidence
} from '../utils/musicMetadataMatching.ts'
import { useSettingsStore } from './useSettingsStore.ts'
import { notifyLocalTracksUnavailable } from '../utils/localTrackRemovalPolicy.ts'
import { splitGenreValues } from '../../../shared/genreSeparators.ts'
import { PlaylistPersistence, type PlaylistPersistenceStatus } from './playlistPersistence.ts'
import {
  exportPlaylistDocument,
  findPlaylistRelocations,
  parsePlaylistDocument,
  reorderStableIds,
  type PlaylistFileFormat,
  type PlaylistRelocationResult
} from '../utils/playlistLifecycle.ts'
import {
  clonePlaylist,
  compareAlbumTrackOrder,
  deduplicateLibraryPaths,
  getAlbumIdentity,
  isLocalLibraryTrack,
  isTrackUnderLibraryRoot,
  mergeAlbumGroupsByReleaseEvidence,
  normalizeLibraryPath,
  normalizePortableLibraryPath,
  parentDirectoryOf,
  playlistDataEqual,
  replayPlaylistTransaction,
  toPlaylistTrackSnapshot
} from './library/musicStoreData.ts'

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
  trackSnapshots?: Record<string, Track>
  /** User-selected data URL or cached cover handle. */
  cover?: string | null
  isDefault?: boolean
  createdAt: string
  updatedAt?: string
}

interface LibraryItem {
  id?: string
  name: string
  trackCount: number
  tracks: Track[]
  cover: string | null
  artist?: string
  path?: string
}

interface AddTracksOptions {
  deferRebuild?: boolean
}

interface ManualMetadataMatchOptions {
  confidence: MetadataMatchConfidence
  score: number
}

export interface PlaylistImportApplyResult {
  playlistId: string
  importedCount: number
  unresolvedEntries: number
  warnings: string[]
}

export interface PlaylistBatchMoveResult {
  moved: number
  sourceRemoved: number
}

export interface PlaylistPersistenceNotice {
  kind: 'revision-conflict-recovered'
  message: string
  authoritativeRevision: number
  recoveredAt: string
}

interface LibraryRepairReport {
  checkedAt: string
  repairedCount: number
  unresolvedCount: number
  repairedTrackIds: string[]
  unresolvedTrackIds: string[]
}

export interface DerivedTrackGroup {
  tracks: Track[]
  cover: string | null
  artist?: string
}

type LibraryChange =
  | { kind: 'add' | 'remove' | 'unknown'; path?: string }
  | { kind: 'scan'; update: LocalLibraryScanUpdate }

const DEFAULT_FAVORITE_PLAYLIST_NAME = '我收藏的音乐'

const tracks = shallowRef<Track[]>([])
const scannedFolders = ref<string[]>([])
const isScanning = ref(false)
const artists = shallowRef<LibraryItem[]>([])
const albums = shallowRef<LibraryItem[]>([])
const genres = shallowRef<LibraryItem[]>([])
const folders = shallowRef<LibraryItem[]>([])
const playlists = ref<Playlist[]>([])
const playlistPersistenceStatus = ref<PlaylistPersistenceStatus>({
  state: 'idle',
  dirty: false,
  failureCount: 0,
  lastError: null
})
const playlistPersistenceNotice = ref<PlaylistPersistenceNotice | null>(null)
const libraryRepairReport = ref<LibraryRepairReport | null>(null)
const excludedTracks = ref<LocalLibraryExclusion[]>([])
const libraryScanStatus = ref<LocalLibraryScanStatus>({
  jobId: null,
  mode: null,
  state: 'idle',
  current: 0,
  total: 0,
  parsedFileCount: 0,
  skippedUnchanged: 0,
  error: ''
})
const libraryScanProgress = ref<LocalLibraryScanProgress | null>(null)
const libraryMetadataEnrichmentStatus = ref<LibraryMetadataEnrichmentStatus>({
  state: 'idle',
  total: 0,
  queued: 0,
  active: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  error: ''
})
let libraryRevision = 0
const trackById = new Map<string, Track>()
const trackByPath = new Map<string, Track>()
const trackIndexById = new Map<string, number>()
let derivedCollectionsInitialized = false
let tracksRevision = 0
let localLogicalTrackMapRevision = -1
let localLogicalTrackMapCache = new Map<string, LogicalTrack>()
let playlistIdentityCache: {
  playlist: Playlist
  trackIds: string[]
  snapshots: Record<string, Track> | undefined
  tracksRevision: number
  ids: Set<string>
  logicalKeys: Set<string>
} | null = null

// Rebuild coalescing state — module-level so it persists across useMusicStore() calls.
let rebuildScheduled = false
let rebuildCount = 0

// Save debounce state — module-level so it persists across useMusicStore() calls.
let saveLibraryTimer: ReturnType<typeof setTimeout> | null = null
const pendingSaveResolvers: Array<{ generation: number; resolve: () => void }> = []
let librarySaveChain: Promise<void> = Promise.resolve()
let libraryMutationGeneration = 0
let libraryRemovalOperations = 0
let librarySaveRetryDelayMs = 500
let pendingRejectedRemoval: { selectedTracks: Track[] } | null = null
let playlistsRevision = 0
let playlistAuthoritativeSnapshot: Playlist[] = []
let playlistPersistence: PlaylistPersistence<Playlist[]> | null = null

// Background post-load state lets callers await enrichment without blocking first render.
let librarySettlementInFlight: Promise<void> | null = null
let libraryMetadataEnrichmentQueue: LibraryMetadataEnrichmentQueue | null = null
let metadataProviderSync: Promise<void> | null = null
const pendingMetadataEnrichmentUpdates = new Map<string, LibraryMetadataEnrichmentTrackUpdate>()
let metadataEnrichmentFlushScheduled = false

export function useMusicStore(): {
  tracks: Ref<Track[]>
  artists: Ref<LibraryItem[]>
  albums: Ref<LibraryItem[]>
  genres: Ref<LibraryItem[]>
  folders: Ref<LibraryItem[]>
  playlists: Ref<Playlist[]>
  playlistPersistenceStatus: Ref<PlaylistPersistenceStatus>
  playlistPersistenceNotice: Ref<PlaylistPersistenceNotice | null>
  libraryRepairReport: Ref<LibraryRepairReport | null>
  excludedTracks: Ref<LocalLibraryExclusion[]>
  libraryScanStatus: Ref<LocalLibraryScanStatus>
  libraryScanProgress: Ref<LocalLibraryScanProgress | null>
  libraryMetadataEnrichmentStatus: Ref<LibraryMetadataEnrichmentStatus>
  addTracks: (newTracks: Track[], options?: AddTracksOptions) => Promise<void>
  removeTrack: (id: string) => void
  removeLocalTracks: (
    selectedTracks: Track[],
    mode: LocalLibraryRemovalMode
  ) => Promise<LocalLibraryRemoveResult>
  restoreExcludedTracks: (filePaths: string[]) => Promise<number>
  /** Reflect only confirmed local tag writes in the cached library snapshot. */
  applyLocalTagWrite: (filePaths: readonly string[], patch: LocalLibraryTagPatch) => number
  clearTrackMetadataMatch: (trackId: string) => boolean
  applyTrackMetadataMatch: (
    trackId: string,
    providerTrack: Track,
    options: ManualMetadataMatchOptions
  ) => boolean
  clearTracks: () => void
  createPlaylist: (name: string) => string
  createPlaylistWithTracks: (name: string, playlistTracks: Track[]) => string
  renamePlaylist: (playlistId: string, name: string) => boolean
  setPlaylistCover: (playlistId: string, cover: string | null) => boolean
  copyPlaylist: (playlistId: string, name: string) => string | null
  reorderPlaylistTracks: (
    playlistName: string,
    trackIds: Iterable<string>,
    targetIndex: number
  ) => boolean
  movePlaylistTracks: (
    sourcePlaylistName: string,
    targetPlaylistName: string,
    trackIds: Iterable<string>
  ) => PlaylistBatchMoveResult
  importPlaylistDocument: (
    name: string,
    fileName: string,
    contents: string
  ) => PlaylistImportApplyResult
  exportPlaylistDocument: (playlistName: string, format: PlaylistFileFormat) => string | null
  repairPlaylistMissingTracks: (
    playlistName: string,
    candidates: Track[]
  ) => PlaylistRelocationResult
  addToPlaylist: (playlistName: string, trackId: string, trackSnapshot?: Track) => void
  addTracksToPlaylist: (playlistName: string, playlistTracks: Track[]) => number
  removeFromPlaylist: (playlistName: string, trackId: string) => void
  removeTracksFromPlaylist: (playlistName: string, trackIds: Iterable<string>) => number
  replaceTrackReference: (oldTrackId: string, replacementTrack: Track) => number
  applyBpmAnalysis: (trackId: string, filePath: string, analysis: Track['bpmAnalysis']) => boolean
  clearBpmAnalysis: () => boolean
  isFavoriteTrack: (track: Track) => boolean
  addFavoriteTrack: (track: Track) => void
  removeFavoriteTrack: (track: Track) => void
  setFavoriteTracks: (favoriteTracks: Track[], favorite: boolean) => number
  deletePlaylist: (playlistId: string) => void
  getPlaylistTracks: (playlistName: string) => Track[]
  savePlaylists: () => Promise<void>
  flushPlaylists: () => Promise<boolean>
  loadPlaylists: () => Promise<void>
  saveLibrary: () => Promise<void>
  scheduleSaveLibrary: () => Promise<void>
  flushSaveLibrary: () => void
  loadLibrary: () => Promise<void>
  whenLibrarySettled: () => Promise<void>
  handleLibraryChange: (change: LibraryChange | undefined) => Promise<void>
  startStartupLibraryScan: () => Promise<LocalLibraryScanUpdate>
  startFullLibraryScan: () => Promise<LocalLibraryScanUpdate>
  resetLibrary: () => Promise<number>
  pauseLibraryScan: () => Promise<boolean>
  resumeLibraryScan: () => Promise<boolean>
  cancelLibraryScan: () => Promise<boolean>
  cancelLibraryMetadataEnrichment: () => boolean
  applyLibraryScanProgress: (progress: LocalLibraryScanProgress) => void
  applyLibraryScanStatus: (status: LocalLibraryScanStatus) => void
  refreshLibraryIndex: () => void
  scannedFolders: Ref<string[]>
  isScanning: Ref<boolean>
  addFolder: (path: string) => void
  removeFolder: (path: string) => void
  syncFolders: (folders: string[]) => void
  flushRebuild: () => void
  getRebuildCount: () => number
  getTrackById: (trackId: string) => Track | undefined
} {
  function setTracks(nextTracks: Track[], options: { rebuildIndexes?: boolean } = {}): void {
    tracks.value = nextTracks
    tracksRevision++
    libraryMutationGeneration++
    if (options.rebuildIndexes !== false) {
      rebuildTrackLookupIndexes(nextTracks)
    }
  }

  function rebuildTrackLookupIndexes(nextTracks: Track[] = tracks.value): void {
    trackById.clear()
    trackByPath.clear()
    trackIndexById.clear()
    nextTracks.forEach((track, index) => {
      trackById.set(track.id, track)
      trackByPath.set(track.filePath, track)
      trackIndexById.set(track.id, index)
    })
  }

  function replaceTrackAtIndex(index: number, nextTrack: Track): void {
    const current = tracks.value[index]
    if (!current) return
    const nextTracks = tracks.value.slice()
    nextTracks[index] = nextTrack
    setTracks(nextTracks, { rebuildIndexes: false })
    trackById.delete(current.id)
    trackByPath.delete(current.filePath)
    trackIndexById.delete(current.id)
    trackById.set(nextTrack.id, nextTrack)
    trackByPath.set(nextTrack.filePath, nextTrack)
    trackIndexById.set(nextTrack.id, index)
  }

  function rebuildDerivedCollections(): void {
    rebuildTrackLookupIndexes()
    const { settings } = useSettingsStore()
    const artistMap = new Map<string, DerivedTrackGroup>()
    const albumMap = new Map<string, DerivedTrackGroup>()
    const genreMap = new Map<string, DerivedTrackGroup>()

    function addToGroup(
      map: Map<string, DerivedTrackGroup>,
      key: string,
      track: Track,
      artist?: string
    ): void {
      let group = map.get(key)
      if (!group) {
        group = { tracks: [], cover: null, artist }
        map.set(key, group)
      }
      group.tracks.push(track)
      if (!group.cover && track.cover) group.cover = track.cover
    }

    for (const track of tracks.value) {
      const artistName = track.artist || '未知艺术家'
      addToGroup(artistMap, artistName, track)

      addToGroup(albumMap, getAlbumIdentity(track), track, track.albumArtist || track.artist)

      const genreNames = splitGenreValues(track.genre, settings.value.genreSeparators)
      if (genreNames.length === 0) {
        addToGroup(genreMap, '未知流派', track)
      } else {
        for (const genreName of genreNames) addToGroup(genreMap, genreName, track)
      }
    }

    artists.value = Array.from(artistMap.entries())
      .map(([name, group]) => ({
        name,
        trackCount: group.tracks.length,
        tracks: group.tracks,
        cover: group.cover
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))

    const mergedAlbumMap = mergeAlbumGroupsByReleaseEvidence(albumMap)
    albums.value = Array.from(mergedAlbumMap.entries())
      .map(([id, group]) => {
        const ordered = [...group.tracks].sort(compareAlbumTrackOrder)
        return {
          id,
          name: ordered[0]?.album || '未知专辑',
          trackCount: ordered.length,
          tracks: ordered,
          cover: group.cover,
          artist: group.artist || ordered[0]?.artist || '未知艺术家'
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh') || (a.id ?? '').localeCompare(b.id ?? ''))

    genres.value = Array.from(genreMap.entries())
      .map(([name, group]) => ({
        name,
        trackCount: group.tracks.length,
        tracks: group.tracks,
        cover: group.cover
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))

    const configuredFolderPaths = deduplicateLibraryPaths([
      ...scannedFolders.value,
      ...settings.value.libraryFolders
    ])
    const configuredFolderRoots = configuredFolderPaths.map((folderPath) => ({
      folderPath,
      normalized: normalizeLibraryPath(folderPath)
    }))
    type FolderGroup = {
      folderPath: string
      normalized: string
      tracks: Track[]
      cover: string | null
    }
    const folderGroups = new Map<string, FolderGroup>()
    const ensureFolderGroup = (folderPath: string): void => {
      const normalized = normalizeLibraryPath(folderPath)
      if (!normalized || folderGroups.has(normalized)) return
      folderGroups.set(normalized, {
        folderPath,
        normalized,
        tracks: [],
        cover: null
      })
    }
    const addTrackToFolderGroup = (group: FolderGroup | undefined, track: Track): void => {
      if (!group) return
      group.tracks.push(track)
      if (!group.cover && track.cover) group.cover = track.cover
    }

    for (const root of configuredFolderRoots) ensureFolderGroup(root.folderPath)

    if (configuredFolderRoots.length === 0) {
      for (const track of tracks.value) {
        ensureFolderGroup(track.dir?.trim() || parentDirectoryOf(track.filePath))
      }
    }

    for (const track of tracks.value) {
      if (configuredFolderRoots.length === 0) {
        const trackDirectory = track.dir?.trim() || parentDirectoryOf(track.filePath)
        addTrackToFolderGroup(folderGroups.get(normalizeLibraryPath(trackDirectory)), track)
        continue
      }

      const matchingRoots = configuredFolderRoots.filter((root) =>
        isTrackUnderLibraryRoot(track.filePath, root.normalized)
      )
      if (matchingRoots.length === 0) continue
      const metadataDirectory = track.dir?.trim() || parentDirectoryOf(track.filePath)
      const currentDirectoryIsBounded = matchingRoots.some((root) =>
        isTrackUnderLibraryRoot(metadataDirectory, root.normalized)
      )
      let currentDirectory = currentDirectoryIsBounded
        ? metadataDirectory
        : parentDirectoryOf(track.filePath)
      const remainingRootPaths = new Set(matchingRoots.map((root) => root.normalized))
      while (currentDirectory) {
        const normalizedCurrent = normalizeLibraryPath(currentDirectory)
        const group = folderGroups.get(normalizedCurrent)
        if (!group) {
          ensureFolderGroup(currentDirectory)
        }
        addTrackToFolderGroup(folderGroups.get(normalizedCurrent), track)
        remainingRootPaths.delete(normalizedCurrent)
        if (remainingRootPaths.size === 0) break
        const parent = parentDirectoryOf(currentDirectory)
        if (!parent || parent === currentDirectory) break
        currentDirectory = parent
      }
    }

    folders.value = [...folderGroups.values()]
      .map(({ folderPath, normalized, tracks: folderTracks, cover }) => {
        const name = normalized.split(/[\\/]/).pop() || folderPath
        return {
          name,
          path: folderPath,
          trackCount: folderTracks.length,
          tracks: folderTracks,
          cover
        }
      })
      .filter((f) => f.trackCount > 0)
      .sort(
        (a, b) => a.name.localeCompare(b.name, 'zh') || (a.path ?? '').localeCompare(b.path ?? '')
      )
  }

  function librarySnapshot(): { revision: number; tracks: Track[]; folders: string[] } {
    return {
      revision: libraryRevision,
      tracks: tracks.value,
      folders: [...scannedFolders.value]
    }
  }

  async function doSaveLibrary(): Promise<void> {
    await enqueueLibraryWrite(async () => {
      const generation = libraryMutationGeneration
      const saved = await persistLibrarySnapshotWithRevisionRecovery()
      applySavedLibraryMetadata(saved)
      librarySaveRetryDelayMs = 500
      resolvePendingLibrarySavesThrough(generation)
    })
  }

  async function saveLibrary(): Promise<void> {
    // Direct save: flush any pending timer and write immediately
    if (saveLibraryTimer !== null) {
      clearTimeout(saveLibraryTimer)
      saveLibraryTimer = null
    }
    try {
      await doSaveLibrary()
    } catch (error) {
      armScheduledLibrarySave()
      throw error
    }
  }

  function scheduleSaveLibrary(): Promise<void> {
    return new Promise<void>((resolve) => {
      pendingSaveResolvers.push({ generation: libraryMutationGeneration, resolve })
      librarySaveRetryDelayMs = 500
      if (saveLibraryTimer !== null) {
        clearTimeout(saveLibraryTimer)
        saveLibraryTimer = null
      }
      armScheduledLibrarySave()
    })
  }

  function flushSaveLibrary(): void {
    if (saveLibraryTimer !== null) {
      clearTimeout(saveLibraryTimer)
      saveLibraryTimer = null
    }
    // Best-effort synchronous save for quit-flush (beforeunload)
    const generation = libraryMutationGeneration
    void window.api.data
      .saveMusicLibrary({
        revision: libraryRevision,
        tracks: tracks.value,
        folders: [...scannedFolders.value]
      })
      .then(
        (saved) => {
          applySavedLibraryMetadata(saved)
          librarySaveRetryDelayMs = 500
          resolvePendingLibrarySavesThrough(generation)
        },
        () => {
          increaseLibrarySaveRetryDelay()
          armScheduledLibrarySave()
        }
      )
  }

  function scheduleRebuild(): void {
    if (rebuildScheduled) return
    rebuildScheduled = true
    queueMicrotask(() => {
      if (!rebuildScheduled) return
      rebuildScheduled = false
      rebuildDerivedCollections()
      rebuildCount++
    })
  }

  function flushRebuild(): void {
    if (rebuildScheduled) {
      rebuildScheduled = false
      rebuildDerivedCollections()
      rebuildCount++
    }
  }

  async function loadLibrary(): Promise<void> {
    const saved = await window.api.data.loadMusicLibrary()
    if (!saved) return

    libraryMetadataEnrichmentQueue?.cancel()
    pendingMetadataEnrichmentUpdates.clear()
    metadataEnrichmentFlushScheduled = false

    let loadedTracks: Track[]
    if (Array.isArray(saved)) {
      loadedTracks = saved as Track[]
      libraryRevision = 0
      excludedTracks.value = []
    } else {
      loadedTracks = (saved.tracks || []) as Track[]
      scannedFolders.value = (saved.folders || []) as string[]
      libraryRevision = Number.isSafeInteger(saved.revision) ? saved.revision : 0
      excludedTracks.value = Array.isArray(saved.exclusions) ? saved.exclusions : []
    }
    // Set tracks immediately so the UI renders local music without waiting for
    // provider metadata enrichment (which can be slow when a provider is unavailable).
    setTracks(loadedTracks)
    rebuildDerivedCollections()
    libraryRepairReport.value = null
    // File-system reconciliation is owned by the main-process incremental scan
    // coordinator. Provider enrichment is queued after the first local render.
    void queueBackgroundMetadataEnrichment(loadedTracks)
  }

  function whenLibrarySettled(): Promise<void> {
    return librarySettlementInFlight ?? Promise.resolve()
  }

  function applyLibraryScanStatus(status: LocalLibraryScanStatus): void {
    libraryScanStatus.value = { ...status }
    if (status.state === 'completed' || status.state === 'cancelled' || status.state === 'failed') {
      libraryScanProgress.value = null
    }
  }

  function applyLibraryScanProgress(progress: LocalLibraryScanProgress): void {
    libraryScanProgress.value = { ...progress }
    libraryScanStatus.value = {
      ...libraryScanStatus.value,
      jobId: progress.jobId,
      mode: progress.mode,
      current: progress.current,
      total: progress.total,
      parsedFileCount: progress.parsedFileCount,
      skippedUnchanged: progress.skippedUnchanged
    }
  }

  function applyLibraryScanUpdate(update: LocalLibraryScanUpdate): void {
    excludedTracks.value = update.exclusions
    libraryRevision = update.libraryRevision
    libraryScanStatus.value = {
      ...libraryScanStatus.value,
      jobId: update.jobId,
      mode: update.mode,
      state: update.state,
      parsedFileCount: update.parsedFileCount,
      skippedUnchanged: update.skippedUnchanged,
      error: ''
    }
    if (update.state === 'cancelled') return

    const excludedPaths = new Set(
      update.exclusions.map((entry) => normalizePortableLibraryPath(entry.filePath))
    )
    const removedPaths = new Set(update.removedFilePaths.map(normalizePortableLibraryPath))
    const replacements = [...update.addedTracks, ...update.updatedTracks].filter(
      (track): track is Track => isLocalLibraryTrack(track)
    )
    const replacementPaths = new Set(
      replacements.map((track) => normalizePortableLibraryPath(track.filePath))
    )
    const replacementIds = new Set(replacements.map((track) => track.id))
    const nextTracks = tracks.value.filter((track) => {
      const key = normalizePortableLibraryPath(track.filePath)
      return (
        !removedPaths.has(key) &&
        !replacementPaths.has(key) &&
        !replacementIds.has(track.id) &&
        !excludedPaths.has(key)
      )
    })
    for (const track of replacements) {
      if (!excludedPaths.has(normalizePortableLibraryPath(track.filePath))) nextTracks.push(track)
    }

    if (removedPaths.size > 0 || excludedPaths.size > 0) {
      const removedIds = tracks.value
        .filter((track) => {
          const key = normalizePortableLibraryPath(track.filePath)
          return removedPaths.has(key) || excludedPaths.has(key)
        })
        .map((track) => track.id)
      notifyLocalTracksUnavailable(removedIds, [...removedPaths, ...excludedPaths])
    }

    const changed =
      nextTracks.length !== tracks.value.length ||
      nextTracks.some((track, index) => track !== tracks.value[index])
    if (!changed) return
    rebuildScheduled = false
    setTracks(nextTracks)
    rebuildDerivedCollections()
    rebuildCount++
    void queueBackgroundMetadataEnrichment(replacements)
  }

  async function startStartupLibraryScan(): Promise<LocalLibraryScanUpdate> {
    const update = await window.api.library.scanStartup()
    applyLibraryScanUpdate(update)
    return update
  }

  async function startFullLibraryScan(): Promise<LocalLibraryScanUpdate> {
    const update = await window.api.library.scanFull()
    applyLibraryScanUpdate(update)
    return update
  }

  async function resetLibrary(): Promise<number> {
    const result = await window.api.library.reset()
    libraryMetadataEnrichmentQueue?.cancel()
    pendingMetadataEnrichmentUpdates.clear()
    metadataEnrichmentFlushScheduled = false
    libraryRevision = result.library.revision
    excludedTracks.value = result.library.exclusions
    setTracks([])
    rebuildDerivedCollections()
    libraryRepairReport.value = null
    notifyLocalTracksUnavailable(result.removedTrackIds, result.removedFilePaths)
    return result.removedTrackIds.length
  }

  async function pauseLibraryScan(): Promise<boolean> {
    return await window.api.library.pauseScan()
  }

  async function resumeLibraryScan(): Promise<boolean> {
    return await window.api.library.resumeScan()
  }

  async function cancelLibraryScan(): Promise<boolean> {
    return await window.api.library.cancelScan()
  }

  function cancelLibraryMetadataEnrichment(): boolean {
    return libraryMetadataEnrichmentQueue?.cancel() ?? false
  }

  async function refreshIncrementalLibrary(): Promise<void> {
    await startStartupLibraryScan()
  }

  async function handleLibraryChange(change: LibraryChange | undefined): Promise<void> {
    if (change?.kind === 'scan') {
      applyLibraryScanUpdate(change.update)
      return
    }
    try {
      // Single file removal
      if (change?.kind === 'remove' && change.path) {
        const track = trackByPath.get(change.path)
        if (track) {
          removeTrack(track.id)
          void scheduleSaveLibrary()
          return
        }
        // Track not found — fall through to full reload
      }

      // Single file addition or content change
      if (change?.kind === 'add' && change.path) {
        const lastSep = Math.max(change.path.lastIndexOf('\\'), change.path.lastIndexOf('/'))
        const dir = lastSep >= 0 ? change.path.slice(0, lastSep) : change.path
        const scanned = await window.api.fs.scanMusicFiles(dir)
        const newTracks = (scanned as Track[]).filter((t) => t.filePath === change.path)
        if (newTracks.length > 0) {
          // If path already exists (content change / tag edit):
          // remove old track first, then add new (remove-then-add)
          const oldTrack = trackByPath.get(change.path)
          if (oldTrack) {
            removeTrack(oldTrack.id)
          }
          await addTracks(newTracks)
          return
        }
        // No tracks found in scan — fall through to full reload
      }

      // Fallback: full reload for unknown/no-path/incremental failure
      await refreshIncrementalLibrary()
    } catch {
      // Incremental parse failed — fallback to full reload
      try {
        await refreshIncrementalLibrary()
      } catch {
        // The main-process scanner reports its failure through scan status.
      }
    }
  }

  async function addTracks(newTracks: Track[], options: AddTracksOptions = {}): Promise<void> {
    const unique: Track[] = []
    for (const track of newTracks) {
      if (isTrackCurrentlyExcluded(track)) continue
      if (trackByPath.has(track.filePath)) continue
      trackByPath.set(track.filePath, track)
      trackById.set(track.id, track)
      unique.push(track)
    }
    if (unique.length === 0) return

    const allowedTracks = unique.filter((track) => !isTrackCurrentlyExcluded(track))
    if (allowedTracks.length !== unique.length) {
      const allowedPaths = new Set(allowedTracks.map((track) => track.filePath))
      for (const track of unique) {
        if (allowedPaths.has(track.filePath)) continue
        if (trackByPath.get(track.filePath)?.id === track.id) trackByPath.delete(track.filePath)
        if (trackById.get(track.id)?.filePath === track.filePath) trackById.delete(track.id)
      }
    }
    if (allowedTracks.length === 0) return
    for (const track of allowedTracks) {
      trackById.set(track.id, track)
      trackByPath.set(track.filePath, track)
    }
    setTracks([...tracks.value, ...allowedTracks])
    if (!options.deferRebuild) {
      scheduleRebuild()
    }
    if (!isScanning.value) {
      void scheduleSaveLibrary()
    }
    void queueBackgroundMetadataEnrichment(allowedTracks)
  }

  function isTrackCurrentlyExcluded(track: Pick<Track, 'filePath'>): boolean {
    const key = normalizePortableLibraryPath(track.filePath)
    return excludedTracks.value.some(
      (exclusion) => normalizePortableLibraryPath(exclusion.filePath) === key
    )
  }

  function removeTrack(id: string): void {
    const track = trackById.get(id)
    if (!track) return
    trackByPath.delete(track.filePath)
    trackById.delete(id)
    setTracks(tracks.value.filter((t) => t.id !== id))
    notifyLocalTracksUnavailable([id], track.filePath ? [track.filePath] : [])
    scheduleRebuild()
  }

  async function removeLocalTracks(
    selectedTracks: Track[],
    mode: LocalLibraryRemovalMode
  ): Promise<LocalLibraryRemoveResult> {
    cancelScheduledLibrarySave()
    libraryRemovalOperations++
    try {
      return await enqueueLibraryWrite(async () => {
        const requestGeneration = libraryMutationGeneration
        let result: LocalLibraryRemoveResult
        try {
          result = await window.api.library.removeTracks({
            mode,
            items: selectedTracks.map((track) => ({
              id: track.id,
              filePath: track.filePath,
              title: track.title,
              artist: track.artist
            })),
            library: librarySnapshot()
          })
        } catch (error) {
          if (mode !== 'trash') throw error
          pendingRejectedRemoval = { selectedTracks }
          const authoritative = await loadAuthoritativeLibraryDocument()
          const recovered = createRecoveredRemovalResult(authoritative, selectedTracks)
          if (!recovered) {
            pendingRejectedRemoval = null
            throw error
          }
          pendingRejectedRemoval = null
          result = recovered
        }
        const changedDuringRemoval = libraryMutationGeneration !== requestGeneration
        applySavedLibraryMetadata(result.library)
        if (result.removedFilePaths.length > 0) {
          applyLocalRemovalDelta(result)
          notifyLocalTracksUnavailable(result.removedTrackIds, result.removedFilePaths)
          resolvePendingLibrarySavesThrough(requestGeneration)
        }

        const pendingSnapshotWasNotCommitted =
          result.removedFilePaths.length === 0 &&
          pendingSaveResolvers.some((pending) => pending.generation <= requestGeneration)
        if (changedDuringRemoval || pendingSnapshotWasNotCommitted) {
          await persistCurrentLibraryUntilStable()
        }
        return result
      })
    } finally {
      libraryRemovalOperations--
      armScheduledLibrarySave()
    }
  }

  async function restoreExcludedTracks(filePaths: string[]): Promise<number> {
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)))
    if (uniquePaths.length === 0) return 0
    cancelScheduledLibrarySave()
    libraryRemovalOperations++
    try {
      const result = await enqueueLibraryWrite(async () => {
        const requestGeneration = libraryMutationGeneration
        const restored = await window.api.library.restoreExclusions({
          filePaths: uniquePaths,
          library: librarySnapshot()
        })
        const changedDuringRestore = libraryMutationGeneration !== requestGeneration
        applySavedLibraryMetadata(restored.library)
        if (restored.restoredFilePaths.length > 0) {
          resolvePendingLibrarySavesThrough(requestGeneration)
        }
        const pendingSnapshotWasNotCommitted =
          restored.restoredFilePaths.length === 0 &&
          pendingSaveResolvers.some((pending) => pending.generation <= requestGeneration)
        if (changedDuringRestore || pendingSnapshotWasNotCommitted) {
          await persistCurrentLibraryUntilStable()
        }
        return restored
      })

      if (result.restoredFilePaths.length > 0) {
        await startStartupLibraryScan()
      }
      return result.restoredFilePaths.length
    } finally {
      libraryRemovalOperations--
      armScheduledLibrarySave()
    }
  }

  function applyLocalTagWrite(filePaths: readonly string[], patch: LocalLibraryTagPatch): number {
    const paths = new Set(filePaths.map(normalizePortableLibraryPath))
    if (paths.size === 0) return 0
    let changed = 0
    const nextTracks = tracks.value.map((track) => {
      if (!paths.has(normalizePortableLibraryPath(track.filePath))) return track
      changed++
      return {
        ...track,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.artist !== undefined ? { artist: patch.artist } : {}),
        ...(patch.album !== undefined ? { album: patch.album } : {}),
        ...(patch.albumArtist !== undefined ? { albumArtist: patch.albumArtist } : {}),
        ...(patch.genre !== undefined ? { genre: patch.genre } : {}),
        ...(patch.track !== undefined ? { trackNumber: patch.track } : {}),
        ...(patch.disc !== undefined ? { discNumber: patch.disc } : {})
      }
    })
    if (changed === 0) return 0
    setTracks(nextTracks, { rebuildIndexes: false })
    scheduleRebuild()
    void scheduleSaveLibrary()
    return changed
  }

  function applyLocalRemovalDelta(result: LocalLibraryRemoveResult): void {
    const removedIds = new Set(result.removedTrackIds)
    const removedPaths = new Set(result.removedFilePaths.map(normalizePortableLibraryPath))
    const nextTracks = tracks.value.filter(
      (track) =>
        !removedIds.has(track.id) && !removedPaths.has(normalizePortableLibraryPath(track.filePath))
    )
    if (nextTracks.length === tracks.value.length) return
    rebuildScheduled = false
    setTracks(nextTracks, { rebuildIndexes: false })
    rebuildDerivedCollections()
    rebuildCount++
  }

  function cancelScheduledLibrarySave(): boolean {
    if (saveLibraryTimer === null) return false
    clearTimeout(saveLibraryTimer)
    saveLibraryTimer = null
    return true
  }

  function resolvePendingLibrarySavesThrough(generation: number): void {
    const remaining: typeof pendingSaveResolvers = []
    for (const pending of pendingSaveResolvers) {
      if (pending.generation <= generation) pending.resolve()
      else remaining.push(pending)
    }
    pendingSaveResolvers.splice(0, pendingSaveResolvers.length, ...remaining)
  }

  function armScheduledLibrarySave(): void {
    if (
      saveLibraryTimer !== null ||
      libraryRemovalOperations > 0 ||
      pendingSaveResolvers.length === 0
    ) {
      return
    }
    saveLibraryTimer = setTimeout(() => {
      saveLibraryTimer = null
      void doSaveLibrary().catch((error) => {
        console.warn('[library] Scheduled save failed; retrying:', error)
        increaseLibrarySaveRetryDelay()
        armScheduledLibrarySave()
      })
    }, librarySaveRetryDelayMs)
  }

  function enqueueLibraryWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = librarySaveChain.then(operation)
    librarySaveChain = result.then(
      () => {},
      () => {}
    )
    return result
  }

  async function persistCurrentLibraryUntilStable(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const generation = libraryMutationGeneration
      const saved = await persistLibrarySnapshotWithRevisionRecovery()
      applySavedLibraryMetadata(saved)
      librarySaveRetryDelayMs = 500
      resolvePendingLibrarySavesThrough(generation)
      if (libraryMutationGeneration === generation) return
    }

    pendingSaveResolvers.push({
      generation: libraryMutationGeneration,
      resolve: () => {}
    })
  }

  async function persistLibrarySnapshotWithRevisionRecovery(): Promise<LocalMusicLibraryDocument> {
    try {
      return await window.api.data.saveMusicLibrary(librarySnapshot())
    } catch (error) {
      if (!isMusicLibraryRevisionConflict(error)) throw error
      const authoritative = await loadAuthoritativeLibraryDocument()
      applySavedLibraryMetadata(authoritative)
      applyPendingRejectedRemoval(authoritative)
      return await window.api.data.saveMusicLibrary(librarySnapshot())
    }
  }

  async function loadAuthoritativeLibraryDocument(): Promise<LocalMusicLibraryDocument> {
    const loaded = await window.api.data.loadMusicLibrary()
    if (Array.isArray(loaded)) {
      throw new Error('Authoritative music library does not expose a revision')
    }
    return loaded
  }

  function applySavedLibraryMetadata(document: LocalMusicLibraryDocument): void {
    libraryRevision = document.revision
    excludedTracks.value = document.exclusions
  }

  function applyPendingRejectedRemoval(document: LocalMusicLibraryDocument): void {
    const intent = pendingRejectedRemoval
    if (!intent) return
    const recovered = createRecoveredRemovalResult(document, intent.selectedTracks)
    pendingRejectedRemoval = null
    if (!recovered) return
    applyLocalRemovalDelta(recovered)
    notifyLocalTracksUnavailable(recovered.removedTrackIds, recovered.removedFilePaths)
  }

  function createRecoveredRemovalResult(
    document: LocalMusicLibraryDocument,
    selectedTracks: Track[]
  ): LocalLibraryRemoveResult | null {
    const authoritativePaths = new Set<string>()
    for (const track of document.tracks) {
      if (!track || typeof track !== 'object' || Array.isArray(track)) continue
      const filePath = (track as { filePath?: unknown }).filePath
      if (typeof filePath === 'string' && filePath) {
        authoritativePaths.add(normalizePortableLibraryPath(filePath))
      }
    }
    const removedPaths = selectedTracks
      .map((track) => track.filePath)
      .filter((filePath) => !authoritativePaths.has(normalizePortableLibraryPath(filePath)))
    if (removedPaths.length === 0) return null
    const pathKeys = new Set(removedPaths.map(normalizePortableLibraryPath))
    const removedTrackIds = tracks.value
      .filter((track) => pathKeys.has(normalizePortableLibraryPath(track.filePath)))
      .map((track) => track.id)
    return {
      mode: 'trash',
      library: document,
      removedTrackIds,
      removedFilePaths: Array.from(new Set(removedPaths)),
      failures: []
    }
  }

  function isMusicLibraryRevisionConflict(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return (
      error.name === 'MusicLibraryRevisionConflictError' ||
      /Music library changed concurrently|expected revision/i.test(error.message)
    )
  }

  function increaseLibrarySaveRetryDelay(): void {
    librarySaveRetryDelayMs = Math.min(30_000, Math.max(500, librarySaveRetryDelayMs * 2))
  }

  function clearTrackMetadataMatch(trackId: string): boolean {
    const index = trackIndexById.get(trackId) ?? -1
    if (index < 0 || !tracks.value[index].metadataMatch) return false

    const nextTrack = {
      ...tracks.value[index],
      metadataMatch: null
    }
    replaceTrackAtIndex(index, nextTrack)
    void scheduleSaveLibrary()
    return true
  }

  function applyTrackMetadataMatch(
    trackId: string,
    providerTrack: Track,
    options: ManualMetadataMatchOptions
  ): boolean {
    const index = trackIndexById.get(trackId) ?? -1
    if (index < 0 || getTrackSource(tracks.value[index]) !== 'local') return false

    const { settings } = useSettingsStore()
    const nextTrack = enrichLocalTrackMetadata(
      tracks.value[index],
      {
        track: providerTrack,
        confidence: options.confidence,
        score: options.score
      },
      settings.value.cachePolicy
    )
    replaceTrackAtIndex(index, nextTrack)
    void scheduleSaveLibrary()
    return true
  }

  function clearTracks(): void {
    libraryMetadataEnrichmentQueue?.cancel()
    pendingMetadataEnrichmentUpdates.clear()
    metadataEnrichmentFlushScheduled = false
    librarySettlementInFlight = null
    rebuildScheduled = false
    setTracks([])
    rebuildDerivedCollections()
  }

  function clonePlaylistSnapshot(source: Playlist[] = playlists.value): Playlist[] {
    // Freeze the queued transaction and strip Vue proxies before it reaches the
    // persistence queue. toRaw unwraps the reactive root (nested storage stays
    // raw); the JSON fallback covers a reactive proxy ever nested in the tree,
    // which Chromium's structuredClone serializer rejects outright.
    const raw = toRaw(source)
    try {
      return structuredClone(raw)
    } catch {
      return JSON.parse(JSON.stringify(raw)) as Playlist[]
    }
  }

  function getPlaylistPersistence(): PlaylistPersistence<Playlist[]> {
    if (playlistPersistence) return playlistPersistence
    playlistPersistence = new PlaylistPersistence({
      write: persistPlaylistSnapshot,
      onStatus: (status) => {
        playlistPersistenceStatus.value = status
      },
      flushDelayMs: 250,
      retryDelayMs: 1_000,
      // queuePlaylistPersistence only ever enqueues clonePlaylistSnapshot()
      // results (frozen plain data), so the queue does not need to re-clone.
      cloneSnapshot: (snapshot) => snapshot
    })
    return playlistPersistence
  }

  function queuePlaylistPersistence(
    base = clonePlaylistSnapshot(playlistAuthoritativeSnapshot)
  ): void {
    playlistIdentityCache = null
    getPlaylistPersistence().enqueue(clonePlaylistSnapshot(), base)
  }

  function ensurePlaylist(name: string, options: { isDefault?: boolean } = {}): Playlist {
    const existing = playlists.value.find((playlist) => playlist.name === name)
    if (existing) return existing
    const playlist: Playlist = {
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      trackIds: [],
      ...(options.isDefault ? { isDefault: true } : {}),
      createdAt: new Date().toISOString()
    }
    playlists.value = [...playlists.value, playlist]
    return playlist
  }

  function createPlaylist(name: string): string {
    const existing = playlists.value.find((playlist) => playlist.name === name)
    if (existing) return existing.id
    const base = clonePlaylistSnapshot()
    const playlist = ensurePlaylist(name)
    queuePlaylistPersistence(base)
    return playlist.id
  }

  function createPlaylistWithTracks(name: string, playlistTracks: Track[]): string {
    const base = clonePlaylistSnapshot()
    const existing = playlists.value.find((playlist) => playlist.name === name)
    const playlist = existing ?? ensurePlaylist(name)
    const changed = appendTracksToPlaylist(playlist, playlistTracks)
    if (!existing || changed) queuePlaylistPersistence(base)
    return playlist.id
  }

  function normalizePlaylistName(value: string): string {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (!normalized) throw new Error('歌单名称不能为空')
    if (normalized.length > 80) throw new Error('歌单名称不能超过 80 个字符')
    return normalized
  }

  function touchPlaylist(playlist: Playlist): void {
    playlist.updatedAt = new Date().toISOString()
  }

  function renamePlaylist(playlistId: string, name: string): boolean {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist) return false
    const normalizedName = normalizePlaylistName(name)
    if (playlist.name === normalizedName) return false
    if (playlists.value.some((item) => item.id !== playlistId && item.name === normalizedName)) {
      throw new Error('已存在同名歌单')
    }
    const base = clonePlaylistSnapshot()
    playlist.name = normalizedName
    touchPlaylist(playlist)
    queuePlaylistPersistence(base)
    return true
  }

  function setPlaylistCover(playlistId: string, cover: string | null): boolean {
    const playlist = playlists.value.find((item) => item.id === playlistId)
    if (!playlist) return false
    const nextCover = cover?.trim() || null
    if (nextCover && nextCover.length > 8 * 1024 * 1024) {
      throw new Error('歌单封面数据超过 8 MiB 上限')
    }
    if (nextCover && !/^(data:image\/(?:png|jpeg|webp);base64,|cover:\/\/)/i.test(nextCover)) {
      throw new Error('歌单封面必须是受支持的图片数据')
    }
    if ((playlist.cover ?? null) === nextCover) return false
    const base = clonePlaylistSnapshot()
    playlist.cover = nextCover
    touchPlaylist(playlist)
    queuePlaylistPersistence(base)
    return true
  }

  function copyPlaylist(playlistId: string, name: string): string | null {
    const source = playlists.value.find((item) => item.id === playlistId)
    if (!source) return null
    const normalizedName = normalizePlaylistName(name)
    if (playlists.value.some((item) => item.name === normalizedName)) {
      throw new Error('已存在同名歌单')
    }
    const base = clonePlaylistSnapshot()
    const now = new Date().toISOString()
    const copy: Playlist = {
      ...clonePlaylist(source),
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: normalizedName,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    }
    playlists.value = [...playlists.value, copy]
    queuePlaylistPersistence(base)
    return copy.id
  }

  function reorderPlaylistTracks(
    playlistName: string,
    trackIds: Iterable<string>,
    targetIndex: number
  ): boolean {
    const playlist = playlists.value.find((item) => item.name === playlistName)
    if (!playlist || !Number.isInteger(targetIndex)) return false
    const nextTrackIds = reorderStableIds(playlist.trackIds, trackIds, targetIndex)
    if (playlistDataEqual(nextTrackIds, playlist.trackIds)) return false
    const base = clonePlaylistSnapshot()
    playlist.trackIds = nextTrackIds
    touchPlaylist(playlist)
    queuePlaylistPersistence(base)
    return true
  }

  function movePlaylistTracks(
    sourcePlaylistName: string,
    targetPlaylistName: string,
    trackIds: Iterable<string>
  ): PlaylistBatchMoveResult {
    const source = playlists.value.find((item) => item.name === sourcePlaylistName)
    const target = playlists.value.find((item) => item.name === targetPlaylistName)
    if (!source || !target || source === target) return { moved: 0, sourceRemoved: 0 }
    const selected = new Set(trackIds)
    if (selected.size === 0) return { moved: 0, sourceRemoved: 0 }
    const sourceIds = source.trackIds.filter((id) => selected.has(id))
    if (sourceIds.length === 0) return { moved: 0, sourceRemoved: 0 }
    const base = clonePlaylistSnapshot()
    const targetKnown = new Set(target.trackIds)
    const nextTargetIds = target.trackIds.slice()
    const nextTargetSnapshots = { ...(target.trackSnapshots ?? {}) }
    let moved = 0
    for (const id of sourceIds) {
      if (!targetKnown.has(id)) {
        targetKnown.add(id)
        nextTargetIds.push(id)
        moved++
      }
      const snapshot = source.trackSnapshots?.[id] ?? trackById.get(id)
      if (snapshot && !nextTargetSnapshots[id])
        nextTargetSnapshots[id] = toPlaylistTrackSnapshot(snapshot)
    }
    source.trackIds = source.trackIds.filter((id) => !selected.has(id))
    if (source.trackSnapshots) {
      const nextSourceSnapshots = { ...source.trackSnapshots }
      for (const id of selected) delete nextSourceSnapshots[id]
      source.trackSnapshots =
        Object.keys(nextSourceSnapshots).length > 0 ? nextSourceSnapshots : undefined
    }
    target.trackIds = nextTargetIds
    target.trackSnapshots =
      Object.keys(nextTargetSnapshots).length > 0 ? nextTargetSnapshots : undefined
    touchPlaylist(source)
    touchPlaylist(target)
    queuePlaylistPersistence(base)
    return { moved, sourceRemoved: sourceIds.length }
  }

  function importPlaylistDocument(
    name: string,
    fileName: string,
    contents: string
  ): PlaylistImportApplyResult {
    const parsed = parsePlaylistDocument(contents, fileName)
    const normalizedName = normalizePlaylistName(name)
    const byPath = new Map<string, Track>()
    for (const track of tracks.value)
      byPath.set(normalizePortableLibraryPath(track.filePath), track)
    const imported: Track[] = []
    let unresolvedEntries = 0
    for (const entry of parsed.entries) {
      const normalizedPath = normalizePortableLibraryPath(entry.path)
      let matched = byPath.get(normalizedPath)
      if (!matched && !/^[a-zA-Z]:\\/.test(normalizedPath) && !normalizedPath.startsWith('\\')) {
        const suffix = `\\${normalizedPath}`
        const candidates = tracks.value.filter((track) =>
          normalizePortableLibraryPath(track.filePath).endsWith(suffix)
        )
        if (candidates.length === 1) matched = candidates[0]
      }
      if (matched) imported.push(matched)
      else unresolvedEntries++
    }
    const base = clonePlaylistSnapshot()
    const existing = playlists.value.find((item) => item.name === normalizedName)
    const playlist = existing ?? ensurePlaylist(normalizedName)
    const changed = appendTracksToPlaylist(playlist, imported)
    if (changed || !existing) {
      touchPlaylist(playlist)
      queuePlaylistPersistence(base)
    }
    return {
      playlistId: playlist.id,
      importedCount: imported.length,
      unresolvedEntries,
      warnings: parsed.warnings
    }
  }

  function exportPlaylistDocumentForStore(
    playlistName: string,
    format: PlaylistFileFormat
  ): string | null {
    const playlist = playlists.value.find((item) => item.name === playlistName)
    if (!playlist) return null
    return exportPlaylistDocument(getPlaylistTracks(playlistName), format)
  }

  function repairPlaylistMissingTracks(
    playlistName: string,
    candidates: Track[]
  ): PlaylistRelocationResult {
    const playlist = playlists.value.find((item) => item.name === playlistName)
    if (!playlist) return { relocations: [], unresolvedTrackIds: [], ambiguousTrackIds: [] }
    const missing = playlist.trackIds
      .filter((id) => !trackById.has(id))
      .map((id) => playlist.trackSnapshots?.[id])
      .filter((track): track is Track => !!track && getTrackSource(track) === 'local')
    const result = findPlaylistRelocations(missing, candidates)
    if (result.relocations.length === 0) return result
    const base = clonePlaylistSnapshot()
    const replacements = new Map(result.relocations.map((item) => [item.trackId, item.toTrack]))
    const nextTrackIds: string[] = []
    const snapshots: Record<string, Track> = { ...(playlist.trackSnapshots ?? {}) }
    const seen = new Set<string>()
    for (const id of playlist.trackIds) {
      const replacement = replacements.get(id)
      const nextId = replacement?.id ?? id
      if (seen.has(nextId)) continue
      seen.add(nextId)
      nextTrackIds.push(nextId)
      if (replacement) {
        delete snapshots[id]
        snapshots[nextId] = toPlaylistTrackSnapshot(replacement)
      }
    }
    playlist.trackIds = nextTrackIds
    playlist.trackSnapshots = Object.keys(snapshots).length > 0 ? snapshots : undefined
    touchPlaylist(playlist)
    queuePlaylistPersistence(base)
    return result
  }

  function deletePlaylist(playlistId: string): void {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl || pl.isDefault) return
    const base = clonePlaylistSnapshot()
    playlists.value = playlists.value.filter((p) => p.id !== playlistId)
    queuePlaylistPersistence(base)
  }

  function addToPlaylist(playlistName: string, trackId: string, trackSnapshot?: Track): void {
    const track = trackSnapshot ?? trackById.get(trackId)
    if (track) {
      addTracksToPlaylist(playlistName, [track])
      return
    }
    const playlist = playlists.value.find((item) => item.name === playlistName)
    if (!playlist || playlist.trackIds.includes(trackId)) return
    const base = clonePlaylistSnapshot()
    playlist.trackIds = [...playlist.trackIds, trackId]
    queuePlaylistPersistence(base)
  }

  function appendTracksToPlaylist(playlist: Playlist, playlistTracks: Track[]): boolean {
    const knownIds = new Set(playlist.trackIds)
    const nextTrackIds = playlist.trackIds.slice()
    const nextSnapshots = { ...(playlist.trackSnapshots ?? {}) }
    let changed = false
    for (const track of playlistTracks) {
      if (!knownIds.has(track.id)) {
        knownIds.add(track.id)
        nextTrackIds.push(track.id)
        changed = true
      }
      const snapshot = toPlaylistTrackSnapshot(track)
      if (!nextSnapshots[track.id]) {
        nextSnapshots[track.id] = snapshot
        changed = true
      }
    }
    if (!changed) return false
    playlist.trackIds = nextTrackIds
    playlist.trackSnapshots = Object.keys(nextSnapshots).length > 0 ? nextSnapshots : undefined
    return true
  }

  function addTracksToPlaylist(playlistName: string, playlistTracks: Track[]): number {
    const playlist = playlists.value.find((item) => item.name === playlistName)
    if (!playlist || playlistTracks.length === 0) return 0
    const base = clonePlaylistSnapshot()
    const beforeCount = playlist.trackIds.length
    const changed = appendTracksToPlaylist(playlist, playlistTracks)
    if (changed) queuePlaylistPersistence(base)
    return playlist.trackIds.length - beforeCount
  }

  function getLibraryMetadataEnrichmentQueue(): LibraryMetadataEnrichmentQueue {
    if (libraryMetadataEnrichmentQueue) return libraryMetadataEnrichmentQueue
    libraryMetadataEnrichmentQueue = new LibraryMetadataEnrichmentQueue({
      provider: {
        searchSongs: async (query, limit, offset) => {
          await (metadataProviderSync ?? syncPluginProviders())
          const providers = useMediaProviders()
          const result = await providers.searchAllSongs({
            query,
            localTracks: [],
            limit,
            offset
          })
          const items = result.items.map((item) => item.track)
          return { items, total: items.length }
        }
      },
      onStatus: (status) => {
        libraryMetadataEnrichmentStatus.value = status
      },
      onTrackEnriched: queueMetadataEnrichmentUpdate
    })
    return libraryMetadataEnrichmentQueue
  }

  function queueBackgroundMetadataEnrichment(inputTracks: Track[]): Promise<void> {
    if (inputTracks.length === 0) return Promise.resolve()
    const { settings } = useSettingsStore()
    const cachePolicy = settings.value.cachePolicy
    if (!cachePolicy.cover && !cachePolicy.lyrics && !cachePolicy.metadata) return Promise.resolve()

    metadataProviderSync = syncPluginProviders().catch((error) => {
      metadataProviderSync = null
      throw error
    })
    const completion = getLibraryMetadataEnrichmentQueue().enqueue(inputTracks, cachePolicy)
    librarySettlementInFlight = completion
    void completion.finally(() => {
      if (librarySettlementInFlight === completion) librarySettlementInFlight = null
    })
    return completion
  }

  function queueMetadataEnrichmentUpdate(update: LibraryMetadataEnrichmentTrackUpdate): void {
    const current = trackById.get(update.track.id)
    if (
      !current ||
      current !== update.source ||
      getTrackSource(current) !== 'local' ||
      current.filePath !== update.track.filePath
    ) {
      return
    }
    pendingMetadataEnrichmentUpdates.set(update.track.id, update)
    if (metadataEnrichmentFlushScheduled) return
    metadataEnrichmentFlushScheduled = true
    queueMicrotask(flushMetadataEnrichmentUpdates)
  }

  function flushMetadataEnrichmentUpdates(): void {
    metadataEnrichmentFlushScheduled = false
    if (pendingMetadataEnrichmentUpdates.size === 0) return
    const updates = new Map(pendingMetadataEnrichmentUpdates)
    pendingMetadataEnrichmentUpdates.clear()
    const nextTracks = tracks.value.slice()
    let changed = false
    for (const [trackId, update] of updates) {
      const index = trackIndexById.get(trackId) ?? -1
      const current = index >= 0 ? nextTracks[index] : undefined
      if (
        !current ||
        current !== update.source ||
        getTrackSource(current) !== 'local' ||
        current.filePath !== update.track.filePath
      ) {
        continue
      }
      nextTracks[index] = update.track
      trackById.set(trackId, update.track)
      trackByPath.set(update.track.filePath, update.track)
      changed = true
    }
    if (!changed) return
    setTracks(nextTracks, { rebuildIndexes: false })
    scheduleRebuild()
    void scheduleSaveLibrary()
  }

  function removeFromPlaylist(playlistName: string, trackId: string): void {
    removeTracksFromPlaylist(playlistName, [trackId])
  }

  function removeTracksFromPlaylist(playlistName: string, trackIds: Iterable<string>): number {
    const playlist = playlists.value.find((item) => item.name === playlistName)
    if (!playlist) return 0
    const removedIds = new Set(trackIds)
    if (removedIds.size === 0) return 0
    const nextTrackIds = playlist.trackIds.filter((trackId) => !removedIds.has(trackId))
    const removedCount = playlist.trackIds.length - nextTrackIds.length
    if (removedCount === 0) return 0
    const base = clonePlaylistSnapshot()
    playlist.trackIds = nextTrackIds
    if (playlist.trackSnapshots) {
      const nextSnapshots = { ...playlist.trackSnapshots }
      for (const trackId of removedIds) delete nextSnapshots[trackId]
      playlist.trackSnapshots = Object.keys(nextSnapshots).length > 0 ? nextSnapshots : undefined
    }
    queuePlaylistPersistence(base)
    return removedCount
  }

  function getDefaultFavoritePlaylist(): Playlist | null {
    return (
      playlists.value.find((playlist) => playlist.isDefault) ??
      playlists.value.find((playlist) => playlist.name === DEFAULT_FAVORITE_PLAYLIST_NAME) ??
      null
    )
  }

  function getPlaylistTrackSnapshot(playlist: Playlist, trackId: string): Track | undefined {
    return trackById.get(trackId) ?? playlist.trackSnapshots?.[trackId]
  }

  function getPlaylistIdentity(playlist: Playlist): { ids: Set<string>; logicalKeys: Set<string> } {
    if (
      playlistIdentityCache &&
      playlistIdentityCache.playlist === playlist &&
      playlistIdentityCache.trackIds === playlist.trackIds &&
      playlistIdentityCache.snapshots === playlist.trackSnapshots &&
      playlistIdentityCache.tracksRevision === tracksRevision
    ) {
      return playlistIdentityCache
    }

    const ids = new Set<string>()
    const logicalKeys = new Set<string>()
    for (const trackId of playlist.trackIds) {
      ids.add(trackId)
      const snapshot = getPlaylistTrackSnapshot(playlist, trackId)
      if (snapshot) logicalKeys.add(getLogicalTrackKey(snapshot))
    }
    playlistIdentityCache = {
      playlist,
      trackIds: playlist.trackIds,
      snapshots: playlist.trackSnapshots,
      tracksRevision,
      ids,
      logicalKeys
    }
    return playlistIdentityCache
  }

  function resolvePlaylistTrack(
    playlist: Playlist,
    trackId: string,
    getLocalLogicalTracks: () => Map<string, LogicalTrack>
  ): Track | undefined {
    const exact = trackById.get(trackId)
    if (exact) return exact
    const snapshot = playlist.trackSnapshots?.[trackId]
    if (!snapshot) return undefined
    const key = getLogicalTrackKey(snapshot)
    const localReplacement = getLocalLogicalTracks().get(key)?.preferredTrack
    if (localReplacement) return localReplacement
    return getTrackSource(snapshot) === 'local' ? undefined : snapshot
  }

  function getLocalLogicalTrackMap(): Map<string, LogicalTrack> {
    if (localLogicalTrackMapRevision === tracksRevision) {
      return localLogicalTrackMapCache
    }

    const result = new Map<string, LogicalTrack>()
    const localInputs = (function* () {
      for (const track of tracks.value) {
        if (getTrackSource(track) !== 'local') continue
        yield {
          track,
          source: 'local' as const,
          sourceName: '本地音乐',
          providerAvailable: true
        }
      }
    })()

    for (const logicalTrack of buildLogicalTracks(localInputs)) {
      if (!result.has(logicalTrack.id)) result.set(logicalTrack.id, logicalTrack)
    }
    localLogicalTrackMapCache = result
    localLogicalTrackMapRevision = tracksRevision
    return result
  }

  function isFavoriteTrack(track: Track): boolean {
    const playlist = getDefaultFavoritePlaylist()
    if (!playlist) return false
    const identity = getPlaylistIdentity(playlist)
    return identity.ids.has(track.id) || identity.logicalKeys.has(getLogicalTrackKey(track))
  }

  function addFavoriteTrack(track: Track): void {
    setFavoriteTracks([track], true)
  }

  function removeFavoriteTrack(track: Track): void {
    setFavoriteTracks([track], false)
  }

  function setFavoriteTracks(favoriteTracks: Track[], favorite: boolean): number {
    if (favoriteTracks.length === 0) return 0
    const playlist = getDefaultFavoritePlaylist()
    if (favorite) {
      const base = clonePlaylistSnapshot()
      const target = playlist ?? ensurePlaylist(DEFAULT_FAVORITE_PLAYLIST_NAME, { isDefault: true })
      const identity = getPlaylistIdentity(target)
      const knownIds = new Set(identity.ids)
      const knownLogicalKeys = new Set(identity.logicalKeys)
      const toAdd = favoriteTracks.filter((track) => {
        const logicalKey = getLogicalTrackKey(track)
        if (knownIds.has(track.id) || knownLogicalKeys.has(logicalKey)) return false
        knownIds.add(track.id)
        knownLogicalKeys.add(logicalKey)
        return true
      })
      const created = !playlist
      const added = appendTracksToPlaylist(target, toAdd)
      if (created || added) queuePlaylistPersistence(base)
      return toAdd.length
    }

    if (!playlist) return 0
    const ids = new Set(favoriteTracks.map((track) => track.id))
    const logicalKeys = new Set(favoriteTracks.map(getLogicalTrackKey))
    const nextTrackIds = playlist.trackIds.filter((trackId) => {
      if (ids.has(trackId)) return false
      const snapshot = getPlaylistTrackSnapshot(playlist, trackId)
      return !snapshot || !logicalKeys.has(getLogicalTrackKey(snapshot))
    })
    const removedCount = playlist.trackIds.length - nextTrackIds.length
    if (removedCount === 0) return 0
    const base = clonePlaylistSnapshot()
    const keptTrackIds = new Set(nextTrackIds)
    playlist.trackIds = nextTrackIds
    if (playlist.trackSnapshots) {
      const snapshots = { ...playlist.trackSnapshots }
      for (const trackId of Object.keys(snapshots)) {
        if (!keptTrackIds.has(trackId)) delete snapshots[trackId]
      }
      playlist.trackSnapshots = Object.keys(snapshots).length > 0 ? snapshots : undefined
    }
    queuePlaylistPersistence(base)
    return removedCount
  }

  function replaceTrackReference(oldTrackId: string, replacementTrack: Track): number {
    if (!oldTrackId || oldTrackId === replacementTrack.id) return 0
    const playlistBase = clonePlaylistSnapshot()
    let replacementCount = 0
    let libraryChanged = false
    let playlistsChanged = false

    if (trackById.has(oldTrackId)) {
      const oldTrack = trackById.get(oldTrackId)
      if (oldTrack) trackByPath.delete(oldTrack.filePath)
      trackById.delete(oldTrackId)
      trackById.set(replacementTrack.id, replacementTrack)
      trackByPath.set(replacementTrack.filePath, replacementTrack)
      setTracks(tracks.value.map((track) => (track.id === oldTrackId ? replacementTrack : track)))
      libraryChanged = true
      replacementCount++
    }

    for (const playlist of playlists.value) {
      if (!playlist.trackIds.includes(oldTrackId)) continue
      const nextTrackIds: string[] = []
      const seenTrackIds = new Set<string>()
      for (const trackId of playlist.trackIds) {
        const nextTrackId = trackId === oldTrackId ? replacementTrack.id : trackId
        if (seenTrackIds.has(nextTrackId)) continue
        seenTrackIds.add(nextTrackId)
        nextTrackIds.push(nextTrackId)
      }
      playlist.trackIds = nextTrackIds
      const snapshots = { ...(playlist.trackSnapshots ?? {}) }
      delete snapshots[oldTrackId]
      snapshots[replacementTrack.id] = toPlaylistTrackSnapshot(replacementTrack)
      playlist.trackSnapshots = Object.keys(snapshots).length > 0 ? snapshots : undefined
      playlistsChanged = true
      replacementCount++
    }

    if (libraryChanged) {
      scheduleRebuild()
      void scheduleSaveLibrary()
    }
    if (playlistsChanged) queuePlaylistPersistence(playlistBase)
    return replacementCount
  }

  function applyBpmAnalysis(
    trackId: string,
    filePath: string,
    analysis: Track['bpmAnalysis']
  ): boolean {
    if (!analysis) return false
    const fallbackTrackId = filePath ? trackByPath.get(filePath)?.id : undefined
    const index =
      trackIndexById.get(trackId) ??
      (fallbackTrackId ? trackIndexById.get(fallbackTrackId) : undefined) ??
      -1
    if (index < 0) return false
    const nextTrack = {
      ...tracks.value[index],
      bpmAnalysis: analysis
    }
    replaceTrackAtIndex(index, nextTrack)

    const playlistBase = clonePlaylistSnapshot()
    let playlistsChanged = false
    for (const playlist of playlists.value) {
      const snapshot = playlist.trackSnapshots?.[trackId] ?? playlist.trackSnapshots?.[nextTrack.id]
      if (!snapshot) continue
      playlist.trackSnapshots = {
        ...(playlist.trackSnapshots ?? {}),
        [nextTrack.id]: toPlaylistTrackSnapshot({
          ...snapshot,
          bpmAnalysis: analysis
        })
      }
      playlistsChanged = true
    }

    void scheduleSaveLibrary()
    if (playlistsChanged) queuePlaylistPersistence(playlistBase)
    return true
  }

  function clearBpmAnalysis(): boolean {
    let libraryChanged = false
    const nextTracks = tracks.value.map((track) => {
      if (!track.bpmAnalysis) return track
      const { bpmAnalysis: _bpmAnalysis, ...nextTrack } = track
      libraryChanged = true
      return nextTrack
    })
    if (libraryChanged) {
      setTracks(nextTracks)
      scheduleRebuild()
      void scheduleSaveLibrary()
    }

    const playlistBase = clonePlaylistSnapshot()
    let playlistsChanged = false
    for (const playlist of playlists.value) {
      if (!playlist.trackSnapshots) continue
      let snapshotChanged = false
      const nextSnapshots: Record<string, Track> = {}
      for (const [trackId, snapshot] of Object.entries(playlist.trackSnapshots)) {
        if (snapshot.bpmAnalysis) {
          const { bpmAnalysis: _bpmAnalysis, ...nextSnapshot } = snapshot
          nextSnapshots[trackId] = nextSnapshot
          snapshotChanged = true
        } else {
          nextSnapshots[trackId] = snapshot
        }
      }
      if (snapshotChanged) {
        playlist.trackSnapshots = nextSnapshots
        playlistsChanged = true
      }
    }
    if (playlistsChanged) queuePlaylistPersistence(playlistBase)
    return libraryChanged || playlistsChanged
  }

  function getPlaylistTracks(playlistName: string): Track[] {
    const pl = playlists.value.find((p) => p.name === playlistName)
    if (!pl) return []
    let localLogicalTracks: Map<string, LogicalTrack> | null = null
    const getLocalLogicalTracks = (): Map<string, LogicalTrack> => {
      localLogicalTracks ??= getLocalLogicalTrackMap()
      return localLogicalTracks
    }
    return pl.trackIds
      .map((trackId) => resolvePlaylistTrack(pl, trackId, getLocalLogicalTracks))
      .filter((track): track is Track => !!track)
  }

  function isPlaylistData(value: unknown): value is Playlist[] {
    return Array.isArray(value)
  }

  async function loadPlaylistEnvelopeForConflict(): Promise<VersionedDataEnvelope<
    Playlist[]
  > | null> {
    const loaded = await window.api.data.loadPlaylists()
    return isVersionedDataEnvelope(loaded, isPlaylistData) ? loaded : null
  }

  async function persistPlaylistSnapshot(snapshot: Playlist[], base: Playlist[]): Promise<void> {
    let expectedRevision = playlistsRevision
    // A preceding queued write may have recovered a CAS conflict while this
    // transaction was waiting. In that case `base` predates the newly merged
    // authoritative snapshot even though `expectedRevision` is current. Replay
    // the local delta before the first attempt so the next successful write
    // cannot silently erase data recovered by the previous transaction.
    let desired = playlistDataEqual(base, playlistAuthoritativeSnapshot)
      ? snapshot
      : replayPlaylistTransaction(base, snapshot, playlistAuthoritativeSnapshot)
    let recoveredConflictRevision: number | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const saved = await window.api.data.savePlaylists(desired, expectedRevision)
        if (isVersionedDataEnvelope(saved, isPlaylistData)) {
          playlistsRevision = saved.revision
          playlistAuthoritativeSnapshot = clonePlaylistSnapshot(saved.data)
          // Do not overwrite an action that arrived while this write was in flight.
          if (playlistDataEqual(playlists.value, snapshot)) {
            playlists.value = clonePlaylistSnapshot(saved.data)
            playlistIdentityCache = null
          }
        } else {
          playlistAuthoritativeSnapshot = clonePlaylistSnapshot(desired)
        }
        if (recoveredConflictRevision !== null) {
          playlistPersistenceNotice.value = {
            kind: 'revision-conflict-recovered',
            message: '检测到歌单被其他窗口更新，已合并权威版本并保存本次修改',
            authoritativeRevision: recoveredConflictRevision,
            recoveredAt: new Date().toISOString()
          }
        }
        return
      } catch (error) {
        if (!isPersistentDataRevisionConflict(error)) throw error
        const current = isVersionedDataEnvelope(error.current, isPlaylistData)
          ? error.current
          : await loadPlaylistEnvelopeForConflict()
        if (!current) throw error
        // Reapply only the immutable local delta to the authoritative snapshot.
        // Sending the old whole-file snapshot here would erase concurrent edits.
        desired = replayPlaylistTransaction(base, snapshot, current.data)
        playlistsRevision = current.revision
        expectedRevision = current.revision
        recoveredConflictRevision = current.revision
      }
    }
    throw new Error('Playlist persistence revision conflict did not settle after 3 retries')
  }

  async function savePlaylists(): Promise<void> {
    queuePlaylistPersistence()
  }

  async function flushPlaylists(): Promise<boolean> {
    return getPlaylistPersistence().flush()
  }

  async function loadPlaylists(): Promise<void> {
    const loadedResult = await window.api.data.loadPlaylists()
    const saved = isVersionedDataEnvelope(loadedResult, isPlaylistData)
      ? loadedResult.data
      : loadedResult
    playlistsRevision = isVersionedDataEnvelope(loadedResult, isPlaylistData)
      ? loadedResult.revision
      : 0
    const DEFAULT_PLAYLIST: Playlist = {
      id: 'pl_favorites',
      name: '我收藏的音乐',
      trackIds: [],
      isDefault: true,
      createdAt: new Date().toISOString()
    }

    if (!saved || !Array.isArray(saved) || saved.length === 0) {
      // First launch: create default playlist
      playlists.value = [DEFAULT_PLAYLIST]
      playlistAuthoritativeSnapshot = []
      queuePlaylistPersistence([])
      return
    }

    const loaded = saved as Playlist[]
    // Ensure default playlist exists
    if (!loaded.find((p) => p.isDefault)) {
      loaded.unshift(DEFAULT_PLAYLIST)
    }
    playlists.value = loaded
    playlistAuthoritativeSnapshot = clonePlaylistSnapshot(loaded)
  }

  if (!derivedCollectionsInitialized) {
    rebuildDerivedCollections()
    derivedCollectionsInitialized = true
  }

  return {
    tracks,
    artists,
    albums,
    genres,
    folders,
    playlists,
    playlistPersistenceStatus,
    playlistPersistenceNotice,
    libraryRepairReport,
    excludedTracks,
    addTracks,
    removeTrack,
    removeLocalTracks,
    restoreExcludedTracks,
    applyLocalTagWrite,
    clearTrackMetadataMatch,
    applyTrackMetadataMatch,
    clearTracks,
    createPlaylist,
    createPlaylistWithTracks,
    renamePlaylist,
    setPlaylistCover,
    copyPlaylist,
    reorderPlaylistTracks,
    movePlaylistTracks,
    importPlaylistDocument,
    exportPlaylistDocument: exportPlaylistDocumentForStore,
    repairPlaylistMissingTracks,
    addToPlaylist,
    addTracksToPlaylist,
    removeFromPlaylist,
    removeTracksFromPlaylist,
    replaceTrackReference,
    applyBpmAnalysis,
    clearBpmAnalysis,
    isFavoriteTrack,
    addFavoriteTrack,
    removeFavoriteTrack,
    setFavoriteTracks,
    deletePlaylist,
    getPlaylistTracks,
    savePlaylists,
    flushPlaylists,
    loadPlaylists,
    saveLibrary,
    loadLibrary,
    whenLibrarySettled,
    libraryScanStatus,
    libraryScanProgress,
    libraryMetadataEnrichmentStatus,
    startStartupLibraryScan,
    startFullLibraryScan,
    resetLibrary,
    pauseLibraryScan,
    resumeLibraryScan,
    cancelLibraryScan,
    cancelLibraryMetadataEnrichment,
    applyLibraryScanProgress,
    applyLibraryScanStatus,
    refreshLibraryIndex: rebuildDerivedCollections,
    scannedFolders,
    isScanning,
    addFolder(path: string): void {
      if (!scannedFolders.value.includes(path)) {
        scannedFolders.value.push(path)
        libraryMutationGeneration++
        rebuildDerivedCollections()
        saveLibrary()
      }
    },
    removeFolder(path: string): void {
      scannedFolders.value = scannedFolders.value.filter((f) => f !== path)
      libraryMutationGeneration++
      rebuildDerivedCollections()
      saveLibrary()
    },
    syncFolders(folders: string[]): void {
      scannedFolders.value = [...folders]
      const folderPrefixes = folders.map((f) => {
        const normalized = f.replace(/[\\/]+$/, '')
        return normalized + (normalized.includes('\\') ? '\\' : '/')
      })
      setTracks(
        tracks.value.filter((t) =>
          folderPrefixes.some(
            (prefix) => t.filePath.startsWith(prefix) || t.filePath === prefix.slice(0, -1)
          )
        )
      )
      rebuildDerivedCollections()
      saveLibrary()
    },
    flushRebuild,
    getRebuildCount: () => rebuildCount,
    getTrackById: (trackId: string) => trackById.get(trackId),
    scheduleSaveLibrary,
    flushSaveLibrary,
    handleLibraryChange
  }
}
