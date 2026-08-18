export type LyricsAppearanceFontFamily =
  | 'inherit'
  | 'system'
  | 'inter'
  | 'lxgw'
  | 'sarasa'
  | 'comic'
  | 'custom'

export type LyricsAppearanceColorMode = 'theme' | 'custom'
export type LyricsAppearanceAlign = 'center' | 'left' | 'right'
export type LyricsFocusLineCount = 'all' | 1 | 3 | 5
export type LyricsBackgroundStyle = 'none' | 'solid' | 'glass' | 'gradient'
export type LyricsHighlightEffect = 'none' | 'shadow' | 'glow' | 'outline'
export type LyricsFontStyle = 'normal' | 'italic'
export type LyricsStyleTarget = 'normal' | 'active' | 'translation' | 'romanization'

export const LYRICS_STYLE_TARGETS: readonly LyricsStyleTarget[] = [
  'normal',
  'active',
  'translation',
  'romanization'
]

export interface LyricsTextStyle {
  fontFamily: LyricsAppearanceFontFamily
  customFontFamily: string
  fontSize: number
  fontWeight: number
  lineHeight: number
  /** em, so it tracks the font size instead of fighting it. */
  letterSpacing: number
  fontStyle: LyricsFontStyle
  align: LyricsAppearanceAlign
  colorMode: LyricsAppearanceColorMode
  color: string
  opacity: number
  backgroundStyle: LyricsBackgroundStyle
  backgroundColor: string
  backgroundOpacity: number
  highlightEffect: LyricsHighlightEffect
  highlightColor: string
  highlightIntensity: number
}

export interface LyricsAppearanceSettings {
  schemaVersion: number
  /** Legacy/global quick controls retained for settings migration and compact controls. */
  fontFamily: LyricsAppearanceFontFamily
  fontSize: number
  fontWeight: number
  lineHeight: number
  align: LyricsAppearanceAlign
  inactiveOpacity: number
  focusLineCount: LyricsFocusLineCount
  colorMode: LyricsAppearanceColorMode
  textColor: string
  activeColor: string
  karaokeColor: string
  karaokeEnabled: boolean
  /** Gap between the cover column and the lyrics column, in px. */
  coverGap: number
  /** Maximum width of the lyric text block, in px. */
  lyricsMaxWidth: number
  /** Horizontal nudge applied to the lyrics column, in px. */
  lyricsOffsetX: number
  /** Cover artwork width, as a percentage of its column. */
  coverSize: number
  coverRadius: number
  /** Fraction of the visible lyric area the active line is anchored to. */
  anchorPosition: number
  /** Extra space between a line and its translation, in px. */
  translationSpacing: number
  /** Hide lines that have already been sung. */
  hidePassedLines: boolean
  /** Strength of the inactive-line shrink, as a percentage of the built-in amount. */
  scaleIntensity: number
  /** Strength of the depth blur, as a percentage of the built-in amount. */
  blurIntensity: number
  /** Cascade pacing. 50 reproduces the built-in rhythm; higher is faster. */
  cascadeSpeed: number
  styles: Record<LyricsStyleTarget, LyricsTextStyle>
}

export const LYRICS_FONT_FAMILIES: readonly LyricsAppearanceFontFamily[] = [
  'inherit',
  'system',
  'inter',
  'lxgw',
  'sarasa',
  'comic',
  'custom'
]

export const LYRICS_FONT_FAMILY_STACKS: Readonly<
  Record<Exclude<LyricsAppearanceFontFamily, 'custom'>, string>
> = {
  inherit: 'inherit',
  system: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  inter: "'Inter', 'MiSans', 'Microsoft YaHei', sans-serif",
  lxgw: "'LXGW WenKai', '霞鹜文楷', 'KaiTi', 'STKaiti', 'MiSans', 'Microsoft YaHei', serif",
  sarasa: "'Sarasa Gothic SC', 'MiSans', 'Microsoft YaHei', sans-serif",
  comic: "'Comic Sans MS', 'MiSans', 'Microsoft YaHei', sans-serif"
}

