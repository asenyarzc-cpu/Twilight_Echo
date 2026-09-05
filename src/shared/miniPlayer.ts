import type { MotionPreference } from './motion.ts'

// Keep the full transport layout usable at every supported display scale.
export const MINI_PLAYER_MIN_WIDTH = 420
export const MINI_PLAYER_MIN_HEIGHT = 220
export const MINI_PLAYER_MAX_WIDTH = 900
export const MINI_PLAYER_MAX_HEIGHT = 520

export const DEFAULT_MINI_PLAYER_STYLE_ID = 'aurora-glass'
export const PORCELAIN_MINI_PLAYER_STYLE_ID = 'porcelain'

export interface MiniPlayerWindowSize {
  width: number
  height: number
}

export type MiniPlayerBackgroundKind = 'solid' | 'gradient' | 'cover' | 'image'
export type MiniPlayerImageFit = 'cover' | 'contain'
export type MiniPlayerLayoutPreference = 'auto' | 'compact' | 'standard' | 'wide'

export interface MiniPlayerBackgroundSettings {
  kind: MiniPlayerBackgroundKind
  solidColor: string
  fallbackColor: string
  gradientStart: string
  gradientEnd: string
  gradientAngle: number
  imageUrl: string
  imageFit: MiniPlayerImageFit
  blur: number
  brightness: number
  saturation: number
  opacity: number
  overlayColor: string
  overlayOpacity: number
}

export interface MiniPlayerAppearanceSettings {
  accentMode: 'track' | 'custom'
  accentColor: string
  textMode: 'auto' | 'custom'
  primaryTextColor: string
  mutedTextColor: string
  fontFamily: string
  surfaceOpacity: number
  glassBlur: number
  cornerRadius: number
  borderWidth: number
  borderColor: string
  shadowStrength: number
  shadowColor: string
}

export interface MiniPlayerLayoutSettings {
  preference: MiniPlayerLayoutPreference
}

export interface MiniPlayerVisibilitySettings {
  artwork: boolean
  album: boolean
  equalizer: boolean
  time: boolean
  volume: boolean
  playMode: boolean
  queuePosition: boolean
}

export interface MiniPlayerThemeProfile {
  background: MiniPlayerBackgroundSettings
  appearance: MiniPlayerAppearanceSettings
  layout: MiniPlayerLayoutSettings
  visibility: MiniPlayerVisibilitySettings
}

export interface MiniPlayerSettings {
  windowX: number
  windowY: number
  windowWidth: number
  windowHeight: number
  alwaysOnTop: boolean
  /** Whether the satellite window owns an independent Windows taskbar entry. */
  showInTaskbar: boolean
  positionLocked: boolean
  activeStyleId: string
  profiles: Record<string, MiniPlayerThemeProfile>
}

export interface MiniPlayerTrackSnapshot {
  id: string
  title: string
  artist: string
  album: string
  albumArtist: string
  trackNumber: number
  cover: string | null
  /** Source codec label (FLAC / MP3 / DSD...), when the track carries it. */
  format: string | null
  /** Sample rate in Hz (44100 / 192000...), when known. */
  sampleRate: number | null
  /** Bit depth (16 / 24 / 32...), when known. */
  bitDepth: number | null
  /**
   * Durable remote cover origin (http/https). Session-scoped twilight-media
   * grants in `cover` die with the main process; the mini player re-grants
   * from this the same way the main window does.
   */
  coverSource: string | null
}

export type MiniPlayerPlayMode = 'sequential' | 'listLoop' | 'repeat' | 'shuffle' | 'heart'

/**
 * One timed lyric line pushed to the mini player. The mini player uses the
 * per-line timestamps to switch the highlighted line itself, so it can show
 * several surrounding lines without relying on a slow marquee.
 */
export interface MiniPlayerLyricLineSnapshot {
  time: number | null
  original: string
  translation: string | null
}

