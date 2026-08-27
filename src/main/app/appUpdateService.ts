import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { app, shell } from 'electron'
import { compareVersions } from '../core/settings.ts'
import { runtime } from '../core/runtime.ts'
import {
  GITHUB_API_RELEASES_URL,
  GITHUB_API_LATEST_RELEASE_URL,
  GITHUB_OWNER,
  GITHUB_REPO,
  RELEASES_URL
} from '../../shared/projectUrls.ts'
import type {
  AppUpdateCheckResult,
  AppUpdateDownloadResult,
  AppUpdateInstallResult,
  AppUpdateProgress
} from '../../shared/appUpdate.ts'
import {
  extractAssetDigestSha256,
  extractChecksumFromBody,
  pickLatestAvailableRelease,
  pickWindowsAsset,
  SHA256_HEX_RE,
  type GithubAssetLike
} from './appUpdateHelpers.ts'

type GithubAsset = GithubAssetLike

type GithubRelease = {
  tag_name?: string
  html_url?: string
  body?: string
  assets?: GithubAsset[]
  draft?: boolean
}

type ResolvedAsset = {
  name: string
  size: number
  url: string
  checksumSha256?: string
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'TwilightEcho-Updater'
} as const

let activeAbort: AbortController | null = null
let readyInstallerPath: string | null = null
let lastResolved: ResolvedAsset | null = null
let lastReleaseUrl = RELEASES_URL
let lastVersion = ''

function emitProgress(progress: AppUpdateProgress): void {
  runtime.mainWindow?.webContents.send('app:update-progress', progress)
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { headers: GITHUB_HEADERS, signal })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
  return await response.text()
}

async function resolveChecksum(
  release: GithubRelease,
  asset: GithubAsset,
  signal?: AbortSignal
): Promise<string | undefined> {
  const assetName = asset.name || ''
  const fromAssetDigest = extractAssetDigestSha256(asset.digest)
  if (fromAssetDigest) return fromAssetDigest
  const fromBody = extractChecksumFromBody(release.body || '', assetName)
  if (fromBody) return fromBody

  const assets = release.assets || []
  const shaAsset =
    assets.find((item) => item.name?.toLowerCase() === `${assetName.toLowerCase()}.sha256`) ||
    assets.find((item) => item.name?.toLowerCase() === `${assetName.toLowerCase()}.sha256.txt`) ||
    assets.find((item) => /sha256/i.test(item.name || '') && /\.txt$/i.test(item.name || '')) ||
    assets.find((item) => /^SHA256SUMS$/i.test(item.name || '')) ||
    assets.find((item) => /checksums?\.txt$/i.test(item.name || ''))

  if (!shaAsset?.browser_download_url) return undefined
  try {
    const text = await fetchText(shaAsset.browser_download_url, signal)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(SHA256_HEX_RE)
      if (!match) continue
      if (trimmed.toLowerCase().includes(assetName.toLowerCase()) || assets.length === 1) {
        return match[0].toLowerCase()
      }
    }
    const only = text.match(SHA256_HEX_RE)
    return only ? only[0].toLowerCase() : undefined
  } catch {
    return undefined
  }
}

