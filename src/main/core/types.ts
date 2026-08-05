import type {
  AudioOutputId,
  OutputConfig,
  AudioProcessingSettings,
  PlayMode,
  EqMode,
  EqualizerBand
} from '../audioEngineManager'
import type { HeadphoneCompensationSettings } from '../audioProcessingEffective'
import type { MiniPlayerSettings } from '../../shared/miniPlayer'
import type { DspScene } from '../../shared/dspGraph'
import type { SleepTimerSettings } from '../../shared/sleepTimer.ts'
import type { ThemeSelection, ThemeWindowInheritance } from '../../shared/theme.ts'
import type { MotionPreference } from '../../shared/motion.ts'
import type { LyricsAppearanceSettings } from '../../shared/lyricsAppearance.ts'

export type { MiniPlayerSettings } from '../../shared/miniPlayer'
export type { MotionPreference } from '../../shared/motion.ts'

/** Global shortcuts are string-only; remote control may send structured seek/volume/queue commands. */
export type PlayerShortcutAction =
  | 'previous'
  | 'next'
  | 'playPause'
  | 'play'
  | 'pause'
  | 'volumeUp'
  | 'volumeDown'
  | { action: 'seek'; positionSeconds: number }
  | { action: 'setVolume'; volume: number }
  | { action: 'jumpQueue'; index: number }

/** Accelerator-bound actions only (excludes structured remote payloads). */
export type PlayerShortcutKeyAction = Extract<PlayerShortcutAction, string>
export type AppTheme = 'system' | 'pureWhite' | 'dark'
export type PlaybackResumeMode = 'off' | 'track' | 'trackAndPosition'
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

export interface AppSettings {
  autoCheckLogin: boolean
  autoLaunch: boolean
  launchAtLogin: boolean
  hardwareAcceleration: boolean
  globalShortcuts: boolean
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
  nowPlayingBackground: NowPlayingBackground
  playbackResumeMode: PlaybackResumeMode
  sleepTimer: SleepTimerSettings
  ncmPlaybackQuality: NcmPlaybackQuality
  playMode: PlayMode
  /** Last user software volume in [0, 1]. Default 0.7; bit-perfect needs explicit 1.0. */
  softwareVolume: number
  audioOutput: AudioOutputId
  audioDevice: string
  foobar2000PortablePath: string
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

export interface PlaybackSession {
  version: number
  savedAt: string
  mode: PlaybackResumeMode
  playMode?: PlayMode
  track: unknown
  position: number
  queue?: unknown[]
  queueIndex?: number
  sleepTimer?: unknown
}

export interface SettingsSnapshot extends AppSettings {
  settings: AppSettings
  defaults: {
    cachePath: string
  }
  paths: {
    settingsFile: string
    userDataPath: string
    activeCachePath: string
  }
  appVersion: string
  platform: string
  restartRequired: boolean
  restartReasons: string[]
}

export interface PlayerShortcutStatus {
  accelerator: string
  action: PlayerShortcutKeyAction
  label: string
  registered: boolean
  error: string | null
}

export const PLAYER_SHORTCUTS: {
  accelerator: string
  action: PlayerShortcutKeyAction
  label: string
}[] = [
  { accelerator: 'CommandOrControl+Alt+Left', action: 'previous', label: '上一首' },
  { accelerator: 'CommandOrControl+Alt+Right', action: 'next', label: '下一首' },
  { accelerator: 'CommandOrControl+Alt+Space', action: 'playPause', label: '播放 / 暂停' },
  { accelerator: 'CommandOrControl+Alt+Up', action: 'volumeUp', label: '音量 +' },
  { accelerator: 'CommandOrControl+Alt+Down', action: 'volumeDown', label: '音量 -' }
]
