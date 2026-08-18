import assert from 'node:assert/strict'
import test from 'node:test'
import { createSleepTimerFadeController } from './sleepTimerFade.ts'

test('sleep fade reaches stop once and restores the user volume afterwards', () => {
  let now = 0
  let callback: (() => void) | null = null
  let volume = 0.8
  let stopCalls = 0
  const fade = createSleepTimerFadeController({
    getVolume: () => volume,
    setVolume: (next) => {
      volume = next
    },
    stop: () => {
      stopCalls++
    },
    now: () => now,
    setInterval: (next) => {
      callback = next
      return {} as ReturnType<typeof setInterval>
    },
    clearInterval: () => {}
  })

  fade.begin({ mode: 'minutes', endsAt: 1, fadeSeconds: 2, active: false, triggered: true })
  now = 1_000
  ;(callback as (() => void) | null)?.()
  assert.equal(volume, 0.4)
  now = 2_000
  ;(callback as (() => void) | null)?.()
  assert.equal(stopCalls, 1)
  assert.equal(volume, 0.8)
  assert.equal(fade.isActive(), false)
})

test('zero-second fades are idempotent until the timer is reset', () => {
  let stopCalls = 0
  const fade = createSleepTimerFadeController({
    getVolume: () => 0.5,
    setVolume: () => {},
    stop: () => {
      stopCalls++
    }
  })
  const terminal = {
    mode: 'queueEnd' as const,
    endsAt: null,
    fadeSeconds: 0,
    active: false,
    triggered: true
  }
  assert.equal(fade.begin(terminal), true)
  assert.equal(fade.begin(terminal), false)
  assert.equal(stopCalls, 1)
  fade.clear()
  assert.equal(fade.begin(terminal), true)
  assert.equal(stopCalls, 2)
})

test('muted or zero volume ends fade immediately without interval', () => {
  let stopCalls = 0
  let intervalCalls = 0
  const fade = createSleepTimerFadeController({
    getVolume: () => 0,
    setVolume: () => {},
    stop: () => {
      stopCalls++
    },
    setInterval: () => {
      intervalCalls++
      return {} as ReturnType<typeof setInterval>
    },
    clearInterval: () => {}
  })
  assert.equal(
    fade.begin({
      mode: 'minutes',
      endsAt: 1,
      fadeSeconds: 10,
      active: false,
      triggered: true
    }),
    true
  )
  assert.equal(stopCalls, 1)
  assert.equal(intervalCalls, 0)
})