async function fetchReleaseList(signal?: AbortSignal): Promise<GithubRelease[]> {
  const response = await fetch(GITHUB_API_RELEASES_URL, {
    headers: GITHUB_HEADERS,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`GitHub Releases API HTTP ${response.status}`)
  const releases = await response.json()
  if (!Array.isArray(releases)) throw new Error('GitHub Releases API returned an invalid response')
  return releases as GithubRelease[]
}

async function fetchLatestRelease(signal?: AbortSignal): Promise<GithubRelease | null> {
  const response = await fetch(GITHUB_API_LATEST_RELEASE_URL, {
    headers: GITHUB_HEADERS,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000)
  })
  if (response.ok) return (await response.json()) as GithubRelease
  if (response.status === 404) {
    return pickLatestAvailableRelease(await fetchReleaseList(signal))
  }
  throw new Error(`GitHub API HTTP ${response.status}`)
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
  const currentVersion = app.getVersion()
  try {
    const release = await fetchLatestRelease()
    if (!release) {
      lastResolved = null
      lastReleaseUrl = RELEASES_URL
      lastVersion = ''
      return { hasUpdate: false, currentVersion }
    }
    const latestTag = (release.tag_name || '').replace(/^v/, '')
    if (!latestTag) {
      return { hasUpdate: false, currentVersion }
    }
    const hasUpdate = compareVersions(latestTag, currentVersion) > 0
    const releaseUrl = release.html_url || RELEASES_URL
    lastReleaseUrl = releaseUrl
    lastVersion = latestTag

    if (!hasUpdate) {
      lastResolved = null
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: latestTag,
        releaseUrl,
        releaseNotes: release.body || ''
      }
    }

    if (process.platform !== 'win32') {
      lastResolved = null
      return {
        hasUpdate: true,
        currentVersion,
        latestVersion: latestTag,
        releaseUrl,
        releaseNotes: release.body || '',
        error: 'unsupported-platform'
      }
    }

    const asset = pickWindowsAsset(release.assets || [])
    if (!asset?.browser_download_url || !asset.name) {
      lastResolved = null
      return {
        hasUpdate: true,
        currentVersion,
        latestVersion: latestTag,
        releaseUrl,
        releaseNotes: release.body || '',
        error: 'no-asset'
      }
    }

    const checksumSha256 = await resolveChecksum(release, asset)
    if (!checksumSha256) {
      lastResolved = null
      return {
        hasUpdate: true,
        currentVersion,
        latestVersion: latestTag,
        releaseUrl,
        releaseNotes: release.body || '',
        assetName: asset.name,
        assetSize: typeof asset.size === 'number' ? asset.size : 0,
        hasChecksum: false,
        error: 'no-checksum'
      }
    }
    lastResolved = {
      name: asset.name,
      size: typeof asset.size === 'number' ? asset.size : 0,
      url: asset.browser_download_url,
      checksumSha256
    }

    return {
      hasUpdate: true,
      currentVersion,
      latestVersion: latestTag,
      releaseUrl,
      releaseNotes: release.body || '',
      assetName: asset.name,
      assetSize: lastResolved.size,
      hasChecksum: Boolean(checksumSha256)
    }
  } catch {
    return { hasUpdate: false, currentVersion, error: 'network' }
  }
}

function updatesDir(): string {
  return join(app.getPath('temp'), 'TwilightEcho-updates')
}

export function cancelAppUpdateDownload(): boolean {
  if (!activeAbort) return false
  activeAbort.abort()
  activeAbort = null
  return true
}

