import { stringifyJsonWithNestingLimit } from './jsonSafety.ts'

export const DEFAULT_IPC_STRING_MAX_LENGTH = 4096

export function normalizeIpcString(
  value: unknown,
  field: string,
  maxLength = DEFAULT_IPC_STRING_MAX_LENGTH
): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} is required`)
  if (normalized.length > maxLength) throw new Error(`${field} is too long`)
  if (/[\0\r\n]/.test(normalized)) throw new Error(`${field} contains invalid characters`)
  return normalized
}

export function normalizeOptionalIpcString(
  value: unknown,
  field: string,
  maxLength = DEFAULT_IPC_STRING_MAX_LENGTH
): string | undefined {
  if (value == null || value === '') return undefined
  return normalizeIpcString(value, field, maxLength)
}

export function normalizeFiniteNumber(
  value: unknown,
  _field: string,
  fallback: number,
  min: number,
  max: number
): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

export function normalizeInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number
): number {
  return Math.trunc(normalizeFiniteNumber(value, field, fallback, min, max))
}

export function stringifyJsonForIpcStorage(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  const json = stringifyJsonWithNestingLimit(value, field)
  if (Buffer.byteLength(json, 'utf-8') > maxBytes) throw new Error(`${field} is too large`)
  return json
}

export function normalizeIpcArray<T>(
  value: unknown,
  _field: string,
  maxItems: number,
  mapItem: (item: unknown, index: number) => T | null
): T[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, maxItems)
    .map(mapItem)
    .filter((item): item is T => item !== null)
}

export const MAX_LOCAL_PATH_LENGTH = 4096

export function isSafeLocalPath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  const normalized = path.trim()
  if (!normalized) return false
  if (normalized.length > MAX_LOCAL_PATH_LENGTH) return false
  const hasUrlScheme = /^[a-z][a-z0-9+.-]*:/i.test(normalized)
  // A drive letter reads as a URL scheme, so both native separators must be accepted here:
  // Electron dialogs and realpath() return backslashes on Windows.
  const isWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(normalized)
  if (hasUrlScheme && !isWindowsDrivePath) return false
  return true
}

export function normalizeLocalPath(path: unknown, field: string): string {
  const normalized = normalizeIpcString(path, field, MAX_LOCAL_PATH_LENGTH)
  if (!isSafeLocalPath(normalized)) throw new Error(`${field} is not a safe local path`)
  return normalized
}