export interface MiniPlayerStateSnapshot {
  track: MiniPlayerTrackSnapshot | null
  /**
   * Current lyric line at snapshot time (original + optional translation).
   * Null when no line is active yet / lyrics are unavailable. The mini player
   * shows it when the cursor leaves the window; hovering returns to metadata.
   */
  currentLyric: { original: string; translation: string | null } | null
  /** Timed lyric lines (sorted by time) for the mini player's multi-line view. */
  lyrics: MiniPlayerLyricLineSnapshot[]
  isPlaying: boolean
  isLoading: boolean
  currentTime: number
  duration: number
  playbackRate: number
  volume: number
  playMode: MiniPlayerPlayMode
  favoriteAvailable: boolean
  favoriteLiked: boolean
  favoriteLoading: boolean
  dominantColor: string
  queueIndex: number
  queueLength: number
}

export type MiniPlayerCommand =
  | { type: 'toggle-play' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'previous' }
  | { type: 'next' }
  | { type: 'cycle-play-mode' }
  | { type: 'set-play-mode'; value: MiniPlayerPlayMode }
  | { type: 'toggle-favorite' }
  | { type: 'seek'; value: number }
  | { type: 'set-volume'; value: number }

export type MiniPlayerSettingsPatch = Partial<
  Pick<
    MiniPlayerSettings,
    | 'alwaysOnTop'
    | 'showInTaskbar'
    | 'positionLocked'
    | 'activeStyleId'
    | 'profiles'
    | 'windowWidth'
    | 'windowHeight'
  >
>

export interface MiniPlayerBootstrap {
  state: MiniPlayerStateSnapshot
  settings: MiniPlayerSettings
  motionPreference: MotionPreference
}

const DEFAULT_MINI_PLAYER_VISIBILITY: MiniPlayerVisibilitySettings = {
  artwork: true,
  album: true,
  equalizer: true,
  time: true,
  volume: true,
  playMode: true,
  queuePosition: false
}

export const DEFAULT_MINI_PLAYER_THEME_PROFILES: Readonly<Record<string, MiniPlayerThemeProfile>> =
  Object.freeze({
    [DEFAULT_MINI_PLAYER_STYLE_ID]: {
      background: {
        kind: 'cover',
        solidColor: '#11121d',
        fallbackColor: '#11121d',
        gradientStart: '#20182f',
        gradientEnd: '#0a0c18',
        gradientAngle: 138,
        imageUrl: '',
        imageFit: 'cover',
        blur: 32,
        brightness: 100,
        saturation: 145,
        opacity: 36,
        overlayColor: '#070812',
        overlayOpacity: 42
      },
      appearance: {
        accentMode: 'track',
        accentColor: '#7c4dff',
        textMode: 'auto',
        primaryTextColor: '#ffffff',
        mutedTextColor: '#b8b7c2',
        fontFamily: "'Inter', 'MiSans', 'Microsoft YaHei UI', system-ui, sans-serif",
        surfaceOpacity: 75,
        glassBlur: 30,
        cornerRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.10)',
        shadowStrength: 80,
        shadowColor: '#000000'
      },
      layout: { preference: 'auto' },
      visibility: { ...DEFAULT_MINI_PLAYER_VISIBILITY }
    },
    [PORCELAIN_MINI_PLAYER_STYLE_ID]: {
      background: {
        kind: 'cover',
        solidColor: '#f4f5fb',
        fallbackColor: '#f4f5fb',
        gradientStart: '#ffffff',
        gradientEnd: '#f1f3fc',
        gradientAngle: 145,
        imageUrl: '',
        imageFit: 'cover',
        blur: 32,
        brightness: 108,
        saturation: 110,
        opacity: 18,
        overlayColor: '#f5f7ff',
        overlayOpacity: 58
      },
      appearance: {
        accentMode: 'custom',
        accentColor: '#5966d9',
        textMode: 'auto',
        primaryTextColor: '#1b2034',
        mutedTextColor: '#656a7b',
        fontFamily: "'Inter', 'MiSans', 'Microsoft YaHei UI', system-ui, sans-serif",
        surfaceOpacity: 90,
        glassBlur: 20,
        cornerRadius: 20,
        borderWidth: 1,
        borderColor: '#d7d9e5',
        shadowStrength: 35,
        shadowColor: '#1b2034'
      },
      layout: { preference: 'auto' },
      visibility: { ...DEFAULT_MINI_PLAYER_VISIBILITY }
    }
  })

