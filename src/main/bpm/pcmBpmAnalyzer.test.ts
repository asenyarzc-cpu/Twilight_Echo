import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzePcmBpm } from './pcmBpmAnalyzer.ts'

function synthClickTrack(bpm: number, seconds: number, sampleRate = 22050): Float32Array {
  const samples = new Float32Array(seconds * sampleRate)
  const beatSamples = Math.round((60 / bpm) * sampleRate)
  for (let offset = 0; offset < samples.length; offset += beatSamples) {
    for (let index = 0; index < 120 && offset + index < samples.length; index += 1) {
      samples[offset + index] = 1 - index / 120
    }
  }
  return samples
}

function synthAlternatingClickTrack(
  bpm: number,
  seconds: number,
  sampleRate = 22050
): Float32Array {
  const samples = new Float32Array(seconds * sampleRate)
  const beatSamples = Math.round((60 / bpm) * sampleRate)
  let beat = 0
  for (let offset = 0; offset < samples.length; offset += beatSamples) {
    beat += 1
    const strength = beat % 2 === 0 ? 1 : 0.22
    for (let index = 0; index < 120 && offset + index < samples.length; index += 1) {
      samples[offset + index] = strength * (1 - index / 120)
    }
  }
  return samples
}

function concat(...chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

test('PCM BPM analyzer detects common fixed tempos', () => {
  for (const bpm of [120, 180, 200]) {
    const result = analyzePcmBpm({
      samples: synthClickTrack(bpm, 32),
      sampleRate: 22050,
      referenceBpm: undefined
    })
    assert.ok(result)
    assert.ok(Math.abs(result.bpm - bpm) <= 3, `expected ${bpm}, got ${result.bpm}`)
    assert.equal(result.source, 'analyzed')
  }
})

test('PCM BPM analyzer keeps fast alternating beats out of half tempo', () => {
  const result = analyzePcmBpm({
    samples: synthAlternatingClickTrack(200, 32),
    sampleRate: 22050
  })

  assert.ok(result)
  assert.ok(Math.abs(result.bpm - 200) <= 3, `expected 200, got ${result.bpm}`)
})

test('PCM BPM analyzer uses metadata as octave prior', () => {
  const result = analyzePcmBpm({
    samples: synthAlternatingClickTrack(195, 32),
    sampleRate: 22050,
    referenceBpm: 195
  })

  assert.ok(result)
  assert.ok(Math.abs(result.bpm - 195) <= 3, `expected 195, got ${result.bpm}`)
})

test('PCM BPM analyzer marks variable tempo ranges', () => {
  const result = analyzePcmBpm({
    samples: concat(synthClickTrack(120, 24), synthClickTrack(180, 24)),
    sampleRate: 22050
  })

  assert.ok(result)
  assert.equal(result.variableTempo, true)
  assert.ok(result.bpmRange)
  assert.ok(result.bpmRange[0] <= 123, `expected low range near 120, got ${result.bpmRange}`)
  assert.ok(result.bpmRange[1] >= 177, `expected high range near 180, got ${result.bpmRange}`)
})