export function resolveLyricsFontFamily(
  style: Pick<LyricsTextStyle, 'fontFamily' | 'customFontFamily'>
): string {
  if (style.fontFamily === 'custom') {
    const custom = style.customFontFamily.trim()
    return custom ? `${JSON.stringify(custom)}, 'Microsoft YaHei', sans-serif` : 'inherit'
  }
  return LYRICS_FONT_FAMILY_STACKS[style.fontFamily]
}

export interface LyricsRange {
  min: number
  max: number
  step: number
}

/**
 * One table for every numeric bound. The editors read `min`/`max`/`step` straight
 * from here so a slider cannot drift out of step with what normalization accepts —
 * the three editors previously carried three different sets of bounds.
 */
export const LYRICS_RANGES = {
  fontSize: { min: 12, max: 48, step: 1 },
  fontWeight: { min: 300, max: 900, step: 100 },
  lineHeight: { min: 1.1, max: 2.8, step: 0.05 },
  letterSpacing: { min: -0.05, max: 0.4, step: 0.01 },
  opacity: { min: 10, max: 100, step: 5 },
  backgroundOpacity: { min: 0, max: 100, step: 5 },
  highlightIntensity: { min: 0, max: 100, step: 5 },
  inactiveOpacity: { min: 10, max: 100, step: 5 },
  coverGap: { min: 0, max: 160, step: 2 },
  lyricsMaxWidth: { min: 420, max: 1200, step: 10 },
  lyricsOffsetX: { min: -80, max: 160, step: 2 },
  coverSize: { min: 60, max: 110, step: 1 },
  coverRadius: { min: 0, max: 64, step: 1 },
  anchorPosition: { min: 0.15, max: 0.85, step: 0.01 },
  translationSpacing: { min: 0, max: 24, step: 1 },
  scaleIntensity: { min: 0, max: 100, step: 5 },
  blurIntensity: { min: 0, max: 100, step: 5 },
  cascadeSpeed: { min: 0, max: 100, step: 5 }
} as const satisfies Record<string, LyricsRange>

export const LYRICS_APPEARANCE_SCHEMA_VERSION = 3

/**
 * `cascadeSpeed` is a speed, so it maps to a delay multiplier geometrically:
 * 50 lands exactly on 1 (the built-in rhythm), 0 doubles the delay and 100 halves
 * it. A linear map could not hit 1 at the midpoint of an asymmetric range.
 */
export function resolveCascadeSpeedFactor(cascadeSpeed: number): number {
  const value = clampNumber(cascadeSpeed, 0, 100, 50)
  return Math.pow(2, (50 - value) / 50)
}

const BASE_TEXT_STYLE: LyricsTextStyle = {
  fontFamily: 'inherit',
  customFontFamily: '',
  fontSize: 18,
  fontWeight: 600,
  lineHeight: 1.85,
  letterSpacing: 0,
  fontStyle: 'normal',
  align: 'center',
  colorMode: 'theme',
  color: '#ffffff',
  opacity: 100,
  backgroundStyle: 'none',
  backgroundColor: '#0f172a',
  backgroundOpacity: 0,
  highlightEffect: 'none',
  highlightColor: '#ffffff',
  highlightIntensity: 30
}

export const DEFAULT_LYRICS_TEXT_STYLES: Record<LyricsStyleTarget, LyricsTextStyle> = {
  normal: { ...BASE_TEXT_STYLE },
  active: {
    ...BASE_TEXT_STYLE,
    lineHeight: 1.65,
    highlightColor: '#fff8df',
    highlightIntensity: 32
  },
  translation: {
    ...BASE_TEXT_STYLE,
    fontWeight: 500,
    lineHeight: 1.45,
    opacity: 82,
    highlightIntensity: 24
  },
  romanization: {
    ...BASE_TEXT_STYLE,
    fontSize: 15,
    fontWeight: 400,
    lineHeight: 1.35,
    opacity: 70,
    highlightIntensity: 24
  }
}

