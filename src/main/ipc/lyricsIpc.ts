import { dialog, BrowserWindow, type IpcMain } from 'electron'
import { basename, dirname, extname, join } from 'path'
import { readFile, stat } from 'fs/promises'
import { parseFile } from 'music-metadata'
import { importLyricsFromDialog } from '../lyrics/importLyrics.ts'
import { saveLyricsFromDialog } from '../lyrics/saveLyrics.ts'
import {
  assertOnlineLyricsRateLimit,
  searchOnlineLyrics,
  type OnlineLyricsSearchResult
} from '../lyrics/onlineLyricsSearch.ts'
import { decodeLyrics } from '../../shared/lyricsEncoding.ts'
import { runtime } from '../core/runtime'
import {
  resolveAuthorizedAudioFile,
  resolveAuthorizedLibraryDirectory
} from '../security/localPaths'
import { normalizeIpcString, normalizeLocalPath } from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'

const MAX_LYRICS_FILE_NAME_LENGTH = 512

export function registerLyricsIpc(ipcMain: IpcMain): void {
  // Lyrics lazy loader — reads .lrc file on demand, falls back to embedded lyrics
  ipcMain.handle(
    'lyrics:get',
    async (event, dir: string, fileName: string, filePath?: string): Promise<string | null> => {
      assertTrustedIpcSender(event, 'lyrics IPC')
      const safeFileName = basename(
        normalizeIpcString(fileName, 'lyrics file name', MAX_LYRICS_FILE_NAME_LENGTH)
      )
      if (!safeFileName) return null
      let resolvedFilePath: string | null = null
      try {
        resolvedFilePath = filePath
          ? await resolveAuthorizedAudioFile(normalizeLocalPath(filePath, 'lyrics audio file path'))
          : null
      } catch {
        return null
      }
      let resolvedDir = resolvedFilePath ? dirname(resolvedFilePath) : null
      if (!resolvedDir) {
        try {
          resolvedDir = await resolveAuthorizedLibraryDirectory(
            normalizeLocalPath(dir, 'lyrics directory')
          )
        } catch {
          return null
        }
      }
      try {
        const lrcPath = join(resolvedDir, `${basename(safeFileName, extname(safeFileName))}.lrc`)
        const lrc = decodeLyrics(await readFile(lrcPath)).text
        if (lrc) return lrc
      } catch {
        // no external .lrc next to the audio file — fall through to embedded lyrics
      }

      // 2. Try embedded lyrics from audio file metadata
      if (resolvedFilePath) {
        try {
          const meta = await parseFile(resolvedFilePath, { skipCovers: true })
          const common = meta.common
          if (common.lyrics && common.lyrics.length > 0) {
            // music-metadata returns lyrics as { language, text } objects or strings
            const first = common.lyrics[0]
            const text = typeof first === 'string' ? first : first?.text
            if (text) return text
          }
        } catch {
          // ignore parse errors
        }
      }
      return null
    }
  )

  ipcMain.handle('lyrics:import', async (event): Promise<string | null> => {
    assertTrustedIpcSender(event, 'lyrics import IPC')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.OpenDialogOptions = {
      title: 'Import LRC lyrics',
      properties: ['openFile'],
      filters: [{ name: 'Lyrics', extensions: ['lrc', 'txt'] }]
    }
    const result =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
    return await importLyricsFromDialog(
      result,
      async (filePath) => decodeLyrics(await readFile(filePath)).text,
      async (filePath) => (await stat(filePath)).size
    )
  })

  ipcMain.handle('lyrics:save', async (event, contents: string): Promise<string | null> => {
    assertTrustedIpcSender(event, 'lyrics save IPC')
    if (typeof contents !== 'string') throw new Error('Lyrics content must be text')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.SaveDialogOptions = {
      title: 'Save LRC lyrics',
      defaultPath: 'lyrics.lrc',
      filters: [{ name: 'LRC lyrics', extensions: ['lrc'] }]
    }
    const result =
      win && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
    const saved = await saveLyricsFromDialog(result, contents)
    return saved?.filePath ?? null
  })

  ipcMain.handle(
    'lyrics:searchOnline',
    async (event, query: unknown): Promise<OnlineLyricsSearchResult> => {
      assertTrustedIpcSender(event, 'lyrics search IPC')
      assertOnlineLyricsRateLimit()
      return await searchOnlineLyrics(query)
    }
  )
}
