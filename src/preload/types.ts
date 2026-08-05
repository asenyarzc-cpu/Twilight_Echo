export type AudioEngineEventCallback = (event: { name: string; data: unknown }) => void
export type AudioEngineEndFileCallback = (reason: string) => void

import type { DspGraphStatus, DspScene } from '../shared/dspGraph.ts'
import type { SleepTimerSettings } from '../shared/sleepTimer.ts'
import type { MotionPreference } from '../shared/motion.ts'
import type { LyricsAppearanceSettings } from '../shared/lyricsAppearance.ts'
import type {
  StructuredPluginTheme,
  ThemeSelection,
  ThemeWindowInheritance
} from '../shared/theme.ts'

export type {
  StructuredPluginTheme,
  StructuredPluginThemeV1,
  StructuredPluginThemeV2,
  ThemeAssetBindings,
  ThemeAssetReference,
  ThemeAssetType,
  ThemeBootstrap,
  ThemeDocumentV1,
  ThemeLibraryDocument,
  ThemeLibrarySnapshot,
  ThemeProfileV1,
  ThemeProfileV2,
  ThemeSelection,
  ThemeTokenDefinition,
  ThemeTokenKind,
  ThemeTone,
  ThemeWindowDefaults,
  ThemeWindowInheritance
} from '../shared/theme.ts'

export type { VersionedDataEnvelope } from '../shared/versionedPersistence.ts'
export type {
  AutoEqSourceColumn,
  FrequencyResponsePoint,
  ImportedFrequencyResponse,
  TargetRelativeFrequencyResponse
} from '../shared/frequencyResponse.ts'
export type { MotionPreference } from '../shared/motion.ts'
export type {
  LyricsAppearanceAlign,
  LyricsAppearanceColorMode,
  LyricsAppearanceFontFamily,
  LyricsAppearanceSettings,
  LyricsFocusLineCount
} from '../shared/lyricsAppearance.ts'
export type {
  LyricsManagementDocument,
  LyricTrackOverride,
  LyricSourcePreference
} from '../shared/lyricsManagement.ts'

export type {
  AcousticFingerprint,
  AcousticFingerprintEvidence,
  DuplicateActionPlan,
  DuplicateCandidate,
  DuplicateConfidence,
  DuplicateDetectionResult,
  DuplicateEvidenceKind,
  DuplicateGroup,
  DuplicateDetectionReadApi
} from '../shared/duplicateDetection.ts'

export type {
  LocalLibraryExclusion,
  LocalLibraryMutationFailure,
  LocalLibraryRemoveRequest,
  LocalLibraryRemoveResult,
  LocalLibraryResetResult,
  LocalLibraryRemovalMode,
  LocalLibraryRestoreRequest,
  LocalLibraryRestoreResult,
  LocalLibrarySnapshotInput,
  LocalLibraryTrackSelection,
  LocalMusicLibraryDocument
} from '../shared/localLibrary.ts'

export type {
  LocalLibraryTagFailure,
  LocalLibraryTagPatch,
  LocalLibraryTagRestoreRequest,
  LocalLibraryTagRestoreResult,
  LocalLibraryTagWriteItem,
  LocalLibraryTagWriteRequest,
  LocalLibraryTagWriteResult
} from '../shared/localLibraryTags.ts'

export type {
  LocalLibraryScanProgress,
  LocalLibraryScanStatus,
  LocalLibraryScanUpdate,
  LibraryWatcherFolderStatus,
  LibraryWatcherMode,
  LibraryWatcherState,
  LibraryWatcherStatusSnapshot
} from '../shared/localLibraryScan.ts'

export type {
  DspAsset,
  DspAssetKind,
  DspCorrectionImportResult,
  DspCorrectionProfile,
  DspGraphStatus,
  DspOutputStageConfig,
  DspProfile,
  DspScene,
  DspSceneState,
  DspStereoImageConfig,
  Vst3CatalogState
} from '../shared/dspGraph.ts'

