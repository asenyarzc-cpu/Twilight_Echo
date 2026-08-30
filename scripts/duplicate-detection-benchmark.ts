import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  detectDuplicates,
  type DuplicateCandidate
} from '../src/main/library/duplicateDetection.ts'

export const DUPLICATE_BENCHMARK_ROWS = 10_000
export const DUPLICATE_BENCHMARK_WARMUP_ITERATIONS = 3
export const DUPLICATE_BENCHMARK_ITERATIONS = 20
export const DUPLICATE_BENCHMARK_UNIQUE_P95_BUDGET_MS = 1_500
export const DUPLICATE_BENCHMARK_COLLISION_P95_BUDGET_MS = 2_500

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BENCHMARK_SOURCE_PATH = 'src/main/library/duplicateDetection.ts'
const BENCHMARK_SHARED_CONTRACT_PATH = 'src/shared/duplicateDetection.ts'
const BENCHMARK_RUNNER_PATH = 'scripts/duplicate-detection-benchmark.ts'
const BENCHMARK_RUNNER_CONTRACT_PATH = 'scripts/duplicate-detection-benchmark.test.ts'
const BENCHMARK_PACKAGE_PATH = 'package.json'
const BENCHMARK_LOCKFILE_PATH = 'pnpm-lock.yaml'

export interface DuplicateDetectionBenchmarkScenario {
  rows: number
  groups: number
  groupsByEvidence: Record<string, number>
  hashUnavailableIds: number
  elapsedMs: number[]
  p50Ms: number
  p95Ms: number
  heapDeltaBytes: number
}

export interface DuplicateDetectionBenchmarkResult {
  schemaVersion: 2
  generatedAt: string
  node: string
  platform: string
  rows: number
  warmupIterations: number
  iterations: number
  budgets: { uniqueP95Ms: number; collisionP95Ms: number }
  provenance: DuplicateDetectionBenchmarkProvenance
  scenarios: {
    unique: DuplicateDetectionBenchmarkScenario
    collision: DuplicateDetectionBenchmarkScenario
  }
}

export interface DuplicateDetectionBenchmarkProvenance {
  algorithm: 'sha256'
  source: { path: string; sha256: string }
  sharedContract: { path: string; sha256: string }
  runner: { path: string; sha256: string }
  runnerContract: { path: string; sha256: string }
  packageManifest: { path: string; sha256: string }
  lockfile: { path: string; sha256: string }
}

export interface DuplicateDetectionBenchmarkManifest {
  schemaVersion: 1
  generatedAt: string
  evidence: { path: string; sha256: string }
  provenance: DuplicateDetectionBenchmarkProvenance
  benchmark: {
    rows: number
    warmupIterations: number
    iterations: number
    budgets: DuplicateDetectionBenchmarkResult['budgets']
    unique: { p50Ms: number; p95Ms: number }
    collision: { p50Ms: number; p95Ms: number }
  }
}

export async function runDuplicateDetectionBenchmark(
  options: {
    rows?: number
    warmupIterations?: number
    iterations?: number
  } = {}
): Promise<DuplicateDetectionBenchmarkResult> {
  const rows = options.rows ?? DUPLICATE_BENCHMARK_ROWS
  const warmupIterations = options.warmupIterations ?? DUPLICATE_BENCHMARK_WARMUP_ITERATIONS
  const iterations = options.iterations ?? DUPLICATE_BENCHMARK_ITERATIONS
  if (!Number.isSafeInteger(rows) || rows < 10 || rows % 10 !== 0) {
    throw new Error('Duplicate detection benchmark rows must be a multiple of 10 and at least 10')
  }
  if (!Number.isSafeInteger(warmupIterations) || warmupIterations < 0 || warmupIterations > 10) {
    throw new Error('Duplicate detection benchmark warmup iterations must be between 0 and 10')
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 50) {
    throw new Error('Duplicate detection benchmark iterations must be between 1 and 50')
  }

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    rows,
    warmupIterations,
    iterations,
    budgets: {
      uniqueP95Ms: DUPLICATE_BENCHMARK_UNIQUE_P95_BUDGET_MS,
      collisionP95Ms: DUPLICATE_BENCHMARK_COLLISION_P95_BUDGET_MS
    },
    provenance: await collectDuplicateDetectionBenchmarkProvenance(),
    scenarios: {
      unique: await runScenario(buildUniqueRows(rows), warmupIterations, iterations),
      collision: await runScenario(buildCollisionRows(rows), warmupIterations, iterations)
    }
  }
}

export function buildUniqueRows(rows: number): DuplicateCandidate[] {
  return Array.from({ length: rows }, (_, index) =>
    candidate(`unique-${index}`, {
      filePath: `E:/benchmark/unique-${index}.wav`,
      title: `Unique ${index}`,
      artist: `Artist ${index}`,
      album: `Album ${index}`,
      duration: 60 + index,
      size: 1_000 + index,
      sampleRate: 44_100 + index,
      bitrate: 1_000 + index
    })
  )
}

