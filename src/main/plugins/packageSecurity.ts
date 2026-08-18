import extract from 'extract-zip'
import { createRequire } from 'module'
import { existsSync, realpathSync } from 'fs'
import { lstat, readdir, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl') as {
  open: (
    path: string,
    options: { lazyEntries: true; validateEntrySizes: false },
    callback: (error: Error | null, zipFile?: ZipFile) => void
  ) => void
}

interface ZipFile {
  readEntry: () => void
  close: () => void
  on: (event: 'entry', handler: (entry: ZipEntry) => void) => void
  once(event: 'end', handler: () => void): void
  once(event: 'error', handler: (error: Error) => void): void
}

interface ZipEntry {
  fileName: string
  uncompressedSize: number
  externalFileAttributes: number
}

export const MAX_PLUGIN_PACKAGE_BYTES = 50 * 1024 * 1024
export const MAX_PLUGIN_EXTRACTED_BYTES = 100 * 1024 * 1024
export const MAX_PLUGIN_PACKAGE_FILES = 2000
export const MAX_PLUGIN_ENTRY_BYTES = 50 * 1024 * 1024
export const MAX_PLUGIN_ENTRY_PATH_LENGTH = 4096

export async function assertPluginPackageFileSize(source: string): Promise<void> {
  const info = await stat(source)
  if (!info.isFile()) throw new Error('插件包必须是文件')
  if (info.size > MAX_PLUGIN_PACKAGE_BYTES) throw new Error('插件包文件过大')
}

export async function extractPluginPackage(source: string, targetDir: string): Promise<void> {
  await assertPluginPackageFileSize(source)
  await inspectZipPackage(source)
  await extract(source, { dir: targetDir })
  await assertPluginTreeSafe(targetDir)
}

export async function assertPluginTreeSafe(root: string): Promise<void> {
  const realRoot = realpathSync(root)
  const totals = { files: 0, bytes: 0 }
  await scanPluginTree(realRoot, realRoot, totals)
}

async function inspectZipPackage(source: string): Promise<void> {
  await new Promise<void>((resolveInspect, rejectInspect) => {
    yauzl.open(source, { lazyEntries: true, validateEntrySizes: false }, (openError, zipFile) => {
      if (openError) {
        rejectInspect(openError)
        return
      }
      if (!zipFile) {
        rejectInspect(new Error('无法读取插件包'))
        return
      }

      let files = 0
      let bytes = 0
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        zipFile.close()
        rejectInspect(error)
      }

      zipFile.on('entry', (entry) => {
        try {
          validateZipEntry(entry)
          if (!entry.fileName.endsWith('/')) {
            files += 1
            bytes += entry.uncompressedSize
            if (files > MAX_PLUGIN_PACKAGE_FILES) throw new Error('插件包文件数量过多')
            if (entry.uncompressedSize > MAX_PLUGIN_ENTRY_BYTES) {
              throw new Error('插件包单文件解压后过大')
            }
            if (bytes > MAX_PLUGIN_EXTRACTED_BYTES) throw new Error('插件包解压后过大')
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
          return
        }
        zipFile.readEntry()
      })
      zipFile.once('end', () => {
        if (settled) return
        settled = true
        resolveInspect()
      })
      zipFile.once('error', fail)
      zipFile.readEntry()
    })
  })
}

function validateZipEntry(entry: ZipEntry): void {
  const name = entry.fileName
  if (!name || name.length > MAX_PLUGIN_ENTRY_PATH_LENGTH) throw new Error('插件包含有非法路径')
  if (name.includes('\\') || name.startsWith('/') || name.startsWith('~')) {
    throw new Error('插件包含有非法路径')
  }
  if (isAbsolute(name) || /^[a-zA-Z]:/.test(name)) throw new Error('插件包含有绝对路径')
  if (name.split('/').some((part) => part === '..')) throw new Error('插件包不能包含越界路径')
  if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw new Error('插件包文件大小非法')
  }
  if (isZipSymlink(entry)) throw new Error('插件包不能包含符号链接')
}

function isZipSymlink(entry: ZipEntry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
  return unixMode === 0o120000
}

async function scanPluginTree(
  current: string,
  root: string,
  totals: { files: number; bytes: number }
): Promise<void> {
  if (!isInsidePath(current, root) || !existsSync(current)) {
    throw new Error('插件包含有越界路径')
  }
  const info = await lstat(current)
  if (info.isSymbolicLink()) throw new Error('插件包不能包含符号链接')
  if (info.isFile()) {
    totals.files += 1
    totals.bytes += info.size
    if (totals.files > MAX_PLUGIN_PACKAGE_FILES) throw new Error('插件包文件数量过多')
    if (info.size > MAX_PLUGIN_ENTRY_BYTES) throw new Error('插件包单文件过大')
    if (totals.bytes > MAX_PLUGIN_EXTRACTED_BYTES) throw new Error('插件包解压后过大')
    return
  }
  if (!info.isDirectory()) return
  const entries = await readdir(current)
  await Promise.all(entries.map((entry) => scanPluginTree(join(current, entry), root, totals)))
}

export function isInsidePath(child: string, parent: string): boolean {
  const resolvedChild = resolve(child)
  const resolvedParent = resolve(parent)
  const pathBetween = relative(resolvedParent, resolvedChild)
  return (
    pathBetween === '' ||
    (pathBetween !== '..' && !pathBetween.startsWith(`..${sep}`) && !isAbsolute(pathBetween))
  )
}

export function resolvePluginFile(filePath: string, root: string): string | null {
  if (!isInsidePath(filePath, root) || !existsSync(filePath)) return null
  try {
    const realRoot = realpathSync(root)
    const realFile = realpathSync(filePath)
    return isInsidePath(realFile, realRoot) ? realFile : null
  } catch {
    return null
  }
}
