/**
 * Cover image loader.
 *
 * Track.cover stores a lightweight handle:
 * - `cover://<hash>.jpg` — local disk cache (must be materialized for display)
 * - `data:` — legacy embedded library covers
 * - `twilight-media://image/<token>` — in-memory remote-media grant (session-scoped)
 * - `http(s):` — rare pass-through when protection did not rewrite the field
 *
 * Remote provider covers are protected in main with a grant *and* a durable
 * `coverSource` (http/https). After process restart the grant map is empty, so
 * display paths re-issue a grant from `coverSource` before setting <img src>.
 *
 * IMPORTANT: never put raw `cover://` / `background://` into <img src> long-term.
 * Chromium's custom-protocol image cache can keep painting the first decoded
 * bitmap across track switches after a cold start (remount / navigation fixes
 * it). Materialize local handles to `data:` via IPC so each distinct cover is a
 * unique, cache-safe src.
 */

import { ref, type Ref, watch, type ComputedRef } from 'vue'

const remoteCoverGrantCache = new Map<string, string>()
const remoteCoverGrantInflight = new Map<string, Promise<string | null>>()
const localCoverDataCache = new Map<string, string>()
const localCoverDataInflight = new Map<string, Promise<string | null>>()

const LOCAL_COVER_DATA_CACHE_LIMIT = 128

/** Insert a materialized cover while keeping the renderer cache bounded. */
function cacheLocalCoverData(handle: string, dataUrl: string): void {
  // Re-setting an existing key should make it the newest entry for FIFO
  // eviction, avoiding eviction of a frequently reused cover.
  localCoverDataCache.delete(handle)
  localCoverDataCache.set(handle, dataUrl)
  while (localCoverDataCache.size > LOCAL_COVER_DATA_CACHE_LIMIT) {
    const oldest = localCoverDataCache.keys().next().value
    if (typeof oldest !== 'string') break
    localCoverDataCache.delete(oldest)
  }
}

function isTwilightMediaImageHandle(handle: string): boolean {
  return /^twilight-media:\/\/image\//i.test(handle.trim())
}

function isDurableRemoteCoverSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim())
}

function isProtocolLocalCoverHandle(handle: string): boolean {
  return /^cover:/i.test(handle) || /^background:/i.test(handle)
}

function isDisplayableCoverHandle(handle: string): boolean {
  // Protocol-local handles are NOT immediately safe for <img> after cold start —
  // they must be materialized first. data/blob/twilight-media can paint now.
  return /^data:/i.test(handle) || /^blob:/i.test(handle) || isTwilightMediaImageHandle(handle)
}

