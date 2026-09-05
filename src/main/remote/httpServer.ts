import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { networkInterfaces } from 'node:os'
import { app } from 'electron'
import { RemoteAuthSession } from './auth.ts'
import { MediaStreamGrantStore, guessAudioContentType } from './mediaTokens.ts'
import {
  createEmptyRemotePlaybackSnapshot,
  isPrivateOrLocalIp,
  parseRemoteBrowseRequest,
  parseRemotePlayerCommand,
  type RemoteBrowseRequest,
  type RemoteBrowseResult,
  type PlayerRemoteCommand,
  type RemoteControlStatus,
  type RemotePlaybackSnapshot
} from '../../shared/remoteControl.ts'
import { REMOTE_SSE_HEARTBEAT_MS } from '../../shared/remoteControl.ts'
import { parseJsonWithNestingLimit } from '../security/jsonSafety.ts'

export type RemoteServerMode = 'full' | 'mediaOnly'

export type RemoteCommandHandler = (command: PlayerRemoteCommand) => Promise<void> | void
export type RemoteBrowseHandler = (request: RemoteBrowseRequest) => Promise<RemoteBrowseResult>

export class RemoteCommandError extends Error {
  readonly status: number

  constructor(message: string, status = 503) {
    super(message)
    this.status = status
  }
}

export interface RemoteHttpServerOptions {
  staticRoot?: string
  onCommand?: RemoteCommandHandler
  onBrowse?: RemoteBrowseHandler
  auth?: RemoteAuthSession
  mediaGrants?: MediaStreamGrantStore
  preferredPort?: number
}

