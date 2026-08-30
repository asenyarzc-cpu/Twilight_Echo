import assert from 'node:assert/strict'
import test from 'node:test'
import { createSleepTimerState } from '../../shared/sleepTimer.ts'
import { registerSleepTimerIpc } from './sleepTimerIpc.ts'

test('sleep timer IPC validates untrusted payloads before configuring the main timer', () => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const calls: string[] = []
  const timer = {
    configure: (state: ReturnType<typeof createSleepTimerState>) => {
      calls.push(`configure:${state.mode}`)
      return state
    },
    cancel: () => null,
    snapshot: () => null,
    boundary: (boundary: 'trackEnd' | 'queueEnd') => {
      calls.push(`boundary:${boundary}`)
      return null
    }
  }
  registerSleepTimerIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    timer,
    () => calls.push('trusted')
  )

  assert.throws(
    () => handlers.get('sleepTimer:configure')?.({}, { mode: 'minutes', endsAt: null }),
    /Invalid sleep timer state/
  )
  const valid = createSleepTimerState('trackEnd', 1, { defaultMinutes: 30, fadeSeconds: 2 })
  assert.deepEqual(handlers.get('sleepTimer:configure')?.({}, valid), valid)
  assert.equal(handlers.get('sleepTimer:boundary')?.({}, 'trackEnd'), null)
  assert.deepEqual(calls, [
    'trusted',
    'trusted',
    'configure:trackEnd',
    'trusted',
    'boundary:trackEnd'
  ])
})
