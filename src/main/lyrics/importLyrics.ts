import { extname } from 'node:path'
import { MAX_LYRICS_BYTES } from '../../shared/lyricsEncoding.ts'

export const MAX_IMPORTED_LYRICS_BYTES = MAX_LYRICS_BYTES

export interface LyricsImportDialogResult {
  canceled: boolean
  filePaths: string[]
}

export function validateImportedLyricsPath(filePath: string): void {
  const extension = extname(filePath).toLowerCase()
  if (extension !== '.lrc' && extension !== '.txt') {
    throw new Error('Imported lyrics must be an .lrc or .txt file')
  }
}

export function validateImportedLyrics(filePath: string, contents: string): string {
  validateImportedLyricsPath(filePath)
  const extension = extname(filePath).toLowerCase()
  if (Buffer.byteLength(contents, 'utf-8') > MAX_IMPORTED_LYRICS_BYTES) {
    throw new Error('Imported lyrics exceed the 1 MiB limit')
  }

  const normalized = contents.replace(/^\uFEFF/, '')
  if (!normalized.trim() || /\0/.test(normalized) || normalized.includes('\uFFFD')) {
    throw new Error('Imported lyrics must be valid non-empty text (UTF-8, GBK, or GB18030)')
  }
  if (
    extension === '.lrc' &&
    !/(?:\[\d{1,3}:\d{2}(?:[.:]\d{2,3})?\]|\[[a-z]+:)/i.test(normalized)
  ) {
    throw new Error('An .lrc import must contain an LRC timestamp or metadata tag')
  }
  return normalized
}

export async function importLyricsFromDialog(
  result: LyricsImportDialogResult,
  readText: (filePath: string) => Promise<string>,
  readByteSize?: (filePath: string) => Promise<number>
): Promise<string | null> {
  if (result.canceled || result.filePaths.length === 0) return null
  if (result.filePaths.length !== 1) throw new Error('Select exactly one lyrics file')
  const filePath = result.filePaths[0]
  validateImportedLyricsPath(filePath)
  if (readByteSize && (await readByteSize(filePath)) > MAX_IMPORTED_LYRICS_BYTES) {
    throw new Error('Imported lyrics exceed the 1 MiB limit')
  }
  return validateImportedLyrics(filePath, await readText(filePath))
}
