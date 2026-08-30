import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BPM_ANALYSIS_ALGORITHM_VERSION,
  BpmAnalysisCache,
  buildBpmAnalysisCacheKey,
  type BpmAnalysisResult
} from './bpmCache.ts'

function deeplyNestedValue(depth = 128): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

test('BPM cache key changes when file identity or algorithm changes', () => {
  const base = {
    filePath: 'D:\\Music\\song.flac',
    size: 123,
    mtimeMs: 456,
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  }

  assert.notEqual(buildBpmAnalysisCacheKey(base), buildBpmAnalysisCacheKey({ ...base, size: 124 }))
  assert.notEqual(
    buildBpmAnalysisCacheKey(base),
    buildBpmAnalysisCacheKey({ ...base, mtimeMs: 789 })
  )
  assert.notEqual(
    buildBpmAnalysisCacheKey(base),
    buildBpmAnalysisCacheKey({ ...base, algorithmVersion: base.algorithmVersion + 1 })
  )
})

test('BPM cache persists and invalidates stale entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-cache-'))
  const cachePath = join(dir, 'bpm-analysis-cache.json')
  const cache = new BpmAnalysisCache(cachePath)
  const identity = {
    filePath: 'D:\\Music\\song.flac',
    size: 123,
    mtimeMs: 456,
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  }
  const analysis = {
    bpm: 200,
    confidence: 0.9,
    source: 'analyzed' as const,
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  }

  await cache.set(identity, analysis)
  assert.deepEqual(await cache.get(identity), analysis)
  assert.equal(await cache.get({ ...identity, size: 999 }), null)

  const raw = JSON.parse(await readFile(cachePath, 'utf-8')) as { entries: Record<string, unknown> }
  assert.equal(Object.keys(raw.entries).length, 1)

  await writeFile(cachePath, '{not-json', 'utf-8')
  assert.equal(await cache.get(identity), null)
  await rm(dir, { recursive: true, force: true })
})

test('BPM cache reports size and can be cleared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-cache-'))
  const cachePath = join(dir, 'bpm-analysis-cache.json')
  const cache = new BpmAnalysisCache(cachePath)
  const identity = {
    filePath: 'D:\\Music\\song.flac',
    size: 123,
    mtimeMs: 456,
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  }

  assert.equal(await cache.getSize(), 0)
  await cache.set(identity, {
    bpm: 128,
    confidence: 0.8,
    source: 'analyzed',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  })
  assert.ok((await cache.getSize()) > 0)
  assert.equal(await cache.clear(), 0)
  assert.equal(await cache.getSize(), 0)

  await rm(dir, { recursive: true, force: true })
})

test('BPM cache conditional rollback deletes only the exact committed analysis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-cache-rollback-'))
  const cache = new BpmAnalysisCache(join(dir, 'bpm-analysis-cache.json'))
  const identity = {
    filePath: 'D:\\Music\\song.flac',
    size: 123,
    mtimeMs: 456,
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  }
  const original: BpmAnalysisResult = {
    bpm: 120,
    confidence: 0.9,
    source: 'analyzed',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
  }
  const newer = { ...original, bpm: 128, analyzedAt: '2026-01-02T00:00:00.000Z' }

  await cache.set(identity, newer)
  assert.equal(await cache.deleteIfMatches(identity, original), false)
  assert.deepEqual(await cache.get(identity), newer)
  assert.equal(await cache.deleteIfMatches(identity, newer), true)
  assert.equal(await cache.get(identity), null)

  await rm(dir, { recursive: true, force: true })
})

test('BPM cache rejects a valid-looking document with excessive unknown nesting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-bpm-cache-deep-'))
  try {
    const cachePath = join(dir, 'bpm-analysis-cache.json')
    const cache = new BpmAnalysisCache(cachePath)
    const identity = {
      filePath: 'D:\\Music\\song.flac',
      size: 123,
      mtimeMs: 456,
      algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
    }
    const analysis: BpmAnalysisResult = {
      bpm: 128,
      confidence: 0.9,
      source: 'analyzed',
      analyzedAt: '2026-01-01T00:00:00.000Z',
      algorithmVersion: BPM_ANALYSIS_ALGORITHM_VERSION
    }

    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: { [buildBpmAnalysisCacheKey(identity)]: analysis },
        padding: deeplyNestedValue()
      }),
      'utf-8'
    )

    assert.equal(await cache.get(identity), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
