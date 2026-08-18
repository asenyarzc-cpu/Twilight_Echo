import { app, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, extname, dirname, resolve } from 'path'
import { createHash } from 'crypto'
import { parseFile } from 'music-metadata'
import { getMusicCacheRoot } from '../cache/ncmCache'
import { readCachedProtocolFile, type ProtocolAssetBytes } from '../cache/protocolAssetCache'

export const COVER_NAMES = [
  'cover.jpg',
  'cover.png',
  'cover.webp',
  'folder.jpg',
  'folder.png',
  'album.jpg',
  'album.png',
  'front.jpg',
  'front.png',
  'artwork.jpg',
  'artwork.png'
]

// ─── Cover thumbnail disk cache ─────────────────────────────────────
// Covers are resized to 500px JPEG (~30-80KB each) and stored on disk.
// Track.cover stores "cover://<hash>.jpg" instead of multi-MB base64 strings.
// A pre-blurred 32px version ("cover://<hash>_blur.jpg") is also generated
// for background use, eliminating expensive CSS filter: blur() at runtime.
export const COVER_THUMBNAIL_WIDTH = 500
export const COVER_JPEG_QUALITY = 85
export const COVER_BLUR_WIDTH = 32
export const COVER_CACHE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

export function getCoverCacheDir(): string {
  return join(getMusicCacheRoot(), 'cover-cache')
}

export function getLegacyCoverCacheDir(): string {
  return join(app.getPath('userData'), 'cover-cache')
}

export function ensureCoverCacheDir(): string {
  const dir = getCoverCacheDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export const BACKGROUND_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
export const MAX_BACKGROUND_IMAGE_BYTES = 20 * 1024 * 1024

export function getBackgroundImageDir(): string {
  return join(app.getPath('userData'), 'backgrounds')
}

export function ensureBackgroundImageDir(): string {
  const dir = getBackgroundImageDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveBackgroundImageFile(fileName: string): string | null {
  const normalizedName = fileName.replace(/^\/+|\/+$/g, '')
  const safeName = normalizedName.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safeName || safeName !== normalizedName) return null
  const filePath = join(getBackgroundImageDir(), safeName)
  return existsSync(filePath) ? filePath : null
}

export function importBackgroundImageBuffer(fileName: string, data: Buffer): string {
  const ext = extname(fileName).toLowerCase()
  if (!BACKGROUND_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('不支持的背景图片格式')
  }
  if (data.byteLength > MAX_BACKGROUND_IMAGE_BYTES) {
    throw new Error('背景图片过大')
  }
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 24)
  const targetName = `${hash}${ext === '.jpeg' ? '.jpg' : ext}`
  const targetPath = join(ensureBackgroundImageDir(), targetName)
  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, data)
  }
  return `background://${targetName}`
}

export function importBackgroundImage(sourcePath: string): string {
  const resolvedPath = resolve(sourcePath)
  const fileStat = statSync(resolvedPath)
  if (!fileStat.isFile() || fileStat.size > MAX_BACKGROUND_IMAGE_BYTES) {
    throw new Error('背景图片无效或过大')
  }
  const data = readFileSync(resolvedPath)
  return importBackgroundImageBuffer(resolvedPath, data)
}

export function normalizeBackgroundImageImportData(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}

export function resolveCoverCacheFile(fileName: string): string | null {
  const currentPath = join(getCoverCacheDir(), fileName)
  if (existsSync(currentPath)) return currentPath
  const legacyPath = join(getLegacyCoverCacheDir(), fileName)
  return existsSync(legacyPath) ? legacyPath : null
}

/**
 * Async cover read for the cover:// protocol handler: current cache dir first,
 * then legacy dir, served from the main-process LRU once read.
 */
export async function readCoverCacheFileBytes(
  fileName: string
): Promise<ProtocolAssetBytes | null> {
  return readCachedProtocolFile(
    join(getCoverCacheDir(), fileName),
    join(getLegacyCoverCacheDir(), fileName)
  )
}

export function isCoverCacheFileName(fileName: string): boolean {
  return COVER_CACHE_EXTENSIONS.has(extname(fileName).toLowerCase())
}

export function getCoverCacheContentType(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    default:
      return 'image/jpeg'
  }
}

/** Extract cover from image buffer, resize, save to disk cache. Returns cover:// handle.
 *  Also generates a tiny pre-blurred version for background use. */
