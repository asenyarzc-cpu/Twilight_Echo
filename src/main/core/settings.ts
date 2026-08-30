import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { release } from 'node:os'
import { stat, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import { createLegacyDspGraph, normalizeDspScenes } from '../../shared/dspGraph'
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  normalizeLanguagePreference
} from '../../shared/i18n/locale.ts'
import {
  DEFAULT_AUDIO_PROCESSING,
  normalizeAudioOutput,
  normalizeAudioProcessingSettings,
  type ChannelRoutingMode,
  type OutputConfig
} from '../audioEngineManager'
import {
  DEFAULT_HEADPHONE_COMPENSATION,
  normalizeHeadphoneCompensationSettings
} from '../audio/audioProcessingEffective'
import type {
  AppBackgroundKind,
  AppBackgroundPage,
  AppBackgroundPageOverride,
  AppBackgroundSettings,
  AppBackgroundColorPair,
  AppSettings,
  AppTheme,
  AudioEqPreset,
  BackgroundEffectTheme,
  CardAppearanceSettings,
  CardAppearanceTheme,
  CardHoverEffect,
  CardShadowStrength,
  CloseWindowBehavior,
  DesktopLyricsSettings,
  GlobalShortcutSettings,
  WindowTransparencyEffectSettings,
  MusicCachePolicySettings,
  NcmPlaybackQuality,
  NowPlayingBackground,
  PlaybackResumeMode,
  PreviousButtonAction,
  ProxyMode,
  SettingsSnapshot,
  StartupHomePage,
  TrackActivationMode,
  StreamingAudioCachePolicy,
  UiDensity
} from './types'
import type { PlayMode } from '../audioEngineManager'
import {
  DEFAULT_MINI_PLAYER_SETTINGS,
  cloneMiniPlayerSettings,
  normalizeMiniPlayerSettings
} from '../../shared/miniPlayer'
import { DEFAULT_SOFTWARE_VOLUME } from '../../shared/audioProcessingOptions'
import { normalizeThemeSelection, normalizeThemeWindowInheritance } from '../../shared/theme.ts'
import { normalizeMotionPreference } from '../../shared/motion.ts'
import {
  DEFAULT_LIQUID_GLASS,
  normalizeLiquidGlass,
  normalizeSurfaceMaterial
} from '../../shared/liquidGlass.ts'
import {
  DEFAULT_PLAYER_BAR_SETTINGS,
  clonePlayerBarSettings,
  normalizePlayerBarSettings
} from '../../shared/playerBar.ts'
import { DEFAULT_SLEEP_TIMER_SETTINGS, type SleepTimerSettings } from '../../shared/sleepTimer.ts'
import {
  DEFAULT_LYRICS_APPEARANCE,
  cloneLyricsAppearance,
  normalizeLyricsAppearance
} from '../../shared/lyricsAppearance.ts'
import {
  DEFAULT_DESKTOP_LYRICS_SETTINGS,
  normalizeDesktopLyricsSettings
} from '../../shared/desktopLyrics.ts'
import { normalizeAppFontFamily } from '../../shared/appFont.ts'
import {
  DEFAULT_LYRICS_PRESET_CONFIG,
  cloneLyricsPresetConfig,
  normalizeLyricsPresetConfig
} from '../../shared/lyricsPresets.ts'
import { DEFAULT_GENRE_SEPARATORS, normalizeGenreSeparators } from '../../shared/genreSeparators.ts'
import {
  loadSettingsFile,
  writeSettingsFile,
  type SettingsFileLoadIssue
} from '../persistence/settingsFile.ts'

let appSettingsLoadIssue: SettingsFileLoadIssue | null = null

export const DEFAULT_DESKTOP_LYRICS: DesktopLyricsSettings = DEFAULT_DESKTOP_LYRICS_SETTINGS

export const DEFAULT_MUSIC_CACHE_POLICY: MusicCachePolicySettings = {
  cover: true,
  lyrics: true,
  metadata: true,
  streamingAudio: 'provider'
}

