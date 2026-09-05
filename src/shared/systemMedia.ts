import type { MiniPlayerPlayMode } from './miniPlayer.ts'

export type SystemMediaRepeatMode = 'none' | 'track' | 'list'

export interface SystemMediaNativeStatus {
  supported: boolean
  active: boolean
  lastError: string | null
}

export interface WindowsSmtcUpdate {
  enabled: boolean
  hasTrack: boolean
  isPlaying: boolean
  isLoading: boolean
  canNext: boolean
  canPrevious: boolean
  shuffle: boolean
  autoRepeatMode: 0 | 1 | 2
  positionSeconds: number
  durationSeconds: number
  playbackRate: number
  title: string
  artist: string
  album: string
  albumArtist: string
  trackNumber: number
  coverUri: string
}

export type WindowsSmtcEvent =
  | { type: 'button'; button: string }
  | { type: 'position'; positionSeconds: number }
  | { type: 'shuffle'; shuffle: boolean }
  | { type: 'repeat'; autoRepeatMode: number }

export function miniPlayerPlayModeToSmtcRepeatMode(mode: MiniPlayerPlayMode): 0 | 1 | 2 {
  if (mode === 'repeat') return 1
  if (mode === 'listLoop') return 2
  return 0
}

export function smtcRepeatModeToMiniPlayerPlayMode(mode: number): MiniPlayerPlayMode {
  if (mode === 1) return 'repeat'
  if (mode === 2) return 'listLoop'
  return 'sequential'
}

/**
 * Twilight Echo wraps queue navigation at both ends even in sequential mode.
 * SMTC availability must therefore describe whether the queue command can run
 * at all, rather than whether another linear index exists in that direction.
 */
export function canNavigateSystemMediaQueue(hasTrack: boolean, queueLength: number): boolean {
  return hasTrack && Number.isFinite(queueLength) && queueLength > 0
}
