import { app } from 'electron'
import { stat } from 'fs/promises'
import { dirname, extname, join, resolve } from 'path'
import type { AppSettings } from '../core/types'
import { runtime } from '../core/runtime'
import { getDefaultCachePath } from '../core/settings'
import { SUPPORTED_EXTENSIONS } from '../../shared/audioFormats.ts'
import { MANAGED_MUSIC_CACHE_DIRECTORY_NAMES } from '../../shared/musicCacheLayout.ts'
import {
  CanonicalPathGrantSet,
  isCanonicalPathInside,
  lexicalPathKey,
  resolveCanonicalExistingPath
} from './pathGrants.ts'
import { classifyAudioSource } from './audioSourcePolicy.ts'

const IMPULSE_RESPONSE_EXTENSIONS = new Set(['.wav', '.flac', '.aiff', '.aif'])

const libraryGrants = new CanonicalPathGrantSet()
const cacheRootGrants = new CanonicalPathGrantSet()
const audioCacheGrants = new CanonicalPathGrantSet()
const appDataGrants = new CanonicalPathGrantSet()
const impulseResponseGrants = new CanonicalPathGrantSet()
const vst3SearchPathGrants = new CanonicalPathGrantSet()

const declaredLibraryRoots = new Map<string, string>()
const declaredCacheRoots = new Map<string, string>()
const declaredImpulseResponseFiles = new Map<string, string>()
const declaredVst3SearchPaths = new Map<string, string>()

let initializationPromise: Promise<void> | null = null

export function initializeLocalPathGrants(
  settings: AppSettings = getLaunchSettings()
): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = initializeLocalPathGrantsOnce(settings)
  }
  return initializationPromise
}

export async function grantUserSelectedLibraryRoot(folder: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await libraryGrants.grantRoot(folder)
  declaredLibraryRoots.set(lexicalPathKey(folder), resolve(folder))
  return canonicalPath
}

export async function grantUserSelectedCacheRoot(folder: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await grantCacheRoot(folder)
  declaredCacheRoots.set(lexicalPathKey(folder), resolve(folder))
  return canonicalPath
}

export async function grantUserSelectedImpulseResponse(filePath: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await resolveCanonicalExistingPath(filePath, 'file')
  assertImpulseResponseExtension(canonicalPath)
  impulseResponseGrants.grantCanonicalFile(canonicalPath)
  declaredImpulseResponseFiles.set(lexicalPathKey(filePath), resolve(filePath))
  return canonicalPath
}

export async function grantUserSelectedVst3SearchPath(folder: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await vst3SearchPathGrants.grantRoot(folder)
  declaredVst3SearchPaths.set(lexicalPathKey(folder), resolve(folder))
  return canonicalPath
}

/**
 * The VST3 catalog is main-process owned. Re-granting persisted roots here
 * keeps renderer-provided paths from becoming an authority source.
 */
export async function registerManagedVst3SearchPaths(paths: string[]): Promise<string[]> {
  await ensureInitialized()
  const authorized: string[] = []
  for (const folder of paths) {
    if (typeof folder !== 'string' || !folder.trim()) continue
    try {
      const canonicalPath = await vst3SearchPathGrants.grantRoot(folder)
      declaredVst3SearchPaths.set(lexicalPathKey(folder), resolve(folder))
      authorized.push(canonicalPath)
    } catch {
      // Offline or removed VST3 paths stay visible in the catalog but are not scanned.
    }
  }
  return authorized
}

export async function resolveAuthorizedVst3SearchPaths(paths: unknown): Promise<string[]> {
  await ensureInitialized()
  if (!Array.isArray(paths)) throw new Error('VST3 搜索目录必须是数组')
  const authorized: string[] = []
  const seen = new Set<string>()
  for (const folder of paths) {
    if (typeof folder !== 'string' || !folder.trim()) throw new Error('VST3 搜索目录无效')
    const canonicalPath = await vst3SearchPathGrants.resolveExactRoot(folder)
    if (!canonicalPath) throw new Error('VST3 搜索目录未经用户授权')
    const key = lexicalPathKey(canonicalPath)
    if (!seen.has(key)) {
      seen.add(key)
      authorized.push(canonicalPath)
    }
  }
  return authorized
}

export async function resolveAuthorizedLibraryRootSettings(folders: unknown): Promise<string[]> {
  await ensureInitialized()
  if (!Array.isArray(folders)) throw new Error('音乐库目录必须是数组')
  await refreshDeclaredLibraryRoots()

  const authorized: string[] = []
  const seen = new Set<string>()
  for (const folder of folders) {
    if (typeof folder !== 'string' || !folder.trim()) {
      throw new Error('音乐库目录无效')
    }
    const canonicalPath = await tryResolveWithinRoots(libraryGrants, folder, 'directory')
    const resolvedPath = canonicalPath ?? resolveDeclaredExactPath(declaredLibraryRoots, folder)
    if (!resolvedPath) throw new Error('音乐库目录未经用户授权')
    const key = lexicalPathKey(resolvedPath)
    if (!seen.has(key)) {
      seen.add(key)
      authorized.push(resolvedPath)
    }
  }
  return authorized
}

