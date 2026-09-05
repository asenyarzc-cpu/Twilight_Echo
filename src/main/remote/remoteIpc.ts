import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { normalizeIpcString } from '../security/ipcValidation.ts'
import { resolveAuthorizedAudioFile } from '../security/localPaths.ts'
import { remoteMediaGrants } from '../security/remoteMediaGrants.ts'
import { runtime } from '../core/runtime.ts'
import type { PlayerShortcutAction } from '../core/types.ts'
import {
  createEmptyRemotePlaybackSnapshot,
  type DlnaDeviceInfo,
  type PlayerRemoteCommand,
  type RemoteBrowseRequest,
  type RemoteBrowseResult,
  type RemoteControlStatus,
  type RemotePlaybackSnapshot
} from '../../shared/remoteControl.ts'
import { RemoteCommandError, RemoteHttpServer } from './httpServer.ts'
import {
  discoverDlnaDevices,
  dlnaPause,
  dlnaPlay,
  dlnaSeek,
  dlnaSetAvTransportUri,
  dlnaSetVolume,
  dlnaStop
} from './dlnaClient.ts'
import {
  chromecastLoad,
  chromecastPause,
  chromecastPlay,
  chromecastSeek,
  chromecastSetVolume,
  chromecastStop,
  discoverChromecastDevices
} from './chromecastClient.ts'
import type { CastDevice } from './castBackend.ts'
import { buildDidlLiteMetadata } from './didl.ts'
import { updateAppSettings } from '../audio/state.ts'

let server: RemoteHttpServer | null = null
/** Unified cast device list (DLNA + Chromecast). usn field holds the cast id. */
let lastDlnaDevices: DlnaDeviceInfo[] = []
let activeCastUsn: string | null = null
let syncDesiredEnabled: boolean | null = null
const rendererRequests = new Map<
  string,
  {
    resolve: (value: RemoteBrowseResult | null) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
    webContentsId: number
  }
>()
const RENDERER_REQUEST_TIMEOUT_MS = 5_000

function getStaticRoot(): string {
  return join(app.getAppPath(), 'resources', 'remote')
}

function ensureServer(): RemoteHttpServer {
  if (!server) {
    server = new RemoteHttpServer({
      staticRoot: getStaticRoot(),
      onCommand: async (command) => {
        await dispatchRemoteCommand(command)
      },
      onBrowse: requestRemoteBrowse
    })
  }
  return server
}

function sendPlayerCommand(action: PlayerShortcutAction): void {
  if (runtime.mainWindow?.isDestroyed() !== false)
    throw new RemoteCommandError('renderer_not_ready')
  runtime.mainWindow.webContents.send('player:shortcut', action)
}

function requestRenderer<T>(kind: 'browse' | 'command', payload: unknown): Promise<T> {
  const window = runtime.mainWindow
  if (!window || window.isDestroyed())
    return Promise.reject(new RemoteCommandError('renderer_not_ready'))
  const id = randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      rendererRequests.delete(id)
      reject(new RemoteCommandError('renderer_timeout'))
    }, RENDERER_REQUEST_TIMEOUT_MS)
    rendererRequests.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
      webContentsId: window.webContents.id
    })
    try {
      window.webContents.send('remote:request', { id, kind, payload })
    } catch {
      rendererRequests.delete(id)
      clearTimeout(timer)
      reject(new RemoteCommandError('renderer_not_ready'))
    }
  })
}

function requestRemoteBrowse(request: RemoteBrowseRequest): Promise<RemoteBrowseResult> {
  return requestRenderer<RemoteBrowseResult>('browse', request)
}

function rejectRendererRequests(webContentsId?: number): void {
  for (const [id, pending] of rendererRequests) {
    if (webContentsId !== undefined && pending.webContentsId !== webContentsId) continue
    rendererRequests.delete(id)
    clearTimeout(pending.timer)
    pending.reject(new RemoteCommandError('renderer_not_ready'))
  }
}

