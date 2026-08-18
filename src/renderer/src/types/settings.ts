import type { AppSettings } from '../../../shared/appSettings.ts'
export type {
  AudioOutputId,
  PlayMode,
  EqMode,
  VolumeNormalizationMode,
  ChannelRoutingMode,
  PcmToDsdMode,
  DsdOutputMode,
  SacdProgramMode,
  EqualizerFilterType,
  EqualizerBand,
  AudioProcessingSettings,
  AudioOutputOption,
  AudioDeviceOption,
  AudioCapabilitySupportState,
  OutputConfig,
  OutputConfigApplyStatus,
  HeadphoneCompensationSettings
} from '../../../shared/audioEngineTypes.ts'
export type {
  AppTheme,
  PlaybackResumeMode,
  PreviousButtonAction,
  NcmPlaybackQuality,
  StartupHomePage,
  TrackActivationMode,
  UiDensity,
  ProxyMode,
  NowPlayingBackground,
  LyricAlign,
  StreamingAudioCachePolicy,
  AppBackgroundPage,
  AppBackgroundKind,
  AppBackgroundColorPair,
  AppBackgroundPageOverride,
  AppBackgroundSettings,
  CardShadowStrength,
  CardHoverEffect,
  CardAppearanceTheme,
  BackgroundEffectTheme,
  BackgroundEffectSettings,
  CardAppearanceSettings,
  WindowTransparencyEffectSettings,
  DesktopLyricsLayout,
  DesktopLyricsSettings,
  MusicCachePolicySettings,
  AudioEqPreset,
  GlobalShortcutSettings,
  AppSettings
} from '../../../shared/appSettings.ts'

export type { MiniPlayerSettings } from '../../../shared/miniPlayer.ts'
export type { MotionPreference } from '../../../shared/motion.ts'
export type {
  LiquidGlassCoverage,
  LiquidGlassSettings,
  LiquidGlassTheme,
  SurfaceMaterial
} from '../../../shared/liquidGlass.ts'
export type {
  PlayerBarMode,
  PlayerBarPageMode,
  PlayerBarPresentation,
  PlayerBarSettings
} from '../../../shared/playerBar.ts'
export type {
  LyricsAppearanceAlign,
  LyricsAppearanceColorMode,
  LyricsAppearanceFontFamily,
  LyricsAppearanceSettings,
  LyricsFocusLineCount
} from '../../../shared/lyricsAppearance.ts'

export type PlayerShortcutAction =
  | 'previous'
  | 'next'
  | 'playPause'
  | 'play'
  | 'pause'
  | 'toggleDesktopLyrics'
  | { action: 'seek'; positionSeconds: number }
  | { action: 'setVolume'; volume: number }
  | { action: 'jumpQueue'; index: number }

export type { DsdRouteSettings } from '../../../shared/audioProcessingOptions.ts'

export interface SettingsSnapshot {
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
  windowTransparencySupported: boolean
  restartRequired: boolean
  restartReasons: string[]
}

export interface PlayerShortcutStatus {
  accelerator: string
  action: PlayerShortcutAction
  label: string
  registered: boolean
  error: string | null
}
