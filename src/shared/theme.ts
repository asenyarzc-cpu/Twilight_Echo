import type { VersionedDataEnvelope } from './versionedPersistence.ts'
import {
  normalizeThemeShellLayout,
  THEME_SHELL_MANAGED_DATA_ATTRIBUTES,
  type ThemeShellLayout
} from './themeLayout.ts'

import type { ThemeTone } from './themeData.ts'
import {
  BUILT_IN_THEME_PRESET_IDS,
  DEFAULT_THEME_MODES,
  getBuiltInThemePreset,
  isBuiltInThemePresetId,
  THEME_DOCUMENT_SCHEMA_VERSION,
  THEME_MODE_DEFINITIONS,
  THEME_PROFILE_SCHEMA_VERSION,
  THEME_TOKEN_DEFINITIONS,
  THEME_VISIBILITY_SLOT_IDS,
  TWILIGHT_DEFAULT_THEME,
  TWILIGHT_DEFAULT_THEME_ID
} from './themeCatalog.ts'

export {
  findInvalidThemeShellLayoutFields,
  themeShellLayoutToCssVariables,
  themeShellLayoutToDataAttributes,
  THEME_SHELL_MANAGED_DATA_ATTRIBUTES,
  THEME_SHELL_SLOT_IDS,
  THEME_SHELL_TRACK_IDS,
  type ThemeShellGrid,
  type ThemeShellGridArea,
  type ThemeShellLayout,
  type ThemeShellNavigationMode,
  type ThemeShellSlotId,
  type ThemeShellTrackId
} from './themeLayout.ts'

export {
  BUILT_IN_THEME_PRESETS,
  BUILT_IN_THEME_PRESET_IDS,
  DEFAULT_THEME_MODES,
  getBuiltInThemePreset,
  isBuiltInThemePresetId,
  THEME_DOCUMENT_SCHEMA_VERSION,
  THEME_MODE_DEFINITIONS,
  THEME_PROFILE_SCHEMA_VERSION,
  THEME_TOKEN_DEFINITIONS,
  THEME_VISIBILITY_SLOT_IDS,
  TWILIGHT_DEFAULT_THEME,
  TWILIGHT_DEFAULT_THEME_ID
} from './themeCatalog.ts'

export const STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION = 2
export const STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION = 3
export const THEME_ARCHIVE_SCHEMA_VERSION = 2
export const THEME_LIBRARY_SCHEMA_VERSION = 1
export const MAX_USER_THEME_PROFILES = 32
export const MAX_THEME_PROFILE_HISTORY_ENTRIES = 8
export const MAX_THEME_PROFILE_HISTORY_BYTES = 256 * 1024

export type BuiltInThemePresetId = (typeof BUILT_IN_THEME_PRESET_IDS)[number]
export type ThemeTokenKind =
  | 'color'
  | 'length'
  | 'number'
  | 'font'
  | 'shadow'
  | 'filter'
  | 'gradient'
  | 'easing'
  | 'enum'
  | 'raw'

export type ThemeTokenGroup =
  | 'colors'
  | 'typography'
  | 'materials'
  | 'shape'
  | 'layout'
  | 'motion'
  | 'playback'

export interface ThemeTokenDefinition {
  id: string
  cssVariable: `--te-${string}`
  label: string
  group: ThemeTokenGroup
  surface: string
  kind: ThemeTokenKind
  defaults: Record<ThemeTone, string>
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: string[]
  adaptive?: 'cover-accent'
}

export interface ThemeVariant {
  tokens: Record<string, string>
}

export interface ThemeMiniPlayerDefaults {
  surfaceColor?: string
  accentColor?: string
  primaryTextColor?: string
  mutedTextColor?: string
  fontFamily?: string
  surfaceOpacity?: number
  glassBlur?: number
  cornerRadius?: number
  borderWidth?: number
  borderColor?: string
  shadowStrength?: number
  shadowColor?: string
}

export interface ThemeDesktopLyricsDefaults {
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  color?: string
  highlightColor?: string
  backgroundColor?: string
  backgroundOpacity?: number
  shadow?: boolean
  shadowBlur?: number
  shadowColor?: string
}

export interface ThemeWindowDefaults {
  miniPlayer?: ThemeMiniPlayerDefaults
  desktopLyrics?: ThemeDesktopLyricsDefaults
}

export type ThemeAssetType = 'image' | 'font'

export interface ThemeAssetReference {
  id: string
  path: string
  type: ThemeAssetType
}

export interface ThemeAssetBindings {
  appBackground?: string
  localBackground?: string
  settingsBackground?: string
  streamingBackground?: string
  playerBackground?: string
  sansFont?: string
  displayFont?: string
  roundedFont?: string
}

export interface ThemeDocumentV1 {
  schemaVersion: 1
  id: string
  name: string
  description: string
  variants: Record<ThemeTone, ThemeVariant>
  windowDefaults?: ThemeWindowDefaults
}

export interface ThemeProfileV1 {
  schemaVersion: 1
  id: string
  name: string
  description: string
  baseThemeId: string
  createdAt: string
  updatedAt: string
  overrides: Record<ThemeTone, Record<string, string>>
  windowDefaults?: ThemeWindowDefaults
  assets?: ThemeAssetReference[]
  assetBindings?: ThemeAssetBindings
}

export type ThemeAppearanceAccentSource = 'fixed' | 'cover'
export type ThemeBackgroundTreatment = 'solid' | 'gradient' | 'cover-blur' | 'image'
export type ThemeToneScheduling = 'manual' | 'system' | 'timed'
export type ThemeContrastGuard = 'off' | 'warn' | 'enforce'
export type ThemeNavigationStyle = 'expanded' | 'compact' | 'rail'
export type ThemeIconScale = 'sm' | 'md' | 'lg'
export type ThemeNavigationLogo = 'show' | 'hide'
export type ThemeLibraryDensity = 'comfortable' | 'compact'
export type ThemeLibrarySelection = 'fill' | 'stroke'
export type ThemeLibraryTitleOverlay = 'off' | 'on'
export type ThemePlayerLayout = 'standard' | 'full-cover' | 'lyrics-focus' | 'split' | 'minimal'
export type ThemePlayerControls = 'standard' | 'pro'
export type ThemePlayerTitleAlign = 'left' | 'center'
export type ThemePlayerProgressStyle = 'line' | 'ring' | 'solid' | 'spectrum'
export type ThemeArtworkTransition = 'fade' | 'slide' | 'none'
export type ThemeArtworkShadow = 'on' | 'off'
export type ThemeEqualizerPanelStyle = 'neutral' | 'tinted' | 'glass'
export type ThemeEqualizerSliderStyle = 'ring' | 'solid'
export type ThemeEqualizerKnobIndicator = 'line' | 'dot'
export type ThemeEqualizerSpectrumStyle = 'bars' | 'line' | 'area'
export type ThemeEqualizerButtonStyle = 'soft' | 'outline' | 'solid'
export type ThemeIconFamily = 'outline' | 'rounded' | 'filled'
export type ThemeTitleCase = 'preserve' | 'uppercase'
export type ThemeLyricAccent = 'off' | 'accent'
export type ThemeTitleColorStyle = 'off' | 'track' | 'artist-album'
export type ThemeEffectsMode = 'full' | 'reduced'