const BUILT_IN_MINI_PLAYER_STYLE_IDS = new Set(Object.keys(DEFAULT_MINI_PLAYER_THEME_PROFILES))

export function cloneMiniPlayerThemeProfile(
  profile: MiniPlayerThemeProfile
): MiniPlayerThemeProfile {
  return {
    background: { ...profile.background },
    appearance: { ...profile.appearance },
    layout: { ...profile.layout },
    visibility: { ...profile.visibility }
  }
}

export function createDefaultMiniPlayerThemeProfile(styleId: string): MiniPlayerThemeProfile {
  const profile =
    DEFAULT_MINI_PLAYER_THEME_PROFILES[styleId] ??
    DEFAULT_MINI_PLAYER_THEME_PROFILES[DEFAULT_MINI_PLAYER_STYLE_ID]
  return cloneMiniPlayerThemeProfile(profile)
}

export const DEFAULT_MINI_PLAYER_SETTINGS: Readonly<MiniPlayerSettings> = Object.freeze({
  windowX: -1,
  windowY: -1,
  windowWidth: 480,
  windowHeight: 300,
  alwaysOnTop: false,
  showInTaskbar: true,
  positionLocked: false,
  activeStyleId: DEFAULT_MINI_PLAYER_STYLE_ID,
  profiles: {
    [DEFAULT_MINI_PLAYER_STYLE_ID]: createDefaultMiniPlayerThemeProfile(
      DEFAULT_MINI_PLAYER_STYLE_ID
    ),
    [PORCELAIN_MINI_PLAYER_STYLE_ID]: createDefaultMiniPlayerThemeProfile(
      PORCELAIN_MINI_PLAYER_STYLE_ID
    )
  }
})

export function cloneMiniPlayerSettings(settings: MiniPlayerSettings): MiniPlayerSettings {
  return {
    ...settings,
    profiles: Object.fromEntries(
      Object.entries(settings.profiles).map(([id, profile]) => [
        id,
        cloneMiniPlayerThemeProfile(profile)
      ])
    )
  }
}

export const EMPTY_MINI_PLAYER_STATE: Readonly<MiniPlayerStateSnapshot> = Object.freeze({
  track: null,
  currentLyric: null,
  lyrics: [],
  isPlaying: false,
  isLoading: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  volume: 0.7,
  playMode: 'sequential',
  favoriteAvailable: false,
  favoriteLiked: false,
  favoriteLoading: false,
  dominantColor: '#7c4dff',
  queueIndex: -1,
  queueLength: 0
})

const MAX_TRACK_TEXT_LENGTH = 512
const MAX_MINI_PLAYER_LYRIC_LINES = 500
const MAX_COVER_URL_LENGTH = 16_384
// Legacy embedded library covers are full data: URLs and routinely exceed the
// generic URL cap; a sliced data: URL is corrupt, so they get their own bound.
const MAX_COVER_DATA_URL_LENGTH = 4_194_304
const MAX_STYLE_ID_LENGTH = 64
const MAX_BACKGROUND_IMAGE_URL_LENGTH = 512
const MAX_THEME_PROFILE_COUNT = 32
const MAX_PLAYBACK_SECONDS = 60 * 60 * 24 * 7
const MAX_QUEUE_LENGTH = 100_000
const MAX_SAMPLE_RATE_HZ = 768_000

