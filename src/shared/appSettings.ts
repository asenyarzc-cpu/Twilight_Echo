import type {
  AudioOutputId,
  AudioProcessingSettings,
  EqMode,
  EqualizerBand,
  HeadphoneCompensationSettings,
  OutputConfig,
  PlayMode
} from './audioEngineTypes.ts'
import type { MiniPlayerSettings } from './miniPlayer.ts'
import type { DspScene } from './dspGraph.ts'
import type { SleepTimerSettings } from './sleepTimer.ts'
import type { ThemeSelection, ThemeWindowInheritance } from './theme.ts'
import type { MotionPreference } from './motion.ts'
import type { LiquidGlassSettings, SurfaceMaterial } from './liquidGlass.ts'
import type { LyricsAppearanceSettings } from './lyricsAppearance.ts'
import type { LyricsPresetConfig } from './lyricsPresets.ts'
import type { PlayerBarSettings } from './playerBar.ts'
import type { LanguagePreference } from './i18n/locale.ts'

export type AppTheme = 'system' | 'pureWhite' | 'dark'
export type PlaybackResumeMode = 'off' | 'track' | 'trackAndPosition'
export type PreviousButtonAction = 'restart' | 'previous'
export type NcmPlaybackQuality = 'auto' | 'standard' | 'exhigh' | 'lossless' | 'hires'
export type StartupHomePage = 'local' | 'streaming'
export type TrackActivationMode = 'singleClick' | 'doubleClick'
export type UiDensity = 'compact' | 'standard' | 'comfortable'
export type ProxyMode = 'auto' | 'custom' | 'off'
export type NowPlayingBackground = 'blur' | 'fluid' | 'solid'
export type LyricAlign = 'center' | 'left'
export type StreamingAudioCachePolicy = 'off' | 'provider'
export type AppBackgroundPage = 'local' | 'settings' | 'streaming' | 'player'
export type AppBackgroundKind = 'color' | 'image'

export interface AppBackgroundColorPair {
  light: string
  dark: string
  kind: AppBackgroundKind
  image: string
}

export interface AppBackgroundPageOverride extends AppBackgroundColorPair {
  inherit: boolean
}

export interface AppBackgroundSettings {
  global: AppBackgroundColorPair
  pages: Record<AppBackgroundPage, AppBackgroundPageOverride>
}

export type CardShadowStrength = 'none' | 'subtle' | 'medium' | 'strong'
export type CardHoverEffect = 'none' | 'lift' | 'zoom' | 'glow'

export interface CardAppearanceTheme {
  blurRadius: number
  blurSaturation: number
  backgroundColor: string
  backgroundOpacity: number
  borderColor: string
  borderOpacity: number
  borderWidth: number
  borderRadius: number
  shadowStrength: CardShadowStrength
  hoverEffect: CardHoverEffect
  glassHighlight: boolean
}

export interface BackgroundEffectTheme {
  blur: number
  brightness: number
  dim: number
}

export interface BackgroundEffectSettings {
  enabled: boolean
  light: BackgroundEffectTheme
  dark: BackgroundEffectTheme
}

export interface CardAppearanceSettings {
  enabled: boolean
  light: CardAppearanceTheme
  dark: CardAppearanceTheme
  background: BackgroundEffectSettings
}

export interface WindowTransparencyEffectSettings {
  surfaceOpacity: number
  surfaceBlur: number
  cardOpacity: number
  cardBlur: number
}

export type DesktopLyricsLayout = 'multi' | 'bilingual'
export type DesktopLyricsPresentation = 'netease' | 'classic'

export interface DesktopLyricsSettings {
  enabled: boolean
  fontSize: number
  /** `follow` resolves from the active PlayingMusic lyric style; other values are overrides. */
  fontFamily: string
  /** Resolved font stack sent to the desktop window while preserving the stored preference. */
  resolvedFontFamily?: string
  fontWeight: number
  color: string
  highlightColor: string
  bgColor: string
  bgOpacity: number
  showAcrylic: boolean
  align: LyricAlign
  showTranslation: boolean
  /** multi = consecutive lines; bilingual = original + translation for the active line. */
  layout: DesktopLyricsLayout
  /** netease = two-row karaoke overlay; classic = the previous desktop lyrics layout. */
  presentation: DesktopLyricsPresentation
  lineSpacing: number
  shadow: boolean
  shadowBlur: number
  shadowColor: string
  windowWidth: number
  windowHeight: number
  windowX: number
  windowY: number
  alwaysOnTop: boolean
  /** Locked windows are click-through until the hover unlock affordance is used. */
  locked: boolean
  /** Compatibility alias retained for settings written before locked mode existed. */
  clickThrough: boolean
  maxLines: number
  /** Horizontal stagger in px: even rows left (-), odd rows right (+). */
  lineOffset: number
}