export const DEFAULT_GLOBAL_SHORTCUT_BINDINGS: GlobalShortcutSettings = {
  previous: 'CommandOrControl+Alt+Left',
  next: 'CommandOrControl+Alt+Right',
  playPause: 'CommandOrControl+Alt+Space',
  toggleDesktopLyrics: 'CommandOrControl+Alt+D',
  toggleDesktopLyricsLock: 'CommandOrControl+Alt+L'
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoCheckLogin: true,
  autoLaunch: false,
  launchAtLogin: false,
  hardwareAcceleration: true,
  globalShortcuts: false,
  globalShortcutBindings: { ...DEFAULT_GLOBAL_SHORTCUT_BINDINGS },
  minimizeToTray: false,
  musicCachePath: '',
  cachePath: '',
  cachePolicy: DEFAULT_MUSIC_CACHE_POLICY,
  autoAnalyzeBpm: true,
  closeWindowBehavior: 'quit',
  closeToTray: false,
  taskbarThumbarButtonsEnabled: true,
  onboardingCompleted: false,
  developerMode: false,
  startupHomePage: 'local',
  trackActivationMode: 'singleClick',
  language: DEFAULT_LANGUAGE_PREFERENCE,
  theme: 'system',
  pluginThemeId: null,
  activeTheme: { kind: 'builtin', id: 'builtin:twilight-echo-default' },
  themeWindowInheritance: { miniPlayer: true, desktopLyrics: true },
  motionPreference: 'system',
  blurEffect: true,
  windowTransparency: false,
  windowTransparencyEffect: {
    surfaceOpacity: 55,
    surfaceBlur: 0,
    cardOpacity: 60,
    cardBlur: 24
  },
  useCoverTheme: true,
  lyricsAppearance: cloneLyricsAppearance(DEFAULT_LYRICS_APPEARANCE),
  lyricsPresets: cloneLyricsPresetConfig(DEFAULT_LYRICS_PRESET_CONFIG),
  libraryFolders: [],
  downloadFolder: '',
  genreSeparators: DEFAULT_GENRE_SEPARATORS,
  watchLibrary: true,
  onlineLyricsFallback: false,
  smtcEnabled: true,
  discordRpcEnabled: false,
  accentColor: 'blue',
  lightAccentColor: 'blue',
  darkAccentColor: 'blue',
  fontFamily: 'system',
  uiDensity: 'standard',
  appBackground: {
    global: {
      light: '#f4f4f7',
      dark: '#17181a',
      kind: 'color',
      image: ''
    },
    pages: {
      local: { inherit: true, light: '#ffffff', dark: '#17181a', kind: 'color', image: '' },
      settings: { inherit: true, light: '#f4f4f7', dark: '#17181a', kind: 'color', image: '' },
      streaming: { inherit: true, light: '#fafbfe', dark: '#17181a', kind: 'color', image: '' },
      player: { inherit: true, light: '#080e17', dark: '#17181a', kind: 'color', image: '' }
    }
  },
  cardAppearance: {
    enabled: false,
    light: {
      blurRadius: 20,
      blurSaturation: 150,
      backgroundColor: '#ffffff',
      backgroundOpacity: 100,
      borderColor: '#0f172a',
      borderOpacity: 8,
      borderWidth: 1,
      borderRadius: 16,
      shadowStrength: 'medium',
      hoverEffect: 'lift',
      glassHighlight: true
    },
    dark: {
      blurRadius: 20,
      blurSaturation: 150,
      backgroundColor: '#181818',
      backgroundOpacity: 100,
      borderColor: '#ffffff',
      borderOpacity: 10,
      borderWidth: 1,
      borderRadius: 16,
      shadowStrength: 'medium',
      hoverEffect: 'lift',
      glassHighlight: true
    },
    background: {
      enabled: false,
      light: { blur: 0, brightness: 100, dim: 0 },
      dark: { blur: 0, brightness: 100, dim: 0 }
    }
  },
  surfaceMaterial: 'standard',
  liquidGlass: DEFAULT_LIQUID_GLASS,
  playerBar: clonePlayerBarSettings(DEFAULT_PLAYER_BAR_SETTINGS),
  nowPlayingBackground: 'blur',
  playbackResumeMode: 'off',
  previousButtonAction: 'restart',
  sleepTimer: DEFAULT_SLEEP_TIMER_SETTINGS,
  ncmPlaybackQuality: 'auto',
  playMode: 'sequential',
  softwareVolume: DEFAULT_SOFTWARE_VOLUME,
  audioOutput:
    process.platform === 'darwin' ? 'coreaudio' : process.platform === 'linux' ? 'alsa' : 'wasapi',
  audioDevice: 'auto',
  audioExclusiveMode: false,
  audioOutputConfig: {
    preferredBufferSize: 0,
    routingMode: 'auto',
    wasapiExclusivePushMode: false,
    pcmToDsdMode: 'off'
  },
  audioProcessing: DEFAULT_AUDIO_PROCESSING,
  dspScenes: [
    {
      id: 'default',
      name: 'Default',
      enabled: true,
      priority: 0,
      rules: {},
      graph: createLegacyDspGraph(DEFAULT_AUDIO_PROCESSING)
    }
  ],
  dspPinnedSceneId: null,
  headphoneCompensation: DEFAULT_HEADPHONE_COMPENSATION,
  audioEqPresets: [],
  desktopLyrics: { ...DEFAULT_DESKTOP_LYRICS },
  miniPlayer: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
  proxyMode: 'auto',
  proxyHost: '',
  proxyPort: 0,
  proxyAllowDirectFallback: false,
  streamingActiveProvider: 'ncm',
  remoteControlEnabled: false,
  remoteControlPort: 0
}