export type {
  MiniPlayerBootstrap,
  MiniPlayerCommand,
  MiniPlayerSettings,
  MiniPlayerSettingsPatch,
  MiniPlayerStateSnapshot
} from '../shared/miniPlayer.ts'
export type { TrayNavigationTarget, TrayPlayerBootstrap } from '../shared/trayPlayer.ts'

export type AudioEngineSimpleCallback = () => void
export type AudioEngineErrorCallback = (message: string) => void
export type AudioEnginePlaybackInfoCallback = (info: PlaybackInfo) => void
export type LoudnormStatus = 'idle' | 'measuring' | 'cached' | 'fallback' | 'unavailable'
export interface LoudnormStatusEvent {
  status: LoudnormStatus
  source: string | null
  reason?: string
  analysis?: LoudnessAnalysisResult
}
export type AudioEngineLoudnormStatusCallback = (event: LoudnormStatusEvent) => void
export interface AudioEngineConfigAppliedEvent {
  requestedConfigRevision: number
  appliedConfigRevision: number
}
export type AudioEngineConfigAppliedCallback = (event: AudioEngineConfigAppliedEvent) => void
export type AudioEngineDeviceOptionsChangedCallback = (event: { reason: string }) => void
export type AudioEngineServiceCrashCallback = (event: { reason: string }) => void
export interface AudioEngineServiceReadyEvent {
  manualResumeRequired: boolean
  outputRouteSynced: boolean
  restoreErrors: string[]
}
export type AudioEngineServiceReadyCallback = (event: AudioEngineServiceReadyEvent) => void
export type AudioOutputId = 'wasapi' | 'asio' | 'coreaudio' | 'alsa'
export type PlayMode = 'sequential' | 'listLoop' | 'repeat' | 'shuffle'
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
export interface PlayerShortcutStatus {
  accelerator: string
  action: PlayerShortcutAction
  label: string
  registered: boolean
  error: string | null
}
export type AppTheme = 'system' | 'pureWhite' | 'dark'
export type PlaybackResumeMode = 'off' | 'track' | 'trackAndPosition'
export type NcmPlaybackQuality = 'auto' | 'standard' | 'exhigh' | 'lossless' | 'hires'
export type {
  NcmCloudDownloadRequest,
  NcmCloudDownloadResult,
  NcmCloudSelectedFile,
  NcmCloudTransferProgress,
  NcmCloudUploadResult
} from '../shared/ncmCloud.ts'
export type StartupHomePage = 'local' | 'streaming'
export type TrackActivationMode = 'singleClick' | 'doubleClick'
export type UiDensity = 'compact' | 'standard' | 'comfortable'
export type NowPlayingBackground = 'blur' | 'fluid' | 'solid'
export type LyricAlign = 'center' | 'left'
export type ProxyMode = 'auto' | 'custom' | 'off'
export type StreamingAudioCachePolicy = 'off' | 'provider'

export type LibraryChange =
  | { kind: 'add' | 'remove' | 'unknown'; path?: string }
  | { kind: 'scan'; update: import('../shared/localLibraryScan.ts').LocalLibraryScanUpdate }

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

export interface DesktopLyricsTrackPayload {
  lyrics: string | null
  translatedLyrics?: string | null
  romanizedLyrics?: string | null
  lyricsSource?: LyricSource | null
  translatedLyricsSource?: LyricSource | null
  title?: string
  artist?: string
}

export interface MusicCachePolicySettings {
  cover: boolean
  lyrics: boolean
  metadata: boolean
  streamingAudio: StreamingAudioCachePolicy
}

