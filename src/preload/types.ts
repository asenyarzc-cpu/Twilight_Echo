import type {
  PlayMode,
  LoudnormStatus,
  EqualizerBand,
  PlaybackInfo,
  BpmAnalysisResult,
  LoudnessAnalysisResult
} from '../shared/audioEngineTypes.ts'
import type { PlaybackResumeMode, AppSettings } from '../shared/appSettings.ts'
import type { TrackData } from '../shared/track.ts'
export type { RemoteRendererRequest } from '../shared/remoteControl.ts'
export type {
  AudioOutputId,
  PlayMode,
  EqMode,
  VolumeNormalizationMode,
  ChannelRoutingMode,
  PcmToDsdMode,
  DsdOutputMode,
  SacdProgramMode,
  LoudnormStatus,
  EqualizerFilterType,
  EqualizerBand,
  AudioProcessingSettings,
  AudioOutputOption,
  AudioDeviceOption,
  AudioCapabilitySupportState,
  OutputConfig,
  OutputConfigApplyStatus,
  OutputConversionInfo,
  OutputConversionInfoSource,
  OutputDiagnostics,
  OutputProviderImplementation,
  LatencyInfo,
  AudioOutputState,
  AudioEngineQueueItem,
  PlaybackOutputInfoMirror,
  PlaybackInfo,
  OutputInfo,
  AudioEnginePlayResult,
  VisualizationOptions,
  VisualizationData,
  VisualizationTapStatus,
  ConvolverInfo,
  NativeAudioMetadata,
  BpmTempoSegment,
  BpmAnalysisResult,
  LoudnessAnalysisResult,
  HeadphoneCompensationSettings,
  DsdRouteSettings
} from '../shared/audioEngineTypes.ts'
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
  DesktopLyricsPalette,
  DesktopLyricsSettings,
  MusicCachePolicySettings,
  AudioEqPreset,
  GlobalShortcutSettings,
  AppSettings
} from '../shared/appSettings.ts'
export type {
  BuiltInTrackSource,
  TrackSource,
  MetadataMatchConfidence,
  TrackMetadataMatch,
  TrackData
} from '../shared/track.ts'
export type AudioEngineEventCallback = (event: { name: string; data: unknown }) => void
export type AudioEngineEndFileCallback = (reason: string) => void

import type { StructuredPluginTheme } from '../shared/theme.ts'

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
  LiquidGlassCoverage,
  LiquidGlassSettings,
  LiquidGlassTheme,
  SurfaceMaterial
} from '../shared/liquidGlass.ts'
export type { PlayerBarMode, PlayerBarPageMode, PlayerBarSettings } from '../shared/playerBar.ts'
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
  LyricSourcePreference,
  LyricSource
} from '../shared/lyricsManagement.ts'
export type {
  DesktopLyricsBootstrap,
  DesktopLyricsClockSnapshot,
  DesktopLyricsLine,
  DesktopLyricsSession,
  DesktopLyricsSettingsV3,
  DesktopLyricsTransportAction,
  DesktopLyricsWord
} from '../shared/desktopLyrics.ts'

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
export type AudioEngineServiceCrashCallback = (event: { reason: string; fatal?: boolean }) => void
export interface AudioEngineServiceReadyEvent {
  manualResumeRequired: boolean
  outputRouteSynced: boolean
  restoreErrors: string[]
}
export type AudioEngineServiceReadyCallback = (event: AudioEngineServiceReadyEvent) => void

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
export interface PlayerShortcutStatus {
  accelerator: string
  action: PlayerShortcutAction
  label: string
  registered: boolean
  error: string | null
}

export type {
  NcmCloudDownloadRequest,
  NcmCloudDownloadResult,
  NcmCloudSelectedFile,
  NcmCloudTransferProgress,
  NcmCloudUploadResult
} from '../shared/ncmCloud.ts'

export type LibraryChange =
  | { kind: 'add' | 'remove' | 'unknown'; path?: string }
  | { kind: 'scan'; update: import('../shared/localLibraryScan.ts').LocalLibraryScanUpdate }

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
  | 'download'
export type TwilightMediaProviderMethod =
  | 'getPlaybackUrl'
  | 'getLyrics'
  | 'searchSongs'
  | 'searchPlaylists'
  | 'searchArtists'
  | 'fetchPlaylistTracks'
  | 'createDownload'
  | 'getDownloadStatus'
  | 'getDownloadFile'
  | 'cancelDownload'
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
  | 'fetchIntelligenceList'
  | 'followArtist'
  | 'followUser'
  | 'likeTrack'
  | 'isTrackLiked'
  | 'createPlaylist'
  | 'deletePlaylist'
  | 'addTracksToPlaylist'
  | 'removeTracksFromPlaylist'

export type ProviderDownloadQuality = 'aac' | 'lossless' | 'hi-res'
export type ProviderDownloadTaskStatus =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ProviderDownloadTrackInput {
  id: string | number
  title: string
  artist: string
  album?: string
  cover?: string
  provider?: string
  [key: string]: unknown
}

export interface ProviderDownloadCreateInput {
  providerId: string
  track: ProviderDownloadTrackInput
  quality: ProviderDownloadQuality
  targetRoot?: string
}

export interface ProviderDownloadTaskSnapshot {
  id: string
  providerId: string
  providerJobId: string
  track: ProviderDownloadTrackInput
  requestedQuality: ProviderDownloadQuality
  actualQuality: ProviderDownloadQuality | null
  status: ProviderDownloadTaskStatus
  progress: number
  queuePosition: number | null
  targetPath: string | null
  fileSize: number | null
  error: string | null
  createdAt: string
  updatedAt: string
}

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
  authType: 'qr' | 'oauth' | 'cookie' | 'settings'
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
  windowTransparencySupported: boolean
  restartRequired: boolean
  restartReasons: string[]
}

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
  supportedMethods?: TwilightMediaProviderMethod[]
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
