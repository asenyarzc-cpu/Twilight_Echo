export interface IdleTaskHost {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

export interface IdleTaskHandle {
  cancel: () => void
}

export function scheduleIdleTask(
  callback: () => void,
  timeout = 180,
  host: IdleTaskHost = globalThis
): IdleTaskHandle {
  let cancelled = false
  let idleId: number | null = null
  let timerId: ReturnType<typeof setTimeout> | null = null
  const run = (): void => {
    if (cancelled) return
    cancelled = true
    idleId = null
    timerId = null
    callback()
  }
  if (host.requestIdleCallback) {
    idleId = host.requestIdleCallback(run, { timeout })
  } else {
    timerId = host.setTimeout(run, Math.min(48, timeout))
  }
  return {
    cancel: () => {
      cancelled = true
      if (idleId !== null) host.cancelIdleCallback?.(idleId)
      if (timerId !== null) host.clearTimeout(timerId)
      idleId = null
      timerId = null
    }
  }
}
