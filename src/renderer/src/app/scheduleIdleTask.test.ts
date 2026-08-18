import assert from 'node:assert/strict'
import test from 'node:test'
import { scheduleIdleTask, type IdleTaskHost } from './scheduleIdleTask.ts'

function createHost(overrides: Partial<IdleTaskHost> = {}): IdleTaskHost {
  return {
    setTimeout,
    clearTimeout,
    ...overrides
  }
}

test('uses requestIdleCallback once and supports cancellation', () => {
  let callback: (() => void) | null = null
  let cancelled: number | null = null
  let calls = 0
  const task = scheduleIdleTask(
    () => {
      calls += 1
    },
    180,
    createHost({
      requestIdleCallback: (next) => {
        callback = next
        return 42
      },
      cancelIdleCallback: (handle) => {
        cancelled = handle
      }
    })
  )
  task.cancel()
  const invoke = callback as (() => void) | null
  if (invoke) invoke()
  assert.equal(cancelled, 42)
  assert.equal(calls, 0)
})

test('falls back to timeout when requestIdleCallback is unavailable', async () => {
  await new Promise<void>((resolve) => {
    scheduleIdleTask(resolve, 1, createHost())
  })
})