export function normalizeMiniPlayerSettings(raw: unknown): MiniPlayerSettings {
  const value = asRecord(raw)
  const rawProfiles = asRecord(value.profiles)
  const profiles: Record<string, MiniPlayerThemeProfile> = {}

  for (const styleId of BUILT_IN_MINI_PLAYER_STYLE_IDS) {
    const fallback = createDefaultMiniPlayerThemeProfile(styleId)
    profiles[styleId] = normalizeMiniPlayerThemeProfile(rawProfiles[styleId], fallback)
  }

  let customProfileCount = 0
  for (const [rawStyleId, rawProfile] of Object.entries(rawProfiles)) {
    const styleId = normalizeOptionalStyleId(rawStyleId)
    if (!styleId || BUILT_IN_MINI_PLAYER_STYLE_IDS.has(styleId)) continue
    if (customProfileCount >= MAX_THEME_PROFILE_COUNT) break
    profiles[styleId] = normalizeMiniPlayerThemeProfile(
      rawProfile,
      createDefaultMiniPlayerThemeProfile(DEFAULT_MINI_PLAYER_STYLE_ID)
    )
    customProfileCount += 1
  }

  const hasProfiles = Object.prototype.hasOwnProperty.call(value, 'profiles')
  const legacyStyleId = normalizeOptionalStyleId(value.styleId) ?? DEFAULT_MINI_PLAYER_STYLE_ID
  const legacyBackgroundColor = normalizeOptionalHexColor(value.backgroundColor)
  if (!hasProfiles && (value.styleId !== undefined || legacyBackgroundColor)) {
    const existing =
      profiles[legacyStyleId] ?? createDefaultMiniPlayerThemeProfile(DEFAULT_MINI_PLAYER_STYLE_ID)
    profiles[legacyStyleId] = {
      ...existing,
      background: {
        ...existing.background,
        ...(legacyBackgroundColor
          ? { solidColor: legacyBackgroundColor, fallbackColor: legacyBackgroundColor }
          : {})
      }
    }
  }

  const requestedStyleId =
    normalizeOptionalStyleId(value.activeStyleId) ??
    normalizeOptionalStyleId(value.styleId) ??
    DEFAULT_MINI_PLAYER_STYLE_ID
  const activeStyleId = BUILT_IN_MINI_PLAYER_STYLE_IDS.has(requestedStyleId)
    ? requestedStyleId
    : DEFAULT_MINI_PLAYER_STYLE_ID

  return {
    windowX: normalizeCoordinate(value.windowX, DEFAULT_MINI_PLAYER_SETTINGS.windowX),
    windowY: normalizeCoordinate(value.windowY, DEFAULT_MINI_PLAYER_SETTINGS.windowY),
    windowWidth: clampFiniteNumber(
      value.windowWidth,
      MINI_PLAYER_MIN_WIDTH,
      MINI_PLAYER_MAX_WIDTH,
      DEFAULT_MINI_PLAYER_SETTINGS.windowWidth,
      true
    ),
    windowHeight: clampFiniteNumber(
      value.windowHeight,
      MINI_PLAYER_MIN_HEIGHT,
      MINI_PLAYER_MAX_HEIGHT,
      DEFAULT_MINI_PLAYER_SETTINGS.windowHeight,
      true
    ),
    alwaysOnTop: value.alwaysOnTop === true,
    showInTaskbar: value.showInTaskbar !== false,
    positionLocked: value.positionLocked === true,
    activeStyleId,
    profiles
  }
}

