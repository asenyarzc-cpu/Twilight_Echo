import type { MotionPreference } from './motion.ts'

export const DESKTOP_LYRICS_SETTINGS_VERSION = 3
export const DESKTOP_LYRICS_MAX_CONTENT_BYTES = 1024 * 1024
export const DESKTOP_LYRICS_CLOCK_INTERVAL_MS = 250
export const DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE = { width: 176, height: 610 } as const

export type DesktopLyricsStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
export type DesktopLyricsTransportState = 'idle' | 'loading' | 'playing' | 'paused'
export type DesktopLyricsPalette = 'accent' | 'sunset' | 'twilight' | 'warm' | 'custom'
export type DesktopLyricsDisplayMode = 'single' | 'double'
export type DesktopLyricsWritingMode = 'horizontal' | 'vertical'
export type DesktopLyricsTextAlign = 'left' | 'center' | 'right'
export type DesktopLyricsTransportAction = 'previous' | 'playPause' | 'next'

export interface DesktopLyricsWord {
  text: string
  startMs: number
  endMs: number
}

export interface DesktopLyricsLine {
  id: string
  startMs: number | null
  endMs: number | null
  text: string
  translation?: string
  romanization?: string
  words?: DesktopLyricsWord[]
}

export interface DesktopLyricsSession {
  schemaVersion: 1
  sessionId: string
  contentRevision: number
  track: { id: string; title: string; artist: string } | null
  status: DesktopLyricsStatus
  lyricOffsetMs: number
  lines: DesktopLyricsLine[]
}

export interface DesktopLyricsClockSnapshot {
  schemaVersion: 1
  sessionId: string
  sequence: number
  epoch: number
  positionMs: number
  durationMs: number
  rate: number
  state: DesktopLyricsTransportState
}

export interface DesktopLyricsSettingsV3 {
  version: 3
  enabled: boolean
  windowWidth: number
  windowHeight: number
  windowX: number
  windowY: number
  alwaysOnTop: boolean
  locked: boolean
  fontFamily: string
  fontSize: number
  fontWeight: number
  lineGap: number
  palette: DesktopLyricsPalette
  customActiveColor: string
  customInactiveColor: string
  inactiveOpacity: number
  translationVisible: boolean
  romanizationVisible: boolean
  displayMode: DesktopLyricsDisplayMode
  writingMode: DesktopLyricsWritingMode
  textAlign: DesktopLyricsTextAlign
  textOutline: boolean
  backgroundOpacity: number
  shadowStrength: number
  motionIntensity: number
  hideWhenPaused: boolean
  pauseHideDelaySeconds: number
  resolvedFontFamily?: string
  accentColor?: string
  motionPreference?: MotionPreference
}

export interface DesktopLyricsBootstrap {
  settings: DesktopLyricsSettingsV3
  session: DesktopLyricsSession | null
  clock: DesktopLyricsClockSnapshot | null
}

export interface DesktopLyricsSlot {
  slot: 0 | 1
  line: DesktopLyricsLine | null
  active: boolean
  align: 'left' | 'right'
}