export async function downloadAppUpdate(): Promise<AppUpdateDownloadResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: '当前仅支持 Windows 应用内更新' }
  }
  if (activeAbort) {
    return { ok: false, error: '已有更新下载任务进行中' }
  }

  const controller = new AbortController()
  activeAbort = controller
  readyInstallerPath = null

  try {
    emitProgress({
      phase: 'resolving',
      percent: 0,
      receivedBytes: 0,
      totalBytes: 0,
      message: '正在解析更新包…'
    })

    let asset = lastResolved
    if (!asset) {
      const check = await checkForAppUpdate()
      if (check.error === 'network') return { ok: false, error: '网络错误，无法获取更新信息' }
      if (check.error === 'no-asset') {
        return { ok: false, error: 'GitHub Release 中未找到 Windows 安装包' }
      }
      if (check.error === 'no-checksum') {
        return { ok: false, error: 'GitHub Release 未提供 Windows 安装包的 SHA-256 校验和' }
      }
      if (!check.hasUpdate) return { ok: false, error: '当前已是最新版本' }
      asset = lastResolved
    }
    if (!asset) {
      return { ok: false, error: '未找到可下载的安装包' }
    }

    const dir = updatesDir()
    await mkdir(dir, { recursive: true })
    const targetPath = join(dir, basename(asset.name))
    await rm(targetPath, { force: true })

    const response = await fetch(asset.url, {
      headers: {
        ...GITHUB_HEADERS,
        Accept: 'application/octet-stream'
      },
      signal: controller.signal,
      redirect: 'follow'
    })
    if (!response.ok || !response.body) {
      return { ok: false, error: `下载失败：HTTP ${response.status}` }
    }

    const totalBytes = Number(response.headers.get('content-length') || 0) || asset.size || 0
    let receivedBytes = 0
    const hash = createHash('sha256')
    const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
    const fileStream = createWriteStream(targetPath)

    nodeStream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      receivedBytes += buf.length
      hash.update(buf)
      const percent =
        totalBytes > 0 ? Math.min(99, Math.floor((receivedBytes / totalBytes) * 100)) : 0
      emitProgress({
        phase: 'downloading',
        percent,
        receivedBytes,
        totalBytes,
        assetName: asset.name,
        message: '正在下载更新包…'
      })
    })

    await pipeline(nodeStream, fileStream)

    emitProgress({
      phase: 'verifying',
      percent: 100,
      receivedBytes,
      totalBytes: totalBytes || receivedBytes,
      assetName: asset.name,
      message: '正在校验文件…'
    })

    const digest = hash.digest('hex')
    let verified = false
    if (asset.checksumSha256) {
      if (digest !== asset.checksumSha256.toLowerCase()) {
        await rm(targetPath, { force: true })
        emitProgress({
          phase: 'error',
          percent: 0,
          receivedBytes: 0,
          totalBytes: 0,
          error: '安装包校验失败（SHA-256 不匹配）'
        })
        return { ok: false, error: '安装包校验失败（SHA-256 不匹配），已删除下载文件' }
      }
      verified = true
    }

    await writeFile(`${targetPath}.sha256`, `${digest}  ${basename(targetPath)}\n`, 'utf8')
    readyInstallerPath = targetPath

    emitProgress({
      phase: 'ready',
      percent: 100,
      receivedBytes,
      totalBytes: totalBytes || receivedBytes,
      assetName: asset.name,
      installerPath: targetPath,
      message: verified ? '校验通过，可以安装' : '已下载（发布页未提供校验和，未做哈希校验）'
    })

    return {
      ok: true,
      installerPath: targetPath,
      assetName: asset.name,
      verified,
      sha256: digest
    }
  } catch (error) {
    const cancelled =
      (error instanceof Error && error.name === 'AbortError') ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === 'ABORT_ERR')
    if (cancelled) {
      emitProgress({
        phase: 'error',
        percent: 0,
        receivedBytes: 0,
        totalBytes: 0,
        error: '已取消下载'
      })
      return { ok: false, error: '已取消下载', cancelled: true }
    }
    const message = error instanceof Error ? error.message : '下载失败'
    emitProgress({
      phase: 'error',
      percent: 0,
      receivedBytes: 0,
      totalBytes: 0,
      error: message
    })
    return { ok: false, error: message }
  } finally {
    activeAbort = null
  }
}

async function hashInstallerFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export async function installDownloadedAppUpdate(): Promise<AppUpdateInstallResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: '当前仅支持 Windows 应用内更新' }
  }
  const installerPath = readyInstallerPath
  if (!installerPath) {
    return { ok: false, error: '请先下载更新包' }
  }

  if (lastResolved?.checksumSha256) {
    try {
      const digest = await hashInstallerFile(installerPath)
      if (digest !== lastResolved.checksumSha256.toLowerCase()) {
        await rm(installerPath, { force: true })
        readyInstallerPath = null
        const error = '安装包校验失败（安装前 SHA-256 不匹配），已删除下载文件'
        emitProgress({
          phase: 'error',
          percent: 0,
          receivedBytes: 0,
          totalBytes: 0,
          error
        })
        return { ok: false, error, installerPath: null }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '安装前校验失败'
      emitProgress({
        phase: 'error',
        percent: 100,
        receivedBytes: 0,
        totalBytes: 0,
        installerPath,
        error: message
      })
      return { ok: false, error: message, installerPath }
    }
  }

  emitProgress({
    phase: 'installing',
    percent: 100,
    receivedBytes: 0,
    totalBytes: 0,
    installerPath,
    message: '正在启动安装程序…'
  })

  const openError = await shell.openPath(installerPath)
  if (openError) {
    emitProgress({
      phase: 'error',
      percent: 100,
      receivedBytes: 0,
      totalBytes: 0,
      installerPath,
      error: openError
    })
    return { ok: false, error: openError, installerPath }
  }

  setTimeout(() => {
    app.quit()
  }, 600)
  return { ok: true }
}

export function getAppUpdateMeta(): {
  releaseUrl: string
  latestVersion: string
  owner: string
  repo: string
} {
  return {
    releaseUrl: lastReleaseUrl,
    latestVersion: lastVersion,
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO
  }
}