export type BuiltInTrackSource = 'local' | 'ncm'
export type TrackSource = BuiltInTrackSource | (string & {})
export type LyricSource = 'embedded' | 'local' | 'provider' | 'manual' | 'online'
export type MetadataMatchConfidence = 'high' | 'medium'
export interface TrackMetadataMatch {
  providerId: string
  trackId: string
  confidence: MetadataMatchConfidence
  score: number
}
export interface BpmTempoSegment {
  startMs: number
  endMs: number
  bpm: number
  confidence: number
}
export interface BpmAnalysisResult {
  bpm: number
  confidence: number
  source: 'analyzed'
  analyzedAt: string
  algorithmVersion: number
  variableTempo?: boolean
  bpmRange?: [number, number]
  tempoMap?: BpmTempoSegment[]
}
export interface BpmAnalysisRequest {
  trackId: string
  filePath: string
  referenceBpm?: number
}
export type BpmAnalysisRequestResult =
  | { status: 'completed'; analysis: BpmAnalysisResult }
  | { status: 'cached'; analysis: BpmAnalysisResult }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
export interface BpmAnalysisCompletedEvent {
  trackId: string
  filePath: string
  analysis: BpmAnalysisResult
}
export interface LoudnessAnalysisResult {
  integratedLufs: number
  truePeakDb: number
  source: 'analyzed'
  analyzedAt: string
  algorithmVersion: number
  sampleRate?: number
  channels?: number
  analyzedFrames?: number
  available?: boolean
}
export interface LoudnessAnalysisRequest {
  trackId: string
  filePath: string
  targetLufs?: number
  truePeakCeilingDb?: number
}
export type LoudnessAnalysisRequestResult =
  | { status: 'completed'; analysis: LoudnessAnalysisResult }
  | { status: 'cached'; analysis: LoudnessAnalysisResult }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'unavailable'; reason: string }
export interface LoudnessAnalysisCompletedEvent {
  trackId: string
  filePath: string
  analysis: LoudnessAnalysisResult
}
export type TwilightPluginType = 'provider' | 'tool' | 'ui' | 'theme' | 'dsp'
export type TwilightPluginStatus = 'installed' | 'enabled' | 'disabled' | 'invalid' | 'failed'
export type TwilightPluginIndexInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'incompatible'
  | 'built-in-blocked'
export type TwilightPluginIndexSourceKind = 'github' | 'custom' | 'bundled'
export type TwilightPluginIndexLoadedFrom = 'remote' | 'cache' | 'bundled'
export type TwilightPluginIndexCacheFormat = 'envelope-v1' | 'legacy'
export type TwilightPluginSignatureStatus =
  | 'missing'
  | 'malformed'
  | 'unsupported'
  | 'unknown-key'
  | 'revoked-key'
  | 'key-not-yet-valid'
  | 'key-expired'
  | 'invalid-key'
  | 'invalid'
  | 'valid'
  | 'trust-store-error'
export type TwilightPluginVerificationLevel =
  | 'official'
  | 'publisher-signed'
  | 'index-declared'
  | 'unverified'
export type TwilightMediaProviderCapability =
  | 'search'
  | 'playbackUrl'
  | 'lyrics'
  | 'cover'
  | 'playlist'
  | 'library'
  | 'login'
export type TwilightMediaProviderMethod =
  | 'getPlaybackUrl'
  | 'getLyrics'
  | 'searchSongs'
  | 'searchPlaylists'
  | 'searchArtists'
  | 'fetchPlaylistTracks'
  | 'checkLogin'
  | 'getProfile'
  | 'logout'
  | 'openOfficialLogin'
  | 'sendCaptcha'
  | 'loginByPhonePassword'
  | 'loginByPhoneCaptcha'
  | 'loginByEmailPassword'
  | 'getQrLogin'
  | 'getQrKey'
  | 'getQrImage'
  | 'checkQrLogin'
  | 'fetchUserLibrary'
  | 'fetchLikedTracks'
  | 'fetchLikedTracksPage'
  | 'fetchCloudSongsPage'
  | 'prepareCloudUpload'
  | 'completeCloudUpload'
  | 'getCloudDownloadUrl'
  | 'fetchRecommendSongs'
  | 'fetchRecommendPlaylists'
  | 'fetchPlaylistCategories'
  | 'fetchDiscoveryPlaylists'
  | 'fetchHighQualityPlaylists'
  | 'fetchPersonalFm'
  | 'fetchPrivateContent'
  | 'fetchArtistTopSongs'
  | 'fetchArtistAlbums'
  | 'fetchArtistIntro'
  | 'fetchArtistFollowState'
  | 'fetchAlbumTracks'
  | 'fetchArtistPlaylists'
  | 'fetchUserPlaylistsByUid'
  | 'fetchUserFollows'
  | 'fetchUserFolloweds'
  | 'fetchPlayRecords'
  | 'fetchRecentSongs'
  | 'followArtist'
  | 'followUser'
  | 'likeTrack'
  | 'isTrackLiked'
  | 'createPlaylist'
  | 'deletePlaylist'
  | 'addTracksToPlaylist'
  | 'removeTracksFromPlaylist'

