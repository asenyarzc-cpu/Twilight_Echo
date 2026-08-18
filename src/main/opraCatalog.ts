import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { EqualizerBand } from './audioEngineManager.ts'
import { parseJsonWithNestingLimit } from './security/jsonSafety.ts'

export const OPRA_DATABASE_URL = 'https://opra.roonlabs.net/database_v1.jsonl'
const OPRA_ATTRIBUTION_URL = 'https://github.com/opra-project/OPRA'
const REQUEST_TIMEOUT_MS = 30_000
const SEARCH_RESULT_LIMIT = 30

export interface OpraCatalogStatus {
  loaded: boolean
  loading: boolean
  source: 'empty' | 'cache' | 'network'
  cachePath: string
  vendorCount: number
  productCount: number
  profileCount: number
  lastUpdatedAt: string | null
  lastError: string
}

export interface OpraProfile {
  eqId: string
  productId: string
  productName: string
  vendorName: string
  author: string
  details: string
  link: string
  attributionUrl: string
  preampDb: number
  bands: EqualizerBand[]
  applicable: boolean
  unsupportedBandTypes: string[]
}

type OpraLineType = 'vendor' | 'product' | 'eq'

interface OpraLine {
  type?: OpraLineType
  id?: string
  data?: Record<string, unknown>
}

interface VendorRecord {
  id: string
  name: string
}

interface ProductRecord {
  id: string
  name: string
  vendorId: string
}

interface EqRecord {
  id: string
  productId: string
  author: string
  details: string
  link: string
  preampDb: number
  bands: EqualizerBand[]
  unsupportedBandTypes: string[]
}

interface ParsedCatalog {
  vendors: Map<string, VendorRecord>
  products: Map<string, ProductRecord>
  eqs: Map<string, EqRecord>
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function mapOpraBandType(value: string): EqualizerBand['filterType'] | null {
  if (value === 'peak_dip') return 'peak'
  if (value === 'low_shelf') return 'lowShelf'
  if (value === 'high_shelf') return 'highShelf'
  return null
}

function parseEqBands(rawBands: unknown): {
  bands: EqualizerBand[]
  unsupportedBandTypes: string[]
} {
  const unsupported = new Set<string>()
  if (!Array.isArray(rawBands)) return { bands: [], unsupportedBandTypes: [] }

  const bands = rawBands
    .map((raw): EqualizerBand | null => {
      if (!raw || typeof raw !== 'object') return null
      const band = raw as Record<string, unknown>
      const rawType = readString(band.type)
      const filterType = mapOpraBandType(rawType)
      if (!filterType) {
        if (rawType) unsupported.add(rawType)
        return null
      }
      const frequency = readNumber(band.frequency, NaN)
      const gain = readNumber(band.gain_db, NaN)
      const q = readNumber(band.q, NaN)
      if (!Number.isFinite(frequency) || !Number.isFinite(gain) || !Number.isFinite(q)) {
        return null
      }
      return { frequency, gain, q, filterType }
    })
    .filter((band): band is EqualizerBand => Boolean(band))

  return { bands, unsupportedBandTypes: [...unsupported].sort() }
}

function parseCatalogText(text: string): ParsedCatalog {
  const vendors = new Map<string, VendorRecord>()
  const products = new Map<string, ProductRecord>()
  const eqs = new Map<string, EqRecord>()

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let record: OpraLine
    try {
      record = parseJsonWithNestingLimit(trimmed) as OpraLine
    } catch {
      continue
    }

    const id = readString(record.id)
    const data = record.data
    if (!id || !data || typeof data !== 'object') continue

    if (record.type === 'vendor') {
      vendors.set(id, {
        id,
        name: readString(data.name) || id
      })
      continue
    }

    if (record.type === 'product') {
      const vendorId = readString(data.vendor_id)
      products.set(id, {
        id,
        name: readString(data.name) || id,
        vendorId
      })
      continue
    }

    if (record.type === 'eq') {
      const parameters =
        data.parameters && typeof data.parameters === 'object'
          ? (data.parameters as Record<string, unknown>)
          : {}
      const { bands, unsupportedBandTypes } = parseEqBands(parameters.bands)
      eqs.set(id, {
        id,
        productId: readString(data.product_id),
        author: readString(data.author),
        details: readString(data.details),
        link: readString(data.link),
        preampDb: readNumber(parameters.gain_db, 0),
        bands,
        unsupportedBandTypes
      })
    }
  }

  return { vendors, products, eqs }
}

export function parseOpraCatalogForTest(text: string): OpraCatalog {
  return OpraCatalog.fromText(text, '')
}

export class OpraCatalog {
  private readonly cachePath: string
  private vendors = new Map<string, VendorRecord>()
  private products = new Map<string, ProductRecord>()
  private eqs = new Map<string, EqRecord>()
  private source: OpraCatalogStatus['source'] = 'empty'
  private lastUpdatedAt: string | null = null
  private lastError = ''
  private loadingPromise: Promise<OpraCatalogStatus> | null = null
  private cacheLoadingPromise: Promise<OpraCatalogStatus> | null = null

