import { existsSync } from 'fs'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { isDeepStrictEqual } from 'util'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import type { LoudnessAnalysisResult } from '../../shared/audioEngineTypes.ts'

export type { LoudnessAnalysisResult }

export const LOUDNESS_ANALYSIS_ALGORITHM_VERSION = 1
export const LOUDNORM_DEFAULT_TARGET_LUFS = -23.0
export const LOUDNORM_DEFAULT_TRUE_PEAK_CEILING_DB = -1.0
/** Soft cap on cached identities; oldest analyzedAt entries are evicted first. */
export const LOUDNESS_ANALYSIS_CACHE_MAX_ENTRIES = 512

export interface LoudnessAnalysisCacheIdentity {
  filePath: string
  size: number
  mtimeMs: number
  algorithmVersion?: number
  targetLufs?: number
  truePeakCeilingDb?: number
}

interface LoudnessAnalysisCacheFile {
  version: 1
  entries: Record<string, LoudnessAnalysisResult>
}

export function buildLoudnessAnalysisCacheKey(identity: LoudnessAnalysisCacheIdentity): string {
  const algorithmVersion = identity.algorithmVersion ?? LOUDNESS_ANALYSIS_ALGORITHM_VERSION
  const target = identity.targetLufs ?? LOUDNORM_DEFAULT_TARGET_LUFS
  const ceiling = identity.truePeakCeilingDb ?? LOUDNORM_DEFAULT_TRUE_PEAK_CEILING_DB
  return [
    identity.filePath.toLowerCase(),
    Math.floor(identity.size),
    Math.floor(identity.mtimeMs),
    algorithmVersion,
    target.toFixed(2),
    ceiling.toFixed(2)
  ].join('|')
}

export class LoudnessAnalysisCache {
  private readonly cachePath: string
  private readonly maxEntries: number
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(cachePath: string, maxEntries = LOUDNESS_ANALYSIS_CACHE_MAX_ENTRIES) {
    this.cachePath = cachePath
    this.maxEntries = Math.max(1, maxEntries)
  }

  async get(identity: LoudnessAnalysisCacheIdentity): Promise<LoudnessAnalysisResult | null> {
    await this.mutationTail
    const file = await this.read()
    const result = file.entries[buildLoudnessAnalysisCacheKey(identity)]
    return isLoudnessAnalysisResult(result) ? result : null
  }

  async set(
    identity: LoudnessAnalysisCacheIdentity,
    analysis: LoudnessAnalysisResult
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      const file = await this.read()
      file.entries[buildLoudnessAnalysisCacheKey(identity)] = analysis
      pruneLoudnessCacheEntries(file.entries, this.maxEntries)
      await this.write(file)
    })
  }

  async deleteIfMatches(
    identity: LoudnessAnalysisCacheIdentity,
    analysis: LoudnessAnalysisResult
  ): Promise<boolean> {
    return await this.enqueueMutation(async () => {
      const file = await this.read()
      const key = buildLoudnessAnalysisCacheKey(identity)
      if (!isDeepStrictEqual(file.entries[key], analysis)) return false
      delete file.entries[key]
      await this.write(file)
      return true
    })
  }

  async getSize(): Promise<number> {
    try {
      return (await stat(this.cachePath)).size
    } catch {
      return 0
    }
  }

  async getEntryCount(): Promise<number> {
    const file = await this.read()
    return Object.keys(file.entries).length
  }

  async clear(): Promise<number> {
    await rm(this.cachePath, { force: true })
    return 0
  }

  private async read(): Promise<LoudnessAnalysisCacheFile> {
    if (!existsSync(this.cachePath)) return { version: 1, entries: {} }
    try {
      const parsed = tryParseJsonWithNestingLimit(await readFile(this.cachePath, 'utf-8'))
      if (!parsed.ok || !isLoudnessAnalysisCacheFile(parsed.value)) {
        return { version: 1, entries: {} }
      }
      return parsed.value
    } catch {
      return { version: 1, entries: {} }
    }
  }

  private async write(file: LoudnessAnalysisCacheFile): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeFile(this.cachePath, JSON.stringify(file), 'utf-8')
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function isLoudnessAnalysisCacheFile(value: unknown): value is LoudnessAnalysisCacheFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as Partial<LoudnessAnalysisCacheFile>
  return (
    file.version === 1 &&
    !!file.entries &&
    typeof file.entries === 'object' &&
    !Array.isArray(file.entries)
  )
}

/** Evict oldest analyzedAt entries until at or under maxEntries. */
export function pruneLoudnessCacheEntries(
  entries: Record<string, LoudnessAnalysisResult>,
  maxEntries: number
): void {
  const keys = Object.keys(entries)
  if (keys.length <= maxEntries) return
  const ordered = keys.sort((a, b) => {
    const aAt = Date.parse(entries[a]?.analyzedAt ?? '') || 0
    const bAt = Date.parse(entries[b]?.analyzedAt ?? '') || 0
    return aAt - bAt
  })
  const removeCount = keys.length - maxEntries
  for (let i = 0; i < removeCount; i += 1) {
    delete entries[ordered[i]!]
  }
}

export function isLoudnessAnalysisResult(value: unknown): value is LoudnessAnalysisResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<LoudnessAnalysisResult>
  return (
    result.source === 'analyzed' &&
    typeof result.integratedLufs === 'number' &&
    Number.isFinite(result.integratedLufs) &&
    typeof result.truePeakDb === 'number' &&
    Number.isFinite(result.truePeakDb) &&
    typeof result.analyzedAt === 'string' &&
    typeof result.algorithmVersion === 'number'
  )
}
