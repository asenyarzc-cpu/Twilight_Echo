import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, extname, join, parse } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type { TwilightPluginManager } from '../plugins/manager.ts'
import { filterAuthorizedLibraryRoots } from '../security/localPaths.ts'
import { isCanonicalPathInside, lexicalPathKey } from '../security/pathGrants.ts'
import type { LocalLibraryIndexCoordinator } from '../library/libraryIndexCoordinator.ts'
import type {
  ProviderDownloadCreateInput,
  ProviderDownloadQuality,
  ProviderDownloadTaskSnapshot
} from '../../shared/providerDownloads.ts'

const POLL_INTERVAL_MS = 1_500
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.wave',
  '.aac',
  '.ogg',
  '.wma',
  '.m4a',
  '.mp4',
  '.aiff',
  '.aif',
  '.opus',
  '.webm',
  '.alac',
  '.ape',
  '.wv',
  '.dsf',
  '.dff',
  '.mqa'
])

interface RemoteDownloadTask {
  jobId: string
  status: 'queued' | 'preparing' | 'ready' | 'failed' | 'cancelled' | 'expired'
  progress: number
  queuePosition?: number | null
  requestedQuality: ProviderDownloadQuality
  actualQuality?: ProviderDownloadQuality | null
  fileName?: string | null
  fileSize?: number | null
  contentType?: string | null
  error?: string | null
}

interface RemoteDownloadFile {
  url: string
  fileName?: string | null
  fileSize?: number | null
  contentType?: string | null
  actualQuality?: ProviderDownloadQuality | null
}

interface ProviderDownloadManagerOptions {
  pluginManager: TwilightPluginManager
  getLibraryFolders: () => string[]
  libraryIndexCoordinator: () => LocalLibraryIndexCoordinator | null
  onChanged: (tasks: ProviderDownloadTaskSnapshot[]) => void
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

export class ProviderDownloadManager {
  private readonly tasks = new Map<string, ProviderDownloadTaskSnapshot>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => Date

  constructor(private readonly options: ProviderDownloadManagerOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => new Date())
  }