export function normalizeMiniPlayerThemeProfile(
  raw: unknown,
  fallback: MiniPlayerThemeProfile
): MiniPlayerThemeProfile {
  const value = asRecord(raw)
  const backgroundValue = asRecord(value.background)
  const appearanceValue = asRecord(value.appearance)
  const layoutValue = asRecord(value.layout)
  const visibilityValue = asRecord(value.visibility)
  const imageUrl = normalizeBackgroundImageUrl(backgroundValue.imageUrl)
  const requestedBackgroundKind = normalizeBackgroundKind(
    backgroundValue.kind,
    fallback.background.kind
  )

  return {
    background: {
      kind: requestedBackgroundKind === 'image' && !imageUrl ? 'solid' : requestedBackgroundKind,
      solidColor: normalizeHexColor(backgroundValue.solidColor, fallback.background.solidColor),
      fallbackColor: normalizeHexColor(
        backgroundValue.fallbackColor,
        fallback.background.fallbackColor
      ),
      gradientStart: normalizeHexColor(
        backgroundValue.gradientStart,
        fallback.background.gradientStart
      ),
      gradientEnd: normalizeHexColor(backgroundValue.gradientEnd, fallback.background.gradientEnd),
      gradientAngle: clampFiniteNumber(
        backgroundValue.gradientAngle,
        0,
        360,
        fallback.background.gradientAngle,
        true
      ),
      imageUrl,
      imageFit:
        backgroundValue.imageFit === 'contain'
          ? 'contain'
          : backgroundValue.imageFit === 'cover'
            ? 'cover'
            : fallback.background.imageFit,
      blur: clampFiniteNumber(backgroundValue.blur, 0, 40, fallback.background.blur, true),
      brightness: clampFiniteNumber(
        backgroundValue.brightness,
        50,
        150,
        fallback.background.brightness,
        true
      ),
      saturation: clampFiniteNumber(
        backgroundValue.saturation,
        0,
        200,
        fallback.background.saturation,
        true
      ),
      opacity: clampFiniteNumber(
        backgroundValue.opacity,
        0,
        100,
        fallback.background.opacity,
        true
      ),
      overlayColor: normalizeHexColor(
        backgroundValue.overlayColor,
        fallback.background.overlayColor
      ),
      overlayOpacity: clampFiniteNumber(
        backgroundValue.overlayOpacity,
        0,
        90,
        fallback.background.overlayOpacity,
        true
      )
    },
    appearance: {
      accentMode:
        appearanceValue.accentMode === 'custom' || appearanceValue.accentMode === 'track'
          ? appearanceValue.accentMode
          : fallback.appearance.accentMode,
      accentColor: normalizeHexColor(appearanceValue.accentColor, fallback.appearance.accentColor),
      textMode:
        appearanceValue.textMode === 'custom' || appearanceValue.textMode === 'auto'
          ? appearanceValue.textMode
          : fallback.appearance.textMode,
      primaryTextColor: normalizeHexColor(
        appearanceValue.primaryTextColor,
        fallback.appearance.primaryTextColor
      ),
      mutedTextColor: normalizeHexColor(
        appearanceValue.mutedTextColor,
        fallback.appearance.mutedTextColor
      ),
      fontFamily: normalizeFontFamily(appearanceValue.fontFamily, fallback.appearance.fontFamily),
      surfaceOpacity: clampFiniteNumber(
        appearanceValue.surfaceOpacity,
        40,
        100,
        fallback.appearance.surfaceOpacity,
        true
      ),
      glassBlur: clampFiniteNumber(
        appearanceValue.glassBlur,
        0,
        40,
        fallback.appearance.glassBlur,
        true
      ),
      cornerRadius: clampFiniteNumber(
        appearanceValue.cornerRadius,
        0,
        36,
        fallback.appearance.cornerRadius,
        true
      ),
      borderWidth: clampFiniteNumber(
        appearanceValue.borderWidth,
        0,
        3,
        fallback.appearance.borderWidth,
        true
      ),
      borderColor: normalizeHexColor(appearanceValue.borderColor, fallback.appearance.borderColor),
      shadowStrength: clampFiniteNumber(
        appearanceValue.shadowStrength,
        0,
        100,
        fallback.appearance.shadowStrength,
        true
      ),
      shadowColor: normalizeHexColor(appearanceValue.shadowColor, fallback.appearance.shadowColor)
    },
    layout: {
      preference: normalizeLayoutPreference(layoutValue.preference, fallback.layout.preference)
    },
    visibility: {
      artwork: normalizeBoolean(visibilityValue.artwork, fallback.visibility.artwork),
      album: normalizeBoolean(visibilityValue.album, fallback.visibility.album),
      equalizer: normalizeBoolean(visibilityValue.equalizer, fallback.visibility.equalizer),
      time: normalizeBoolean(visibilityValue.time, fallback.visibility.time),
      volume: normalizeBoolean(visibilityValue.volume, fallback.visibility.volume),
      playMode: normalizeBoolean(visibilityValue.playMode, fallback.visibility.playMode),
      queuePosition: normalizeBoolean(
        visibilityValue.queuePosition,
        fallback.visibility.queuePosition
      )
    }
  }
}

