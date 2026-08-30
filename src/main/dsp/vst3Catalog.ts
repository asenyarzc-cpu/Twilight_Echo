import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { lstat, mkdir, readFile, rename, readdir, stat, writeFile } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'
import type {
  DspChannelLayout,
  Vst3CatalogEntry,
  Vst3CatalogState,
  Vst3HelpersAvailability,
  Vst3ParameterDescriptor,
  Vst3ScanDescriptor
} from '../../shared/dspGraph.ts'
import { getNativeAddonCandidates } from '../audio/nativeBinding.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'

const CATALOG_FILE = 'vst3-catalog.json'
const MAX_SCAN_MODULES = 1024
const MAX_SCAN_DEPTH = 16

export interface Vst3ModuleScanner {
  scan(modulePath: string): Promise<Vst3ScanDescriptor>
}

export interface Vst3ModuleResolution {
  modulePath: string | null
  classId: string
  reason: string
}

export class Vst3CatalogService {
  private readonly root: string
  private readonly scanner: Vst3ModuleScanner
  private state: Vst3CatalogState
  private initialized = false
  private serial = Promise.resolve()

  constructor(
    root: string,
    scanner: Vst3ModuleScanner,
    standardSearchPaths: string[] = defaultVst3SearchPaths()
  ) {
    this.root = root
    this.scanner = scanner
    this.state = {
      enabled: process.platform === 'win32',
      searchPaths: uniquePaths(standardSearchPaths),
      entries: []
    }
  }

