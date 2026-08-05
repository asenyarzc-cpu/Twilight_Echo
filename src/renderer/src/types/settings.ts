import type { MiniPlayerSettings } from '../../../shared/miniPlayer.ts'
import type { DspScene } from '../../../shared/dspGraph.ts'
import type { SleepTimerSettings } from '../../../shared/sleepTimer.ts'
import type { ThemeSelection, ThemeWindowInheritance } from '../../../shared/theme.ts'
import type { MotionPreference } from '../../../shared/motion.ts'
import type { LyricsAppearanceSettings } from '../../../shared/lyricsAppearance.ts'

export type { MiniPlayerSettings } from '../../../shared/miniPlayer.ts'
export type { MotionPreference } from '../../../shared/motion.ts'
export type {
  LyricsAppearanceAlign,
  LyricsAppearanceColorMode,
  LyricsAppearanceFontFamily,
  LyricsAppearanceSettings,
  LyricsFocusLineCount
} from '../../../shared/lyricsAppearance.ts'

export type AppTheme = 'system' | 'pureWhite' | 'dark'
export type PlaybackResumeMode = 'off' | 'track' | 'trackAndPosition'
export type NcmPlaybackQuality = 'auto' | 'standard' | 'exhigh' | 'lossless' | 'hires'
export type StartupHomePage = 'local' | 'streaming'
export type TrackActivationMode = 'singleClick' | 'doubleClick'
/** sequential stops at the tail; listLoop wraps; repeat loops one track; shuffle uses a shuffled cycle. */
export type PlayMode = 'sequential' | 'listLoop' | 'repeat' | 'shuffle'
export type AudioOutputId = 'wasapi' | 'asio' | 'coreaudio' | 'alsa'
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
export type EqMode = 'graphic' | 'parametric'
export type VolumeNormalizationMode = 'off' | 'track' | 'album' | 'loudnorm'
export type ChannelRoutingMode =
  | 'auto'
  | 'stereo'
  | 'stereo-to-5.1'
  | 'stereo-to-7.1'
  | 'mono-to-stereo'
  | 'mono-to-multichannel'
export type DsdOutputMode = 'auto' | 'pcm' | 'dop' | 'native' | 'foo_dsd_asio'
export type SacdProgramMode = 'auto' | 'stereo' | 'multichannel'
export type UiDensity = 'compact' | 'standard' | 'comfortable'
export type NowPlayingBackground = 'blur' | 'fluid' | 'solid'
export type LyricAlign = 'center' | 'left'
export type ProxyMode = 'auto' | 'custom' | 'off'
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

export type EqualizerFilterType =
  | 'peak'
  | 'lowShelf'
  | 'highShelf'
  | 'bandPass'
  | 'lowPass'
  | 'highPass'
  | 'allPass'
  | 'notch'

export interface EqualizerBand {
  frequency: number
  gain: number
  q: number
  filterType: EqualizerFilterType
  enabled?: boolean
  channelMask?: number
}

export interface AudioProcessingSettings {
  dspEnabled: boolean
  directMode: boolean
  clipGuard: boolean
  fftEnabled: boolean
  fftResolution: number
  highResolution: boolean
  dsdToPcm: boolean
  dsdOutputMode: DsdOutputMode
  sacdProgramMode: SacdProgramMode
  eqEnabled: boolean
  eqMode: EqMode
  eqPreamp: number
  eqBands: EqualizerBand[]
  volumeNormalization: VolumeNormalizationMode
  replayGainPreamp: number
  replayGainFallback: number
  replayGainClip: boolean
  convolverEnabled: boolean
  convolverIrPath: string
  crossfeedEnabled: boolean
  crossfeedStrength: number
  crossfeedDelayMs: number
  crossfeedCutoffHz: number
  gapless: boolean
  crossfadeSeconds: number
}

export interface HeadphoneCompensationSettings {
  enabled: boolean
  productId: string
  productName: string
  vendorName: string
  eqId: string
  author: string
  details: string
  link: string
  preampDb: number
  bands: EqualizerBand[]
}

export interface AudioEqPreset {
  id: string
  name: string
  eqMode: EqMode
  eqPreamp: number
  eqBands: EqualizerBand[]
}

export interface AudioOutputOption {
  id: AudioOutputId
  label: string
  description: string
  platform: NodeJS.Platform
  supportsExclusive: boolean
}

export interface AudioDeviceOption {
  id: string
  label: string
  isDefault: boolean
  backend?: string
  name?: string
  channels?: number
  sampleRates?: number[]
  driverName?: string
  driverVersion?: number
  bitDepths?: number[]
  latencyFrames?: number
  minBufferSize?: number
  maxBufferSize?: number
  granularity?: number
  preferredBufferSize?: number
  capabilityVersion?: number
  supportsExclusive?: boolean
  supportsHogMode?: boolean
  supportsDirectHw?: boolean
  supportsDop?: boolean
  supportsNativeDsd?: boolean
  dopSupportState?: AudioCapabilitySupportState
  nativeDsdSupportState?: AudioCapabilitySupportState
  supportedDsdRates?: number[]
  nativeDsdSampleRates?: number[]
  nativeDsdSampleFormats?: string[]
  dopCarrierSampleRates?: number[]
  dopCarrierFormats?: string[]
  pathKind?: string
  capabilityReason?: string
}

export type AudioCapabilitySupportState = 'verified' | 'runtime-probed' | 'unsupported' | 'unknown'

export type PcmToDsdMode = 'off' | 'dsd64' | 'dsd128' | 'dsd256'

export interface OutputConfig {
  preferredBufferSize: number
  routingMode: ChannelRoutingMode
  wasapiExclusivePushMode?: boolean
  pcmToDsdMode?: PcmToDsdMode
  upmixCenterGain?: number
  upmixLfeGain?: number
  upmixLfeLowpassHz?: number
  upmixSurroundGain?: number
  upmixSideGain?: number
  upmixSurroundDelayMs?: number
}

export interface OutputConfigApplyStatus {
  requestedRevision: number
  appliedRevision: number
  failedRevision: number
  state: 'idle' | 'pending' | 'applied' | 'failed'
  error: string
  generation: number
}

export interface AppSettings {
  autoCheckLogin: boolean
  autoLaunch: boolean
  minimizeToTray: boolean
  launchAtLogin: boolean
  hardwareAcceleration: boolean
  globalShortcuts: boolean
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
  remoteControlEnabled: boolean
  remoteControlPort: number
}

export interface FooDsdAsioPortableStatus {
  configuredPath: string
  rootPath: string
  foobarExecutable: string
  portableModeEnabled: boolean
  hasAsioDsdComponent: boolean
  hasSacdComponent: boolean
  matched: boolean
  message: string
}

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