export interface ThemeToneSchedule {
  lightStartMinutes: number
  darkStartMinutes: number
}

export type ThemeVisibilitySlotId =
  | 'playerAlbumArtist'
  | 'playerArtwork'
  | 'playerTrackMenu'
  | 'playerMiscIcons'
  | 'playerDuration'
  | 'playerWaveform'
  | 'playerTrackInfo'
  | 'equalizerGrid'
  | 'equalizerFrequencyGuides'
  | 'equalizerSpectrum'
  | 'previousButton'
  | 'nextButton'
  | 'miniPlayerArtwork'

export interface ThemeModes {
  appearance?: {
    accentSource?: ThemeAppearanceAccentSource
    backgroundTreatment?: ThemeBackgroundTreatment
    toneScheduling?: ThemeToneScheduling
    contrastGuard?: ThemeContrastGuard
    effectsMode?: ThemeEffectsMode
  }
  navigation?: {
    style?: ThemeNavigationStyle
    iconScale?: ThemeIconScale
    logo?: ThemeNavigationLogo
  }
  library?: {
    density?: ThemeLibraryDensity
    selection?: ThemeLibrarySelection
    titleOverlay?: ThemeLibraryTitleOverlay
  }
  player?: {
    layout?: ThemePlayerLayout
    controls?: ThemePlayerControls
    titleAlign?: ThemePlayerTitleAlign
    progress?: ThemePlayerProgressStyle
  }
  artwork?: {
    transition?: ThemeArtworkTransition
    shadow?: ThemeArtworkShadow
  }
  equalizer?: {
    panel?: ThemeEqualizerPanelStyle
    slider?: ThemeEqualizerSliderStyle
    knob?: ThemeEqualizerKnobIndicator
    spectrum?: ThemeEqualizerSpectrumStyle
    button?: ThemeEqualizerButtonStyle
  }
  icons?: {
    family?: ThemeIconFamily
  }
  typography?: {
    titleCase?: ThemeTitleCase
    lyricAccent?: ThemeLyricAccent
    titleColor?: ThemeTitleColorStyle
  }
  visibility?: Partial<Record<ThemeVisibilitySlotId, boolean>>
}

export interface ThemeProfileV2 extends Omit<ThemeProfileV1, 'schemaVersion'> {
  schemaVersion: 2
  modes: ThemeModes
  toneSchedule?: ThemeToneSchedule
  source?: ThemeProfileSource
}

export interface ThemeProfileSource {
  kind: 'builtin-preset'
  presetId: BuiltInThemePresetId
}

export type ThemeIconDomain = 'navigation' | 'library'

export interface ThemeIconSlotDefinition {
  domain: ThemeIconDomain
  classes: Readonly<Record<ThemeIconFamily, string>>
}

function themeIconSlot(domain: ThemeIconDomain, glyph: string): ThemeIconSlotDefinition {
  return Object.freeze({
    domain,
    classes: Object.freeze({
      outline: `ph ph-${glyph}`,
      rounded: `ph-bold ph-${glyph}`,
      filled: `ph-fill ph-${glyph}`
    })
  })
}

export const THEME_ICON_SLOT_REGISTRY = Object.freeze({
  'navigation.home': themeIconSlot('navigation', 'house'),
  'navigation.songs': themeIconSlot('navigation', 'music-notes-simple'),
  'navigation.artists': themeIconSlot('navigation', 'microphone-stage'),
  'navigation.albums': themeIconSlot('navigation', 'disc'),
  'navigation.genres': themeIconSlot('navigation', 'tag'),
  'navigation.playlists': themeIconSlot('navigation', 'playlist'),
  'navigation.folders': themeIconSlot('navigation', 'folder-open'),
  'navigation.recent': themeIconSlot('navigation', 'clock-counter-clockwise'),
  'navigation.streaming': themeIconSlot('navigation', 'globe'),
  'navigation.radio': themeIconSlot('navigation', 'radio'),
  'navigation.import': themeIconSlot('navigation', 'plus'),
  'navigation.plugin': themeIconSlot('navigation', 'puzzle-piece'),
  'library.search': themeIconSlot('library', 'magnifying-glass'),
  'library.clear': themeIconSlot('library', 'x'),
  'library.artist': themeIconSlot('library', 'microphone-stage'),
  'library.album': themeIconSlot('library', 'disc'),
  'library.genre': themeIconSlot('library', 'tag'),
  'library.playlist': themeIconSlot('library', 'playlist'),
  'library.folder': themeIconSlot('library', 'folder-open'),
  'library.add': themeIconSlot('library', 'plus'),
  'library.play': themeIconSlot('library', 'play'),
  'library.empty': themeIconSlot('library', 'waveform'),
  'library.selected': themeIconSlot('library', 'check'),
  'library.playing': themeIconSlot('library', 'speaker-high'),
  'library.filter': themeIconSlot('library', 'funnel')
})

export type ThemeIconSlot = keyof typeof THEME_ICON_SLOT_REGISTRY

export function resolveThemeIconClasses(slot: ThemeIconSlot, family: ThemeIconFamily): string {
  return THEME_ICON_SLOT_REGISTRY[slot].classes[family]
}

export type ThemeProfile = ThemeProfileV1 | ThemeProfileV2

export interface ThemeModeDefinition {
  id: string
  dataAttribute: `data-te-${string}`
  label: string
  options: readonly string[]
  defaultValue: string
}

export type ThemeSelection =
  | { kind: 'builtin'; id: BuiltInThemePresetId }
  | { kind: 'user'; id: string }
  | { kind: 'plugin'; pluginId: string; themeId: string }

