import { app, BrowserWindow, session, shell, ipcMain } from 'electron'
import { isSafeExternalUrl } from '../security/externalUrl.ts'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { runtime } from '../core/runtime'
import { getCachedNcmSong, cacheNcmSong } from '../cache/ncmCache'
import { redactSensitiveText } from '../security/secureStorage.ts'
import {
  normalizeInteger,
  normalizeIpcString,
  normalizeOptionalIpcString
} from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { setupNcmCloudTransferIpc } from './cloudTransfer.ts'

export const NCM_API_PORT = 3100
export const NCM_API_HOST = '127.0.0.1'
export const NCM_OFFICIAL_LOGIN_TIMEOUT_MS = 180000
export const NCM_API_REQUEST_TIMEOUT_MS = 25000
const MAX_NCM_API_PATH_LENGTH = 4096
const MAX_NCM_COOKIE_LENGTH = 16 * 1024
const MAX_NCM_REMOTE_URL_LENGTH = 8192
const MAX_NCM_CACHE_FILENAME_LENGTH = 255
const NCM_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface NcmApiRequestOptions {
  signal?: AbortSignal
  /** Forwarded to the local API gateway when it supports idempotent writes. */
  idempotencyKey?: string
}

export function bundledPluginPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'plugins', name)
    : join(process.cwd(), 'resources', 'plugins', name)
}

export function bundledPluginIndexPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'plugin-index', 'plugins.json')
    : join(process.cwd(), 'resources', 'plugin-index', 'plugins.json')
}

