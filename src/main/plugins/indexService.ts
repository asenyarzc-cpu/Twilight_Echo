import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile, type FileHandle } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  OFFICIAL_PLUGIN_INDEX_URL,
  createPluginIndexEntryFingerprint,
  loadTrustedPluginPublisherRegistry,
  verifyPluginIndexEntry,
  type PluginIndexTrustContext,
  type TrustedPluginPublisherRegistry
} from './indexTrust.ts'
import { isCompatibleTwilightRange, validatePluginManifest } from './manifest.ts'
import { extractPluginPackage } from './packageSecurity.ts'
import type {
  TwilightPluginDescriptor,
  TwilightPluginIndexCacheFormat,
  TwilightPluginIndexEntry,
  TwilightPluginIndexLoadedFrom,
  TwilightPluginIndexSourceKind,
  TwilightPluginIndexStatus,
  TwilightPluginInstallEvidence,
  TwilightPluginManifest
} from './types'
import { parseJsonWithNestingLimit } from '../security/jsonSafety.ts'

interface PluginIndexRaw {
  schemaVersion: number
  plugins: unknown[]
}

interface PluginIndexCacheEnvelope {
  cacheSchemaVersion: 1
  origin: string
  fetchedAt: string
  expiresAt: string
  etag?: string
  index: unknown
}

interface ActivePluginIndex {
  index: unknown
  indexOrigin: string
  loadedFrom: TwilightPluginIndexLoadedFrom
  stale: boolean
  originVerified: boolean
  expiresAt: string | null
  expiredWithoutTimestamp: boolean
}

export interface PluginIndexServiceOptions {
  appVersion: string
  localIndexPath: string
  remoteIndexUrl?: string
  cacheIndexPath?: string
  bundledPluginIds?: string[]
  fetchImpl?: typeof fetch
  indexSizeLimitBytes?: number
  packageSizeLimitBytes?: number
  timeoutMs?: number
  cacheTtlMs?: number
  now?: () => Date
  trustedPublisherRegistry?: TrustedPluginPublisherRegistry
  trustedPublisherRegistryPath?: string
  /**
   * Parent directory for downloaded .tep staging directories. Production passes a
   * path below Electron userData so downloads and the plugin install target stay
   * on the same volume.
   */
  packageStagingDir?: string
}

export type PluginIndexSourceKind = TwilightPluginIndexSourceKind
export type PluginIndexLoadedFrom = TwilightPluginIndexLoadedFrom
export type PluginIndexStatus = TwilightPluginIndexStatus

export interface DownloadedPluginPackage {
  entry: TwilightPluginIndexEntry
  packagePath: string
  evidence: TwilightPluginInstallEvidence
  cleanup: () => Promise<void>
}

export const DEFAULT_PLUGIN_INDEX_URL = OFFICIAL_PLUGIN_INDEX_URL

const INDEX_SCHEMA_VERSION = 1
const DEFAULT_INDEX_SIZE_LIMIT_BYTES = 1024 * 1024
const DEFAULT_PACKAGE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_REDIRECTS = 5
const PACKAGE_STREAM_CHUNK_BYTES = 64 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

interface RemoteResponseMetadata {
  response: Response
  responseUrl: string
  redirected: boolean
}

interface PackageSourceMetadata {
  checksum: string
  responseUrl: string
}

class PluginIndexPolicyError extends Error {}

export class PluginIndexService {
  private readonly appVersion: string
  private readonly localIndexPath: string
  private readonly remoteIndexUrl?: string
  private readonly cacheIndexPath?: string
  private readonly bundledPluginIds: Set<string>
  private readonly fetchImpl: typeof fetch
  private readonly indexSizeLimitBytes: number
  private readonly packageSizeLimitBytes: number
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly now: () => Date
  private readonly trustedPublisherRegistry: TrustedPluginPublisherRegistry
  private readonly packageStagingDir: string
  private cachedEntries: TwilightPluginIndexEntry[] | null = null
  private activeIndex: ActivePluginIndex | null = null
  private currentBaseUrl: string
  private status: TwilightPluginIndexStatus
  private loadGeneration = 0
  private latestLoadPromise: Promise<TwilightPluginIndexEntry[]> | null = null
  private cacheWriteQueue: Promise<void> = Promise.resolve()
  private cachedIndexEtag: string | null = null
  private indexValidatedAt = 0
  private backgroundRevalidate: Promise<void> | null = null