export interface ThemeWindowInheritance {
  miniPlayer: boolean
  desktopLyrics: boolean
}

export interface ThemeLibraryDocument {
  schemaVersion: 1
  activeTheme: ThemeSelection
  profiles: ThemeProfileV2[]
  windowInheritance: ThemeWindowInheritance
  profileHistory: Record<string, ThemeProfileHistoryEntry[]>
}

export interface ThemeProfileHistoryEntry {
  savedAt: string
  profile: ThemeProfileV2
}

export type ThemeLibrarySnapshot = VersionedDataEnvelope<ThemeLibraryDocument>

export interface ThemeBootstrap {
  library: ThemeLibrarySnapshot
  defaultTheme: ThemeDocumentV1
}

export interface ThemeArchiveDocumentV1 {
  schemaVersion: 1
  profile: ThemeProfileV1
  assets: ThemeAssetReference[]
}

export interface ThemeArchiveDocumentV2 {
  schemaVersion: 2
  profile: ThemeProfileV2
  assets: ThemeAssetReference[]
}

export type ThemeArchiveDocument = ThemeArchiveDocumentV1 | ThemeArchiveDocumentV2

export interface StructuredPluginThemeV1 {
  schemaVersion: 1
  variants: Partial<Record<ThemeTone, { tokens?: Record<string, string> }>>
  windowDefaults?: ThemeWindowDefaults
}

export interface StructuredPluginThemeV2 {
  schemaVersion: 2
  variants: Partial<Record<ThemeTone, { tokens?: Record<string, string> }>>
  modes?: ThemeModes
  windowDefaults?: ThemeWindowDefaults
}

export interface StructuredPluginThemeV3 extends Omit<StructuredPluginThemeV2, 'schemaVersion'> {
  schemaVersion: 3
  layout?: ThemeShellLayout
}

export type StructuredPluginTheme =
  | StructuredPluginThemeV1
  | StructuredPluginThemeV2
  | StructuredPluginThemeV3

export const DEFAULT_THEME_TONE_SCHEDULE: Readonly<ThemeToneSchedule> = Object.freeze({
  lightStartMinutes: 7 * 60,
  darkStartMinutes: 19 * 60
})

export {
  BUILT_IN_THEME_FONTS,
  THEME_ACCENT_PALETTES,
  THEME_BACKGROUND_PALETTES
} from './themeData.ts'
export type { ThemeTone, ThemePaletteEntry, BuiltInThemeFont } from './themeData.ts'
const tokenDefinitionById = new Map(
  THEME_TOKEN_DEFINITIONS.map((definition) => [definition.id, definition])
)
export function createDefaultThemeLibraryDocument(
  activeTheme: ThemeSelection = { kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID },
  windowInheritance: ThemeWindowInheritance = { miniPlayer: true, desktopLyrics: true }
): ThemeLibraryDocument {
  return {
    schemaVersion: THEME_LIBRARY_SCHEMA_VERSION,
    activeTheme,
    profiles: [],
    windowInheritance,
    profileHistory: {}
  }
}

export function isThemeLibraryDocument(value: unknown): value is ThemeLibraryDocument {
  if (!isRecord(value) || value.schemaVersion !== THEME_LIBRARY_SCHEMA_VERSION) return false
  if (!Array.isArray(value.profiles) || !isRecord(value.windowInheritance)) return false
  if (value.profileHistory !== undefined && !isRecord(value.profileHistory)) return false
  return isThemeSelection(value.activeTheme)
}

export function normalizeThemeLibraryDocument(value: unknown): ThemeLibraryDocument {
  const fallback = createDefaultThemeLibraryDocument()
  if (!isRecord(value)) return fallback
  const profiles = Array.isArray(value.profiles)
    ? value.profiles
        .map((profile) => normalizeThemeProfile(profile))
        .filter((profile): profile is ThemeProfileV2 => profile !== null)
        .slice(0, MAX_USER_THEME_PROFILES)
    : []
  const selection = isThemeSelection(value.activeTheme) ? value.activeTheme : fallback.activeTheme
  const activeTheme =
    selection.kind !== 'user' || profiles.some((profile) => profile.id === selection.id)
      ? selection
      : fallback.activeTheme
  const inheritance = isRecord(value.windowInheritance) ? value.windowInheritance : {}
  const profileHistory = normalizeThemeProfileHistory(value.profileHistory, profiles)
  return {
    schemaVersion: THEME_LIBRARY_SCHEMA_VERSION,
    activeTheme,
    profiles,
    windowInheritance: {
      miniPlayer: inheritance.miniPlayer !== false,
      desktopLyrics: inheritance.desktopLyrics !== false
    },
    profileHistory
  }
}

export function normalizeThemeProfile(value: unknown): ThemeProfileV2 | null {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== THEME_DOCUMENT_SCHEMA_VERSION &&
      value.schemaVersion !== THEME_PROFILE_SCHEMA_VERSION)
  ) {
    return null
  }
  const id = normalizeThemeId(value.id)
  const name = normalizeText(value.name, 80)
  if (!id || !name || isBuiltInThemePresetId(id)) return null
  const createdAt = normalizeIsoDate(value.createdAt)
  const updatedAt = normalizeIsoDate(value.updatedAt)
  const overrides = isRecord(value.overrides) ? value.overrides : {}
  const assets = normalizeThemeAssets(value.assets)
  const source =
    value.schemaVersion === THEME_PROFILE_SCHEMA_VERSION
      ? normalizeThemeProfileSource(value.source)
      : undefined
  const toneSchedule =
    value.schemaVersion === THEME_PROFILE_SCHEMA_VERSION
      ? normalizeThemeToneSchedule(value.toneSchedule)
      : undefined
  return {
    schemaVersion: THEME_PROFILE_SCHEMA_VERSION,
    id,
    name,
    description: normalizeText(value.description, 240),
    baseThemeId: source
      ? source.presetId
      : typeof value.baseThemeId === 'string' && value.baseThemeId.trim()
        ? value.baseThemeId.trim().slice(0, 160)
        : TWILIGHT_DEFAULT_THEME_ID,
    createdAt,
    updatedAt,
    overrides: {
      pureWhite: normalizeThemeTokenOverrides(
        isRecord(overrides.pureWhite) ? overrides.pureWhite : {}
      ),
      dark: normalizeThemeTokenOverrides(isRecord(overrides.dark) ? overrides.dark : {})
    },
    modes:
      value.schemaVersion === THEME_PROFILE_SCHEMA_VERSION ? normalizeThemeModes(value.modes) : {},
    ...(toneSchedule ? { toneSchedule } : {}),
    ...(source ? { source } : {}),
    windowDefaults: normalizeWindowDefaults(value.windowDefaults),
    ...(assets.length > 0 ? { assets } : {}),
    ...normalizeThemeAssetBindings(value.assetBindings, assets)
  }
}