function bareLocalCoverHandle(handle: string): string {
  // Drop fragment/query cache-bust suffixes before IPC / disk lookup.
  return handle.trim().split(/[?#]/, 1)[0]
}

/**
 * Resolve a cover handle to a displayable image src.
 * - `null` / empty → returns null (or re-grants from durableSource when present)
 * - `cover://` / `background://` → materialized `data:` (avoids protocol cache stickiness)
 * - `data:` / `blob:` → returned as-is
 * - durable `coverSource` (http/https) when no local handle → re-granted twilight-media
 * - bare http(s) `cover` (legacy stats) → re-granted for CSP
 * - live `twilight-media:` without durable origin → returned as-is
 */
export async function resolveCover(
  handle: string | null | undefined,
  durableSource?: string | null
): Promise<string | null> {
  const source =
    typeof durableSource === 'string' && isDurableRemoteCoverSource(durableSource)
      ? durableSource.trim()
      : null

  const trimmedHandle = typeof handle === 'string' && handle.trim() ? handle.trim() : null

  // Local disk art always wins over durable remote origin. Provider enrichment
  // may attach coverSource while the track still has a correct cover:// handle;
  // preferring remote after restart made playbar/home art sticky or wrong.
  if (trimmedHandle && isProtocolLocalCoverHandle(trimmedHandle)) {
    const materialized = await materializeLocalCoverForDisplay(trimmedHandle)
    if (materialized) return materialized
    // Last resort: raw protocol URL (may stick in Chromium — prefer materialize).
    return bareLocalCoverHandle(trimmedHandle)
  }

  if (trimmedHandle && (/^data:/i.test(trimmedHandle) || /^blob:/i.test(trimmedHandle))) {
    return trimmedHandle
  }

  // Prefer durable origin for remote-only rows (session restore / listening stats).
  if (source) {
    const granted = await grantRemoteCoverForDisplay(source)
    if (granted) return granted
    if (trimmedHandle && isTwilightMediaImageHandle(trimmedHandle)) {
      return trimmedHandle
    }
    return null
  }

  if (!trimmedHandle) return null

  if (isDurableRemoteCoverSource(trimmedHandle)) {
    const granted = await grantRemoteCoverForDisplay(trimmedHandle)
    if (granted) return granted
    return null
  }

  if (isTwilightMediaImageHandle(trimmedHandle)) {
    return trimmedHandle
  }

  return trimmedHandle
}

async function materializeLocalCoverForDisplay(handle: string): Promise<string | null> {
  const bare = bareLocalCoverHandle(handle)
  if (!bare) return null

  const cached = localCoverDataCache.get(bare)
  if (cached) return cached

  const inflight = localCoverDataInflight.get(bare)
  if (inflight) return inflight

  const request = (async () => {
    try {
      const api = (
        globalThis as {
          window?: {
            api?: {
              data?: {
                getCover?: (src: string) => Promise<string | Uint8Array | null>
              }
            }
          }
        }
      ).window?.api?.data
      if (api?.getCover) {
        const response = await api.getCover(bare)
        if (typeof response === 'string' && response.startsWith('data:')) {
          const dataUrl = response
          cacheLocalCoverData(bare, dataUrl)
          return dataUrl
        }
        const materialized = await coverBytesToDataUrl(response, bare)
        if (materialized) {
          cacheLocalCoverData(bare, materialized)
          return materialized
        }
      }

      // Fallback when IPC is unavailable (tests / early boot): fetch protocol.
      if (typeof fetch === 'function') {
        const response = await fetch(bare)
        if (!response.ok) return null
        const blob = await response.blob()
        const dataUrl = await blobToDataUrl(blob)
        if (dataUrl) {
          cacheLocalCoverData(bare, dataUrl)
          return dataUrl
        }
      }
      return null
    } catch {
      return null
    } finally {
      localCoverDataInflight.delete(bare)
    }
  })()

  localCoverDataInflight.set(bare, request)
  return request
}

async function coverBytesToDataUrl(value: unknown, handle: string): Promise<string | null> {
  let bytes: Uint8Array | null = null
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (!bytes || bytes.byteLength === 0) return null
  const extension = handle.split(/[?#]/, 1)[0].toLowerCase()
  const type = extension.endsWith('.png')
    ? 'image/png'
    : extension.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg'
  return blobToDataUrl(new Blob([bytes as unknown as BlobPart], { type }))
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

async function grantRemoteCoverForDisplay(source: string): Promise<string | null> {
  const normalized = source.trim()
  if (!normalized) return null
  return ensureCachedRemoteGrant(normalized)
}

/** Drop a single origin from the grant cache so the next resolve re-issues a token. */
export function invalidateRemoteCoverGrant(source: string): void {
  const normalized = source.trim()
  if (!normalized) return
  remoteCoverGrantCache.delete(normalized)
  remoteCoverGrantInflight.delete(normalized)
}

async function ensureCachedRemoteGrant(source: string): Promise<string | null> {
  const normalized = source.trim()
  if (!normalized) return null
  const existing = remoteCoverGrantCache.get(normalized)
  if (existing) return existing

  const inflight = remoteCoverGrantInflight.get(normalized)
  if (inflight) return inflight

  const request = (async () => {
    try {
      const api = (
        globalThis as {
          window?: { api?: { data?: { grantRemoteCover?: (src: string) => Promise<string> } } }
        }
      ).window?.api?.data
      if (!api?.grantRemoteCover) return null
      const granted = await api.grantRemoteCover(normalized)
      if (typeof granted === 'string' && granted.trim()) {
        const token = granted.trim()
        remoteCoverGrantCache.set(normalized, token)
        if (remoteCoverGrantCache.size > 256) {
          const first = remoteCoverGrantCache.keys().next().value
          if (first) remoteCoverGrantCache.delete(first)
        }
        return token
      }
      return null
    } catch {
      return null
    } finally {
      remoteCoverGrantInflight.delete(normalized)
    }
  })()

  remoteCoverGrantInflight.set(normalized, request)
  return request
}

/** Clear re-grant cache (tests / after clear-cache). */
export function clearRemoteCoverGrantCache(): void {
  remoteCoverGrantCache.clear()
  remoteCoverGrantInflight.clear()
}

export function clearLocalCoverDataCache(): void {
  localCoverDataCache.clear()
  localCoverDataInflight.clear()
}

/**
 * Vue composable: reactively resolve a cover handle (and optional durable origin).
 * Returns a ref that updates when either input changes.
 * Never leaves a previous track's art painted while the next cover resolves.
 */
export function useCover(
  handleRef: ComputedRef<string | null | undefined> | Ref<string | null | undefined>,
  sourceRef?: ComputedRef<string | null | undefined> | Ref<string | null | undefined>
): Ref<string | null> {
  const resolved = ref<string | null>(null)
  let requestId = 0

  watch(
    () => [handleRef.value, sourceRef?.value] as const,
    ([handle, source], previous) => {
      const id = ++requestId
      const trimmed = typeof handle === 'string' && handle.trim() ? handle.trim() : null
      const inputsChanged = !previous || previous[0] !== handle || previous[1] !== source

      // Always clear on input change so Chromium cannot keep the previous bitmap
      // while async materialize / re-grant runs (protocol-local handles included).
      if (inputsChanged) {
        resolved.value = null
      }

      // Only paint handles that are safe without async work.
      if (trimmed && isDisplayableCoverHandle(trimmed) && !isProtocolLocalCoverHandle(trimmed)) {
        resolved.value = trimmed
      }

      void resolveCover(handle, source).then((next) => {
        if (id !== requestId) return
        resolved.value = next
      })
    },
    { immediate: true }
  )

  return resolved
}

/** Clear local + remote cover display caches. */
export function clearCoverCache(): void {
  clearRemoteCoverGrantCache()
  clearLocalCoverDataCache()
}