async function dispatchRemoteCommand(command: PlayerRemoteCommand): Promise<void> {
  // When casting, transport/volume target the renderer (local engine paused) and
  // also forward to the active DLNA renderer when possible.
  switch (command.action) {
    case 'playPause':
      sendPlayerCommand('playPause')
      if (activeCastUsn) await tryDlnaPlayPause()
      return
    case 'play':
      sendPlayerCommand('play')
      if (activeCastUsn) await tryDlnaTransport('play')
      return
    case 'pause':
      sendPlayerCommand('pause')
      if (activeCastUsn) await tryDlnaTransport('pause')
      return
    case 'previous':
      sendPlayerCommand('previous')
      return
    case 'next':
      sendPlayerCommand('next')
      return
    case 'seek':
      sendPlayerCommand({ action: 'seek', positionSeconds: command.positionSeconds })
      if (activeCastUsn) await tryDlnaSeek(command.positionSeconds)
      return
    case 'setVolume':
      sendPlayerCommand({ action: 'setVolume', volume: command.volume })
      if (activeCastUsn) await tryDlnaVolume(command.volume)
      return
    case 'jumpQueue':
    case 'removeQueue':
    case 'playTrack':
    case 'enqueueTrack':
    case 'setPlayMode':
      await requestRenderer<void>('command', command)
      return
  }
}

function findActiveDevice(): DlnaDeviceInfo | null {
  if (!activeCastUsn) return null
  return lastDlnaDevices.find((d) => d.usn === activeCastUsn) ?? null
}

function deviceProtocol(device: DlnaDeviceInfo): 'dlna' | 'chromecast' {
  return device.protocol === 'chromecast' ? 'chromecast' : 'dlna'
}

function toCastDevice(device: DlnaDeviceInfo): CastDevice {
  return {
    id: device.usn,
    protocol: deviceProtocol(device),
    friendlyName: device.friendlyName,
    manufacturer: device.manufacturer,
    modelName: device.modelName,
    location: device.location,
    avTransportUrl: device.avTransportUrl,
    renderingControlUrl: device.renderingControlUrl,
    host: device.host,
    port: device.port,
    lastSeenAt: device.lastSeenAt
  }
}

async function tryDlnaTransport(kind: 'play' | 'pause' | 'stop'): Promise<void> {
  const device = findActiveDevice()
  if (!device) return
  try {
    if (deviceProtocol(device) === 'chromecast') {
      const cast = toCastDevice(device)
      if (kind === 'play') await chromecastPlay(cast)
      else if (kind === 'pause') await chromecastPause(cast)
      else await chromecastStop(cast)
      return
    }
    if (!device.avTransportUrl) return
    if (kind === 'play') await dlnaPlay(device.avTransportUrl)
    else if (kind === 'pause') await dlnaPause(device.avTransportUrl)
    else await dlnaStop(device.avTransportUrl)
  } catch (error) {
    console.warn('[remote] cast transport failed:', error)
  }
}

async function tryDlnaPlayPause(): Promise<void> {
  // Web remote playPause is ambiguous; prefer Play (renderer mirrors toggle).
  await tryDlnaTransport('play')
}

async function tryDlnaSeek(positionSeconds: number): Promise<void> {
  const device = findActiveDevice()
  if (!device) return
  try {
    if (deviceProtocol(device) === 'chromecast') {
      await chromecastSeek(toCastDevice(device), positionSeconds)
      return
    }
    if (!device.avTransportUrl) return
    await dlnaSeek(device.avTransportUrl, positionSeconds)
  } catch (error) {
    console.warn('[remote] cast seek failed:', error)
  }
}

async function tryDlnaVolume(volume: number): Promise<void> {
  const device = findActiveDevice()
  if (!device) return
  try {
    if (deviceProtocol(device) === 'chromecast') {
      await chromecastSetVolume(toCastDevice(device), volume)
      return
    }
    if (!device.renderingControlUrl) return
    await dlnaSetVolume(device.renderingControlUrl, volume)
  } catch (error) {
    console.warn('[remote] cast volume failed:', error)
  }
}

export async function syncRemoteControlWithSettings(): Promise<void> {
  const enabled = runtime.appSettings.remoteControlEnabled === true
  const preferredPort = runtime.appSettings.remoteControlPort ?? 0
  if (syncDesiredEnabled === enabled && server && enabled && !server.isMediaOnly()) {
    // already in desired full-remote state
    return
  }
  syncDesiredEnabled = enabled
  if (!enabled) {
    if (!server) return
    // Keep media token host only while a cast session is active.
    // Orphan mediaOnly binds (failed cast) must not stick around.
    if (activeCastUsn) {
      await server.start(preferredPort, { mode: 'mediaOnly' })
    } else {
      await server.stop()
    }
    return
  }
  const instance = ensureServer()
  // Upgrade media-only cast bind (or start fresh) into full remote control.
  await instance.start(preferredPort, { mode: 'full' })
}

