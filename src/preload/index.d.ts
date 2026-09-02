import type {
  AudioOutputId,
  PlayMode,
  VolumeNormalizationMode,
  LoudnormStatus,
  EqualizerBand,
  AudioProcessingSettings,
  AudioOutputOption,
  OutputConfig,
  OutputConfigApplyStatus,
  AudioOutputState,
  AudioEngineQueueItem,
  PlaybackInfo,
  AudioEnginePlayResult,
  VisualizationOptions,
  VisualizationData,
  ConvolverInfo,
  NativeAudioMetadata,
  BpmAnalysisResult,
  LoudnessAnalysisResult
} from '../shared/audioEngineTypes.ts'
import type { PlaybackResumeMode, AudioEqPreset, AppSettings } from '../shared/appSettings.ts'
import type {
  DesktopLyricsBootstrap,
  DesktopLyricsClockSnapshot,
  DesktopLyricsSession,
  DesktopLyricsSettingsV3,
  DesktopLyricsTransportAction
} from '../shared/desktopLyrics.ts'
import type { TrackData } from '../shared/track.ts'
import type {
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
import type { ImportedFrequencyResponse } from '../shared/frequencyResponse.ts'
import type { AppStartupSnapshot } from '../shared/appStartup.ts'
import type {
  ThemeAssetReference,
  ThemeAssetType,
  ThemeBootstrap,
  ThemeLibrarySnapshot,
  ThemeProfileV2,
  ThemeSelection,
  ThemeWindowInheritance
} from '../shared/theme.ts'
import type {
  LocalLibraryRemoveRequest,
  LocalLibraryRemoveResult,
  LocalLibraryResetResult,
  LocalLibraryRestoreRequest,
  LocalLibraryRestoreResult,
  LocalLibrarySnapshotInput,
  LocalMusicLibraryDocument
} from '../shared/localLibrary.ts'
import type {
  LocalLibraryTagRestoreRequest,
  LocalLibraryTagRestoreResult,
  LocalLibraryTagWriteRequest,
  LocalLibraryTagWriteResult
} from '../shared/localLibraryTags.ts'
import type {
  LocalLibraryScanProgress,
  LocalLibraryScanStatus,
  LocalLibraryScanUpdate
} from '../shared/localLibraryScan.ts'
import type { DuplicateDetectionReadApi } from '../shared/duplicateDetection.ts'
import type { LyricsManagementDocument } from '../shared/lyricsManagement.ts'
import type {
  NcmCloudDownloadRequest,
  NcmCloudDownloadResult,
  NcmCloudSelectedFile,
  NcmCloudTransferProgress,
  NcmCloudUploadResult
} from '../shared/ncmCloud.ts'

export {}

interface AudioEngineEvent {
  name: string
  data: unknown
}

type PlayerShortcutAction =
  | 'previous'
  | 'next'
  | 'playPause'
  | 'play'
  | 'pause'
  | 'toggleDesktopLyrics'
  | 'toggleDesktopLyricsLock'
  | { action: 'seek'; positionSeconds: number }
  | { action: 'setVolume'; volume: number }
  | { action: 'jumpQueue'; index: number }
interface PlayerShortcutStatus {
  accelerator: string
  action: PlayerShortcutAction
  label: string
  registered: boolean
  error: string | null
}

type LibraryChange =
  | { kind: 'add' | 'remove' | 'unknown'; path?: string }
  | { kind: 'scan'; update: LocalLibraryScanUpdate }

interface BpmAnalysisRequest {
  trackId: string
  filePath: string
  referenceBpm?: number
}
type BpmAnalysisRequestResult =
  | { status: 'completed'; analysis: BpmAnalysisResult }
  | { status: 'cached'; analysis: BpmAnalysisResult }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
interface BpmAnalysisCompletedEvent {
  trackId: string
  filePath: string
  analysis: BpmAnalysisResult
}

interface LoudnessAnalysisRequest {
  trackId: string
  filePath: string
  targetLufs?: number
  truePeakCeilingDb?: number
}
type LoudnessAnalysisRequestResult =
  | { status: 'completed'; analysis: LoudnessAnalysisResult }
  | { status: 'cached'; analysis: LoudnessAnalysisResult }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'unavailable'; reason: string }
interface LoudnessAnalysisCompletedEvent {
  trackId: string
  filePath: string
  analysis: LoudnessAnalysisResult
}

interface LoudnormStatusEvent {
  status: LoudnormStatus
  source: string | null
  reason?: string
  analysis?: LoudnessAnalysisResult
}
type TwilightPluginType = 'provider' | 'tool' | 'ui' | 'theme' | 'dsp'
type TwilightPluginStatus = 'installed' | 'enabled' | 'disabled' | 'invalid' | 'failed'
type TwilightPluginIndexInstallState =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'incompatible'
  | 'built-in-blocked'