  async initialize(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.initialized) return
      await mkdir(this.root, { recursive: true })
      try {
        const parsed = tryParseJsonWithNestingLimit(await readFile(this.catalogPath(), 'utf8'))
        if (parsed.ok && isCatalogState(parsed.value)) {
          this.state = {
            enabled: parsed.value.enabled === true && process.platform === 'win32',
            searchPaths: uniquePaths(parsed.value.searchPaths),
            entries: parsed.value.entries.filter(isCatalogEntry)
          }
        }
      } catch {
        // A missing catalog is created once a scan or preference update occurs.
      }
      this.initialized = true
    })
  }

  async getState(): Promise<Vst3CatalogState> {
    await this.initialize()
    return cloneState(this.state)
  }

  getHelpersAvailability(): Vst3HelpersAvailability {
    return resolveVst3HelpersAvailability()
  }

  async setEnabled(enabled: boolean): Promise<Vst3CatalogState> {
    await this.initialize()
    return await this.runExclusive(async () => {
      this.state.enabled = enabled === true && process.platform === 'win32'
      await this.writeState()
      return cloneState(this.state)
    })
  }

  async setSearchPaths(paths: string[]): Promise<Vst3CatalogState> {
    await this.initialize()
    return await this.runExclusive(async () => {
      this.state.searchPaths = uniquePaths(paths)
      await this.writeState()
      return cloneState(this.state)
    })
  }

  async scan(): Promise<Vst3CatalogState> {
    await this.initialize()
    return await this.runExclusive(async () => {
      if (process.platform !== 'win32' || !this.state.enabled) return cloneState(this.state)
      const modules = await discoverVst3Modules(this.state.searchPaths)
      const previous = new Map(this.state.entries.map((entry) => [entry.modulePath, entry]))
      const next: Vst3CatalogEntry[] = []
      for (const modulePath of modules) {
        const moduleFingerprint = await fingerprintModule(modulePath)
        const old = previous.get(modulePath)
        if (old?.moduleFingerprint === moduleFingerprint && old.status !== 'failed') {
          next.push(old)
          continue
        }
        next.push(await this.scanModule(modulePath, moduleFingerprint))
      }
      this.state.entries = next.sort((left, right) => left.name.localeCompare(right.name))
      await this.writeState()
      return cloneState(this.state)
    })
  }

  async clearQuarantine(id: string): Promise<Vst3CatalogState> {
    await this.initialize()
    return await this.runExclusive(async () => {
      const entry = this.state.entries.find((candidate) => candidate.id === id)
      if (!entry) throw new Error('VST3 模块不存在')
      if (entry.status === 'quarantined') {
        entry.status = 'failed'
        entry.error = null
        delete entry.quarantinedAt
        await this.writeState()
      }
      return cloneState(this.state)
    })
  }

  async quarantine(id: string, reason: string): Promise<void> {
    await this.initialize()
    await this.runExclusive(async () => {
      const entry = this.state.entries.find((candidate) => candidate.id === id)
      if (!entry) return
      entry.status = 'quarantined'
      entry.error = reason.slice(0, 1000)
      entry.quarantinedAt = new Date().toISOString()
      await this.writeState()
    })
  }

  async find(id: string): Promise<Vst3CatalogEntry | null> {
    await this.initialize()
    const entry = this.state.entries.find((candidate) => candidate.id === id)
    return entry
      ? {
          ...entry,
          parameters: [...entry.parameters],
          supportedLayouts: [...entry.supportedLayouts]
        }
      : null
  }

  /**
   * Resolves only catalog-owned modules for the audio engine. Renderer graph
   * JSON is never allowed to nominate an arbitrary executable bundle path.
   */
  resolveAvailableModule(catalogId: string, classId: string): Vst3ModuleResolution {
    const normalizedId = typeof catalogId === 'string' ? catalogId.trim() : ''
    const normalizedClassId = typeof classId === 'string' ? classId.trim() : ''
    if (!this.initialized) {
      return {
        modulePath: null,
        classId: normalizedClassId,
        reason: 'VST3 catalog is not initialized'
      }
    }
    if (process.platform !== 'win32') {
      return {
        modulePath: null,
        classId: normalizedClassId,
        reason: 'VST3 hosting is available only on Windows x64'
      }
    }
    if (!this.state.enabled) {
      return { modulePath: null, classId: normalizedClassId, reason: 'VST3 hosting is disabled' }
    }
    const entry = this.state.entries.find((candidate) => candidate.id === normalizedId)
    if (!entry) {
      return {
        modulePath: null,
        classId: normalizedClassId,
        reason: 'The selected VST3 module is not in the managed catalog'
      }
    }
    if (entry.status !== 'available') {
      return {
        modulePath: null,
        classId: normalizedClassId,
        reason: entry.error || `The selected VST3 module is ${entry.status}`
      }
    }
    if (!normalizedClassId || entry.classId.toUpperCase() !== normalizedClassId.toUpperCase()) {
      return {
        modulePath: null,
        classId: normalizedClassId,
        reason: 'The VST3 class ID no longer matches its catalog entry'
      }
    }
    if (!existsSync(entry.modulePath)) {
      return {
        modulePath: null,
        classId: normalizedClassId,
        reason: 'The managed VST3 module is no longer on disk'
      }
    }
    return { modulePath: entry.modulePath, classId: entry.classId, reason: '' }
  }

  private async scanModule(
    modulePath: string,
    moduleFingerprint: string
  ): Promise<Vst3CatalogEntry> {
    const scannedAt = new Date().toISOString()
    try {
      const descriptor = await this.scanner.scan(modulePath)
      const classId = descriptor.classId.trim()
      if (!classId) throw new Error('VST3 未返回 class ID')
      return {
        id: `vst3:${createHash('sha256').update(`${modulePath}\u0000${classId}`).digest('hex')}`,
        modulePath,
        moduleFingerprint,
        classId,
        name: descriptor.name.trim() || basename(modulePath),
        vendor: descriptor.vendor.trim(),
        version: descriptor.version.trim(),
        category: descriptor.category?.trim() || 'Audio Effect',
        supportedLayouts: normalizeLayouts(descriptor.supportedLayouts),
        parameters: normalizeParameters(descriptor.parameters),
        status: 'available',
        error: null,
        scannedAt
      }
    } catch (error) {
      return {
        id: `vst3:${moduleFingerprint}`,
        modulePath,
        moduleFingerprint,
        classId: '',
        name: basename(modulePath),
        vendor: '',
        version: '',
        category: 'Audio Effect',
        supportedLayouts: [],
        parameters: [],
        status: 'failed',
        error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        scannedAt
      }
    }
  }

  private async writeState(): Promise<void> {
    const temporary = `${this.catalogPath()}.tmp`
    await writeFile(temporary, JSON.stringify(this.state, null, 2), 'utf8')
    await rename(temporary, this.catalogPath())
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

  private catalogPath(): string {
    return join(this.root, CATALOG_FILE)
  }
}

export function defaultVst3SearchPaths(): string[] {
  if (process.platform !== 'win32') return []
  const commonProgramFiles = process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files'
  return [join(commonProgramFiles, 'VST3')]
}

async function discoverVst3Modules(paths: string[]): Promise<string[]> {
  const modules: string[] = []
  const seen = new Set<string>()
  for (const root of paths) {
    await scanDirectory(resolve(root), 0, modules, seen)
    if (modules.length >= MAX_SCAN_MODULES) break
  }
  return modules
}

async function scanDirectory(
  directory: string,
  depth: number,
  modules: string[],
  seen: Set<string>
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || modules.length >= MAX_SCAN_MODULES) return
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (modules.length >= MAX_SCAN_MODULES) return
    const candidate = join(directory, entry)
    let info
    try {
      info = await lstat(candidate)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    const isModule = extname(entry).toLowerCase() === '.vst3'
    if (isModule && (info.isDirectory() || info.isFile())) {
      const normalized = resolve(candidate)
      if (!seen.has(normalized)) {
        seen.add(normalized)
        modules.push(normalized)
      }
      continue
    }
    if (info.isDirectory()) await scanDirectory(candidate, depth + 1, modules, seen)
  }
}