export function buildCollisionRows(rows: number): DuplicateCandidate[] {
  const perEvidence = rows / 10
  const result: DuplicateCandidate[] = []
  for (let index = 0; index < perEvidence; index++) {
    const pair = `path-${index}`
    result.push(
      candidate(`${pair}-a`, {
        filePath: `E:/benchmark/path/${index}.wav`,
        duration: 61 + index,
        size: 10_000 + index
      }),
      candidate(`${pair}-b`, {
        filePath: `E:/benchmark/path/${index}.WAV`,
        duration: 62 + index,
        size: 11_000 + index
      })
    )
  }
  for (let index = 0; index < perEvidence; index++) {
    // Prefix with zeroes so values such as `a` and `aa` cannot collapse into the same
    // all-`a` 64-character string. Each pair is one intentional content-hash collision only.
    const hash = index.toString(16).padStart(64, '0')
    result.push(
      candidate(`hash-${index}-a`, {
        filePath: `E:/benchmark/hash/${index}-a.wav`,
        duration: 71 + index,
        size: 20_000 + index,
        contentHash: hash
      }),
      candidate(`hash-${index}-b`, {
        filePath: `E:/benchmark/hash/${index}-b.wav`,
        duration: 72 + index,
        size: 20_000 + index,
        contentHash: hash
      })
    )
  }
  for (let index = 0; index < perEvidence; index++) {
    result.push(
      candidate(`acoustic-${index}-a`, {
        filePath: `E:/benchmark/acoustic/${index}-a.wav`,
        duration: 81 + index,
        size: 30_000 + index,
        audioFingerprint: {
          algorithm: 'chromaprint-v1',
          value: `fp-${index}`,
          evidence: 'verifiedAcoustic'
        }
      }),
      candidate(`acoustic-${index}-b`, {
        filePath: `E:/benchmark/acoustic/${index}-b.wav`,
        duration: 82 + index,
        size: 31_000 + index,
        audioFingerprint: {
          algorithm: 'chromaprint-v1',
          value: `fp-${index}`,
          evidence: 'verifiedAcoustic'
        }
      })
    )
  }
  for (let index = 0; index < perEvidence; index++) {
    result.push(
      candidate(`metadata-${index}-a`, {
        filePath: `E:/benchmark/metadata/${index}-a.wav`,
        title: `Metadata A ${index}`,
        artist: `Metadata Artist A ${index}`,
        album: `Metadata Album A ${index}`,
        duration: 91 + index,
        size: 40_000 + index
      }),
      candidate(`metadata-${index}-b`, {
        filePath: `E:/benchmark/metadata/${index}-b.wav`,
        title: `Metadata B ${index}`,
        artist: `Metadata Artist B ${index}`,
        album: `Metadata Album B ${index}`,
        duration: 91 + index,
        size: 40_000 + index
      })
    )
  }
  for (let index = 0; index < perEvidence; index++) {
    result.push(
      candidate(`logical-${index}-a`, {
        filePath: `E:/benchmark/logical/${index}-a.wav`,
        title: `Logical ${index}`,
        artist: `Logical Artist ${index}`,
        album: `Logical Album ${index}`,
        duration: 101 + index,
        size: 50_000 + index,
        sampleRate: 44_100,
        bitrate: 1_001
      }),
      candidate(`logical-${index}-b`, {
        filePath: `E:/benchmark/logical/${index}-b.wav`,
        title: ` logical  ${index} `,
        artist: `LOGICAL artist ${index}`,
        album: `logical album ${index}`,
        duration: 101.1 + index,
        size: 51_000 + index,
        sampleRate: 48_000,
        bitrate: 1_002
      })
    )
  }
  return result
}

async function runScenario(
  candidates: DuplicateCandidate[],
  warmupIterations: number,
  iterations: number
): Promise<DuplicateDetectionBenchmarkScenario> {
  const elapsedMs: number[] = []
  let groups = 0
  let groupsByEvidence: Record<string, number> = {}
  let hashUnavailableIds = 0
  const heapBefore = process.memoryUsage().heapUsed
  for (let index = 0; index < warmupIterations + iterations; index++) {
    forceGc()
    const started = performance.now()
    const result = await detectDuplicates(candidates, {
      contentHashForPath: async (filePath) => deterministicHash(filePath)
    })
    const elapsed = performance.now() - started
    if (index >= warmupIterations) elapsedMs.push(elapsed)
    groups = result.groups.length
    groupsByEvidence = countByEvidence(result)
    hashUnavailableIds = result.contentHashUnavailableIds.length
  }
  forceGc()
  return {
    rows: candidates.length,
    groups,
    groupsByEvidence,
    hashUnavailableIds,
    elapsedMs,
    p50Ms: percentile(elapsedMs, 0.5),
    p95Ms: percentile(elapsedMs, 0.95),
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore
  }
}