function normalizeThemeProfileSource(value: unknown): ThemeProfileSource | undefined {
  if (!isRecord(value) || value.kind !== 'builtin-preset') return undefined
  return isBuiltInThemePresetId(value.presetId)
    ? { kind: 'builtin-preset', presetId: value.presetId }
    : undefined
}

function normalizeThemeProfileHistory(
  value: unknown,
  profiles: ThemeProfileV2[]
): Record<string, ThemeProfileHistoryEntry[]> {
  if (!isRecord(value)) return {}
  const profileIds = new Set(profiles.map((profile) => profile.id))
  const result: Record<string, ThemeProfileHistoryEntry[]> = {}
  for (const [profileId, rawEntries] of Object.entries(value)) {
    if (!profileIds.has(profileId) || !Array.isArray(rawEntries)) continue
    const entries = rawEntries.flatMap((rawEntry) => {
      if (!isRecord(rawEntry)) return []
      const profile = normalizeThemeProfile(rawEntry.profile)
      if (!profile || profile.id !== profileId) return []
      return [{ savedAt: normalizeIsoDate(rawEntry.savedAt), profile }]
    })
    const limited = limitThemeProfileHistory(entries)
    if (limited.length > 0) result[profileId] = limited
  }
  return result
}

export function limitThemeProfileHistory(
  entries: readonly ThemeProfileHistoryEntry[]
): ThemeProfileHistoryEntry[] {
  const result: ThemeProfileHistoryEntry[] = []
  let byteLength = 2
  for (const entry of entries.slice(0, MAX_THEME_PROFILE_HISTORY_ENTRIES)) {
    const serialized = JSON.stringify(entry)
    const entryBytes = new TextEncoder().encode(serialized).byteLength + (result.length > 0 ? 1 : 0)
    if (byteLength + entryBytes > MAX_THEME_PROFILE_HISTORY_BYTES) break
    result.push(entry)
    byteLength += entryBytes
  }
  return result
}

export function themeProfilesHaveSameEditableState(
  first: ThemeProfileV2,
  second: ThemeProfileV2
): boolean {
  return (
    JSON.stringify(themeProfileEditableState(first)) ===
    JSON.stringify(themeProfileEditableState(second))
  )
}

function themeProfileEditableState(profile: ThemeProfileV2): object {
  return {
    name: profile.name,
    description: profile.description,
    baseThemeId: profile.baseThemeId,
    overrides: profile.overrides,
    modes: profile.modes,
    toneSchedule: profile.toneSchedule,
    source: profile.source,
    windowDefaults: profile.windowDefaults,
    assets: profile.assets,
    assetBindings: profile.assetBindings
  }
}

export function normalizeThemeModes(value: unknown): ThemeModes {
  if (!isRecord(value)) return {}
  const result: ThemeModes = {}
  if (isRecord(value.appearance)) {
    const appearance: NonNullable<ThemeModes['appearance']> = {}
    assignModeOption(appearance, 'accentSource', value.appearance.accentSource, ['fixed', 'cover'])
    assignModeOption(appearance, 'backgroundTreatment', value.appearance.backgroundTreatment, [
      'solid',
      'gradient',
      'cover-blur',
      'image'
    ])
    assignModeOption(appearance, 'toneScheduling', value.appearance.toneScheduling, [
      'manual',
      'system',
      'timed'
    ])
    assignModeOption(appearance, 'contrastGuard', value.appearance.contrastGuard, [
      'off',
      'warn',
      'enforce'
    ])
    assignModeOption(appearance, 'effectsMode', value.appearance.effectsMode, ['full', 'reduced'])
    if (Object.keys(appearance).length > 0) result.appearance = appearance
  }
  if (isRecord(value.navigation)) {
    const navigation: NonNullable<ThemeModes['navigation']> = {}
    assignModeOption(navigation, 'style', value.navigation.style, ['expanded', 'compact', 'rail'])
    assignModeOption(navigation, 'iconScale', value.navigation.iconScale, ['sm', 'md', 'lg'])
    assignModeOption(navigation, 'logo', value.navigation.logo, ['show', 'hide'])
    if (Object.keys(navigation).length > 0) result.navigation = navigation
  }
  if (isRecord(value.library)) {
    const library: NonNullable<ThemeModes['library']> = {}
    assignModeOption(library, 'density', value.library.density, ['comfortable', 'compact'])
    assignModeOption(library, 'selection', value.library.selection, ['fill', 'stroke'])
    assignModeOption(library, 'titleOverlay', value.library.titleOverlay, ['off', 'on'])
    if (Object.keys(library).length > 0) result.library = library
  }
  if (isRecord(value.player)) {
    const player: NonNullable<ThemeModes['player']> = {}
    assignModeOption(player, 'layout', value.player.layout, [
      'standard',
      'full-cover',
      'lyrics-focus',
      'split',
      'minimal'
    ])
    assignModeOption(player, 'controls', value.player.controls, ['standard', 'pro'])
    assignModeOption(player, 'titleAlign', value.player.titleAlign, ['left', 'center'])
    assignModeOption(player, 'progress', value.player.progress, [
      'line',
      'ring',
      'solid',
      'spectrum'
    ])
    if (Object.keys(player).length > 0) result.player = player
  }
  if (isRecord(value.artwork)) {
    const artwork: NonNullable<ThemeModes['artwork']> = {}
    assignModeOption(artwork, 'transition', value.artwork.transition, ['fade', 'slide', 'none'])
    assignModeOption(artwork, 'shadow', value.artwork.shadow, ['on', 'off'])
    if (Object.keys(artwork).length > 0) result.artwork = artwork
  }
  if (isRecord(value.equalizer)) {
    const equalizer: NonNullable<ThemeModes['equalizer']> = {}
    assignModeOption(equalizer, 'panel', value.equalizer.panel, ['neutral', 'tinted', 'glass'])
    assignModeOption(equalizer, 'slider', value.equalizer.slider, ['ring', 'solid'])
    assignModeOption(equalizer, 'knob', value.equalizer.knob, ['line', 'dot'])
    assignModeOption(equalizer, 'spectrum', value.equalizer.spectrum, ['bars', 'line', 'area'])
    assignModeOption(equalizer, 'button', value.equalizer.button, ['soft', 'outline', 'solid'])
    if (Object.keys(equalizer).length > 0) result.equalizer = equalizer
  }
  if (isRecord(value.icons)) {
    const icons: NonNullable<ThemeModes['icons']> = {}
    assignModeOption(icons, 'family', value.icons.family, ['outline', 'rounded', 'filled'])
    if (Object.keys(icons).length > 0) result.icons = icons
  }
  if (isRecord(value.typography)) {
    const typography: NonNullable<ThemeModes['typography']> = {}
    assignModeOption(typography, 'titleCase', value.typography.titleCase, ['preserve', 'uppercase'])
    assignModeOption(typography, 'lyricAccent', value.typography.lyricAccent, ['off', 'accent'])
    assignModeOption(typography, 'titleColor', value.typography.titleColor, [
      'off',
      'track',
      'artist-album'
    ])
    if (Object.keys(typography).length > 0) result.typography = typography
  }
  if (isRecord(value.visibility)) {
    const visibility: Partial<Record<ThemeVisibilitySlotId, boolean>> = {}
    for (const id of THEME_VISIBILITY_SLOT_IDS) {
      if (typeof value.visibility[id] === 'boolean') visibility[id] = value.visibility[id]
    }
    if (Object.keys(visibility).length > 0) result.visibility = visibility
  }
  return result
}