export function normalizeMiniPlayerStateSnapshot(raw: unknown): MiniPlayerStateSnapshot {
  const value = asRecord(raw)
  const duration = clampFiniteNumber(value.duration, 0, MAX_PLAYBACK_SECONDS, 0)
  const currentTime = clampFiniteNumber(
    value.currentTime,
    0,
    duration > 0 ? duration : MAX_PLAYBACK_SECONDS,
    0
  )
  const queueLength = clampFiniteNumber(value.queueLength, 0, MAX_QUEUE_LENGTH, 0, true)

  return {
    track: normalizeTrack(value.track),
    currentLyric: normalizeMiniPlayerLyric(value.currentLyric),
    lyrics: normalizeMiniPlayerLyrics(value.lyrics),
    isPlaying: value.isPlaying === true,
    isLoading: value.isLoading === true,
    currentTime,
    duration,
    playbackRate: clampFiniteNumber(value.playbackRate, 0.25, 4, 1),
    volume: clampFiniteNumber(value.volume, 0, 1, EMPTY_MINI_PLAYER_STATE.volume),
    playMode: normalizeMiniPlayerPlayMode(value.playMode) ?? 'sequential',
    favoriteAvailable: value.favoriteAvailable === true,
    favoriteLiked: value.favoriteLiked === true,
    favoriteLoading: value.favoriteLoading === true,
    dominantColor: normalizeDominantColor(value.dominantColor),
    queueIndex: clampFiniteNumber(value.queueIndex, -1, Math.max(-1, queueLength - 1), -1, true),
    queueLength
  }
}

function normalizeMiniPlayerLyric(
  raw: unknown
): { original: string; translation: string | null } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const original = normalizeText(value.original, MAX_TRACK_TEXT_LENGTH)
  if (!original) return null
  const translation = normalizeText(value.translation, MAX_TRACK_TEXT_LENGTH)
  return { original, translation: translation || null }
}

function normalizeMiniPlayerLyrics(raw: unknown): MiniPlayerLyricLineSnapshot[] {
  if (!Array.isArray(raw)) return []
  const lines: MiniPlayerLyricLineSnapshot[] = []
  for (const entry of raw) {
    if (lines.length >= MAX_MINI_PLAYER_LYRIC_LINES) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const value = entry as Record<string, unknown>
    const original = normalizeText(value.original, MAX_TRACK_TEXT_LENGTH)
    if (!original) continue
    const time =
      typeof value.time === 'number' && Number.isFinite(value.time)
        ? Math.max(0, Math.min(MAX_PLAYBACK_SECONDS, value.time))
        : null
    const translation = normalizeText(value.translation, MAX_TRACK_TEXT_LENGTH)
    lines.push({ time, original, translation: translation || null })
  }
  return lines
}

export function normalizeMiniPlayerCommand(raw: unknown): MiniPlayerCommand | null {
  const value = asRecord(raw)
  switch (value.type) {
    case 'toggle-play':
    case 'play':
    case 'pause':
    case 'previous':
    case 'next':
    case 'cycle-play-mode':
    case 'toggle-favorite':
      return { type: value.type }
    case 'set-play-mode': {
      const playMode = normalizeMiniPlayerPlayMode(value.value, null)
      return playMode ? { type: 'set-play-mode', value: playMode } : null
    }
    case 'seek':
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return null
      return {
        type: 'seek',
        value: Math.min(MAX_PLAYBACK_SECONDS, Math.max(0, value.value))
      }
    case 'set-volume':
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return null
      return { type: 'set-volume', value: Math.min(1, Math.max(0, value.value)) }
    default:
      return null
  }
}