export interface TwilightProviderStreamingSection {
  id: string
  title: string
  icon: string
  method: string
  args?: unknown[]
}

export interface TwilightProviderUiMetadata {
  icon: string
  color?: string
  description?: string
  authType: 'qr' | 'oauth' | 'cookie'
  loginInstructions?: string
  qrStatusCodes?: {
    waiting: number
    scanned: number | null
    expired: number
    denied?: number
    success: number
  }
  showBrowserButton?: boolean
  loginExtraActions?: Array<{
    label: string
    icon: string
    method: string
  }>
  streamingSections?: TwilightProviderStreamingSection[]
  streamingLibraryTab?: boolean
  streamingSearch?: boolean
  unifiedLibrary?: boolean
}
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

export interface ConvolverInfo {
  loaded: boolean
  active: boolean
  bypassed: boolean
  irResampled: boolean
  path: string
  sampleRate: number
  channels: number
  lengthFrames: number
  lengthMs: number
  partitionSize: number
  latencyFrames: number
  overrunCount: number
  lastProcessMs: number
  maxProcessMs: number
  channelMappingMode: string
  warning: string
  lastError: string
}

export interface NativeAudioMetadata {
  source: string
  title: string
  artist: string
  album: string
  albumArtist: string
  composer: string
  year: string
  genre: string
  trackNumber: string
  discNumber: string
  comment: string
  codec: string
  container: string
  channelLayout: string
  sampleRate: number
  channelCount: number
  bitDepth: number
  bitrate: number
  duration: number
  playable?: boolean
  reasonCode?: string
  isDsd: boolean
  dsdMode: string
  dsdRate: number
  outputModes?: string[]
  coverMime: string
  coverDataBase64: string
  replayGainTrackGain: number | null
  replayGainAlbumGain: number | null
  r128TrackGain: number | null
  r128AlbumGain: number | null
  error: string
  isoTracks?: NativeAudioMetadata[]
}

export interface VisualizationOptions {
  spectrumPoints?: number
  waveformPoints?: number
  spectrogramFrames?: number
  oscilloscopePoints?: number
  visualizerBarCount?: number
}

export interface VisualizationData {
  spectrum: number[]
  visualizerBars?: number[]
  waveform: number[]
  oscilloscope: number[]
  peakDb: number
  rmsDb: number
  lufsMomentary: number | null
  spectrogram: number[][]
  sampleRate: number
  maxFrequency: number
  active: boolean
  tapStatus: VisualizationTapStatus
  reason: string
}

export type VisualizationTapStatus =
  | 'active'
  | 'stopped'
  | 'disabled'
  | 'no-samples'
  | 'native-unavailable'
  | 'synthetic-fallback'

