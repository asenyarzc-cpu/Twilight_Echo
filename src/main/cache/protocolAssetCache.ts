import { readFile } from 'fs/promises'

const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024

type ProtocolAssetBytes = NonSharedBuffer
export type { ProtocolAssetBytes }

const cachedBytesByPath = new Map<string, ProtocolAssetBytes>()
const readsInFlightByPath = new Map<string, Promise<ProtocolAssetBytes | null>>()
let cachedBytesTotal = 0
let maxCacheBytes = DEFAULT_MAX_CACHE_BYTES

/**
 * Read file bytes for a protocol handler response, trying paths in order.
 * Served bytes are kept in a byte-budgeted LRU so repeat cover/background
 * requests never touch the disk again and never block the main thread.
 */
export async function readCachedProtocolFile(
  ...paths: string[]
): Promise<ProtocolAssetBytes | null> {
  for (const path of paths) {
    const data = await readCachedProtocolPath(path)
    if (data) return data
  }
  return null
}

async function readCachedProtocolPath(filePath: string): Promise<ProtocolAssetBytes | null> {
  const cached = cachedBytesByPath.get(filePath)
  if (cached) {
    cachedBytesByPath.delete(filePath)
    cachedBytesByPath.set(filePath, cached)
    return cached
  }

  let read = readsInFlightByPath.get(filePath)
  if (!read) {
    read = readFile(filePath)
      .then((data) => {
        cachedBytesByPath.set(filePath, data)
        cachedBytesTotal += data.byteLength
        evictOverflow()
        return data
      })
      .catch(() => null)
      .finally(() => {
        readsInFlightByPath.delete(filePath)
      })
    readsInFlightByPath.set(filePath, read)
  }
  return read
}

function evictOverflow(): void {
  while (cachedBytesTotal > maxCacheBytes && cachedBytesByPath.size > 1) {
    const oldest = cachedBytesByPath.keys().next().value
    if (oldest === undefined) break
    const evicted = cachedBytesByPath.get(oldest)
    cachedBytesByPath.delete(oldest)
    cachedBytesTotal -= evicted?.byteLength ?? 0
  }
}

export function resetProtocolAssetCacheForTests(): void {
  cachedBytesByPath.clear()
  readsInFlightByPath.clear()
  cachedBytesTotal = 0
  maxCacheBytes = DEFAULT_MAX_CACHE_BYTES
}

export function setProtocolAssetCacheMaxBytesForTests(bytes: number): void {
  maxCacheBytes = bytes
  evictOverflow()
}