  constructor(cachePath: string) {
    this.cachePath = cachePath
  }

  static fromText(text: string, cachePath: string): OpraCatalog {
    const catalog = new OpraCatalog(cachePath)
    catalog.applyParsedCatalog(parseCatalogText(text), 'cache')
    return catalog
  }

  getStatus(): OpraCatalogStatus {
    return {
      loaded: this.eqs.size > 0,
      loading: this.loadingPromise !== null || this.cacheLoadingPromise !== null,
      source: this.source,
      cachePath: this.cachePath,
      vendorCount: this.vendors.size,
      productCount: this.products.size,
      profileCount: this.eqs.size,
      lastUpdatedAt: this.lastUpdatedAt,
      lastError: this.lastError
    }
  }

  async loadFromCache(): Promise<OpraCatalogStatus> {
    if (this.eqs.size > 0) return this.getStatus()
    if (this.cacheLoadingPromise) return await this.cacheLoadingPromise
    const loading = this.loadFromCacheInternal()
    this.cacheLoadingPromise = loading
    try {
      return await loading
    } finally {
      if (this.cacheLoadingPromise === loading) this.cacheLoadingPromise = null
    }
  }

  private async loadFromCacheInternal(): Promise<OpraCatalogStatus> {
    if (!this.cachePath || !existsSync(this.cachePath)) {
      this.lastError = 'OPRA cache is not available'
      return this.getStatus()
    }

    try {
      const text = await readFile(this.cachePath, 'utf-8')
      this.applyParsedCatalog(parseCatalogText(text), 'cache')
      this.lastError = ''
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
    }
    return this.getStatus()
  }

  async refresh(): Promise<OpraCatalogStatus> {
    if (this.loadingPromise) return this.loadingPromise
    this.loadingPromise = this.refreshInternal().finally(() => {
      this.loadingPromise = null
    })
    return this.loadingPromise
  }

  async search(query: string): Promise<OpraProfile[]> {
    await this.ensureCacheLoaded()
    const normalizedQuery = normalizeSearchText(query)
    if (!normalizedQuery) return []
    const terms = normalizedQuery.split(/\s+/).filter(Boolean)
    const results: OpraProfile[] = []

    for (const eq of this.eqs.values()) {
      const product = this.products.get(eq.productId)
      const vendor = product ? this.vendors.get(product.vendorId) : undefined
      const productName = product?.name || eq.productId
      const vendorName = vendor?.name || product?.vendorId || ''
      const haystack = normalizeSearchText(
        `${vendorName} ${productName} ${eq.author} ${eq.details} ${eq.id}`
      )
      if (!terms.every((term) => haystack.includes(term))) continue
      results.push(this.toProfile(eq))
      if (results.length >= SEARCH_RESULT_LIMIT) break
    }

    return results
  }

  async getProfile(eqId: string): Promise<OpraProfile | null> {
    await this.ensureCacheLoaded()
    const eq = this.eqs.get(eqId)
    return eq ? this.toProfile(eq) : null
  }

  private async ensureCacheLoaded(): Promise<void> {
    if (this.eqs.size > 0) return
    await this.loadFromCache()
  }

  private async refreshInternal(): Promise<OpraCatalogStatus> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const response = await fetch(OPRA_DATABASE_URL, { signal: controller.signal })
      clearTimeout(timeout)
      if (!response.ok) {
        throw new Error(`OPRA download failed: ${response.status} ${response.statusText}`)
      }
      const text = await response.text()
      const parsed = parseCatalogText(text)
      if (parsed.eqs.size === 0) throw new Error('OPRA database did not contain EQ profiles')
      await mkdir(dirname(this.cachePath), { recursive: true })
      await writeFile(this.cachePath, text, 'utf-8')
      this.applyParsedCatalog(parsed, 'network')
      this.lastError = ''
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      if (this.eqs.size === 0) await this.loadFromCache()
    }
    return this.getStatus()
  }

  private applyParsedCatalog(parsed: ParsedCatalog, source: OpraCatalogStatus['source']): void {
    this.vendors = parsed.vendors
    this.products = parsed.products
    this.eqs = parsed.eqs
    this.source = source
    this.lastUpdatedAt = new Date().toISOString()
  }

  private toProfile(eq: EqRecord): OpraProfile {
    const product = this.products.get(eq.productId)
    const vendor = product ? this.vendors.get(product.vendorId) : undefined
    return {
      eqId: eq.id,
      productId: eq.productId,
      productName: product?.name || eq.productId,
      vendorName: vendor?.name || product?.vendorId || '',
      author: eq.author || 'Unknown',
      details: eq.details,
      link: eq.link || OPRA_ATTRIBUTION_URL,
      attributionUrl: OPRA_ATTRIBUTION_URL,
      preampDb: eq.preampDb,
      bands: eq.bands.map((band) => ({ ...band })),
      applicable: eq.unsupportedBandTypes.length === 0 && eq.bands.length > 0,
      unsupportedBandTypes: [...eq.unsupportedBandTypes]
    }
  }
}