export interface TrackData {
  id: string
  title: string
  artist: string
  album: string
  filePath: string
  fileName: string
  dir?: string
  subTrack?: string
  /** Logical source segment for a single-file CUE track. */
  cueRange?: import('../shared/cue.ts').CueRange
  cueSheetPath?: string
  cueEncoding?: import('../shared/cue.ts').ParsedCueSheet['encoding']
  duration: number
  size: number
  cover: string | null
  lyrics: string | null
  translatedLyrics?: string | null
  metadataMatch?: TrackMetadataMatch | null
  source?: TrackSource
  ncmSongId?: number
  streamUrl?: string | null
  streamQuality?: NcmPlaybackQuality
  format?: string
  sampleRate?: number
  bitrate?: number
  bitDepth?: number
  bpm?: number
  bpmAnalysis?: BpmAnalysisResult
  discNumber?: number
  trackNumber?: number
  replayGainTrackGainDb?: number
  replayGainAlbumGainDb?: number
  replayGainTrackPeak?: number
  replayGainAlbumPeak?: number
  r128TrackGainDb?: number
  r128AlbumGainDb?: number
}

export interface AudioEngineQueueItem {
  id: string
  source: string
  title?: string
  artist?: string
  album?: string
  duration?: number
  codec?: string
  sampleRate?: number
  bitrate?: number
  bitDepth?: number
  measuredIntegratedLufs?: number
  measuredTruePeakDb?: number
  replayGainTrackGainDb?: number
  replayGainAlbumGainDb?: number
  replayGainTrackPeak?: number
  replayGainAlbumPeak?: number
  r128TrackGainDb?: number
  r128AlbumGainDb?: number
  /** Explicit range in source seconds for one logical CUE track. */
  cueRange?: import('../shared/cue.ts').CueRange
}

export interface PlaybackSession {
  version: 1
  savedAt: string
  mode: PlaybackResumeMode
  playMode?: PlayMode
  track: TrackData
  position: number
  queue?: TrackData[]
  queueIndex?: number
  sleepTimer?: import('../shared/sleepTimer.ts').SleepTimerState
}

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
  miniPlayer: import('../shared/miniPlayer.ts').MiniPlayerSettings
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

export interface OpraCatalogStatus {
  loaded: boolean
  loading: boolean
  source: 'empty' | 'cache' | 'network'
  cachePath: string
  vendorCount: number
  productCount: number
  profileCount: number
  lastUpdatedAt: string | null
  lastError: string
}