export function findUnsupportedThemeModeIds(value: unknown): string[] {
  if (!isRecord(value)) return []
  const definitions = new Map(
    THEME_MODE_DEFINITIONS.map((definition) => [definition.id, definition])
  )
  const supportedDomains = new Set(
    THEME_MODE_DEFINITIONS.map((definition) => definition.id.split('.')[0])
  )
  const unsupported = new Set<string>()
  for (const [domain, section] of Object.entries(value)) {
    if (domain === 'visibility') {
      if (!isRecord(section)) {
        unsupported.add(domain)
        continue
      }
      for (const [id, visible] of Object.entries(section)) {
        if (
          !THEME_VISIBILITY_SLOT_IDS.includes(id as ThemeVisibilitySlotId) ||
          typeof visible !== 'boolean'
        ) {
          unsupported.add(`${domain}.${id}`)
        }
      }
      continue
    }
    if (!supportedDomains.has(domain) || !isRecord(section)) {
      unsupported.add(domain)
      continue
    }
    for (const [key, modeValue] of Object.entries(section)) {
      const id = `${domain}.${key}`
      const definition = definitions.get(id)
      if (!definition || typeof modeValue !== 'string' || !definition.options.includes(modeValue)) {
        unsupported.add(id)
      }
    }
  }
  return [...unsupported].slice(0, 64)
}

function assignModeOption<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  options: readonly T[K][]
): void {
  if (options.includes(value as T[K])) target[key] = value as T[K]
}

export function normalizeThemeToneSchedule(value: unknown): ThemeToneSchedule | undefined {
  if (!isRecord(value)) return undefined
  const lightStartMinutes = value.lightStartMinutes
  const darkStartMinutes = value.darkStartMinutes
  if (
    !Number.isInteger(lightStartMinutes) ||
    !Number.isInteger(darkStartMinutes) ||
    (lightStartMinutes as number) < 0 ||
    (lightStartMinutes as number) >= 24 * 60 ||
    (darkStartMinutes as number) < 0 ||
    (darkStartMinutes as number) >= 24 * 60 ||
    lightStartMinutes === darkStartMinutes
  ) {
    return undefined
  }
  return {
    lightStartMinutes: lightStartMinutes as number,
    darkStartMinutes: darkStartMinutes as number
  }
}

export function resolveScheduledThemeTone(
  date: Date,
  schedule: ThemeToneSchedule = DEFAULT_THEME_TONE_SCHEDULE
): ThemeTone {
  const normalized = normalizeThemeToneSchedule(schedule) ?? DEFAULT_THEME_TONE_SCHEDULE
  const minutes = date.getHours() * 60 + date.getMinutes()
  const { lightStartMinutes, darkStartMinutes } = normalized
  const isLight =
    lightStartMinutes < darkStartMinutes
      ? minutes >= lightStartMinutes && minutes < darkStartMinutes
      : minutes >= lightStartMinutes || minutes < darkStartMinutes
  return isLight ? 'pureWhite' : 'dark'
}

export function normalizeThemeAssets(value: unknown): ThemeAssetReference[] {
  if (!Array.isArray(value)) return []
  const assets: ThemeAssetReference[] = []
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const candidate of value.slice(0, 64)) {
    if (!isRecord(candidate)) continue
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const path = typeof candidate.path === 'string' ? candidate.path.trim().replace(/\\/g, '/') : ''
    const type = candidate.type
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    const pathSegments = path.split('/')
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ||
      !path ||
      path.length > 240 ||
      path.startsWith('/') ||
      /^[a-zA-Z]:/.test(path) ||
      pathSegments.some((segment) => !segment || segment === '..') ||
      (type !== 'image' && type !== 'font') ||
      (type === 'font'
        ? extension !== '.woff2'
        : !['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) ||
      ids.has(id) ||
      paths.has(path)
    ) {
      continue
    }
    ids.add(id)
    paths.add(path)
    assets.push({ id, path, type })
  }
  return assets
}

function normalizeThemeAssetBindings(
  value: unknown,
  assets: ThemeAssetReference[]
): { assetBindings?: ThemeAssetBindings } {
  if (!isRecord(value)) return {}
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const result: ThemeAssetBindings = {}
  const imageKeys = [
    'appBackground',
    'localBackground',
    'settingsBackground',
    'streamingBackground',
    'playerBackground'
  ] as const
  const fontKeys = ['sansFont', 'displayFont', 'roundedFont'] as const
  for (const key of imageKeys) {
    const id = typeof value[key] === 'string' ? value[key].trim() : ''
    if (byId.get(id)?.type === 'image') result[key] = id
  }
  for (const key of fontKeys) {
    const id = typeof value[key] === 'string' ? value[key].trim() : ''
    if (byId.get(id)?.type === 'font') result[key] = id
  }
  return Object.keys(result).length > 0 ? { assetBindings: result } : {}
}

export function normalizeThemeTokenOverrides(
  value: Record<string, unknown>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!tokenDefinitionById.has(id) || typeof raw !== 'string') continue
    const normalized = normalizeThemeTokenValue(id, raw)
    if (normalized != null) result[id] = normalized
  }
  return result
}