async function fingerprintModule(modulePath: string): Promise<string> {
  const info = await stat(modulePath)
  if (info.isFile()) return await hashFile(modulePath)
  const hash = createHash('sha256')
  await hashDirectory(modulePath, modulePath, hash, 0)
  return hash.digest('hex')
}

async function hashDirectory(
  root: string,
  directory: string,
  hash: ReturnType<typeof createHash>,
  depth: number
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return
  const entries = await readdir(directory)
  for (const entry of entries.sort()) {
    const path = join(directory, entry)
    const info = await lstat(path)
    if (info.isSymbolicLink()) continue
    hash.update(path.slice(root.length))
    hash.update(`${info.size}:${info.mtimeMs}:${info.isDirectory() ? 'd' : 'f'}`)
    if (info.isDirectory()) await hashDirectory(root, path, hash, depth + 1)
  }
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

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of paths) {
    if (typeof value !== 'string' || !value.trim()) continue
    const normalized = resolve(value.trim())
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result.slice(0, 32)
}

function normalizeLayouts(layouts: DspChannelLayout[] | undefined): DspChannelLayout[] {
  const supported = new Set<DspChannelLayout>()
  for (const layout of layouts ?? []) {
    if (layout === 'mono' || layout === 'stereo' || layout === '5.1' || layout === '7.1')
      supported.add(layout)
  }
  return [...supported]
}

function normalizeParameters(
  parameters: Vst3ParameterDescriptor[] | undefined
): Vst3ParameterDescriptor[] {
  return (parameters ?? [])
    .filter((parameter) => Number.isInteger(parameter.id) && typeof parameter.title === 'string')
    .slice(0, 2048)
    .map((parameter) => ({
      id: parameter.id,
      title: parameter.title.slice(0, 256),
      unit: typeof parameter.unit === 'string' ? parameter.unit.slice(0, 64) : '',
      defaultNormalizedValue: Math.max(
        0,
        Math.min(1, Number(parameter.defaultNormalizedValue) || 0)
      ),
      stepCount: Math.max(0, Math.min(1_000_000, Math.trunc(Number(parameter.stepCount) || 0))),
      flags: Math.max(0, Math.trunc(Number(parameter.flags) || 0))
    }))
}

function resolveVst3HelpersAvailability(): Vst3HelpersAvailability {
  const platformSupported = process.platform === 'win32'
  if (!platformSupported) {
    return { platformSupported: false, scannerPresent: false, hostPresent: false }
  }
  const roots = new Set<string>()
  for (const candidate of getNativeAddonCandidates()) {
    const root = candidate.replace(/[\\/][^\\/]+$/, '')
    if (root) roots.add(root)
  }
  let scannerPresent = false
  let hostPresent = false
  for (const root of roots) {
    if (existsSync(join(root, 'twilight-vst3-scanner.exe'))) scannerPresent = true
    if (existsSync(join(root, 'twilight-vst3-host.exe'))) hostPresent = true
    if (scannerPresent && hostPresent) break
  }
  return { platformSupported: true, scannerPresent, hostPresent }
}

function cloneState(state: Vst3CatalogState): Vst3CatalogState {
  return {
    enabled: state.enabled,
    searchPaths: [...state.searchPaths],
    entries: state.entries.map((entry) => ({
      ...entry,
      supportedLayouts: [...entry.supportedLayouts],
      parameters: entry.parameters.map((parameter) => ({ ...parameter }))
    })),
    helpers: resolveVst3HelpersAvailability()
  }
}

function isCatalogState(value: unknown): value is Vst3CatalogState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<Vst3CatalogState>
  return (
    typeof state.enabled === 'boolean' &&
    Array.isArray(state.searchPaths) &&
    Array.isArray(state.entries)
  )
}

function isCatalogEntry(value: unknown): value is Vst3CatalogEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<Vst3CatalogEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.modulePath === 'string' &&
    typeof entry.moduleFingerprint === 'string' &&
    typeof entry.classId === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.vendor === 'string' &&
    typeof entry.version === 'string' &&
    typeof entry.category === 'string' &&
    Array.isArray(entry.supportedLayouts) &&
    Array.isArray(entry.parameters) &&
    (entry.status === 'available' ||
      entry.status === 'incompatible' ||
      entry.status === 'quarantined' ||
      entry.status === 'failed') &&
    (typeof entry.error === 'string' || entry.error === null) &&
    typeof entry.scannedAt === 'string'
  )
}
