import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { join } from 'path'
import { AudioEngineServiceBinding, canUseAudioEngineService } from './audioEngineServiceClient.ts'
import { isBpmAnalysisResult, type BpmAnalysisResult } from './bpm/bpmCache.ts'
import { isLoudnessAnalysisResult, type LoudnessAnalysisResult } from './audio/loudnessCache.ts'
import type { LoudnessAnalysisManager } from './audio/loudnessAnalysisManager.ts'
import {
  graphHasEnabledProcessing,
  type DspGraphStatus,
  type DspOutputStageConfig,
  type DspScene,
  type DspSceneState,
  type DspStereoImageConfig,
  type Vst3ScanDescriptor
} from '../shared/dspGraph.ts'
import type {
  AudioEngineConfig,
  AudioEngineManagerDependencies,
  AudioEnginePlayResult,
  AudioEngineQueueItem,
  AudioEngineScheduler,
  AudioEngineServiceNativeBinding,
  AudioOutputId,
  AudioOutputOption,
  AudioOutputState,
  AudioProcessingSettings,
  ConvolverInfo,
  EqMode,
  EqualizerBand,
  LoudnormStatus,
  NativeAudioBinding,
  NativeAudioMetadata,
  NativeBpmAnalysisOptions,
  NativeLoudnessAnalysisOptions,
  OutputConfig,
  OutputConfigApplyStatus,
  PlaybackInfo,
  PlayMode,
  VisualizationData,
  VisualizationOptions,
  VolumeNormalizationMode
} from './audio/audioEngineTypes.ts'
import {
  DEFAULT_AUDIO_ENGINE_SCHEDULER,
  METADATA_CACHE_TTL_MS,
  MAX_METADATA_CACHE_ENTRIES,
  clampNumber,
  createDefaultPlaybackInfo,
  nativePlayMode,
  parseNativeJson
} from './audio/audioEngineHelpers.ts'
import {
  getNativeAddonCandidates,
  loadNativeBinding,
  rendererFallbackAllowed
} from './audio/nativeBinding.ts'
import { DspOrchestrator } from './audio/dspOrchestrator.ts'
import { OutputRouter } from './audio/outputRouter.ts'
import { PlaybackController } from './audio/playbackController.ts'

export type {
  AudioCapabilitySupportState,
  AudioDeviceOption,
  AudioEngineConfig,
  AudioEngineManagerDependencies,
  AudioEnginePlayResult,
  AudioEngineQueueItem,
  AudioEngineScheduler,
  AudioEngineServiceNativeBinding,
  AudioOutputId,
  AudioOutputOption,
  AudioOutputState,
  AudioProcessingSettings,
  ConvolverInfo,
  EqualizerBand,
  EqualizerFilterType,
  EqMode,
  LatencyInfo,
  LoudnormStatus,
  NativeAudioBinding,
  NativeAudioMetadata,
  NativeBpmAnalysisOptions,
  NativeLoudnessAnalysisOptions,
  OutputConfig,
  OutputConfigApplyStatus,
  OutputDiagnostics,
  OutputInfo,
  PlayMode,
  PlaybackInfo,
  PlaybackOutputInfoMirror,
  VisualizationData,
  VisualizationOptions,
  VisualizationTapStatus,
  VolumeNormalizationMode,
  ChannelRoutingMode,
  DsdOutputMode,
  SacdProgramMode
} from './audio/audioEngineTypes.ts'
export type { DspSceneState } from '../shared/dspGraph.ts'
export {
  DEFAULT_AUDIO_PROCESSING,
  getAudioOutputOptions,
  normalizeAudioOutput,
  createPlaybackInfoFanoutSignature,
  normalizeAudioProcessingSettings,
  resolveProcessingMasterState,
  mapSpectrumToVisualizerBars
} from './audio/audioEngineHelpers.ts'
export {
  getNativeAddonCandidates,
  loadNativeBinding,
  rendererFallbackAllowed
} from './audio/nativeBinding.ts'

export class AudioEngineManager extends EventEmitter {
  private native: NativeAudioBinding | null
  private audioServiceBinding: AudioEngineServiceNativeBinding | null = null
  private readonly outputRouter: OutputRouter
  private readonly dsp: DspOrchestrator
  private readonly playback: PlaybackController
  private scheduler: AudioEngineScheduler
  private loudnessAnalysisManager: LoudnessAnalysisManager | null = null
  private loudnormStatus: LoudnormStatus = 'idle'
  private loudnormStatusSource: string | null = null
  private metadataCache = new Map<
    string,
    {
      readAt: number
      metadata: NativeAudioMetadata | null
    }
  >()
  private destroyed = false
  private nativePlaybackActive = false
  private nativeOutputRouteSynced = false
  private nativeVolumeSynced = false
  private audioServiceReadyRestoreSerial = 0
  private lastNativeError = ''
  private pendingNativeSource: string | null = null
  private directModePlaybackRateRestore: number | null = null