export function getSettingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getDefaultCachePath(): string {
  return join(app.getPath('userData'), 'music-cache')
}

export function getOpraDatabaseCachePath(): string {
  return join(app.getPath('userData'), 'opra', 'database_v1.jsonl')
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function normalizeProxyMode(value: unknown): ProxyMode {
  if (value === 'auto' || value === 'custom' || value === 'off') return value
  return 'auto'
}

export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((n) => parseInt(n, 10) || 0)
  const partsB = b.split('.').map((n) => parseInt(n, 10) || 0)
  const maxLen = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < maxLen; i++) {
    const va = partsA[i] ?? 0
    const vb = partsB[i] ?? 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

export function normalizeAudioEqPresets(presets: unknown): AudioEqPreset[] {
  if (!Array.isArray(presets)) return []

  return presets
    .map((preset, index): AudioEqPreset | null => {
      if (!preset || typeof preset !== 'object') return null
      const raw = preset as Partial<AudioEqPreset>
      const normalized = normalizeAudioProcessingSettings({
        eqMode: raw.eqMode,
        eqPreamp: raw.eqPreamp,
        eqBands: raw.eqBands
      })
      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : `custom-${index}`,
        name:
          typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 40) : `Preset ${index + 1}`,
        eqMode: normalized.eqMode,
        eqPreamp: normalized.eqPreamp,
        eqBands: normalized.eqBands
      }
    })
    .filter((preset): preset is AudioEqPreset => Boolean(preset))
    .slice(0, 24)
}

export function normalizeAppTheme(theme: unknown): AppTheme {
  return theme === 'system' || theme === 'dark' || theme === 'pureWhite'
    ? theme
    : DEFAULT_SETTINGS.theme
}

export function normalizePlaybackResumeMode(mode: unknown): PlaybackResumeMode {
  return mode === 'track' || mode === 'trackAndPosition' || mode === 'off'
    ? mode
    : DEFAULT_SETTINGS.playbackResumeMode
}

export function normalizePreviousButtonAction(value: unknown): PreviousButtonAction {
  return value === 'previous' ? 'previous' : DEFAULT_SETTINGS.previousButtonAction
}

export function normalizeNcmPlaybackQuality(value: unknown): NcmPlaybackQuality {
  return value === 'standard' ||
    value === 'exhigh' ||
    value === 'lossless' ||
    value === 'hires' ||
    value === 'auto'
    ? value
    : DEFAULT_SETTINGS.ncmPlaybackQuality
}

export function normalizeStartupHomePage(value: unknown): StartupHomePage {
  return value === 'streaming' ? 'streaming' : 'local'
}

export function normalizeTrackActivationMode(value: unknown): TrackActivationMode {
  return value === 'doubleClick' ? 'doubleClick' : 'singleClick'
}

export function normalizeStreamingAudioCachePolicy(value: unknown): StreamingAudioCachePolicy {
  return value === 'off' ? 'off' : 'provider'
}

const ACCELERATOR_PATTERN = /^([A-Za-z0-9+]+)$/
export function normalizeShortcutAccelerator(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().slice(0, 128)
  if (!trimmed) return fallback
  if (!ACCELERATOR_PATTERN.test(trimmed)) return fallback
  return trimmed
}

export function normalizeGlobalShortcutBindings(raw: unknown): GlobalShortcutSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    previous: normalizeShortcutAccelerator(
      value.previous,
      DEFAULT_GLOBAL_SHORTCUT_BINDINGS.previous
    ),
    next: normalizeShortcutAccelerator(value.next, DEFAULT_GLOBAL_SHORTCUT_BINDINGS.next),
    playPause: normalizeShortcutAccelerator(
      value.playPause,
      DEFAULT_GLOBAL_SHORTCUT_BINDINGS.playPause
    ),
    toggleDesktopLyrics: normalizeShortcutAccelerator(
      value.toggleDesktopLyrics,
      DEFAULT_GLOBAL_SHORTCUT_BINDINGS.toggleDesktopLyrics
    ),
    toggleDesktopLyricsLock: normalizeShortcutAccelerator(
      value.toggleDesktopLyricsLock,
      DEFAULT_GLOBAL_SHORTCUT_BINDINGS.toggleDesktopLyricsLock
    )
  }
}

