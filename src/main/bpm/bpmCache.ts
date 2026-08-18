import { existsSync } from 'fs'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { isDeepStrictEqual } from 'util'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import type { BpmAnalysisResult, BpmTempoSegment } from '../../shared/audioEngineTypes.ts'

export type { BpmAnalysisResult, BpmTempoSegment }

export const BPM_ANALYSIS_ALGORITHM_VERSION = 1

export interface BpmAnalysisCacheIdentity {
  filePath: string
  size: number
  mtimeMs: number
  algorithmVersion?: number
}

interface BpmAnalysisCacheFile {
  version: 1
  entries: Record<string, BpmAnalysisResult>
}

export function buildBpmAnalysisCacheKey(identity: BpmAnalysisCacheIdentity): string {
  const algorithmVersion = identity.algorithmVersion ?? BPM_ANALYSIS_ALGORITHM_VERSION
  return [
    identity.filePath.toLowerCase(),
    Math.floor(identity.size),
    Math.floor(identity.mtimeMs),
    algorithmVersion
  ].join('|')
}

export class BpmAnalysisCache {
  private readonly cachePath: string
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(cachePath: string) {
    this.cachePath = cachePath
  }

  async get(identity: BpmAnalysisCacheIdentity): Promise<BpmAnalysisResult | null> {
    await this.mutationTail
    const file = await this.read()
    const result = file.entries[buildBpmAnalysisCacheKey(identity)]
    return isBpmAnalysisResult(result) ? result : null
  }

  async set(identity: BpmAnalysisCacheIdentity, analysis: BpmAnalysisResult): Promise<void> {
    await this.enqueueMutation(async () => {
      const file = await this.read()
      file.entries[buildBpmAnalysisCacheKey(identity)] = analysis
      await this.write(file)
    })
  }

  async deleteIfMatches(
    identity: BpmAnalysisCacheIdentity,
    analysis: BpmAnalysisResult
  ): Promise<boolean> {
    return await this.enqueueMutation(async () => {
      const file = await this.read()
      const key = buildBpmAnalysisCacheKey(identity)
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

  async clear(): Promise<number> {
    await rm(this.cachePath, { force: true })
    return 0
  }

  private async read(): Promise<BpmAnalysisCacheFile> {
    if (!existsSync(this.cachePath)) return { version: 1, entries: {} }
    try {
      const parsed = tryParseJsonWithNestingLimit(await readFile(this.cachePath, 'utf-8'))
      if (!parsed.ok || !isBpmAnalysisCacheFile(parsed.value)) {
        return { version: 1, entries: {} }
      }
      return parsed.value
    } catch {
      return { version: 1, entries: {} }
    }
  }

  private async write(file: BpmAnalysisCacheFile): Promise<void> {
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

function isBpmAnalysisCacheFile(value: unknown): value is BpmAnalysisCacheFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as Partial<BpmAnalysisCacheFile>
  return (
    file.version === 1 &&
    !!file.entries &&
    typeof file.entries === 'object' &&
    !Array.isArray(file.entries)
  )
}

export function isBpmAnalysisResult(value: unknown): value is BpmAnalysisResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<BpmAnalysisResult>
  return (
    result.source === 'analyzed' &&
    typeof result.bpm === 'number' &&
    Number.isFinite(result.bpm) &&
    typeof result.confidence === 'number' &&
    Number.isFinite(result.confidence) &&
    typeof result.analyzedAt === 'string' &&
    typeof result.algorithmVersion === 'number'
  )
}
