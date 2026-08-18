import { IPC } from '../../shared/ipcChannels.ts'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'path'
import { runtime } from '../core/runtime'
import { sleepTimerService } from '../sleepTimer.ts'
import { registerNativeSleepTimerBoundaries } from './sleepTimerNativeBoundary.ts'
import {
  createSettingsSnapshot,
  normalizeAppSettings,
  normalizeOutputConfig,
  writeAppSettings
} from '../core/settings'
import { DEFAULT_SOFTWARE_VOLUME } from '../../shared/audioProcessingOptions.ts'
import {
  AudioEngineManager,
  normalizeAudioProcessingSettings,
  resolveProcessingMasterState,
  type AudioProcessingSettings,
  type AudioOutputId,
  type AudioEngineQueueItem,
  type PlayMode,
  type EqMode,
  type EqualizerBand
} from '../audioEngineManager'
import { normalizeDspScenes, type DspAssetKind } from '../../shared/dspGraph.ts'
import { normalizeCueRange } from '../../shared/cue.ts'
import { DspAssetLibrary } from '../dsp/dspAssetLibrary.ts'
import {
  importCorrectionProfileFile,
  parseCorrectionProfileFile
} from '../dsp/correctionProfile.ts'
import {
  collectDspAssetIds,
  createDspProfile,
  exportDspProfileArchive,
  importDspProfileArchive
} from '../dsp/dspProfileArchive.ts'
import { Vst3CatalogService } from '../dsp/vst3Catalog.ts'
import { rendererFallbackAllowed } from './nativeBinding.ts'
import { importFrequencyResponseFromDialog } from './importFrequencyResponse.ts'
import {
  AudioDiagnosticRecorder,
  collectDsdPcmBlockers,
  createPlaybackDiagnosticEvent,
  type AudioDiagnosticSnapshot
} from './audioDiagnostics.ts'
import {
  persistAudioOutputState,
  persistAudioOutputConfig,
  broadcastPlayerLifecycleEvents,
  getEffectiveAudioProcessing,
  persistAndApplyAudioProcessingState,
  persistDspSceneState
} from './state'
import {
  normalizeFiniteNumber,
  normalizeInteger,
  normalizeIpcArray,
  normalizeIpcString,
  normalizeOptionalIpcString
} from '../security/ipcValidation.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { remoteMediaGrants } from '../security/remoteMediaGrants.ts'
import {
  grantUserSelectedImpulseResponse,
  grantUserSelectedVst3SearchPath,
  registerManagedVst3SearchPaths,
  resolveAuthorizedAudioSource,
  resolveAuthorizedImpulseResponseFile,
  resolveAuthorizedVst3SearchPaths
} from '../security/localPaths.ts'

const MAX_AUDIO_QUEUE_ITEMS = 5000
const MAX_AUDIO_SOURCE_LENGTH = 8192
const MAX_AUDIO_DEVICE_LENGTH = 512
let audioDiagnosticRecorder: AudioDiagnosticRecorder | null = null
let lastAudioDiagnosticPlaybackSignature = ''

const SOFTWARE_VOLUME_PERSIST_DELAY_MS = 350
let softwareVolumePersistTimer: NodeJS.Timeout | null = null
let pendingSoftwareVolume: number | null = null

function persistSoftwareVolumeNow(): void {
  softwareVolumePersistTimer = null
  const next = pendingSoftwareVolume
  pendingSoftwareVolume = null
  if (typeof next !== 'number' || !Number.isFinite(next)) return
  const clamped = Math.min(1, Math.max(0, Math.round(next * 1000) / 1000))
  const saved =
    typeof runtime.appSettings.softwareVolume === 'number' &&
    Number.isFinite(runtime.appSettings.softwareVolume)
      ? Math.min(1, Math.max(0, runtime.appSettings.softwareVolume))
      : DEFAULT_SOFTWARE_VOLUME
  if (Math.abs(clamped - saved) < 0.0005) return
  runtime.appSettings = normalizeAppSettings({
    ...runtime.appSettings,
    softwareVolume: clamped
  })
  writeAppSettings(runtime.appSettings)
  runtime.mainWindow?.webContents.send(
    'settings:changed',
    createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  )
}

function scheduleSoftwareVolumePersist(volume: number): void {
  pendingSoftwareVolume = volume
  if (softwareVolumePersistTimer) clearTimeout(softwareVolumePersistTimer)
  softwareVolumePersistTimer = setTimeout(
    persistSoftwareVolumeNow,
    SOFTWARE_VOLUME_PERSIST_DELAY_MS
  )
}

function flushSoftwareVolumePersist(): void {
  if (softwareVolumePersistTimer) {
    clearTimeout(softwareVolumePersistTimer)
    persistSoftwareVolumeNow()
  }
}

const DSP_ASSET_KINDS: DspAssetKind[] = [
  'impulseResponse',
  'correctionProfile',
  'vst3Preset',
  'vst3State'
]

export function requireAudioEngine(): AudioEngineManager {
  if (!runtime.audioEngineManager) throw new Error('原生音频引擎尚未初始化')
  return runtime.audioEngineManager
}

function requireDspAssets(): DspAssetLibrary {
  if (!runtime.dspAssetLibrary) throw new Error('DSP 资料库尚未初始化')
  return runtime.dspAssetLibrary
}

function requireVst3Catalog(): Vst3CatalogService {
  if (!runtime.vst3Catalog) throw new Error('VST3 目录尚未初始化')
  return runtime.vst3Catalog
}