export function normalizeStructuredPluginTheme(value: unknown): StructuredPluginTheme | undefined {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== THEME_DOCUMENT_SCHEMA_VERSION &&
      value.schemaVersion !== STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION &&
      value.schemaVersion !== STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION)
  ) {
    return undefined
  }
  const schemaVersion = value.schemaVersion
  const sourceVariants = isRecord(value.variants) ? value.variants : {}
  const variants: StructuredPluginTheme['variants'] = {}
  for (const tone of ['pureWhite', 'dark'] as const) {
    const source = isRecord(sourceVariants[tone]) ? sourceVariants[tone] : {}
    const tokens = normalizeThemeTokenOverrides(isRecord(source.tokens) ? source.tokens : {})
    if (Object.keys(tokens).length > 0) variants[tone] = { tokens }
  }
  const windowDefaults = normalizeWindowDefaults(value.windowDefaults)
  const modes =
    schemaVersion === STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION ||
    schemaVersion === STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION
      ? normalizeThemeModes(value.modes)
      : undefined
  const hasDeclaredModes =
    (schemaVersion === STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION ||
      schemaVersion === STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION) &&
    isRecord(value.modes)
  const layout =
    schemaVersion === STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION
      ? normalizeThemeShellLayout(value.layout)
      : undefined
  const hasDeclaredLayout =
    schemaVersion === STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION && value.layout !== undefined
  if (
    Object.keys(variants).length === 0 &&
    !windowDefaults &&
    !hasDeclaredModes &&
    (!hasDeclaredLayout || !layout)
  ) {
    return undefined
  }
  if (schemaVersion === THEME_DOCUMENT_SCHEMA_VERSION) {
    return {
      schemaVersion: THEME_DOCUMENT_SCHEMA_VERSION,
      variants,
      ...(windowDefaults ? { windowDefaults } : {})
    }
  }
  if (schemaVersion === STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION) {
    return {
      schemaVersion: STRUCTURED_PLUGIN_THEME_MODE_SCHEMA_VERSION,
      variants,
      ...(modes && Object.keys(modes).length > 0 ? { modes } : {}),
      ...(windowDefaults ? { windowDefaults } : {})
    }
  }
  return {
    schemaVersion: STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION,
    variants,
    ...(modes && Object.keys(modes).length > 0 ? { modes } : {}),
    ...(layout ? { layout } : {}),
    ...(windowDefaults ? { windowDefaults } : {})
  }
}

export function normalizeThemeTokenValue(id: string, value: string): string | null {
  const definition = tokenDefinitionById.get(id)
  if (!definition) return null
  const normalized = value.trim()
  if (!normalized || normalized.length > 240) return null
  if (/[;{}]|url\s*\(|@import|expression\s*\(/i.test(normalized)) return null
  if (definition.kind === 'color' && !isThemeColor(normalized)) return null
  if (definition.kind === 'enum' && !definition.options?.includes(normalized)) return null
  if (definition.kind === 'number') {
    const numberText = definition.unit
      ? normalized.endsWith(definition.unit)
        ? normalized.slice(0, -definition.unit.length)
        : ''
      : normalized
    const number = Number(numberText)
    if (!Number.isFinite(number)) return null
    if (definition.min != null && number < definition.min) return null
    if (definition.max != null && number > definition.max) return null
  }
  if (definition.kind === 'length' && definition.unit) {
    const match = normalized.match(/^(-?\d+(?:\.\d+)?)([a-z%]+)$/i)
    if (!match || match[2] !== definition.unit) return null
    const number = Number(match[1])
    if (definition.min != null && number < definition.min) return null
    if (definition.max != null && number > definition.max) return null
  }
  return normalized
}

function isThemeColor(value: string): boolean {
  return (
    /^#[0-9a-f]{3,4}(?:[0-9a-f]{3,4})?$/i.test(value) ||
    /^(?:rgb|rgba|hsl|hsla)\([^()]{1,80}\)$/i.test(value) ||
    /^(?:transparent|currentcolor)$/i.test(value)
  )
}

interface ThemeRgbColor {
  r: number
  g: number
  b: number
  a: number
}

export function themeContrastRatio(
  foreground: string,
  background: string,
  canvas = '#ffffff'
): number | null {
  const canvasColor = parseThemeRgb(canvas)
  const foregroundColor = parseThemeRgb(foreground)
  const backgroundColor = parseThemeRgb(background)
  if (!canvasColor || !foregroundColor || !backgroundColor) return null
  const opaqueBackground = compositeThemeColor(backgroundColor, canvasColor)
  const opaqueForeground = compositeThemeColor(foregroundColor, opaqueBackground)
  const light = Math.max(
    themeRelativeLuminance(opaqueForeground),
    themeRelativeLuminance(opaqueBackground)
  )
  const dark = Math.min(
    themeRelativeLuminance(opaqueForeground),
    themeRelativeLuminance(opaqueBackground)
  )
  return (light + 0.05) / (dark + 0.05)
}

export function ensureThemeTextContrast(
  foreground: string,
  background: string,
  minimum = 4.5
): string {
  const ratio = themeContrastRatio(foreground, background)
  if (ratio != null && ratio >= minimum) return foreground
  const dark = '#111827'
  const light = '#f8fafc'
  const darkRatio = themeContrastRatio(dark, background) ?? 0
  const lightRatio = themeContrastRatio(light, background) ?? 0
  return darkRatio >= lightRatio ? dark : light
}

export function createThemeAccentTokenOverrides(
  color: string,
  tone: ThemeTone,
  background: string,
  adaptive = false
): Record<string, string> {
  const fallback = tone === 'dark' ? '#f59e0b' : '#2563eb'
  const source = parseThemeRgb(color)
  const normalized = source
  const muted =
    adaptive && normalized
      ? mixThemeColors(normalized, { r: 128, g: 128, b: 128, a: 1 }, 0.1)
      : (normalized ?? parseThemeRgb(fallback)!)
  let primary = themeRgbToHex(muted)
  if (
    adaptive &&
    (themeContrastRatio(primary, background, tone === 'dark' ? '#17181a' : '#f4f4f7') ?? 0) < 3
  ) {
    primary = fallback
  }
  const base = parseThemeRgb(primary)!
  const white = { r: 255, g: 255, b: 255, a: 1 }
  const primary400 = themeRgbToHex(mixThemeColors(base, white, tone === 'dark' ? 0.18 : 0.12))
  const primary300 = themeRgbToHex(mixThemeColors(base, white, tone === 'dark' ? 0.44 : 0.38))
  const rgb = `${base.r}, ${base.g}, ${base.b}`
  return {
    'color.primary.500': primary,
    'color.primary.400': primary400,
    'color.primary.300': primary300,
    'color.primary.rgb': rgb,
    'material.glowMain': `rgba(${rgb}, ${tone === 'dark' ? '0.2' : '0.14'})`,
    'surface.active': `rgba(${rgb}, ${tone === 'dark' ? '0.16' : '0.1'})`,
    'navigation.activeText': primary,
    'navigation.indicator': primary,
    'playback.accent': primary
  }
}

function parseThemeRgb(value: string): ThemeRgbColor | null {
  const normalized = value.trim()
  const hex = normalized.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)
  if (hex) {
    const raw =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((part) => part + part)
            .join('')
        : hex[1]
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
      a: raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1
    }
  }
  const rgb = normalized.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d?(?:\.\d+)?))?\s*\)$/i
  )
  if (!rgb) return null
  const channels = rgb.slice(1, 4).map(Number)
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    return null
  }
  const alpha = rgb[4] == null || rgb[4] === '' ? 1 : Number(rgb[4])
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null
  return { r: channels[0], g: channels[1], b: channels[2], a: alpha }
}