/**
 * Every default here reproduces what the page rendered before these knobs
 * existed, so upgrading changes nothing on screen. Opinionated looks live in
 * the presets, not in the defaults.
 */
export const DEFAULT_LYRICS_APPEARANCE: LyricsAppearanceSettings = {
  schemaVersion: LYRICS_APPEARANCE_SCHEMA_VERSION,
  fontFamily: 'inherit',
  fontSize: 18,
  fontWeight: 600,
  lineHeight: 1.85,
  align: 'center',
  inactiveOpacity: 100,
  focusLineCount: 'all',
  colorMode: 'theme',
  textColor: '#ffffff',
  activeColor: '#ffffff',
  karaokeColor: '#fff8df',
  karaokeEnabled: true,
  coverGap: 40,
  lyricsMaxWidth: 820,
  lyricsOffsetX: 0,
  coverSize: 100,
  coverRadius: 26,
  anchorPosition: 0.35,
  translationSpacing: 0,
  hidePassedLines: false,
  scaleIntensity: 100,
  blurIntensity: 100,
  cascadeSpeed: 50,
  styles: {
    normal: { ...DEFAULT_LYRICS_TEXT_STYLES.normal },
    active: { ...DEFAULT_LYRICS_TEXT_STYLES.active },
    translation: { ...DEFAULT_LYRICS_TEXT_STYLES.translation },
    romanization: { ...DEFAULT_LYRICS_TEXT_STYLES.romanization }
  }
}

/** The `inactiveOpacity` default before it was ever wired to rendering. */
const LEGACY_INERT_INACTIVE_OPACITY = 40

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function clampRange(value: unknown, range: LyricsRange, fallback: number): number {
  return clampNumber(value, range.min, range.max, fallback)
}

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : fallback
}

function normalizeFontWeight(value: unknown, fallback: number): number {
  const numeric = clampRange(value, LYRICS_RANGES.fontWeight, fallback)
  return Math.round(numeric / 100) * 100
}

function normalizeAlign(value: unknown, fallback: LyricsAppearanceAlign): LyricsAppearanceAlign {
  return value === 'left' || value === 'center' || value === 'right' ? value : fallback
}

function normalizeFontFamily(
  value: unknown,
  fallback: LyricsAppearanceFontFamily
): LyricsAppearanceFontFamily {
  return LYRICS_FONT_FAMILIES.includes(value as LyricsAppearanceFontFamily)
    ? (value as LyricsAppearanceFontFamily)
    : fallback
}

function normalizeTextStyle(
  raw: unknown,
  fallback: LyricsTextStyle,
  migrateLegacyDefaultGlow = false
): LyricsTextStyle {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const backgroundStyles: readonly LyricsBackgroundStyle[] = ['none', 'solid', 'glass', 'gradient']
  const highlightEffects: readonly LyricsHighlightEffect[] = ['none', 'shadow', 'glow', 'outline']
  const isLegacyDefaultGlow =
    migrateLegacyDefaultGlow &&
    value.highlightEffect === 'glow' &&
    value.highlightColor === '#fff8df' &&
    value.highlightIntensity === 32
  return {
    fontFamily: normalizeFontFamily(value.fontFamily, fallback.fontFamily),
    customFontFamily:
      typeof value.customFontFamily === 'string'
        ? value.customFontFamily.trim().slice(0, 96)
        : fallback.customFontFamily,
    fontSize: clampRange(value.fontSize, LYRICS_RANGES.fontSize, fallback.fontSize),
    fontWeight: normalizeFontWeight(value.fontWeight, fallback.fontWeight),
    lineHeight: clampRange(value.lineHeight, LYRICS_RANGES.lineHeight, fallback.lineHeight),
    letterSpacing: clampRange(
      value.letterSpacing,
      LYRICS_RANGES.letterSpacing,
      fallback.letterSpacing
    ),
    fontStyle: value.fontStyle === 'italic' ? 'italic' : 'normal',
    align: normalizeAlign(value.align, fallback.align),
    colorMode: value.colorMode === 'custom' ? 'custom' : 'theme',
    color: normalizeColor(value.color, fallback.color),
    opacity: clampRange(value.opacity, LYRICS_RANGES.opacity, fallback.opacity),
    backgroundStyle: backgroundStyles.includes(value.backgroundStyle as LyricsBackgroundStyle)
      ? (value.backgroundStyle as LyricsBackgroundStyle)
      : fallback.backgroundStyle,
    backgroundColor: normalizeColor(value.backgroundColor, fallback.backgroundColor),
    backgroundOpacity: clampRange(
      value.backgroundOpacity,
      LYRICS_RANGES.backgroundOpacity,
      fallback.backgroundOpacity
    ),
    highlightEffect: isLegacyDefaultGlow
      ? 'none'
      : highlightEffects.includes(value.highlightEffect as LyricsHighlightEffect)
        ? (value.highlightEffect as LyricsHighlightEffect)
        : fallback.highlightEffect,
    highlightColor: normalizeColor(value.highlightColor, fallback.highlightColor),
    highlightIntensity: clampRange(
      value.highlightIntensity,
      LYRICS_RANGES.highlightIntensity,
      fallback.highlightIntensity
    )
  }
}