export function toQueueItem(raw: unknown): AudioEngineQueueItem | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const source =
    typeof item.source === 'string'
      ? item.source
      : typeof item.audioSource === 'string'
        ? item.audioSource
        : typeof item.playUrl === 'string'
          ? item.playUrl
          : typeof item.filePath === 'string'
            ? item.filePath
            : typeof item.streamUrl === 'string'
              ? item.streamUrl
              : ''
  if (!source) return null
  let normalizedSource: string
  try {
    normalizedSource = normalizeIpcString(source, 'queue item source', MAX_AUDIO_SOURCE_LENGTH)
  } catch {
    return null
  }
  const cueRange = item.cueRange === undefined ? undefined : normalizeCueRange(item.cueRange)
  if (cueRange === null) return null
  return {
    id: normalizeQueueText(item.id, normalizedSource) ?? normalizedSource,
    source: normalizedSource,
    title: normalizeQueueText(item.title),
    artist: normalizeQueueText(item.artist),
    album: normalizeQueueText(item.album),
    duration: Number.isFinite(item.duration) ? Number(item.duration) : undefined,
    codec:
      typeof item.format === 'string'
        ? item.format
        : typeof item.codec === 'string'
          ? item.codec
          : undefined,
    sampleRate: Number.isFinite(item.sampleRate) ? Number(item.sampleRate) : undefined,
    bitrate: Number.isFinite(item.bitrate) ? Number(item.bitrate) : undefined,
    bitDepth: Number.isFinite(item.bitDepth) ? Number(item.bitDepth) : undefined,
    measuredIntegratedLufs: Number.isFinite(item.measuredIntegratedLufs)
      ? Number(item.measuredIntegratedLufs)
      : undefined,
    measuredTruePeakDb: Number.isFinite(item.measuredTruePeakDb)
      ? Number(item.measuredTruePeakDb)
      : undefined,
    replayGainTrackGainDb: Number.isFinite(item.replayGainTrackGainDb)
      ? Number(item.replayGainTrackGainDb)
      : undefined,
    replayGainAlbumGainDb: Number.isFinite(item.replayGainAlbumGainDb)
      ? Number(item.replayGainAlbumGainDb)
      : undefined,
    replayGainTrackPeak: Number.isFinite(item.replayGainTrackPeak)
      ? Number(item.replayGainTrackPeak)
      : undefined,
    replayGainAlbumPeak: Number.isFinite(item.replayGainAlbumPeak)
      ? Number(item.replayGainAlbumPeak)
      : undefined,
    r128TrackGainDb: Number.isFinite(item.r128TrackGainDb)
      ? Number(item.r128TrackGainDb)
      : undefined,
    r128AlbumGainDb: Number.isFinite(item.r128AlbumGainDb)
      ? Number(item.r128AlbumGainDb)
      : undefined,
    cueRange
  }
}

async function authorizeAudioProcessingSettings(
  settings: Partial<AudioProcessingSettings>
): Promise<AudioProcessingSettings> {
  const normalized = normalizeAudioProcessingSettings(settings)
  if (normalized.convolverIrPath) {
    normalized.convolverIrPath = await resolveAuthorizedImpulseResponseFile(
      normalized.convolverIrPath
    )
  }
  return normalized
}

function normalizeQueueText(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback
  const normalized = value
    .replace(/[\0\r\n]/g, ' ')
    .trim()
    .slice(0, 512)
  return normalized || fallback
}

async function resolveAuthorizedPlaybackSource(source: string): Promise<string> {
  if (source.startsWith('twilight-media:')) {
    return remoteMediaGrants.resolve(source, 'audio').source
  }
  return await resolveAuthorizedAudioSource(source)
}

function normalizeDspAssetKind(value: unknown): DspAssetKind {
  if (typeof value === 'string' && DSP_ASSET_KINDS.includes(value as DspAssetKind)) {
    return value as DspAssetKind
  }
  throw new Error('DSP 资料类型无效')
}

function assetDialogOptions(kind: DspAssetKind): Electron.OpenDialogOptions {
  const filters: Record<DspAssetKind, Electron.FileFilter[]> = {
    impulseResponse: [{ name: 'Impulse Response', extensions: ['wav', 'flac', 'aiff', 'aif'] }],
    correctionProfile: [{ name: 'Correction Profile', extensions: ['txt', 'apo'] }],
    vst3Preset: [{ name: 'VST3 Preset', extensions: ['vstpreset'] }],
    vst3State: [{ name: 'VST3 State', extensions: ['vststate', 'bin'] }]
  }
  return {
    title: '导入 DSP 资料',
    properties: ['openFile'],
    filters: [...filters[kind], { name: 'All Files', extensions: ['*'] }]
  }
}

async function reconcileDspAssetReferences(): Promise<void> {
  await runtime.dspAssetLibrary?.reconcileReferences(
    collectDspAssetIds(runtime.appSettings.dspScenes)
  )
}

async function quarantineActiveVst3Nodes(reason: string): Promise<void> {
  const catalog = runtime.vst3Catalog
  if (!catalog) return
  const graph = runtime.audioEngineManager?.getDspSceneState().graph
  for (const node of graph?.nodes ?? []) {
    if (node.type !== 'vst3Plugin' || !node.vst3?.catalogId) continue
    await catalog.quarantine(node.vst3.catalogId, `音频服务崩溃后旁路：${reason}`)
  }
  // Persisted catalog status should be visible immediately. The manager's
  // synchronous recovery gate already prevents a restarted service from
  // launching these modules while this asynchronous work is in flight.
  runtime.audioEngineManager?.refreshDspGraph()
}

function initializeAudioDiagnostics(): AudioDiagnosticRecorder {
  const recorder = new AudioDiagnosticRecorder({
    directory: join(app.getPath('logs'), 'audio'),
    environment: {
      appName: app.getName(),
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      locale: app.getLocale(),
      processVersions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        modules: process.versions.modules
      }
    }
  })
  recorder.record('session-start', {
    selectedOutput: {
      output: runtime.appSettings.audioOutput,
      device: runtime.appSettings.audioDevice,
      exclusiveMode: runtime.appSettings.audioExclusiveMode
    },
    outputConfig: runtime.appSettings.audioOutputConfig,
    configuredProcessing: runtime.appSettings.audioProcessing,
    effectiveProcessing: getEffectiveAudioProcessing(),
    headphoneCompensation: summarizeHeadphoneCompensation()
  })
  return recorder
}

function summarizeHeadphoneCompensation(): Record<string, unknown> {
  const compensation = runtime.appSettings.headphoneCompensation
  return {
    enabled: compensation.enabled,
    productId: compensation.productId,
    productName: compensation.productName,
    vendorName: compensation.vendorName,
    eqId: compensation.eqId,
    preampDb: compensation.preampDb,
    bandCount: compensation.bands.length
  }
}