function compositeThemeColor(foreground: ThemeRgbColor, background: ThemeRgbColor): ThemeRgbColor {
  const alpha = foreground.a + background.a * (1 - foreground.a)
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: Math.round(
      (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha
    ),
    g: Math.round(
      (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha
    ),
    b: Math.round(
      (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha
    ),
    a: alpha
  }
}

function mixThemeColors(from: ThemeRgbColor, to: ThemeRgbColor, amount: number): ThemeRgbColor {
  const ratio = Math.max(0, Math.min(1, amount))
  return {
    r: Math.round(from.r + (to.r - from.r) * ratio),
    g: Math.round(from.g + (to.g - from.g) * ratio),
    b: Math.round(from.b + (to.b - from.b) * ratio),
    a: from.a + (to.a - from.a) * ratio
  }
}

function themeRgbToHex(color: ThemeRgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`
}

function themeRelativeLuminance(color: ThemeRgbColor): number {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function resolveThemeProfileTokens(
  profile: ThemeProfileV2 | null,
  tone: ThemeTone
): Record<string, string> {
  if (!profile) return {}
  const basePreset = resolveThemeProfileBasePreset(profile)
  return {
    ...TWILIGHT_DEFAULT_THEME.variants[tone].tokens,
    ...(basePreset?.overrides[tone] ?? {}),
    ...profile.overrides[tone]
  }
}

export function resolveThemeProfileModes(profile: ThemeProfileV2 | null): ThemeModes {
  const baseModes = resolveThemeProfileBasePreset(profile)?.modes ?? {}
  const modes = profile?.modes ?? {}
  return resolveThemeModes(modes, baseModes)
}

export function resolveThemeModes(value: unknown, baseValue: unknown = {}): ThemeModes {
  const baseModes = normalizeThemeModes(baseValue)
  const modes = normalizeThemeModes(value)
  return {
    appearance: {
      ...DEFAULT_THEME_MODES.appearance,
      ...baseModes.appearance,
      ...modes.appearance
    },
    navigation: {
      ...DEFAULT_THEME_MODES.navigation,
      ...baseModes.navigation,
      ...modes.navigation
    },
    library: { ...DEFAULT_THEME_MODES.library, ...baseModes.library, ...modes.library },
    player: { ...DEFAULT_THEME_MODES.player, ...baseModes.player, ...modes.player },
    artwork: { ...DEFAULT_THEME_MODES.artwork, ...baseModes.artwork, ...modes.artwork },
    equalizer: {
      ...DEFAULT_THEME_MODES.equalizer,
      ...baseModes.equalizer,
      ...modes.equalizer
    },
    icons: { ...DEFAULT_THEME_MODES.icons, ...baseModes.icons, ...modes.icons },
    typography: {
      ...DEFAULT_THEME_MODES.typography,
      ...baseModes.typography,
      ...modes.typography
    },
    visibility: { ...baseModes.visibility, ...modes.visibility }
  }
}

export function resolveThemeProfileWindowDefaults(
  profile: ThemeProfileV2 | null
): ThemeWindowDefaults {
  const base = resolveThemeProfileBasePreset(profile)?.windowDefaults
  return {
    miniPlayer: { ...base?.miniPlayer, ...profile?.windowDefaults?.miniPlayer },
    desktopLyrics: { ...base?.desktopLyrics, ...profile?.windowDefaults?.desktopLyrics }
  }
}

function resolveThemeProfileBasePreset(profile: ThemeProfileV2 | null): ThemeProfileV2 | null {
  if (
    !profile ||
    profile.baseThemeId === profile.id ||
    profile.baseThemeId === TWILIGHT_DEFAULT_THEME_ID
  ) {
    return null
  }
  return getBuiltInThemePreset(profile.baseThemeId)
}

export function themeModesToDataAttributes(value: unknown): Record<`data-te-${string}`, string> {
  const modes = normalizeThemeModes(value)
  const attributes: Record<`data-te-${string}`, string> = {}
  for (const definition of THEME_MODE_DEFINITIONS) {
    const modeValue = readThemeModeValue(modes, definition.id)
    if (typeof modeValue === 'string' && definition.options.includes(modeValue)) {
      attributes[definition.dataAttribute] = modeValue
    }
  }
  for (const id of THEME_VISIBILITY_SLOT_IDS) {
    const visible = modes.visibility?.[id]
    if (typeof visible === 'boolean') attributes[visibilityDataAttribute(id)] = String(visible)
  }
  return attributes
}

function readThemeModeValue(modes: ThemeModes, id: string): string | undefined {
  const [domain, key] = id.split('.')
  const section = modes[domain as keyof ThemeModes]
  return isRecord(section) && typeof section[key] === 'string' ? section[key] : undefined
}

function visibilityDataAttribute(id: ThemeVisibilitySlotId): `data-te-${string}` {
  return `data-te-visible-${id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}

export const THEME_MANAGED_DATA_ATTRIBUTES: readonly `data-te-${string}`[] = Object.freeze([
  ...THEME_MODE_DEFINITIONS.map((definition) => definition.dataAttribute),
  ...THEME_VISIBILITY_SLOT_IDS.map(visibilityDataAttribute),
  ...THEME_SHELL_MANAGED_DATA_ATTRIBUTES,
  'data-te-liquid-glass-coverage'
])

export function themeTokensToCssVariables(tokens: Record<string, string>): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [id, value] of Object.entries(tokens)) {
    const definition = tokenDefinitionById.get(id)
    if (definition) variables[definition.cssVariable] = value
  }
  const primary500 = variables['--te-primary-500']
  if (primary500) {
    const primary400 = variables['--te-primary-400'] ?? primary500
    const primary300 = variables['--te-primary-300'] ?? primary500
    variables['--te-accent'] = primary500
    variables['--brand-50'] = primary300
    variables['--brand-100'] = primary300
    variables['--brand-200'] = primary300
    variables['--brand-300'] = primary300
    variables['--brand-400'] = primary400
    variables['--brand-500'] = primary500
    variables['--brand-600'] = primary500
    variables['--brand-700'] = primary500
  }
  const active = variables['--te-active-bg']
  if (active) variables['--te-accent-soft'] = active
  return variables
}

export function getThemeTokenDefinition(id: string): ThemeTokenDefinition | null {
  return tokenDefinitionById.get(id) ?? null
}

export function isThemeSelection(value: unknown): value is ThemeSelection {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'builtin') return isBuiltInThemePresetId(value.id)
  if (value.kind === 'user') return Boolean(normalizeThemeId(value.id))
  return (
    value.kind === 'plugin' &&
    typeof value.pluginId === 'string' &&
    value.pluginId.trim().length > 0 &&
    typeof value.themeId === 'string' &&
    value.themeId.trim().length > 0
  )
}