  constructor(
    config: AudioEngineConfig = { exclusiveMode: false },
    dependencies: AudioEngineManagerDependencies = {}
  ) {
    super()
    this.scheduler = {
      ...DEFAULT_AUDIO_ENGINE_SCHEDULER,
      ...(dependencies.scheduler ?? {})
    }
    this.native =
      dependencies.nativeBinding !== undefined
        ? dependencies.nativeBinding
        : this.createNativeBinding(dependencies)
    this.outputRouter = new OutputRouter(
      {
        getNative: () => this.native,
        getPlaybackInfo: () => this.playbackInfo,
        setPlaybackInfo: (info) => {
          this.playbackInfo = info
        },
        getLastNativeError: () => this.lastNativeError,
        getScheduler: () => this.scheduler,
        isDestroyed: () => this.destroyed,
        getNativeOutputRouteSynced: () => this.nativeOutputRouteSynced,
        setNativeOutputRouteSynced: (value) => {
          this.nativeOutputRouteSynced = value
        },
        callNativeMaybeAsync: (context, method, ...args) =>
          this.callNativeMaybeAsync(context, method, ...args),
        applyNativeDspGraphOrThrow: (context) => this.applyNativeDspGraphOrThrow(context),
        readNativePlaybackInfo: () => this.readNativePlaybackInfo(),
        readNativePlaybackInfoAsync: () => this.readNativePlaybackInfoAsync(),
        mergeNativePlaybackInfo: (nativeInfo) => this.mergeNativePlaybackInfo(nativeInfo),
        updateOutputPerfect: () => this.updateOutputPerfect(),
        publishPlaybackInfo: () => this.publishPlaybackInfo(),
        syncPlaybackOutputMirrorsFromOutputInfo: () =>
          this.syncPlaybackOutputMirrorsFromOutputInfo(),
        emit: (event, payload) => {
          this.emit(event, payload)
        }
      },
      config,
      dependencies
    )
    this.outputRouter.initializeDeviceSelection()
    const initialPlaybackInfo = createDefaultPlaybackInfo(
      this.output,
      this.device,
      this.exclusiveMode,
      this.outputConfig
    )
    initialPlaybackInfo.volume = clampNumber(config.volume, 0, 1, 1)
    this.playback = new PlaybackController(
      {
        getNative: () => this.native,
        getAudioServiceBinding: () => this.audioServiceBinding,
        getScheduler: () => this.scheduler,
        getLastNativeError: () => this.lastNativeError,
        setLastNativeError: (error) => {
          this.lastNativeError = error
        },
        isDestroyed: () => this.destroyed,
        getNativePlaybackActive: () => this.nativePlaybackActive,
        setNativePlaybackActive: (value) => {
          this.nativePlaybackActive = value
        },
        getNativeOutputRouteSynced: () => this.nativeOutputRouteSynced,
        setNativeOutputRouteSynced: (value) => {
          this.nativeOutputRouteSynced = value
        },
        getPendingNativeSource: () => this.pendingNativeSource,
        setPendingNativeSource: (value) => {
          this.pendingNativeSource = value
        },
        getOutput: () => this.output,
        setOutput: (value) => {
          this.output = value
        },
        getDevice: () => this.device,
        setDevice: (value) => {
          this.device = value
        },
        getExclusiveMode: () => this.exclusiveMode,
        setExclusiveMode: (value) => {
          this.exclusiveMode = value
        },
        getOutputConfig: () => this.outputConfig,
        setOutputConfig: (value) => {
          this.outputConfig = value
        },
        createDeviceCapabilityRefreshSignature: (info) =>
          this.createDeviceCapabilityRefreshSignature(info),
        invalidateAudioDeviceOptionsCache: (reason) =>
          this.invalidateAudioDeviceOptionsCache(reason),
        getProcessing: () => this.processing,
        getActiveDspGraph: () => this.dsp.activeDspGraph,
        getNativeBackendId: () => this.getNativeBackendId(),
        shouldFallbackFromAsio: (output) => this.shouldFallbackFromAsio(output),
        restoreAudioServiceOutputRoute: (contextPrefix) =>
          this.restoreAudioServiceOutputRoute(contextPrefix),
        applyNativeDspGraph: (context) => this.applyNativeDspGraph(context),
        applyNativeDspGraphOrThrow: (context) => this.applyNativeDspGraphOrThrow(context),
        applyNativeDspSettings: (context, options, throwOnGraphFailure) =>
          this.applyNativeDspSettings(context, options, throwOnGraphFailure),
        refreshResolvedDspScene: () => this.refreshResolvedDspScene(),
        updateOutputPerfect: () => this.updateOutputPerfect(),
        refreshOutputInfoFromNative: (resetDefaults) =>
          this.refreshOutputInfoFromNative(resetDefaults),
        pollAudioDeviceOptionsForChanges: () => this.pollAudioDeviceOptionsForChanges(),
        prepareLoudnormForPlay: (source) => this.prepareLoudnormForPlay(source),
        tryNative: (context, command, logFailure) => this.tryNative(context, command, logFailure),
        isNativeVolumeSynced: () => this.nativeVolumeSynced,
        markNativeVolumeSynced: (value) => {
          this.nativeVolumeSynced = value
        },
        canVerifyNativeVolume: () => this.audioServiceBinding === null,
        callNativeMaybeAsync: (context, method, ...args) =>
          this.callNativeMaybeAsync(context, method, ...args),
        emit: (event, payload) => {
          this.emit(event, payload)
        }
      },
      initialPlaybackInfo
    )
    this.dsp = new DspOrchestrator(
      {
        getNative: () => this.native,
        getAudioServiceBinding: () => this.audioServiceBinding,
        getPlaybackInfo: () => this.playbackInfo,
        setPlaybackInfo: (info) => {
          this.playbackInfo = info
        },
        getDevice: () => this.device,
        getOutput: () => this.output,
        getLastNativeError: () => this.lastNativeError,
        setLastNativeError: (error) => {
          this.lastNativeError = error
        },
        getScheduler: () => this.scheduler,
        updateOutputPerfect: () => this.updateOutputPerfect(),
        publishPlaybackInfo: () => this.publishPlaybackInfo(),
        syncPlaybackOutputMirrorsFromOutputInfo: () =>
          this.syncPlaybackOutputMirrorsFromOutputInfo(),
        updateNativeInfoSnapshot: () => this.updateNativeInfoSnapshot(),
        syncLoudnormModeTransition: (previousMode, nextMode) =>
          this.syncLoudnormModeTransition(previousMode, nextMode),
        applyDirectModeRuntimeOverrides: (enabled) => this.applyDirectModeRuntimeOverrides(enabled),
        tryNative: (context, action) => this.tryNative(context, action)
      },
      config,
      dependencies
    )
    this.resetOutputInfoDefaults()
    this.updateOutputPerfect()
  }

  private get playbackInfo(): PlaybackInfo {
    return this.playback.playbackInfo
  }
  private set playbackInfo(value: PlaybackInfo) {
    this.playback.playbackInfo = value
  }
  private get queue(): AudioEngineQueueItem[] {
    return this.playback.queue
  }
  private set queue(value: AudioEngineQueueItem[]) {
    this.playback.queue = value
  }
  private get queueJson(): string {
    return this.playback.queueJson
  }
  private set queueJson(value: string) {
    this.playback.queueJson = value
  }
  private get nativeConfigRevisionEpochPending(): boolean {
    return this.playback.nativeConfigRevisionEpochPending
  }
  private set nativeConfigRevisionEpochPending(value: boolean) {
    this.playback.nativeConfigRevisionEpochPending = value
  }