function migrateLegacyStyles(
  value: Record<string, unknown>
): Record<LyricsStyleTarget, LyricsTextStyle> {
  const fontFamily = normalizeFontFamily(value.fontFamily, DEFAULT_LYRICS_APPEARANCE.fontFamily)
  const fontSize = clampRange(
    value.fontSize,
    LYRICS_RANGES.fontSize,
    DEFAULT_LYRICS_APPEARANCE.fontSize
  )
  const fontWeight = normalizeFontWeight(value.fontWeight, DEFAULT_LYRICS_APPEARANCE.fontWeight)
  const lineHeight = clampRange(
    value.lineHeight,
    LYRICS_RANGES.lineHeight,
    DEFAULT_LYRICS_APPEARANCE.lineHeight
  )
  const align = normalizeAlign(value.align, DEFAULT_LYRICS_APPEARANCE.align)
  const colorMode = value.colorMode === 'custom' ? 'custom' : 'theme'
  const textColor = normalizeColor(value.textColor, DEFAULT_LYRICS_APPEARANCE.textColor)
  const activeColor = normalizeColor(value.activeColor, DEFAULT_LYRICS_APPEARANCE.activeColor)

  return {
    normal: {
      ...DEFAULT_LYRICS_TEXT_STYLES.normal,
      fontFamily,
      fontSize,
      fontWeight,
      lineHeight,
      align,
      colorMode,
      color: textColor
    },
    active: {
      ...DEFAULT_LYRICS_TEXT_STYLES.active,
      fontFamily,
      fontSize,
      fontWeight,
      align,
      colorMode,
      color: activeColor,
      highlightColor: normalizeColor(value.karaokeColor, DEFAULT_LYRICS_APPEARANCE.karaokeColor)
    },
    translation: {
      ...DEFAULT_LYRICS_TEXT_STYLES.translation,
      fontFamily,
      fontSize,
      align,
      colorMode,
      color: textColor
    },
    // Romanization was hardcoded three px below the main text before it became a
    // style layer, so seed it that way rather than at the shared size.
    romanization: {
      ...DEFAULT_LYRICS_TEXT_STYLES.romanization,
      fontFamily,
      fontSize: clampRange(fontSize - 3, LYRICS_RANGES.fontSize, fontSize),
      align,
      colorMode,
      color: textColor
    }
  }
}

export function cloneLyricsAppearance(value: LyricsAppearanceSettings): LyricsAppearanceSettings {
  const styles = {} as Record<LyricsStyleTarget, LyricsTextStyle>
  for (const target of LYRICS_STYLE_TARGETS) {
    styles[target] = { ...(value.styles[target] ?? DEFAULT_LYRICS_TEXT_STYLES[target]) }
  }
  return { ...value, styles }
}

