const assert = require('node:assert/strict')
const test = require('node:test')

const {
  callbackDeadlineLoadPercent,
  parseArgs,
  performanceDelta
} = require('./audio-performance-soak.cjs')

test('real-device audio performance soak parses explicit thresholds without running a backend', () => {
  const options = parseArgs([
    '--device',
    'Desk DAC',
    '--duration-seconds',
    '180',
    '--buffer',
    '256',
    '--max-deadline-misses',
    '0',
    '--max-callback-load',
    '65',
    '--json'
  ])

  assert.equal(options.device, 'Desk DAC')
  assert.equal(options.durationSeconds, 180)
  assert.equal(options.buffer, 256)
  assert.equal(options.maxDeadlineMisses, 0)
  assert.equal(options.maxCallbackLoad, 65)
  assert.equal(options.json, true)
})

test('real-device audio performance soak rejects unsafe duration and threshold values', () => {
  assert.throws(() => parseArgs(['--duration-seconds', '59']), /at least 60/)
  assert.throws(() => parseArgs(['--max-deadline-misses', '-1']), /non-negative integer/)
  assert.throws(() => parseArgs(['--max-callback-load', '0']), /must be positive/)
})

test('audio performance evidence computes only counter deltas', () => {
  const before = {
    callbackCount: 100,
    totalCallbackNanoseconds: 3000,
    totalDeadlineNanoseconds: 5000,
    deadlineMissCount: 1,
    peakCallbackNanoseconds: 99
  }
  const after = {
    callbackCount: 145,
    totalCallbackNanoseconds: 5100,
    totalDeadlineNanoseconds: 7250,
    deadlineMissCount: 3,
    peakCallbackNanoseconds: 120
  }

  assert.deepEqual(performanceDelta(before, after), {
    callbackCount: 45,
    totalCallbackNanoseconds: 2100,
    totalDeadlineNanoseconds: 2250,
    deadlineMissCount: 2
  })
  assert.equal(callbackDeadlineLoadPercent(performanceDelta(before, after)), 93.33333333333333)
  assert.equal(callbackDeadlineLoadPercent({ totalCallbackNanoseconds: 10 }), 0)
})