  private get output(): AudioOutputId {
    return this.outputRouter.output
  }
  private set output(value: AudioOutputId) {
    this.outputRouter.output = value
  }
  private get device(): string {
    return this.outputRouter.device
  }
  private set device(value: string) {
    this.outputRouter.device = value
  }
  private get exclusiveMode(): boolean {
    return this.outputRouter.exclusiveMode
  }
  private set exclusiveMode(value: boolean) {
    this.outputRouter.exclusiveMode = value
  }
  private get outputConfig(): OutputConfig {
    return this.outputRouter.outputConfig
  }
  private set outputConfig(value: OutputConfig) {
    this.outputRouter.outputConfig = value
  }
  private get outputConfigServiceGeneration(): number {
    return this.outputRouter.outputConfigServiceGeneration
  }
  private set outputConfigServiceGeneration(value: number) {
    this.outputRouter.outputConfigServiceGeneration = value
  }
  private get outputConfigApplyStatus(): OutputConfigApplyStatus {
    return this.outputRouter.outputConfigApplyStatus
  }
  private set outputConfigApplyStatus(value: OutputConfigApplyStatus) {
    this.outputRouter.outputConfigApplyStatus = value
  }
  private get outputConfigApplyGeneration(): number {
    return this.outputRouter.outputConfigApplyGeneration
  }

  private get processing(): AudioProcessingSettings {
    return this.dsp.processing
  }
  private set processing(value: AudioProcessingSettings) {
    this.dsp.processing = value
  }
  private get nativeConvolverIrPath(): string | null {
    return this.dsp.nativeConvolverIrPath
  }
  private set nativeConvolverIrPath(value: string | null) {
    this.dsp.nativeConvolverIrPath = value
  }
  private get nativeDspPluginChainJson(): string {
    return this.dsp.getEffectiveNativeDspPluginChainJson()
  }
  private set lastNativeDspPluginStatusCache(value: { readAt: number; status: unknown } | null) {
    this.dsp.lastNativeDspPluginStatusCache = value
  }
  private set lastConvolverInfoCache(value: { readAt: number; info: ConvolverInfo } | null) {
    this.dsp.lastConvolverInfoCache = value
  }

  private createNativeBinding(
    dependencies: AudioEngineManagerDependencies
  ): NativeAudioBinding | null {
    // The isolated service owns its own native addon load. Do not make the main
    // process probe a .node candidate before honoring an injected/default
    // service binding, or service mode becomes incorrectly dependent on a
    // main-process addon copy.
    if (dependencies.audioServiceFactory || canUseAudioEngineService()) {
      const service =
        dependencies.audioServiceFactory?.() ??
        new AudioEngineServiceBinding({
          serviceEntry: dependencies.audioServiceEntry ?? join(__dirname, 'audioEngineService.js')
        })
      service.on('crash', (reason: string) => this.handleAudioServiceCrash(reason))
      service.on('ready', () => this.handleAudioServiceReady())
      service.on('error-log', (message: string) => {
        const normalized = message.trim()
        if (!normalized) return
        console.warn('[音频服务]', normalized)
        this.emit('audio-service-stderr', { message: normalized })
      })
      service.on('log', (message: string) => {
        const normalized = message.trim()
        if (normalized) this.emit('audio-service-stdout', { message: normalized })
      })
      this.audioServiceBinding = service
      return service
    }

    const nativeAddonCandidates = dependencies.nativeAddonCandidates ?? getNativeAddonCandidates
    if (!nativeAddonCandidates().some((candidate) => existsSync(candidate))) {
      this.lastNativeError = '未加载 twilight_audio_node.node'
      return null
    }
    const native = loadNativeBinding(nativeAddonCandidates)
    if (
      native &&
      (typeof native.ApplyDspState !== 'function' || typeof native.GetDspGraphStatus !== 'function')
    ) {
      this.lastNativeError =
        'native audio binding is missing required DSP methods: ApplyDspState, GetDspGraphStatus'
      console.warn(this.lastNativeError)
      return null
    }
    return native
  }

  private handleAudioServiceCrash(reason: string): void {
    this.outputConfigServiceGeneration += 1
    this.nativeVolumeSynced = false
    if (this.outputConfigApplyStatus.state === 'pending') {
      this.outputConfigApplyStatus = {
        ...this.outputConfigApplyStatus,
        failedRevision: this.outputConfigApplyStatus.requestedRevision,
        state: 'failed',
        error: reason,
        generation: this.outputConfigApplyGeneration
      }
    }
    this.lastNativeError = reason
    this.nativePlaybackActive = false
    this.nativeOutputRouteSynced = false
    this.nativeConfigRevisionEpochPending = true
    this.audioServiceReadyRestoreSerial += 1
    this.dsp.resetAfterServiceCrash(reason)
    this.lastNativeDspPluginStatusCache = null
    this.lastConvolverInfoCache = null
    this.invalidateAudioDeviceOptionsCache('audio-service-crash')
    this.playback.resetCachesOnServiceCrash()
    this.metadataCache.clear()
    const nextDiagnostics = {
      ...this.playbackInfo.outputInfo.diagnostics,
      lastError: reason,
      sessionRecoveryCount: this.playbackInfo.outputInfo.diagnostics.sessionRecoveryCount + 1,
      lifetimeRecoveryCount: this.playbackInfo.outputInfo.diagnostics.lifetimeRecoveryCount + 1
    }
    this.playbackInfo = {
      ...this.playbackInfo,
      state: 'stopped',
      nativePlaybackActive: false,
      outputInfo: {
        ...this.playbackInfo.outputInfo,
        nativeDsp: { plugins: [] },
        diagnostics: nextDiagnostics,
        recoveryCount: this.playbackInfo.outputInfo.recoveryCount + 1
      },
      diagnostics: {
        ...this.playbackInfo.diagnostics,
        lastError: reason,
        sessionRecoveryCount: this.playbackInfo.diagnostics.sessionRecoveryCount + 1,
        lifetimeRecoveryCount: this.playbackInfo.diagnostics.lifetimeRecoveryCount + 1
      },
      recoveryCount: this.playbackInfo.recoveryCount + 1
    }
    this.emit('audio-service-crash', { reason })
    this.publishPlaybackInfo()
  }

  private handleAudioServiceReady(): void {
    const restoreSerial = ++this.audioServiceReadyRestoreSerial
    this.nativeOutputRouteSynced = false
    this.invalidateAudioDeviceOptionsCache('audio-service-ready')
    void this.restoreAudioServiceReadyState().then((result) => {
      if (this.destroyed || restoreSerial !== this.audioServiceReadyRestoreSerial) return
      this.nativeOutputRouteSynced = result.outputRouteSynced
      this.nativePlaybackActive = false
      this.invalidateUpcomingTrackCache()
      this.playbackInfo = {
        ...this.playbackInfo,
        state: 'stopped',
        nativePlaybackActive: false
      }
      this.publishPlaybackInfo()
      this.emit('audio-service-ready', {
        manualResumeRequired: true,
        outputRouteSynced: result.outputRouteSynced,
        restoreErrors: result.errors
      })
    })
  }

