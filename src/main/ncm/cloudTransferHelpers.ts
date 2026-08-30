import { extname, posix, win32 } from 'node:path'

const MAX_FILE_NAME_LENGTH = 255
const CLOUD_DOWNLOAD_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
export const MAX_CLOUD_DOWNLOAD_REDIRECTS = 5

export interface OwnedExpiringGrant {
  ownerId: number
  expiresAt: number
}

export interface OwnedAbortableTransfer {
  ownerId: number
  controller: Pick<AbortController, 'abort'>
}

export interface DownloadCommitOperations {
  exists(path: string): Promise<boolean>
  rename(source: string, target: string): Promise<void>
  remove(path: string): Promise<void>
}

export function normalizeCloudSongId(value: unknown, maxLength = 128): string {
  const normalized =
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : ''
  if (!normalized) throw new Error('NCM cloud song id is required')
  if (normalized.length > maxLength) throw new Error('NCM cloud song id is too long')
  if (/[^\x21-\x7e]/.test(normalized))
    throw new Error('NCM cloud song id contains invalid characters')
  return normalized
}

export function sanitizeDownloadFileName(value: string): string {
  const normalized = [...value]
    .map((character) =>
      character.charCodeAt(0) <= 31 || '<>:"/\\|?*'.includes(character) ? '_' : character
    )
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
  const safe =
    normalized && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized)
      ? normalized
      : `网易云云盘歌曲${extname(normalized)}`
  return safe.slice(0, MAX_FILE_NAME_LENGTH) || '网易云云盘歌曲'
}

export function assertOwnedGrant(
  grant: OwnedExpiringGrant | undefined,
  ownerId: number,
  now = Date.now()
): void {
  if (!grant || grant.ownerId !== ownerId || grant.expiresAt <= now) {
    throw new Error('文件选择凭证已失效，请重新选择文件')
  }
}

export function reserveExclusiveResource(
  resources: Set<string>,
  key: string,
  conflictMessage: string
): () => void {
  if (resources.has(key)) throw new Error(conflictMessage)
  resources.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    resources.delete(key)
  }
}

export function cancelOwnedTransfer(
  transfer: OwnedAbortableTransfer | undefined,
  ownerId: number,
  reason: Error
): boolean {
  if (!transfer || transfer.ownerId !== ownerId) return false
  transfer.controller.abort(reason)
  return true
}

export function normalizeTransferUrl(value: string, label: string): URL {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    throw new Error(`${label}无效`)
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error(`${label}协议无效`)
  }
  if (target.username || target.password) throw new Error(`${label}不得包含 URL 凭据`)
  return target
}

export function resolveCloudDownloadRedirect(current: URL, location: string): URL {
  let target: URL
  try {
    target = normalizeTransferUrl(new URL(location, current).toString(), '网易云下载重定向地址')
  } catch (error) {
    if (error instanceof Error && error.message.includes('网易云下载重定向地址')) throw error
    throw new Error('网易云下载重定向地址无效')
  }
  if (current.protocol === 'https:' && target.protocol !== 'https:') {
    throw new Error('网易云下载重定向不允许从 HTTPS 降级到 HTTP')
  }
  return target
}

export function temporaryDownloadPath(targetPath: string, transferId: string): string {
  const pathApi = targetPath.includes('\\') ? win32 : posix
  const directory = pathApi.dirname(targetPath)
  const fileName = pathApi.basename(targetPath)
  return pathApi.join(directory, `.${fileName}.twilight-part-${transferId}`)
}

export async function commitDownloadedFile(
  temporaryPath: string,
  targetPath: string,
  backupPath: string,
  operations: DownloadCommitOperations
): Promise<void> {
  const hadTarget = await operations.exists(targetPath)
  if (hadTarget) await operations.rename(targetPath, backupPath)
  try {
    await operations.rename(temporaryPath, targetPath)
  } catch (error) {
    if (hadTarget) {
      await operations.rename(backupPath, targetPath).catch(() => undefined)
    }
    throw error
  }
  if (hadTarget) await operations.remove(backupPath)
}

export async function fetchCloudDownloadResponse(
  source: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  let current = normalizeTransferUrl(source, '网易云下载地址')
  const visited = new Set([current.toString()])

  for (let hop = 0; hop <= MAX_CLOUD_DOWNLOAD_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, {
      method: 'GET',
      signal,
      redirect: 'manual',
      credentials: 'omit'
    })
    if (!CLOUD_DOWNLOAD_REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('网易云下载重定向缺少 Location 响应头')
    }
    if (hop === MAX_CLOUD_DOWNLOAD_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`网易云下载重定向超过 ${MAX_CLOUD_DOWNLOAD_REDIRECTS} 次限制`)
    }
    const target = resolveCloudDownloadRedirect(current, location)
    if (visited.has(target.toString())) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('网易云下载重定向形成循环')
    }
    await response.body?.cancel().catch(() => undefined)
    current = target
    visited.add(current.toString())
  }

  throw new Error(`网易云下载重定向超过 ${MAX_CLOUD_DOWNLOAD_REDIRECTS} 次限制`)
}
