import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LOUDNESS_ANALYSIS_ALGORITHM_VERSION,
  LOUDNORM_DEFAULT_TARGET_LUFS,
  LOUDNORM_DEFAULT_TRUE_PEAK_CEILING_DB,
  LoudnessAnalysisCache,
  buildLoudnessAnalysisCacheKey,
  pruneLoudnessCacheEntries,
  type LoudnessAnalysisResult
} from './loudnessCache.ts'

function deeplyNestedValue(depth = 128): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < depth; index += 1) value = [value]
  return value
}

test('loudness cache key changes when file identity, algorithm, or targets change', () => {
  const base = {
    filePath: 'D:\\Music\\song.flac',
    size: 123,
    mtimeMs: 456,
    algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION,
    targetLufs: LOUDNORM_DEFAULT_TARGET_LUFS,
    truePeakCeilingDb: LOUDNORM_DEFAULT_TRUE_PEAK_CEILING_DB
  }

  assert.notEqual(
    buildLoudnessAnalysisCacheKey(base),
    buildLoudnessAnalysisCacheKey({ ...base, size: 124 })
  )
  assert.notEqual(
    buildLoudnessAnalysisCacheKey(base),
    buildLoudnessAnalysisCacheKey({ ...base, mtimeMs: 789 })
  )
  assert.notEqual(
    buildLoudnessAnalysisCacheKey(base),
    buildLoudnessAnalysisCacheKey({ ...base, algorithmVersion: base.algorithmVersion + 1 })
  )
  assert.notEqual(
    buildLoudnessAnalysisCacheKey(base),
    buildLoudnessAnalysisCacheKey({ ...base, targetLufs: -16 })
  )
})

test('loudness cache persists and invalidates stale entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-loudness-cache-'))
  const cachePath = join(dir, 'loudness-analysis-cache.json')
  const cache = new LoudnessAnalysisCache(cachePath)
  const identity = {
    filePath: 'D:\\Music\\song.flac',
    size: 123,
    mtimeMs: 456,
    algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
  }
  const analysis = {
    integratedLufs: -14.2,
    truePeakDb: -1.1,
    source: 'analyzed' as const,
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
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

test('loudness cache reports size and can be cleared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-loudness-cache-clear-'))
  const cachePath = join(dir, 'loudness-analysis-cache.json')
  const cache = new LoudnessAnalysisCache(cachePath)
  const identity = {
    filePath: 'D:\\Music\\song.flac',
    size: 123,
    mtimeMs: 456,
    algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
  }

  assert.equal(await cache.getSize(), 0)
  await cache.set(identity, {
    integratedLufs: -18,
    truePeakDb: -2,
    source: 'analyzed',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
  })
  assert.ok((await cache.getSize()) > 0)
  await cache.clear()
  assert.equal(await cache.get(identity), null)
  await rm(dir, { recursive: true, force: true })
})

test('loudness cache conditional rollback deletes only the exact committed analysis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-loudness-cache-rollback-'))
  const cache = new LoudnessAnalysisCache(join(dir, 'loudness-analysis-cache.json'))
  const identity = {
    filePath: 'D:\\Music\\song.flac',
    size: 123,
    mtimeMs: 456,
    algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
  }
  const original: LoudnessAnalysisResult = {
    integratedLufs: -18,
    truePeakDb: -2,
    source: 'analyzed',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
  }
  const newer = {
    ...original,
    integratedLufs: -14,
    analyzedAt: '2026-01-02T00:00:00.000Z'
  }

  await cache.set(identity, newer)
  assert.equal(await cache.deleteIfMatches(identity, original), false)
  assert.deepEqual(await cache.get(identity), newer)
  assert.equal(await cache.deleteIfMatches(identity, newer), true)
  assert.equal(await cache.get(identity), null)

  await rm(dir, { recursive: true, force: true })
})

test('loudness cache prunes oldest entries when over maxEntries', async () => {
  const entries: Record<string, LoudnessAnalysisResult> = {
    old: {
      integratedLufs: -10,
      truePeakDb: -1,
      source: 'analyzed',
      analyzedAt: '2020-01-01T00:00:00.000Z',
      algorithmVersion: 1
    },
    mid: {
      integratedLufs: -11,
      truePeakDb: -1,
      source: 'analyzed',
      analyzedAt: '2021-01-01T00:00:00.000Z',
      algorithmVersion: 1
    },
    new: {
      integratedLufs: -12,
      truePeakDb: -1,
      source: 'analyzed',
      analyzedAt: '2022-01-01T00:00:00.000Z',
      algorithmVersion: 1
    }
  }
  pruneLoudnessCacheEntries(entries, 2)
  assert.equal(Object.keys(entries).sort().join(','), 'mid,new')
  assert.equal(entries.old, undefined)

  const dir = await mkdtemp(join(tmpdir(), 'twilight-loudness-cache-prune-'))
  const cachePath = join(dir, 'loudness-analysis-cache.json')
  const cache = new LoudnessAnalysisCache(cachePath, 2)
  for (let i = 0; i < 3; i += 1) {
    await cache.set(
      {
        filePath: 'D:\\Music\\song-' + i + '.flac',
        size: 100 + i,
        mtimeMs: 1000 + i,
        algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
      },
      {
        integratedLufs: -15 - i,
        truePeakDb: -1,
        source: 'analyzed',
        analyzedAt: '2026-01-0' + (i + 1) + 'T00:00:00.000Z',
        algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
      }
    )
  }
  assert.equal(await cache.getEntryCount(), 2)
  await rm(dir, { recursive: true, force: true })
})

test('loudness cache rejects a valid-looking document with excessive unknown nesting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-loudness-cache-deep-'))
  try {
    const cachePath = join(dir, 'loudness-analysis-cache.json')
    const cache = new LoudnessAnalysisCache(cachePath)
    const identity = {
      filePath: 'D:\\Music\\song.flac',
      size: 123,
      mtimeMs: 456,
      algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
    }
    const analysis: LoudnessAnalysisResult = {
      integratedLufs: -14.2,
      truePeakDb: -1.1,
      source: 'analyzed',
      analyzedAt: '2026-01-01T00:00:00.000Z',
      algorithmVersion: LOUDNESS_ANALYSIS_ALGORITHM_VERSION
    }

    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: { [buildLoudnessAnalysisCacheKey(identity)]: analysis },
        padding: deeplyNestedValue()
      }),
      'utf-8'
    )

    assert.equal(await cache.get(identity), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
