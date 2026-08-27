import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, rename, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, extname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { parseFile } from 'music-metadata'
import { runtime } from '../core/runtime.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import {
  assertOwnedGrant,
  cancelOwnedTransfer,
  commitDownloadedFile,
  fetchCloudDownloadResponse,
  normalizeCloudSongId,
  normalizeTransferUrl,
  reserveExclusiveResource,
  sanitizeDownloadFileName,
  temporaryDownloadPath
} from './cloudTransferHelpers.ts'
import { normalizeIpcString } from '../security/ipcValidation.ts'
import {
  NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL,
  type NcmCloudDownloadRequest,
  type NcmCloudDownloadResult,
  type NcmCloudSelectedFile,
  type NcmCloudTransferProgress,
  type NcmCloudUploadResult
} from '../../shared/ncmCloud.ts'

const NCM_PROVIDER_ID = 'ncm'
const HANDLE_TTL_MS = 30 * 60_000
const MAX_SELECTED_FILES = 20
const MAX_FILE_NAME_LENGTH = 255
const MAX_HANDLE_LENGTH = 128
const MAX_CLOUD_SONG_ID_LENGTH = 128
const MAX_NOS_ERROR_RESPONSE_BYTES = 8 * 1024
const SUPPORTED_AUDIO_EXTENSIONS = new Set([
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

interface SelectedFileGrant {
  handle: string
  ownerId: number
  path: string
  name: string
  size: number
  format: string | null
  expiresAt: number
}

interface ActiveTransfer {
  controller: AbortController
  ownerId: number
}

interface CloudUploadPreparation {
  needUpload: boolean
  songId: string | number
  uploadToken: string
  uploadUrl: string
  resourceId: string
  md5: string
  fileSize: number
  filename: string
}

const selectedFiles = new Map<string, SelectedFileGrant>()
const activeTransfers = new Map<string, ActiveTransfer>()
const activeUploadPaths = new Set<string>()
const activeDownloadSongs = new Set<string>()
const observedWebContents = new Set<number>()

export function setupNcmCloudTransferIpc(): void {
  ipcMain.handle('ncmCloud:chooseUploadFiles', chooseUploadFiles)
  ipcMain.handle('ncmCloud:upload', startUploadSelectedFile)
  ipcMain.handle('ncmCloud:download', startDownloadCloudSong)
  ipcMain.handle('ncmCloud:cancel', cancelTransfer)
}

async function chooseUploadFiles(event: IpcMainInvokeEvent): Promise<NcmCloudSelectedFile[]> {
  assertTrustedIpcSender(event, 'NCM cloud IPC')
  observeWebContents(event.sender)
  pruneExpiredHandles()
  const owner = BrowserWindow.fromWebContents(event.sender) ?? runtime.mainWindow
  const options: Electron.OpenDialogOptions = {
    title: '选择要上传到网易云云盘的音频文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音频文件', extensions: [...SUPPORTED_AUDIO_EXTENSIONS].map((item) => item.slice(1)) }
    ]
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return []
  if (result.filePaths.length > MAX_SELECTED_FILES) {
    throw new Error(`一次最多选择 ${MAX_SELECTED_FILES} 个音频文件`)
  }

  const files: NcmCloudSelectedFile[] = []
  for (const path of result.filePaths) {
    const extension = extname(path).toLowerCase()
    if (!SUPPORTED_AUDIO_EXTENSIONS.has(extension)) continue
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0) continue
    const handle = randomUUID()
    const grant: SelectedFileGrant = {
      handle,
      ownerId: event.sender.id,
      path,
      name: basename(path),
      size: info.size,
      format: extension ? extension.slice(1) : null,
      expiresAt: Date.now() + HANDLE_TTL_MS
    }
    selectedFiles.set(handle, grant)
    files.push({ handle, name: grant.name, size: grant.size, format: grant.format })
  }
  return files
}

function startUploadSelectedFile(
  event: IpcMainInvokeEvent,
  rawHandle: unknown
): NcmCloudUploadResult {
  assertTrustedIpcSender(event, 'NCM cloud IPC')
  observeWebContents(event.sender)
  const handle = normalizeIpcString(rawHandle, 'NCM cloud file handle', MAX_HANDLE_LENGTH)
  const grant = resolveFileGrant(handle, event.sender.id)
  const releaseUploadPath = reserveExclusiveResource(
    activeUploadPaths,
    grant.path,
    '该文件已有上传任务正在运行'
  )

  const transferId = randomUUID()
  const controller = new AbortController()
  activeTransfers.set(transferId, { controller, ownerId: event.sender.id })
  emitProgress(event.sender, {
    transferId,
    kind: 'upload',
    stage: 'queued',
    handle,
    fileName: grant.name,
    bytesTransferred: 0,
    bytesTotal: grant.size,
    percent: 0,
    message: '上传任务已创建'
  })
  queueMicrotask(
    () =>
      void runUploadSelectedFile(
        event.sender,
        handle,
        grant,
        transferId,
        controller,
        releaseUploadPath
      )
  )
  return { transferId, handle, fileName: grant.name, accepted: true }
}