export async function filterAuthorizedLibraryRoots(folders: unknown): Promise<string[]> {
  if (!Array.isArray(folders)) return []
  const authorized: string[] = []
  for (const folder of folders) {
    try {
      const [resolvedPath] = await resolveAuthorizedLibraryRootSettings([folder])
      if (
        resolvedPath &&
        !authorized.some((item) => lexicalPathKey(item) === lexicalPathKey(resolvedPath))
      ) {
        authorized.push(resolvedPath)
      }
    } catch {
      // Persisted renderer data is not an authority source. Ignore ungranted roots.
    }
  }
  return authorized
}

export async function resolveAuthorizedCacheRoot(rootPath: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await resolveCanonicalExistingPath(rootPath, 'directory')
  if (!cacheRootGrants.hasCanonicalRoot(canonicalPath)) {
    await refreshDeclaredCacheRoots()
  }
  if (!cacheRootGrants.hasCanonicalRoot(canonicalPath)) {
    throw new Error('缓存目录未经用户授权')
  }
  return canonicalPath
}

export async function resolveAuthorizedAudioFile(filePath: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await resolveCanonicalExistingPath(filePath, 'file')
  assertSupportedAudioExtension(canonicalPath)
  let inLibrary = libraryGrants.isCanonicalWithinRoots(canonicalPath)
  let inManagedCache = audioCacheGrants.isCanonicalWithinRoots(canonicalPath)
  if (!inLibrary && !inManagedCache) {
    await Promise.all([refreshDeclaredLibraryRoots(), refreshDeclaredCacheRoots()])
    inLibrary = libraryGrants.isCanonicalWithinRoots(canonicalPath)
    inManagedCache = audioCacheGrants.isCanonicalWithinRoots(canonicalPath)
  }
  if (!inLibrary && !inManagedCache) {
    throw new Error('音频路径不在已授权目录内')
  }
  return canonicalPath
}

export async function resolveAuthorizedAudioSource(source: string): Promise<string> {
  const candidate = classifyAudioSource(source)
  return candidate.kind === 'local'
    ? await resolveAuthorizedAudioFile(candidate.source)
    : candidate.source
}

export async function resolveAuthorizedImpulseResponseFile(filePath: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await resolveCanonicalExistingPath(filePath, 'file')
  if (!impulseResponseGrants.hasCanonicalFile(canonicalPath)) {
    await refreshDeclaredImpulseResponseFiles()
  }
  if (!impulseResponseGrants.hasCanonicalFile(canonicalPath)) {
    throw new Error('卷积脉冲响应文件未经用户授权')
  }
  assertImpulseResponseExtension(canonicalPath)
  return canonicalPath
}

export async function resolveAuthorizedLibraryDirectory(dirPath: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await resolveCanonicalExistingPath(dirPath, 'directory')
  if (!libraryGrants.isCanonicalWithinRoots(canonicalPath)) {
    await refreshDeclaredLibraryRoots()
  }
  if (!libraryGrants.isCanonicalWithinRoots(canonicalPath)) {
    throw new Error('目录不在已授权音乐库内')
  }
  return canonicalPath
}

export async function resolveAuthorizedOpenPath(targetPath: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await resolveCanonicalExistingPath(targetPath)
  const targetStat = await stat(canonicalPath)
  if (targetStat.isDirectory()) {
    if (!isCanonicalDirectoryAllowed(canonicalPath)) {
      await Promise.all([refreshDeclaredLibraryRoots(), refreshDeclaredCacheRoots()])
    }
    if (isCanonicalDirectoryAllowed(canonicalPath)) return canonicalPath
    throw new Error('目录不在已授权范围内')
  }
  if (!libraryGrants.isCanonicalWithinRoots(canonicalPath)) {
    await refreshDeclaredLibraryRoots()
  }
  if (!libraryGrants.isCanonicalWithinRoots(canonicalPath)) {
    throw new Error('文件不在音乐库内')
  }
  assertSupportedAudioExtension(canonicalPath)
  return canonicalPath
}

export async function resolveAuthorizedShowItemPath(filePath: string): Promise<string> {
  await ensureInitialized()
  const canonicalPath = await resolveCanonicalExistingPath(filePath)
  const targetStat = await stat(canonicalPath)
  const checkedPath = targetStat.isDirectory() ? canonicalPath : dirname(canonicalPath)
  if (!isCanonicalDirectoryAllowed(checkedPath)) {
    await Promise.all([refreshDeclaredLibraryRoots(), refreshDeclaredCacheRoots()])
  }
  if (!isCanonicalDirectoryAllowed(checkedPath)) {
    throw new Error('路径不在已授权范围内')
  }
  return canonicalPath
}

