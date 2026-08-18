import { readdirSync, statSync } from 'fs'
import { dirname, extname, join } from 'path'

export { SUPPORTED_EXTENSIONS } from '../../shared/audioFormats.ts'
import { SUPPORTED_EXTENSIONS } from '../../shared/audioFormats.ts'

export interface FileEntry {
  fullPath: string
  fileName: string
  dir: string
  size: number
  mtimeMs: number
}

export async function collectFilesAsync(
  dirPath: string,
  isExcluded: (filePath: string) => boolean = () => false
): Promise<FileEntry[]> {
  const results: FileEntry[] = []
  const queue: string[] = [dirPath]

  while (queue.length > 0) {
    const currentDir = queue.shift()!
    try {
      const entries = readdirSync(currentDir)
      for (const entry of entries) {
        const fullPath = join(currentDir, entry)
        try {
          const fileStat = statSync(fullPath)
          if (fileStat.isDirectory()) {
            queue.push(fullPath)
          } else if (fileStat.isFile()) {
            const extension = extname(entry).toLowerCase()
            if (SUPPORTED_EXTENSIONS.includes(extension) && !isExcluded(fullPath)) {
              results.push({
                fullPath,
                fileName: entry,
                dir: dirname(fullPath),
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs
              })
            }
          }
        } catch {
          // Files can disappear while a recursive scan is in progress.
        }
        if (results.length % 100 === 0) {
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
    } catch {
      // Missing or inaccessible directories are skipped like individual files.
    }
  }
  return results
}

export function filterParsedTracksAgainstExclusions(
  tracks: unknown[],
  isExcluded: (filePath: string) => boolean
): unknown[] {
  return tracks.filter((track) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) return true
    const filePath = (track as Record<string, unknown>).filePath
    return typeof filePath !== 'string' || !filePath || !isExcluded(filePath)
  })
}