  list(): ProviderDownloadTaskSnapshot[] {
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => structuredClone(task))
  }

  async create(input: ProviderDownloadCreateInput): Promise<ProviderDownloadTaskSnapshot> {
    const providerId = normalizeProviderId(input.providerId)
    const track = normalizeTrack(input.track)
    const quality = normalizeQuality(input.quality)
    const roots = await filterAuthorizedLibraryRoots(this.options.getLibraryFolders())
    if (roots.length === 0) throw new Error('请先在设置中添加并授权本地音乐库目录')
    const targetRoot = selectTargetRoot(input.targetRoot, roots)
    const remote = normalizeRemoteTask(
      await this.options.pluginManager.callProvider(
        providerId,
        'createDownload',
        [{ track, quality }],
        { idempotencyKey: randomUUID() }
      )
    )
    const timestamp = this.now().toISOString()
    const task: ProviderDownloadTaskSnapshot = {
      id: randomUUID(),
      providerId,
      providerJobId: remote.jobId,
      track,
      requestedQuality: quality,
      actualQuality: remote.actualQuality ?? null,
      status:
        remote.status === 'ready' ? 'preparing' : remote.status === 'failed' ? 'failed' : 'queued',
      progress: clampProgress(remote.progress),
      queuePosition: normalizeOptionalInteger(remote.queuePosition),
      targetPath: null,
      fileSize: normalizeOptionalSize(remote.fileSize),
      error: remote.error ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.tasks.set(task.id, task)
    this.emitChanged()
    if (!TERMINAL_STATUSES.has(task.status)) void this.run(task.id, targetRoot, remote)
    return structuredClone(task)
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.requireTask(taskId)
    if (TERMINAL_STATUSES.has(task.status)) return
    this.abortControllers.get(task.id)?.abort(new Error('用户取消下载'))
    try {
      await this.options.pluginManager.callProvider(task.providerId, 'cancelDownload', [
        task.providerJobId
      ])
    } catch {
      // Local cancellation still wins if the remote task already reached a terminal state.
    }
    this.patch(task.id, { status: 'cancelled', error: null })
  }

  async retry(taskId: string): Promise<ProviderDownloadTaskSnapshot> {
    const previous = this.requireTask(taskId)
    if (previous.status !== 'failed' && previous.status !== 'cancelled') {
      throw new Error('只有失败或已取消的任务可以重试')
    }
    return this.create({
      providerId: previous.providerId,
      track: previous.track,
      quality: previous.requestedQuality
    })
  }

  private async run(
    taskId: string,
    targetRoot: string,
    initial: RemoteDownloadTask
  ): Promise<void> {
    const controller = new AbortController()
    this.abortControllers.set(taskId, controller)
    try {
      let remote = initial
      while (remote.status !== 'ready') {
        if (controller.signal.aborted) throw controller.signal.reason
        if (remote.status === 'failed' || remote.status === 'expired') {
          throw new Error(
            remote.error ||
              (remote.status === 'expired' ? '远端下载任务已过期' : '远端下载任务失败')
          )
        }
        if (remote.status === 'cancelled') {
          this.patch(taskId, { status: 'cancelled', error: null })
          return
        }
        this.patch(taskId, {
          status: remote.status === 'queued' ? 'queued' : 'preparing',
          progress: clampProgress(remote.progress) * 0.45,
          queuePosition: normalizeOptionalInteger(remote.queuePosition),
          actualQuality: remote.actualQuality ?? null
        })
        await wait(POLL_INTERVAL_MS, controller.signal)
        const task = this.requireTask(taskId)
        remote = normalizeRemoteTask(
          await this.options.pluginManager.callProvider(task.providerId, 'getDownloadStatus', [
            task.providerJobId
          ])
        )
      }
      await this.receiveFile(taskId, targetRoot, remote, controller.signal)
    } catch (error) {
      if (this.requireTask(taskId).status !== 'cancelled') {
        this.patch(taskId, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          error: controller.signal.aborted ? null : errorMessage(error)
        })
      }
    } finally {
      this.abortControllers.delete(taskId)
    }
  }

  private async receiveFile(
    taskId: string,
    targetRoot: string,
    remote: RemoteDownloadTask,
    signal: AbortSignal
  ): Promise<void> {
    const task = this.requireTask(taskId)
    await mkdir(targetRoot, { recursive: true })
    const file = normalizeRemoteFile(
      await this.options.pluginManager.callProvider(task.providerId, 'getDownloadFile', [
        task.providerJobId
      ])
    )
    const targetPath = await availableTargetPath(
      targetRoot,
      file.fileName || remote.fileName,
      task.track
    )
    assertWithinRoot(targetRoot, targetPath)
    const partPath = `${targetPath}.${task.id}.part`
    this.patch(taskId, {
      status: 'downloading',
      progress: 0.45,
      queuePosition: null,
      targetPath,
      actualQuality: file.actualQuality ?? remote.actualQuality ?? null,
      fileSize: normalizeOptionalSize(file.fileSize ?? remote.fileSize)
    })
    try {
      const response = await this.fetchImpl(file.url, { signal, redirect: 'error' })
      if (!response.ok || !response.body) throw new Error(`下载文件请求失败 (${response.status})`)
      const declaredSize = parseContentLength(response.headers.get('content-length'))
      const expectedSize = normalizeOptionalSize(file.fileSize ?? remote.fileSize) ?? declaredSize
      if (expectedSize != null && expectedSize > MAX_DOWNLOAD_BYTES)
        throw new Error('下载文件超过 4 GiB 限制')
      let received = 0
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length
          if (received > MAX_DOWNLOAD_BYTES) return callback(new Error('下载文件超过 4 GiB 限制'))
          this.patch(taskId, {
            progress: expectedSize ? 0.45 + Math.min(0.54, (received / expectedSize) * 0.54) : 0.45
          })
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        progress,
        createWriteStream(partPath, { flags: 'wx' }),
        { signal }
      )
      if (expectedSize != null && received !== expectedSize) {
        throw new Error(`下载文件大小不匹配：预期 ${expectedSize} 字节，实际 ${received} 字节`)
      }
      const handle = await open(partPath, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(partPath, targetPath)
      this.options
        .libraryIndexCoordinator()
        ?.enqueueWatcherChanges([{ kind: 'add', path: targetPath }])
      this.patch(taskId, {
        status: 'completed',
        progress: 1,
        fileSize: received,
        targetPath,
        error: null
      })
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private requireTask(taskId: string): ProviderDownloadTaskSnapshot {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('下载任务不存在')
    return task
  }

  private patch(taskId: string, patch: Partial<ProviderDownloadTaskSnapshot>): void {
    const task = this.requireTask(taskId)
    Object.assign(task, patch, { updatedAt: this.now().toISOString() })
    this.emitChanged()
  }

  private emitChanged(): void {
    this.options.onChanged(this.list())
  }
}

function normalizeProviderId(value: unknown): string {
  const providerId = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(providerId)) throw new Error('Provider ID 无效')
  return providerId
}

