import type { PluginIndexEntryTrustLike, PluginIndexStatusLike } from './pluginTrustPresentation.ts'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_RETRY_DELAY_MS = 30_000

export interface PluginTrustRefreshSnapshot {
  entries: readonly PluginIndexEntryTrustLike[]
  status: PluginIndexStatusLike | null
}

export interface PluginTrustRefreshController {
  schedule: () => void
  refreshNow: () => Promise<void>
  waitForIdle: () => Promise<void>
  stop: () => void
}

export function getPluginTrustRevalidationDeadline(
  snapshot: PluginTrustRefreshSnapshot
): number | null {
  const deadlines: number[] = []
  if (snapshot.status && !snapshot.status.expired) {
    addDeadline(deadlines, snapshot.status.expiresAt)
  }
  for (const entry of snapshot.entries) {
    addDeadline(deadlines, entry.verification.revalidateAt)
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : null
}

export function createPluginTrustRefreshController(options: {
  getSnapshot: () => PluginTrustRefreshSnapshot
  refresh: () => Promise<void>
  now?: () => number
  retryDelayMs?: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}): PluginTrustRefreshController {
  const now = options.now ?? Date.now
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let timer: unknown | null = null
  let inFlight: Promise<void> | null = null
  let lastTriggeredDeadline: number | null = null
  let stopped = false

  const clearScheduledTimer = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const schedule = (): void => {
    if (stopped) return
    clearScheduledTimer()
    const currentTime = now()
    const deadline = getPluginTrustRevalidationDeadline(options.getSnapshot())
    if (deadline === null) return
    const delay =
      deadline <= currentTime && lastTriggeredDeadline === deadline
        ? retryDelayMs
        : Math.max(0, Math.min(deadline - currentTime, MAX_TIMER_DELAY_MS))
    timer = setTimer(() => {
      timer = null
      lastTriggeredDeadline = deadline
      void refreshAndReschedule().catch(() => undefined)
    }, delay)
  }

  const refreshAndReschedule = async (): Promise<void> => {
    if (inFlight) return inFlight
    inFlight = Promise.resolve().then(options.refresh)
    try {
      await inFlight
    } finally {
      inFlight = null
      schedule()
    }
  }

  return {
    schedule,
    refreshNow: async (): Promise<void> => {
      if (stopped) return
      lastTriggeredDeadline = null
      clearScheduledTimer()
      await refreshAndReschedule()
    },
    waitForIdle: async (): Promise<void> => {
      await (inFlight ?? Promise.resolve())
    },
    stop: (): void => {
      stopped = true
      clearScheduledTimer()
    }
  }
}

function addDeadline(target: number[], value: string | null): void {
  if (!value) return
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) target.push(parsed)
}
