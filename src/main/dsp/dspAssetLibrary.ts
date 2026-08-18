import { createHash, randomUUID } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'
import type { DspAsset, DspAssetKind } from '../../shared/dspGraph.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { isCanonicalPathInside } from '../security/pathGrants.ts'

const ASSET_INDEX_FILE = 'assets.json'
const MAX_ASSET_BYTES = 512 * 1024 * 1024

type StoredDspAsset = DspAsset & {
  relativePath: string
}

type StoredAssetIndex = {
  version: 1
  assets: StoredDspAsset[]
}

const EXTENSIONS_BY_KIND: Record<DspAssetKind, Set<string>> = {
  impulseResponse: new Set(['.wav', '.flac', '.aiff', '.aif']),
  correctionProfile: new Set(['.txt', '.apo']),
  vst3Preset: new Set(['.vstpreset']),
  vst3State: new Set(['.vststate', '.bin'])
}

const MEDIA_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.txt': 'text/plain',
  '.apo': 'text/plain',
  '.vstpreset': 'application/octet-stream',
  '.vststate': 'application/octet-stream',
  '.bin': 'application/octet-stream'
}

export interface DspAssetImportOptions {
  kind: DspAssetKind
  sourcePath: string
  name?: string
}

export interface DspAssetBufferImportOptions {
  kind: DspAssetKind
  fileName: string
  data: Buffer
  name?: string
}

export type Vst3StateAssetKind = 'vst3Preset' | 'vst3State'

export interface Vst3StateAssetResolution {
  path: string | null
  kind: Vst3StateAssetKind | null
  reason: string
}

export class DspAssetLibrary {
  private readonly root: string
  private readonly assets = new Map<string, StoredDspAsset>()
  private initialized = false
  private serial = Promise.resolve()

  constructor(root: string) {
    this.root = root
  }

  async initialize(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.initialized) return
      await mkdir(this.filesRoot(), { recursive: true })
      try {
        const raw = await readFile(this.indexPath(), 'utf8')
        const parsed = tryParseJsonWithNestingLimit(raw)
        if (parsed.ok && isStoredAssetIndex(parsed.value)) {
          for (const asset of parsed.value.assets) {
            if (!isStoredDspAsset(asset)) continue
            this.assets.set(asset.id, asset)
          }
        }
      } catch {
        // A missing or corrupt index is rebuilt as assets are imported.
      }
      this.initialized = true
    })
  }

  async list(): Promise<DspAsset[]> {
    await this.initialize()
    return [...this.assets.values()]
      .map(toPublicAsset)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async importFile(options: DspAssetImportOptions): Promise<DspAsset> {
    await this.initialize()
    return await this.runExclusive(async () => {
      const sourcePath = resolve(options.sourcePath)
      const extension = normalizeExtension(sourcePath)
      assertSupportedAssetExtension(options.kind, extension)
      const sourceInfo = await stat(sourcePath)
      if (!sourceInfo.isFile()) throw new Error('DSP 资料必须是文件')
      if (sourceInfo.size <= 0 || sourceInfo.size > MAX_ASSET_BYTES) {
        throw new Error('DSP 资料大小不在允许范围内')
      }
      const sha256 = await hashFile(sourcePath)
      return await this.storeFile({
        kind: options.kind,
        sourcePath,
        fileName: basename(sourcePath),
        name: options.name,
        sha256,
        byteSize: sourceInfo.size,
        extension
      })
    })
  }

  async importBuffer(options: DspAssetBufferImportOptions): Promise<DspAsset> {
    await this.initialize()
    return await this.runExclusive(async () => {
      const extension = normalizeExtension(options.fileName)
      assertSupportedAssetExtension(options.kind, extension)
      if (options.data.length <= 0 || options.data.length > MAX_ASSET_BYTES) {
        throw new Error('DSP 资料大小不在允许范围内')
      }
      const sha256 = createHash('sha256').update(options.data).digest('hex')
      const id = assetId(options.kind, sha256)
      const existing = this.assets.get(id)
      if (existing) return toPublicAsset(existing)
      const relativePath = assetRelativePath(options.kind, sha256, extension)
      const destination = join(this.root, relativePath)
      await mkdir(join(destination, '..'), { recursive: true })
      await writeFile(destination, options.data)
      const stored = createStoredAsset({
        id,
        kind: options.kind,
        fileName: sanitizeFileName(options.fileName),
        name: options.name,
        sha256,
        byteSize: options.data.length,
        extension,
        relativePath
      })
      this.assets.set(id, stored)
      await this.writeIndex()
      return toPublicAsset(stored)
    })
  }

  async getPath(id: string): Promise<string> {
    await this.initialize()
    const asset = this.assets.get(id)
    if (!asset) throw new Error('DSP 资料不存在')
    const target = resolve(this.root, asset.relativePath)
    if (!isCanonicalPathInside(this.root, target)) throw new Error('DSP 资料路径无效')
    const info = await stat(target).catch(() => null)
    if (!info?.isFile()) throw new Error('DSP 资料文件缺失')
    return target
  }

  /**
   * Used only by the main-process graph compiler after initialization. The
   * renderer never receives this filesystem path.
   */
  getKnownPath(id: string): string | null {
    const asset = this.assets.get(id)
    if (!asset) return null
    const target = resolve(this.root, asset.relativePath)
    return isCanonicalPathInside(this.root, target) ? target : null
  }

  /**
   * Resolves only state-bearing VST3 assets for the native helper. This keeps
   * renderer graph JSON from passing arbitrary state file paths to a child
   * process that loads third-party code.
   */
  resolveVst3State(id: string): Vst3StateAssetResolution {
    const asset = this.assets.get(id)
    if (!asset)
      return { path: null, kind: null, reason: 'The managed VST3 state asset was not found' }
    if (asset.kind !== 'vst3Preset' && asset.kind !== 'vst3State') {
      return {
        path: null,
        kind: null,
        reason: 'The selected asset is not a VST3 preset or component state'
      }
    }
    const target = resolve(this.root, asset.relativePath)
    if (!isCanonicalPathInside(this.root, target) || !existsSync(target)) {
      return { path: null, kind: null, reason: 'The managed VST3 state file is missing' }
    }
    return { path: target, kind: asset.kind, reason: '' }
  }

  async get(id: string): Promise<DspAsset | null> {
    await this.initialize()
    const asset = this.assets.get(id)
    return asset ? toPublicAsset(asset) : null
  }

  async reconcileReferences(assetIds: Iterable<string>): Promise<void> {
    await this.initialize()
    await this.runExclusive(async () => {
      const referenced = new Set(assetIds)
      let changed = false
      for (const asset of this.assets.values()) {
        const nextCount = referenced.has(asset.id) ? 1 : 0
        if (asset.referenceCount !== nextCount) {
          asset.referenceCount = nextCount
          changed = true
        }
      }
      if (changed) await this.writeIndex()
    })
  }

  async remove(id: string, force = false): Promise<void> {
    await this.initialize()
    await this.runExclusive(async () => {
      const asset = this.assets.get(id)
      if (!asset) return
      if (!force && asset.referenceCount > 0) {
        throw new Error('DSP 资料仍被场景引用，不能删除')
      }
      const target = resolve(this.root, asset.relativePath)
      if (isCanonicalPathInside(this.root, target)) await rm(target, { force: true })
      this.assets.delete(id)
      await this.writeIndex()
    })
  }

  async entries(ids: Iterable<string>): Promise<Array<{ asset: DspAsset; path: string }>> {
    const result: Array<{ asset: DspAsset; path: string }> = []
    for (const id of new Set(ids)) {
      const asset = await this.get(id)
      if (!asset) continue
      result.push({ asset, path: await this.getPath(id) })
    }
    return result
  }

  private async storeFile(input: {
    kind: DspAssetKind
    sourcePath: string
    fileName: string
    name?: string
    sha256: string
    byteSize: number
    extension: string
  }): Promise<DspAsset> {
    const id = assetId(input.kind, input.sha256)
    const existing = this.assets.get(id)
    if (existing) return toPublicAsset(existing)
    const relativePath = assetRelativePath(input.kind, input.sha256, input.extension)
    const destination = join(this.root, relativePath)
    await mkdir(join(destination, '..'), { recursive: true })
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await copyFile(input.sourcePath, temporary)
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    const stored = createStoredAsset({ ...input, id, relativePath })
    this.assets.set(id, stored)
    await this.writeIndex()
    return toPublicAsset(stored)
  }

  private async writeIndex(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const temporary = `${this.indexPath()}.${randomUUID()}.tmp`
    const data: StoredAssetIndex = { version: 1, assets: [...this.assets.values()] }
    await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8')
    await rename(temporary, this.indexPath())
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial
    let release: (() => void) | undefined
    this.serial = new Promise<void>((resolveSerial) => {
      release = resolveSerial
    })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }

  private indexPath(): string {
    return join(this.root, ASSET_INDEX_FILE)
  }

  private filesRoot(): string {
    return join(this.root, 'files')
  }
}