  constructor(options: PluginIndexServiceOptions) {
    this.appVersion = options.appVersion
    this.localIndexPath = options.localIndexPath
    this.remoteIndexUrl = options.remoteIndexUrl?.trim() || undefined
    this.cacheIndexPath = options.cacheIndexPath
    this.bundledPluginIds = new Set(options.bundledPluginIds ?? [])
    this.fetchImpl = options.fetchImpl ?? fetch
    this.indexSizeLimitBytes = options.indexSizeLimitBytes ?? DEFAULT_INDEX_SIZE_LIMIT_BYTES
    this.packageSizeLimitBytes = options.packageSizeLimitBytes ?? DEFAULT_PACKAGE_SIZE_LIMIT_BYTES
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs <= 0) {
      throw new Error('插件索引 cacheTtlMs 必须是正数')
    }
    this.now = options.now ?? (() => new Date())
    this.trustedPublisherRegistry =
      options.trustedPublisherRegistry ??
      loadTrustedPluginPublisherRegistry(
        options.trustedPublisherRegistryPath ??
          join(dirname(this.localIndexPath), 'trusted-publishers.json')
      )
    this.packageStagingDir = options.packageStagingDir?.trim() || tmpdir()
    this.currentBaseUrl = this.remoteIndexUrl || pathToFileURL(this.localIndexPath).toString()
    const configuredSourceUrl = this.currentBaseUrl
    this.status = this.createStatus({
      sourceUrl: configuredSourceUrl,
      configuredSourceUrl,
      loadedFrom: this.remoteIndexUrl ? 'remote' : 'bundled',
      lastFetchedAt: null,
      expiresAt: null,
      stale: false,
      expired: false,
      originVerified: false,
      cacheFormat: null,
      error: null
    })
  }

  async list(forceRefresh = false): Promise<TwilightPluginIndexEntry[]> {
    if (!forceRefresh && this.cachedEntries) {
      this.refreshDerivedTrust()
      if ((this.status.stale || this.status.expired) && !this.backgroundRevalidate) {
        this.startBackgroundRevalidate()
      }
      return this.cachedEntries
    }
    const generation = ++this.loadGeneration
    const loadPromise = this.loadIndex(generation)
    this.latestLoadPromise = loadPromise
    try {
      return await loadPromise
    } finally {
      if (this.latestLoadPromise === loadPromise) this.latestLoadPromise = null
    }
  }

  private startBackgroundRevalidate(): void {
    const generation = ++this.loadGeneration
    const operation = this.loadIndex(generation, false)
      .catch(() => undefined)
      .then((): void => undefined)
      .finally(() => {
        if (this.backgroundRevalidate === operation) this.backgroundRevalidate = null
      })
    this.backgroundRevalidate = operation
  }

  private hasRecentlyValidatedIndex(): boolean {
    return (
      this.cachedEntries !== null &&
      !this.status.expired &&
      this.indexValidatedAt > 0 &&
      Date.now() - this.indexValidatedAt < 60_000
    )
  }

  private async loadIndex(
    generation: number,
    allowCachedResult = true
  ): Promise<TwilightPluginIndexEntry[]> {
    const remoteUrl = this.remoteIndexUrl
    if (!remoteUrl) {
      return this.loadBundledIndex(null, generation)
    }

    try {
      if (allowCachedResult) {
        const cached = await this.tryReadCache(remoteUrl, null, generation, false)
        if (cached && !this.status.expired) {
          this.indexValidatedAt = Date.now()
          this.startBackgroundRevalidate()
          return cached
        }
      }
      const {
        raw,
        responseUrl: indexOrigin,
        redirected,
        etag: responseEtag
      } = await this.readRemoteIndex(remoteUrl, this.cachedIndexEtag ?? undefined)
      if (raw === null) {
        const refreshed = await this.refreshNotModifiedCache(remoteUrl, generation)
        if (refreshed) {
          this.indexValidatedAt = Date.now()
          return refreshed
        }
        throw new Error('插件索引返回 304 但缺少有效缓存')
      }
      if (!this.isCurrentLoad(generation)) return this.latestSnapshot(generation)
      const parsed = parseJsonWithNestingLimit(raw) as unknown
      const fetchedAtDate = this.currentTime()
      const fetchedAt = fetchedAtDate.toISOString()
      const expiresAt = new Date(fetchedAtDate.getTime() + this.cacheTtlMs).toISOString()
      const exactConfiguredOrigin = indexOrigin === remoteUrl && !redirected
      const unpersistedContext = this.trustContext({
        indexOrigin,
        loadedFrom: 'remote',
        stale: false,
        expired: false,
        originVerified: exactConfiguredOrigin && !this.cacheIndexPath
      })
      let entries = this.validateIndex(parsed, indexOrigin, unpersistedContext, fetchedAtDate)
      let originVerified = exactConfiguredOrigin && !this.cacheIndexPath
      let cacheError: string | null = null
      try {
        const cacheWritten = await this.writeCache(
          {
            cacheSchemaVersion: 1,
            origin: indexOrigin,
            fetchedAt,
            expiresAt,
            ...(responseEtag ? { etag: responseEtag } : {}),
            index: parsed
          },
          generation
        )
        if (!this.isCurrentLoad(generation)) return this.latestSnapshot(generation)
        if (this.cacheIndexPath && !cacheWritten) return this.latestSnapshot(generation)
        originVerified = exactConfiguredOrigin
      } catch (error) {
        if (!this.isCurrentLoad(generation)) return this.latestSnapshot(generation)
        cacheError = `插件索引缓存写入失败：${errorMessage(error)}`
      }
      if (originVerified !== unpersistedContext.originVerified) {
        entries = this.validateIndex(
          parsed,
          indexOrigin,
          this.trustContext({
            indexOrigin,
            loadedFrom: 'remote',
            stale: false,
            expired: false,
            originVerified
          }),
          fetchedAtDate
        )
      }
      if (!this.isCurrentLoad(generation)) return this.latestSnapshot(generation)
      this.currentBaseUrl = indexOrigin
      this.cachedIndexEtag = responseEtag ?? null
      this.indexValidatedAt = Date.now()
      this.cachedEntries = entries
      this.status = this.createStatus({
        sourceUrl: indexOrigin,
        configuredSourceUrl: remoteUrl,
        loadedFrom: 'remote',
        lastFetchedAt: fetchedAt,
        expiresAt,
        loadedAt: fetchedAt,
        stale: false,
        expired: false,
        originVerified,
        cacheFormat: null,
        error: cacheError
      })
      this.activeIndex = {
        index: parsed,
        indexOrigin,
        loadedFrom: 'remote',
        stale: false,
        originVerified,
        expiresAt,
        expiredWithoutTimestamp: false
      }
      return this.cachedEntries
    } catch (remoteError) {
      if (!this.isCurrentLoad(generation)) return this.latestSnapshot(generation)
      const message = errorMessage(remoteError)
      if (!isRecoverableIndexError(remoteError)) throw remoteError
      const cached = await this.tryReadCache(remoteUrl, message, generation)
      if (cached) return cached
      return this.loadBundledIndex(message, generation)
    }
  }

  async refresh(): Promise<TwilightPluginIndexEntry[]> {
    return this.list(true)
  }

  private async refreshNotModifiedCache(
    remoteUrl: string,
    generation: number
  ): Promise<TwilightPluginIndexEntry[] | null> {
    if (!this.cacheIndexPath || !this.cachedIndexEtag) return null
    const raw = await this.readIndexSource(this.cacheIndexPath)
    const envelope = parseCacheEnvelope(parseJsonWithNestingLimit(raw) as unknown)
    if (!envelope) return null
    const fetchedAtDate = this.currentTime()
    const updatedEnvelope: PluginIndexCacheEnvelope = {
      ...envelope,
      fetchedAt: fetchedAtDate.toISOString(),
      expiresAt: new Date(fetchedAtDate.getTime() + this.cacheTtlMs).toISOString(),
      etag: this.cachedIndexEtag
    }
    const written = await this.writeCache(updatedEnvelope, generation)
    if (!written) return null
    return this.tryReadCache(remoteUrl, null, generation, false)
  }

  getStatus(): TwilightPluginIndexStatus {
    this.refreshDerivedTrust()
    return { ...this.status }
  }

  async downloadPackage(id: string): Promise<DownloadedPluginPackage> {
    if (!this.hasRecentlyValidatedIndex()) await this.list(true)
    this.refreshDerivedTrust()
    const entry = this.cachedEntries?.find((candidate) => candidate.id === id)
    if (!entry) throw new Error('插件索引中未找到该插件')
    if (this.bundledPluginIds.has(entry.id)) {
      throw new Error('索引不能安装或覆盖 Twilight Echo 自带插件')
    }
    if (!isCompatibleTwilightRange(entry.engines.twilightEcho, this.appVersion)) {
      throw new Error(`插件 ${entry.name} 不兼容当前 Twilight Echo ${this.appVersion}`)
    }
    const entryOrigin = this.activeIndex?.indexOrigin ?? this.indexBaseUrl()
    const entryFingerprint = createPluginIndexEntryFingerprint(
      entry as unknown as Record<string, unknown>,
      entryOrigin
    )
    const packageUrl = this.resolveSourceUrl(entry.sourceUrl, entryOrigin)
    const tempRoot = await this.createPackageStagingRoot()
    const packagePath = join(tempRoot, 'package.tep')
    try {
      const { checksum, responseUrl: packageSourceUrl } = await this.streamPackageSource(
        packageUrl,
        packagePath
      )
      if (checksum.toLowerCase() !== entry.checksumSha256.toLowerCase()) {
        throw new Error(`插件包 checksum 不匹配：${entry.id}`)
      }
      await this.validateDownloadedPackageManifest(entry, packagePath, tempRoot)
      this.refreshDerivedTrust()
      const currentEntry = this.cachedEntries?.find((candidate) => candidate.id === id)
      if (!currentEntry) throw new Error('插件索引状态已失效，请刷新后重试')
      const currentOrigin = this.activeIndex?.indexOrigin ?? this.indexBaseUrl()
      const currentFingerprint = createPluginIndexEntryFingerprint(
        currentEntry as unknown as Record<string, unknown>,
        currentOrigin
      )
      if (currentFingerprint !== entryFingerprint) {
        throw new Error(`插件索引在下载期间发生变化，请刷新后重试：${entry.id}`)
      }
      const indexStatus = { ...this.status }
      return {
        entry: currentEntry,
        packagePath,
        evidence: {
          sourceLabel: packageSourceUrl,
          indexSourceUrl: indexStatus.sourceUrl,
          configuredIndexUrl: indexStatus.configuredSourceUrl,
          loadedFrom: indexStatus.loadedFrom,
          fetchedAt: indexStatus.lastFetchedAt,
          expiresAt: indexStatus.expiresAt,
          stale: indexStatus.stale,
          expired: indexStatus.expired,
          originVerified: indexStatus.originVerified,
          cacheFormat: indexStatus.cacheFormat,
          packageSha256: checksum,
          checksumVerified: true,
          manifestVerified: true,
          expectedPackageSha256: currentEntry.checksumSha256,
          verification: currentEntry.verification
        },
        cleanup: async () => {
          await rm(tempRoot, { recursive: true, force: true })
        }
      }
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true })
      throw error
    }
  }

  describeInstallState(
    entry: TwilightPluginIndexEntry,
    installed: TwilightPluginDescriptor[]
  ): 'not-installed' | 'installed' | 'update-available' | 'incompatible' | 'built-in-blocked' {
    if (this.bundledPluginIds.has(entry.id)) return 'built-in-blocked'
    if (!isCompatibleTwilightRange(entry.engines.twilightEcho, this.appVersion))
      return 'incompatible'
    const descriptor = installed.find((plugin) => plugin.id === entry.id)
    if (!descriptor) return 'not-installed'
    if (compareSemver(entry.version, descriptor.version) > 0) return 'update-available'
    return 'installed'
  }

  private indexBaseUrl(): string {
    return this.currentBaseUrl
  }

  private async writeCache(
    envelope: PluginIndexCacheEnvelope,
    generation: number
  ): Promise<boolean> {
    if (!this.cacheIndexPath) return false
    const operation = this.cacheWriteQueue.then(async () => {
      if (!this.isCurrentLoad(generation)) return false
      await mkdir(dirname(this.cacheIndexPath!), { recursive: true })
      if (!this.isCurrentLoad(generation)) return false
      await writeFile(this.cacheIndexPath!, JSON.stringify(envelope, null, 2), 'utf-8')
      return true
    })
    this.cacheWriteQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async tryReadCache(
    remoteUrl: string,
    remoteError: string | null,
    generation: number,
    stale = true
  ): Promise<TwilightPluginIndexEntry[] | null> {
    if (!this.cacheIndexPath) return null
    try {
      const raw = await this.readIndexSource(this.cacheIndexPath)
      if (!this.isCurrentLoad(generation)) return this.latestSnapshot(generation)
      const parsed = parseJsonWithNestingLimit(raw) as unknown
      const envelope = parseCacheEnvelope(parsed)
      const loadedAtDate = this.currentTime()
      const loadedAt = loadedAtDate.toISOString()
      let indexOrigin: string
      let index: unknown
      let fetchedAt: string | null
      let expiresAt: string | null
      let expired: boolean
      let originVerified: boolean
      let cacheFormat: TwilightPluginIndexCacheFormat
      let etag: string | null = null

      if (envelope) {
        indexOrigin = envelope.origin
        index = envelope.index
        fetchedAt = envelope.fetchedAt
        expiresAt = envelope.expiresAt
        expired = loadedAtDate.getTime() >= Date.parse(envelope.expiresAt)
        originVerified = envelope.origin === remoteUrl
        cacheFormat = 'envelope-v1'
        etag = typeof envelope.etag === 'string' && envelope.etag ? envelope.etag : null
      } else {
        indexOrigin = remoteUrl
        index = parsed
        fetchedAt = null
        expiresAt = null
        expired = true
        originVerified = false
        cacheFormat = 'legacy'
      }

      this.currentBaseUrl = indexOrigin
      this.cachedIndexEtag = etag
      this.cachedEntries = this.validateIndex(
        index,
        indexOrigin,
        this.trustContext({
          indexOrigin,
          loadedFrom: 'cache',
          stale,
          expired,
          originVerified
        }),
        loadedAtDate
      )
      this.status = this.createStatus({
        sourceUrl: indexOrigin,
        configuredSourceUrl: remoteUrl,
        loadedFrom: 'cache',
        lastFetchedAt: fetchedAt,
        expiresAt,
        loadedAt,
        stale,
        expired,
        originVerified,
        cacheFormat,
        error: remoteError
      })
      this.activeIndex = {
        index,
        indexOrigin,
        loadedFrom: 'cache',
        stale: true,
        originVerified,
        expiresAt,
        expiredWithoutTimestamp: cacheFormat === 'legacy'
      }
      return this.cachedEntries
    } catch {
      if (!this.isCurrentLoad(generation)) return this.latestSnapshot(generation)
      return null
    }
  }

  private async loadBundledIndex(
    remoteError: string | null,
    generation: number
  ): Promise<TwilightPluginIndexEntry[]> {
    const localUrl = pathToFileURL(this.localIndexPath).toString()
    const raw = await this.readIndexSource(this.localIndexPath)
    if (!this.isCurrentLoad(generation)) return this.latestSnapshot(generation)
    const parsed = parseJsonWithNestingLimit(raw) as unknown
    const loadedAtDate = this.currentTime()
    const stale = remoteError !== null
    this.currentBaseUrl = localUrl
    this.cachedEntries = this.validateIndex(
      parsed,
      localUrl,
      this.trustContext({
        indexOrigin: localUrl,
        loadedFrom: 'bundled',
        stale,
        expired: false,
        originVerified: true
      }),
      loadedAtDate
    )
    this.status = this.createStatus({
      sourceUrl: localUrl,
      configuredSourceUrl: this.remoteIndexUrl ?? localUrl,
      loadedFrom: 'bundled',
      lastFetchedAt: null,
      expiresAt: null,
      stale,
      expired: false,
      originVerified: true,
      cacheFormat: null,
      loadedAt: loadedAtDate.toISOString(),
      error: remoteError
    })
    this.activeIndex = {
      index: parsed,
      indexOrigin: localUrl,
      loadedFrom: 'bundled',
      stale,
      originVerified: true,
      expiresAt: null,
      expiredWithoutTimestamp: false
    }
    return this.cachedEntries
  }

  private isCurrentLoad(generation: number): boolean {
    return generation === this.loadGeneration
  }

  private async latestSnapshot(generation: number): Promise<TwilightPluginIndexEntry[]> {
    if (this.isCurrentLoad(generation)) {
      throw new Error('插件索引加载状态异常')
    }
    const latest = this.latestLoadPromise
    if (latest) return latest
    if (this.cachedEntries) {
      this.refreshDerivedTrust()
      return this.cachedEntries
    }
    throw new Error('插件索引加载已被更新请求取代')
  }

  private validateIndex(
    raw: unknown,
    baseUrl: string,
    trustContext: PluginIndexTrustContext,
    verificationTime: Date = this.currentTime()
  ): TwilightPluginIndexEntry[] {
    if (!isPluginIndexRaw(raw))
      throw new Error('插件索引必须是包含 schemaVersion 和 plugins 的对象')
    if (raw.schemaVersion !== INDEX_SCHEMA_VERSION) {
      throw new Error(`不支持的插件索引 schemaVersion：${raw.schemaVersion}`)
    }
    return raw.plugins.map((candidate, index) =>
      this.validateEntry(candidate, index, baseUrl, trustContext, verificationTime)
    )
  }

  private validateEntry(
    raw: unknown,
    index: number,
    baseUrl: string,
    trustContext: PluginIndexTrustContext,
    verificationTime: Date
  ): TwilightPluginIndexEntry {
    const manifest = validatePluginManifest(raw) as TwilightPluginManifest
    if (!isRecord(raw)) throw new Error(`插件索引第 ${index + 1} 项必须是对象`)
    const sourceUrl = requireString(raw, 'sourceUrl')
    this.resolveSourceUrl(sourceUrl, baseUrl)
    const checksumSha256 = requireString(raw, 'checksumSha256').toLowerCase()
    if (!SHA256_PATTERN.test(checksumSha256)) {
      throw new Error(`插件索引 ${manifest.id} checksumSha256 必须是 64 位 sha256`)
    }
    if (this.bundledPluginIds.has(manifest.id)) {
      throw new Error(`插件索引不能包含自带插件：${manifest.id}`)
    }
    if (raw.verified !== undefined && typeof raw.verified !== 'boolean') {
      throw new Error(`插件索引 ${manifest.id} verified 必须是 boolean`)
    }
    const entry = {
      ...manifest,
      sourceUrl,
      checksumSha256,
      repository: typeof raw.repository === 'string' ? raw.repository.trim() : manifest.repository,
      homepage: typeof raw.homepage === 'string' ? raw.homepage.trim() : manifest.homepage,
      tags: Array.isArray(raw.tags)
        ? raw.tags
            .filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()))
            .map((tag) => tag.trim())
        : undefined,
      ...(typeof raw.verified === 'boolean' ? { verified: raw.verified } : {}),
      publisherSignature: raw.publisherSignature
    } as Record<string, unknown>
    const trust = verifyPluginIndexEntry(
      entry,
      trustContext,
      this.trustedPublisherRegistry,
      verificationTime
    )
    return {
      ...(entry as unknown as TwilightPluginIndexEntry),
      publisherSignature: trust.signature,
      verification: trust.verification
    }
  }

  private trustContext(context: PluginIndexTrustContext): PluginIndexTrustContext {
    return context
  }

  private refreshDerivedTrust(): void {
    const activeIndex = this.activeIndex
    if (!activeIndex) return
    const verificationTime = this.currentTime()
    const expired = activeIndex.expiresAt
      ? verificationTime.getTime() >= Date.parse(activeIndex.expiresAt)
      : activeIndex.expiredWithoutTimestamp
    this.cachedEntries = this.validateIndex(
      activeIndex.index,
      activeIndex.indexOrigin,
      this.trustContext({
        indexOrigin: activeIndex.indexOrigin,
        loadedFrom: activeIndex.loadedFrom,
        stale: activeIndex.stale,
        expired,
        originVerified: activeIndex.originVerified
      }),
      verificationTime
    )
    if (this.status.expired !== expired) {
      this.status = { ...this.status, expired }
    }
  }

  private currentTime(): Date {
    const value = this.now()
    if (!Number.isFinite(value.getTime())) throw new Error('插件索引时钟无效')
    return value
  }

  private createStatus(input: {
    sourceUrl: string
    configuredSourceUrl: string
    loadedFrom: TwilightPluginIndexLoadedFrom
    lastFetchedAt: string | null
    expiresAt: string | null
    loadedAt?: string
    stale: boolean
    expired: boolean
    originVerified: boolean
    cacheFormat: TwilightPluginIndexCacheFormat | null
    error: string | null
  }): TwilightPluginIndexStatus {
    return {
      sourceUrl: input.sourceUrl,
      configuredSourceUrl: input.configuredSourceUrl,
      sourceKind: input.loadedFrom === 'bundled' ? 'bundled' : sourceKindForUrl(input.sourceUrl),
      loadedFrom: input.loadedFrom,
      lastFetchedAt: input.lastFetchedAt,
      expiresAt: input.expiresAt,
      loadedAt: input.loadedAt ?? this.currentTime().toISOString(),
      stale: input.stale,
      expired: input.expired,
      originVerified: input.originVerified,
      officialSource: input.sourceUrl === OFFICIAL_PLUGIN_INDEX_URL,
      cacheFormat: input.cacheFormat,
      trustStoreError: this.trustedPublisherRegistry.error,
      error: input.error
    }
  }

  private async readIndexSource(source: string): Promise<string> {
    if (isHttpUrl(source)) {
      const { buffer } = await this.fetchBufferWithMetadata(source, this.indexSizeLimitBytes)
      return buffer.toString('utf-8')
    }
    const filePath = source.startsWith('file://') ? fileUrlToPath(source) : resolve(source)
    const data = await readFile(filePath)
    if (data.byteLength > this.indexSizeLimitBytes) throw new Error('插件索引文件过大')
    return data.toString('utf-8')
  }

  private async readRemoteIndex(
    source: string,
    etag?: string
  ): Promise<{
    raw: string | null
    responseUrl: string
    redirected: boolean
    etag?: string | null
  }> {
    const result = await this.fetchBufferWithMetadata(
      source,
      this.indexSizeLimitBytes,
      etag ? { 'If-None-Match': etag } : undefined
    )
    return {
      raw: result.status === 304 ? null : result.buffer.toString('utf-8'),
      responseUrl: result.responseUrl,
      redirected: result.redirected,
      etag: result.etag
    }
  }

  private async fetchBufferWithMetadata(
    url: string,
    limitBytes: number,
    headers?: Record<string, string>
  ): Promise<{
    buffer: Buffer
    responseUrl: string
    redirected: boolean
    status: number
    etag?: string | null
  }> {
    const result = await this.withRemoteResponse(
      url,
      async (response, controller) => this.readResponseBuffer(response, limitBytes, controller),
      headers
    )
    return {
      buffer: result.value,
      responseUrl: result.responseUrl,
      redirected: result.redirected,
      status: result.status,
      etag: result.etag
    }
  }

  private async createPackageStagingRoot(): Promise<string> {
    const parent = resolve(this.packageStagingDir)
    await mkdir(parent, { recursive: true })
    return await mkdtemp(join(parent, 'twilight-plugin-download-'))
  }

  private async streamPackageSource(
    source: string,
    packagePath: string
  ): Promise<PackageSourceMetadata> {
    if (isHttpUrl(source)) {
      let serverAcceptsRanges = false
      try {
        const result = await this.withRemoteResponse(source, async (response, controller) => {
          serverAcceptsRanges =
            response.headers.get('accept-ranges')?.toLowerCase().includes('bytes') === true
          return await this.writeResponsePackage(response, packagePath, controller)
        })
        return { checksum: result.value, responseUrl: result.responseUrl }
      } catch (error) {
        const partialSize = existsSync(packagePath) ? (await stat(packagePath)).size : 0
        if (!serverAcceptsRanges || partialSize === 0) throw error
        const result = await this.withRemoteResponse(
          source,
          async (response, controller) =>
            this.writeResponsePackage(response, packagePath, controller, partialSize),
          { Range: `bytes=${partialSize}-` }
        )
        return { checksum: result.value, responseUrl: result.responseUrl }
      }
    }
    if (!source.startsWith('file://')) throw new Error('插件包 sourceUrl 协议不受支持')
    const filePath = fileUrlToPath(source)
    if (!existsSync(filePath)) throw new Error('插件包文件不存在')
    const sourceStats = await stat(filePath)
    if (!sourceStats.isFile()) throw new Error('插件包来源必须是文件')
    if (sourceStats.size > this.packageSizeLimitBytes) throw new Error('插件包文件过大')
    return {
      checksum: await this.writeLocalPackage(filePath, packagePath),
      responseUrl: source
    }
  }

  private async withRemoteResponse<T>(
    source: string,
    consume: (response: Response, controller: AbortController) => Promise<T>,
    headers?: Record<string, string>
  ): Promise<{
    value: T
    responseUrl: string
    redirected: boolean
    status: number
    etag?: string | null
  }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let activeResponse: Response | null = null
    try {
      const response = await this.fetchRemoteResponse(source, controller, headers)
      activeResponse = response.response
      return {
        value: await consume(activeResponse, controller),
        responseUrl: response.responseUrl,
        redirected: response.redirected,
        status: response.response.status,
        etag: response.response.headers.get('etag')
      }
    } catch (error) {
      controller.abort()
      await discardResponseBody(activeResponse)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchRemoteResponse(
    source: string,
    controller: AbortController,
    headers: Record<string, string> = {}
  ): Promise<RemoteResponseMetadata> {
    const initialUrl = new URL(source)
    assertAllowedPluginRemoteUrl(initialUrl, 'Plugin index')
    let currentUrl = initialUrl
    let redirects = 0
    let redirected = false
    const visited = new Set([currentUrl.toString()])

    while (true) {
      const response = await this.fetchImpl(currentUrl.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers
      })
      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get('location')
        : null
      if (REDIRECT_STATUSES.has(response.status)) {
        if (!location) {
          await discardResponseBody(response)
          throw new PluginIndexPolicyError('Plugin download redirect is missing a Location header')
        }
        if (redirects >= DEFAULT_MAX_REDIRECTS) {
          await discardResponseBody(response)
          throw new PluginIndexPolicyError(
            `Plugin download exceeded the ${DEFAULT_MAX_REDIRECTS}-redirect limit`
          )
        }
        const targetUrl = resolvePluginRedirectTarget(currentUrl, location)
        if (visited.has(targetUrl.toString())) {
          await discardResponseBody(response)
          throw new PluginIndexPolicyError('Plugin download redirect loop detected')
        }
        await discardResponseBody(response)
        currentUrl = targetUrl
        visited.add(currentUrl.toString())
        redirects += 1
        redirected = true
        continue
      }
      if (!response.ok && response.status !== 304) {
        await discardResponseBody(response)
        throw new Error(`插件索引请求失败：HTTP ${response.status}`)
      }

      const responseUrl = response.url?.trim() || currentUrl.toString()
      const reportedUrl = new URL(responseUrl)
      assertAllowedPluginRemoteUrl(reportedUrl, 'Plugin index response')
      if (reportedUrl.protocol !== currentUrl.protocol && currentUrl.protocol === 'https:') {
        await discardResponseBody(response)
        throw new PluginIndexPolicyError('Plugin download redirect downgrade is not allowed')
      }
      return {
        response,
        responseUrl: reportedUrl.toString(),
        redirected:
          redirected ||
          response.redirected === true ||
          reportedUrl.toString() !== currentUrl.toString()
      }
    }
  }

  private async readResponseBuffer(
    response: Response,
    limitBytes: number,
    controller: AbortController
  ): Promise<Buffer> {
    const chunks: Buffer[] = []
    const totalBytes = await consumeResponseBody(
      response,
      limitBytes,
      controller,
      async (chunk) => {
        chunks.push(Buffer.from(chunk))
      }
    )
    return Buffer.concat(chunks, totalBytes)
  }

  private async writeResponsePackage(
    response: Response,
    packagePath: string,
    controller: AbortController,
    resumeFrom = 0
  ): Promise<string> {
    if (resumeFrom === 0) {
      return await this.writePackage(packagePath, async (writeChunk) => {
        await consumeResponseBody(response, this.packageSizeLimitBytes, controller, writeChunk)
      })
    }
    if (response.status !== 206) {
      await discardResponseBody(response)
      throw new PluginIndexPolicyError('插件下载服务不支持请求的字节区间')
    }
    const partial = await readFile(packagePath)
    if (partial.byteLength !== resumeFrom || partial.byteLength > this.packageSizeLimitBytes) {
      throw new PluginIndexPolicyError('插件下载续传状态无效')
    }
    return await this.writePackage(
      packagePath,
      async (writeChunk) => {
        await consumeResponseBody(
          response,
          this.packageSizeLimitBytes - resumeFrom,
          controller,
          writeChunk
        )
      },
      partial,
      resumeFrom
    )
  }

  private async writeLocalPackage(sourcePath: string, packagePath: string): Promise<string> {
    return await this.writePackage(packagePath, async (writeChunk) => {
      const source = await open(sourcePath, 'r')
      let receivedBytes = 0
      try {
        while (true) {
          const chunk = Buffer.allocUnsafe(PACKAGE_STREAM_CHUNK_BYTES)
          const { bytesRead } = await source.read(chunk, 0, chunk.byteLength, null)
          if (bytesRead === 0) return
          const data = chunk.subarray(0, bytesRead)
          receivedBytes = addBoundedBytes(
            receivedBytes,
            data.byteLength,
            this.packageSizeLimitBytes
          )
          await writeChunk(data)
        }
      } finally {
        await source.close()
      }
    })
  }

  private async writePackage(
    packagePath: string,
    copy: (writeChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
    existingBytes?: Buffer,
    resumeFrom = 0
  ): Promise<string> {
    let handle: FileHandle | null = null
    let position = 0
    const hash = createHash('sha256')
    try {
      handle = await open(packagePath, existingBytes ? 'r+' : 'wx')
      if (existingBytes) {
        hash.update(existingBytes)
        position = resumeFrom
      }
      await copy(async (chunk) => {
        hash.update(chunk)
        position = await writeAll(handle!, chunk, position)
      })
      await handle.sync()
      await handle.close()
      handle = null
      return hash.digest('hex')
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await rm(packagePath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private resolveSourceUrl(sourceUrl: string, baseUrl: string): string {
    const trimmed = sourceUrl.trim()
    if (!trimmed) throw new Error('插件索引 sourceUrl 不能为空')
    if (
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) &&
      !isHttpUrl(trimmed) &&
      !trimmed.startsWith('file://')
    ) {
      throw new Error('插件包 sourceUrl 协议不受支持')
    }
    if (isHttpUrl(trimmed)) {
      const parsed = new URL(trimmed)
      if (!isAllowedHttpUrl(parsed)) throw new Error('插件包 sourceUrl 协议不受支持')
      return parsed.toString()
    }
    if (trimmed.startsWith('file://')) return new URL(trimmed).toString()
    if (isAbsolute(trimmed)) return pathToFileURL(trimmed).toString()
    if (baseUrl.startsWith('file://')) {
      const basePath = fileUrlToPath(baseUrl)
      const resolved = resolve(dirname(basePath), trimmed)
      if (!isInsidePath(resolved, dirname(basePath))) {
        throw new Error('插件包 sourceUrl 不能指向索引目录外')
      }
      return pathToFileURL(resolved).toString()
    }
    return new URL(trimmed, baseUrl).toString()
  }

  private async validateDownloadedPackageManifest(
    entry: TwilightPluginIndexEntry,
    packagePath: string,
    tempRoot: string
  ): Promise<void> {
    const extractedRoot = join(tempRoot, 'manifest-check')
    await extractPluginPackage(packagePath, extractedRoot)
    const manifest = validatePluginManifest(
      parseJsonWithNestingLimit(await readFile(join(extractedRoot, 'plugin.json'), 'utf-8'))
    )
    const mismatches = manifestComparisonKeys.filter(
      (key) => JSON.stringify(manifest[key]) !== JSON.stringify(entry[key])
    )
    if (mismatches.length > 0) {
      throw new Error(`插件包 manifest 与索引 entry 不一致：${entry.id} (${mismatches.join(', ')})`)
    }
  }
}

export function resolvePluginIndexUrl(value?: string): string {
  return value?.trim() || DEFAULT_PLUGIN_INDEX_URL
}

async function consumeResponseBody(
  response: Response,
  limitBytes: number,
  controller: AbortController,
  onChunk: (chunk: Uint8Array) => Promise<void>
): Promise<number> {
  const contentLength = parseContentLength(response.headers.get('content-length'))
  if (contentLength !== null && contentLength > limitBytes) {
    controller.abort()
    await discardResponseBody(response)
    throw new Error('Plugin response Content-Length exceeds the configured size limit')
  }

  const body = response.body
  if (!body) {
    if (contentLength !== null && contentLength > 0) {
      controller.abort()
      throw new Error('Plugin response ended before the declared Content-Length')
    }
    return 0
  }

  const reader = body.getReader()
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  if (controller.signal.aborted) cancelReader()
  else controller.signal.addEventListener('abort', cancelReader, { once: true })

  let receivedBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return receivedBytes
      if (!value || value.byteLength === 0) continue
      receivedBytes = addBoundedBytes(receivedBytes, value.byteLength, limitBytes)
      await onChunk(value)
    }
  } catch (error) {
    controller.abort()
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    controller.signal.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }
}