export async function requestNcmApi(
  path: string,
  cookie?: string,
  options: NcmApiRequestOptions = {}
): Promise<unknown> {
  const normalizedPath = normalizeNcmApiPath(path)
  if (!normalizedPath) {
    return { code: -1, message: 'Invalid NetEase API path' }
  }
  try {
    await ensureNcmServer()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('网易云音乐服务启动失败：', redactSensitiveText(message))
    return { code: -1, message }
  }
  const sep = normalizedPath.includes('?') ? '&' : '?'
  const url = `http://${NCM_API_HOST}:${NCM_API_PORT}${normalizedPath}${sep}timestamp=${Date.now()}`
  const headers: Record<string, string> = {}
  const normalizedCookie = normalizeNcmCookie(cookie)
  if (normalizedCookie) {
    headers.Cookie = normalizedCookie
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .join('; ')
  }
  const idempotencyKey = options.idempotencyKey?.trim()
  if (idempotencyKey && NCM_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    headers['X-Twilight-Idempotency-Key'] = idempotencyKey
  }
  const controller = new AbortController()
  const abortFromCaller = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abortFromCaller()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => controller.abort(), NCM_API_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, headers })
    return await res.json()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      '网易云请求失败：',
      redactSensitiveText(normalizedPath),
      redactSensitiveText(message)
    )
    return {
      code: -1,
      message
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function collectNcmOfficialCookie(partition: string): Promise<string> {
  const ses = session.fromPartition(partition)
  const cookies = await ses.cookies.get({ domain: '.music.163.com' })
  const names = new Set(['MUSIC_U', '__csrf', 'NMTID', 'MUSIC_A'])
  return cookies
    .filter((cookie) => names.has(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join(';')
}

export async function openNcmOfficialLogin(): Promise<string> {
  // 内存分区（去掉 persist: 前缀）：登录 Cookie 只存活于登录窗口会话期间，不落盘到 userData/Partitions。
  // 登录完成后 Cookie 已通过 collectNcmOfficialCookie 取回，会话随之销毁。
  const partition = `twilight-ncm-login-${Date.now()}`
  const ses = session.fromPartition(partition)
  await ses.clearStorageData().catch(() => undefined)

  return await new Promise<string>((resolveLogin, rejectLogin) => {
    const owner =
      runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : undefined
    const loginWindow = new BrowserWindow({
      width: 920,
      height: 680,
      minWidth: 720,
      minHeight: 560,
      title: '网易云音乐登录',
      parent: owner,
      modal: false,
      show: false,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      ses.cookies.removeListener('changed', handleCookieChanged)
      loginWindow.removeAllListeners('closed')
    }
    const finish = (cookie: string): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!loginWindow.isDestroyed()) loginWindow.close()
      resolveLogin(cookie)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!loginWindow.isDestroyed()) loginWindow.close()
      rejectLogin(error)
    }
    const checkCookie = async (): Promise<void> => {
      const cookie = await collectNcmOfficialCookie(partition)
      if (cookie.includes('MUSIC_U=')) finish(cookie)
    }
    const handleCookieChanged = (): void => {
      void checkCookie().catch(() => undefined)
    }
    const timer = setTimeout(() => {
      fail(new Error('网易云官方登录超时'))
    }, NCM_OFFICIAL_LOGIN_TIMEOUT_MS)

    ses.cookies.on('changed', handleCookieChanged)
    loginWindow.once('closed', () => {
      if (!settled) {
        settled = true
        cleanup()
        rejectLogin(new Error('已取消网易云官方登录'))
      }
    })
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?music\.163\.com\//i.test(url)) return { action: 'allow' }
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    loginWindow.webContents.on('will-navigate', (event, url) => {
      if (/^https?:\/\/([^/]+\.)?music\.163\.com\//i.test(url)) return
      event.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    })
    loginWindow.once('ready-to-show', () => loginWindow.show())
    loginWindow
      .loadURL('https://music.163.com/#/login')
      .then(() => checkCookie())
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
  })
}

export function setupNcmIpc(): void {
  setupNcmCloudTransferIpc()
  ipcMain.handle('ncm:getPort', (event) => {
    assertTrustedIpcSender(event, 'NCM IPC')
    return NCM_API_PORT
  })

  ipcMain.handle('ncm:getCachedSong', async (_event, songId: number) => {
    assertTrustedIpcSender(_event, 'NCM IPC')
    return getCachedNcmSong(normalizeNcmSongId(songId))
  })

  ipcMain.handle(
    'ncm:cacheSong',
    async (_event, songId: number, url: string, fileName?: string) => {
      assertTrustedIpcSender(_event, 'NCM IPC')
      return await cacheNcmSong(
        normalizeNcmSongId(songId),
        normalizeIpcString(url, 'NCM cache url', MAX_NCM_REMOTE_URL_LENGTH),
        normalizeOptionalIpcString(fileName, 'NCM cache file name', MAX_NCM_CACHE_FILENAME_LENGTH)
      )
    }
  )

  ipcMain.handle('ncm:request', async (_event, path: string, cookie?: string) => {
    assertTrustedIpcSender(_event, 'NCM IPC')
    return requestNcmApi(path, cookie)
  })
}

function normalizeNcmApiPath(path: unknown): string | null {
  let normalized: string
  try {
    normalized = normalizeIpcString(path, 'NCM API path', MAX_NCM_API_PATH_LENGTH)
  } catch {
    return null
  }
  if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('\\'))
    return null
  try {
    const parsed = new URL(`http://${NCM_API_HOST}:${NCM_API_PORT}${normalized}`)
    if (parsed.origin !== `http://${NCM_API_HOST}:${NCM_API_PORT}`) return null
    return normalized
  } catch {
    return null
  }
}

function normalizeNcmCookie(cookie: unknown): string | undefined {
  if (cookie == null || cookie === '') return undefined
  try {
    return normalizeIpcString(cookie, 'NCM cookie', MAX_NCM_COOKIE_LENGTH)
  } catch {
    return undefined
  }
}

function normalizeNcmSongId(songId: unknown): number {
  const normalized = normalizeInteger(songId, 'NCM song id', 0, 1, Number.MAX_SAFE_INTEGER)
  if (normalized <= 0) throw new Error('NCM song id is invalid')
  return normalized
}

// S4：登录窗外部跳转仅放行 https:（http: 如需放行须显式传域名白名单）
// 共享实现见 src/main/security/externalUrl.ts

export function ensureNcmServer(): Promise<void> {
  if (runtime.ncmServer) return Promise.resolve()
  if (runtime.ncmServerPromise) return runtime.ncmServerPromise

  const startup = startNcmServer()
  runtime.ncmServerPromise = startup
  void startup.then(
    () => {
      if (runtime.ncmServerPromise === startup) runtime.ncmServerPromise = null
    },
    () => {
      if (runtime.ncmServerPromise === startup) runtime.ncmServerPromise = null
    }
  )
  return startup
}

async function startNcmServer(): Promise<void> {
  const tokenPath = join(tmpdir(), 'anonymous_token')
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, '', 'utf-8')
  }
  const { serveNcmApi } = await import('@neteasecloudmusicapienhanced/api/server.js')
  const ncmApp = await serveNcmApi({
    port: NCM_API_PORT,
    host: NCM_API_HOST,
    checkVersion: false
  })
  if (runtime.forceQuit) {
    ncmApp.server.close()
    throw new Error('NetEase API server startup was cancelled')
  }
  runtime.ncmServer = ncmApp.server
  ncmApp.server.once('close', () => {
    if (runtime.ncmServer === ncmApp.server) runtime.ncmServer = null
  })
  console.log(`网易云音乐服务已启动：http://${NCM_API_HOST}:${NCM_API_PORT}`)
}