  private async restoreAudioServiceReadyState(): Promise<{
    outputRouteSynced: boolean
    errors: string[]
  }> {
    const routeRestore = await this.restoreAudioServiceOutputRoute()
    // Volume / rate / queue state must be re-applied even when the output
    // route restore failed. A freshly started audio-service process begins at
    // unity volume; skipping the playback-state restore would leave the native
    // engine loud while the manager still reports the saved volume (renderer
    // pushes are then no-ops because playbackInfo already matches).
    const stateRestore = await this.restoreAudioServicePlaybackState()
    return {
      outputRouteSynced: routeRestore.synced && stateRestore.synced,
      errors: [...routeRestore.errors, ...stateRestore.errors]
    }
  }

  private async restoreAudioServicePlaybackState(): Promise<{ synced: boolean; errors: string[] }> {
    const results: Array<{ ok: boolean; error: string }> = []
    if (this.nativeDspPluginChainJson) {
      results.push(
        await this.restoreAudioServiceOutputRouteStep(
          'native-dsp-plugin-chain',
          '音频服务恢复后应用原生 DSP 插件链',
          'SetDspPluginChain',
          this.nativeDspPluginChainJson
        )
      )
    }
    const graphStatus = await this.applyNativeDspGraph('音频服务恢复后应用 DSP graph')
    results.push({
      ok:
        graphStatus.applyState === 'applied' &&
        (graphStatus.appliedRevision ?? 0) >= (graphStatus.requestedRevision ?? 0),
      error:
        graphStatus.applyState === 'applied'
          ? ''
          : `dsp-graph: ${graphStatus.applyError || 'native revision ACK was not observed'}`
    })
    if (graphStatus.applyState === 'applied') {
      this.nativeConvolverIrPath = this.processing.convolverIrPath
    }
    if (this.queue.length > 0) {
      results.push(
        await this.restoreAudioServiceOutputRouteStep(
          'queue',
          '音频服务恢复后加载队列',
          'LoadQueue',
          JSON.stringify(this.queue),
          this.playbackInfo.queueIndex
        )
      )
      // Native LoadQueue starts a fresh service in sequential mode; without
      // re-applying the play mode, shuffle/repeat silently died with the
      // crashed process while the UI kept showing the saved mode.
      results.push(
        await this.restoreAudioServiceOutputRouteStep(
          'play-mode',
          '音频服务恢复后应用播放模式',
          'SetPlayMode',
          nativePlayMode(this.playbackInfo.playMode)
        )
      )
    }
    const volumeResult = await this.restoreAudioServiceOutputRouteStep(
      'volume',
      '音频服务恢复后应用音量',
      'SetVolume',
      this.playbackInfo.volume
    )
    this.nativeVolumeSynced = volumeResult.ok
    results.push(volumeResult)
    results.push(
      await this.restoreAudioServiceOutputRouteStep(
        'playback-rate',
        '音频服务恢复后应用倍速',
        'SetPlaybackRate',
        this.playbackInfo.playbackRate ?? 1
      )
    )
    return {
      synced: results.every((result) => result.ok),
      errors: results.filter((result) => !result.ok).map((result) => result.error)
    }
  }

  async start(): Promise<void> {
    this.nativeOutputRouteSynced = false
    const routeRestore = await this.restoreAudioServiceOutputRoute('初始化')
    this.nativeOutputRouteSynced = routeRestore.synced
    await this.applyNativeDspSettings('初始化 DSP 配置', {}, false)
    const volumeStep = await this.restoreAudioServiceOutputRouteStep(
      'volume',
      '初始化软件音量',
      'SetVolume',
      this.playbackInfo.volume
    )
    this.nativeVolumeSynced = volumeStep.ok
    if (this.processing.directMode) await this.applyDirectModeRuntimeOverrides(true)
    this.startClock()
    this.scheduler.setImmediate(() => this.emit('ready'))
  }

  setLoudnessAnalysisManager(manager: LoudnessAnalysisManager | null): void {
    this.loudnessAnalysisManager = manager
  }

  getLoudnormStatus(): { status: LoudnormStatus; source: string | null } {
    return { status: this.loudnormStatus, source: this.loudnormStatusSource }
  }

  getMetadata(source: string): NativeAudioMetadata | null {
    const cached = this.getCachedMetadata(source)
    if (cached.found) return cached.metadata

    const metadata = parseNativeJson(
      this.native?.GetMetadata?.(source),
      null as NativeAudioMetadata | null
    )
    this.cacheMetadata(source, metadata)
    return metadata
  }

  async getMetadataAsync(source: string): Promise<NativeAudioMetadata | null> {
    const cached = this.getCachedMetadata(source)
    if (cached.found) return cached.metadata

    if (this.audioServiceBinding) {
      const metadata = parseNativeJson(
        await this.audioServiceBinding.getMetadataAsync(source),
        null as NativeAudioMetadata | null
      )
      this.cacheMetadata(source, metadata)
      return metadata
    }
    const metadata = this.getMetadata(source)
    this.cacheMetadata(source, metadata)
    return metadata
  }

  async analyzeBpm(
    source: string,
    options: NativeBpmAnalysisOptions = {}
  ): Promise<BpmAnalysisResult | null> {
    const optionsJson = JSON.stringify({
      maxAnalysisSeconds: clampNumber(options.maxAnalysisSeconds, 1, 1800, 180),
      referenceBpm:
        typeof options.referenceBpm === 'number' && Number.isFinite(options.referenceBpm)
          ? options.referenceBpm
          : undefined
    })
    try {
      if (this.audioServiceBinding) {
        throw new Error('offline BPM analysis requires the isolated audio analysis service')
      }
      const raw = this.native?.AnalyzeBpm?.(source, optionsJson)
      const analysis = parseNativeJson<BpmAnalysisResult | null>(
        raw as string | BpmAnalysisResult | undefined,
        null
      )
      return isBpmAnalysisResult(analysis) ? analysis : null
    } catch {
      return null
    }
  }

