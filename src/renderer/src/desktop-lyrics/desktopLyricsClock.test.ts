import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopLyricsClock } from './desktopLyricsClock.ts'

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    sessionId: 'a',
    sequence: 1,
    epoch: 1,
    positionMs: 1000,
    durationMs: 10000,
    rate: 1,
    state: 'playing' as const,
    ...overrides
  }
}

test('clock projects locally and freezes across suspend until a fresh snapshot arrives', () => {
  let now = 100
  const clock = createDesktopLyricsClock(() => now)
  assert.equal(clock.ingest(snapshot(), 'a'), true)
  now = 350
  assert.equal(clock.positionAt(), 1250)
  clock.freeze()
  now = 100000
  assert.equal(clock.positionAt(), 1250)
  assert.equal(clock.ingest(snapshot({ sequence: 2, positionMs: 1400 }), 'a'), true)
  assert.equal(clock.positionAt(), 1400)
})

test('clock rejects stale sequences and sessions while accepting a seek epoch', () => {
  const clock = createDesktopLyricsClock(() => 0)
  assert.equal(clock.ingest(snapshot(), 'a'), true)
  assert.equal(clock.ingest(snapshot({ sequence: 1 }), 'a'), false)
  assert.equal(clock.ingest(snapshot({ sessionId: 'b', sequence: 2 }), 'a'), false)
  assert.equal(clock.ingest(snapshot({ epoch: 2, sequence: 1, positionMs: 5000 }), 'a'), true)
  assert.equal(clock.positionAt(), 5000)
})