export function normalizeLyricsAppearance(
  raw: unknown,
  legacy: Record<string, unknown> = {}
): LyricsAppearanceSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const storedVersion = typeof value.schemaVersion === 'number' ? value.schemaVersion : 0
  const fontFamily = normalizeFontFamily(value.fontFamily, DEFAULT_LYRICS_APPEARANCE.fontFamily)
  const fontSize = clampRange(
    value.fontSize,
    LYRICS_RANGES.fontSize,
    clampNumber(legacy.lyricFontSize, 14, 28, DEFAULT_LYRICS_APPEARANCE.fontSize)
  )
  const fontWeight = normalizeFontWeight(value.fontWeight, DEFAULT_LYRICS_APPEARANCE.fontWeight)
  const lineHeight = clampRange(
    value.lineHeight,
    LYRICS_RANGES.lineHeight,
    DEFAULT_LYRICS_APPEARANCE.lineHeight
  )
  const align = normalizeAlign(
    value.align,
    legacy.lyricAlign === 'left' ? 'left' : DEFAULT_LYRICS_APPEARANCE.align
  )
  const colorMode = value.colorMode === 'custom' ? 'custom' : 'theme'
  const textColor = normalizeColor(value.textColor, DEFAULT_LYRICS_APPEARANCE.textColor)
  const activeColor = normalizeColor(value.activeColor, DEFAULT_LYRICS_APPEARANCE.activeColor)
  const karaokeColor = normalizeColor(value.karaokeColor, DEFAULT_LYRICS_APPEARANCE.karaokeColor)
  const migratedStyles = migrateLegacyStyles({
    ...value,
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight,
    align,
    colorMode,
    textColor,
    activeColor,
    karaokeColor
  })
  const stylesValue =
    typeof value.styles === 'object' && value.styles !== null
      ? (value.styles as Record<string, unknown>)
      : {}
  // Schema 2 retired the default active-line glow. Gate the rewrite on the
  // version that introduced it, not on "not the current version", or every
  // later bump would run it again and wipe a glow the user chose deliberately.
  const migrateLegacyDefaultGlow = storedVersion < 2
  const styles = {} as Record<LyricsStyleTarget, LyricsTextStyle>
  for (const target of LYRICS_STYLE_TARGETS) {
    styles[target] = normalizeTextStyle(
      stylesValue[target],
      migratedStyles[target],
      migrateLegacyDefaultGlow
    )
  }

  return {
    schemaVersion: LYRICS_APPEARANCE_SCHEMA_VERSION,
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight,
    align,
    inactiveOpacity: normalizeInactiveOpacity(value, legacy, storedVersion),
    focusLineCount:
      value.focusLineCount === 'all' ||
      value.focusLineCount === 1 ||
      value.focusLineCount === 3 ||
      value.focusLineCount === 5
        ? value.focusLineCount
        : DEFAULT_LYRICS_APPEARANCE.focusLineCount,
    colorMode,
    textColor,
    activeColor,
    karaokeColor,
    karaokeEnabled: value.karaokeEnabled !== false,
    coverGap: clampRange(
      value.coverGap,
      LYRICS_RANGES.coverGap,
      DEFAULT_LYRICS_APPEARANCE.coverGap
    ),
    lyricsMaxWidth: clampRange(
      value.lyricsMaxWidth,
      LYRICS_RANGES.lyricsMaxWidth,
      DEFAULT_LYRICS_APPEARANCE.lyricsMaxWidth
    ),
    lyricsOffsetX: clampRange(
      value.lyricsOffsetX,
      LYRICS_RANGES.lyricsOffsetX,
      DEFAULT_LYRICS_APPEARANCE.lyricsOffsetX
    ),
    coverSize: clampRange(
      value.coverSize,
      LYRICS_RANGES.coverSize,
      DEFAULT_LYRICS_APPEARANCE.coverSize
    ),
    coverRadius: clampRange(
      value.coverRadius,
      LYRICS_RANGES.coverRadius,
      DEFAULT_LYRICS_APPEARANCE.coverRadius
    ),
    anchorPosition: clampRange(
      value.anchorPosition,
      LYRICS_RANGES.anchorPosition,
      DEFAULT_LYRICS_APPEARANCE.anchorPosition
    ),
    translationSpacing: clampRange(
      value.translationSpacing,
      LYRICS_RANGES.translationSpacing,
      DEFAULT_LYRICS_APPEARANCE.translationSpacing
    ),
    hidePassedLines: value.hidePassedLines === true,
    scaleIntensity: clampRange(
      value.scaleIntensity,
      LYRICS_RANGES.scaleIntensity,
      DEFAULT_LYRICS_APPEARANCE.scaleIntensity
    ),
    blurIntensity: clampRange(
      value.blurIntensity,
      LYRICS_RANGES.blurIntensity,
      DEFAULT_LYRICS_APPEARANCE.blurIntensity
    ),
    cascadeSpeed: clampRange(
      value.cascadeSpeed,
      LYRICS_RANGES.cascadeSpeed,
      DEFAULT_LYRICS_APPEARANCE.cascadeSpeed
    ),
    styles
  }
}