  async analyzeLoudness(
    source: string,
    options: NativeLoudnessAnalysisOptions = {}
  ): Promise<LoudnessAnalysisResult | null> {
    const optionsJson = JSON.stringify({
      maxAnalysisSeconds:
        typeof options.maxAnalysisSeconds === 'number' &&
        Number.isFinite(options.maxAnalysisSeconds)
          ? clampNumber(options.maxAnalysisSeconds, 0, 14_400, 0)
          : 0
    })
    try {
      if (this.audioServiceBinding) {
        throw new Error('offline loudness analysis requires the isolated audio analysis service')
      }
      const raw = this.native?.AnalyzeLoudness?.(source, optionsJson)
      const analysis = parseNativeJson<
        LoudnessAnalysisResult | { error?: string; available?: boolean } | null
      >(raw as string | LoudnessAnalysisResult | undefined, null)
      if (!analysis || typeof analysis !== 'object') return null
      if ('error' in analysis) {
        if (analysis.available === false) {
          return {
            integratedLufs: 0,
            truePeakDb: 0,
            source: 'analyzed',
            analyzedAt: new Date().toISOString(),
            algorithmVersion: 1,
            available: false
          }
        }
        return null
      }
      return isLoudnessAnalysisResult(analysis) ? analysis : null
    } catch {
      return null
    }
  }

  private async prepareLoudnormForPlay(source: string): Promise<void> {
    if (this.processing.volumeNormalization !== 'loudnorm') {
      if (this.loudnormStatusSource && this.loudnessAnalysisManager) {
        this.loudnessAnalysisManager.cancel(this.loudnormStatusSource)
      }
      this.loudnormStatus = 'idle'
      this.loudnormStatusSource = null
      this.emit('loudnorm-status', { status: 'idle' as LoudnormStatus, source: null })
      return
    }

    if (
      this.loudnormStatusSource &&
      this.loudnormStatusSource !== source &&
      this.loudnessAnalysisManager
    ) {
      this.loudnessAnalysisManager.cancel(this.loudnormStatusSource)
    }

    this.loudnormStatusSource = source
    const manager = this.loudnessAnalysisManager
    if (!manager) {
      this.loudnormStatus = 'fallback'
      this.emit('loudnorm-status', { status: 'fallback' as LoudnormStatus, source })
      return
    }

    const trackId = this.queue.find((item) => item.source === source)?.id ?? source
    const cached = await manager.peekCached({ trackId, filePath: source })
    if (cached && Number.isFinite(cached.integratedLufs)) {
      this.loudnormStatus = 'cached'
      this.applyLoudnormMeasurementToQueue(source, cached)
      this.emit('loudnorm-status', {
        status: 'cached' as LoudnormStatus,
        source,
        analysis: cached
      })
      return
    }

    this.loudnormStatus = 'measuring'
    this.emit('loudnorm-status', { status: 'measuring' as LoudnormStatus, source })
    // Fire-and-forget analysis; first play uses fallback gain until cache is ready.
    void manager.requestAnalysis({ trackId, filePath: source, priority: 100 }).then((result) => {
      // Drop stale results after mode leave / track change / destroy.
      if (
        this.destroyed ||
        this.processing.volumeNormalization !== 'loudnorm' ||
        this.loudnormStatusSource !== source
      ) {
        return
      }
      if (result.status === 'completed' || result.status === 'cached') {
        this.loudnormStatus = 'cached'
        this.applyLoudnormMeasurementToQueue(source, result.analysis)
        this.emit('loudnorm-status', {
          status: 'cached' as LoudnormStatus,
          source,
          analysis: result.analysis
        })
      } else if (result.status === 'unavailable') {
        this.loudnormStatus = 'unavailable'
        this.emit('loudnorm-status', { status: 'unavailable' as LoudnormStatus, source })
      } else if (result.status === 'failed' || result.status === 'skipped') {
        this.loudnormStatus =
          result.status === 'skipped' && result.reason === 'cancelled' ? 'idle' : 'fallback'
        this.emit('loudnorm-status', {
          status: this.loudnormStatus as LoudnormStatus,
          source,
          reason: result.reason
        })
      }
    })
  }

  /**
   * Mode transitions outside play(): leaving loudnorm cancels in-flight analysis
   * and emits idle; entering while a source is loaded re-runs prepare for that source.
   */
  private async syncLoudnormModeTransition(
    previousMode: VolumeNormalizationMode,
    nextMode: VolumeNormalizationMode
  ): Promise<void> {
    if (previousMode === nextMode) return

    if (previousMode === 'loudnorm' && nextMode !== 'loudnorm') {
      if (this.loudnormStatusSource && this.loudnessAnalysisManager) {
        this.loudnessAnalysisManager.cancel(this.loudnormStatusSource)
      }
      this.loudnormStatus = 'idle'
      this.loudnormStatusSource = null
      this.emit('loudnorm-status', { status: 'idle' as LoudnormStatus, source: null })
      return
    }

    if (nextMode === 'loudnorm') {
      const source = this.playbackInfo.source?.trim()
      if (source) {
        await this.prepareLoudnormForPlay(source)
      } else {
        this.loudnormStatus = 'idle'
        this.loudnormStatusSource = null
        this.emit('loudnorm-status', { status: 'idle' as LoudnormStatus, source: null })
      }
    }
  }

  private applyLoudnormMeasurementToQueue(source: string, analysis: LoudnessAnalysisResult): void {
    if (!Number.isFinite(analysis.integratedLufs)) return
    let changed = false
    this.queue = this.queue.map((item) => {
      if (item.source !== source) return item
      changed = true
      return {
        ...item,
        measuredIntegratedLufs: analysis.integratedLufs,
        measuredTruePeakDb: analysis.truePeakDb
      }
    })
    if (!changed) return
    this.queueJson = JSON.stringify(this.queue)
    this.tryNative('注入 loudnorm 测量结果', (native) =>
      native.LoadQueue?.(this.queueJson, this.playbackInfo.queueIndex)
    )
  }

  refreshDspGraph(): void {
    this.dsp.refreshDspGraph()
  }

  clearVst3RecoveryBypass(catalogId?: string): void {
    this.dsp.clearVst3RecoveryBypass(catalogId)
  }

  getDspSceneState(): DspSceneState {
    return this.dsp.getDspSceneState()
  }

  async setDspScenes(
    scenes: DspScene[],
    pinnedSceneId: string | null = this.dsp.dspPinnedSceneId
  ): Promise<DspSceneState> {
    return this.dsp.setDspScenes(scenes, pinnedSceneId)
  }

  async setOutputStage(partial: Partial<DspOutputStageConfig>): Promise<DspSceneState> {
    return this.dsp.setOutputStage(partial)
  }

  getOutputStage(): DspOutputStageConfig {
    return this.dsp.getOutputStage()
  }

  async setStereoImage(partial: Partial<DspStereoImageConfig>): Promise<DspSceneState> {
    return this.dsp.setStereoImage(partial)
  }