async function discardResponseBody(response: Response | null): Promise<void> {
  if (!response?.body) return
  await response.body.cancel().catch(() => undefined)
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function addBoundedBytes(receivedBytes: number, chunkBytes: number, limitBytes: number): number {
  if (chunkBytes > limitBytes - receivedBytes) {
    throw new Error('Plugin response exceeds the configured size limit')
  }
  return receivedBytes + chunkBytes
}

async function writeAll(handle: FileHandle, chunk: Uint8Array, position: number): Promise<number> {
  let sourceOffset = 0
  let targetPosition = position
  while (sourceOffset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      sourceOffset,
      chunk.byteLength - sourceOffset,
      targetPosition
    )
    if (bytesWritten <= 0) throw new Error('Could not write plugin package staging file')
    sourceOffset += bytesWritten
    targetPosition += bytesWritten
  }
  return targetPosition
}

function assertAllowedPluginRemoteUrl(url: URL, label: string): void {
  if (url.username || url.password) {
    throw new PluginIndexPolicyError(`${label} URLs containing credentials are not allowed`)
  }
  if (!isAllowedHttpUrl(url)) {
    throw new PluginIndexPolicyError(`${label} only permits https or localhost http URLs`)
  }
}

function resolvePluginRedirectTarget(currentUrl: URL, location: string): URL {
  let targetUrl: URL
  try {
    targetUrl = new URL(location, currentUrl)
  } catch {
    throw new PluginIndexPolicyError('Plugin download redirect has an invalid target URL')
  }
  if (currentUrl.protocol === 'https:' && targetUrl.protocol !== 'https:') {
    throw new PluginIndexPolicyError('Plugin download redirect downgrade is not allowed')
  }
  assertAllowedPluginRemoteUrl(targetUrl, 'Plugin download redirect')
  return targetUrl
}