async function runUploadSelectedFile(
  sender: WebContents,
  handle: string,
  grant: SelectedFileGrant,
  transferId: string,
  controller: AbortController,
  releaseUploadPath: () => void
): Promise<void> {
  try {
    emitProgress(sender, {
      transferId,
      kind: 'upload',
      stage: 'hashing',
      fileName: grant.name,
      bytesTransferred: 0,
      bytesTotal: grant.size,
      percent: 0,
      message: '正在计算文件 MD5'
    })
    const md5 = await hashFile(grant, controller.signal, (bytes) => {
      emitProgress(sender, {
        ...progress(transferId, 'upload', 'hashing', grant.name, bytes, grant.size),
        handle
      })
    })

    emitProgress(sender, {
      transferId,
      kind: 'upload',
      stage: 'metadata',
      handle,
      fileName: grant.name,
      bytesTransferred: 0,
      bytesTotal: null,
      percent: null,
      message: '正在读取音频元数据'
    })
    const metadata = await readAudioMetadata(grant.path, grant.name)

    emitProgress(sender, {
      transferId,
      kind: 'upload',
      stage: 'authorizing',
      handle,
      fileName: grant.name,
      bytesTransferred: 0,
      bytesTotal: null,
      percent: null,
      message: '正在获取上传凭证'
    })
    const preparation = await callNcmProvider<CloudUploadPreparation>(
      'prepareCloudUpload',
      [
        {
          md5,
          fileSize: grant.size,
          filename: grant.name,
          ...(metadata.bitrate ? { bitrate: metadata.bitrate } : {})
        }
      ],
      controller.signal
    )

    if (preparation.needUpload) {
      await uploadToNos(sender, transferId, grant, preparation, controller.signal, handle)
    }

    emitProgress(sender, {
      transferId,
      kind: 'upload',
      stage: 'importing',
      handle,
      fileName: grant.name,
      bytesTransferred: grant.size,
      bytesTotal: grant.size,
      percent: 100,
      message: preparation.needUpload ? '上传完成，正在导入云盘' : '文件已存在，正在导入云盘'
    })
    await callNcmProvider(
      'completeCloudUpload',
      [
        {
          songId: preparation.songId,
          resourceId: preparation.resourceId,
          md5,
          filename: grant.name,
          song: metadata.title,
          artist: metadata.artist,
          album: metadata.album,
          ...(metadata.bitrate ? { bitrate: metadata.bitrate } : {})
        }
      ],
      controller.signal,
      transferId
    )

    emitProgress(sender, {
      transferId,
      kind: 'upload',
      stage: 'completed',
      handle,
      fileName: grant.name,
      bytesTransferred: grant.size,
      bytesTotal: grant.size,
      percent: 100,
      message: '已上传到网易云云盘'
    })
    selectedFiles.delete(handle)
  } catch (error) {
    emitFailure(sender, transferId, 'upload', grant.name, error, controller.signal.aborted, {
      handle
    })
  } finally {
    activeTransfers.delete(transferId)
    releaseUploadPath()
  }
}

async function startDownloadCloudSong(
  event: IpcMainInvokeEvent,
  rawRequest: unknown
): Promise<NcmCloudDownloadResult> {
  assertTrustedIpcSender(event, 'NCM cloud IPC')
  observeWebContents(event.sender)
  const request = normalizeDownloadRequest(rawRequest)
  const downloadKey = String(request.cloudSongId)
  const releaseDownloadSong = reserveExclusiveResource(
    activeDownloadSongs,
    downloadKey,
    '该歌曲已有下载任务正在运行'
  )

  let handedOff = false
  try {
    const safeName = sanitizeDownloadFileName(request.fileName)
    const owner = BrowserWindow.fromWebContents(event.sender) ?? runtime.mainWindow
    const options: Electron.SaveDialogOptions = {
      title: '下载网易云云盘歌曲',
      defaultPath: safeName
    }
    const choice = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) {
      return { transferId: '', fileName: safeName, accepted: false, cancelled: true }
    }

    const transferId = randomUUID()
    const controller = new AbortController()
    activeTransfers.set(transferId, { controller, ownerId: event.sender.id })
    emitProgress(event.sender, {
      transferId,
      kind: 'download',
      stage: 'queued',
      cloudSongId: request.cloudSongId,
      fileName: safeName,
      bytesTransferred: 0,
      bytesTotal: null,
      percent: null,
      message: '下载任务已创建'
    })
    handedOff = true
    queueMicrotask(
      () =>
        void runDownloadCloudSong(
          event.sender,
          request,
          choice.filePath as string,
          safeName,
          transferId,
          controller,
          releaseDownloadSong
        )
    )
    return { transferId, fileName: safeName, accepted: true, cancelled: false }
  } finally {
    if (!handedOff) releaseDownloadSong()
  }
}

