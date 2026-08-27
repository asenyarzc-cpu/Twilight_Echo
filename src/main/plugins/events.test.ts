import assert from 'node:assert/strict'
import test from 'node:test'

const { derivePlaybackEvents } = (await import(
  new URL('./events.ts', import.meta.url).href
)) as typeof import('./events')

test('derives progress and track/state events from playback snapshots', () => {
  const events = derivePlaybackEvents(null, {
    source: 'ncm:1',
    state: 'playing',
    position: 12,
    duration: 180,
    queueIndex: 0,
    codec: 'mp3'
  })

  assert.deepEqual(
    events.map((event) => event.name),
    ['player:progress', 'player:track-change', 'player:play']
  )
})

test('derives only changed state events for subsequent snapshots', () => {
  const events = derivePlaybackEvents(
    {
      source: 'ncm:1',
      state: 'playing',
      position: 12,
      duration: 180,
      queueIndex: 0,
      codec: 'mp3'
    },
    {
      source: 'ncm:1',
      state: 'paused',
      position: 20,
      duration: 180,
      queueIndex: 0,
      codec: 'mp3'
    }
  )

  assert.deepEqual(
    events.map((event) => event.name),
    ['player:progress', 'player:pause']
  )
})
