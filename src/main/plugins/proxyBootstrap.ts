// The plugin utility process uses this module before loading plugin code.
// ProxyAgent owns CONNECT/TLS transport; this module owns fetch redirect and
// fallback policy so those security decisions stay explicit and testable.

import { connect as netConnect } from 'net'
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'

const COMMON_PROXY_PORTS = [7897, 7890, 7891, 1080, 10809, 8080, 2080, 7898]
const DEFAULT_MAX_REDIRECTS = 5
const PROXY_CONNECT_TIMEOUT_MS = 10_000
const PROXY_HEADERS_TIMEOUT_MS = 15_000
const MAX_PROXY_RESPONSE_HEADER_BYTES = 16 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CROSS_ORIGIN_SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'referer'
]
const REQUEST_BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type'
]

type PluginProxyMode = 'auto' | 'custom' | 'off'

interface DetectedProxy {
  url: string
  source: 'environment' | 'local-probe'
}

interface TransportRequestInit {
  method: string
  headers: Headers
  body?: Uint8Array<ArrayBuffer>
  redirect: 'manual'
  signal: AbortSignal
}

export type ProxyFetchTransport = (url: string, init: TransportRequestInit) => Promise<Response>

export interface SecureProxyFetchOptions {
  proxyRequest: ProxyFetchTransport
  directRequest: ProxyFetchTransport
  passthroughFetch: typeof fetch
  allowDirectFallback?: boolean
  maxRedirects?: number
}

export interface InstalledProxyFetch {
  fetch: typeof fetch
  close: () => Promise<void>
}

export interface PluginProxySettings {
  proxyMode: PluginProxyMode
  proxyHost: string
  proxyPort: number
  proxyAllowDirectFallback: boolean
}

const STANDARD_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
] as const

export function buildPluginProxyEnv(settings: PluginProxySettings): Record<string, string> {
  const result: Record<string, string> = {
    TWILIGHT_PLUGIN_PROXY_MODE: settings.proxyMode,
    TWILIGHT_PLUGIN_PROXY_ALLOW_DIRECT_FALLBACK: settings.proxyAllowDirectFallback ? '1' : '0'
  }

  if (settings.proxyMode === 'off') {
    result.TWILIGHT_PLUGIN_PROXY_URL = ''
    for (const key of STANDARD_PROXY_ENV_KEYS) result[key] = ''
    return result
  }

  if (settings.proxyMode === 'custom') {
    const proxyUrl =
      settings.proxyHost && settings.proxyPort > 0
        ? normalizeProxyUrl(`http://${settings.proxyHost}:${settings.proxyPort}`)
        : ''
    result.TWILIGHT_PLUGIN_PROXY_URL = proxyUrl
    for (const key of STANDARD_PROXY_ENV_KEYS) result[key] = proxyUrl
    result.NO_PROXY = 'localhost,127.0.0.1,::1'
    result.no_proxy = result.NO_PROXY
  }

  return result
}

function parseProxyMode(value: string | undefined): PluginProxyMode {
  return value === 'off' || value === 'custom' ? value : 'auto'
}

function parseExplicitBoolean(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function normalizeProxyUrl(value: string): string {
  const raw = value.trim()
  if (!raw) throw new Error('Plugin proxy URL is empty')

  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported plugin proxy protocol: ${parsed.protocol}`)
  }
  if (!parsed.hostname) throw new Error('Plugin proxy URL must include a hostname')
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Plugin proxy URL must not include a path, query, or fragment')
  }
  return parsed.href
}

function proxyLabel(proxyUrl: string): string {
  const parsed = new URL(proxyUrl)
  const defaultPort = parsed.protocol === 'https:' ? '443' : '80'
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port || defaultPort}`
}

function isPortOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(port, host)
    let settled = false
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function testProxyTunnel(
  host: string,
  port: number,
  target: string,
  timeoutMs = 5000
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(port, host)
    let settled = false
    let response = Buffer.alloc(0)
    const finish = (accepted: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(accepted)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\n\r\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk])
      if (response.length > MAX_PROXY_RESPONSE_HEADER_BYTES) {
        finish(false)
        return
      }
      const headerEnd = response.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const statusLine = response.subarray(0, headerEnd).toString('latin1').split('\r\n', 1)[0]
      finish(/^HTTP\/1\.[01] 2\d\d(?:\s|$)/.test(statusLine))
    })
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(false))
  })
}