async function runDownloadCloudSong(
  sender: WebContents,
  request: NcmCloudDownloadRequest,
  targetPath: string,
  safeName: string,
  transferId: string,
  controller: AbortController,
  releaseDownloadSong: () => void
): Promise<void> {
  const temporaryPath = temporaryDownloadPath(targetPath, transferId)
  const backupPath = `${temporaryPath}.backup`
  try {
    const downloadUrl = await callNcmProvider<string>(
      'getCloudDownloadUrl',
      [request.cloudSongId],
      controller.signal
    )
    const response = await fetchCloudDownloadResponse(downloadUrl, controller.signal)
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`下载服务器返回 HTTP ${response.status}`)
    }
    const contentLength = Number(response.headers.get('content-length'))
    const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null
    let bytes = 0
    const progressTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        emitProgress(sender, {
          transferId,
          kind: 'download',
          stage: 'downloading',
          cloudSongId: request.cloudSongId,
          fileName: safeName,
          bytesTransferred: bytes,
          bytesTotal: total,
          percent: total ? Math.min(100, Math.round((bytes / total) * 100)) : null,
          message: total
            ? `正在下载 ${Math.min(100, Math.round((bytes / total) * 100))}%`
            : '正在下载'
        })
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as never),
      progressTransform,
      createWriteStream(temporaryPath),
      { signal: controller.signal }
    )
    await commitDownloadedFile(temporaryPath, targetPath, backupPath, {
      exists: pathExists,
      rename,
      remove: async (path) => rm(path, { force: true })
    })
    emitProgress(sender, {
      transferId,
      kind: 'download',
      stage: 'completed',
      cloudSongId: request.cloudSongId,
      fileName: safeName,
      bytesTransferred: bytes,
      bytesTotal: total,
      percent: 100,
      message: '下载完成'
    })
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    if ((await pathExists(backupPath)) && !(await pathExists(targetPath))) {
      await rename(backupPath, targetPath).catch(() => undefined)
    }
    emitFailure(sender, transferId, 'download', safeName, error, controller.signal.aborted, {
      cloudSongId: request.cloudSongId
    })
  } finally {
    activeTransfers.delete(transferId)
    releaseDownloadSong()
  }
}

function cancelTransfer(event: IpcMainInvokeEvent, rawTransferId: unknown): boolean {
  assertTrustedIpcSender(event, 'NCM cloud IPC')
  const transferId = normalizeIpcString(rawTransferId, 'NCM cloud transfer id', MAX_HANDLE_LENGTH)
  return cancelOwnedTransfer(
    activeTransfers.get(transferId),
    event.sender.id,
    new Error('用户已取消传输')
  )
}

async function hashFile(
  grant: SelectedFileGrant,
  signal: AbortSignal,
  onProgress: (bytes: number) => void
): Promise<string> {
  const hash = createHash('md5')
  let bytes = 0
  for await (const chunk of createReadStream(grant.path, { signal })) {
    hash.update(chunk)
    bytes += chunk.length
    onProgress(bytes)
  }
  return hash.digest('hex')
}

async function readAudioMetadata(
  path: string,
  fileName: string
): Promise<{
  title: string
  artist: string
  album: string
  bitrate?: number
}> {
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '')
  try {
    const metadata = await parseFile(path, { duration: false, skipCovers: true })
    const bitrate = Math.round(Number(metadata.format.bitrate))
    return {
      title: metadata.common.title?.trim() || fallbackTitle,
      artist: metadata.common.artist?.trim() || '未知艺术家',
      album: metadata.common.album?.trim() || '未知专辑',
      ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrate } : {})
    }
  } catch {
    return { title: fallbackTitle, artist: '未知艺术家', album: '未知专辑' }
  }
}

