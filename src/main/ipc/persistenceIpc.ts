import { app, type IpcMain } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import {
  DEFAULT_PLAYBACK_BOOKMARKS,
  isPlaybackBookmarksDocument,
  type PlaybackBookmarksDocument
} from '../../shared/playbackBookmarks.ts'
import type { PlaybackSession } from '../core/types'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import {
  PersistentDataRevisionConflictError,
  createPersistentDataRevisionConflictResponse
} from '../../shared/versionedPersistence.ts'
import {
  isLyricsManagementDocument,
  type LyricsManagementDocument
} from '../../shared/lyricsManagement.ts'
import { playbackSessionCueRangesAreValid } from '../../shared/cue.ts'
import {
  isSecureValueEnvelope,
  protectString,
  redactSensitiveText,
  unprotectString
} from '../security/secureStorage.ts'
import { normalizeIpcString, stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import {
  reportPersistentDataFailure,
  reportPersistentDataRecovery
} from './persistenceReporting.ts'

const MAX_PLAYBACK_SESSION_BYTES = 2 * 1024 * 1024
const MAX_PLAYLISTS_BYTES = 20 * 1024 * 1024
const MAX_LYRICS_MANAGEMENT_BYTES = 8 * 1024 * 1024
const MAX_PLAYBACK_BOOKMARKS_BYTES = 4 * 1024 * 1024
const MAX_NCM_COOKIE_BYTES = 16 * 1024
const MAX_NCM_COOKIE_FILE_BYTES = 64 * 1024

export function registerPersistenceIpc(ipcMain: IpcMain): void {
  const userDataPath = app.getPath('userData')
  const NCM_COOKIE_FILE = join(userDataPath, 'ncm-cookie.json')
  const PLAYBACK_SESSION_FILE = join(userDataPath, 'playback-session.json')
  const PLAYLISTS_FILE = join(userDataPath, 'playlists.json')
  const LYRICS_MANAGEMENT_FILE = join(userDataPath, 'lyrics-management.json')
  const PLAYBACK_BOOKMARKS_FILE = join(userDataPath, 'playback-bookmarks.json')

  const playbackSessionStore = new VersionedDataStore<PlaybackSession | null>({
    filePath: PLAYBACK_SESSION_FILE,
    label: 'playback session',
    maxBytes: MAX_PLAYBACK_SESSION_BYTES,
    isData: (value): value is PlaybackSession | null =>
      value === null || isPlaybackSessionFile(value),
    isLegacy: isPlaybackSessionFile,
    onRecovery: (result) =>
      reportPersistentDataRecovery('Playback session', PLAYBACK_SESSION_FILE, result)
  })
  const playlistsStore = new VersionedDataStore<unknown[]>({
    filePath: PLAYLISTS_FILE,
    label: 'playlists',
    maxBytes: MAX_PLAYLISTS_BYTES,
    isData: Array.isArray,
    isLegacy: Array.isArray,
    onRecovery: (result) => reportPersistentDataRecovery('Playlists', PLAYLISTS_FILE, result)
  })
  const lyricsManagementStore = new VersionedDataStore<LyricsManagementDocument>({
    filePath: LYRICS_MANAGEMENT_FILE,
    label: 'lyrics management',
    maxBytes: MAX_LYRICS_MANAGEMENT_BYTES,
    isData: isLyricsManagementDocument,
    isLegacy: isLyricsManagementDocument,
    onRecovery: (result) =>
      reportPersistentDataRecovery('Lyrics management', LYRICS_MANAGEMENT_FILE, result)
  })
  const playbackBookmarksStore = new VersionedDataStore<PlaybackBookmarksDocument>({
    filePath: PLAYBACK_BOOKMARKS_FILE,
    label: 'playback bookmarks',
    maxBytes: MAX_PLAYBACK_BOOKMARKS_BYTES,
    isData: isPlaybackBookmarksDocument,
    isLegacy: isPlaybackBookmarksDocument,
    onRecovery: (result) =>
      reportPersistentDataRecovery('Playback bookmarks', PLAYBACK_BOOKMARKS_FILE, result)
  })

  ipcMain.handle('data:loadLyricsManagement', async (event) => {
    assertTrustedIpcSender(event, 'lyrics management IPC')
    try {
      return await lyricsManagementStore.load()
    } catch (error) {
      reportPersistentDataFailure('Lyrics management', LYRICS_MANAGEMENT_FILE, error)
      return null
    }
  })

  ipcMain.handle(
    'data:saveLyricsManagement',
    async (event, document: LyricsManagementDocument, expectedRevision: number) => {
      assertTrustedIpcSender(event, 'lyrics management IPC')
      stringifyJsonForIpcStorage(document, 'lyrics management', MAX_LYRICS_MANAGEMENT_BYTES)
      if (!isLyricsManagementDocument(document)) {
        throw new Error('Lyrics management has an invalid structure')
      }
      return await saveVersionedData(lyricsManagementStore, document, expectedRevision)
    }
  )

  ipcMain.handle('data:loadPlaybackBookmarks', async (event) => {
    assertTrustedIpcSender(event, 'playback bookmarks IPC')
    try {
      return await playbackBookmarksStore.load()
    } catch (error) {
      reportPersistentDataFailure('Playback bookmarks', PLAYBACK_BOOKMARKS_FILE, error)
      return {
        revision: 0,
        data: DEFAULT_PLAYBACK_BOOKMARKS
      }
    }
  })

  ipcMain.handle(
    'data:savePlaybackBookmarks',
    async (event, document: PlaybackBookmarksDocument, expectedRevision: number) => {
      assertTrustedIpcSender(event, 'playback bookmarks IPC')
      stringifyJsonForIpcStorage(document, 'playback bookmarks', MAX_PLAYBACK_BOOKMARKS_BYTES)
      if (!isPlaybackBookmarksDocument(document)) {
        throw new Error('Playback bookmarks have an invalid structure')
      }
      return await saveVersionedData(playbackBookmarksStore, document, expectedRevision)
    }
  )

  ipcMain.handle(
    'data:savePlaybackSession',
    async (event, session: PlaybackSession, expectedRevision: number) => {
      assertTrustedIpcSender(event, 'data IPC')
      stringifyJsonForIpcStorage(session, 'playback session', MAX_PLAYBACK_SESSION_BYTES)
      if (!isPlaybackSessionFile(session))
        throw new Error('Playback session has an invalid structure')
      return await saveVersionedData(playbackSessionStore, session, expectedRevision)
    }
  )

  ipcMain.handle('data:loadPlaybackSession', async (event) => {
    assertTrustedIpcSender(event, 'data IPC')
    try {
      return await playbackSessionStore.load()
    } catch (error) {
      reportPersistentDataFailure('Playback session', PLAYBACK_SESSION_FILE, error)
      return null
    }
  })

  ipcMain.handle('data:clearPlaybackSession', async (event, expectedRevision: number) => {
    assertTrustedIpcSender(event, 'data IPC')
    return await saveVersionedData(playbackSessionStore, null, expectedRevision)
  })

  ipcMain.handle(
    'data:savePlaylists',
    async (event, playlists: unknown, expectedRevision: number) => {
      assertTrustedIpcSender(event, 'data IPC')
      stringifyJsonForIpcStorage(playlists, 'playlists', MAX_PLAYLISTS_BYTES)
      if (!Array.isArray(playlists)) throw new Error('Playlists have an invalid structure')
      return await saveVersionedData(playlistsStore, playlists, expectedRevision)
    }
  )

  ipcMain.handle('data:loadPlaylists', async (event) => {
    assertTrustedIpcSender(event, 'data IPC')
    try {
      return await playlistsStore.load()
    } catch (error) {
      reportPersistentDataFailure('Playlists', PLAYLISTS_FILE, error)
      return null
    }
  })

  ipcMain.handle('data:saveCookie', async (event, cookie: string) => {
    assertTrustedIpcSender(event, 'data IPC')
    await saveNcmCookie(NCM_COOKIE_FILE, normalizeNcmCookieForSave(cookie))
  })

  ipcMain.handle('data:loadCookie', async (event) => {
    assertTrustedIpcSender(event, 'data IPC')
    return loadNcmCookie(NCM_COOKIE_FILE)
  })
}

async function saveVersionedData<T>(
  store: VersionedDataStore<T>,
  data: T,
  expectedRevision: number
) {
  try {
    return await store.save(data, expectedRevision)
  } catch (error) {
    if (error instanceof PersistentDataRevisionConflictError) {
      return createPersistentDataRevisionConflictResponse(error)
    }
    throw error
  }
}

function isPlaybackSessionFile(value: unknown): value is PlaybackSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const track = record.track
  return (
    record.version === 1 &&
    typeof record.savedAt === 'string' &&
    (record.mode === 'off' || record.mode === 'track' || record.mode === 'trackAndPosition') &&
    !!track &&
    typeof track === 'object' &&
    !Array.isArray(track) &&
    typeof (track as Record<string, unknown>).id === 'string' &&
    typeof record.position === 'number' &&
    Number.isFinite(record.position) &&
    record.position >= 0 &&
    (record.queue === undefined || Array.isArray(record.queue)) &&
    playbackSessionCueRangesAreValid(value)
  )
}

