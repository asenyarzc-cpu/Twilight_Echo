import { THEME_MANAGED_DATA_ATTRIBUTES } from '../../../shared/theme.ts'

const STORAGE_KEY = 'twilight-echo:theme-runtime-cache:v1'
const SCHEMA_VERSION = 1
const MAX_CACHE_BYTES = 512 * 1024
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const CACHED_ATTRIBUTE = 'data-theme-cached'

interface ThemeRuntimeCacheEnvelope {
  schemaVersion: number
  savedAt: number
  css: string
  attributes: Record<string, string>
  theme: string
  tone: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readCache(): ThemeRuntimeCacheEnvelope | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw || new Blob([raw]).size > MAX_CACHE_BYTES) return null
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return null
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      typeof value.savedAt !== 'number' ||
      Date.now() - value.savedAt > MAX_CACHE_AGE_MS ||
      typeof value.css !== 'string' ||
      typeof value.theme !== 'string' ||
      typeof value.tone !== 'string' ||
      !isRecord(value.attributes)
    ) {
      return null
    }
    const attributes: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value.attributes)) {
      if (
        THEME_MANAGED_DATA_ATTRIBUTES.includes(key as `data-te-${string}`) &&
        typeof entry === 'string'
      ) {
        attributes[key] = entry
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      savedAt: value.savedAt,
      css: value.css,
      attributes,
      theme: value.theme,
      tone: value.tone
    }
  } catch {
    return null
  }
}

export function injectCachedThemeRuntime(): boolean {
  const cache = readCache()
  if (!cache) return false
  try {
    let style = document.getElementById('twilight-theme-runtime') as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = 'twilight-theme-runtime'
      document.head.appendChild(style)
    }
    style.textContent = cache.css
    for (const attribute of THEME_MANAGED_DATA_ATTRIBUTES) {
      document.documentElement.removeAttribute(attribute)
    }
    for (const [attribute, value] of Object.entries(cache.attributes)) {
      document.documentElement.setAttribute(attribute, value)
    }
    document.documentElement.dataset.theme = cache.tone
    document.documentElement.dataset.activeTheme = cache.theme
    document.documentElement.style.colorScheme = cache.tone === 'dark' ? 'dark' : 'light'
    document.documentElement.setAttribute(CACHED_ATTRIBUTE, 'true')
    return true
  } catch {
    return false
  }
}

export function persistThemeRuntimeCache(state: {
  css: string
  attributes: Record<string, string>
  activeTheme: string
  tone: string
}): void {
  try {
    const envelope: ThemeRuntimeCacheEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      css: state.css,
      attributes: state.attributes,
      theme: state.activeTheme,
      tone: state.tone
    }
    const raw = JSON.stringify(envelope)
    if (new Blob([raw]).size > MAX_CACHE_BYTES) return
    localStorage.setItem(STORAGE_KEY, raw)
  } catch {
    // Storage can be disabled or full; the runtime theme remains authoritative.
  }
}

export function markThemeRuntimeFresh(): void {
  document.documentElement.removeAttribute(CACHED_ATTRIBUTE)
}

export function clearCachedThemeRuntime(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage failures during recovery.
  }
}

export const themeRuntimeCacheStorageKey = STORAGE_KEY
