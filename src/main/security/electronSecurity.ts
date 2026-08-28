import { app, session, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron'

const NCM_API_ORIGINS = ['http://localhost:3100', 'http://127.0.0.1:3100']

export function installElectronSecurity(): void {
  installSessionSecurity(session.defaultSession)
}

export function installSessionSecurity(targetSession: Session): void {
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  targetSession.setPermissionCheckHandler(() => false)

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    if (!shouldApplyDocumentSecurityHeaders(details)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }

    callback({
      responseHeaders: {
        ...withoutHeader(details.responseHeaders, 'content-security-policy'),
        'Content-Security-Policy': [contentSecurityPolicyForUrl(details.url)],
        'X-Content-Type-Options': ['nosniff'],
        'Referrer-Policy': ['no-referrer'],
        'Permissions-Policy': [
          'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()'
        ]
      }
    })
  })
}

function shouldApplyDocumentSecurityHeaders(
  details: Electron.OnHeadersReceivedListenerDetails
): boolean {
  if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return false
  return isAppDocumentUrl(details.url) || isAudioVisualizerDocumentUrl(details.url)
}

function contentSecurityPolicyForUrl(url: string): string {
  if (isAudioVisualizerDocumentUrl(url)) {
    return [
      "default-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "frame-ancestors 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: cover: background: theme-asset: twilight-media:",
      "font-src 'self' data: theme-asset:",
      "media-src 'none'",
      "connect-src 'self'",
      "worker-src 'none'",
      "form-action 'none'"
    ].join('; ')
  }

  const connectSrc = ["'self'", ...NCM_API_ORIGINS]
  if (isDevRendererUrl(url)) {
    connectSrc.push(
      'ws://localhost:*',
      'ws://127.0.0.1:*',
      'http://localhost:*',
      'http://127.0.0.1:*'
    )
  }

  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    // Allow the bundled audio visualizer surface and other same-origin app frames.
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: cover: background: theme-asset: twilight-media:",
    "font-src 'self' data: theme-asset:",
    "media-src 'self' blob: twilight-audio: twilight-media:",
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self' blob:",
    "form-action 'none'"
  ].join('; ')
}

function withoutHeader(
  headers: Record<string, string[] | undefined> | undefined,
  headerName: string
): Record<string, string[] | undefined> {
  const filtered: Record<string, string[] | undefined> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== headerName.toLowerCase()) filtered[key] = value
  }
  return filtered
}

function isAppDocumentUrl(url: string): boolean {
  return isDevRendererUrl(url) || /\/renderer\/index\.html(?:[#?].*)?$/i.test(url)
}

function isAudioVisualizerDocumentUrl(url: string): boolean {
  return /\/audio-visualizer\/index\.html(?:[#?].*)?$/i.test(url)
}

function isDevRendererUrl(url: string): boolean {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!rendererUrl) return false
  try {
    return new URL(url).origin === new URL(rendererUrl).origin
  } catch {
    return false
  }
}

export function isTrustedIpcSenderUrl(url: string): boolean {
  // The desktop lyrics window is now the shared renderer document with a `window`
  // query, so it is covered by isAppDocumentUrl and needs no exception of its own
  // (which is also what let its old inline-script CSP allowance go away).
  if (isAppDocumentUrl(url)) return true
  if (url.startsWith('file://') && app.isPackaged) return isAppDocumentUrl(url)
  return false
}

export function assertTrustedIpcSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  capability = 'IPC'
): void {
  if (isTrustedIpcSender(event)) return
  throw new Error(`${capability} rejected from untrusted sender`)
}

export function isTrustedIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url
  if (frameUrl && isTrustedIpcSenderUrl(frameUrl)) return true
  const contentsUrl = event.sender.getURL()
  return Boolean(contentsUrl && isTrustedIpcSenderUrl(contentsUrl))
}

export function shouldAcceptIpcEvent(
  event: IpcMainEvent | IpcMainInvokeEvent,
  capability = 'IPC'
): boolean {
  if (isTrustedIpcSender(event)) return true
  console.warn(`${capability} rejected from untrusted sender`)
  return false
}