export function normalizeMusicCachePolicy(raw: unknown): MusicCachePolicySettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    cover: value.cover !== false,
    lyrics: value.lyrics !== false,
    metadata: value.metadata !== false,
    streamingAudio: normalizeStreamingAudioCachePolicy(value.streamingAudio)
  }
}

export function normalizePlayMode(mode: unknown): PlayMode {
  return mode === 'listLoop' || mode === 'repeat' || mode === 'shuffle' ? mode : 'sequential'
}

export const ACCENT_COLORS = ['violet', 'blue', 'emerald', 'rose', 'amber', 'slate']

export function normalizeAccentColor(value: unknown): string {
  return typeof value === 'string' && ACCENT_COLORS.includes(value)
    ? value
    : DEFAULT_SETTINGS.accentColor
}

export function normalizeLightAccentColor(value: unknown): string {
  return typeof value === 'string' && ACCENT_COLORS.includes(value)
    ? value
    : DEFAULT_SETTINGS.lightAccentColor
}

export function normalizeDarkAccentColor(value: unknown, legacyValue: unknown): string {
  if (typeof value === 'string' && ACCENT_COLORS.includes(value)) return value
  if (typeof legacyValue === 'string' && ACCENT_COLORS.includes(legacyValue)) return legacyValue
  return DEFAULT_SETTINGS.darkAccentColor
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 64)
}

export function normalizeUiDensity(value: unknown): UiDensity {
  return value === 'compact' || value === 'comfortable' ? value : 'standard'
}

export function normalizeNowPlayingBackground(value: unknown): NowPlayingBackground {
  return value === 'fluid' || value === 'solid' ? value : 'blur'
}

export function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) return normalized.toLowerCase()
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) return `#${normalized.toLowerCase()}`
  return fallback
}

export function normalizeBackgroundKind(value: unknown): AppBackgroundKind {
  return value === 'image' ? 'image' : 'color'
}

export function normalizeBackgroundImageHandle(value: unknown): string {
  return typeof value === 'string' && /^background:\/\/[a-zA-Z0-9._-]+$/.test(value) ? value : ''
}

export const APP_BACKGROUND_PAGES: AppBackgroundPage[] = [
  'local',
  'settings',
  'streaming',
  'player'
]

export function normalizeAppBackground(raw: unknown): AppBackgroundSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    global?: Partial<AppBackgroundColorPair>
    pages?: Partial<Record<AppBackgroundPage, Partial<AppBackgroundPageOverride>>>
  }
  const defaultBackground = DEFAULT_SETTINGS.appBackground
  const global = {
    light: normalizeHexColor(value.global?.light, defaultBackground.global.light),
    dark: normalizeHexColor(value.global?.dark, defaultBackground.global.dark),
    kind: normalizeBackgroundKind(value.global?.kind),
    image: normalizeBackgroundImageHandle(value.global?.image)
  }
  const pages = APP_BACKGROUND_PAGES.reduce(
    (acc, page) => {
      const defaults = defaultBackground.pages[page]
      const override = value.pages?.[page]
      acc[page] = {
        inherit: override?.inherit !== false,
        light: normalizeHexColor(override?.light, defaults.light),
        dark: normalizeHexColor(override?.dark, defaults.dark),
        kind: normalizeBackgroundKind(override?.kind),
        image: normalizeBackgroundImageHandle(override?.image)
      }
      return acc
    },
    {} as Record<AppBackgroundPage, AppBackgroundPageOverride>
  )
  return { global, pages }
}

export const CARD_SHADOW_STRENGTHS: CardShadowStrength[] = ['none', 'subtle', 'medium', 'strong']
export const CARD_HOVER_EFFECTS: CardHoverEffect[] = ['none', 'lift', 'zoom', 'glow']

export function normalizeCardShadowStrength(value: unknown): CardShadowStrength {
  return typeof value === 'string' && CARD_SHADOW_STRENGTHS.includes(value as CardShadowStrength)
    ? (value as CardShadowStrength)
    : 'medium'
}

export function normalizeCardHoverEffect(value: unknown): CardHoverEffect {
  return typeof value === 'string' && CARD_HOVER_EFFECTS.includes(value as CardHoverEffect)
    ? (value as CardHoverEffect)
    : 'lift'
}