function candidate(id: string, overrides: Partial<DuplicateCandidate>): DuplicateCandidate {
  return {
    id,
    filePath: `E:/benchmark/${id}.wav`,
    title: id,
    artist: id,
    album: id,
    duration: 180,
    size: 1,
    sampleRate: 44_100,
    bitrate: 1_000,
    format: 'wav',
    ...overrides
  }
}

function deterministicHash(filePath: string): string {
  let value = 0
  for (const char of filePath) value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value.toString(16).padStart(64, '0')
}

function countByEvidence(
  result: Awaited<ReturnType<typeof detectDuplicates>>
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const group of result.groups) counts[group.kind] = (counts[group.kind] ?? 0) + 1
  return counts
}

function forceGc(): void {
  ;(globalThis as { gc?: () => void }).gc?.()
}

export function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new Error('Cannot calculate a percentile without samples')
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error('Percentile quantile must be in the range (0, 1]')
  }
  const ordered = [...samples].sort((left, right) => left - right)
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)
  return ordered[index]
}

export async function collectDuplicateDetectionBenchmarkProvenance(): Promise<DuplicateDetectionBenchmarkProvenance> {
  const entry = async (path: string): Promise<{ path: string; sha256: string }> => ({
    path,
    sha256: sha256(canonicalizeProvenanceBytes(await readFile(resolve(REPOSITORY_ROOT, path))))
  })
  return {
    algorithm: 'sha256',
    source: await entry(BENCHMARK_SOURCE_PATH),
    sharedContract: await entry(BENCHMARK_SHARED_CONTRACT_PATH),
    runner: await entry(BENCHMARK_RUNNER_PATH),
    runnerContract: await entry(BENCHMARK_RUNNER_CONTRACT_PATH),
    packageManifest: await entry(BENCHMARK_PACKAGE_PATH),
    lockfile: await entry(BENCHMARK_LOCKFILE_PATH)
  }
}

export function assertDuplicateBenchmarkWithinBudget(
  result: DuplicateDetectionBenchmarkResult
): void {
  if (
    result.scenarios.unique.p95Ms > result.budgets.uniqueP95Ms ||
    result.scenarios.collision.p95Ms > result.budgets.collisionP95Ms
  ) {
    throw new Error(
      `Duplicate detection benchmark exceeded its p95 budget: unique=${result.scenarios.unique.p95Ms.toFixed(2)}ms, collision=${result.scenarios.collision.p95Ms.toFixed(2)}ms`
    )
  }
}

export function createDuplicateBenchmarkManifest(
  result: DuplicateDetectionBenchmarkResult,
  evidencePath: string,
  evidenceBytes: Uint8Array
): DuplicateDetectionBenchmarkManifest {
  return {
    schemaVersion: 1,
    generatedAt: result.generatedAt,
    evidence: { path: evidencePath.replace(/\\/g, '/'), sha256: sha256(evidenceBytes) },
    provenance: result.provenance,
    benchmark: {
      rows: result.rows,
      warmupIterations: result.warmupIterations,
      iterations: result.iterations,
      budgets: result.budgets,
      unique: {
        p50Ms: result.scenarios.unique.p50Ms,
        p95Ms: result.scenarios.unique.p95Ms
      },
      collision: {
        p50Ms: result.scenarios.collision.p50Ms,
        p95Ms: result.scenarios.collision.p95Ms
      }
    }
  }
}

export function canonicalizeProvenanceBytes(value: Uint8Array): Uint8Array {
  if (value.indexOf(0x0d) === -1) return value

  const normalized: number[] = []
  for (let index = 0; index < value.length; index++) {
    const byte = value[index]
    if (byte === 0x0d && value[index + 1] === 0x0a) continue
    normalized.push(byte)
  }
  return Uint8Array.from(normalized)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function parseDuplicateBenchmarkCli(argv: string[]): {
  output: string | null
  manifest: string | null
} {
  let output: string | null = null
  let manifest: string | null = null
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]
    if (option === '--') continue
    if (option !== '--output' && option !== '--manifest') {
      throw new Error(`Unknown duplicate benchmark option: ${option}`)
    }
    const value = argv[++index]
    if (!value) throw new Error(`Duplicate benchmark ${option} requires a file path`)
    if (option === '--output') output = resolve(value)
    else manifest = resolve(value)
  }
  if (manifest && !output) throw new Error('Duplicate benchmark --manifest requires --output')
  return { output, manifest }
}

async function main(): Promise<void> {
  const { output, manifest } = parseDuplicateBenchmarkCli(process.argv.slice(2))
  const result = await runDuplicateDetectionBenchmark()
  assertDuplicateBenchmarkWithinBudget(result)
  const json = `${JSON.stringify(result, null, 2)}\n`
  if (output) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, json, 'utf8')
  }
  if (manifest && output) {
    const manifestDocument = createDuplicateBenchmarkManifest(
      result,
      basename(output),
      Buffer.from(json)
    )
    await mkdir(dirname(manifest), { recursive: true })
    await writeFile(manifest, `${JSON.stringify(manifestDocument, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(json)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    process.exitCode = 1
  })
}