export function cacheCoverFromBuffer(data: Buffer): string | null {
  try {
    const img = nativeImage.createFromBuffer(data)
    if (img.isEmpty()) return null
    const originalSize = img.getSize()
    let resized = img
    if (originalSize.width > COVER_THUMBNAIL_WIDTH) {
      resized = img.resize({ width: COVER_THUMBNAIL_WIDTH, quality: 'good' })
    }
    const jpegBuf = resized.toJPEG(COVER_JPEG_QUALITY)
    const hash = createHash('md5').update(jpegBuf).digest('hex').slice(0, 16)
    const fileName = `${hash}.jpg`
    const cacheDir = ensureCoverCacheDir()
    const fullPath = join(cacheDir, fileName)
    if (!existsSync(fullPath)) {
      writeFileSync(fullPath, jpegBuf)
    }
    // Generate pre-blurred tiny version for background (eliminates CSS blur at runtime)
    const blurFileName = `${hash}_blur.jpg`
    const blurPath = join(cacheDir, blurFileName)
    if (!existsSync(blurPath)) {
      const blurred = resized.resize({ width: COVER_BLUR_WIDTH, quality: 'good' })
      writeFileSync(blurPath, blurred.toJPEG(60))
    }
    return `cover://${fileName}`
  } catch {
    return null
  }
}

/** Extract cover from an image file on disk, resize, save to cache. Returns cover:// handle. */
export function cacheCoverFromFile(filePath: string): string | null {
  try {
    const data = readFileSync(filePath)
    return cacheCoverFromBuffer(data)
  } catch {
    return null
  }
}

/** Read a cached cover file and return as base64 data URL. */
export function readCachedCover(handle: string): string | null {
  if (!handle.startsWith('cover://')) return null
  const fileName = handle.slice('cover://'.length)
  const fullPath = resolveCoverCacheFile(fileName)
  if (!fullPath) return null
  try {
    const data = readFileSync(fullPath)
    return `data:${getCoverCacheContentType(fileName)};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

export function coverHandleExists(handle: unknown): boolean {
  if (typeof handle !== 'string' || !handle.startsWith('cover://')) return false
  const fileName = handle.slice('cover://'.length)
  return resolveCoverCacheFile(fileName) !== null
}

/** Migrate a base64 data: URL cover to disk cache. Returns cover:// handle. */
export function migrateBase64Cover(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  try {
    const buf = Buffer.from(match[2], 'base64')
    return cacheCoverFromBuffer(buf)
  } catch {
    return null
  }
}

export const coverCache = new Map<string, string | null>()

export function findCoverInDir(dir: string): string | null {
  if (coverCache.has(dir)) return coverCache.get(dir) ?? null
  for (const name of COVER_NAMES) {
    const fullPath = join(dir, name)
    if (existsSync(fullPath)) {
      const handle = cacheCoverFromFile(fullPath)
      if (handle) {
        coverCache.set(dir, handle)
        return handle
      }
    }
  }
  coverCache.set(dir, null)
  return null
}

export async function rebuildMissingTrackCover(track: Record<string, unknown>): Promise<boolean> {
  const cover = track.cover
  if (typeof cover !== 'string' || !cover.startsWith('cover://') || coverHandleExists(cover)) {
    return false
  }

  const filePath = typeof track.filePath === 'string' ? track.filePath : ''
  const dir =
    typeof track.dir === 'string' && track.dir ? track.dir : filePath ? dirname(filePath) : ''
  let repairedCover: string | null = null

  if (filePath && existsSync(filePath) && !filePath.toLowerCase().endsWith('.iso')) {
    try {
      const meta = await parseFile(filePath, { skipCovers: false })
      const pic = meta.common.picture?.[0]
      if (pic) {
        repairedCover = cacheCoverFromBuffer(Buffer.from(pic.data))
      }
    } catch {
      /* keep folder-art fallback */
    }
  }

  if (!repairedCover && dir) {
    repairedCover = findCoverInDir(dir)
  }

  if (!repairedCover) return false
  track.cover = repairedCover
  return repairedCover !== cover
}

export async function repairMissingLibraryCovers(tracks: unknown[]): Promise<boolean> {
  const candidates = tracks.filter(
    (track): track is Record<string, unknown> =>
      !!track &&
      typeof track === 'object' &&
      !Array.isArray(track) &&
      typeof (track as Record<string, unknown>).cover === 'string' &&
      ((track as Record<string, unknown>).cover as string).startsWith('cover://') &&
      !coverHandleExists((track as Record<string, unknown>).cover)
  )
  if (candidates.length === 0) return false

  let changed = false
  const batchSize = 4
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const repaired = await Promise.all(batch.map(rebuildMissingTrackCover))
    changed = repaired.some(Boolean) || changed
    await new Promise((resolve) => setImmediate(resolve))
  }
  return changed
}