  getStereoImage(): DspStereoImageConfig {
    return this.dsp.getStereoImage()
  }

  async applyDspScene(
    sceneId: string | null,
    confirmDsdPcmFallback = false
  ): Promise<DspSceneState> {
    return this.dsp.applyDspScene(sceneId, confirmDsdPcmFallback)
  }

  async getDspGraphStatus(): Promise<DspGraphStatus> {
    return this.dsp.getDspGraphStatus()
  }

  async scanVst3Module(modulePath: string): Promise<Vst3ScanDescriptor> {
    return this.dsp.scanVst3Module(modulePath)
  }

  async setAudioProcessing(
    settings: Partial<AudioProcessingSettings>
  ): Promise<AudioProcessingSettings> {
    return this.dsp.setAudioProcessing(settings)
  }

  getAudioProcessing(): AudioProcessingSettings {
    return this.dsp.getAudioProcessing()
  }

  async loadImpulseResponse(path: string): Promise<ConvolverInfo> {
    return this.dsp.loadImpulseResponse(path)
  }

  async unloadImpulseResponse(): Promise<ConvolverInfo> {
    return this.dsp.unloadImpulseResponse()
  }

  getConvolverInfo(): ConvolverInfo {
    return this.dsp.getConvolverInfo()
  }

  async setEqBands(settings: Partial<AudioProcessingSettings>): Promise<AudioProcessingSettings> {
    return this.dsp.setEqBands(settings)
  }

  async setEqPreset(preset: {
    eqMode: EqMode
    eqPreamp: number
    eqBands: EqualizerBand[]
  }): Promise<AudioProcessingSettings> {
    return this.dsp.setEqPreset(preset)
  }

  async setCrossfeedStrength(strength: number): Promise<AudioProcessingSettings> {
    return this.dsp.setCrossfeedStrength(strength)
  }

  async setReplayGainMode(
    mode: VolumeNormalizationMode,
    preamp = this.processing.replayGainPreamp,
    fallback = this.processing.replayGainFallback,
    clip = this.processing.replayGainClip
  ): Promise<AudioProcessingSettings> {
    return this.dsp.setReplayGainMode(mode, preamp, fallback, clip)
  }

  setNativeDspPluginChain(chainJson: string): void {
    this.dsp.setNativeDspPluginChain(chainJson)
  }

  getNativeDspPluginStatus(): unknown {
    return this.dsp.getNativeDspPluginStatus()
  }

  private async applyNativeDspGraph(context: string): Promise<DspGraphStatus> {
    return this.dsp.applyNativeDspGraph(context)
  }

  private async applyNativeDspGraphOrThrow(context: string): Promise<DspGraphStatus> {
    return this.dsp.applyNativeDspGraphOrThrow(context)
  }

  private async applyNativeDspSettings(
    context: string,
    options: { previousProcessing?: AudioProcessingSettings } = {},
    throwOnGraphFailure = true
  ): Promise<DspGraphStatus> {
    return this.dsp.applyNativeDspSettings(context, options, throwOnGraphFailure)
  }

  private refreshResolvedDspScene() {
    return this.dsp.refreshResolvedDspScene()
  }

  async setExclusiveMode(enabled: boolean): Promise<AudioOutputState> {
    return this.outputRouter.setExclusiveMode(enabled)
  }

  async getExclusiveMode(): Promise<boolean> {
    return this.outputRouter.getExclusiveMode()
  }

  async setAudioOutput(output: AudioOutputId, device?: string): Promise<AudioOutputState> {
    return this.outputRouter.setAudioOutput(output, device)
  }

  async setAudioDevice(device: string): Promise<AudioOutputState> {
    return this.outputRouter.setAudioDevice(device)
  }

  async setOutputConfig(config: Partial<OutputConfig>): Promise<void> {
    return this.outputRouter.setOutputConfig(config)
  }

  getOutputConfig(): OutputConfig {
    return this.outputRouter.getOutputConfig()
  }

  getEffectiveOutputConfig(): OutputConfig {
    return this.outputRouter.getEffectiveOutputConfig()
  }

  getOutputConfigApplyStatus(): OutputConfigApplyStatus {
    return this.outputRouter.getOutputConfigApplyStatus()
  }

  async getAudioOutput(): Promise<AudioOutputId> {
    return this.outputRouter.getAudioOutput()
  }

  getAudioOutputOptions(): AudioOutputOption[] {
    return this.outputRouter.getAudioOutputOptions()
  }

  async getAudioOutputState(): Promise<AudioOutputState> {
    return this.outputRouter.getAudioOutputState()
  }

  notifyAudioDeviceOptionsChanged(reason = 'platform-device-change'): void {
    this.outputRouter.notifyAudioDeviceOptionsChanged(reason)
  }

  private async restoreAudioServiceOutputRoute(
    contextPrefix = '音频服务恢复后应用'
  ): Promise<{ synced: boolean; errors: string[] }> {
    return this.outputRouter.restoreAudioServiceOutputRoute(contextPrefix)
  }

  private async restoreAudioServiceOutputRouteStep(
    id: string,
    context: string,
    method: keyof NativeAudioBinding,
    ...args: unknown[]
  ): Promise<{ ok: boolean; error: string }> {
    return this.outputRouter.restoreAudioServiceOutputRouteStep(id, context, method, ...args)
  }

  private getNativeBackendId(): string {
    return this.outputRouter.getNativeBackendId()
  }

  private shouldFallbackFromAsio(output: AudioOutputId): boolean {
    return this.outputRouter.shouldFallbackFromAsio(output)
  }

  private resetOutputInfoDefaults(): void {
    this.outputRouter.resetOutputInfoDefaults()
  }

  private refreshOutputInfoFromNative(resetDefaults: boolean): void {
    this.outputRouter.refreshOutputInfoFromNative(resetDefaults)
  }

  private pollAudioDeviceOptionsForChanges(): void {
    this.outputRouter.pollAudioDeviceOptionsForChanges()
  }

  private invalidateAudioDeviceOptionsCache(reason: string): void {
    this.outputRouter.invalidateAudioDeviceOptionsCache(reason)
  }

  private createDeviceCapabilityRefreshSignature(info: PlaybackInfo): string {
    return this.outputRouter.createDeviceCapabilityRefreshSignature(info)
  }

  async play(source: string, startTime = 0): Promise<AudioEnginePlayResult> {
    return this.playback.play(source, startTime)
  }

  async togglePause(): Promise<void> {
    return this.playback.togglePause()
  }