export function normalizeCardAppearanceTheme(
  raw: unknown,
  defaults: CardAppearanceTheme
): CardAppearanceTheme {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    blurRadius: clampNumber(t.blurRadius, 0, 40, defaults.blurRadius),
    blurSaturation: clampNumber(t.blurSaturation, 80, 180, defaults.blurSaturation),
    backgroundColor: normalizeHexColor(t.backgroundColor, defaults.backgroundColor),
    backgroundOpacity: clampNumber(t.backgroundOpacity, 0, 100, defaults.backgroundOpacity),
    borderColor: normalizeHexColor(t.borderColor, defaults.borderColor),
    borderOpacity: clampNumber(t.borderOpacity, 0, 100, defaults.borderOpacity),
    borderWidth: clampNumber(t.borderWidth, 0, 3, defaults.borderWidth),
    borderRadius: clampNumber(t.borderRadius, 0, 24, defaults.borderRadius),
    shadowStrength: normalizeCardShadowStrength(t.shadowStrength),
    hoverEffect: normalizeCardHoverEffect(t.hoverEffect),
    glassHighlight: t.glassHighlight !== false
  }
}

export function normalizeWindowTransparencyEffect(raw: unknown): WindowTransparencyEffectSettings {
  const defaults = DEFAULT_SETTINGS.windowTransparencyEffect
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    surfaceOpacity: clampNumber(t.surfaceOpacity, 20, 100, defaults.surfaceOpacity),
    surfaceBlur: clampNumber(t.surfaceBlur, 0, 60, defaults.surfaceBlur),
    cardOpacity: clampNumber(t.cardOpacity, 0, 100, defaults.cardOpacity),
    cardBlur: clampNumber(t.cardBlur, 0, 60, defaults.cardBlur)
  }
}

export function normalizeBackgroundEffectTheme(
  raw: unknown,
  defaults: BackgroundEffectTheme
): BackgroundEffectTheme {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    blur: clampNumber(t.blur, 0, 30, defaults.blur),
    brightness: clampNumber(t.brightness, 50, 120, defaults.brightness),
    dim: clampNumber(t.dim, 0, 80, defaults.dim)
  }
}

export function normalizeCardAppearance(raw: unknown): CardAppearanceSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const defaults = DEFAULT_SETTINGS.cardAppearance
  const bgRaw = (
    typeof value.background === 'object' && value.background !== null ? value.background : {}
  ) as Record<string, unknown>
  return {
    enabled: value.enabled === true,
    light: normalizeCardAppearanceTheme(value.light, defaults.light),
    dark: normalizeCardAppearanceTheme(value.dark, defaults.dark),
    background: {
      enabled: bgRaw.enabled === true,
      light: normalizeBackgroundEffectTheme(bgRaw.light, defaults.background.light),
      dark: normalizeBackgroundEffectTheme(bgRaw.dark, defaults.background.dark)
    }
  }
}

export function normalizePluginThemeId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && /^[a-z][a-z0-9-_.]*:[a-z][a-z0-9-_.]*$/.test(normalized) ? normalized : null
}

export function isDefaultAudioDeviceAlias(device: string): boolean {
  const normalized = device.trim()
  const lower = normalized.toLowerCase()
  return (
    lower === 'auto' ||
    lower === 'default' ||
    lower === 'system default' ||
    lower === 'system-default' ||
    normalized === '系统默认'
  )
}

export function normalizeAudioDevice(device: unknown): string {
  if (typeof device !== 'string') return DEFAULT_SETTINGS.audioDevice
  const normalized = device.trim()
  if (!normalized || isDefaultAudioDeviceAlias(normalized)) return DEFAULT_SETTINGS.audioDevice
  return normalized
}

export function normalizeChannelRoutingMode(value: unknown): ChannelRoutingMode {
  return value === 'stereo' ||
    value === 'stereo-to-5.1' ||
    value === 'stereo-to-7.1' ||
    value === 'mono-to-stereo' ||
    value === 'mono-to-multichannel'
    ? value
    : 'auto'
}

export function normalizePcmToDsdMode(value: unknown): NonNullable<OutputConfig['pcmToDsdMode']> {
  return value === 'dsd64' || value === 'dsd128' || value === 'dsd256' ? value : 'off'
}

export function normalizeOutputConfig(config: unknown): OutputConfig {
  if (!config || typeof config !== 'object') return { ...DEFAULT_SETTINGS.audioOutputConfig }
  const value = config as Partial<Record<keyof OutputConfig, unknown>>
  return {
    preferredBufferSize:
      typeof value.preferredBufferSize === 'number'
        ? clampNumber(Math.trunc(value.preferredBufferSize), 0, 8192, 0)
        : DEFAULT_SETTINGS.audioOutputConfig.preferredBufferSize,
    routingMode: normalizeChannelRoutingMode(value.routingMode),
    wasapiExclusivePushMode: value.wasapiExclusivePushMode === true,
    pcmToDsdMode: normalizePcmToDsdMode(value.pcmToDsdMode),
    upmixCenterGain: clampNumber(value.upmixCenterGain, 0, 2, 0.7071),
    upmixLfeGain: clampNumber(value.upmixLfeGain, 0, 2, 0.5),
    upmixLfeLowpassHz: clampNumber(value.upmixLfeLowpassHz, 20, 500, 120),
    upmixSurroundGain: clampNumber(value.upmixSurroundGain, 0, 2, 0.5),
    upmixSideGain: clampNumber(value.upmixSideGain, 0, 2, 0.3),
    upmixSurroundDelayMs: clampNumber(value.upmixSurroundDelayMs, 0, 100, 0)
  }
}