const manifestComparisonKeys: Array<keyof TwilightPluginManifest> = [
  'id',
  'name',
  'version',
  'description',
  'author',
  'license',
  'type',
  'main',
  'binary',
  'dependencies',
  'engines',
  'apiVersion',
  'permissions',
  'contributes',
  'homepage',
  'repository',
  'icon',
  'signature'
]

function parseCacheEnvelope(value: unknown): PluginIndexCacheEnvelope | null {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'cacheSchemaVersion')) {
    return null
  }
  if (value.cacheSchemaVersion !== 1) {
    throw new Error('不支持的插件索引缓存 schemaVersion')
  }
  const origin = requireCacheString(value.origin, 'origin')
  if (!isHttpUrl(origin) || !isAllowedHttpUrl(new URL(origin))) {
    throw new Error('插件索引缓存 origin 必须是允许的远程 URL')
  }
  const fetchedAt = normalizeCacheTimestamp(value.fetchedAt, 'fetchedAt')
  const expiresAt = normalizeCacheTimestamp(value.expiresAt, 'expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(fetchedAt)) {
    throw new Error('插件索引缓存 expiresAt 必须晚于 fetchedAt')
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'index')) {
    throw new Error('插件索引缓存缺少 index')
  }
  return {
    cacheSchemaVersion: 1,
    origin,
    fetchedAt,
    expiresAt,
    ...(typeof value.etag === 'string' && value.etag ? { etag: value.etag } : {}),
    index: value.index
  }
}