export const DEFAULT_DESKTOP_LYRICS_SETTINGS: DesktopLyricsSettingsV3 = {
  version: DESKTOP_LYRICS_SETTINGS_VERSION,
  enabled: false,
  windowWidth: 960,
  windowHeight: 196,
  windowX: -1,
  windowY: -1,
  alwaysOnTop: true,
  locked: false,
  fontFamily: 'MiSans',
  fontSize: 36,
  fontWeight: 400,
  lineGap: 12,
  palette: 'sunset',
  customActiveColor: '#f3a6a6',
  customInactiveColor: '#f4e4df',
  inactiveOpacity: 48,
  translationVisible: false,
  romanizationVisible: false,
  displayMode: 'double',
  writingMode: 'horizontal',
  textAlign: 'center',
  textOutline: true,
  backgroundOpacity: 0,
  shadowStrength: 55,
  motionIntensity: 70,
  hideWhenPaused: false,
  pauseHideDelaySeconds: 5
}

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export const DESKTOP_LYRICS_PALETTE_COLORS = {
  sunset: { active: '#f3a6a6', inactive: '#f4e4df' },
  twilight: { active: '#9b8cff', inactive: '#ddd7ff' },
  warm: { active: '#fff1d6', inactive: '#fff7e8' }
} as const

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function clamp(raw: unknown, min: number, max: number, fallback: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function color(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && COLOR_RE.test(raw.trim()) ? raw.trim().toLowerCase() : fallback
}

export function resolveDesktopLyricsPaletteColors(
  settings: Pick<
    DesktopLyricsSettingsV3,
    'palette' | 'customActiveColor' | 'customInactiveColor' | 'accentColor'
  >
): { active: string; inactive: string } {
  if (settings.palette === 'custom') {
    return {
      active: settings.customActiveColor,
      inactive: settings.customInactiveColor
    }
  }
  if (settings.palette === 'accent') {
    return {
      active: settings.accentColor || '#7aa2ff',
      inactive: '#ffffff'
    }
  }
  return DESKTOP_LYRICS_PALETTE_COLORS[settings.palette]
}

export function normalizeDesktopLyricsSettings(
  raw: unknown,
  options: { resetLegacy?: boolean } = {}
): DesktopLyricsSettingsV3 {
  const value = record(raw)
  const legacy = value.version !== DESKTOP_LYRICS_SETTINGS_VERSION
  const source = legacy && options.resetLegacy !== false ? {} : value
  const defaults = DEFAULT_DESKTOP_LYRICS_SETTINGS
  const fontFamily =
    typeof source.fontFamily === 'string' && source.fontFamily.trim()
      ? source.fontFamily.trim().slice(0, 64)
      : defaults.fontFamily
  const palette = ['accent', 'sunset', 'twilight', 'warm', 'custom'].includes(
    String(source.palette)
  )
    ? (source.palette as DesktopLyricsPalette)
    : defaults.palette
  const writingMode = source.writingMode === 'vertical' ? 'vertical' : defaults.writingMode
  const vertical = writingMode === 'vertical'
  const verticalWindowWasHorizontal =
    vertical && Number(source.windowWidth) >= 480 && Number(source.windowHeight) <= 320
  return {
    version: DESKTOP_LYRICS_SETTINGS_VERSION,
    enabled: value.enabled === true,
    windowWidth: clamp(
      verticalWindowWasHorizontal ? undefined : source.windowWidth,
      vertical ? 160 : 480,
      vertical ? 480 : 1920,
      vertical ? DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE.width : defaults.windowWidth
    ),
    windowHeight: clamp(
      verticalWindowWasHorizontal ? undefined : source.windowHeight,
      vertical ? 360 : 140,
      vertical ? 960 : 320,
      vertical ? DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE.height : defaults.windowHeight
    ),
    windowX: Number.isFinite(value.windowX) ? Number(value.windowX) : defaults.windowX,
    windowY: Number.isFinite(value.windowY) ? Number(value.windowY) : defaults.windowY,
    alwaysOnTop: source.alwaysOnTop !== false,
    locked: source.locked === true,
    fontFamily,
    fontSize: clamp(source.fontSize, 20, 64, defaults.fontSize),
    fontWeight: clamp(source.fontWeight, 400, 800, defaults.fontWeight),
    lineGap: clamp(source.lineGap, 0, 24, defaults.lineGap),
    palette,
    customActiveColor: color(source.customActiveColor, defaults.customActiveColor),
    customInactiveColor: color(source.customInactiveColor, defaults.customInactiveColor),
    inactiveOpacity: clamp(source.inactiveOpacity, 20, 80, defaults.inactiveOpacity),
    translationVisible:
      typeof source.translationVisible === 'boolean'
        ? source.translationVisible
        : defaults.translationVisible,
    romanizationVisible: source.romanizationVisible === true,
    displayMode: source.displayMode === 'single' ? 'single' : defaults.displayMode,
    writingMode,
    textAlign: ['left', 'center', 'right'].includes(String(source.textAlign))
      ? (source.textAlign as DesktopLyricsTextAlign)
      : defaults.textAlign,
    textOutline: source.textOutline !== false,
    backgroundOpacity: clamp(source.backgroundOpacity, 0, 60, defaults.backgroundOpacity),
    shadowStrength: clamp(source.shadowStrength, 0, 100, defaults.shadowStrength),
    motionIntensity: clamp(source.motionIntensity, 0, 100, defaults.motionIntensity),
    hideWhenPaused: source.hideWhenPaused === true,
    pauseHideDelaySeconds: clamp(
      source.pauseHideDelaySeconds,
      2,
      30,
      defaults.pauseHideDelaySeconds
    )
  }
}

export function desktopLyricsLineEnd(
  lines: readonly DesktopLyricsLine[],
  index: number
): number | null {
  const line = lines[index]
  if (!line || line.startMs == null) return null
  if (line.endMs != null && line.endMs >= line.startMs) return line.endMs
  for (let next = index + 1; next < lines.length; next += 1) {
    if (lines[next].startMs != null && lines[next].startMs! > line.startMs) {
      return lines[next].startMs
    }
  }
  const lastWord = line.words?.at(-1)
  return Math.max(line.startMs + 4000, lastWord?.endMs ?? 0)
}

export function findDesktopLyricsActiveIndex(
  lines: readonly DesktopLyricsLine[],
  positionMs: number
): number {
  let low = 0
  let high = lines.length - 1
  let answer = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    const start = lines[middle].startMs
    if (start == null || start <= positionMs) {
      if (start != null) answer = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return answer
}

export function resolveDesktopLyricsSlots(
  lines: readonly DesktopLyricsLine[],
  activeIndex: number
): [DesktopLyricsSlot, DesktopLyricsSlot] {
  const displayIndex = activeIndex >= 0 ? activeIndex : lines.length > 0 ? 0 : -1
  if (displayIndex < 0) {
    return [
      { slot: 0, line: null, active: false, align: 'left' },
      { slot: 1, line: null, active: false, align: 'right' }
    ]
  }
  const activeSlot = (displayIndex % 2) as 0 | 1
  const nextSlot = activeSlot === 0 ? 1 : 0
  const slots: [DesktopLyricsSlot, DesktopLyricsSlot] = [
    { slot: 0, line: null, active: false, align: 'left' },
    { slot: 1, line: null, active: false, align: 'right' }
  ]
  slots[activeSlot] = {
    slot: activeSlot,
    line: lines[displayIndex],
    active: activeIndex >= 0,
    align: activeSlot === 0 ? 'left' : 'right'
  }
  slots[nextSlot] = {
    slot: nextSlot,
    line: lines[displayIndex + 1] ?? null,
    active: false,
    align: nextSlot === 0 ? 'left' : 'right'
  }
  return slots
}

export function desktopLyricsWordProgress(word: DesktopLyricsWord, positionMs: number): number {
  const duration = Math.max(1, word.endMs - word.startMs)
  return Math.min(1, Math.max(0, (positionMs - word.startMs) / duration))
}

export function desktopLyricsFitScale(contentWidth: number, availableWidth: number): number {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0 || availableWidth <= 0) return 1
  return Math.max(0.72, Math.min(1, availableWidth / contentWidth))
}

export function acceptsDesktopLyricsClock(
  current: DesktopLyricsClockSnapshot | null,
  next: DesktopLyricsClockSnapshot,
  sessionId: string
): boolean {
  if (next.sessionId !== sessionId) return false
  if (!current || current.sessionId !== next.sessionId) return true
  if (next.epoch < current.epoch) return false
  return next.epoch > current.epoch || next.sequence > current.sequence
}