  async pause(): Promise<void> {
    return this.playback.pause()
  }

  async seek(time: number): Promise<void> {
    return this.playback.seek(time)
  }

  async setVolume(volume: number): Promise<void> {
    return this.playback.setVolume(volume)
  }

  async setPlaybackRate(rate: number): Promise<void> {
    if (this.processing.directMode) {
      this.directModePlaybackRateRestore = clampNumber(rate, 0.5, 2, 1)
      return this.playback.setPlaybackRate(1)
    }
    return this.playback.setPlaybackRate(rate)
  }

  async setLoopRange(startSeconds: number, endSeconds: number): Promise<boolean> {
    return this.playback.setLoopRange(startSeconds, endSeconds)
  }

  async stop(): Promise<void> {
    return this.playback.stop()
  }

  async loadQueue(items: AudioEngineQueueItem[], startIndex = 0): Promise<void> {
    return this.playback.loadQueue(items, startIndex)
  }

  async next(): Promise<void> {
    return this.playback.next()
  }

  async previous(): Promise<void> {
    return this.playback.previous()
  }

  async setPlayMode(mode: PlayMode): Promise<void> {
    return this.playback.setPlayMode(mode)
  }

  getUpcomingTrack(): AudioEngineQueueItem | null {
    return this.playback.getUpcomingTrack()
  }

  async getPlaybackInfo(): Promise<PlaybackInfo> {
    return this.playback.getPlaybackInfo()
  }

  getSpectrumData(points = 64): number[] {
    return this.playback.getSpectrumData(points)
  }

  getVisualizationData(options: VisualizationOptions = {}): VisualizationData {
    return this.playback.getVisualizationData(options)
  }

  private startClock(): void {
    this.playback.startClock()
  }

  private readNativePlaybackInfo(): PlaybackInfo | null {
    return this.playback.readNativePlaybackInfo()
  }

  private async readNativePlaybackInfoAsync(): Promise<PlaybackInfo | null> {
    return this.playback.readNativePlaybackInfoAsync()
  }

  private mergeNativePlaybackInfo(nativeInfo: PlaybackInfo): PlaybackInfo {
    return this.playback.mergeNativePlaybackInfo(nativeInfo)
  }

  private syncPlaybackOutputMirrorsFromOutputInfo(): void {
    this.playback.syncPlaybackOutputMirrorsFromOutputInfo()
  }

  /** Exposed for unit tests that drive the native playback clock. */
  tick(): void {
    this.playback.tick()
  }

  private invalidateUpcomingTrackCache(): void {
    this.playback.invalidateUpcomingTrackCache()
  }

  private publishPlaybackInfo(options: { dedupePositionOnly?: boolean } = {}): void {
    this.playback.publishPlaybackInfo(options)
  }

  destroy(): void {
    if (this.destroyed) return

    this.destroyed = true
    this.nativePlaybackActive = false
    this.playback.clearTimer()
    if (this.loudnessAnalysisManager) {
      this.loudnessAnalysisManager.cancel()
    }
    this.loudnormStatus = 'idle'
    this.loudnormStatusSource = null
    this.tryNative('销毁停止', (native) => native.Stop())
    this.audioServiceBinding?.destroy()
    this.audioServiceBinding = null
  }

  /**
   * After Settings clears the on-disk loudness cache: drop stale cached UI status
   * and re-prepare the current source so the next gain path is honest.
   */
  async notifyLoudnessCacheCleared(): Promise<void> {
    if (this.destroyed) return
    if (this.loudnessAnalysisManager) {
      this.loudnessAnalysisManager.cancel()
      this.loudnessAnalysisManager.clearFailures()
    }
    if (this.processing.volumeNormalization !== 'loudnorm') {
      this.loudnormStatus = 'idle'
      this.loudnormStatusSource = null
      this.emit('loudnorm-status', { status: 'idle' as LoudnormStatus, source: null })
      return
    }
    const source = this.playbackInfo.source?.trim()
    if (source) {
      await this.prepareLoudnormForPlay(source)
    } else {
      this.loudnormStatus = 'idle'
      this.loudnormStatusSource = null
      this.emit('loudnorm-status', { status: 'idle' as LoudnormStatus, source: null })
    }
  }

  updateNativeInfoSnapshot(): void {
    this.refreshOutputInfoFromNative(false)
  }

  private getCachedMetadata(source: string): {
    found: boolean
    metadata: NativeAudioMetadata | null
  } {
    const now = this.scheduler.now()
    const cached = this.metadataCache.get(source)
    if (!cached) {
      return { found: false, metadata: null }
    }
    if (now - cached.readAt > METADATA_CACHE_TTL_MS) {
      this.metadataCache.delete(source)
      return { found: false, metadata: null }
    }
    return { found: true, metadata: cached.metadata }
  }

  private cacheMetadata(source: string, metadata: NativeAudioMetadata | null): void {
    const now = this.scheduler.now()
    this.metadataCache.delete(source)
    this.metadataCache.set(source, {
      readAt: now,
      metadata
    })
    this.pruneMetadataCache(now)
  }

  private pruneMetadataCache(now: number): void {
    for (const [source, cached] of this.metadataCache.entries()) {
      if (now - cached.readAt > METADATA_CACHE_TTL_MS) {
        this.metadataCache.delete(source)
      }
    }
    while (this.metadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
      const oldestSource = this.metadataCache.keys().next().value as string | undefined
      if (!oldestSource) return
      this.metadataCache.delete(oldestSource)
    }
  }

  private tryNative(
    context: string,
    command: (native: NativeAudioBinding) => void,
    logFailure = true
  ): boolean {
    if (!this.native) {
      this.lastNativeError = '未加载 twilight_audio_node.node'
      return false
    }
    try {
      command(this.native)
      this.lastNativeError = ''
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastNativeError = message
      if (!logFailure) return false
      const fallbackHint = rendererFallbackAllowed()
        ? '使用临时播放通道'
        : '已阻止 HTMLAudio 静默降级'
      console.warn(`原生音频引擎${context}失败，${fallbackHint}：`, message)
      return false
    }
  }