function requireCacheString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`插件索引缓存 ${field} 必须是非空字符串`)
  }
  return value.trim()
}

function normalizeCacheTimestamp(value: unknown, field: string): string {
  const timestamp = requireCacheString(value, field)
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) throw new Error(`插件索引缓存 ${field} 必须是有效时间`)
  return new Date(parsed).toISOString()
}

function isPluginIndexRaw(value: unknown): value is PluginIndexRaw {
  return (
    isRecord(value) && value.schemaVersion === INDEX_SCHEMA_VERSION && Array.isArray(value.plugins)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`插件索引字段 ${key} 必须是非空字符串`)
  }
  return value.trim()
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://')
}

function isAllowedHttpUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
}

function sourceKindForUrl(url: string): PluginIndexSourceKind {
  return url === DEFAULT_PLUGIN_INDEX_URL ? 'github' : 'custom'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecoverableIndexError(error: unknown): boolean {
  if (error instanceof PluginIndexPolicyError) return false
  const message = errorMessage(error)
  return !(
    message.includes('只允许 https 或本机 http URL') ||
    message.includes('协议不受支持') ||
    message.includes('schemaVersion') ||
    message.includes('插件索引必须是') ||
    message.includes('sourceUrl') ||
    message.includes('checksumSha256') ||
    message.includes('自带插件')
  )
}

function fileUrlToPath(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'file:') throw new Error('不是 file URL')
  return fileURLToPath(url)
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  return 0
}

function isInsidePath(child: string, parent: string): boolean {
  const pathBetween = relative(resolve(parent), resolve(child))
  return (
    pathBetween === '' ||
    (pathBetween !== '..' && !pathBetween.startsWith(`..${sep}`) && !isAbsolute(pathBetween))
  )
}
