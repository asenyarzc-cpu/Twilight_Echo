import {
  acceptsDesktopLyricsClock,
  type DesktopLyricsClockSnapshot
} from '../../../shared/desktopLyrics.ts'

export interface DesktopLyricsClock {
  ingest: (snapshot: DesktopLyricsClockSnapshot, sessionId: string, now?: number) => boolean
  positionAt: (now?: number) => number
  freeze: () => void
  reset: () => void
  snapshot: () => DesktopLyricsClockSnapshot | null
}

export function createDesktopLyricsClock(
  getNow: () => number = () => performance.now()
): DesktopLyricsClock {
  let current: DesktopLyricsClockSnapshot | null = null
  let receivedAt = 0
  let frozen = true

  function ingest(
    snapshot: DesktopLyricsClockSnapshot,
    sessionId: string,
    now = getNow()
  ): boolean {
    if (!acceptsDesktopLyricsClock(current, snapshot, sessionId)) return false
    current = snapshot
    receivedAt = now
    frozen = false
    return true
  }

  function positionAt(now = getNow()): number {
    if (!current) return 0
    const elapsed = current.state === 'playing' && !frozen ? (now - receivedAt) * current.rate : 0
    const projected = current.positionMs + Math.max(0, elapsed)
    return current.durationMs > 0 ? Math.min(current.durationMs, projected) : projected
  }

  return {
    ingest,
    positionAt,
    freeze: () => {
      if (!current || frozen) return
      current = { ...current, positionMs: positionAt() }
      receivedAt = getNow()
      frozen = true
    },
    reset: () => {
      current = null
      receivedAt = 0
      frozen = true
    },
    snapshot: () => current
  }
}