export interface MusicCachePolicySettings {
  cover: boolean
  lyrics: boolean
  metadata: boolean
  streamingAudio: StreamingAudioCachePolicy
}

export interface AudioEqPreset {
  id: string
  name: string
  eqMode: EqMode
  eqPreamp: number
  eqBands: EqualizerBand[]
}

export interface GlobalShortcutSettings {
  previous: string
  next: string
  playPause: string
  toggleDesktopLyrics: string
}

export type CloseWindowBehavior = 'quit' | 'tray' | 'miniPlayer'

export interface AppSettings {
  autoCheckLogin: boolean
  autoLaunch: boolean
  launchAtLogin: boolean
  hardwareAcceleration: boolean
  globalShortcuts: boolean
  globalShortcutBindings: GlobalShortcutSettings
  minimizeToTray: boolean
  musicCachePath: string
  cachePath: string
  cachePolicy: MusicCachePolicySettings
  autoAnalyzeBpm: boolean
  /**
   * How the main-window close control behaves. closeToTray is retained as the
   * compatibility mirror for older settings and code paths.
   */
  closeWindowBehavior: CloseWindowBehavior
  closeToTray: boolean
  /** Windows taskbar thumbnail transport buttons; independent from SMTC metadata. */
  taskbarThumbarButtonsEnabled: boolean
  /** First-run welcome wizard has been completed or skipped. */
  onboardingCompleted: boolean
  /** Unlocks developer-only affordances, e.g. installing an unpacked plugin directory. */
  developerMode: boolean
  startupHomePage: StartupHomePage
  trackActivationMode: TrackActivationMode
  /** UI and error-message language. `system` follows the OS locale. */
  language: LanguagePreference
  theme: AppTheme
  pluginThemeId: string | null
  activeTheme: ThemeSelection
  themeWindowInheritance: ThemeWindowInheritance
  motionPreference: MotionPreference
  blurEffect: boolean
  windowTransparency: boolean
  windowTransparencyEffect: WindowTransparencyEffectSettings
  useCoverTheme: boolean
  lyricsAppearance: LyricsAppearanceSettings
  lyricsPresets: LyricsPresetConfig
  libraryFolders: string[]
  /** Destination for provider downloads. Empty falls back to the first music library folder. */
  downloadFolder: string
  genreSeparators: string
  watchLibrary: boolean
  /** When true, empty local/provider lyrics may fall back to LRCLIB online search. */
  onlineLyricsFallback: boolean
  smtcEnabled: boolean
  discordRpcEnabled: boolean
  accentColor: string
  lightAccentColor: string
  darkAccentColor: string
  fontFamily: string
  uiDensity: UiDensity
  appBackground: AppBackgroundSettings
  cardAppearance: CardAppearanceSettings
  /** Switches navigation and playback controls between standard surfaces and liquid glass. */
  surfaceMaterial: SurfaceMaterial
  liquidGlass: LiquidGlassSettings
  /** Standard vs mini playbar shape, plus now-playing auto-hide. */
  playerBar: PlayerBarSettings
  nowPlayingBackground: NowPlayingBackground
  playbackResumeMode: PlaybackResumeMode
  /** restart: previous button replays the current track first; previous: always jump to the previous track. */
  previousButtonAction: PreviousButtonAction
  sleepTimer: SleepTimerSettings
  ncmPlaybackQuality: NcmPlaybackQuality
  playMode: PlayMode
  /** Last user software volume in [0, 1]. Default 0.7; bit-perfect needs explicit 1.0. */
  softwareVolume: number
  audioOutput: AudioOutputId
  audioDevice: string
  audioExclusiveMode: boolean
  audioOutputConfig: OutputConfig
  audioProcessing: AudioProcessingSettings
  dspScenes: DspScene[]
  dspPinnedSceneId: string | null
  headphoneCompensation: HeadphoneCompensationSettings
  audioEqPresets: AudioEqPreset[]
  desktopLyrics: DesktopLyricsSettings
  miniPlayer: MiniPlayerSettings
  proxyMode: ProxyMode
  proxyHost: string
  proxyPort: number
  proxyAllowDirectFallback: boolean
  streamingActiveProvider: string
  /** LAN web remote + media token server. Default OFF. */
  remoteControlEnabled: boolean
  /** Preferred remote HTTP port; 0 = ephemeral. */
  remoteControlPort: number
}