/**
 * Until schema 3 this value was persisted but never rendered, so every schema-2
 * profile carries the old default of 40 whether or not anyone chose it. Wiring
 * the control up would therefore have dimmed the far lines for every existing
 * user at once; treat that exact untouched default as "off" and keep any other
 * stored value, which was a deliberate choice.
 */
function normalizeInactiveOpacity(
  value: Record<string, unknown>,
  legacy: Record<string, unknown>,
  storedVersion: number
): number {
  if (storedVersion < LYRICS_APPEARANCE_SCHEMA_VERSION) {
    if (value.inactiveOpacity === LEGACY_INERT_INACTIVE_OPACITY) {
      return DEFAULT_LYRICS_APPEARANCE.inactiveOpacity
    }
  }
  return clampRange(
    value.inactiveOpacity,
    LYRICS_RANGES.inactiveOpacity,
    clampRange(
      legacy.lyricDimOpacity,
      LYRICS_RANGES.inactiveOpacity,
      DEFAULT_LYRICS_APPEARANCE.inactiveOpacity
    )
  )
}

export function syncLegacyLyricsAppearance(
  appearance: LyricsAppearanceSettings,
  patch: Partial<
    Pick<
      LyricsAppearanceSettings,
      | 'fontFamily'
      | 'fontSize'
      | 'fontWeight'
      | 'lineHeight'
      | 'align'
      | 'colorMode'
      | 'textColor'
      | 'activeColor'
      | 'karaokeColor'
    >
  >
): LyricsAppearanceSettings {
  const next = cloneLyricsAppearance({ ...appearance, ...patch })
  for (const target of LYRICS_STYLE_TARGETS) {
    if (patch.fontFamily !== undefined) next.styles[target].fontFamily = patch.fontFamily
    if (patch.fontSize !== undefined) next.styles[target].fontSize = patch.fontSize
    if (patch.align !== undefined) next.styles[target].align = patch.align
    if (patch.colorMode !== undefined) next.styles[target].colorMode = patch.colorMode
  }
  if (patch.fontWeight !== undefined) {
    next.styles.normal.fontWeight = patch.fontWeight
    next.styles.active.fontWeight = patch.fontWeight
  }
  if (patch.lineHeight !== undefined) next.styles.normal.lineHeight = patch.lineHeight
  if (patch.textColor !== undefined) {
    next.styles.normal.color = patch.textColor
    next.styles.translation.color = patch.textColor
    next.styles.romanization.color = patch.textColor
  }
  if (patch.activeColor !== undefined) next.styles.active.color = patch.activeColor
  if (patch.karaokeColor !== undefined) next.styles.active.highlightColor = patch.karaokeColor
  return next
}