async function initializeLocalPathGrantsOnce(settings: AppSettings): Promise<void> {
  await appDataGrants.grantRoot(app.getPath('userData'))

  for (const folder of settings.libraryFolders ?? []) {
    if (typeof folder === 'string' && folder.trim()) {
      declaredLibraryRoots.set(lexicalPathKey(folder), resolve(folder))
    }
  }

  const cachePath = settings.musicCachePath || settings.cachePath || getDefaultCachePath()
  for (const folder of [cachePath, getDefaultCachePath()]) {
    if (folder) declaredCacheRoots.set(lexicalPathKey(folder), resolve(folder))
  }

  const impulseResponsePath = settings.audioProcessing?.convolverIrPath
  if (impulseResponsePath) {
    declaredImpulseResponseFiles.set(
      lexicalPathKey(impulseResponsePath),
      resolve(impulseResponsePath)
    )
  }

  await Promise.all([
    refreshDeclaredLibraryRoots(),
    refreshDeclaredCacheRoots(),
    refreshDeclaredImpulseResponseFiles()
  ])
}

async function ensureInitialized(): Promise<void> {
  await initializeLocalPathGrants()
}

function getLaunchSettings(): AppSettings {
  return Array.isArray(runtime.launchSettings?.libraryFolders)
    ? runtime.launchSettings
    : runtime.appSettings
}

async function refreshDeclaredLibraryRoots(): Promise<void> {
  await Promise.all(
    [...declaredLibraryRoots.values()].map(async (folder) => {
      try {
        await libraryGrants.grantRoot(folder)
      } catch {
        // Missing or offline startup roots remain declared but grant no filesystem access.
      }
    })
  )
}

async function refreshDeclaredCacheRoots(): Promise<void> {
  await Promise.all(
    [...declaredCacheRoots.values()].map(async (folder) => {
      try {
        await grantCacheRoot(folder)
      } catch {
        // A missing or unsafe cache layout is not granted.
      }
    })
  )
}

async function refreshDeclaredImpulseResponseFiles(): Promise<void> {
  await Promise.all(
    [...declaredImpulseResponseFiles.values()].map(async (filePath) => {
      try {
        const canonicalPath = await resolveCanonicalExistingPath(filePath, 'file')
        assertImpulseResponseExtension(canonicalPath)
        impulseResponseGrants.grantCanonicalFile(canonicalPath)
      } catch {
        // Missing startup IR files remain configured but cannot be loaded until available.
      }
    })
  )
}

async function grantCacheRoot(rootPath: string): Promise<string> {
  const canonicalRoot = await resolveCanonicalExistingPath(rootPath, 'directory')
  const managedDirectories = await Promise.all(
    MANAGED_MUSIC_CACHE_DIRECTORY_NAMES.map((name) =>
      resolveCanonicalExistingPath(join(canonicalRoot, name), 'directory')
    )
  )
  if (managedDirectories.some((directory) => !isCanonicalPathInside(canonicalRoot, directory))) {
    throw new Error('缓存子目录越出已选择的缓存根目录')
  }
  cacheRootGrants.grantCanonicalRoot(canonicalRoot)
  for (const directory of managedDirectories) {
    audioCacheGrants.grantCanonicalRoot(directory)
  }
  return canonicalRoot
}

function resolveDeclaredExactPath(
  declarations: Map<string, string>,
  targetPath: string
): string | null {
  return declarations.get(lexicalPathKey(targetPath)) ?? null
}

async function tryResolveWithinRoots(
  grants: CanonicalPathGrantSet,
  targetPath: string,
  kind: 'any' | 'directory' | 'file'
): Promise<string | null> {
  try {
    return await grants.resolveWithinRoots(targetPath, kind)
  } catch {
    return null
  }
}

function isCanonicalDirectoryAllowed(canonicalPath: string): boolean {
  return (
    libraryGrants.isCanonicalWithinRoots(canonicalPath) ||
    cacheRootGrants.hasCanonicalRoot(canonicalPath) ||
    audioCacheGrants.isCanonicalWithinRoots(canonicalPath) ||
    appDataGrants.isCanonicalWithinRoots(canonicalPath)
  )
}

function assertSupportedAudioExtension(filePath: string): void {
  if (!SUPPORTED_EXTENSIONS.includes(extname(filePath).toLowerCase())) {
    throw new Error('不支持的音频文件类型')
  }
}

function assertImpulseResponseExtension(filePath: string): void {
  if (!IMPULSE_RESPONSE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error('不支持的卷积脉冲响应文件类型')
  }
}