function recordPlaybackDiagnostic(
  info: Awaited<ReturnType<AudioEngineManager['getPlaybackInfo']>>
): void {
  const engine = runtime.audioEngineManager
  const recorder = audioDiagnosticRecorder
  if (!engine || !recorder) return
  try {
    const details = createPlaybackDiagnosticEvent({
      playback: info,
      processing: getEffectiveAudioProcessing(),
      outputConfig: engine.getEffectiveOutputConfig(),
      sceneState: engine.getDspSceneState(),
      selectedOutput: {
        output: runtime.appSettings.audioOutput,
        device: runtime.appSettings.audioDevice,
        exclusiveMode: runtime.appSettings.audioExclusiveMode
      }
    })
    const signatureDetails = { ...details, position: 0 }
    const signature = JSON.stringify(signatureDetails)
    if (signature === lastAudioDiagnosticPlaybackSignature) return
    lastAudioDiagnosticPlaybackSignature = signature
    const warning = info.isDsd && info.dsdMode === 'pcm'
    recorder.record('playback-state', details, warning ? 'warning' : 'info')
  } catch (error) {
    recorder.record(
      'diagnostic-collection-failed',
      { phase: 'playback-state', message: error instanceof Error ? error.message : String(error) },
      'error'
    )
  }
}

async function captureAudioDiagnosticSnapshot(): Promise<AudioDiagnosticSnapshot> {
  const engine = await ensureAudioEngineRuntime()
  const configuredProcessing = runtime.appSettings.audioProcessing
  const effectiveProcessing = getEffectiveAudioProcessing()
  const outputConfig = engine.getOutputConfig()
  const effectiveOutputConfig = engine.getEffectiveOutputConfig()
  const dspSceneState = engine.getDspSceneState()
  const playback = await captureDiagnosticValue(() => engine.getPlaybackInfo())
  const outputState = await captureDiagnosticValue(() => engine.getAudioOutputState())
  const dspGraphStatus = await captureDiagnosticValue(() => engine.getDspGraphStatus())
  const diagnosis = isPlaybackInfo(playback)
    ? {
        dsdPcmFallback: playback.isDsd && playback.dsdMode === 'pcm',
        perfectReasonCode: playback.perfectReasonCode,
        perfectReason: playback.perfectReason,
        blockers: collectDsdPcmBlockers({
          playback,
          processing: effectiveProcessing,
          outputConfig: effectiveOutputConfig,
          sceneState: dspSceneState
        }),
        nativeDsdRuntimeState: playback.outputInfo.nativeDsdRuntimeState,
        nativeDsdRuntimeReason: playback.outputInfo.nativeDsdRuntimeReason,
        nativeDsdNegotiation: playback.outputInfo.diagnostics.nativeDsdNegotiation ?? '',
        dopRuntimeEvidence: playback.outputInfo.diagnostics.dopRuntimeEvidence ?? ''
      }
    : { unavailable: true }
  return {
    playback,
    outputState,
    outputConfig,
    effectiveOutputConfig,
    outputConfigApplyStatus: engine.getOutputConfigApplyStatus(),
    configuredProcessing,
    effectiveProcessing,
    engineProcessing: engine.getAudioProcessing(),
    headphoneCompensation: summarizeHeadphoneCompensation(),
    dspSceneState,
    dspGraphStatus,
    diagnosis
  }
}

async function captureDiagnosticValue<T>(
  read: () => T | Promise<T>
): Promise<T | { error: string }> {
  try {
    return await read()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function isPlaybackInfo(
  value: unknown
): value is Awaited<ReturnType<AudioEngineManager['getPlaybackInfo']>> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'outputInfo' in value &&
    'volume' in value &&
    'state' in value
  )
}

let audioEngineRuntimePromise: Promise<void> | null = null

/**
 * Handlers are registered before the engine runtime finishes initializing so
 * the renderer can never race an unregistered channel; calls that arrive
 * during the background init simply await this bridge.
 */
export function ensureAudioEngineRuntime(): Promise<AudioEngineManager> {
  if (audioEngineRuntimePromise) {
    return audioEngineRuntimePromise.then(() => requireAudioEngine())
  }
  if (runtime.audioEngineManager) return Promise.resolve(runtime.audioEngineManager)
  const initialization = initializeAudioEngineRuntime()
  audioEngineRuntimePromise = initialization
  void initialization.catch(() => {
    if (audioEngineRuntimePromise === initialization) audioEngineRuntimePromise = null
  })
  return initialization.then(() => requireAudioEngine())
}