type TwilightPluginIndexSourceKind = 'github' | 'custom' | 'bundled'
type TwilightPluginIndexLoadedFrom = 'remote' | 'cache' | 'bundled'
type TwilightPluginIndexCacheFormat = 'envelope-v1' | 'legacy'
type TwilightPluginSignatureStatus =
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
type TwilightPluginVerificationLevel =
  | 'official'
  | 'publisher-signed'
  | 'index-declared'
  | 'unverified'
type TwilightMediaProviderCapability =
  | 'search'
  | 'playbackUrl'
  | 'lyrics'
  | 'cover'
  | 'playlist'
  | 'library'
  | 'login'
  | 'download'
type TwilightMediaProviderMethod =
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
type ProviderDownloadQuality = 'aac' | 'lossless' | 'hi-res'
type ProviderDownloadTaskStatus =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'
interface ProviderDownloadTrackInput {
  id: string | number
  title: string
  artist: string
  album?: string
  cover?: string
  provider?: string
  [key: string]: unknown
}
interface ProviderDownloadCreateInput {
  providerId: string
  track: ProviderDownloadTrackInput
  quality: ProviderDownloadQuality
  targetRoot?: string
}
interface ProviderDownloadTaskSnapshot {
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

type MiniPlayerBackgroundKind = 'solid' | 'gradient' | 'cover' | 'image'
type MiniPlayerImageFit = 'cover' | 'contain'
type MiniPlayerLayoutPreference = 'auto' | 'compact' | 'standard' | 'wide'
type MotionPreference = 'system' | 'full' | 'reduced' | 'off'

interface MiniPlayerBackgroundSettings {
  kind: MiniPlayerBackgroundKind
  solidColor: string
  fallbackColor: string
  gradientStart: string
  gradientEnd: string
  gradientAngle: number
  imageUrl: string
  imageFit: MiniPlayerImageFit
  blur: number
  brightness: number
  saturation: number
  opacity: number
  overlayColor: string
  overlayOpacity: number
}

interface MiniPlayerAppearanceSettings {
  accentMode: 'track' | 'custom'
  accentColor: string
  textMode: 'auto' | 'custom'
  primaryTextColor: string
  mutedTextColor: string
  fontFamily: string
  surfaceOpacity: number
  glassBlur: number
  cornerRadius: number
  borderWidth: number
  borderColor: string
  shadowStrength: number
  shadowColor: string
}

interface MiniPlayerLayoutSettings {
  preference: MiniPlayerLayoutPreference
}

interface MiniPlayerVisibilitySettings {
  artwork: boolean
  album: boolean
  equalizer: boolean
  time: boolean
  volume: boolean
  playMode: boolean
  queuePosition: boolean
}

interface MiniPlayerThemeProfile {
  background: MiniPlayerBackgroundSettings
  appearance: MiniPlayerAppearanceSettings
  layout: MiniPlayerLayoutSettings
  visibility: MiniPlayerVisibilitySettings
}

interface MiniPlayerSettings {
  windowX: number
  windowY: number
  windowWidth: number
  windowHeight: number
  alwaysOnTop: boolean
  showInTaskbar: boolean
  positionLocked: boolean
  activeStyleId: string
  profiles: Record<string, MiniPlayerThemeProfile>
}

interface MiniPlayerTrackSnapshot {
  id: string
  title: string
  artist: string
  album: string
  cover: string | null
  format: string | null
  sampleRate: number | null
  bitDepth: number | null
  coverSource: string | null
}

interface MiniPlayerLyricLineSnapshot {
  time: number | null
  original: string
  translation: string | null
}

interface MiniPlayerStateSnapshot {
  track: MiniPlayerTrackSnapshot | null
  currentLyric: { original: string; translation: string | null } | null
  lyrics: MiniPlayerLyricLineSnapshot[]
  isPlaying: boolean
  isLoading: boolean
  currentTime: number
  duration: number
  volume: number
  playMode: PlayMode
  favoriteAvailable: boolean
  favoriteLiked: boolean
  favoriteLoading: boolean
  dominantColor: string
  queueIndex: number
  queueLength: number
}

type MiniPlayerCommand =
  | { type: 'toggle-play' }
  | { type: 'previous' }
  | { type: 'next' }
  | { type: 'cycle-play-mode' }
  | { type: 'set-play-mode'; value: PlayMode }
  | { type: 'toggle-favorite' }
  | { type: 'seek'; value: number }
  | { type: 'set-volume'; value: number }

type MiniPlayerSettingsPatch = Partial<
  Pick<
    MiniPlayerSettings,
    | 'alwaysOnTop'
    | 'showInTaskbar'
    | 'positionLocked'
    | 'activeStyleId'
    | 'profiles'
    | 'windowWidth'
    | 'windowHeight'
  >
>

interface MiniPlayerBootstrap {
  state: MiniPlayerStateSnapshot
  settings: MiniPlayerSettings
  motionPreference: MotionPreference
}

type TrayNavigationTarget = 'local' | 'streaming' | 'settings'

interface TrayPlayerBootstrap {
  state: MiniPlayerStateSnapshot
}

interface OpraCatalogStatus {
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

interface OpraProfile {
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

interface PlaybackSession {
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

interface VersionedDataEnvelope<T> {
  version: 2
  revision: number
  savedAt: string
  data: T
}

interface SettingsSnapshot extends AppSettings {
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

interface TwilightPluginDescriptor {
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

interface TwilightPluginInstallResult {
  plugin: TwilightPluginDescriptor
  warning: string
}

interface TwilightPluginPublisherSignature {
  schemaVersion: 1
  algorithm: 'ed25519'
  keyId: string
  value: string
}

interface TwilightPluginVerification {
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

interface TwilightPluginIndexEntry {
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

interface TwilightPluginIndexStatus {
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

interface TwilightProviderStreamingSection {
  id: string
  title: string
  icon: string
  method: string
  args?: unknown[]
}

interface TwilightProviderUiMetadata {
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

interface TwilightMediaProviderRegistration {
  id: string
  name: string
  capabilities: TwilightMediaProviderCapability[]
  supportedMethods?: TwilightMediaProviderMethod[]
  ui?: TwilightProviderUiMetadata
  health?: TwilightMediaProviderHealth
}

interface TwilightMediaProviderHealth {
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

interface TwilightMediaProviderMethodHealth {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  lastError: string | null
  lastCheckedAt: string | null
}

type TwilightUiContributionKind =
  | 'sidebarPage'
  | 'playerBarButton'
  | 'settingsPanel'
  | 'localSidebarItem'
  | 'streamingHome'

interface TwilightUiContribution {
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

interface TwilightThemeContribution {
  id: string
  name: string
  description?: string
  variables?: Record<string, string>
  stylesheet?: string
  structured?: import('../shared/theme.ts').StructuredPluginTheme
  compatibilityNotes?: string[]
}

interface TwilightPluginExtensionContribution {
  pluginId: string
  ui: TwilightUiContribution[]
  themes: TwilightThemeContribution[]
}

interface AudioEngineConfigAppliedEvent {
  requestedConfigRevision: number
  appliedConfigRevision: number
}

interface AudioEngineAPI {
  loadQueue: (items: AudioEngineQueueItem[], startIndex?: number) => Promise<void>
  play: (filePath: string, startTime?: number) => Promise<AudioEnginePlayResult>
  isHtmlAudioFallbackAllowed: () => Promise<boolean>
  togglePause: () => Promise<void>
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => Promise<void>
  setPlaybackRate: (rate: number) => Promise<void>
  /** Native A-B loop; end <= start clears. Returns false when native unavailable. */
  setLoopRange: (startSeconds: number, endSeconds: number) => Promise<boolean>
  stop: () => Promise<void>
  next: () => Promise<void>
  previous: () => Promise<void>
  setPlayMode: (mode: PlayMode) => Promise<void>
  getUpcomingTrack: () => Promise<AudioEngineQueueItem | null>
  setExclusiveMode: (enabled: boolean) => Promise<AudioOutputState>
  getExclusiveMode: () => Promise<boolean>
  setAudioOutput: (output: AudioOutputId, device?: string) => Promise<AudioOutputState>
  setAudioDevice: (device: string) => Promise<AudioOutputState>
  setOutputConfig: (config: OutputConfig) => Promise<OutputConfig>
  getOutputConfigApplyStatus: () => Promise<OutputConfigApplyStatus>
  getAudioOutput: () => Promise<AudioOutputId>
  getAudioOutputOptions: () => Promise<AudioOutputOption[]>
  getAudioOutputState: () => Promise<AudioOutputState>
  setAudioProcessing: (
    settings: Partial<AudioProcessingSettings>
  ) => Promise<AudioProcessingSettings>
  getAudioProcessing: () => Promise<AudioProcessingSettings>
  getDspSceneState: () => Promise<DspSceneState>
  setDspScenes: (scenes: DspScene[], pinnedSceneId?: string | null) => Promise<DspSceneState>
  setOutputStage: (partial: Partial<DspOutputStageConfig>) => Promise<DspSceneState>
  setStereoImage: (partial: Partial<DspStereoImageConfig>) => Promise<DspSceneState>
  applyDspScene: (sceneId: string | null, confirmDsdPcmFallback?: boolean) => Promise<DspSceneState>
  getDspGraphStatus: () => Promise<DspGraphStatus>
  getDspAssets: () => Promise<DspAsset[]>
  importDspAsset: (kind: DspAssetKind) => Promise<DspAsset | null>
  importDspCorrectionProfile: () => Promise<DspCorrectionImportResult | null>
  importFrequencyResponse: () => Promise<ImportedFrequencyResponse | null>
  getDspCorrectionProfile: (assetId: string) => Promise<DspCorrectionProfile>
  deleteDspAsset: (assetId: string) => Promise<DspAsset[]>
  exportDspProfile: (name?: string) => Promise<DspProfile | null>
  importDspProfile: () => Promise<{
    state: DspSceneState
    profile: DspProfile
    importedAssets: DspAsset[]
  } | null>
  getVst3Catalog: () => Promise<Vst3CatalogState>
  setVst3Enabled: (enabled: boolean) => Promise<Vst3CatalogState>
  selectVst3SearchPath: () => Promise<string | null>
  setVst3SearchPaths: (paths: string[]) => Promise<Vst3CatalogState>
  scanVst3Plugins: () => Promise<Vst3CatalogState>
  clearVst3Quarantine: (id: string) => Promise<Vst3CatalogState>
  selectImpulseResponse: () => Promise<string | null>
  loadImpulseResponse: (path: string) => Promise<ConvolverInfo>
  unloadImpulseResponse: () => Promise<ConvolverInfo>
  getConvolverInfo: () => Promise<ConvolverInfo>
  setEqBands: (settings: Partial<AudioProcessingSettings>) => Promise<AudioProcessingSettings>
  setEqPreset: (preset: AudioEqPreset) => Promise<AudioProcessingSettings>
  setCrossfeedStrength: (strength: number) => Promise<AudioProcessingSettings>
  setReplayGainMode: (
    mode: VolumeNormalizationMode,
    preamp?: number,
    fallback?: number,
    clip?: boolean
  ) => Promise<AudioProcessingSettings>
  getMetadata: (source: string) => Promise<NativeAudioMetadata | null>
  getPlaybackInfo: () => Promise<PlaybackInfo>
  exportDiagnostics: () => Promise<{ filePath: string | null }>
  getSpectrumData: (points?: number) => Promise<number[]>
  getVisualizationData: (options?: VisualizationOptions) => Promise<VisualizationData>