function normalizeTrack(value: unknown): ProviderDownloadCreateInput['track'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('下载曲目信息无效')
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' || typeof record.id === 'number' ? record.id : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const artist = typeof record.artist === 'string' ? record.artist.trim() : ''
  if (id === '' || !title || !artist) throw new Error('下载曲目缺少 id、标题或艺术家')
  return { ...record, id, title: title.slice(0, 300), artist: artist.slice(0, 300) }
}

function normalizeQuality(value: unknown): ProviderDownloadQuality {
  if (value !== 'aac' && value !== 'lossless' && value !== 'hi-res') throw new Error('下载音质无效')
  return value
}

function normalizeRemoteTask(value: unknown): RemoteDownloadTask {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provider 下载任务响应无效')
  const record = value as Record<string, unknown>
  const jobId = typeof record.jobId === 'string' ? record.jobId.trim() : ''
  const status = record.status
  if (
    !jobId ||
    !['queued', 'preparing', 'ready', 'failed', 'cancelled', 'expired'].includes(String(status))
  ) {
    throw new Error('Provider 下载任务响应缺少有效 jobId 或状态')
  }
  return {
    jobId,
    status: status as RemoteDownloadTask['status'],
    progress: clampProgress(Number(record.progress)),
    queuePosition: normalizeOptionalInteger(record.queuePosition),
    requestedQuality: normalizeQuality(record.requestedQuality),
    actualQuality: normalizeOptionalQuality(record.actualQuality),
    fileName: typeof record.fileName === 'string' ? record.fileName : null,
    fileSize: normalizeOptionalSize(record.fileSize),
    contentType: typeof record.contentType === 'string' ? record.contentType : null,
    error: typeof record.error === 'string' ? record.error.slice(0, 1000) : null
  }
}

function normalizeRemoteFile(value: unknown): RemoteDownloadFile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provider 下载文件响应无效')
  const record = value as Record<string, unknown>
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('Provider 下载文件必须通过 127.0.0.1 回环代理交付')
  }
  return {
    url,
    fileName: typeof record.fileName === 'string' ? record.fileName : null,
    fileSize: normalizeOptionalSize(record.fileSize),
    contentType: typeof record.contentType === 'string' ? record.contentType : null,
    actualQuality: normalizeOptionalQuality(record.actualQuality)
  }
}

function normalizeOptionalQuality(value: unknown): ProviderDownloadQuality | null {
  return value === 'aac' || value === 'lossless' || value === 'hi-res' ? value : null
}

function normalizeOptionalInteger(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null
}

function normalizeOptionalSize(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
}

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function selectTargetRoot(requested: unknown, roots: string[]): string {
  if (typeof requested !== 'string' || !requested.trim()) return roots[0]
  const targetKey = lexicalPathKey(requested)
  const match = roots.find((root) => lexicalPathKey(root) === targetKey)
  if (!match) throw new Error('下载目录必须是已授权的本地音乐库根目录')
  return match
}

async function availableTargetPath(
  root: string,
  remoteFileName: string | null | undefined,
  track: ProviderDownloadCreateInput['track']
): Promise<string> {
  const remoteBase = remoteFileName ? basename(remoteFileName) : ''
  const extension = AUDIO_EXTENSIONS.has(extname(remoteBase).toLowerCase())
    ? extname(remoteBase).toLowerCase()
    : '.m4a'
  const preferred = remoteBase
    ? `${sanitizeSegment(parse(remoteBase).name)}${extension}`
    : `${sanitizeSegment(`${track.artist} - ${track.title}`)}${extension}`
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : ` (${index})`
    const candidate = join(root, `${parse(preferred).name}${suffix}${extension}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('无法为下载文件分配不冲突的文件名')
}

function sanitizeSegment(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || '<>:"/\\|?*'.includes(character) ? '_' : character
  })
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180)
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'Apple Music Track'
}

function assertWithinRoot(root: string, target: string): void {
  if (!isCanonicalPathInside(root, target)) throw new Error('下载目标路径越界')
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null
  return normalizeOptionalSize(value)
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolveWait, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
