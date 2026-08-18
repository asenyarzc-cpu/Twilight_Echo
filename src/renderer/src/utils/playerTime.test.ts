import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTime, getNowMs } from './playerTime.ts'

test('formatTime handles invalid and negative values', () => {
  assert.equal(formatTime(Number.NaN), '0:00')
  assert.equal(formatTime(Number.POSITIVE_INFINITY), '0:00')
  assert.equal(formatTime(Number.NEGATIVE_INFINITY), '0:00')
  assert.equal(formatTime(-0.1), '0:00')
})

test('formatTime floors minutes and zero-pads seconds', () => {
  assert.equal(formatTime(0), '0:00')
  assert.equal(formatTime(59.9), '0:59')
  assert.equal(formatTime(60), '1:00')
  assert.equal(formatTime(61.9), '1:01')
  assert.equal(formatTime(599), '9:59')
  assert.equal(formatTime(600), '10:00')
  assert.equal(formatTime(3661.9), '61:01')
})

test('getNowMs returns a finite non-negative number', () => {
  const now = getNowMs()
  assert.equal(Number.isFinite(now), true)
  assert.ok(now >= 0)
})