  onPropertyChange: (cb: (event: AudioEngineEvent) => void) => () => void
  onEndFile: (cb: (reason: string) => void) => () => void
  onStartFile: (cb: () => void) => () => void
  onReady: (cb: () => void) => () => void
  onError: (cb: (message: string) => void) => () => void
  onDisconnected: (cb: () => void) => () => void
  onPlaybackInfo: (cb: (info: PlaybackInfo) => void) => () => void
  onLoudnormStatus: (cb: (event: LoudnormStatusEvent) => void) => () => void
  onConfigApplied: (cb: (event: AudioEngineConfigAppliedEvent) => void) => () => void
  onDeviceOptionsChanged: (cb: (event: { reason: string }) => void) => () => void
  onServiceCrash: (cb: (event: { reason: string; fatal?: boolean }) => void) => () => void
  restartService: () => Promise<{ restarted: boolean; error: string }>
  onServiceReady: (
    cb: (event: {
      manualResumeRequired: boolean
      outputRouteSynced: boolean
      restoreErrors: string[]
    }) => void
  ) => () => void
}

interface OpraAPI {
  search: (query: string) => Promise<OpraProfile[]>
  getProfile: (eqId: string) => Promise<OpraProfile | null>
  refresh: () => Promise<OpraCatalogStatus>
  getStatus: () => Promise<OpraCatalogStatus>
}

interface WindowAPI {
  sleepTimer: {
    configure: (
      state: import('../shared/sleepTimer.ts').SleepTimerState
    ) => Promise<import('../shared/sleepTimer.ts').SleepTimerState | null>
    cancel: () => Promise<null>
    getState: () => Promise<import('../shared/sleepTimer.ts').SleepTimerState | null>
    boundary: (
      boundary: 'trackEnd' | 'queueEnd'
    ) => Promise<import('../shared/sleepTimer.ts').SleepTimerState | null>
    onState: (
      callback: (state: import('../shared/sleepTimer.ts').SleepTimerState | null) => void
    ) => () => void
    onTrigger: (
      callback: (state: import('../shared/sleepTimer.ts').SleepTimerState) => void
    ) => () => void
  }
  window: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
  }
  dialog: {
    openFolder: () => Promise<string | null>
  }
  shell: {
    showItemInFolder: (filePath: string) => Promise<void>
    openPath: (path: string) => Promise<string>
    openExternal: (url: string) => Promise<void>
  }
  discord: {
    getStatus: () => Promise<{
      enabled: boolean
      connected: boolean
      lastError: string | null
    }>
    updateActivity: (data: {
      title: string
      artist: string
      album?: string
      playing: boolean
      startTime?: number
    }) => Promise<void>
    clearActivity: () => Promise<void>
  }
  library: DuplicateDetectionReadApi & {
    removeTracks: (request: LocalLibraryRemoveRequest) => Promise<LocalLibraryRemoveResult>
    restoreExclusions: (request: LocalLibraryRestoreRequest) => Promise<LocalLibraryRestoreResult>
    reset: () => Promise<LocalLibraryResetResult>
    writeTags: (request: LocalLibraryTagWriteRequest) => Promise<LocalLibraryTagWriteResult>
    restoreTags: (request: LocalLibraryTagRestoreRequest) => Promise<LocalLibraryTagRestoreResult>
    scanStartup: () => Promise<LocalLibraryScanUpdate>
    scanFull: () => Promise<LocalLibraryScanUpdate>
    getScanStatus: () => Promise<LocalLibraryScanStatus>
    getWatcherStatus: () => Promise<
      import('../shared/localLibraryScan.ts').LibraryWatcherStatusSnapshot
    >
    pauseScan: () => Promise<boolean>
    resumeScan: () => Promise<boolean>
    cancelScan: () => Promise<boolean>
    onChanged: (cb: (change: LibraryChange | undefined) => void) => () => void
    onCoversMissing: (cb: (info: { dirtyCount: number }) => void) => () => void
    onScanProgress: (cb: (progress: LocalLibraryScanProgress) => void) => () => void
    onScanStatus: (cb: (status: LocalLibraryScanStatus) => void) => () => void
  }
  fs: {
    scanMusicFiles: (folderPath: string) => Promise<TrackData[]>
    readAudioFile: (filePath: string) => Promise<{ buffer: ArrayBuffer; mimeType: string }>
    getAudioFileUrl: (filePath: string) => Promise<string>
    isAudioFileAuthorized: (filePath: string) => Promise<boolean>
    areAudioFilesAuthorized: (filePaths: string[]) => Promise<boolean[]>
    onScanProgress: (cb: (progress: { current: number; total: number }) => void) => () => void
  }
  audioEngine: AudioEngineAPI
  bpmAnalysis: {
    request: (request: BpmAnalysisRequest) => Promise<BpmAnalysisRequestResult>
    getCacheSize: () => Promise<number>
    clearCache: () => Promise<number>
    cancel: (filePath?: string) => Promise<void>
    onCompleted: (cb: (event: BpmAnalysisCompletedEvent) => void) => () => void
  }
  loudnessAnalysis: {
    request: (request: LoudnessAnalysisRequest) => Promise<LoudnessAnalysisRequestResult>
    getCacheSize: () => Promise<number>
    clearCache: () => Promise<number>
    getStatus: () => Promise<{ status: string; source: string | null }>
    cancel: (filePath?: string) => Promise<void>
    onCompleted: (cb: (event: LoudnessAnalysisCompletedEvent) => void) => () => void
  }
  opra: OpraAPI
  app: {
    getStartupSnapshot: () => Promise<AppStartupSnapshot>
    consumePendingNavigation: () => Promise<TrayNavigationTarget | null>
    relaunch: () => Promise<void>
    checkForUpdates: () => Promise<import('../shared/appUpdate').AppUpdateCheckResult>
    downloadUpdate: () => Promise<import('../shared/appUpdate').AppUpdateDownloadResult>
    cancelUpdateDownload: () => Promise<boolean>
    installUpdate: () => Promise<import('../shared/appUpdate').AppUpdateInstallResult>
    onUpdateProgress: (
      cb: (progress: import('../shared/appUpdate').AppUpdateProgress) => void
    ) => () => void
    /**
     * Reject to report a failed close-time persistence transaction. The main
     * process keeps the window open and offers the user a retry path.
     */
    onSavePlaybackSession: (cb: () => Promise<void> | void) => () => void
    onNavigate: (cb: (target: TrayNavigationTarget) => void) => () => void
  }
  ncm: {
    getPort: () => Promise<number>
    request: (path: string, cookie?: string) => Promise<unknown>
    getCachedSong: (songId: number) => Promise<string | null>
    cacheSong: (songId: number, url: string, fileName?: string) => Promise<string | null>
  }
  ncmCloud: {
    chooseUploadFiles: () => Promise<NcmCloudSelectedFile[]>
    upload: (handle: string) => Promise<NcmCloudUploadResult>
    download: (request: NcmCloudDownloadRequest) => Promise<NcmCloudDownloadResult>
    cancel: (transferId: string) => Promise<boolean>
    onProgress: (callback: (progress: NcmCloudTransferProgress) => void) => () => void
  }
  radio: {
    loadStations: () => Promise<
      VersionedDataEnvelope<import('../shared/radioStations.ts').RadioStationsDocument>
    >
    saveStations: (
      document: import('../shared/radioStations.ts').RadioStationsDocument,
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<import('../shared/radioStations.ts').RadioStationsDocument>>
    importPlaylist: (payload: {
      text: string
      fileNameHint?: string
      allowInsecureHttp?: boolean
    }) => Promise<import('../shared/radioStations.ts').RadioStation[]>
    searchDirectory: (payload: { query: string; limit?: number; offset?: number }) => Promise<
      Array<{
        stationuuid: string
        name: string
        url: string
        urlResolved: string
        homepage?: string
        favicon?: string
        tags: string[]
        countryCode?: string
        bitrate?: number
        codec?: string
        votes?: number
      }>
    >
  }
  podcast: {
    loadSubscriptions: () => Promise<
      VersionedDataEnvelope<
        import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
      >
    >
    saveSubscriptions: (
      document: import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument,
      expectedRevision: number
    ) => Promise<
      VersionedDataEnvelope<
        import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
      >
    >
    subscribe: (feedUrl: string) => Promise<{
      subscription: import('../shared/podcastSubscriptions.ts').PodcastSubscription
      document: import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
      revision: number
    }>
    refresh: (subscriptionId: string) => Promise<{
      subscription: import('../shared/podcastSubscriptions.ts').PodcastSubscription
      document: import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
      revision: number
    }>
    refreshAll: () => Promise<
      import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
    >
  }
  data: {
    saveMusicLibrary: (data: LocalLibrarySnapshotInput) => Promise<LocalMusicLibraryDocument>
    loadMusicLibrary: () => Promise<LocalMusicLibraryDocument | unknown[]>
    getCover: (handle: string) => Promise<Uint8Array | string | null>
    cacheCover: (data: ArrayBuffer | Uint8Array) => Promise<string | null>
    grantRemoteCover: (source: string) => Promise<string>
    getLyrics: (dir: string, fileName: string, filePath?: string) => Promise<string | null>
    getAmlTtml: (songId: number) => Promise<string | null>
    importLyrics: () => Promise<string | null>
    saveLyrics: (contents: string) => Promise<string | null>
    searchOnlineLyrics: (query: {
      title: string
      artist: string
      album?: string
      durationSeconds?: number
    }) => Promise<{
      query: { title: string; artist: string; album?: string; durationSeconds?: number }
      candidates: Array<{
        id: number | string
        title: string
        artist: string
        album: string
        durationSeconds: number | null
        score: number
        syncedLyrics: string | null
        plainLyrics: string | null
        source: 'lrclib'
      }>
      best: {
        id: number | string
        title: string
        artist: string
        album: string
        durationSeconds: number | null
        score: number
        syncedLyrics: string | null
        plainLyrics: string | null
        source: 'lrclib'
      } | null
    }>
    saveLyricsManagement: (
      document: LyricsManagementDocument,
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<LyricsManagementDocument>>
    loadLyricsManagement: () => Promise<VersionedDataEnvelope<LyricsManagementDocument> | null>
    loadPlaybackBookmarks: () => Promise<VersionedDataEnvelope<
      import('../shared/playbackBookmarks.ts').PlaybackBookmarksDocument
    > | null>
    savePlaybackBookmarks: (
      document: import('../shared/playbackBookmarks.ts').PlaybackBookmarksDocument,
      expectedRevision: number
    ) => Promise<
      VersionedDataEnvelope<import('../shared/playbackBookmarks.ts').PlaybackBookmarksDocument>
    >
    savePlaybackSession: (
      session: PlaybackSession,
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<PlaybackSession>>
    loadPlaybackSession: () => Promise<VersionedDataEnvelope<PlaybackSession | null> | null>
    clearPlaybackSession: (
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<PlaybackSession | null>>
    savePlaylists: (
      playlists: unknown[],
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<unknown[]>>
    loadPlaylists: () => Promise<VersionedDataEnvelope<unknown[]> | null>
    saveCookie: (cookie: string) => Promise<void>
    loadCookie: () => Promise<string>
  }
  networkSources: {
    listProfiles: () => Promise<import('../shared/networkSources.ts').NetworkSourceProfileSummary[]>
    createProfile: (
      input: import('../shared/networkSources.ts').NetworkSourceProfileInput
    ) => Promise<import('../shared/networkSources.ts').NetworkSourceProfileSummary>
    updateProfile: (
      id: string,
      patch: Partial<import('../shared/networkSources.ts').NetworkSourceProfileInput>
    ) => Promise<import('../shared/networkSources.ts').NetworkSourceProfileSummary>
    deleteProfile: (id: string) => Promise<void>
    listDirectory: (
      profileId: string,
      remotePath: string
    ) => Promise<import('../shared/networkSources.ts').NetworkEntry[]>
    testConnection: (profileId: string) => Promise<{
      ok: boolean
      errorCode?: import('../shared/networkSources.ts').NetworkSourceErrorCode
    }>
    resolvePlayback: (
      profileId: string,
      entry: import('../shared/networkSources.ts').NetworkEntry
    ) => Promise<import('../shared/networkSources.ts').NetworkPlaybackPlan>
    scanDirectory: (
      profileId: string,
      remotePath: string
    ) => Promise<{ added: number; total: number }>
    listLibrary: (
      profileId: string,
      query?: string
    ) => Promise<import('../shared/networkSources.ts').NetworkEntry[]>
    removeLibraryEntry: (profileId: string, entryId: string) => Promise<void>
    enrichLibrary: (profileId: string) => Promise<{ enriched: number; failed: number }>
    cacheInfo: () => Promise<{ sizeBytes: number }>
    clearCache: () => Promise<{ ok: boolean }>
    searchLibrary: (query?: string) => Promise<
      Array<{
        profileId: string
        profileName: string
        entry: import('../shared/networkSources.ts').NetworkEntry
      }>
    >
    coverDataUrl: (profileId: string, entryId: string) => Promise<string | null>
  }
  remote: {
    getStatus: () => Promise<import('../shared/remoteControl.ts').RemoteControlStatus>
    setEnabled: (
      enabled: boolean
    ) => Promise<import('../shared/remoteControl.ts').RemoteControlStatus>
    rotatePin: () => Promise<{
      pin: string
      status: import('../shared/remoteControl.ts').RemoteControlStatus
    }>
    publishState: (
      snapshot: Partial<import('../shared/remoteControl.ts').RemotePlaybackSnapshot>
    ) => Promise<boolean>
    discoverDlna: () => Promise<import('../shared/remoteControl.ts').DlnaDeviceInfo[]>
    getDlnaDevices: () => Promise<import('../shared/remoteControl.ts').DlnaDeviceInfo[]>
    castToDevice: (payload: {
      usn: string
      /** Authorized local library / managed-cache path. Mutually exclusive with mediaUrl. */
      filePath?: string
      /** Direct http(s) stream URL (podcast / radio / provider). Mutually exclusive with filePath. */
      mediaUrl?: string
      contentType?: string
      title?: string
      artist?: string
      album?: string
      positionSeconds?: number
    }) => Promise<{ ok: true; usn: string; friendlyName: string; mediaUrl: string }>
    stopCast: () => Promise<{ ok: true }>
    getCastTarget: () => Promise<{ usn: string; friendlyName: string } | null>
    controlCast: (payload: {
      seek?: number
      volume?: number
      pause?: boolean
      play?: boolean
    }) => Promise<{ ok: boolean; reason?: string }>
  }
  settings: {
    get: () => Promise<SettingsSnapshot>
    update: (patch: Partial<AppSettings>) => Promise<SettingsSnapshot>
    chooseCacheFolder: () => Promise<string | null>
    chooseDownloadFolder: () => Promise<string | null>
    chooseBackgroundImage: () => Promise<string | null>
    importBackgroundImage: (fileName: string, data: ArrayBuffer) => Promise<string | null>
    exportBackup: () => Promise<string>
    importBackup: (json: string) => Promise<SettingsSnapshot>
    getCacheSize: () => Promise<number>
    clearCache: () => Promise<number>
    getShortcutStatuses: () => Promise<PlayerShortcutStatus[]>
    onChanged: (cb: (snapshot: SettingsSnapshot) => void) => () => void
    onPlayerShortcut: (cb: (action: PlayerShortcutAction) => void) => () => void
  }
  fonts: {
    listInstalled: () => Promise<string[]>
  }
  themes: {
    getSystemTone: () => Promise<ThemeTone>
    getBootstrap: () => Promise<ThemeBootstrap>
    list: () => Promise<ThemeLibrarySnapshot>
    save: (profile: ThemeProfileV2, expectedRevision: number) => Promise<ThemeLibrarySnapshot>
    delete: (profileId: string, expectedRevision: number) => Promise<ThemeLibrarySnapshot>
    setActive: (
      selection: ThemeSelection,
      expectedRevision: number
    ) => Promise<ThemeLibrarySnapshot>
    setWindowInheritance: (
      inheritance: ThemeWindowInheritance,
      expectedRevision: number
    ) => Promise<ThemeLibrarySnapshot>
    importTheme: (expectedRevision: number) => Promise<ThemeLibrarySnapshot | null>
    exportTheme: (profileId: string) => Promise<string | null>
    importAsset: (profileId: string, type: ThemeAssetType) => Promise<ThemeAssetReference | null>
    validateAssets: (profileId: string, assets: ThemeAssetReference[]) => Promise<boolean>
    copyAssets: (sourceProfileId: string, targetProfileId: string) => Promise<void>
    onChanged: (cb: (snapshot: ThemeLibrarySnapshot) => void) => () => void
    onSystemToneChanged: (cb: (tone: ThemeTone) => void) => () => void
  }
  plugins: {
    list: () => Promise<TwilightPluginDescriptor[]>
    installFromPath: (path: string) => Promise<TwilightPluginInstallResult>
    chooseAndInstall: (
      kind?: 'package' | 'directory'
    ) => Promise<TwilightPluginInstallResult | null>
    enable: (id: string) => Promise<TwilightPluginDescriptor>
    disable: (id: string) => Promise<TwilightPluginDescriptor>
    uninstall: (id: string, options?: { removeData?: boolean }) => Promise<void>
    openLog: (id: string) => Promise<void>
    getLog: (id: string) => Promise<string>
    listIndex: () => Promise<TwilightPluginIndexEntry[]>
    refreshIndex: () => Promise<TwilightPluginIndexEntry[]>
    getIndexStatus: () => Promise<TwilightPluginIndexStatus>
    installFromIndex: (id: string) => Promise<TwilightPluginInstallResult>
    setNativeDspParameters: (
      id: string,
      parameters: Record<string, number>
    ) => Promise<TwilightPluginDescriptor>
    onChanged: (cb: () => void) => () => void
  }
  providers: {
    list: () => Promise<TwilightMediaProviderRegistration[]>
    call: (
      providerId: string,
      method: TwilightMediaProviderMethod,
      args: unknown[],
      options?: { idempotencyKey?: string; requestId?: string }
    ) => Promise<unknown>
    cancel: (requestId: string) => void
  }
  providerDownloads: {
    list: () => Promise<ProviderDownloadTaskSnapshot[]>
    create: (input: ProviderDownloadCreateInput) => Promise<ProviderDownloadTaskSnapshot>
    cancel: (taskId: string) => Promise<void>
    retry: (taskId: string) => Promise<ProviderDownloadTaskSnapshot>
    onChanged: (cb: (tasks: ProviderDownloadTaskSnapshot[]) => void) => () => void
  }
  extensions: {
    list: () => Promise<TwilightPluginExtensionContribution[]>
    executeCommand: (command: string, args?: unknown[]) => Promise<unknown>
    readThemeStylesheet: (stylesheetPath: string) => Promise<string>
  }
  desktopLyrics: {
    setEnabled: (enabled: boolean) => Promise<boolean>
    publishSession: (session: DesktopLyricsSession) => void
    publishClock: (clock: DesktopLyricsClockSnapshot) => void
    onEnabledChanged: (cb: (enabled: boolean) => void) => () => void
    onResyncRequested: (cb: () => void) => () => void
    onLoadFailed: (cb: (payload: { code: number; description: string }) => void) => () => void
    bootstrap: () => Promise<DesktopLyricsBootstrap>
    updateQuickSettings: (
      patch: Partial<DesktopLyricsSettingsV3>
    ) => Promise<DesktopLyricsSettingsV3>
    setLocked: (locked: boolean) => Promise<DesktopLyricsSettingsV3>
    setInteractionActive: (active: boolean) => Promise<void>
    setPausedHidden: (hidden: boolean) => Promise<void>
    transport: (action: DesktopLyricsTransportAction) => void
    moveTo: (x: number, y: number) => void
    moveEnd: () => void
    ready: () => void
    close: () => void
    onSessionChanged: (cb: (session: DesktopLyricsSession) => void) => () => void
    onClockChanged: (cb: (clock: DesktopLyricsClockSnapshot) => void) => () => void
    onSettingsChanged: (cb: (settings: DesktopLyricsSettingsV3) => void) => () => void
    onFreezeClock: (cb: () => void) => () => void
    onHoverIntent: (cb: (pointerInside: boolean) => void) => () => void
  }
  miniPlayer: {
    open: () => Promise<MiniPlayerSettings>
    getBootstrap: () => Promise<MiniPlayerBootstrap>
    command: (command: MiniPlayerCommand) => void
    updateSettings: (patch: MiniPlayerSettingsPatch) => Promise<MiniPlayerSettings>
    chooseBackgroundImage: () => Promise<string | null>
    minimize: () => void
    returnToMain: () => void
    publishState: (state: MiniPlayerStateSnapshot) => void
    onState: (cb: (state: MiniPlayerStateSnapshot) => void) => () => void
    onSettings: (cb: (settings: MiniPlayerSettings) => void) => () => void
    onMotionPreference: (cb: (preference: MotionPreference) => void) => () => void
    onCommand: (cb: (command: MiniPlayerCommand) => void) => () => void
  }
  trayPlayer: {
    getBootstrap: () => Promise<TrayPlayerBootstrap>
    command: (command: MiniPlayerCommand) => void
    navigate: (target: TrayNavigationTarget) => void
    hide: () => void
    onState: (cb: (state: MiniPlayerStateSnapshot) => void) => () => void
  }
  debug: {
    appendNativeTrace: (message: string) => Promise<void>
  }
}

declare global {
  interface Window {
    api: WindowAPI
  }
}