export function normalizeThemeSelection(
  value: unknown,
  legacyPluginThemeId: unknown = null
): ThemeSelection {
  if (isThemeSelection(value)) {
    if (value.kind === 'plugin') {
      return {
        kind: 'plugin',
        pluginId: value.pluginId.trim().slice(0, 128),
        themeId: value.themeId.trim().slice(0, 128)
      }
    }
    if (value.kind === 'user') return { kind: 'user', id: normalizeThemeId(value.id) }
    return { kind: 'builtin', id: value.id }
  }
  if (typeof legacyPluginThemeId === 'string') {
    const separator = legacyPluginThemeId.indexOf(':')
    if (separator > 0 && separator < legacyPluginThemeId.length - 1) {
      return {
        kind: 'plugin',
        pluginId: legacyPluginThemeId.slice(0, separator).trim().slice(0, 128),
        themeId: legacyPluginThemeId
          .slice(separator + 1)
          .trim()
          .slice(0, 128)
      }
    }
  }
  return { kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID }
}

export function normalizeThemeWindowInheritance(
  value: unknown,
  fallback: ThemeWindowInheritance = { miniPlayer: true, desktopLyrics: true }
): ThemeWindowInheritance {
  const record = isRecord(value) ? value : {}
  return {
    miniPlayer: typeof record.miniPlayer === 'boolean' ? record.miniPlayer : fallback.miniPlayer,
    desktopLyrics:
      typeof record.desktopLyrics === 'boolean' ? record.desktopLyrics : fallback.desktopLyrics
  }
}

function normalizeWindowDefaults(value: unknown): ThemeWindowDefaults | undefined {
  if (!isRecord(value)) return undefined
  const result: ThemeWindowDefaults = {}
  if (isRecord(value.miniPlayer)) {
    result.miniPlayer = {
      accentColor: normalizeOptionalColor(value.miniPlayer.accentColor),
      primaryTextColor: normalizeOptionalColor(value.miniPlayer.primaryTextColor),
      mutedTextColor: normalizeOptionalColor(value.miniPlayer.mutedTextColor),
      surfaceOpacity: normalizeOptionalNumber(value.miniPlayer.surfaceOpacity, 40, 100),
      glassBlur: normalizeOptionalNumber(value.miniPlayer.glassBlur, 0, 40),
      cornerRadius: normalizeOptionalNumber(value.miniPlayer.cornerRadius, 0, 36),
      borderWidth: normalizeOptionalNumber(value.miniPlayer.borderWidth, 0, 3),
      borderColor: normalizeOptionalColor(value.miniPlayer.borderColor),
      shadowStrength: normalizeOptionalNumber(value.miniPlayer.shadowStrength, 0, 100),
      ...(value.miniPlayer.surfaceColor !== undefined
        ? { surfaceColor: normalizeOptionalColor(value.miniPlayer.surfaceColor) }
        : {}),
      ...(value.miniPlayer.fontFamily !== undefined
        ? { fontFamily: normalizeOptionalText(value.miniPlayer.fontFamily, 240) }
        : {}),
      ...(value.miniPlayer.shadowColor !== undefined
        ? { shadowColor: normalizeOptionalColor(value.miniPlayer.shadowColor) }
        : {})
    }
  }
  if (isRecord(value.desktopLyrics)) {
    result.desktopLyrics = {
      fontFamily: normalizeOptionalText(value.desktopLyrics.fontFamily, 64),
      fontSize: normalizeOptionalNumber(value.desktopLyrics.fontSize, 12, 80),
      fontWeight: normalizeOptionalNumber(value.desktopLyrics.fontWeight, 100, 900),
      color: normalizeOptionalColor(value.desktopLyrics.color),
      highlightColor: normalizeOptionalColor(value.desktopLyrics.highlightColor),
      backgroundColor: normalizeOptionalColor(value.desktopLyrics.backgroundColor),
      backgroundOpacity: normalizeOptionalNumber(value.desktopLyrics.backgroundOpacity, 0, 100),
      shadow:
        typeof value.desktopLyrics.shadow === 'boolean' ? value.desktopLyrics.shadow : undefined,
      shadowBlur: normalizeOptionalNumber(value.desktopLyrics.shadowBlur, 0, 30),
      shadowColor: normalizeOptionalColor(value.desktopLyrics.shadowColor)
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeOptionalColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > 80 ||
    /[;{}]|url\s*\(|@import|expression\s*\(/i.test(normalized)
  ) {
    return undefined
  }
  return normalized
}

function normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function normalizeOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : undefined
}

function normalizeThemeId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(normalized) ? normalized : ''
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function normalizeIsoDate(value: unknown): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value
  return new Date(0).toISOString()
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