function normalizeTrack(raw: unknown): MiniPlayerTrackSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const id = normalizeText(value.id, MAX_TRACK_TEXT_LENGTH)
  const title = normalizeText(value.title, MAX_TRACK_TEXT_LENGTH)
  if (!id && !title) return null

  const cover = normalizeCoverHandle(value.cover)
  const coverSource = normalizeText(value.coverSource, MAX_COVER_URL_LENGTH)
  const format = normalizeText(value.format, MAX_TRACK_TEXT_LENGTH)
  const sampleRate =
    typeof value.sampleRate === 'number' && Number.isFinite(value.sampleRate)
      ? Math.min(MAX_SAMPLE_RATE_HZ, Math.max(1, Math.round(value.sampleRate)))
      : null
  const bitDepth =
    typeof value.bitDepth === 'number' && Number.isFinite(value.bitDepth)
      ? Math.min(64, Math.max(1, Math.round(value.bitDepth)))
      : null
  return {
    id: id || title,
    title: title || '未知曲目',
    artist: normalizeText(value.artist, MAX_TRACK_TEXT_LENGTH) || '未知艺术家',
    album: normalizeText(value.album, MAX_TRACK_TEXT_LENGTH),
    albumArtist: normalizeText(value.albumArtist, MAX_TRACK_TEXT_LENGTH),
    trackNumber: clampFiniteNumber(value.trackNumber, 0, 99_999, 0, true),
    cover: cover || null,
    format: format || null,
    sampleRate,
    bitDepth,
    coverSource: /^https?:\/\//i.test(coverSource) ? coverSource : null
  }
}

function normalizeCoverHandle(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (/^data:/i.test(trimmed)) {
    // Truncating a data: URL corrupts the image — drop instead of slicing.
    return trimmed.length <= MAX_COVER_DATA_URL_LENGTH ? trimmed : ''
  }
  return trimmed.length <= MAX_COVER_URL_LENGTH ? trimmed : ''
}

function normalizeOptionalStyleId(value: unknown): string | null {
  const styleId = normalizeText(value, MAX_STYLE_ID_LENGTH)
  return /^[a-z0-9][a-z0-9._-]*$/i.test(styleId) ? styleId : null
}

function normalizeBackgroundKind(
  value: unknown,
  fallback: MiniPlayerBackgroundKind
): MiniPlayerBackgroundKind {
  return value === 'solid' || value === 'gradient' || value === 'cover' || value === 'image'
    ? value
    : fallback
}

function normalizeBackgroundImageUrl(value: unknown): string {
  const url = normalizeText(value, MAX_BACKGROUND_IMAGE_URL_LENGTH)
  return /^background:\/\/[a-f0-9]{24}\.(?:jpg|png|webp)$/i.test(url) ? url : ''
}

function normalizeLayoutPreference(
  value: unknown,
  fallback: MiniPlayerLayoutPreference
): MiniPlayerLayoutPreference {
  return value === 'compact' || value === 'standard' || value === 'wide' || value === 'auto'
    ? value
    : fallback
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeMiniPlayerPlayMode(
  value: unknown,
  fallback: MiniPlayerPlayMode | null = 'sequential'
): MiniPlayerPlayMode | null {
  return value === 'sequential' ||
    value === 'listLoop' ||
    value === 'repeat' ||
    value === 'shuffle' ||
    value === 'heart'
    ? value
    : fallback
}

function normalizeDominantColor(value: unknown): string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value.trim())
    ? value.trim()
    : EMPTY_MINI_PLAYER_STATE.dominantColor
}

function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value.trim()) ? value.trim() : fallback
}

function normalizeOptionalHexColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value.trim()) ? value.trim() : null
}

function normalizeFontFamily(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().slice(0, 240)
  return normalized && !/[;{}]|url\s*\(|@import|expression\s*\(/i.test(normalized)
    ? normalized
    : fallback
}

function normalizeCoordinate(value: unknown, fallback: number): number {
  return clampFiniteNumber(value, -100_000, 100_000, fallback, true)
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function clampFiniteNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  integer = false
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const normalized = integer ? Math.round(value) : value
  return Math.min(max, Math.max(min, normalized))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