export function normalizeDesktopLyrics(raw: unknown): DesktopLyricsSettings {
  return normalizeDesktopLyricsSettings(raw)
}

export function normalizeSleepTimerSettings(raw: unknown): SleepTimerSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    defaultMinutes: clampNumber(
      value.defaultMinutes,
      1,
      720,
      DEFAULT_SLEEP_TIMER_SETTINGS.defaultMinutes
    ),
    fadeSeconds: clampNumber(value.fadeSeconds, 0, 120, DEFAULT_SLEEP_TIMER_SETTINGS.fadeSeconds)
  }
}

export function normalizeAppSettings(settings: Partial<AppSettings>): AppSettings {
  const rawSettings = settings as Record<string, unknown>
  const audioProcessing = normalizeAudioProcessingSettings(settings.audioProcessing)
  const dspScenes = normalizeDspScenes(settings.dspScenes, audioProcessing)
  const rawCachePath =
    typeof settings.cachePath === 'string' && settings.cachePath.trim()
      ? settings.cachePath.trim()
      : typeof settings.musicCachePath === 'string' && settings.musicCachePath.trim()
        ? settings.musicCachePath.trim()
        : getDefaultCachePath()
  const cachePath = resolve(rawCachePath)
  const launchAtLogin =
    typeof settings.launchAtLogin === 'boolean'
      ? settings.launchAtLogin
      : typeof settings.autoLaunch === 'boolean'
        ? settings.autoLaunch
        : DEFAULT_SETTINGS.launchAtLogin
  const autoLaunch = launchAtLogin
  const legacyCloseToTray =
    typeof settings.closeToTray === 'boolean'
      ? settings.closeToTray
      : typeof settings.minimizeToTray === 'boolean'
        ? settings.minimizeToTray
        : DEFAULT_SETTINGS.closeToTray
  const closeWindowBehavior: CloseWindowBehavior =
    settings.closeWindowBehavior === 'quit' ||
    settings.closeWindowBehavior === 'tray' ||
    settings.closeWindowBehavior === 'miniPlayer'
      ? settings.closeWindowBehavior
      : legacyCloseToTray
        ? 'tray'
        : 'quit'
  const closeToTray = closeWindowBehavior === 'tray'
  const minimizeToTray =
    typeof settings.minimizeToTray === 'boolean' ? settings.minimizeToTray : closeToTray

  const activeTheme = normalizeThemeSelection(settings.activeTheme, settings.pluginThemeId)
  const themeWindowInheritance = normalizeThemeWindowInheritance(
    settings.themeWindowInheritance,
    Object.prototype.hasOwnProperty.call(settings, 'themeWindowInheritance')
      ? DEFAULT_SETTINGS.themeWindowInheritance
      : { miniPlayer: false, desktopLyrics: false }
  )

  return {
    autoCheckLogin: settings.autoCheckLogin !== false,
    autoLaunch,
    launchAtLogin,
    hardwareAcceleration: settings.hardwareAcceleration !== false,
    globalShortcuts: settings.globalShortcuts === true,
    globalShortcutBindings: normalizeGlobalShortcutBindings(settings.globalShortcutBindings),
    minimizeToTray,
    musicCachePath: cachePath,
    cachePath,
    cachePolicy: normalizeMusicCachePolicy(settings.cachePolicy),
    autoAnalyzeBpm: settings.autoAnalyzeBpm !== false,
    closeWindowBehavior,
    closeToTray,
    taskbarThumbarButtonsEnabled: settings.taskbarThumbarButtonsEnabled !== false,
    onboardingCompleted: settings.onboardingCompleted === true,
    developerMode: settings.developerMode === true,
    startupHomePage: normalizeStartupHomePage(settings.startupHomePage),
    trackActivationMode: normalizeTrackActivationMode(settings.trackActivationMode),
    language: normalizeLanguagePreference(settings.language),
    theme: normalizeAppTheme(settings.theme),
    pluginThemeId:
      activeTheme.kind === 'plugin' ? `${activeTheme.pluginId}:${activeTheme.themeId}` : null,
    activeTheme,
    themeWindowInheritance,
    motionPreference: normalizeMotionPreference(settings.motionPreference),
    blurEffect: settings.blurEffect !== false,
    windowTransparency: settings.windowTransparency === true,
    windowTransparencyEffect: normalizeWindowTransparencyEffect(settings.windowTransparencyEffect),
    useCoverTheme: settings.useCoverTheme !== false,
    lyricsAppearance: normalizeLyricsAppearance(settings.lyricsAppearance, rawSettings),
    lyricsPresets: normalizeLyricsPresetConfig(settings.lyricsPresets),
    libraryFolders: normalizeStringArray(settings.libraryFolders),
    downloadFolder:
      typeof settings.downloadFolder === 'string' && settings.downloadFolder.trim()
        ? resolve(settings.downloadFolder.trim())
        : DEFAULT_SETTINGS.downloadFolder,
    genreSeparators: normalizeGenreSeparators(settings.genreSeparators),
    watchLibrary: settings.watchLibrary !== false,
    onlineLyricsFallback: settings.onlineLyricsFallback === true,
    smtcEnabled: settings.smtcEnabled !== false,
    discordRpcEnabled: settings.discordRpcEnabled === true,
    accentColor: normalizeAccentColor(
      settings.lightAccentColor ?? DEFAULT_SETTINGS.lightAccentColor
    ),
    lightAccentColor: normalizeLightAccentColor(settings.lightAccentColor),
    darkAccentColor: normalizeDarkAccentColor(settings.darkAccentColor, settings.accentColor),
    fontFamily: normalizeAppFontFamily(settings.fontFamily),
    uiDensity: normalizeUiDensity(settings.uiDensity),
    appBackground: normalizeAppBackground(settings.appBackground),
    cardAppearance: normalizeCardAppearance(settings.cardAppearance),
    surfaceMaterial: normalizeSurfaceMaterial(settings.surfaceMaterial),
    liquidGlass: normalizeLiquidGlass(settings.liquidGlass),
    playerBar: normalizePlayerBarSettings(settings.playerBar),
    nowPlayingBackground: normalizeNowPlayingBackground(settings.nowPlayingBackground),
    playbackResumeMode: normalizePlaybackResumeMode(settings.playbackResumeMode),
    previousButtonAction: normalizePreviousButtonAction(settings.previousButtonAction),
    sleepTimer: normalizeSleepTimerSettings(settings.sleepTimer),
    ncmPlaybackQuality: normalizeNcmPlaybackQuality(settings.ncmPlaybackQuality),
    playMode: normalizePlayMode(settings.playMode),
    softwareVolume: clampNumber(settings.softwareVolume, 0, 1, DEFAULT_SOFTWARE_VOLUME),
    audioOutput: normalizeAudioOutput(settings.audioOutput),
    audioDevice: normalizeAudioDevice(settings.audioDevice),
    audioExclusiveMode: settings.audioExclusiveMode === true,
    audioOutputConfig: normalizeOutputConfig(settings.audioOutputConfig),
    audioProcessing,
    dspScenes,
    dspPinnedSceneId:
      typeof settings.dspPinnedSceneId === 'string' &&
      dspScenes.some((scene) => scene.id === settings.dspPinnedSceneId)
        ? settings.dspPinnedSceneId
        : null,
    headphoneCompensation: normalizeHeadphoneCompensationSettings(settings.headphoneCompensation),
    audioEqPresets: normalizeAudioEqPresets(settings.audioEqPresets),
    desktopLyrics: normalizeDesktopLyrics(settings.desktopLyrics),
    miniPlayer: normalizeMiniPlayerSettings(settings.miniPlayer),
    proxyMode: normalizeProxyMode(settings.proxyMode),
    proxyHost:
      typeof settings.proxyHost === 'string' ? settings.proxyHost.trim().slice(0, 255) : '',
    proxyPort: clampNumber(settings.proxyPort, 0, 65535, 0),
    proxyAllowDirectFallback: settings.proxyAllowDirectFallback === true,
    streamingActiveProvider:
      typeof settings.streamingActiveProvider === 'string' &&
      settings.streamingActiveProvider.trim()
        ? settings.streamingActiveProvider.trim()
        : DEFAULT_SETTINGS.streamingActiveProvider,
    remoteControlEnabled: settings.remoteControlEnabled === true,
    remoteControlPort: clampNumber(settings.remoteControlPort, 0, 65535, 0)
  }
}

