import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlaybackSessionClock, type PlaybackClockSnapshot } from './playbackSessionClock.ts'

function makeClock() {
  let now = 0
  const clock = createPlaybackSessionClock({ now: () => now })
  return {
    clock,
    advance(ms: number) {
      now += ms
    }
  }
}

test('rejects old epochs and keeps one revisioned snapshot', () => {
  const { clock } = makeClock()
  const started = clock.begin({ trackId: 'track-a', position: 0, duration: 180, state: 'playing' })
  const next = clock.begin({ trackId: 'track-b', position: 12, duration: 200, state: 'playing' })

  assert.equal(next.epoch, started.epoch + 1)
  const stale = clock.ingest({
    trackId: 'track-a',
    epoch: started.epoch,
    position: 4,
    source: 'native-time-pos'
  })
  assert.equal(stale.accepted, false)
  assert.equal(stale.reason, 'wrong-track')
  assert.equal(clock.snapshot().position, 12)
})

test('seek publishes immediately and old samples cannot overwrite the target', () => {
  const { clock } = makeClock()
  clock.begin({ trackId: 'track', position: 20, duration: 180, state: 'playing' })
  const beforeSeek = clock.snapshot()
  const seek = clock.seek(90, 'playing')
  assert.equal(seek.position, 90)
  const stale = clock.ingest({
    trackId: 'track',
    epoch: beforeSeek.epoch,
    position: 21,
    source: 'native-info'
  })
  assert.equal(stale.accepted, false)
  assert.equal(clock.snapshot().position, 90)
})

test('short sample gaps predict and long gaps become stalled with resync requested', () => {
  const { clock, advance } = makeClock()
  clock.begin({ trackId: 'track', position: 10, duration: 180, state: 'playing' })
  advance(600)
  const predicted = clock.estimate()
  assert.equal(predicted?.position, 10.6)
  assert.equal(predicted?.state, 'playing')

  advance(1_600)
  const stalled = clock.estimate()
  assert.equal(stalled?.state, 'stalled')
  assert.equal(stalled?.needsResync, true)
  assert.equal(stalled?.position, 10.6)

  const confirmed = clock.ingest({
    trackId: 'track',
    epoch: clock.epoch(),
    position: 12.2,
    state: 'playing',
    source: 'native-info'
  })
  assert.equal(confirmed.accepted, true)
  assert.equal(confirmed.snapshot.needsResync, false)
})

test('duplicate samples do not block a later advancing sample', () => {
  const { clock, advance } = makeClock()
  clock.begin({ trackId: 'track', position: 0, duration: 180, state: 'playing' })
  advance(100)
  assert.equal(
    clock.ingest({
      trackId: 'track',
      epoch: clock.epoch(),
      position: 0.2,
      sampledAt: 100,
      source: 'native-time-pos'
    }).accepted,
    true
  )
  const duplicate = clock.ingest({
    trackId: 'track',
    epoch: clock.epoch(),
    position: 0.2,
    sampledAt: 100,
    source: 'native-time-pos'
  })
  assert.equal(duplicate.accepted, false)
  advance(250)
  const advancing = clock.ingest({
    trackId: 'track',
    epoch: clock.epoch(),
    position: 0.5,
    sampledAt: 350,
    source: 'native-time-pos'
  })
  assert.equal(advancing.accepted, true)
  assert.equal(advancing.snapshot.position, 0.5)
})

test('repeated frozen engine positions leave the shared timeline interpolating', () => {
  const { clock, advance } = makeClock()
  clock.begin({ trackId: 'track', position: 0.25, duration: 180, state: 'playing' })

  advance(100)
  const frozen = clock.ingest({
    trackId: 'track',
    epoch: clock.epoch(),
    position: 0.25,
    sampledAt: 100,
    state: 'playing',
    source: 'native-time-pos'
  })
  assert.equal(frozen.accepted, true)
  assert.equal(frozen.advanced, false)

  advance(600)
  assert.equal(clock.estimate()?.position, 0.95)
})

test('a lagging engine sample does not rewind the interpolated playhead', () => {
  const { clock, advance } = makeClock()
  clock.begin({ trackId: 'track', position: 10, duration: 180, state: 'playing' })

  advance(200)
  assert.equal(clock.estimate()?.position, 10.2)

  const lagged = clock.ingest({
    trackId: 'track',
    epoch: clock.epoch(),
    position: 10.05,
    sampledAt: 200,
    state: 'playing',
    source: 'native-time-pos'
  })
  assert.equal(lagged.accepted, true)
  assert.equal(lagged.advanced, false)
  assert.equal(clock.snapshot().position, 10.2, 'presentation must not sawtooth backward')

  advance(200)
  assert.ok(Math.abs((clock.estimate()?.position ?? 0) - 10.4) < 1e-9)
})

test('lagging samples still count as heartbeats so interpolation does not stall', () => {
  const { clock, advance } = makeClock()
  clock.begin({ trackId: 'track', position: 5, duration: 180, state: 'playing' })
  advance(200)
  clock.estimate()

  for (let step = 0; step < 8; step += 1) {
    advance(200)
    const now = (step + 2) * 200
    const result = clock.ingest({
      trackId: 'track',
      epoch: clock.epoch(),
      position: 5 + now / 1000 - 0.12,
      sampledAt: now,
      state: 'playing',
      source: 'native-time-pos'
    })
    assert.equal(result.accepted, true)
  }

  const estimated = clock.estimate()
  assert.equal(estimated?.state, 'playing')
  assert.equal(estimated?.needsResync, false)
  assert.ok((estimated?.position ?? 0) > 6.5)
})

test('an expected rewind may still jump the presentation clock backward', () => {
  const { clock, advance } = makeClock()
  clock.begin({ trackId: 'track', position: 10, duration: 180, state: 'playing' })
  advance(200)
  clock.estimate()

  const rewound = clock.ingest({
    trackId: 'track',
    epoch: clock.epoch(),
    position: 2,
    sampledAt: 200,
    state: 'playing',
    expectedRewind: true,
    source: 'native-time-pos'
  })
  assert.equal(rewound.accepted, true)
  assert.equal(rewound.snapshot.position, 2)
})

test('snapshot shape remains serializable for presentation consumers', () => {
  const { clock } = makeClock()
  const snapshot: PlaybackClockSnapshot = clock.begin({
    trackId: 'track',
    position: 1,
    duration: 2,
    rate: 1.25,
    state: 'playing'
  })
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'duration',
    'epoch',
    'needsResync',
    'position',
    'rate',
    'revision',
    'sampledAt',
    'source',
    'state',
    'trackId'
  ])
})