async function initializeAudioEngineRuntime(): Promise<void> {
  app.on('before-quit', () => {
    flushSoftwareVolumePersist()
  })
  // A stale persisted directMode can silently bypass an enabled processing
  // module (for example EQ) after a restart. Reconcile the master switch once
  // at startup so the engine and the stored settings agree on what should run.
  const startupProcessing = normalizeAudioProcessingSettings(runtime.appSettings.audioProcessing)
  const startupMasterState = resolveProcessingMasterState(
    startupProcessing,
    undefined,
    startupProcessing.directMode
  )
  if (
    startupMasterState.dspEnabled !== startupProcessing.dspEnabled ||
    startupMasterState.directMode !== startupProcessing.directMode
  ) {
    runtime.appSettings = normalizeAppSettings({
      ...runtime.appSettings,
      audioProcessing: { ...startupProcessing, ...startupMasterState }
    })
    writeAppSettings(runtime.appSettings)
  }
  let initialAudioProcessing = getEffectiveAudioProcessing()
  try {
    initialAudioProcessing = await authorizeAudioProcessingSettings(initialAudioProcessing)
  } catch (error) {
    console.warn('Configured impulse response is unavailable or unauthorized:', error)
    initialAudioProcessing = normalizeAudioProcessingSettings({
      ...initialAudioProcessing,
      convolverEnabled: false,
      convolverIrPath: ''
    })
  }
  runtime.dspAssetLibrary = new DspAssetLibrary(join(app.getPath('userData'), 'dsp-assets'))
  await runtime.dspAssetLibrary.initialize()
  runtime.audioEngineManager = new AudioEngineManager(
    {
      exclusiveMode: runtime.appSettings.audioExclusiveMode,
      volume: runtime.appSettings.softwareVolume,
      audioOutput: runtime.appSettings.audioOutput,
      audioDevice: runtime.appSettings.audioDevice,
      audioOutputConfig: runtime.appSettings.audioOutputConfig,
      audioProcessing: initialAudioProcessing,
      dspScenes: runtime.appSettings.dspScenes,
      dspPinnedSceneId: runtime.appSettings.dspPinnedSceneId
    },
    {
      audioServiceEntry: join(__dirname, 'audioEngineService.js'),
      dspAssetPathResolver: (assetId) => runtime.dspAssetLibrary?.getKnownPath(assetId) ?? null,
      vst3StateAssetResolver: (assetId) =>
        runtime.dspAssetLibrary?.resolveVst3State(assetId) ?? {
          path: null,
          kind: null,
          reason: 'The DSP asset library is not initialized'
        },
      vst3ModuleResolver: (catalogId, classId) =>
        runtime.vst3Catalog?.resolveAvailableModule(catalogId, classId) ?? {
          modulePath: null,
          classId,
          reason: 'VST3 catalog is not initialized'
        }
    }
  )
  runtime.audioEngineManager.setLoudnessAnalysisManager(runtime.loudnessAnalysisManager)
  runtime.vst3Catalog = new Vst3CatalogService(join(app.getPath('userData'), 'dsp-vst3'), {
    scan: (modulePath) => requireAudioEngine().scanVst3Module(modulePath)
  })
  await runtime.vst3Catalog.initialize()
  await registerManagedVst3SearchPaths((await runtime.vst3Catalog.getState()).searchPaths)
  runtime.audioEngineManager.refreshDspGraph()
  await reconcileDspAssetReferences()
  audioDiagnosticRecorder = initializeAudioDiagnostics()
  lastAudioDiagnosticPlaybackSignature = ''

  runtime.audioEngineManager.on('property-change', ({ name, data }) => {
    runtime.mainWindow?.webContents.send(IPC.audioEngine.propertyChange, { name, data })
    void runtime.pluginManager?.broadcastEvent(`audioEngine:${name}`, data)
  })

  runtime.audioEngineManager.on('end-file', ({ reason }) => {
    audioDiagnosticRecorder?.record('end-file', { reason })
    runtime.mainWindow?.webContents.send(IPC.audioEngine.endFile, { reason })
    void runtime.pluginManager?.broadcastEvent(IPC.audioEngine.endFile, { reason })
  })

  registerNativeSleepTimerBoundaries(runtime.audioEngineManager, sleepTimerService)

  runtime.audioEngineManager.on('start-file', () => {
    audioDiagnosticRecorder?.record('start-file')
    runtime.mainWindow?.webContents.send(IPC.audioEngine.startFile)
    void runtime.pluginManager?.broadcastEvent(IPC.audioEngine.startFile, null)
  })

  runtime.audioEngineManager.on('queue-change', (queue) => {
    void runtime.pluginManager?.broadcastEvent('player:queue-change', { queue })
  })

  runtime.audioEngineManager.on('error', (err: Error) => {
    audioDiagnosticRecorder?.record('engine-error', { message: err.message }, 'error')
    console.error('[音频引擎]', err.message)
    runtime.mainWindow?.webContents.send(IPC.audioEngine.error, err.message)
  })

  runtime.audioEngineManager.on('audio-service-crash', ({ reason }) => {
    audioDiagnosticRecorder?.record('audio-service-crash', { reason }, 'error')
    console.error('[音频服务]', reason)
    runtime.mainWindow?.webContents.send(IPC.audioEngine.serviceCrash, { reason })
    runtime.mainWindow?.webContents.send(IPC.audioEngine.error, `音频服务已重启：${reason}`)
    void runtime.pluginManager?.handleNativeDspHostCrash(reason)
    void quarantineActiveVst3Nodes(reason)
  })

  runtime.audioEngineManager.on('audio-service-ready', (event) => {
    audioDiagnosticRecorder?.record('audio-service-ready', event)
    runtime.mainWindow?.webContents.send(IPC.audioEngine.serviceReady, event)
    void runtime.pluginManager?.broadcastEvent(IPC.audioEngine.serviceReady, event)
  })

  runtime.audioEngineManager.on('audio-service-stderr', ({ message }) => {
    audioDiagnosticRecorder?.record('audio-service-stderr', { message }, 'warning')
  })

  runtime.audioEngineManager.on('audio-service-stdout', ({ message }) => {
    audioDiagnosticRecorder?.record('audio-service-stdout', { message })
  })

  runtime.audioEngineManager.on('audio-device-options-changed', ({ reason }) => {
    audioDiagnosticRecorder?.record('device-options-changed', { reason })
    runtime.mainWindow?.webContents.send(IPC.audioEngine.deviceOptionsChanged, { reason })
  })

  runtime.audioEngineManager.on('ready', () => {
    audioDiagnosticRecorder?.record('engine-ready')
    runtime.mainWindow?.webContents.send(IPC.audioEngine.ready)
    void runtime.pluginManager?.broadcastEvent(IPC.audioEngine.ready, null)
  })

  runtime.audioEngineManager.on('playback-info', (info) => {
    recordPlaybackDiagnostic(info)
    runtime.mainWindow?.webContents.send(IPC.audioEngine.playbackInfo, info)
    void runtime.pluginManager?.broadcastEvent('player:playback-info', info)
    broadcastPlayerLifecycleEvents(info)
  })

  runtime.audioEngineManager.on('config-applied', (event) => {
    audioDiagnosticRecorder?.record('output-config-applied', event)
    runtime.mainWindow?.webContents.send(IPC.audioEngine.configApplied, event)
  })

  runtime.audioEngineManager.on('loudnorm-status', (event) => {
    audioDiagnosticRecorder?.record('loudnorm-status', event)
    runtime.mainWindow?.webContents.send(IPC.audioEngine.loudnormStatus, event)
  })

  await runtime.audioEngineManager.start().catch((err: Error) => {
    console.error('原生音频引擎启动失败：', err.message)
  })
}