export function readAppSettings(): AppSettings {
  const result = loadSettingsFile(getSettingsFilePath(), DEFAULT_SETTINGS, normalizeAppSettings)
  appSettingsLoadIssue = result.issue
  if (result.issue?.kind === 'recovered') {
    console.warn('[persistence] application settings recovered from backup')
  } else if (result.issue?.kind === 'corrupt') {
    console.error('[persistence] application settings are corrupt; using defaults for this run')
  }
  return result.settings
}

export function writeAppSettings(settings: AppSettings): void {
  writeSettingsFile(getSettingsFilePath(), settings)
}

export function consumeAppSettingsLoadIssue(): SettingsFileLoadIssue | null {
  const issue = appSettingsLoadIssue
  appSettingsLoadIssue = null
  return issue
}

export function getRestartReasons(settings: AppSettings, launch: AppSettings): string[] {
  const reasons: string[] = []
  if (settings.hardwareAcceleration !== launch.hardwareAcceleration) {
    reasons.push('GPU 加速')
  }
  if (settings.windowTransparency !== launch.windowTransparency) {
    reasons.push('窗口透明')
  }
  if (resolve(settings.musicCachePath) !== resolve(launch.musicCachePath)) {
    reasons.push('缓存位置')
  }
  if (
    settings.proxyMode !== launch.proxyMode ||
    settings.proxyHost !== launch.proxyHost ||
    settings.proxyPort !== launch.proxyPort ||
    settings.proxyAllowDirectFallback !== launch.proxyAllowDirectFallback
  ) {
    reasons.push('插件代理')
  }
  return reasons
}

