import assert from 'node:assert/strict'
import test from 'node:test'

import { AudioTempoEstimator, normalizeBpm } from './audioTempoEstimator.ts'

function frameBars(strength: number): Float32Array {
  const bars = new Float32Array(16)
  bars[2] = strength
  bars[3] = strength * 0.6
  bars[4] = strength * 0.35
  return bars
}

function waveformPulse(strength: number): Float32Array {
  const samples = new Float32Array(32)
  samples[0] = strength
  samples[1] = -strength * 0.8
  samples[2] = strength * 0.45
  return samples
}

function feedPulseTrain(
  estimator: AudioTempoEstimator,
  bpm: number,
  seconds: number
): ReturnType<AudioTempoEstimator['pushFrame']> {
  const intervalMs = 50
  const beatMs = 60000 / bpm
  let result: ReturnType<AudioTempoEstimator['pushFrame']> = estimator.getState()
  for (let timestamp = 0; timestamp <= seconds * 1000; timestamp += intervalMs) {
    const beatPhase = timestamp % beatMs
    const onBeat = beatPhase < intervalMs || beatMs - beatPhase < intervalMs
    const strength = onBeat ? 1 : 0.08
    result = estimator.pushFrame({
      timestamp,
      visualizerBars: frameBars(strength),
      rmsDb: onBeat ? -8 : -24,
      active: true
    })
  }
  return result
}

function feedAlternatingPulseTrain(
  estimator: AudioTempoEstimator,
  bpm: number,
  seconds: number,
  weakBeatStrength = 0.18,
  referenceBpm?: number
): ReturnType<AudioTempoEstimator['pushFrame']> {
  const intervalMs = 50
  const beatMs = 60000 / bpm
  let result: ReturnType<AudioTempoEstimator['pushFrame']> = estimator.getState()
  let beatIndex = 0
  let wasOnBeat = false
  for (let timestamp = 0; timestamp <= seconds * 1000; timestamp += intervalMs) {
    const beatPhase = timestamp % beatMs
    const onBeat = beatPhase < intervalMs || beatMs - beatPhase < intervalMs
    if (onBeat && !wasOnBeat) beatIndex += 1
    wasOnBeat = onBeat
    const strongBeat = beatIndex % 2 === 0
    const strength = onBeat ? (strongBeat ? 1 : weakBeatStrength) : 0.06
    result = estimator.pushFrame({
      timestamp,
      visualizerBars: frameBars(strength),
      rmsDb: onBeat ? (strongBeat ? -8 : -18) : -26,
      active: true,
      referenceBpm
    })
  }
  return result
}

function feedWaveformPulseTrain(
  estimator: AudioTempoEstimator,
  bpm: number,
  seconds: number
): ReturnType<AudioTempoEstimator['pushFrame']> {
  const intervalMs = 50
  const beatMs = 60000 / bpm
  let result: ReturnType<AudioTempoEstimator['pushFrame']> = estimator.getState()
  for (let timestamp = 0; timestamp <= seconds * 1000; timestamp += intervalMs) {
    const beatPhase = timestamp % beatMs
    const onBeat = beatPhase < intervalMs || beatMs - beatPhase < intervalMs
    result = estimator.pushFrame({
      timestamp,
      visualizerBars: frameBars(0.2),
      waveform: waveformPulse(onBeat ? 1 : 0.03),
      rmsDb: -18,
      active: true
    })
  }
  return result
}

test('normalizeBpm accepts finite values in the supported tempo range', () => {
  assert.equal(normalizeBpm('128.49'), 128.5)
  assert.equal(normalizeBpm(30), 30)
  assert.equal(normalizeBpm(300), 300)
})

test('normalizeBpm rejects invalid or unsupported tempo values', () => {
  assert.equal(normalizeBpm('fast'), undefined)
  assert.equal(normalizeBpm(29.9), undefined)
  assert.equal(normalizeBpm(300.1), undefined)
  assert.equal(normalizeBpm(Number.NaN), undefined)
})

test('tempo estimator stabilizes near 120 BPM from repeated onsets', () => {
  const estimator = new AudioTempoEstimator()
  const result = feedPulseTrain(estimator, 120, 14)

  assert.equal(result.source, 'live')
  assert.ok(result.bpm)
  assert.ok(Math.abs(result.bpm - 120) <= 2, `expected about 120 BPM, got ${result.bpm}`)
  assert.ok(result.confidence >= 0.62)
})

test('tempo estimator stabilizes near 90 BPM without doubling to 180', () => {
  const estimator = new AudioTempoEstimator()
  const result = feedPulseTrain(estimator, 90, 16)

  assert.equal(result.source, 'live')
  assert.ok(result.bpm)
  assert.ok(Math.abs(result.bpm - 90) <= 3, `expected about 90 BPM, got ${result.bpm}`)
})

test('tempo estimator does not lock fast alternating beats to half tempo', () => {
  const estimator = new AudioTempoEstimator()
  const result = feedAlternatingPulseTrain(estimator, 200, 16)

  assert.equal(result.source, 'live')
  assert.ok(result.bpm)
  assert.ok(Math.abs(result.bpm - 200) <= 3, `expected about 200 BPM, got ${result.bpm}`)
})

test('tempo estimator uses metadata as an octave prior for weak fast beats', () => {
  const estimator = new AudioTempoEstimator()
  const result = feedAlternatingPulseTrain(estimator, 195, 16, 0.18, 195)

  assert.equal(result.source, 'live')
  assert.ok(result.bpm)
  assert.ok(Math.abs(result.bpm - 195) <= 3, `expected metadata-aligned 195 BPM, got ${result.bpm}`)
})

test('tempo estimator remains analyzing before enough history exists', () => {
  const estimator = new AudioTempoEstimator()
  const result = feedPulseTrain(estimator, 120, 5)

  assert.equal(result.source, 'analyzing')
  assert.equal(result.bpm, undefined)
})

test('tempo estimator reset clears stable live tempo state', () => {
  const estimator = new AudioTempoEstimator()
  assert.equal(feedPulseTrain(estimator, 120, 14).source, 'live')

  estimator.reset()
  const result = estimator.getState()

  assert.equal(result.source, 'analyzing')
  assert.equal(result.bpm, undefined)
  assert.equal(result.confidence, 0)
})

test('tempo estimator keeps the last stable bpm through a temporary weak section', () => {
  const estimator = new AudioTempoEstimator()
  const stable = feedPulseTrain(estimator, 120, 14)
  assert.equal(stable.source, 'live')

  let held = stable
  for (let timestamp = 14050; timestamp <= 18000; timestamp += 50) {
    held = estimator.pushFrame({
      timestamp,
      visualizerBars: frameBars(0.08),
      rmsDb: -24,
      active: true
    })
  }

  assert.equal(held.source, 'live')
  assert.ok(held.bpm)
  assert.ok(Math.abs(held.bpm - 120) <= 2, `expected held 120 BPM, got ${held.bpm}`)
})

test('tempo estimator can stabilize from waveform transients when spectrum bars are flat', () => {
  const estimator = new AudioTempoEstimator()
  const result = feedWaveformPulseTrain(estimator, 128, 14)

  assert.equal(result.source, 'live')
  assert.ok(result.bpm)
  assert.ok(Math.abs(result.bpm - 128) <= 3, `expected about 128 BPM, got ${result.bpm}`)
})
