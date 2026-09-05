/**
 * LAN web remote + DLNA cast shared types / validators.
 * Default OFF; PIN pairing + bearer token; rate-limited.
 */

export const REMOTE_CONTROL_SCHEMA_VERSION = 1 as const
export const REMOTE_PIN_LENGTH = 6
export const REMOTE_TOKEN_BYTES = 24
export const REMOTE_MAX_COMMANDS_PER_WINDOW = 60
export const REMOTE_COMMAND_WINDOW_MS = 60_000
export const REMOTE_PAIR_MAX_ATTEMPTS = 8
export const REMOTE_PAIR_WINDOW_MS = 5 * 60_000
export const REMOTE_MEDIA_TOKEN_TTL_MS = 2 * 60 * 60_000
export const REMOTE_SSE_HEARTBEAT_MS = 15_000

export const REMOTE_BROWSE_MAX_LIMIT = 100

export type RemoteBrowseView = 'library' | 'playlists' | 'queue'
export type RemotePlayMode = 'sequence' | 'loop' | 'single' | 'shuffle'

export interface RemoteBrowseRequest {
  view: RemoteBrowseView
  query: string
  offset: number
  limit: number
  playlistId?: string
}

export interface RemoteBrowseItem {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  index?: number
  trackCount?: number
}

export interface RemoteBrowseResult {
  items: RemoteBrowseItem[]
  total: number
  offset: number
  limit: number
  revision?: number
}

export type RemoteRendererRequest =
  | { id: string; kind: 'browse'; payload: RemoteBrowseRequest }
  | { id: string; kind: 'command'; payload: PlayerRemoteCommand }

export type RemotePlayerCommandAction =
  | 'playPause'
  | 'play'
  | 'pause'
  | 'previous'
  | 'next'
  | 'seek'
  | 'setVolume'
  | 'jumpQueue'
  | 'removeQueue'
  | 'playTrack'
  | 'enqueueTrack'
  | 'setPlayMode'

export type PlayerRemoteCommand =
  | { action: 'playPause' }
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'previous' }
  | { action: 'next' }
  | { action: 'seek'; positionSeconds: number }
  | { action: 'setVolume'; volume: number }
  | { action: 'jumpQueue'; index: number; revision: number }
  | { action: 'removeQueue'; index: number; revision: number }
  | { action: 'playTrack'; id: string }
  | { action: 'enqueueTrack'; id: string }
  | { action: 'setPlayMode'; mode: RemotePlayMode }

export interface RemotePlaybackSnapshot {
  state: 'playing' | 'paused' | 'stopped'
  title: string
  artist: string
  album: string
  position: number
  duration: number
  volume: number
  muted: boolean
  queueIndex: number
  queueLength: number
  coverUrl: string | null
  isLive: boolean
  castTarget: string | null
  playMode: RemotePlayMode
  queueRevision: number
  updatedAt: number
}

export interface RemoteControlStatus {
  enabled: boolean
  running: boolean
  port: number | null
  pin: string | null
  urls: string[]
  paired: boolean
  clientCount: number
  lastError: string | null
  /**
   * True when the LAN HTTP server is bound only to serve cast media tokens
   * (no remote-control UI, pairing, or command API). Remote remains "off".
   */
  mediaOnly?: boolean
}

export type CastProtocol = 'dlna' | 'chromecast'

export interface DlnaDeviceInfo {
  usn: string
  friendlyName: string
  location: string
  manufacturer: string
  modelName: string
  avTransportUrl: string | null
  renderingControlUrl: string | null
  lastSeenAt: number
  /** Cast backend protocol; defaults to 'dlna' when omitted (legacy). */
  protocol?: CastProtocol
  /** Chromecast host (IPv4). */
  host?: string
  port?: number
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseRemoteBrowseRequest(params: URLSearchParams): RemoteBrowseRequest | null {
  const view = params.get('view')
  if (view !== 'library' && view !== 'playlists' && view !== 'queue') return null
  const offset = Number(params.get('offset') ?? '0')
  const limit = Number(params.get('limit') ?? '40')
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) return null
  const query = params.get('query') ?? ''
  const playlistId = params.get('playlistId') ?? undefined
  if (query.length > 120 || (playlistId && (playlistId.length < 1 || playlistId.length > 512))) {
    return null
  }
  return {
    view,
    query,
    offset,
    limit: Math.min(limit, REMOTE_BROWSE_MAX_LIMIT),
    ...(playlistId ? { playlistId } : {})
  }
}

export function parseRemotePlayerCommand(value: unknown): PlayerRemoteCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const action = record.action
  if (typeof action !== 'string') return null

  switch (action) {
    case 'playPause':
    case 'play':
    case 'pause':
    case 'previous':
    case 'next':
      return { action }
    case 'seek': {
      if (!isFiniteNumber(record.positionSeconds) || record.positionSeconds < 0) return null
      return {
        action: 'seek',
        positionSeconds: Math.min(record.positionSeconds, 24 * 60 * 60)
      }
    }
    case 'setVolume': {
      if (!isFiniteNumber(record.volume)) return null
      return {
        action: 'setVolume',
        volume: Math.min(1, Math.max(0, record.volume))
      }
    }
    case 'jumpQueue':
    case 'removeQueue': {
      if (
        !isFiniteNumber(record.index) ||
        record.index < 0 ||
        !Number.isInteger(record.index) ||
        !isFiniteNumber(record.revision) ||
        record.revision < 0 ||
        !Number.isInteger(record.revision)
      ) {
        return null
      }
      return { action, index: record.index, revision: record.revision }
    }
    case 'playTrack':
    case 'enqueueTrack': {
      if (typeof record.id !== 'string' || record.id.length < 1 || record.id.length > 512)
        return null
      return { action, id: record.id }
    }
    case 'setPlayMode': {
      if (
        record.mode !== 'sequence' &&
        record.mode !== 'loop' &&
        record.mode !== 'single' &&
        record.mode !== 'shuffle'
      ) {
        return null
      }
      return { action, mode: record.mode }
    }
    default:
      return null
  }
}

export function createEmptyRemotePlaybackSnapshot(
  overrides: Partial<RemotePlaybackSnapshot> = {}
): RemotePlaybackSnapshot {
  return {
    state: 'stopped',
    title: '',
    artist: '',
    album: '',
    position: 0,
    duration: 0,
    volume: 1,
    muted: false,
    queueIndex: -1,
    queueLength: 0,
    coverUrl: null,
    isLive: false,
    castTarget: null,
    playMode: 'sequence',
    queueRevision: 0,
    updatedAt: Date.now(),
    ...overrides
  }
}

export function isPrivateOrLocalIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/i, '').toLowerCase()
  if (normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost') return true
  if (normalized.startsWith('10.')) return true
  if (normalized.startsWith('192.168.')) return true
  if (normalized.startsWith('169.254.')) return true
  const match = /^172\.(\d+)\./.exec(normalized)
  if (match) {
    const second = Number(match[1])
    if (second >= 16 && second <= 31) return true
  }
  // Unique local IPv6 (fc00::/7)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  return false
}