export function setupAudioEngineIpc(): void {
  registerAudioEngineIpcHandlers()
}

function registerAudioEngineIpcHandlers(): void {
  ipcMain.handle(IPC.audioEngine.loadQueue, async (_event, items: unknown, startIndex?: number) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    if (!Array.isArray(items) || items.length > MAX_AUDIO_QUEUE_ITEMS) {
      throw new Error('Audio queue is invalid or too large')
    }
    const queue = normalizeIpcArray(items, 'audio queue', MAX_AUDIO_QUEUE_ITEMS, toQueueItem)
    if (queue.length !== items.length) {
      throw new Error('Audio queue contains an invalid item')
    }
    const authorizedQueue = await Promise.all(
      queue.map(async (item) => ({
        ...item,
        source: await resolveAuthorizedPlaybackSource(item.source)
      }))
    )
    const normalizedStartIndex = normalizeInteger(
      startIndex,
      'queue start index',
      0,
      0,
      Math.max(0, authorizedQueue.length - 1)
    )
    ;(await ensureAudioEngineRuntime()).loadQueue(authorizedQueue, normalizedStartIndex)
  })

  ipcMain.handle(IPC.audioEngine.play, async (_event, source: string, startTime?: number) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    const authorizedSource = await resolveAuthorizedPlaybackSource(
      normalizeIpcString(source, 'audio source', MAX_AUDIO_SOURCE_LENGTH)
    )
    const normalizedStartTime = normalizeFiniteNumber(
      startTime,
      'start time',
      0,
      0,
      Number.MAX_SAFE_INTEGER
    )
    audioDiagnosticRecorder?.record('play-requested', {
      source: authorizedSource,
      startTime: normalizedStartTime
    })
    try {
      const result = await (
        await ensureAudioEngineRuntime()
      ).play(authorizedSource, normalizedStartTime)
      audioDiagnosticRecorder?.record(
        'play-result',
        result,
        result.nativeStarted ? 'info' : 'warning'
      )
      return result
    } catch (error) {
      audioDiagnosticRecorder?.record(
        'play-failed',
        { message: error instanceof Error ? error.message : String(error) },
        'error'
      )
      throw error
    }
  })

  ipcMain.handle(IPC.audioEngine.isHtmlAudioFallbackAllowed, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return rendererFallbackAllowed()
  })

  ipcMain.handle(IPC.audioEngine.togglePause, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    ;(await ensureAudioEngineRuntime()).togglePause()
  })

  ipcMain.handle(IPC.audioEngine.seek, async (_event, time: number) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    ;(await ensureAudioEngineRuntime()).seek(
      normalizeFiniteNumber(time, 'seek time', 0, 0, Number.MAX_SAFE_INTEGER)
    )
  })

  ipcMain.handle(IPC.audioEngine.setVolume, async (_event, volume: number) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    const normalizedVolume = normalizeFiniteNumber(volume, 'volume', 1, 0, 1)
    ;(await ensureAudioEngineRuntime()).setVolume(normalizedVolume)
    // The renderer's debounced persistence depends on a setTimeout in the
    // window that drove the change. When that window is hidden (mini-player
    // mode) Chromium throttles or suspends the timer, so the last volume was
    // never written to disk. Persist here in the main process, which is never
    // throttled, so the value survives a restart regardless of window state.
    scheduleSoftwareVolumePersist(normalizedVolume)
    audioDiagnosticRecorder?.record('volume-changed', {
      volume: normalizedVolume,
      unity: Math.abs(normalizedVolume - 1) <= 0.001
    })
  })

  ipcMain.handle(IPC.audioEngine.setPlaybackRate, async (_event, rate: number) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    const normalizedRate = normalizeFiniteNumber(rate, 'playback rate', 1, 0.5, 2)
    ;(await ensureAudioEngineRuntime()).setPlaybackRate(normalizedRate)
    audioDiagnosticRecorder?.record('playback-rate-changed', { playbackRate: normalizedRate })
  })

  ipcMain.handle(
    IPC.audioEngine.setLoopRange,
    async (_event, startSeconds: unknown, endSeconds: unknown) => {
      assertTrustedIpcSender(_event, 'audio engine IPC')
      const start =
        typeof startSeconds === 'number' && Number.isFinite(startSeconds) ? startSeconds : -1
      const end = typeof endSeconds === 'number' && Number.isFinite(endSeconds) ? endSeconds : -1
      return await (await ensureAudioEngineRuntime()).setLoopRange(start, end)
    }
  )

  ipcMain.handle(IPC.audioEngine.stop, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    ;(await ensureAudioEngineRuntime()).stop()
  })

  ipcMain.handle(IPC.audioEngine.next, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    ;(await ensureAudioEngineRuntime()).next()
  })

  ipcMain.handle(IPC.audioEngine.previous, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    ;(await ensureAudioEngineRuntime()).previous()
  })

  ipcMain.handle(IPC.audioEngine.setPlayMode, async (_event, mode: PlayMode) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    ;(await ensureAudioEngineRuntime()).setPlayMode(
      mode === 'repeat' || mode === 'shuffle' ? mode : 'sequential'
    )
  })

  ipcMain.handle(IPC.audioEngine.getUpcomingTrack, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getUpcomingTrack()
  })

  ipcMain.handle(IPC.audioEngine.setExclusiveMode, async (_event, enabled: boolean) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    const state = await (await ensureAudioEngineRuntime()).setExclusiveMode(enabled === true)
    persistAudioOutputState(state)
    audioDiagnosticRecorder?.record('exclusive-mode-changed', state)
    return state
  })

  ipcMain.handle(IPC.audioEngine.getExclusiveMode, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getExclusiveMode()
  })

  ipcMain.handle(
    IPC.audioEngine.setAudioOutput,
    async (_event, output: string, device?: string) => {
      assertTrustedIpcSender(_event, 'audio engine IPC')
      const state = await (
        await ensureAudioEngineRuntime()
      ).setAudioOutput(
        normalizeIpcString(output, 'audio output', 64) as AudioOutputId,
        normalizeOptionalIpcString(device, 'audio device', MAX_AUDIO_DEVICE_LENGTH)
      )
      persistAudioOutputState(state)
      audioDiagnosticRecorder?.record('audio-output-changed', state)
      return state
    }
  )

  ipcMain.handle(IPC.audioEngine.setAudioDevice, async (_event, device: string) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    const state = await (
      await ensureAudioEngineRuntime()
    ).setAudioDevice(normalizeIpcString(device, 'audio device', MAX_AUDIO_DEVICE_LENGTH))
    persistAudioOutputState(state)
    audioDiagnosticRecorder?.record('audio-device-changed', state)
    return state
  })

  ipcMain.handle(IPC.audioEngine.setOutputConfig, async (_event, config: unknown) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    const normalized = normalizeOutputConfig(config)
    const engine = await ensureAudioEngineRuntime()
    await engine.setOutputConfig(normalized)
    const applied = engine.getOutputConfig()
    persistAudioOutputConfig(applied)
    audioDiagnosticRecorder?.record('output-config-changed', {
      requested: normalized,
      applied,
      applyStatus: engine.getOutputConfigApplyStatus()
    })
    return applied
  })

  ipcMain.handle(IPC.audioEngine.getOutputConfigApplyStatus, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getOutputConfigApplyStatus()
  })

  ipcMain.handle(IPC.audioEngine.getAudioOutput, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getAudioOutput()
  })

  ipcMain.handle(IPC.audioEngine.getAudioOutputOptions, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getAudioOutputOptions()
  })

  ipcMain.handle(IPC.audioEngine.getAudioOutputState, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getAudioOutputState()
  })

  ipcMain.handle(
    IPC.audioEngine.setAudioProcessing,
    async (_event, settings: Partial<AudioProcessingSettings>) => {
      assertTrustedIpcSender(_event, 'audio engine IPC')
      const merged = normalizeAudioProcessingSettings({
        ...runtime.appSettings.audioProcessing,
        ...settings
      })
      const { dspEnabled, directMode } = resolveProcessingMasterState(
        merged,
        settings.dspEnabled,
        settings.directMode
      )
      const normalized = await authorizeAudioProcessingSettings({
        ...runtime.appSettings.audioProcessing,
        ...settings,
        dspEnabled,
        directMode
      })
      await persistAndApplyAudioProcessingState(normalized)
      audioDiagnosticRecorder?.record('audio-processing-changed', {
        configured: runtime.appSettings.audioProcessing,
        effective: getEffectiveAudioProcessing(),
        headphoneCompensation: summarizeHeadphoneCompensation()
      })
      return runtime.appSettings.audioProcessing
    }
  )

  ipcMain.handle(IPC.audioEngine.getAudioProcessing, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return runtime.appSettings.audioProcessing
  })

  ipcMain.handle(IPC.audioEngine.getDspSceneState, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getDspSceneState()
  })

  ipcMain.handle(
    IPC.audioEngine.setDspScenes,
    async (event, scenes: unknown, pinnedSceneId?: unknown) => {
      assertTrustedIpcSender(event, 'audio engine IPC')
      const normalizedScenes = normalizeDspScenes(scenes, runtime.appSettings.audioProcessing)
      const normalizedPin =
        typeof pinnedSceneId === 'string' &&
        normalizedScenes.some((scene) => scene.id === pinnedSceneId)
          ? pinnedSceneId
          : null
      const state = await (
        await ensureAudioEngineRuntime()
      ).setDspScenes(normalizedScenes, normalizedPin)
      persistDspSceneState(state)
      await reconcileDspAssetReferences()
      return state
    }
  )

  ipcMain.handle(IPC.audioEngine.setOutputStage, async (event, partial: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const raw =
      partial && typeof partial === 'object' && !Array.isArray(partial)
        ? (partial as Record<string, unknown>)
        : {}
    const state = await (await ensureAudioEngineRuntime()).setOutputStage(raw)
    persistDspSceneState(state)
    return state
  })

  ipcMain.handle(IPC.audioEngine.setStereoImage, async (event, partial: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const raw =
      partial && typeof partial === 'object' && !Array.isArray(partial)
        ? (partial as Record<string, unknown>)
        : {}
    const state = await (await ensureAudioEngineRuntime()).setStereoImage(raw)
    persistDspSceneState(state)
    return state
  })

  ipcMain.handle(
    IPC.audioEngine.applyDspScene,
    async (event, sceneId: unknown, confirmDsdPcmFallback?: unknown) => {
      assertTrustedIpcSender(event, 'audio engine IPC')
      const state = await (
        await ensureAudioEngineRuntime()
      ).applyDspScene(typeof sceneId === 'string' ? sceneId : null, confirmDsdPcmFallback === true)
      persistDspSceneState(state)
      await reconcileDspAssetReferences()
      return state
    }
  )

  ipcMain.handle(IPC.audioEngine.getDspGraphStatus, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getDspGraphStatus()
  })

  ipcMain.handle(IPC.audioEngine.getDspAssets, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    await ensureAudioEngineRuntime()
    return await requireDspAssets().list()
  })

  ipcMain.handle(IPC.audioEngine.importDspAsset, async (event, kind: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    await ensureAudioEngineRuntime()
    const assetKind = normalizeDspAssetKind(kind)
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, assetDialogOptions(assetKind))
      : await dialog.showOpenDialog(assetDialogOptions(assetKind))
    if (result.canceled || result.filePaths.length === 0) return null
    if (assetKind === 'correctionProfile') {
      return (await importCorrectionProfileFile(result.filePaths[0], requireDspAssets())).asset
    }
    return await requireDspAssets().importFile({ kind: assetKind, sourcePath: result.filePaths[0] })
  })

  ipcMain.handle(IPC.audioEngine.importDspCorrectionProfile, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    await ensureAudioEngineRuntime()
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options = assetDialogOptions('correctionProfile')
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return await importCorrectionProfileFile(result.filePaths[0], requireDspAssets())
  })

  ipcMain.handle(IPC.audioEngine.importFrequencyResponse, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.OpenDialogOptions = {
      title: '导入 AutoEq 耳机频响 CSV',
      properties: ['openFile'],
      filters: [{ name: 'AutoEq CSV', extensions: ['csv'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return await importFrequencyResponseFromDialog(
      result,
      async (filePath) => await readFile(filePath, 'utf-8'),
      async (filePath) => (await stat(filePath)).size
    )
  })

  ipcMain.handle(IPC.audioEngine.getDspCorrectionProfile, async (event, assetId: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    await ensureAudioEngineRuntime()
    const id = normalizeIpcString(assetId, 'DSP correction asset id', 160)
    if (!/^correctionProfile:[a-f0-9]{64}$/.test(id)) {
      throw new Error('DSP 校正资料标识无效')
    }
    const assets = requireDspAssets()
    const asset = await assets.get(id)
    if (!asset || asset.kind !== 'correctionProfile') throw new Error('DSP 校正资料不存在')
    return await parseCorrectionProfileFile(await assets.getPath(id))
  })

  ipcMain.handle(IPC.audioEngine.deleteDspAsset, async (event, assetId: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    await ensureAudioEngineRuntime()
    const id = normalizeIpcString(assetId, 'DSP asset id', 160)
    if (!/^[a-zA-Z]+:[a-f0-9]{64}$/.test(id)) throw new Error('DSP 资料标识无效')
    await requireDspAssets().remove(id)
    return await requireDspAssets().list()
  })

  ipcMain.handle(IPC.audioEngine.exportDspProfile, async (event, name?: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    await ensureAudioEngineRuntime()
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: '导出 DSP 配置包',
          defaultPath: 'DSP Profile.tedsp',
          filters: [{ name: 'Twilight Echo DSP Profile', extensions: ['tedsp'] }]
        })
      : await dialog.showSaveDialog({
          title: '导出 DSP 配置包',
          defaultPath: 'DSP Profile.tedsp',
          filters: [{ name: 'Twilight Echo DSP Profile', extensions: ['tedsp'] }]
        })
    if (result.canceled || !result.filePath) return null
    const scenes = runtime.appSettings.dspScenes
    const profile = createDspProfile({
      name: typeof name === 'string' ? name : 'DSP Profile',
      scenes,
      pinnedSceneId: runtime.appSettings.dspPinnedSceneId,
      assetIds: collectDspAssetIds(scenes)
    })
    await exportDspProfileArchive({ outputPath: result.filePath, profile }, requireDspAssets())
    return profile
  })

  ipcMain.handle(IPC.audioEngine.importDspProfile, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    await ensureAudioEngineRuntime()
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '导入 DSP 配置包',
          properties: ['openFile'],
          filters: [{ name: 'Twilight Echo DSP Profile', extensions: ['tedsp'] }]
        })
      : await dialog.showOpenDialog({
          title: '导入 DSP 配置包',
          properties: ['openFile'],
          filters: [{ name: 'Twilight Echo DSP Profile', extensions: ['tedsp'] }]
        })
    if (result.canceled || result.filePaths.length === 0) return null
    const imported = await importDspProfileArchive(result.filePaths[0], requireDspAssets())
    const scenes = normalizeDspScenes(imported.profile.scenes, runtime.appSettings.audioProcessing)
    const pinnedSceneId =
      typeof imported.profile.pinnedSceneId === 'string' &&
      scenes.some((scene) => scene.id === imported.profile.pinnedSceneId)
        ? imported.profile.pinnedSceneId
        : null
    const state = await (await ensureAudioEngineRuntime()).setDspScenes(scenes, pinnedSceneId)
    persistDspSceneState(state)
    await reconcileDspAssetReferences()
    return { state, profile: imported.profile, importedAssets: imported.importedAssets }
  })

  ipcMain.handle(IPC.audioEngine.getVst3Catalog, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    await ensureAudioEngineRuntime()
    return await requireVst3Catalog().getState()
  })

  ipcMain.handle(IPC.audioEngine.setVst3Enabled, async (event, enabled: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const engine = await ensureAudioEngineRuntime()
    const state = await requireVst3Catalog().setEnabled(enabled === true)
    engine.refreshDspGraph()
    return state
  })

  ipcMain.handle(IPC.audioEngine.selectVst3SearchPath, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择 VST3 搜索目录',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ title: '选择 VST3 搜索目录', properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return await grantUserSelectedVst3SearchPath(result.filePaths[0])
  })

  ipcMain.handle(IPC.audioEngine.setVst3SearchPaths, async (event, paths: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const engine = await ensureAudioEngineRuntime()
    const authorized = await resolveAuthorizedVst3SearchPaths(paths)
    const state = await requireVst3Catalog().setSearchPaths(authorized)
    engine.refreshDspGraph()
    return state
  })

  ipcMain.handle(IPC.audioEngine.scanVst3Plugins, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const engine = await ensureAudioEngineRuntime()
    const state = await requireVst3Catalog().scan()
    engine.refreshDspGraph()
    return state
  })

  ipcMain.handle(IPC.audioEngine.clearVst3Quarantine, async (event, id: unknown) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const engine = await ensureAudioEngineRuntime()
    const catalogId = normalizeIpcString(id, 'VST3 catalog id', 160)
    const catalog = requireVst3Catalog()
    await catalog.clearQuarantine(catalogId)
    // Re-probe in the scanner process before allowing this one module back
    // into the graph. A bad module remains isolated when the probe fails.
    const state = await catalog.scan()
    const entry = state.entries.find((candidate) => candidate.id === catalogId)
    if (entry?.status === 'available') await engine.clearVst3RecoveryBypass(catalogId)
    engine.refreshDspGraph()
    return state
  })

  ipcMain.handle(IPC.audioEngine.selectImpulseResponse, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.OpenDialogOptions = {
      title: '选择卷积脉冲响应',
      properties: ['openFile'],
      filters: [
        { name: 'Impulse Response', extensions: ['wav', 'flac', 'aiff', 'aif'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return await grantUserSelectedImpulseResponse(result.filePaths[0])
  })

  ipcMain.handle(IPC.audioEngine.loadImpulseResponse, async (_event, path: string) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    const convolverIrPath = await resolveAuthorizedImpulseResponseFile(
      normalizeIpcString(path, 'impulse response path', MAX_AUDIO_SOURCE_LENGTH)
    )
    const normalized = await authorizeAudioProcessingSettings({
      ...runtime.appSettings.audioProcessing,
      dspEnabled: true,
      convolverEnabled: true,
      convolverIrPath
    })
    await persistAndApplyAudioProcessingState(normalized)
    return await (await ensureAudioEngineRuntime()).getConvolverInfo()
  })

  ipcMain.handle(IPC.audioEngine.unloadImpulseResponse, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const normalized = normalizeAudioProcessingSettings({
      ...runtime.appSettings.audioProcessing,
      convolverEnabled: false,
      convolverIrPath: ''
    })
    await persistAndApplyAudioProcessingState(normalized)
    return await (await ensureAudioEngineRuntime()).getConvolverInfo()
  })

  ipcMain.handle(IPC.audioEngine.getConvolverInfo, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getConvolverInfo()
  })

  ipcMain.handle(
    IPC.audioEngine.setEqBands,
    async (_event, settings: Partial<AudioProcessingSettings>) => {
      assertTrustedIpcSender(_event, 'audio engine IPC')
      const merged = normalizeAudioProcessingSettings({
        ...runtime.appSettings.audioProcessing,
        ...settings,
        dspEnabled: true,
        eqEnabled: true
      })
      const { dspEnabled, directMode } = resolveProcessingMasterState(merged, true, false)
      const normalized = await authorizeAudioProcessingSettings({
        ...runtime.appSettings.audioProcessing,
        ...settings,
        dspEnabled,
        eqEnabled: true,
        directMode
      })
      await persistAndApplyAudioProcessingState(normalized)
      return runtime.appSettings.audioProcessing
    }
  )

  ipcMain.handle(
    IPC.audioEngine.setEqPreset,
    async (
      _event,
      preset: {
        eqMode: EqMode
        eqPreamp: number
        eqBands: EqualizerBand[]
      }
    ) => {
      assertTrustedIpcSender(_event, 'audio engine IPC')
      const merged = normalizeAudioProcessingSettings({
        ...runtime.appSettings.audioProcessing,
        ...preset,
        dspEnabled: true,
        eqEnabled: true
      })
      const { dspEnabled, directMode } = resolveProcessingMasterState(merged, true, false)
      const normalized = await authorizeAudioProcessingSettings({
        ...runtime.appSettings.audioProcessing,
        ...preset,
        dspEnabled,
        eqEnabled: true,
        directMode
      })
      await persistAndApplyAudioProcessingState(normalized)
      return runtime.appSettings.audioProcessing
    }
  )

  ipcMain.handle(IPC.audioEngine.setCrossfeedStrength, async (_event, strength: number) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    const normalizedStrength = normalizeFiniteNumber(strength, 'crossfeed strength', 0, 0, 1)
    const normalized = await authorizeAudioProcessingSettings({
      ...runtime.appSettings.audioProcessing,
      dspEnabled: true,
      crossfeedEnabled: normalizedStrength > 0,
      crossfeedStrength: normalizedStrength
    })
    await persistAndApplyAudioProcessingState(normalized)
    return runtime.appSettings.audioProcessing
  })

  ipcMain.handle(
    IPC.audioEngine.setReplayGainMode,
    async (
      _event,
      mode: AudioProcessingSettings['volumeNormalization'],
      preamp?: number,
      fallback?: number,
      clip?: boolean
    ) => {
      assertTrustedIpcSender(_event, 'audio engine IPC')
      const normalized = await authorizeAudioProcessingSettings({
        ...runtime.appSettings.audioProcessing,
        dspEnabled: true,
        volumeNormalization: mode,
        replayGainPreamp: preamp ?? runtime.appSettings.audioProcessing.replayGainPreamp,
        replayGainFallback: fallback ?? runtime.appSettings.audioProcessing.replayGainFallback,
        replayGainClip: clip ?? runtime.appSettings.audioProcessing.replayGainClip
      })
      await persistAndApplyAudioProcessingState(normalized)
      return runtime.appSettings.audioProcessing
    }
  )

  ipcMain.handle(IPC.audioEngine.getMetadata, async (_event, source: string) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    return await (
      await ensureAudioEngineRuntime()
    ).getMetadataAsync(
      await resolveAuthorizedAudioSource(
        normalizeIpcString(source, 'metadata source', MAX_AUDIO_SOURCE_LENGTH)
      )
    )
  })

  ipcMain.handle(IPC.audioEngine.getPlaybackInfo, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    return await (await ensureAudioEngineRuntime()).getPlaybackInfo()
  })

  ipcMain.handle(IPC.audioEngine.exportDiagnostics, async (event) => {
    assertTrustedIpcSender(event, 'audio engine IPC')
    const recorder = audioDiagnosticRecorder
    if (!recorder) throw new Error('音频诊断记录器尚未初始化')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const win = BrowserWindow.getFocusedWindow() ?? runtime.mainWindow
    const options: Electron.SaveDialogOptions = {
      title: '导出音频诊断日志',
      defaultPath: `TwilightEcho-audio-diagnostics-${timestamp}.json`,
      filters: [{ name: 'Twilight Echo Audio Diagnostics', extensions: ['json'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { filePath: null }
    recorder.record('diagnostic-export-requested')
    const snapshot = await captureAudioDiagnosticSnapshot()
    await recorder.exportReport(result.filePath, snapshot)
    return { filePath: result.filePath }
  })

  ipcMain.handle(IPC.audioEngine.getSpectrumData, async (_event, points?: number) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    return await (
      await ensureAudioEngineRuntime()
    ).getSpectrumData(normalizeInteger(points, 'spectrum points', 128, 8, 4096))
  })

  ipcMain.handle(IPC.audioEngine.getVisualizationData, async (_event, options?: unknown) => {
    assertTrustedIpcSender(_event, 'audio engine IPC')
    return await (
      await ensureAudioEngineRuntime()
    ).getVisualizationData(typeof options === 'object' && options !== null ? options : {})
  })
}
