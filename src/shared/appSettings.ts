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

export interface DesktopLyricsSettings {
  enabled: boolean
  fontSize: number
  /** `follow` resolves from the active PlayingMusic lyric style; other values are overrides. */
  fontFamily: string
  fontWeight: number
  color: string
  highlightColor: string
  bgColor: string
  bgOpacity: number
  align: LyricAlign
  showTranslation: boolean
  /** multi = consecutive lines; bilingual = original + translation for the active line. */
  layout: DesktopLyricsLayout
  lineSpacing: number
  shadow: boolean
  shadowBlur: number
  shadowColor: string
  windowWidth: number
  windowHeight: number
  windowX: number
  windowY: number
  alwaysOnTop: boolean
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
  closeToTray: boolean
  /** First-run welcome wizard has been completed or skipped. */
  onboardingCompleted: boolean
  startupHomePage: StartupHomePage
  trackActivationMode: TrackActivationMode
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