/**
 * Ensure a LAN HTTP bind suitable for issuing cast media tokens.
 * When remote control is off, only the media token surface is exposed.
 */
async function ensureCastMediaServer(): Promise<RemoteHttpServer> {
  const remoteEnabled = runtime.appSettings.remoteControlEnabled === true
  const preferredPort = runtime.appSettings.remoteControlPort ?? 0
  const instance = ensureServer()
  if (remoteEnabled) {
    await instance.start(preferredPort, { mode: 'full' })
  } else {
    await instance.start(preferredPort, { mode: 'mediaOnly' })
  }
  return instance
}

/** Drop mediaOnly bind when no cast session and full remote stays off. */
async function releaseOrphanMediaOnlyServer(): Promise<void> {
  if (activeCastUsn) return
  if (!server?.isMediaOnly()) return
  if (runtime.appSettings.remoteControlEnabled === true) return
  try {
    await server.stop()
  } catch {
    // ignore
  }
}

/** Align with offline download private-host policy for cast upstream proxy. */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const parts = host.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }
  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

export function getRemoteControlStatus(): RemoteControlStatus {
  if (!server) {
    return {
      enabled: runtime.appSettings.remoteControlEnabled === true,
      running: false,
      port: null,
      pin: null,
      urls: [],
      paired: false,
      clientCount: 0,
      lastError: null,
      mediaOnly: false
    }
  }
  return server.getStatus()
}