// Win11 22H2 (build 22621) 及以上才支持 DWM 原生亚克力背板。
export function isWindowsAcrylicBuild(): boolean {
  if (process.platform !== 'win32') return false
  const build = Number(release().split('.')[2] ?? 0)
  return Number.isFinite(build) && build >= 22621
}

// 透明窗口支持判定：
// - Linux Wayland：合成器忽略逐像素 alpha，内容可能整窗不渲染（黑屏）→ 不支持；
// - Windows：逐像素透明（transparent: true）在 DWM/部分 GPU 下会整窗黑屏且卡住，
//   只有系统开启"透明效果"、能用 DWM 原生亚克力时才安全 → 否则视为不支持；
// - 其余平台（X11/macOS）支持。
// 不支持的平台回退为不透明窗口，保证应用始终可见。
export function supportsNativeWindowTransparency(): boolean {
  if (process.platform === 'linux') {
    if (process.env['WAYLAND_DISPLAY'] || process.env['XDG_SESSION_TYPE'] === 'wayland') {
      return false
    }
    return true
  }
  if (process.platform === 'win32') {
    return isWindowsAcrylicBuild() && isWindowsAcrylicBackdropAvailable()
  }
  return true
}

// Win11 的原生亚克力（backgroundMaterial）依赖系统"透明效果"开关：
// 关闭时 DWM 不提供系统背板，Electron 会把窗口画成灰色。
// 这里读注册表检测该开关，供窗口层决定是否使用亚克力（而非逐像素透明）。
let windowsAcrylicBackdropAvailableCache: boolean | null = null
export function isWindowsAcrylicBackdropAvailable(): boolean {
  if (process.platform !== 'win32') return false
  if (windowsAcrylicBackdropAvailableCache !== null) {
    return windowsAcrylicBackdropAvailableCache
  }
  try {
    const output = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
        '/v',
        'EnableTransparency'
      ],
      { encoding: 'utf8', timeout: 3000 }
    )
    const match = /EnableTransparency\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output)
    windowsAcrylicBackdropAvailableCache = match ? parseInt(match[1], 16) === 1 : true
  } catch {
    // 读不到注册表时不做强判，交给 Electron 的默认回退行为。
    windowsAcrylicBackdropAvailableCache = true
  }
  return windowsAcrylicBackdropAvailableCache
}

export function createSettingsSnapshot(
  settings: AppSettings,
  launch: AppSettings
): SettingsSnapshot {
  const restartReasons = getRestartReasons(settings, launch)
  return {
    ...settings,
    settings: { ...settings },
    defaults: {
      cachePath: getDefaultCachePath()
    },
    paths: {
      settingsFile: getSettingsFilePath(),
      userDataPath: app.getPath('userData'),
      activeCachePath: launch.musicCachePath || getDefaultCachePath()
    },
    appVersion: app.getVersion(),
    platform: process.platform,
    windowTransparencySupported: supportsNativeWindowTransparency(),
    restartRequired: restartReasons.length > 0,
    restartReasons
  }
}

export async function getDirectorySize(directory: string): Promise<number> {
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) return info.size

    const entries = await readdir(directory, { withFileTypes: true })
    const sizes = await Promise.all(
      entries.map((entry) => {
        const fullPath = join(directory, entry.name)
        return entry.isDirectory() ? getDirectorySize(fullPath) : stat(fullPath).then((s) => s.size)
      })
    )
    return sizes.reduce((sum, size) => sum + size, 0)
  } catch {
    return 0
  }
}