async function uploadToNos(
  sender: WebContents,
  transferId: string,
  grant: SelectedFileGrant,
  preparation: CloudUploadPreparation,
  signal: AbortSignal,
  handle: string
): Promise<void> {
  const target = normalizeTransferUrl(preparation.uploadUrl, '网易云上传地址')
  const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest
  await new Promise<void>((resolve, reject) => {
    const request = requestImpl(
      target,
      {
        method: 'POST',
        headers: {
          'x-nos-token': preparation.uploadToken,
          'Content-MD5': preparation.md5,
          'Content-Type': mimeTypeForFile(grant.name),
          'Content-Length': String(grant.size)
        },
        signal
      },
      (response) => {
        const chunks: Buffer[] = []
        let capturedBytes = 0
        response.on('data', (chunk: Buffer) => {
          if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) return
          const remaining = MAX_NOS_ERROR_RESPONSE_BYTES - capturedBytes
          if (remaining <= 0) return
          const captured = chunk.subarray(0, remaining)
          chunks.push(captured)
          capturedBytes += captured.length
        })
        response.once('end', () => {
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) resolve()
          else
            reject(
              new Error(
                `网易云存储上传失败：HTTP ${status} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`
              )
            )
        })
      }
    )
    request.once('error', reject)
    const stream = createReadStream(grant.path, { signal })
    let bytes = 0
    stream.on('data', (chunk: string | Buffer) => {
      bytes += Buffer.byteLength(chunk)
      emitProgress(sender, {
        ...progress(transferId, 'upload', 'uploading', grant.name, bytes, grant.size),
        handle
      })
    })
    stream.once('error', reject)
    stream.pipe(request)
  })
}

async function callNcmProvider<T = unknown>(
  method: string,
  args: unknown[],
  signal?: AbortSignal,
  idempotencyKey?: string
): Promise<T> {
  await runtime.pluginManagerReady
  if (!runtime.pluginManager) throw new Error('网易云 Provider 尚未就绪')
  return (await runtime.pluginManager.callProvider(NCM_PROVIDER_ID, method as never, args, {
    signal,
    idempotencyKey
  })) as T
}

function resolveFileGrant(handle: string, ownerId: number): SelectedFileGrant {
  const grant = selectedFiles.get(handle)
  try {
    assertOwnedGrant(grant, ownerId)
  } catch (error) {
    if (grant?.expiresAt && grant.expiresAt <= Date.now() && !activeUploadPaths.has(grant.path)) {
      selectedFiles.delete(handle)
    }
    throw error
  }
  return grant as SelectedFileGrant
}

function observeWebContents(sender: WebContents): void {
  if (observedWebContents.has(sender.id)) return
  observedWebContents.add(sender.id)
  sender.once('destroyed', () => {
    observedWebContents.delete(sender.id)
    for (const [handle, grant] of selectedFiles) {
      if (grant.ownerId === sender.id) selectedFiles.delete(handle)
    }
    for (const [transferId, transfer] of activeTransfers) {
      if (transfer.ownerId !== sender.id) continue
      transfer.controller.abort(new Error('窗口已关闭'))
      activeTransfers.delete(transferId)
    }
  })
}

function pruneExpiredHandles(): void {
  const now = Date.now()
  for (const [handle, grant] of selectedFiles) {
    if (grant.expiresAt <= now && !activeUploadPaths.has(grant.path)) selectedFiles.delete(handle)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function normalizeDownloadRequest(value: unknown): NcmCloudDownloadRequest {
  if (!value || typeof value !== 'object') throw new Error('云盘下载参数无效')
  const input = value as Record<string, unknown>
  const cloudSongId = normalizeCloudSongId(input.cloudSongId, MAX_CLOUD_SONG_ID_LENGTH)
  const fileName = normalizeIpcString(input.fileName, 'NCM cloud file name', MAX_FILE_NAME_LENGTH)
  return { cloudSongId, fileName }
}

function mimeTypeForFile(fileName: string): string {
  const extension = extname(fileName).toLowerCase()
  const known: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.aif': 'audio/aiff'
  }
  return known[extension] ?? 'application/octet-stream'
}

function progress(
  transferId: string,
  kind: 'upload' | 'download',
  stage: 'hashing' | 'uploading',
  fileName: string,
  bytes: number,
  total: number
): NcmCloudTransferProgress {
  const percent = Math.min(100, Math.round((bytes / total) * 100))
  return {
    transferId,
    kind,
    stage,
    fileName,
    bytesTransferred: bytes,
    bytesTotal: total,
    percent,
    message: stage === 'hashing' ? `正在计算 MD5 ${percent}%` : `正在上传 ${percent}%`
  }
}

function emitFailure(
  sender: WebContents,
  transferId: string,
  kind: 'upload' | 'download',
  fileName: string,
  error: unknown,
  cancelled: boolean,
  identity: Pick<NcmCloudTransferProgress, 'handle' | 'cloudSongId'> = {}
): void {
  const message = error instanceof Error ? error.message : String(error)
  emitProgress(sender, {
    transferId,
    kind,
    stage: cancelled ? 'cancelled' : 'failed',
    ...identity,
    fileName,
    bytesTransferred: 0,
    bytesTotal: null,
    percent: null,
    message: cancelled ? '传输已取消' : '传输失败',
    error: message
  })
}

function emitProgress(sender: WebContents, update: NcmCloudTransferProgress): void {
  if (!sender.isDestroyed()) sender.send(NCM_CLOUD_TRANSFER_PROGRESS_CHANNEL, update)
}