export function setupRemoteIpc(): void {
  ensureServer()
  const webContents = runtime.mainWindow?.webContents
  if (webContents) {
    const webContentsId = webContents.id
    webContents.once('destroyed', () => rejectRendererRequests(webContentsId))
  }

  ipcMain.handle(
    'remote:rendererResponse',
    async (event, id: unknown, ok: unknown, value: unknown) => {
      assertTrustedIpcSender(event, 'remote renderer response')
      if (typeof id !== 'string') return false
      const pending = rendererRequests.get(id)
      if (!pending || pending.webContentsId !== event.sender.id) return false
      rendererRequests.delete(id)
      clearTimeout(pending.timer)
      if (ok !== true) {
        const message =
          typeof value === 'string' &&
          [
            'queue_changed',
            'queue_item_not_found',
            'track_not_found',
            'playlist_not_found',
            'renderer_not_ready'
          ].includes(value)
            ? value
            : 'renderer_request_failed'
        pending.reject(new RemoteCommandError(message, message === 'queue_changed' ? 409 : 503))
        return true
      }
      pending.resolve(value as RemoteBrowseResult | null)
      return true
    }
  )

  ipcMain.handle('remote:getStatus', async (event) => {
    assertTrustedIpcSender(event, 'remote control IPC')
    return getRemoteControlStatus()
  })

  ipcMain.handle('remote:setEnabled', async (event, enabled: unknown) => {
    assertTrustedIpcSender(event, 'remote control IPC')
    await updateAppSettings({ remoteControlEnabled: enabled === true })
    await syncRemoteControlWithSettings()
    return getRemoteControlStatus()
  })

  ipcMain.handle('remote:rotatePin', async (event) => {
    assertTrustedIpcSender(event, 'remote control IPC')
    const instance = ensureServer()
    const pin = instance.rotatePin()
    return { pin, status: getRemoteControlStatus() }
  })

  ipcMain.handle('remote:publishState', async (event, snapshot: unknown) => {
    assertTrustedIpcSender(event, 'remote control IPC')
    if (!server) return false
    if (!snapshot || typeof snapshot !== 'object') return false
    const partial = snapshot as Partial<RemotePlaybackSnapshot>
    const next = createEmptyRemotePlaybackSnapshot({
      ...server.getPlaybackSnapshot(),
      ...partial,
      castTarget: activeCastUsn
        ? (findActiveDevice()?.friendlyName ?? activeCastUsn)
        : (partial.castTarget ?? null),
      updatedAt: Date.now()
    })
    server.updatePlaybackSnapshot(next)
    return true
  })

  ipcMain.handle('remote:discoverDlna', async (event) => {
    assertTrustedIpcSender(event, 'remote control IPC')
    const [dlna, cast] = await Promise.all([
      discoverDlnaDevices({ timeoutMs: 2500 }),
      discoverChromecastDevices({ timeoutMs: 2500 }).catch(() => [] as CastDevice[])
    ])
    const dlnaMapped: DlnaDeviceInfo[] = dlna.map((d) => ({
      ...d,
      protocol: 'dlna' as const
    }))
    const castMapped: DlnaDeviceInfo[] = cast.map((d) => ({
      usn: d.id,
      friendlyName: d.friendlyName,
      location: d.location,
      manufacturer: d.manufacturer,
      modelName: d.modelName,
      avTransportUrl: null,
      renderingControlUrl: null,
      lastSeenAt: d.lastSeenAt,
      protocol: 'chromecast' as const,
      host: d.host,
      port: d.port
    }))
    lastDlnaDevices = [...dlnaMapped, ...castMapped].sort((a, b) =>
      a.friendlyName.localeCompare(b.friendlyName, 'zh-CN')
    )
    return lastDlnaDevices
  })

  ipcMain.handle('remote:getDlnaDevices', async (event) => {
    assertTrustedIpcSender(event, 'remote control IPC')
    return lastDlnaDevices
  })

  ipcMain.handle(
    'remote:castToDevice',
    async (
      event,
      payload: {
        usn?: unknown
        filePath?: unknown
        /** Direct http(s) stream URL (podcast / radio / provider). Proxied via media token. */
        mediaUrl?: unknown
        contentType?: unknown
        title?: unknown
        artist?: unknown
        album?: unknown
        positionSeconds?: unknown
      }
    ) => {
      assertTrustedIpcSender(event, 'remote control IPC')
      const usn = normalizeIpcString(payload?.usn, 'DLNA device usn', 512)
      const title = typeof payload?.title === 'string' ? payload.title.slice(0, 256) : undefined
      const artist = typeof payload?.artist === 'string' ? payload.artist.slice(0, 256) : undefined
      const album = typeof payload?.album === 'string' ? payload.album.slice(0, 256) : undefined
      const contentTypeHint =
        typeof payload?.contentType === 'string' ? payload.contentType.slice(0, 128) : undefined
      const positionSeconds =
        typeof payload?.positionSeconds === 'number' && Number.isFinite(payload.positionSeconds)
          ? Math.max(0, payload.positionSeconds)
          : 0

      const device = lastDlnaDevices.find((d) => d.usn === usn)
      if (!device) {
        throw new Error('Cast device not found — refresh discovery and try again')
      }
      const protocol = deviceProtocol(device)
      if (protocol === 'dlna' && !device.avTransportUrl) {
        throw new Error('DLNA device missing AVTransport')
      }
      if (protocol === 'chromecast' && !device.host) {
        throw new Error('Chromecast device host is missing')
      }

      const hasFile = typeof payload?.filePath === 'string' && payload.filePath.trim().length > 0
      const hasRemote = typeof payload?.mediaUrl === 'string' && payload.mediaUrl.trim().length > 0
      if (hasFile === hasRemote) {
        throw new Error('Cast requires exactly one of filePath or mediaUrl')
      }

      // Cast needs a media token host. When remote control is off, bind media-only
      // so pair/UI/command surfaces stay closed (remote remains default-off).
      // On failure before activeCastUsn is set, release orphan mediaOnly binds.
      let castSucceeded = false
      try {
        const instance = await ensureCastMediaServer()

        let castUrl: string | null = null
        let didlContentType: string | undefined = contentTypeHint

        if (hasFile) {
          const filePath = normalizeIpcString(payload?.filePath, 'media file path', 4096)
          // Only stream authorized library/managed-cache files.
          const authorizedPath = await resolveAuthorizedAudioFile(filePath)
          castUrl = instance.issueMediaUrl(authorizedPath, title)
          didlContentType = contentTypeHint
        } else {
          const rawUrl = normalizeIpcString(payload?.mediaUrl, 'media stream URL', 8192)
          let upstream = rawUrl
          // Provider streams are exposed to the renderer as twilight-media grants.
          // Resolve them in main so cast never accepts bare untrusted schemes.
          if (rawUrl.startsWith('twilight-media:')) {
            try {
              upstream = remoteMediaGrants.resolve(rawUrl, 'audio').source
            } catch {
              throw new Error('Cast media grant is unknown or expired')
            }
          }
          let parsed: URL
          try {
            parsed = new URL(upstream)
          } catch {
            throw new Error('Cast media URL is invalid')
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('Cast media URL protocol is not authorized')
          }
          if (parsed.username || parsed.password) {
            throw new Error('Cast media URL must not include credentials')
          }
          // Align with offline download: never open-proxy private/loopback hosts.
          if (isPrivateOrLoopbackHost(parsed.hostname)) {
            throw new Error('Cast media URL host is not authorized')
          }
          // Always proxy through our LAN token so the cast device never sees CDN secrets
          // and so private LAN devices can reach sources that need app-side fetch.
          castUrl = instance.issueRemoteMediaUrl(parsed.toString(), {
            title,
            contentType: contentTypeHint
          })
          didlContentType = contentTypeHint
        }

        if (!castUrl) throw new Error('Unable to issue media stream URL')

        if (protocol === 'chromecast') {
          await chromecastLoad(toCastDevice(device), {
            deviceId: device.usn,
            mediaUrl: castUrl,
            title,
            artist,
            album,
            contentType: didlContentType,
            positionSeconds
          })
        } else {
          const metadata = buildDidlLiteMetadata({
            title: title ?? 'Twilight Echo',
            artist,
            album,
            resUrl: castUrl,
            contentType: didlContentType
          })
          await dlnaSetAvTransportUri(device.avTransportUrl!, castUrl, metadata)
          await dlnaPlay(device.avTransportUrl!)
          if (positionSeconds > 1) {
            try {
              await dlnaSeek(device.avTransportUrl!, positionSeconds)
            } catch {
              // Some renderers reject seek before buffering completes.
            }
          }
        }

        activeCastUsn = usn
        castSucceeded = true
        // Pause local engine via renderer.
        sendPlayerCommand('pause')
        return {
          ok: true as const,
          usn,
          friendlyName: device.friendlyName,
          mediaUrl: castUrl
        }
      } finally {
        if (!castSucceeded) {
          await releaseOrphanMediaOnlyServer()
        }
      }
    }
  )

  ipcMain.handle('remote:stopCast', async (event) => {
    assertTrustedIpcSender(event, 'remote control IPC')
    if (activeCastUsn) {
      await tryDlnaTransport('stop')
    }
    activeCastUsn = null
    // Tear down media-only cast bind when full remote control remains off.
    if (server?.isMediaOnly() && runtime.appSettings.remoteControlEnabled !== true) {
      try {
        await server.stop()
      } catch {
        // ignore
      }
    }
    return { ok: true as const }
  })

  ipcMain.handle('remote:getCastTarget', async (event) => {
    assertTrustedIpcSender(event, 'remote control IPC')
    if (!activeCastUsn) return null
    const device = findActiveDevice()
    return device
      ? { usn: device.usn, friendlyName: device.friendlyName }
      : { usn: activeCastUsn, friendlyName: activeCastUsn }
  })

  /**
   * Fan-out in-app transport/volume to the active DLNA renderer while casting.
   * Local engine stays paused; renderer still tracks UI position/volume state.
   */
  ipcMain.handle(
    'remote:controlCast',
    async (
      event,
      payload: {
        seek?: unknown
        volume?: unknown
        pause?: unknown
        play?: unknown
      }
    ) => {
      assertTrustedIpcSender(event, 'remote control IPC')
      if (!activeCastUsn) return { ok: false as const, reason: 'no-active-cast' as const }
      if (payload?.seek !== undefined) {
        const seek =
          typeof payload.seek === 'number' && Number.isFinite(payload.seek)
            ? Math.max(0, payload.seek)
            : null
        if (seek === null) throw new Error('Cast seek position is invalid')
        await tryDlnaSeek(seek)
      }
      if (payload?.volume !== undefined) {
        const volume =
          typeof payload.volume === 'number' && Number.isFinite(payload.volume)
            ? Math.min(1, Math.max(0, payload.volume))
            : null
        if (volume === null) throw new Error('Cast volume is invalid')
        await tryDlnaVolume(volume)
      }
      if (payload?.pause === true) await tryDlnaTransport('pause')
      if (payload?.play === true) await tryDlnaTransport('play')
      return { ok: true as const }
    }
  )

  void syncRemoteControlWithSettings().catch((error) => {
    console.warn('[remote] initial sync failed:', error)
  })
}

export async function destroyRemoteIpc(): Promise<void> {
  rejectRendererRequests()
  activeCastUsn = null
  lastDlnaDevices = []
  syncDesiredEnabled = null
  if (server) {
    try {
      await server.stop()
    } catch {
      // ignore
    }
  }
  server = null
}
