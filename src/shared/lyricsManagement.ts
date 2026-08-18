/**
 * Renderer-owned lyric choices live outside the library index so scanning a
 * folder can never discard a user's timing correction or hand-edited text.
 */
export type LyricSourcePreference = 'auto' | 'local' | 'provider' | 'manual'
export type LyricLayerSourceSelection = 'automatic' | 'local' | 'provider' | 'manual'
export type LyricSource = 'embedded' | 'local' | 'provider' | 'manual' | 'online'

export interface DesktopLyricsTrackPayload {
  lyrics: string | null
  translatedLyrics?: string | null
  romanizedLyrics?: string | null
  lyricsSource?: LyricSource | null
  translatedLyricsSource?: LyricSource | null
  title?: string
  artist?: string
}

export interface LyricTrackOverride {
  offsetMs: number
  source: LyricSourcePreference
  originalSelection?: LyricLayerSourceSelection
  translationSelection?: LyricLayerSourceSelection
  romanizationSelection?: LyricLayerSourceSelection
  original: string | null
  translation: string | null
  romanization: string | null
  updatedAt: string
}

export interface LyricsManagementDocument {
  schemaVersion: 1
  globalOffsetMs: number
  showOriginal: boolean
  showTranslation: boolean
  showRomanization: boolean
  tracks: Record<string, LyricTrackOverride>
}

export interface ManagedLyricsProjection {
  original: string | null | undefined
  translation: string | null | undefined
  romanization: string | null | undefined
  originalSource: string | null | undefined
  translationSource: string | null | undefined
  romanizationSource: string | null | undefined
}

export interface LyricDisplayContent {
  text: string
  translation: string | null
  romanization: string | null
}

export interface OnlineLyricsQuery {
  title: string
  artist: string
  album?: string
  durationSeconds?: number
}

export interface OnlineLyricsCandidate {
  id: number | string
  title: string
  artist: string
  album: string
  durationSeconds: number | null
  score: number
  syncedLyrics: string | null
  plainLyrics: string | null
  source: 'lrclib'
}

export interface OnlineLyricsSearchResult {
  query: OnlineLyricsQuery
  candidates: OnlineLyricsCandidate[]
  best: OnlineLyricsCandidate | null
}

export const DEFAULT_LYRICS_MANAGEMENT: LyricsManagementDocument = {
  schemaVersion: 1,
  globalOffsetMs: 0,
  showOriginal: true,
  showTranslation: true,
  showRomanization: false,
  tracks: {}
}

export const MAX_LYRIC_OFFSET_MS = 120_000
export const MAX_MANAGED_LYRIC_BYTES = 1_024 * 1_024
export const MAX_MANAGED_LYRIC_TRACKS = 5_000

export function effectiveLyricOffsetSeconds(globalOffsetMs: number, trackOffsetMs = 0): number {
  return (clampLyricOffset(globalOffsetMs) + clampLyricOffset(trackOffsetMs)) / 1000
}

export function projectManagedLyrics(
  automatic: ManagedLyricsProjection,
  override: LyricTrackOverride | undefined
): ManagedLyricsProjection {
  if (!override) return automatic
  const originalSelection = layerSelection(override, 'originalSelection')
  const translationSelection = layerSelection(override, 'translationSelection')
  const romanizationSelection = layerSelection(override, 'romanizationSelection')
  if (
    originalSelection === 'automatic' &&
    translationSelection === 'automatic' &&
    romanizationSelection === 'automatic'
  ) {
    return automatic
  }
  return {
    original: originalSelection === 'manual' ? (override.original ?? '') : automatic.original,
    translation:
      translationSelection === 'manual' ? (override.translation ?? null) : automatic.translation,
    romanization:
      romanizationSelection === 'manual' ? (override.romanization ?? null) : automatic.romanization,
    originalSource: originalSelection === 'manual' ? 'manual' : automatic.originalSource,
    translationSource:
      translationSelection === 'manual'
        ? override.translation
          ? 'manual'
          : null
        : automatic.translationSource,
    romanizationSource:
      romanizationSelection === 'manual'
        ? override.romanization
          ? 'manual'
          : null
        : automatic.romanizationSource
  }
}

function layerSelection(
  override: LyricTrackOverride,
  key: 'originalSelection' | 'translationSelection' | 'romanizationSelection'
): LyricLayerSourceSelection {
  const selection = override[key]
  if (
    selection === 'automatic' ||
    selection === 'local' ||
    selection === 'provider' ||
    selection === 'manual'
  ) {
    return selection
  }
  return override.source === 'manual' ? 'manual' : 'automatic'
}

export function projectLyricDisplay(
  line: LyricDisplayContent,
  preferences: Pick<
    LyricsManagementDocument,
    'showOriginal' | 'showTranslation' | 'showRomanization'
  >
): LyricDisplayContent {
  return {
    text: preferences.showOriginal ? line.text : '',
    translation: preferences.showTranslation ? line.translation : null,
    romanization: preferences.showRomanization ? line.romanization : null
  }
}

export function clampLyricOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(Math.max(-MAX_LYRIC_OFFSET_MS, Math.min(MAX_LYRIC_OFFSET_MS, value)))
}

export function isLyricsManagementDocument(value: unknown): value is LyricsManagementDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    record.schemaVersion !== 1 ||
    typeof record.globalOffsetMs !== 'number' ||
    typeof record.showOriginal !== 'boolean' ||
    typeof record.showTranslation !== 'boolean' ||
    typeof record.showRomanization !== 'boolean' ||
    !record.tracks ||
    typeof record.tracks !== 'object' ||
    Array.isArray(record.tracks)
  ) {
    return false
  }
  const tracks = record.tracks as Record<string, unknown>
  if (Object.keys(tracks).length > MAX_MANAGED_LYRIC_TRACKS) return false
  return Object.entries(tracks).every(([id, entry]) => isLyricTrackOverride(id, entry))
}

export function cloneLyricsManagementDocument(
  value: LyricsManagementDocument
): LyricsManagementDocument {
  return {
    ...value,
    tracks: Object.fromEntries(
      Object.entries(value.tracks).map(([id, override]) => [id, { ...override }])
    )
  }
}

function isLyricTrackOverride(id: string, value: unknown): value is LyricTrackOverride {
  if (!id || id.length > 1024 || !value || typeof value !== 'object' || Array.isArray(value))
    return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.offsetMs === 'number' &&
    Number.isFinite(entry.offsetMs) &&
    isLyricSourcePreference(entry.source) &&
    isOptionalLyricLayerSourceSelection(entry.originalSelection) &&
    isOptionalLyricLayerSourceSelection(entry.translationSelection) &&
    isOptionalLyricLayerSourceSelection(entry.romanizationSelection) &&
    isLyricText(entry.original) &&
    isLyricText(entry.translation) &&
    isLyricText(entry.romanization) &&
    typeof entry.updatedAt === 'string'
  )
}

function isLyricSourcePreference(value: unknown): value is LyricSourcePreference {
  return value === 'auto' || value === 'local' || value === 'provider' || value === 'manual'
}

function isOptionalLyricLayerSourceSelection(
  value: unknown
): value is LyricLayerSourceSelection | undefined {
  return (
    value === undefined ||
    value === 'automatic' ||
    value === 'local' ||
    value === 'provider' ||
    value === 'manual'
  )
}

function isLyricText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      new TextEncoder().encode(value).byteLength <= MAX_MANAGED_LYRIC_BYTES)
  )
}