function createStoredAsset(input: {
  id: string
  kind: DspAssetKind
  fileName: string
  name?: string
  sha256: string
  byteSize: number
  extension: string
  relativePath: string
}): StoredDspAsset {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name?.trim() || input.fileName,
    fileName: sanitizeFileName(input.fileName),
    sha256: input.sha256,
    byteSize: input.byteSize,
    mediaType: MEDIA_TYPES[input.extension] ?? 'application/octet-stream',
    createdAt: new Date().toISOString(),
    referenceCount: 0,
    relativePath: input.relativePath
  }
}

function toPublicAsset(asset: StoredDspAsset): DspAsset {
  const { relativePath: _relativePath, ...publicAsset } = asset
  return { ...publicAsset }
}

function assetId(kind: DspAssetKind, sha256: string): string {
  return `${kind}:${sha256}`
}

function assetRelativePath(kind: DspAssetKind, sha256: string, extension: string): string {
  return join('files', kind, `${sha256}${extension}`)
}

function normalizeExtension(filePath: string): string {
  return extname(filePath).toLowerCase()
}

function assertSupportedAssetExtension(kind: DspAssetKind, extension: string): void {
  if (!EXTENSIONS_BY_KIND[kind].has(extension)) {
    throw new Error('DSP 资料类型不受支持')
  }
}

function sanitizeFileName(fileName: string): string {
  const name = Array.from(basename(fileName), (character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character
  })
    .join('')
    .trim()
  return name.slice(0, 160) || 'asset.bin'
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', rejectHash)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function isStoredAssetIndex(value: unknown): value is StoredAssetIndex {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { assets?: unknown }).assets)
  )
}

function isStoredDspAsset(value: unknown): value is StoredDspAsset {
  if (!value || typeof value !== 'object') return false
  const asset = value as Partial<StoredDspAsset>
  return (
    typeof asset.id === 'string' &&
    typeof asset.kind === 'string' &&
    typeof asset.name === 'string' &&
    typeof asset.fileName === 'string' &&
    typeof asset.sha256 === 'string' &&
    typeof asset.byteSize === 'number' &&
    typeof asset.mediaType === 'string' &&
    typeof asset.createdAt === 'string' &&
    typeof asset.referenceCount === 'number' &&
    typeof asset.relativePath === 'string'
  )
}