export class RemoteHttpServer {
  private server: Server | null = null
  private port: number | null = null
  /** Full remote-control surface (pair/UI/commands). False in mediaOnly cast mode. */
  private enabled = false
  private mode: RemoteServerMode = 'full'
  private lastError: string | null = null
  private readonly auth: RemoteAuthSession
  private readonly mediaGrants: MediaStreamGrantStore
  private readonly staticRoot: string
  private onCommand: RemoteCommandHandler | null
  private onBrowse: RemoteBrowseHandler | null
  private snapshot: RemotePlaybackSnapshot = createEmptyRemotePlaybackSnapshot()
  private readonly sseClients = new Set<ServerResponse>()
  /** S3: SSE 长连接上限，防止局域网内开大量 /api/events 耗尽资源。 */
  private readonly sseMaxClients = 8
  private browseInFlight = 0
  private readonly maxBrowseInFlight = 2
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: RemoteHttpServerOptions = {}) {
    this.auth = options.auth ?? new RemoteAuthSession()
    this.mediaGrants = options.mediaGrants ?? new MediaStreamGrantStore()
    this.staticRoot = options.staticRoot ?? join(app.getAppPath(), 'resources', 'remote')
    this.onCommand = options.onCommand ?? null
    this.onBrowse = options.onBrowse ?? null
  }

  setCommandHandler(handler: RemoteCommandHandler | null): void {
    this.onCommand = handler
  }

  setBrowseHandler(handler: RemoteBrowseHandler | null): void {
    this.onBrowse = handler
  }

  getAuth(): RemoteAuthSession {
    return this.auth
  }

  getMediaGrants(): MediaStreamGrantStore {
    return this.mediaGrants
  }

  isMediaOnly(): boolean {
    return this.mode === 'mediaOnly' && this.server != null
  }

  getStatus(): RemoteControlStatus {
    const mediaOnly = this.mode === 'mediaOnly' && this.server != null
    return {
      // "enabled" means full remote control is on — never true for media-only cast.
      enabled: this.enabled && !mediaOnly,
      running: this.server != null && this.port != null,
      port: this.port,
      pin: this.enabled && !mediaOnly ? this.auth.getPin() : null,
      urls: this.enabled && !mediaOnly && this.port != null ? this.listLanUrls(this.port) : [],
      paired: this.enabled && !mediaOnly ? this.auth.isPaired() : false,
      clientCount: this.sseClients.size,
      lastError: this.lastError,
      mediaOnly
    }
  }

  updatePlaybackSnapshot(snapshot: RemotePlaybackSnapshot): void {
    const coverChanged = this.snapshot.coverUrl !== snapshot.coverUrl
    this.snapshot = { ...snapshot, updatedAt: Date.now() }
    if (coverChanged) this.broadcastSse('state', this.snapshot)
    else {
      const { coverUrl: _coverUrl, ...state } = this.snapshot
      this.broadcastSse('state', state)
    }
  }

  getPlaybackSnapshot(): RemotePlaybackSnapshot {
    return this.snapshot
  }

  /**
   * Bind the LAN HTTP server.
   * - full: remote UI, PIN pair, command API, media tokens
   * - mediaOnly: media tokens only (cast), no pair/UI/commands; remote stays "off"
   *
   * Mode switches on an already-bound server are in-place: media grants are kept
   * so active cast `/media/{token}` URLs survive remote on/off toggles.
   */
  async start(
    preferredPort = 0,
    options: { mode?: RemoteServerMode } = {}
  ): Promise<RemoteControlStatus> {
    const desiredMode: RemoteServerMode = options.mode ?? 'full'
    if (this.server) {
      if (this.mode === desiredMode) return this.getStatus()
      this.applyMode(desiredMode)
      return this.getStatus()
    }
    this.applyMode(desiredMode)
    this.lastError = null

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      server.on('error', (error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        reject(error)
      })
      server.listen(preferredPort, '0.0.0.0', () => {
        const address = server.address()
        this.port = address && typeof address === 'object' ? address.port : preferredPort || null
        this.server = server
        if (desiredMode === 'full') this.startHeartbeat()
        resolve()
      })
    })

    return this.getStatus()
  }

  private resolveAllowedOrigin(origin: string | undefined, host: string): string | null {
    if (!origin) return null
    try {
      const parsed = new URL(origin)
      if (parsed.host === host) return parsed.origin
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return parsed.origin
    } catch {
      return null
    }
    return null
  }

  /**
   * Switch surface mode without closing the socket or clearing media grants.
   * Demoting full → mediaOnly revokes remote pair sessions and drops SSE clients.
   */
  applyMode(desiredMode: RemoteServerMode): void {
    const previous = this.mode
    this.mode = desiredMode
    this.enabled = desiredMode === 'full'
    this.lastError = null
    if (desiredMode === 'full') {
      if (!this.auth.getPin()) this.auth.rotatePin()
      if (this.server) this.startHeartbeat()
      return
    }
    // mediaOnly: close remote-control surface only.
    this.stopHeartbeat()
    for (const client of this.sseClients) {
      try {
        client.end()
      } catch {
        // ignore
      }
    }
    this.sseClients.clear()
    // Revoke pair tokens when leaving full mode; keep cast media grants.
    if (previous === 'full') this.auth.revokeToken()
  }

  async stop(): Promise<void> {
    this.enabled = false
    this.mode = 'full'
    this.stopHeartbeat()
    for (const client of this.sseClients) {
      try {
        client.end()
      } catch {
        // ignore
      }
    }
    this.sseClients.clear()
    this.mediaGrants.clear()
    this.auth.revokeToken()

    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  rotatePin(): string {
    const pin = this.auth.rotatePin()
    this.broadcastSse('auth', { paired: false })
    return pin
  }

  issueMediaUrl(filePath: string, title?: string): string | null {
    if (!this.port) return null
    const token = this.mediaGrants.issueFile(filePath, {
      contentType: guessAudioContentType(filePath),
      title
    })
    return this.mediaUrlForToken(token)
  }

  /** Proxy an upstream http(s) audio URL through the LAN media token endpoint. */
  issueRemoteMediaUrl(
    remoteUrl: string,
    options: { title?: string; contentType?: string } = {}
  ): string | null {
    if (!this.port) return null
    const token = this.mediaGrants.issueRemote(remoteUrl, {
      contentType: options.contentType ?? guessAudioContentType(remoteUrl),
      title: options.title
    })
    return this.mediaUrlForToken(token)
  }

  private mediaUrlForToken(token: string): string | null {
    if (!this.port) return null
    const host = this.listLanUrls(this.port)[0]
    if (!host) return null
    return `${host}/media/${token}`
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.broadcastSse('ping', { t: Date.now() })
    }, REMOTE_SSE_HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private listLanUrls(port: number): string[] {
    const urls = new Set<string>()
    const nets = networkInterfaces()
    for (const entries of Object.values(nets)) {
      if (!entries) continue
      for (const entry of entries) {
        if (entry.internal) continue
        const family = String(entry.family)
        if (family !== 'IPv4' && family !== '4') continue
        if (!isPrivateOrLocalIp(entry.address)) continue
        urls.add(`http://${entry.address}:${port}`)
      }
    }
    if (urls.size === 0) urls.add(`http://127.0.0.1:${port}`)
    return Array.from(urls)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? `127.0.0.1:${this.port ?? 0}`
      const url = new URL(req.url ?? '/', `http://${host}`)
      const remoteIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '')
      if (remoteIp && !isPrivateOrLocalIp(remoteIp) && remoteIp !== '::1') {
        this.sendJson(res, 403, { error: 'lan_only' })
        return
      }

      // S2: CORS 不再无条件 `*`，仅当 Origin 与本服务同源（或本机回环）时回显。
      // 任意第三方网页跨源读取将被浏览器拦截。
      ;(res as ServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin =
        this.resolveAllowedOrigin(req.headers.origin, host)

      if (req.method === 'OPTIONS') {
        res.writeHead(
          204,
          corsHeaders((res as ServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin)
        )
        res.end()
        return
      }

      // Media-only cast bind: only capability-token media streaming is exposed.
      if (this.mode === 'mediaOnly') {
        if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
          const token = url.pathname.slice('/media/'.length)
          await this.serveMedia(req, res, token)
          return
        }
        this.sendJson(res, 404, { error: 'media_only' })
        return
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        this.serveStatic(res, 'index.html')
        return
      }
      if (req.method === 'GET' && url.pathname === '/remote.js') {
        this.serveStatic(res, 'remote.js', 'application/javascript; charset=utf-8')
        return
      }
      if (req.method === 'GET' && url.pathname === '/remote.css') {
        this.serveStatic(res, 'remote.css', 'text/css; charset=utf-8')
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        this.sendJson(res, 200, {
          requiresPairing: true,
          paired: this.auth.isPaired(),
          app: 'Twilight Echo'
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const body = await readJsonBody(req)
        const pin = typeof body?.pin === 'string' ? body.pin : ''
        const result = this.auth.pair(pin)
        if (!result.ok) {
          this.sendJson(res, 401, { error: result.reason })
          return
        }
        this.sendJson(res, 200, { token: result.token })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        this.sendJson(res, 200, this.snapshot)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        this.attachSse(res)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/browse') {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        const browse = parseRemoteBrowseRequest(url.searchParams)
        if (!browse) {
          this.sendJson(res, 400, { error: 'invalid_browse_request' })
          return
        }
        if (!this.onBrowse) {
          this.sendJson(res, 503, { error: 'browse_handler_missing' })
          return
        }
        if (this.browseInFlight >= this.maxBrowseInFlight) {
          this.sendJson(res, 429, { error: 'browse_busy' })
          return
        }
        this.browseInFlight++
        try {
          const result = await this.onBrowse(browse)
          this.sendJson(res, 200, result)
        } finally {
          this.browseInFlight--
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/command') {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        if (!this.auth.tryConsumeCommand()) {
          this.sendJson(res, 429, { error: 'rate_limited' })
          return
        }
        const body = await readJsonBody(req)
        const command = parseRemotePlayerCommand(body)
        if (!command) {
          this.sendJson(res, 400, { error: 'invalid_command' })
          return
        }
        if (!this.onCommand) {
          this.sendJson(res, 503, { error: 'command_handler_missing' })
          return
        }
        await this.onCommand(command)
        this.sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
        const token = url.pathname.slice('/media/'.length)
        await this.serveMedia(req, res, token)
        return
      }

      this.sendJson(res, 404, { error: 'not_found' })
    } catch (error) {
      if (error instanceof RemoteCommandError) {
        this.sendJson(res, error.status, { error: error.message })
        return
      }
      this.sendJson(res, 500, { error: 'remote_request_failed' })
    }
  }

  private authorize(req: IncomingMessage, url: URL): boolean {
    if (this.auth.authorizeBearer(req.headers.authorization)) return true
    return this.auth.authorizeTokenQuery(url.searchParams.get('token'))
  }

  private attachSse(res: ServerResponse): void {
    // S3: 超过上限直接 429 拒绝，避免无限长连接。
    if (this.sseClients.size >= this.sseMaxClients) {
      this.sendJson(res, 429, { error: 'too_many_event_connections' })
      return
    }
    const origin = (res as ServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin
    res.writeHead(200, {
      ...corsHeaders(origin),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    })
    res.write(`event: state\ndata: ${JSON.stringify(this.snapshot)}\n\n`)
    this.sseClients.add(res)
    reqOnClose(res, () => {
      this.sseClients.delete(res)
    })
  }

  private broadcastSse(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.sseClients) {
      try {
        client.write(payload)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  private serveStatic(
    res: ServerResponse,
    fileName: string,
    contentType = 'text/html; charset=utf-8'
  ): void {
    const path = join(this.staticRoot, fileName)
    if (!existsSync(path)) {
      this.sendJson(res, 404, { error: 'static_missing', fileName })
      return
    }
    const body = readFileSync(path)
    res.writeHead(200, {
      ...corsHeaders((res as ServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin),
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-cache'
    })
    res.end(body)
  }

  private async serveMedia(
    req: IncomingMessage,
    res: ServerResponse,
    token: string
  ): Promise<void> {
    const grant = this.mediaGrants.resolve(token)
    if (!grant) {
      this.sendJson(res, 404, { error: 'media_token_invalid' })
      return
    }

    if (grant.kind === 'remote' && grant.remoteUrl) {
      await this.proxyRemoteMedia(req, res, grant.remoteUrl, grant.contentType)
      return
    }

    const filePath = grant.filePath
    if (!filePath) {
      this.sendJson(res, 404, { error: 'media_missing' })
      return
    }

    let stat
    try {
      stat = statSync(filePath)
    } catch {
      this.sendJson(res, 404, { error: 'media_missing' })
      return
    }
    if (!stat.isFile()) {
      this.sendJson(res, 404, { error: 'media_missing' })
      return
    }

    const total = stat.size
    const range = req.headers.range
    const type = grant.contentType || guessAudioContentType(filePath)

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range)
      if (!match) {
        res.writeHead(416, { 'content-range': `bytes */${total}` })
        res.end()
        return
      }
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Number(match[2]) : total - 1
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end >= total ||
        start > end
      ) {
        res.writeHead(416, { 'content-range': `bytes */${total}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${total}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
      })
      createReadStream(filePath, { start, end }).pipe(res)
      return
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': total,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store'
    })
    createReadStream(filePath).pipe(res)
  }

  /**
   * Proxy upstream http(s) media to the DLNA renderer. Never expose the
   * original URL (may contain CDN tokens). Rejects redirects and non-audio types.
   */
  private async proxyRemoteMedia(
    req: IncomingMessage,
    res: ServerResponse,
    remoteUrl: string,
    fallbackContentType: string
  ): Promise<void> {
    const headers: Record<string, string> = {
      'user-agent': 'TwilightEcho-CastProxy/1.0',
      accept: 'audio/*,application/ogg,application/octet-stream,*/*'
    }
    const range = req.headers.range
    if (typeof range === 'string' && range) headers.range = range

    let upstream: Response
    try {
      upstream = await fetch(remoteUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(120_000)
      })
    } catch {
      this.sendJson(res, 502, { error: 'upstream_fetch_failed' })
      return
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      this.sendJson(res, 502, { error: 'upstream_redirect_rejected' })
      return
    }
    if (!upstream.ok && upstream.status !== 206) {
      this.sendJson(res, 502, { error: 'upstream_http_error', status: upstream.status })
      return
    }

    const contentType =
      upstream.headers.get('content-type') || fallbackContentType || 'application/octet-stream'
    const outHeaders: Record<string, string | number> = {
      'content-type': contentType,
      'cache-control': 'no-store',
      'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes'
    }
    for (const name of ['content-length', 'content-range'] as const) {
      const value = upstream.headers.get(name)
      if (value) outHeaders[name] = value
    }

    res.writeHead(upstream.status, outHeaders)

    if (!upstream.body) {
      res.end()
      return
    }

    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve))
        }
        if (res.destroyed || res.writableEnded) {
          await reader.cancel()
          return
        }
      }
      res.end()
    } catch {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
      if (!res.writableEnded) res.end()
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(status, {
      ...corsHeaders((res as ServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': payload.length
    })
    res.end(payload)
  }
}

/**
 * S2: 仅当 Origin 通过同源/回环校验时回显；无 Origin（curl/原生客户端/同源导航）
 * 不需要 CORS 头。跨源网页读取将被浏览器拦截。
 */
function corsHeaders(origin?: string | null): Record<string, string> {
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin'
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null)
        return
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = parseJsonWithNestingLimit(text) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          resolve(null)
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        resolve(null)
      }
    })
    req.on('error', reject)
  })
}

function reqOnClose(res: ServerResponse, cb: () => void): void {
  res.on('close', cb)
  res.on('error', cb)
}

// Silence unused import warning for extname in case static root uses it later.
void extname