function environmentProxyUrl(env: NodeJS.ProcessEnv): string | null {
  const value =
    env.TWILIGHT_PLUGIN_PROXY_URL ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy
  return value ? normalizeProxyUrl(value) : null
}

async function detectProxy(
  mode: PluginProxyMode,
  env: NodeJS.ProcessEnv = process.env
): Promise<DetectedProxy | null> {
  if (mode === 'off') return null

  const configuredProxy =
    mode === 'custom'
      ? env.TWILIGHT_PLUGIN_PROXY_URL
        ? normalizeProxyUrl(env.TWILIGHT_PLUGIN_PROXY_URL)
        : null
      : environmentProxyUrl(env)
  if (configuredProxy) {
    console.log(`[proxy] Using configured proxy ${proxyLabel(configuredProxy)}`)
    return { url: configuredProxy, source: 'environment' }
  }
  if (mode === 'custom') {
    throw new Error('Custom plugin proxy mode requires a valid proxy host and port')
  }

  for (const port of COMMON_PROXY_PORTS) {
    if (!(await isPortOpen('127.0.0.1', port))) continue
    if (await testProxyTunnel('127.0.0.1', port, 'www.youtube.com')) {
      const url = `http://127.0.0.1:${port}`
      console.log(`[proxy] Detected local proxy ${proxyLabel(url)}`)
      return { url, source: 'local-probe' }
    }
  }

  console.log('[proxy] No proxy detected; plugin requests will use direct connections')
  return null
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true
  }
  const octets = normalized.split('.')
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  )
}

function shouldProxyUrl(url: URL): boolean {
  return url.protocol === 'https:' && !isLoopbackHostname(url.hostname)
}

function assertSafeRedirectTarget(currentUrl: URL, location: string): URL {
  let target: URL
  try {
    target = new URL(location, currentUrl)
  } catch {
    throw new TypeError('Proxy response contains an invalid redirect URL')
  }

  if (target.username || target.password) {
    throw new TypeError('Redirect URLs containing credentials are not allowed')
  }
  if (currentUrl.protocol === 'https:' && target.protocol !== 'https:') {
    throw new TypeError('Plugin proxy blocked an HTTPS redirect downgrade')
  }
  if (target.protocol !== 'https:') {
    throw new TypeError(`Plugin proxy blocked redirect protocol ${target.protocol}`)
  }
  return target
}

function stripCrossOriginCredentials(headers: Headers): void {
  for (const name of CROSS_ORIGIN_SENSITIVE_HEADERS) headers.delete(name)
}

function redirectMethod(status: number, method: string): string {
  if (status === 303 && method !== 'HEAD') return 'GET'
  if ((status === 301 || status === 302) && method === 'POST') return 'GET'
  return method
}

async function discardRedirectResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The security decision is already made; body cleanup errors are non-fatal.
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function transportError(error: unknown): TypeError {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? ` (${error.code})`
      : ''
  return new TypeError(`Plugin proxy request failed${code}; direct fallback is disabled`, {
    cause: error
  })
}

async function sendWithProxyPolicy(
  url: string,
  init: TransportRequestInit,
  options: SecureProxyFetchOptions
): Promise<Response> {
  throwIfAborted(init.signal)
  try {
    return await options.proxyRequest(url, init)
  } catch (error) {
    if (init.signal.aborted) throw abortReason(init.signal)
    if (!options.allowDirectFallback) throw transportError(error)

    console.warn('[proxy] Proxy request failed; using explicitly enabled direct fallback')
    throwIfAborted(init.signal)
    return await options.directRequest(url, init)
  }
}

async function bufferRequestBody(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body || request.method === 'GET' || request.method === 'HEAD') return undefined
  return new Uint8Array(await request.arrayBuffer())
}