  private async callNativeMaybeAsync(
    context: string,
    method: keyof NativeAudioBinding,
    ...args: unknown[]
  ): Promise<boolean> {
    if (!this.native) {
      this.lastNativeError = '未加载 twilight_audio_node.node'
      return false
    }
    if (typeof this.native.callAsync === 'function') {
      try {
        await this.native.callAsync(String(method), args)
        this.lastNativeError = ''
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.lastNativeError = message
        const fallbackHint = rendererFallbackAllowed()
          ? '使用临时播放通道'
          : '已阻止 HTMLAudio 静默降级'
        console.warn(`原生音频引擎${context}失败，${fallbackHint}：`, message)
        return false
      }
    }
    return this.tryNative(context, (native) => {
      const target = native[method]
      if (typeof target !== 'function') {
        throw new Error(`原生音频引擎不支持 ${String(method)}`)
      }
      ;(target as (...callArgs: unknown[]) => unknown).apply(native, args)
    })
  }

  private async applyDirectModeRuntimeOverrides(enabled: boolean): Promise<void> {
    if (enabled) {
      if (this.directModePlaybackRateRestore === null) {
        this.directModePlaybackRateRestore = this.playbackInfo.playbackRate ?? 1
      }
      await this.outputRouter.setDirectRoutingOverride(true)
      try {
        await this.playback.setPlaybackRate(1)
      } catch (error) {
        await this.outputRouter.setDirectRoutingOverride(false)
        this.directModePlaybackRateRestore = null
        throw error
      }
    } else {
      const restoreRate = this.directModePlaybackRateRestore ?? this.playbackInfo.playbackRate ?? 1
      await this.outputRouter.setDirectRoutingOverride(false)
      try {
        await this.playback.setPlaybackRate(restoreRate)
        this.directModePlaybackRateRestore = null
      } catch (error) {
        await this.outputRouter.setDirectRoutingOverride(true)
        throw error
      }
    }
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
  }

  private updateOutputPerfect(): void {
    if (this.nativePlaybackActive) {
      this.playbackInfo = this.playback.normalizePlaybackInfo(this.playbackInfo)
      return
    }

    const sceneState = this.dsp.getDspSceneState()
    const effectiveGraph = sceneState.effectiveGraph ?? sceneState.graph
    const sceneDspActive =
      graphHasEnabledProcessing(effectiveGraph) &&
      !(sceneState.requiresPcmFallback && this.processing.dsdOutputMode !== 'pcm')
    const crossfadeSeconds = this.processing.directMode ? 0 : this.processing.crossfadeSeconds
    const dspActive =
      sceneDspActive ||
      crossfadeSeconds > 0 ||
      Math.abs(this.playbackInfo.volume - 1) > 0.001 ||
      Math.abs((this.playbackInfo.playbackRate ?? 1) - 1) > 0.001
    const replayGainActive =
      !this.processing.directMode &&
      this.processing.dspEnabled &&
      this.processing.volumeNormalization !== 'off'
    const eqActive =
      !this.processing.directMode && this.processing.dspEnabled && this.processing.eqEnabled
    const convolverActive =
      !this.processing.directMode && this.processing.dspEnabled && this.playbackInfo.convolverActive
    const crossfeedActive =
      !this.processing.directMode &&
      this.processing.dspEnabled &&
      this.processing.crossfeedEnabled &&
      this.processing.crossfeedStrength > 0
    const crossfadeActive = crossfadeSeconds > 0
    const supportsOutputPerfect = this.playbackInfo.outputInfo.supportsOutputPerfect === true
    const outputFormatMatchesSource =
      this.playbackInfo.sourceSampleRate > 0 &&
      this.playbackInfo.outputSampleRate > 0 &&
      this.playbackInfo.sourceSampleRate === this.playbackInfo.outputSampleRate &&
      this.playbackInfo.sourceBitDepth > 0 &&
      this.playbackInfo.outputBitDepth > 0 &&
      this.playbackInfo.sourceBitDepth === this.playbackInfo.outputBitDepth
    const noResample = !this.playbackInfo.outputInfo.resampled
    const shared = (this.output === 'wasapi' || this.output === 'coreaudio') && !this.exclusiveMode
    const perfectReason =
      this.playbackInfo.outputInfo.perfectReason ||
      (shared
        ? '共享输出经过系统混音'
        : supportsOutputPerfect && !dspActive && noResample && outputFormatMatchesSource
          ? '当前 PCM 渲染路径尚未验证样本级直通'
          : '')
    const perfectReasonCode =
      this.playbackInfo.outputInfo.perfectReasonCode ||
      (shared ? 'shared_mixer' : perfectReason ? 'output_not_perfect' : '')
    this.playbackInfo.replayGainActive = replayGainActive
    this.playbackInfo.eqActive = eqActive
    this.playbackInfo.convolverActive = convolverActive
    this.playbackInfo.crossfeedActive = crossfeedActive
    this.playbackInfo.crossfeedStrength = crossfeedActive ? this.processing.crossfeedStrength : 0
    this.playbackInfo.crossfadeActive = crossfadeActive
    this.playbackInfo.crossfadeSeconds = crossfadeActive ? crossfadeSeconds : 0
    this.playbackInfo.dspActive = dspActive
    this.playbackInfo.outputInfo = {
      ...this.playbackInfo.outputInfo,
      exclusive:
        this.output === 'wasapi' || this.output === 'coreaudio'
          ? this.exclusiveMode
          : this.playbackInfo.outputInfo.exclusive,
      supportsOutputPerfect,
      sourceExact: false,
      outputPerfect: false,
      pcmPassthrough: false,
      resampled: this.nativePlaybackActive ? this.playbackInfo.outputInfo.resampled : false,
      accessMode:
        this.playbackInfo.outputInfo.accessMode ||
        (this.output === 'asio'
          ? 'exclusive'
          : this.output === 'wasapi' || this.output === 'coreaudio'
            ? this.exclusiveMode
              ? 'exclusive'
              : 'shared'
            : 'shared'),
      devicePathKind:
        this.playbackInfo.outputInfo.devicePathKind ||
        (this.output === 'asio' ? 'asio' : this.output === 'coreaudio' ? 'hal' : 'default'),
      perfectReasonCode,
      capabilityReason: this.playbackInfo.outputInfo.capabilityReason || perfectReason,
      perfectReason,
      outputSampleRate: this.playbackInfo.outputSampleRate,
      outputBitDepth: this.playbackInfo.outputBitDepth,
      backend: this.playbackInfo.outputBackend,
      actualBackend: this.playbackInfo.actualBackend || this.playbackInfo.outputBackend,
      deviceName: this.playbackInfo.outputInfo.deviceName || this.playbackInfo.outputDevice,
      actualDeviceName:
        this.playbackInfo.outputInfo.actualDeviceName ||
        this.playbackInfo.outputInfo.deviceName ||
        this.playbackInfo.outputDevice
    }
    this.syncPlaybackOutputMirrorsFromOutputInfo()
  }
}