export interface OpraProfile {
  eqId: string
  productId: string
  productName: string
  vendorName: string
  author: string
  details: string
  link: string
  attributionUrl: string
  preampDb: number
  bands: EqualizerBand[]
  applicable: boolean
  unsupportedBandTypes: string[]
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

export interface TwilightPluginDescriptor {
  id: string
  name: string
  version: string
  description: string
  author: string
  license: string
  type: TwilightPluginType[]
  main?: string
  binary?: Record<string, string>
  dependencies?: Record<string, string>
  engines: {
    twilightEcho: string
  }
  apiVersion: number
  permissions: string[]
  status: TwilightPluginStatus
  enabled: boolean
  builtIn: boolean
  error: string | null
  isDsp: boolean
  source: 'directory' | 'tep' | 'bundled' | 'index' | 'scan'
  installedAt: string | null
  updatedAt: string | null
  paths: {
    root: string
    versionRoot: string
    manifestPath: string
    dataDir: string
    logPath: string
  }
}

export interface TwilightPluginInstallResult {
  plugin: TwilightPluginDescriptor
  warning: string
}

export interface TwilightPluginPublisherSignature {
  schemaVersion: 1
  algorithm: 'ed25519'
  keyId: string
  value: string
}

export interface TwilightPluginVerification {
  level: TwilightPluginVerificationLevel
  official: boolean
  officialSource: boolean
  indexClaimed: boolean
  signatureStatus: TwilightPluginSignatureStatus
  keyId: string | null
  publisher: string | null
  keyFingerprintSha256: string | null
  revalidateAt: string | null
  reason: string
}

export interface TwilightPluginIndexEntry {
  id: string
  name: string
  version: string
  description: string
  author: string
  license: string
  type: TwilightPluginType[]
  main?: string
  binary?: Record<string, string>
  dependencies?: Record<string, string>
  engines: {
    twilightEcho: string
  }
  apiVersion: number
  permissions: string[]
  homepage?: string
  repository?: string
  icon?: string
  sourceUrl: string
  checksumSha256: string
  tags?: string[]
  publisherSignature?: TwilightPluginPublisherSignature
  /** Publisher/index metadata only. Never use this field as an official trust decision. */
  verified?: boolean
  verification: TwilightPluginVerification
  installState?: TwilightPluginIndexInstallState
  installedVersion?: string
}

export interface TwilightPluginIndexStatus {
  sourceUrl: string
  configuredSourceUrl: string
  sourceKind: TwilightPluginIndexSourceKind
  loadedFrom: TwilightPluginIndexLoadedFrom
  lastFetchedAt: string | null
  expiresAt: string | null
  loadedAt: string
  stale: boolean
  expired: boolean
  originVerified: boolean
  officialSource: boolean
  cacheFormat: TwilightPluginIndexCacheFormat | null
  trustStoreError: string | null
  error: string | null
}

export interface TwilightMediaProviderRegistration {
  id: string
  name: string
  capabilities: TwilightMediaProviderCapability[]
  ui?: TwilightProviderUiMetadata
  health?: TwilightMediaProviderHealth
}

export interface TwilightMediaProviderHealth {
  providerId: string
  pluginId: string
  pluginStatus: TwilightPluginStatus
  available: boolean
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  methodStats?: Partial<Record<TwilightMediaProviderMethod, TwilightMediaProviderMethodHealth>>
  lastError: string | null
  lastCheckedAt: string | null
}

export interface TwilightMediaProviderMethodHealth {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  lastError: string | null
  lastCheckedAt: string | null
}

export type TwilightUiContributionKind =
  | 'sidebarPage'
  | 'playerBarButton'
  | 'settingsPanel'
  | 'localSidebarItem'
  | 'streamingHome'

export interface TwilightUiContribution {
  id: string
  kind: TwilightUiContributionKind
  title: string
  description?: string
  icon?: string
  command?: string
  /** Legacy field normalized by the host to command-only rendering. */
  renderMode?: 'command'
  autoLoad?: boolean
}

export interface TwilightThemeContribution {
  id: string
  name: string
  description?: string
  variables?: Record<string, string>
  stylesheet?: string
  structured?: StructuredPluginTheme
  compatibilityNotes?: string[]
}

export interface TwilightPluginExtensionContribution {
  pluginId: string
  ui: TwilightUiContribution[]
  themes: TwilightThemeContribution[]
}

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

export interface LatencyInfo {
  bufferLatencyMs: number
  outputLatencyMs: number
  totalLatencyMs: number
}

export interface OutputDiagnostics {
  sessionUnderrunCount: number
  sessionBufferDropCount: number
  sessionRecoveryCount: number
  lifetimeUnderrunCount: number
  lifetimeBufferDropCount: number
  lifetimeRecoveryCount: number
  driverRestartCount: number
  deviceLostCount: number
  lastError: string
}

export interface AudioOutputOption {
  id: AudioOutputId
  label: string
  description: string
  platform: NodeJS.Platform
  supportsExclusive: boolean
}

export interface AudioOutputState {
  output: AudioOutputId
  device: string
  exclusiveMode: boolean
  exclusiveAvailable: boolean
  outputOptions: AudioOutputOption[]
  deviceOptions: AudioDeviceOption[]
}

export interface OutputInfo {
  exclusive: boolean
  supportsOutputPerfect: boolean
  sourceExact: boolean
  outputPerfect: boolean
  pcmPassthrough: boolean
  resampled: boolean
  perfectReason: string
  outputSampleRate: number
  outputBitDepth: number
  backend: string
  actualBackend: string
  deviceName: string
  actualDeviceName: string
  driverName: string
  actualDriverName: string
  driverVersion: number
  actualDriverVersion: number
  actualOutputFormat: string
  actualSampleRate: number
  actualBitDepth: number
  actualChannels: number
  accessMode: string
  devicePathKind: string
  perfectReasonCode: string
  capabilityReason: string
  driverDopCapable: boolean
  driverNativeDsdCapable: boolean
  driverDopCarrierSampleRates: number[]
  driverDopCarrierFormats: string[]
  driverNativeDsdSampleRates: number[]
  nativeDsdRuntimeState: string
  nativeDsdRequestedRate: number
  nativeDsdActualRate: number
  nativeDsdChannels: number
  nativeDsdExplicitlyCapable: boolean
  nativeDsdAdvertisedSampleRates: number[]
  nativeDsdRuntimeReason: string
  bufferSizeFrames: number
  latencyFrames: number
  latencyMs: number
  latencyInfo: LatencyInfo
  channelRoutingMode: string
  diagnostics: OutputDiagnostics
  deviceRecovered: boolean
  recoveryCount: number
  nativeDsp?: { plugins: unknown[]; graph?: DspGraphStatus }
  isDsd: boolean
  dsdMode: string
  dsdRate: number
}

export type PlaybackOutputInfoMirror = Pick<
  OutputInfo,
  | 'actualBackend'
  | 'actualOutputFormat'
  | 'actualSampleRate'
  | 'actualBitDepth'
  | 'actualChannels'
  | 'bufferSizeFrames'
  | 'latencyFrames'
  | 'latencyMs'
  | 'latencyInfo'
  | 'channelRoutingMode'
  | 'supportsOutputPerfect'
  | 'sourceExact'
  | 'diagnostics'
  | 'deviceRecovered'
  | 'recoveryCount'
  | 'outputSampleRate'
  | 'outputBitDepth'
  | 'outputPerfect'
  | 'pcmPassthrough'
  | 'perfectReason'
  | 'perfectReasonCode'
  | 'isDsd'
  | 'dsdMode'
  | 'dsdRate'
> &
  Partial<Pick<OutputInfo, 'accessMode' | 'devicePathKind' | 'capabilityReason'>>

export interface PlaybackInfo extends PlaybackOutputInfoMirror {
  state: 'stopped' | 'playing' | 'paused'
  position: number
  duration: number
  volume: number
  /** Application-layer playback rate; 1 = realtime. */
  playbackRate?: number
  requestedConfigRevision: number
  appliedConfigRevision: number
  queueIndex: number
  playMode: PlayMode
  source: string
  codec: string
  bitrate: number
  sourceSampleRate: number
  sourceBitDepth: number
  decodedSampleRate: number
  decodedBitDepth: number
  decodedChannels: number
  decodedSampleFormat: string
  outputBackend: string
  outputDevice: string
  outputInfo: OutputInfo
  actualBackend: string
  driverName: string
  driverVersion: number
  actualOutputFormat: string
  actualSampleRate: number
  actualBitDepth: number
  actualChannels: number
  bufferSizeFrames: number
  latencyFrames: number
  latencyMs: number
  latencyInfo: LatencyInfo
  channelRoutingMode: string
  supportsOutputPerfect: boolean
  sourceExact: boolean
  diagnostics: OutputDiagnostics
  deviceRecovered: boolean
  recoveryCount: number
  outputSampleRate: number
  outputBitDepth: number
  channelCount: number
  outputPerfect: boolean
  pcmPassthrough: boolean
  dspActive: boolean
  replayGainActive: boolean
  eqActive: boolean
  convolverActive: boolean
  crossfeedActive: boolean
  crossfadeActive: boolean
  fftActive: boolean
  irResampled: boolean
  replayGainDb: number
  crossfeedStrength: number
  crossfadeSeconds: number
  convolverLatencyFrames: number
  partitionSize: number
  channelMappingMode: string
  perfectReason: string
  perfectReasonCode: string
  isDsd: boolean
  dsdMode: string
  dsdRate: number
  gaplessActive: boolean
  preloadReady: boolean
  /** Empty when unblocked; else disabled | dsd_path | typed_passthrough | crossfade | format_mismatch */
  gaplessBlockedReason: string
  upcomingTrack: AudioEngineQueueItem | null
}

export interface AudioEnginePlayResult {
  nativeStarted: boolean
  fallbackReason: string
}