export function createSecureProxyFetch(options: SecureProxyFetchOptions): typeof fetch {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new RangeError('maxRedirects must be an integer between 0 and 20')
  }

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inputUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    let parsedInput: URL
    try {
      parsedInput = new URL(inputUrl)
    } catch {
      return await options.passthroughFetch(input, init)
    }
    if (parsedInput.protocol !== 'https:') return await options.passthroughFetch(input, init)

    const request = new Request(input, init)
    const signal = request.signal
    throwIfAborted(signal)

    let currentUrl = parsedInput
    let method = request.method
    let headers = new Headers(request.headers)
    headers.delete('host')
    let body = await bufferRequestBody(request)
    let redirects = 0

    while (true) {
      throwIfAborted(signal)
      const transportInit = { method, headers, body, redirect: 'manual' as const, signal }
      const response = shouldProxyUrl(currentUrl)
        ? await sendWithProxyPolicy(currentUrl.href, transportInit, options)
        : await options.directRequest(currentUrl.href, transportInit)
      const location = response.headers.get('location')
      if (!REDIRECT_STATUSES.has(response.status) || !location) return response

      if (request.redirect === 'manual') return response
      await discardRedirectResponse(response)
      if (request.redirect === 'error') {
        throw new TypeError('Redirect encountered while redirect mode is set to error')
      }
      if (redirects >= maxRedirects) {
        throw new TypeError(`Plugin proxy exceeded the ${maxRedirects}-redirect limit`)
      }

      const targetUrl = assertSafeRedirectTarget(currentUrl, location)
      const nextHeaders = new Headers(headers)
      if (targetUrl.origin !== currentUrl.origin) stripCrossOriginCredentials(nextHeaders)

      const nextMethod = redirectMethod(response.status, method)
      if (nextMethod !== method) {
        body = undefined
        for (const name of REQUEST_BODY_HEADERS) nextHeaders.delete(name)
      }

      redirects += 1
      currentUrl = targetUrl
      method = nextMethod
      headers = nextHeaders
    }
  }) as typeof fetch
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, name) => {
    result[name] = value
  })
  return result
}

export function installProxyFetch(
  proxyUrl: string,
  originalFetch: typeof fetch,
  allowDirectFallback = false
): InstalledProxyFetch {
  const dispatcher = new ProxyAgent({
    uri: normalizeProxyUrl(proxyUrl),
    connectTimeout: PROXY_CONNECT_TIMEOUT_MS,
    headersTimeout: PROXY_HEADERS_TIMEOUT_MS
  })
  const directRequest: ProxyFetchTransport = (url, init) =>
    originalFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
      signal: init.signal
    })
  const proxyRequest: ProxyFetchTransport = async (url, init) => {
    const undiciInit: UndiciRequestInit = {
      method: init.method,
      headers: headersToRecord(init.headers),
      body: init.body,
      redirect: 'manual',
      signal: init.signal,
      dispatcher
    }
    return (await undiciFetch(url, undiciInit)) as unknown as Response
  }

  return {
    fetch: createSecureProxyFetch({
      proxyRequest,
      directRequest,
      passthroughFetch: originalFetch,
      allowDirectFallback
    }),
    close: () => dispatcher.close()
  }
}

let initialized = false

export async function initProxy(): Promise<void> {
  if (initialized) return
  initialized = true

  const mode = parseProxyMode(process.env.TWILIGHT_PLUGIN_PROXY_MODE)
  if (mode === 'off') {
    console.log('[proxy] Plugin proxy is disabled by application settings')
    return
  }

  const proxy = await detectProxy(mode)
  if (!proxy) return

  const allowDirectFallback = parseExplicitBoolean(
    process.env.TWILIGHT_PLUGIN_PROXY_ALLOW_DIRECT_FALLBACK
  )
  const originalFetch = globalThis.fetch.bind(globalThis)
  const installed = installProxyFetch(proxy.url, originalFetch, allowDirectFallback)
  globalThis.fetch = installed.fetch

  console.log(
    `[proxy] External HTTPS fetch uses ${proxyLabel(proxy.url)}; direct fallback ${
      allowDirectFallback ? 'enabled' : 'disabled'
    }`
  )
}
