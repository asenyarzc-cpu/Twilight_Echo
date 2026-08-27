/**
 * Shared utility functions extracted from duplicated code across the codebase.
 * @module shared/utils
 */

/**
 * Compare two semantic version strings.
 * Returns positive if a > b, negative if a < b, 0 if equal.
 * Strips leading 'v' prefix and handles pre-release tags.
 */
export function compareSemver(a: string, b: string): number {
  const parseVersion = (v: string): number[] => {
    const clean = v.replace(/^v/i, '').split('-')[0].split('.')
    return clean.map((n) => parseInt(n, 10) || 0)
  }
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Clamp a number to [min, max] range, returning fallback if invalid.
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Format seconds as mm:ss or h:mm:ss.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Default EQ band frequencies (Hz).
 */
export const DEFAULT_EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

/**
 * Check if a path is inside another path (for security checks).
 */
export function isInsidePath(target: string, container: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const t = normalize(target)
  const c = normalize(container)
  return t === c || t.startsWith(c + '/')
}