function normalizeNcmCookieForSave(cookie: unknown): string {
  if (cookie == null || cookie === '') return ''
  return normalizeIpcString(cookie, 'NCM cookie', MAX_NCM_COOKIE_BYTES)
}

async function saveNcmCookie(filePath: string, cookie: string): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify(
      {
        cookie: protectString(cookie, ncmCookieScope(filePath))
      },
      null,
      2
    ),
    'utf-8'
  )
}

async function loadNcmCookie(filePath: string): Promise<string> {
  if (!existsSync(filePath)) return ''
  try {
    const fileInfo = statSync(filePath)
    if (!fileInfo.isFile() || fileInfo.size <= 0 || fileInfo.size > MAX_NCM_COOKIE_FILE_BYTES)
      return ''
    const raw = readFileSync(filePath, 'utf-8')
    if (Buffer.byteLength(raw, 'utf-8') > MAX_NCM_COOKIE_FILE_BYTES) return ''
    const parsed = tryParseJsonWithNestingLimit(raw)
    if (
      !parsed.ok ||
      !parsed.value ||
      typeof parsed.value !== 'object' ||
      Array.isArray(parsed.value)
    ) {
      return ''
    }
    const cookie = (parsed.value as Record<string, unknown>).cookie
    if (isSecureValueEnvelope(cookie)) {
      return normalizeLoadedNcmCookie(unprotectString(cookie, ncmCookieScope(filePath)))
    }
    if (typeof cookie === 'string') {
      const normalized = normalizeLoadedNcmCookie(cookie)
      if (!normalized) return ''
      await saveNcmCookie(filePath, normalized)
      return normalized
    }
    return ''
  } catch (error) {
    console.warn(
      '读取网易云 Cookie 失败：',
      redactSensitiveText(error instanceof Error ? error.message : error)
    )
    return ''
  }
}

function normalizeLoadedNcmCookie(cookie: string | null): string {
  if (!cookie) return ''
  try {
    return normalizeNcmCookieForSave(cookie)
  } catch {
    return ''
  }
}

function ncmCookieScope(filePath: string): string {
  return `ncm-cookie:${filePath}`
}
