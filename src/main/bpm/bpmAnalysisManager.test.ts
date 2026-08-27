import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BPM_ANALYSIS_ALGORITHM_VERSION,
  BpmAnalysisCache,
  type BpmAnalysisCacheIdentity,
  type BpmAnalysisResult
} from './bpmCache.ts'
import { BpmAnalysisManager } from './bpmAnalysisManager.ts'

class DeferredBpmCache extends BpmAnalysisCache {
  readonly committed: Promise<void>
  private resolveCommitted: () => void = () => undefined
  private readonly releaseGate: Promise<void>
  private releaseGateResolve: () => void = () => undefined

  constructor(cachePath: string) {
    super(cachePath)
    this.committed = new Promise((resolve) => {
      this.resolveCommitted = resolve
    })
    this.releaseGate = new Promise((resolve) => {
      this.releaseGateResolve = resolve
    })
  }

  override async set(
    identity: BpmAnalysisCacheIdentity,
    analysis: BpmAnalysisResult
  ): Promise<void> {
    await super.set(identity, analysis)
    this.resolveCommitted()
    await this.releaseGate
  }

  release(): void {
    this.releaseGateResolve()
  }
}

test('BpmAnalysisManager skips remote URLs', async () => {
  const manager = new BpmAnalysisManager({
    cache: new BpmAnalysisCache(join(tmpdir(), `bpm-skip-${Date.now()}.json`)),
    analyzeFile: async () => {
      throw new Error('should not analyze remote URLs')
    }
  })

  const result = await manager.requestAnalysis({
    trackId: 'ncm:1',
    filePath: 'https://example.test/audio.flac',
    referenceBpm: 200
  })

  assert.equal(result.status, 'skipped')
})

test('BpmAnalysisManager deduplicates concurrent file analysis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-manager-'))
  const filePath = join(dir, 'song.wav')
  await writeFile(filePath, 'fake', 'utf-8')
  let analyzeCount = 0
  const manager = new BpmAnalysisManager({
    cache: new BpmAnalysisCache(join(dir, 'bpm-analysis-cache.json')),
    analyzeFile: async () => {
      analyzeCount += 1
      return {
        bpm: 200,
        confidence: 0.9,
        source: 'analyzed',
        analyzedAt: '2026-01-01T00:00:00.000Z',
        algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
      }
    }
  })

  const [first, second] = await Promise.all([
    manager.requestAnalysis({ trackId: 'local:1', filePath }),
    manager.requestAnalysis({ trackId: 'local:1', filePath })
  ])

  assert.equal(first.status, 'completed')
  assert.equal(second.status, 'completed')
  assert.equal(analyzeCount, 1)
  await rm(dir, { recursive: true, force: true })
})

test('BpmAnalysisManager suppresses immediate retries after analysis failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-manager-fail-'))
  const filePath = join(dir, 'song.wav')
  await writeFile(filePath, 'fake', 'utf-8')
  let analyzeCount = 0
  const manager = new BpmAnalysisManager({
    cache: new BpmAnalysisCache(join(dir, 'bpm-analysis-cache.json')),
    failureCooldownMs: 60_000,
    now: () => 1000,
    analyzeFile: async () => {
      analyzeCount += 1
      throw new Error('decode failed')
    }
  })

  assert.equal((await manager.requestAnalysis({ trackId: 'local:1', filePath })).status, 'failed')
  assert.equal((await manager.requestAnalysis({ trackId: 'local:1', filePath })).status, 'skipped')
  assert.equal(analyzeCount, 1)
  await rm(dir, { recursive: true, force: true })
})

test('BpmAnalysisManager cancellation aborts the isolated worker and drops late results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-manager-cancel-'))
  const filePath = join(dir, 'song.wav')
  await writeFile(filePath, 'fake', 'utf-8')
  let releaseAnalyze: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    releaseAnalyze = resolve
  })
  const cancelled: Array<string | undefined> = []
  const manager = new BpmAnalysisManager({
    cache: new BpmAnalysisCache(join(dir, 'bpm-analysis-cache.json')),
    cancelFile: (source) => cancelled.push(source),
    analyzeFile: async () => {
      await gate
      return {
        bpm: 120,
        confidence: 0.9,
        source: 'analyzed',
        analyzedAt: '2026-01-01T00:00:00.000Z',
        algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
      }
    }
  })

  const pending = manager.requestAnalysis({ trackId: 'local:cancel', filePath })
  await new Promise((resolve) => setTimeout(resolve, 10))
  manager.cancel(filePath)
  releaseAnalyze()
  const result = await pending
  assert.deepEqual(cancelled, [filePath])
  assert.deepEqual(result, { status: 'skipped', reason: 'cancelled' })
  assert.equal(
    await manager
      .requestAnalysis({ trackId: 'local:cancel', filePath })
      .then((item) => item.status),
    'completed'
  )
  await rm(dir, { recursive: true, force: true })
})

test('BpmAnalysisManager cancellation during deferred cache commit rolls back without event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-manager-commit-rollback-'))
  const filePath = join(dir, 'song.wav')
  const cache = new DeferredBpmCache(join(dir, 'bpm-analysis-cache.json'))
  await writeFile(filePath, 'fake', 'utf-8')
  const completed: BpmAnalysisResult[] = []
  const manager = new BpmAnalysisManager({
    cache,
    analyzeFile: async () => ({
      bpm: 120,
      confidence: 0.9,
      source: 'analyzed',
      analyzedAt: '2026-01-01T00:00:00.000Z',
      algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
    }),
    onComplete: ({ analysis }) => completed.push(analysis)
  })

  const pending = manager.requestAnalysis({ trackId: 'local:commit-cancel', filePath })
  await cache.committed
  manager.cancel(filePath)
  cache.release()

  assert.deepEqual(await pending, { status: 'skipped', reason: 'cancelled' })
  const fileStat = await stat(filePath)
  assert.equal(
    await cache.get({
      filePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
    }),
    null
  )
  assert.deepEqual(completed, [])
  await rm(dir, { recursive: true, force: true })
})

test('BpmAnalysisManager cancellation during cache commit preserves a newer exact value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-manager-commit-cancel-'))
  const filePath = join(dir, 'song.wav')
  const cachePath = join(dir, 'bpm-analysis-cache.json')
  await writeFile(filePath, 'fake', 'utf-8')
  const fileStat = await stat(filePath)
  const identity = {
    filePath,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  }
  const cancelledValue: BpmAnalysisResult = {
    bpm: 120,
    confidence: 0.9,
    source: 'analyzed',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  }
  const newerValue: BpmAnalysisResult = {
    ...cancelledValue,
    bpm: 128,
    analyzedAt: '2026-01-02T00:00:00.000Z'
  }
  const cache = new DeferredBpmCache(cachePath)
  const completed: BpmAnalysisResult[] = []
  const manager = new BpmAnalysisManager({
    cache,
    analyzeFile: async () => cancelledValue,
    onComplete: ({ analysis }) => completed.push(analysis)
  })

  const pending = manager.requestAnalysis({ trackId: 'local:commit-cancel', filePath })
  await cache.committed
  manager.cancel(filePath)
  await new BpmAnalysisCache(cachePath).set(identity, newerValue)
  cache.release()

  assert.deepEqual(await pending, { status: 'skipped', reason: 'cancelled' })
  assert.deepEqual(await cache.get(identity), newerValue)
  assert.deepEqual(completed, [])
  await rm(dir, { recursive: true, force: true })
})
