import assert from 'node:assert/strict'
import test from 'node:test'
import { SleepTimerService } from '../../../main/sleepTimerCore.ts'
import { createSleepTimerState, type SleepTimerState } from '../../../shared/sleepTimer.ts'
import { createSleepTimerEventBridge } from '../../../preload/sleepTimerEvents.ts'
import { createSleepTimerController } from './sleepTimerController.ts'
import { createSleepTimerFadeController } from './sleepTimerFade.ts'

test('one main-process trigger yields one stop through preload, controller, and zero-fade', () => {
  const listeners = new Map<string, (event: unknown, state: SleepTimerState | null) => void>()
  const events = createSleepTimerEventBridge()
  events.bind({ on: (channel, listener) => listeners.set(channel, listener) })

  let state: SleepTimerState | null = null
  let stops = 0
  const fade = createSleepTimerFadeController({
    getVolume: () => 0.75,
    setVolume: () => {},
    stop: () => {
      stops++
    }
  })
  const controller = createSleepTimerController({
    bridge: null,
    getSettings: () => ({ defaultMinutes: 30, fadeSeconds: 0 }),
    getState: () => state,
    setState: (next) => {
      state = next
    },
    persistSession: () => {},
    setNotice: () => {},
    onTriggered: (next) => fade.begin(next)
  })
  events.onState(controller.applyAuthoritativeState)
  events.onTrigger(controller.applyTrigger)

  const timer = new SleepTimerService({
    now: () => 1_000,
    publish: (kind, next) => listeners.get(`sleepTimer:${kind}`)?.({}, next)
  })
  timer.configure(createSleepTimerState('queueEnd', 1_000, { defaultMinutes: 30, fadeSeconds: 0 }))
  timer.boundary('queueEnd')

  assert.equal(stops, 1)
  assert.equal((state as SleepTimerState | null)?.triggered, true)
  // The terminal status follows the trigger and must remain passive.
  listeners.get('sleepTimer:status')?.({}, state)
  assert.equal(stops, 1)
})
