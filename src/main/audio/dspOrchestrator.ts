import {
  applyStereoImageToGraph,
  createLegacyDspGraph,
  extractStereoImageFromGraph,
  graphHasEnabledProcessing,
  mergeDspOutputStage,
  normalizeDspScenes,
  resolveDspScene,
  type DspGraphConfig,
  type DspGraphStatus,
  type DspOutputStageConfig,
  type DspScene,
  type DspSceneContext,
  type DspSceneState,
  type DspStereoImageConfig,
  type Vst3ScanDescriptor
} from '../../shared/dspGraph.ts'
import type { DspStatePayload } from '../../shared/audioServiceContract.ts'
import type {
  AudioEngineConfig,
  AudioEngineManagerDependencies,
  AudioEngineScheduler,
  AudioEngineServiceNativeBinding,
  AudioOutputId,
  AudioProcessingSettings,
  ConvolverInfo,
  EqMode,
  EqualizerBand,
  NativeAudioBinding,
  PlaybackInfo,
  VolumeNormalizationMode
} from './audioEngineTypes.ts'
import {
  CONVOLVER_INFO_CACHE_TTL_MS,
  NATIVE_DSP_PLUGIN_STATUS_CACHE_TTL_MS,
  audioProcessingSettingsEqual,
  isVst3ScanDescriptor,
  normalizeAudioProcessingSettings,
  parseDspGraphStatusOrThrow,
  parseNativeJson,
  resolveProcessingMasterState,
  sourceLooksDsd
} from './audioEngineHelpers.ts'

export interface DspOrchestratorHost {
  getNative(): NativeAudioBinding | null
  getAudioServiceBinding(): AudioEngineServiceNativeBinding | null
  getPlaybackInfo(): PlaybackInfo
  setPlaybackInfo(info: PlaybackInfo): void
  getDevice(): string
  getOutput(): AudioOutputId
  getLastNativeError(): string
  setLastNativeError(error: string): void
  getScheduler(): AudioEngineScheduler
  updateOutputPerfect(): void
  publishPlaybackInfo(): void
  syncPlaybackOutputMirrorsFromOutputInfo(): void
  updateNativeInfoSnapshot(): void
  syncLoudnormModeTransition(
    previousMode: VolumeNormalizationMode,
    nextMode: VolumeNormalizationMode
  ): Promise<void>
  applyDirectModeRuntimeOverrides(enabled: boolean): Promise<void>
  tryNative(context: string, action: (native: NativeAudioBinding) => void): boolean
}

export class DspOrchestrator {
  processing: AudioProcessingSettings
  dspScenes: DspScene[]
  dspPinnedSceneId: string | null
  activeDspSceneId: string | null = null
  activeDspGraph: DspGraphConfig
  dspGraphRevision = 0
  dspGraphAppliedRevision = 0
  dspGraphApplyState: NonNullable<DspGraphStatus['applyState']> = 'idle'
  dspGraphApplyError = ''
  lastNativeDspGraphStatus: DspGraphStatus | null = null
  nativeConvolverIrPath: string | null = null
  nativeDspPluginChainJson = ''
  readonly vst3RecoveryBypassReasons = new Map<string, string>()
  private readonly dspAssetPathResolver?: (assetId: string) => string | null
  private readonly vst3ModuleResolver?: AudioEngineManagerDependencies['vst3ModuleResolver']
  private readonly vst3StateAssetResolver?: AudioEngineManagerDependencies['vst3StateAssetResolver']
  private masterSwitchExplicit = false
  lastNativeDspPluginStatusCache: {
    readAt: number
    status: unknown
  } | null = null
  lastConvolverInfoCache: {
    readAt: number
    info: ConvolverInfo
  } | null = null

  private readonly host: DspOrchestratorHost

  constructor(
    host: DspOrchestratorHost,
    config: Pick<AudioEngineConfig, 'audioProcessing' | 'dspScenes' | 'dspPinnedSceneId'>,
    dependencies: Pick<
      AudioEngineManagerDependencies,
      'dspAssetPathResolver' | 'vst3ModuleResolver' | 'vst3StateAssetResolver'
    >
  ) {
    this.host = host
    this.dspAssetPathResolver = dependencies.dspAssetPathResolver
    this.vst3ModuleResolver = dependencies.vst3ModuleResolver
    this.vst3StateAssetResolver = dependencies.vst3StateAssetResolver
    const normalizedProcessing = normalizeAudioProcessingSettings(config.audioProcessing)
    const hasExplicitMasterSwitch =
      typeof config.audioProcessing?.dspEnabled === 'boolean' ||
      typeof config.audioProcessing?.directMode === 'boolean'
    this.masterSwitchExplicit = hasExplicitMasterSwitch
    const hasConfiguredProcessing =
      normalizedProcessing.eqEnabled ||
      normalizedProcessing.volumeNormalization !== 'off' ||
      normalizedProcessing.convolverEnabled ||
      normalizedProcessing.convolverIrPath.length > 0 ||
      (normalizedProcessing.crossfeedEnabled && normalizedProcessing.crossfeedStrength > 0) ||
      Math.abs(normalizedProcessing.eqPreamp) > 0.001 ||
      normalizedProcessing.dsdOutputMode === 'pcm' ||
      (Array.isArray(config.dspScenes) &&
        config.dspScenes.some((scene) => {
          const graph = scene && typeof scene === 'object' ? scene.graph : undefined
          return graph && graphHasEnabledProcessing(graph)
        }))
    // Pre-direct-mode settings did not always persist the master switch. Keep
    // those legacy module/scene configurations active, while an explicit false
    // remains an authoritative request to bypass every processing node. An
    // enabled processing module (for example EQ) also implies the graph must
    // run, so a stale persisted directMode never silently bypasses it.
    const { dspEnabled, directMode } = resolveProcessingMasterState(
      normalizedProcessing,
      undefined,
      normalizedProcessing.directMode
    )
    this.processing = {
      ...normalizedProcessing,
      dspEnabled: dspEnabled || (hasConfiguredProcessing && !hasExplicitMasterSwitch),
      directMode
    }
    this.dspScenes = normalizeDspScenes(config.dspScenes, this.processing)
    this.dspPinnedSceneId =
      typeof config.dspPinnedSceneId === 'string' &&
      this.dspScenes.some((scene) => scene.id === config.dspPinnedSceneId)
        ? config.dspPinnedSceneId
        : null
    this.activeDspGraph = createLegacyDspGraph(this.processing)
    this.refreshResolvedDspScene()
  }

  private get native(): NativeAudioBinding | null {
    return this.host.getNative()
  }

  private get audioServiceBinding(): AudioEngineServiceNativeBinding | null {
    return this.host.getAudioServiceBinding()
  }

  private get playbackInfo(): PlaybackInfo {
    return this.host.getPlaybackInfo()
  }

  private set playbackInfo(info: PlaybackInfo) {
    this.host.setPlaybackInfo(info)
  }

  private get device(): string {
    return this.host.getDevice()
  }

  private get output(): AudioOutputId {
    return this.host.getOutput()
  }

  private get lastNativeError(): string {
    return this.host.getLastNativeError()
  }

  private set lastNativeError(error: string) {
    this.host.setLastNativeError(error)
  }

  private get scheduler(): AudioEngineScheduler {
    return this.host.getScheduler()
  }

  private updateOutputPerfect(): void {
    this.host.updateOutputPerfect()
  }

  private publishPlaybackInfo(): void {
    this.host.publishPlaybackInfo()
  }

  private syncPlaybackOutputMirrorsFromOutputInfo(): void {
    this.host.syncPlaybackOutputMirrorsFromOutputInfo()
  }

  private updateNativeInfoSnapshot(): void {
    this.host.updateNativeInfoSnapshot()
  }

  private async syncLoudnormModeTransition(
    previousMode: VolumeNormalizationMode,
    nextMode: VolumeNormalizationMode
  ): Promise<void> {
    await this.host.syncLoudnormModeTransition(previousMode, nextMode)
  }

  private async applyDirectModeRuntimeOverrides(enabled: boolean): Promise<void> {
    await this.host.applyDirectModeRuntimeOverrides(enabled)
  }

  private tryNative(context: string, action: (native: NativeAudioBinding) => void): boolean {
    return this.host.tryNative(context, action)
  }

  resetAfterServiceCrash(reason: string): void {
    this.dspGraphAppliedRevision = 0
    this.dspGraphApplyState = 'failed'
    this.dspGraphApplyError = reason
    this.lastNativeDspGraphStatus = null
    this.nativeConvolverIrPath = null
    this.markActiveVst3NodesForManualRecovery()
  }

  private dspSceneContext(): DspSceneContext {
    const channels =
      this.playbackInfo.outputInfo.actualChannels ||
      this.playbackInfo.decodedChannels ||
      this.playbackInfo.channelCount ||
      2
    const channelLayout =
      channels <= 1 ? 'mono' : channels >= 8 ? '7.1' : channels >= 6 ? '5.1' : 'stereo'
    const sourceKind =
      sourceLooksDsd(this.playbackInfo.source) ||
      this.playbackInfo.codec.trim().toLowerCase() === 'dsd' ||
      this.playbackInfo.outputInfo.isDsd
        ? 'dsd'
        : 'pcm'
    return {
      deviceId: this.device,
      backend: this.output,
      channelLayout,
      sourceKind,
      sampleRate:
        this.playbackInfo.sourceSampleRate ||
        this.playbackInfo.decodedSampleRate ||
        this.playbackInfo.outputInfo.actualSampleRate ||
        48000
    }
  }

  refreshResolvedDspScene() {
    const resolution = resolveDspScene(
      this.dspScenes,
      this.dspSceneContext(),
      this.dspPinnedSceneId
    )
    this.activeDspSceneId = resolution.scene?.id ?? null
    this.activeDspGraph = resolution.graph
    return resolution
  }

  private cloneDspScenes(scenes: DspScene[]): DspScene[] {
    return scenes.map((scene) => ({
      ...scene,
      rules: { ...scene.rules },
      graph: {
        ...scene.graph,
        nodes: scene.graph.nodes.map((node) => ({
          ...node,
          params: { ...node.params },
          ...(node.vst3 ? { vst3: { ...node.vst3 } } : {})
        })),
        outputStage: { ...scene.graph.outputStage }
      }
    }))
  }

  private identityOutputStage(): DspOutputStageConfig {
    return {
      targetSampleRate: 'device',
      resamplerQuality: 'native',
      dither: 'off',
      safetyClamp: true
    }
  }

  private graphWithRuntimeModuleGates(graph: DspGraphConfig): DspGraphConfig {
    if (!this.processing.dspEnabled || this.processing.directMode) {
      return {
        version: graph.version,
        nodes: [],
        outputStage: this.identityOutputStage()
      }
    }

    const nodes = graph.nodes.map((node) => {
      let enabled = node.enabled
      switch (node.type) {
        case 'replayGain':
          enabled &&= this.processing.volumeNormalization !== 'off'
          break
        case 'equalizer':
          enabled &&= this.processing.eqEnabled
          break
        case 'convolver':
          enabled &&= this.processing.convolverEnabled
          break
        case 'crossfeed':
          enabled &&= this.processing.crossfeedEnabled && this.processing.crossfeedStrength > 0
          break
        case 'meter':
          enabled &&= this.processing.fftEnabled
          break
        default:
          break
      }
      return enabled === node.enabled ? node : { ...node, enabled }
    })
    return { ...graph, nodes }
  }

  private maybeEnableLegacyDsp(graph: DspGraphConfig | undefined): void {
    if (
      this.masterSwitchExplicit ||
      this.processing.directMode ||
      this.processing.dspEnabled ||
      !graph ||
      !graphHasEnabledProcessing(graph)
    ) {
      return
    }
    this.processing = { ...this.processing, dspEnabled: true }
  }

  private effectiveProcessingForPayload(): AudioProcessingSettings {
    if (this.processing.dspEnabled && !this.processing.directMode) return this.processing
    return {
      ...this.processing,
      // FFT is a read-only observation tap. Keep it independent from the DSP
      // master/direct bypass so visualization can inspect PCM without changing it.
      dspEnabled: false,
      fftEnabled: this.processing.fftEnabled,
      eqEnabled: false,
      volumeNormalization: 'off',
      convolverEnabled: false,
      crossfeedEnabled: false,
      crossfeedStrength: 0,
      crossfadeSeconds: 0
    }
  }

  private graphPayload(revision = this.dspGraphRevision) {
    const resolution = this.refreshResolvedDspScene()
    const dsdPcmFallbackApplied =
      resolution.requiresPcmFallback &&
      resolution.scene?.allowDsdPcmFallback === true &&
      this.processing.dsdOutputMode === 'pcm'
    const directBypass = this.processing.directMode
    const masterBypass = !this.processing.dspEnabled
    const dsdBypass = resolution.requiresPcmFallback && !dsdPcmFallbackApplied
    const bypassReason = directBypass
      ? 'Direct mode bypasses the DSP graph and output stage'
      : masterBypass
        ? 'DSP master bypass is active'
        : dsdBypass
          ? 'DSD Direct requires explicit PCM fallback before DSP can run'
          : ''
    const graph: DspGraphConfig =
      bypassReason.length > 0
        ? {
            version: this.activeDspGraph.version,
            nodes: [],
            outputStage: this.identityOutputStage()
          }
        : this.materializeGraphAssets(this.graphWithRuntimeModuleGates(this.activeDspGraph))
    return {
      revision,
      sceneId: resolution.scene?.id ?? null,
      graph,
      bypassReason,
      requiresPcmFallback: dsdBypass,
      dsdPcmFallbackApplied
    }
  }

  private dspStatePayload(revision: number): DspStatePayload {
    return {
      ...this.graphPayload(revision),
      revision,
      graphUpdateMode: 'replace',
      processing: { ...this.effectiveProcessingForPayload() }
    }
  }

  private materializeGraphAssets(graph: DspGraphConfig): DspGraphConfig {
    if (
      !this.dspAssetPathResolver &&
      !this.vst3ModuleResolver &&
      !graph.nodes.some((node) => node.type === 'vst3Plugin')
    ) {
      return graph
    }
    let changed = false
    const nodes = graph.nodes.map((node) => {
      let params = node.params
      const assetId = node.params.impulseResponseAssetId
      if (typeof assetId === 'string') {
        const path = this.dspAssetPathResolver?.(assetId)
        if (path && params.impulseResponsePath !== path) {
          params = { ...params, impulseResponsePath: path }
          changed = true
        }
      }
      if (node.type !== 'vst3Plugin') {
        return params === node.params ? node : { ...node, params }
      }

      // These values are materialized only in main memory immediately before
      // native dispatch. Persisted renderer configuration can reference a
      // catalog ID, never an arbitrary filesystem module path.
      const {
        vst3ModulePath: _ignoredModulePath,
        vst3ClassId: _ignoredClassId,
        vst3StatePath: _ignoredStatePath,
        vst3StateFormat: _ignoredStateFormat,
        vst3BypassReason: _ignoredBypassReason,
        ...safeParams
      } = params
      const reference = node.vst3
      const resolution = reference
        ? this.vst3ModuleResolver?.(reference.catalogId, reference.classId)
        : undefined
      const stateResolution = reference?.stateAssetId
        ? this.vst3StateAssetResolver?.(reference.stateAssetId)
        : undefined
      const bypassReason =
        (reference ? this.vst3RecoveryBypassReasons.get(reference.catalogId) : '') ||
        (!resolution?.modulePath
          ? resolution?.reason ||
            (reference
              ? 'VST3 catalog resolution is unavailable'
              : 'VST3 graph nodes require a managed catalog reference')
          : reference?.stateAssetId && !stateResolution?.path
            ? stateResolution?.reason || 'VST3 state asset resolution is unavailable'
            : '')
      const resolvedParams = bypassReason
        ? { ...safeParams, vst3BypassReason: bypassReason }
        : {
            ...safeParams,
            vst3ModulePath: resolution?.modulePath ?? '',
            vst3ClassId: resolution?.classId ?? reference?.classId ?? '',
            ...(stateResolution?.path
              ? {
                  vst3StatePath: stateResolution.path,
                  vst3StateFormat:
                    stateResolution.kind === 'vst3Preset' ? 'preset' : 'componentState'
                }
              : {})
          }
      changed = true
      return { ...node, params: resolvedParams }
    })
    return changed ? { ...graph, nodes } : graph
  }

  refreshDspGraph(): void {
    void this.applyNativeDspGraph('刷新 DSP 场景资料解析')
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
  }

  /** Called after a listener explicitly clears a VST3 quarantine. */
  clearVst3RecoveryBypass(catalogId?: string): void {
    const normalizedCatalogId = typeof catalogId === 'string' ? catalogId.trim() : ''
    if (normalizedCatalogId) {
      this.vst3RecoveryBypassReasons.delete(normalizedCatalogId)
      return
    }
    this.vst3RecoveryBypassReasons.clear()
  }

  markActiveVst3NodesForManualRecovery(): void {
    const reason = 'VST3 node is bypassed after an audio service crash; re-enable it manually'
    for (const node of this.activeDspGraph.nodes) {
      const catalogId =
        node.type === 'vst3Plugin' && node.enabled ? node.vst3?.catalogId.trim() : ''
      if (catalogId) this.vst3RecoveryBypassReasons.set(catalogId, reason)
    }
  }

  private createDspGraphStatusFallback(): DspGraphStatus {
    const payload = this.graphPayload(this.dspGraphAppliedRevision)
    return {
      revision: this.dspGraphAppliedRevision,
      activeSceneId: this.activeDspSceneId,
      totalLatencyFrames: 0,
      totalTailFrames: 0,
      nodes: payload.graph.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        enabled: node.enabled,
        active: false,
        bypassed: false,
        bypassReason: '',
        latencyFrames: 0,
        tailFrames: 0,
        processCalls: 0,
        lastProcessMs: 0,
        maxProcessMs: 0
      }))
    }
  }

  private decorateDspGraphStatus(status: DspGraphStatus): DspGraphStatus {
    return {
      ...status,
      requestedRevision: this.dspGraphRevision,
      appliedRevision: this.dspGraphAppliedRevision,
      applyState: this.dspGraphApplyState,
      applyError: this.dspGraphApplyError
    }
  }

  private observeNativeDspGraphStatus(status: DspGraphStatus): void {
    if (
      !this.lastNativeDspGraphStatus ||
      status.revision >= this.lastNativeDspGraphStatus.revision
    ) {
      this.lastNativeDspGraphStatus = status
    }
    this.dspGraphAppliedRevision = Math.max(this.dspGraphAppliedRevision, status.revision)
    if (status.revision >= this.dspGraphRevision && this.dspGraphRevision > 0) {
      this.dspGraphApplyState = 'applied'
      this.dspGraphApplyError = ''
    }
  }

  async applyNativeDspGraph(context: string): Promise<DspGraphStatus> {
    const revision = ++this.dspGraphRevision
    const payload = this.dspStatePayload(revision)
    this.dspGraphApplyState = 'pending'
    this.dspGraphApplyError = ''
    try {
      const native = this.native
      if (!native) throw new Error('未加载 twilight_audio_node.node')
      let status: DspGraphStatus
      if (this.audioServiceBinding) {
        status = await this.audioServiceBinding.applyDspState(revision, payload)
      } else {
        if (
          typeof native.ApplyDspState !== 'function' ||
          typeof native.GetDspGraphStatus !== 'function'
        ) {
          throw new Error(
            'native audio binding is missing required DSP methods: ApplyDspState, GetDspGraphStatus'
          )
        }
        native.ApplyDspState(revision, JSON.stringify(payload))
        status = await this.waitForDirectNativeDspRevision(revision, native)
      }
      if (status.revision < revision) {
        throw new Error(
          `DSP graph ACK revision mismatch: requested ${revision}, applied ${status.revision}`
        )
      }
      if (status.compileState === 'failed') {
        throw new Error(status.compileError || `DSP graph revision ${revision} failed to compile`)
      }
      this.observeNativeDspGraphStatus(status)
      this.lastNativeError = ''
      return this.decorateDspGraphStatus(status)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (revision === this.dspGraphRevision) {
        this.dspGraphApplyState = 'failed'
        this.dspGraphApplyError = message
      }
      this.lastNativeError = message
      console.warn(`原生音频引擎${context}失败：`, message)
      return this.decorateDspGraphStatus(
        this.lastNativeDspGraphStatus ?? this.createDspGraphStatusFallback()
      )
    }
  }

  private async waitForDirectNativeDspRevision(
    revision: number,
    native: NativeAudioBinding
  ): Promise<DspGraphStatus> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = parseDspGraphStatusOrThrow(native.GetDspGraphStatus())
      if (status.revision >= revision) return status
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`DSP graph ACK revision mismatch: requested ${revision}`)
  }

  async applyNativeDspGraphOrThrow(context: string): Promise<DspGraphStatus> {
    const status = await this.applyNativeDspGraph(context)
    if (status.applyState === 'failed') {
      throw new Error(status.applyError || `${context}失败`)
    }
    return status
  }

  getDspSceneState(): DspSceneState {
    const payload = this.graphPayload()
    return {
      scenes: this.dspScenes,
      pinnedSceneId: this.dspPinnedSceneId,
      activeSceneId: payload.sceneId,
      graph: this.activeDspGraph,
      effectiveGraph: payload.graph,
      effectiveBypassReason: payload.bypassReason,
      directMode: this.processing.directMode,
      requiresPcmFallback: payload.requiresPcmFallback,
      dsdPcmFallbackApplied: payload.dsdPcmFallbackApplied
    }
  }

  async setDspScenes(
    scenes: DspScene[],
    pinnedSceneId: string | null = this.dspPinnedSceneId
  ): Promise<DspSceneState> {
    const previousScenes = this.cloneDspScenes(this.dspScenes)
    const previousPinnedSceneId = this.dspPinnedSceneId
    const previousProcessing = this.processing
    const previousSceneById = new Map(this.dspScenes.map((scene) => [scene.id, scene]))
    this.dspScenes = normalizeDspScenes(scenes, this.processing)
    for (const scene of this.dspScenes) {
      const previous = previousSceneById.get(scene.id)
      // A confirmation applies to the exact graph the listener heard. Editing
      // that graph, importing a new scene, or restoring an older draft always
      // asks again before a DSD Direct/DoP path can become PCM processing.
      if (
        previous?.allowDsdPcmFallback !== true ||
        JSON.stringify(previous.graph) !== JSON.stringify(scene.graph)
      ) {
        delete scene.allowDsdPcmFallback
      }
    }
    this.dspPinnedSceneId =
      typeof pinnedSceneId === 'string' &&
      this.dspScenes.some((scene) => scene.id === pinnedSceneId)
        ? pinnedSceneId
        : null
    const selectedGraph = this.dspScenes.find((scene) => scene.id === this.dspPinnedSceneId)?.graph
    this.maybeEnableLegacyDsp(selectedGraph ?? this.dspScenes[0]?.graph)
    try {
      await this.applyNativeDspGraphOrThrow('更新 DSP 场景')
    } catch (error) {
      this.dspScenes = previousScenes
      this.dspPinnedSceneId = previousPinnedSceneId
      this.processing = previousProcessing
      await this.applyNativeDspGraph('DSP 场景回滚')
      throw error
    }
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
    return this.getDspSceneState()
  }

  /**
   * Thin HiFi / console wrapper: patch default scene graph.outputStage and fan out SetDspGraph.
   * Does not invent OutputConfig fields; rate lock lives only on the DSP graph output stage.
   */
  async setOutputStage(partial: Partial<DspOutputStageConfig>): Promise<DspSceneState> {
    const previousScenes = this.cloneDspScenes(this.dspScenes)
    const previousProcessing = this.processing
    const defaultScene = this.dspScenes.find((scene) => scene.id === 'default')
    if (!defaultScene) {
      this.dspScenes = normalizeDspScenes(this.dspScenes, {
        ...this.processing,
        outputStage: mergeDspOutputStage(undefined, partial)
      })
    } else {
      defaultScene.graph = {
        ...defaultScene.graph,
        outputStage: mergeDspOutputStage(defaultScene.graph.outputStage, partial)
      }
      // Editing output stage invalidates any prior DSD PCM-fallback confirmation.
      delete defaultScene.allowDsdPcmFallback
    }
    this.maybeEnableLegacyDsp(this.dspScenes.find((scene) => scene.id === 'default')?.graph)
    try {
      await this.applyNativeDspGraphOrThrow('更新输出采样率锁')
    } catch (error) {
      this.dspScenes = previousScenes
      this.processing = previousProcessing
      await this.applyNativeDspGraph('输出级回滚')
      throw error
    }
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
    return this.getDspSceneState()
  }

  getOutputStage(): DspOutputStageConfig {
    const defaultScene = this.dspScenes.find((scene) => scene.id === 'default')
    return mergeDspOutputStage(defaultScene?.graph.outputStage, {})
  }

  /**
   * Thin HiFi wrapper: patch default-scene stereoField + channelStrip polarity.
   * Does not invent classic audioProcessing fields — balance/phase live on the graph.
   */
  async setStereoImage(partial: Partial<DspStereoImageConfig>): Promise<DspSceneState> {
    const previousScenes = this.cloneDspScenes(this.dspScenes)
    const previousProcessing = this.processing
    const defaultScene = this.dspScenes.find((scene) => scene.id === 'default')
    if (!defaultScene) {
      this.dspScenes = normalizeDspScenes(this.dspScenes, {
        ...this.processing,
        stereoImage: partial
      })
    } else {
      defaultScene.graph = applyStereoImageToGraph(defaultScene.graph, partial)
      delete defaultScene.allowDsdPcmFallback
    }
    this.maybeEnableLegacyDsp(this.dspScenes.find((scene) => scene.id === 'default')?.graph)
    try {
      await this.applyNativeDspGraphOrThrow('更新立体声平衡/相位')
    } catch (error) {
      this.dspScenes = previousScenes
      this.processing = previousProcessing
      await this.applyNativeDspGraph('立体声图回滚')
      throw error
    }
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
    return this.getDspSceneState()
  }

  getStereoImage(): DspStereoImageConfig {
    const defaultScene = this.dspScenes.find((scene) => scene.id === 'default')
    return extractStereoImageFromGraph(defaultScene?.graph)
  }

  async applyDspScene(
    sceneId: string | null,
    confirmDsdPcmFallback = false
  ): Promise<DspSceneState> {
    this.dspPinnedSceneId =
      typeof sceneId === 'string' && this.dspScenes.some((scene) => scene.id === sceneId)
        ? sceneId
        : null
    const state = this.getDspSceneState()
    if (state.requiresPcmFallback && !state.dsdPcmFallbackApplied) {
      if (!confirmDsdPcmFallback) {
        await this.applyNativeDspGraphOrThrow('保留 DSD Direct/DoP 并旁路 DSP 场景')
        this.updateOutputPerfect()
        this.publishPlaybackInfo()
        return this.getDspSceneState()
      }
      const scene = this.dspScenes.find((candidate) => candidate.id === state.activeSceneId)
      if (!scene) return state
      scene.allowDsdPcmFallback = true
      const previousProcessing = this.processing
      this.processing = this.mergeAudioProcessingSettings({ dsdOutputMode: 'pcm', dsdToPcm: true })
      await this.applyNativeDspSettings('确认 DSD PCM DSP 回退', { previousProcessing })
    } else {
      await this.applyNativeDspGraphOrThrow('应用 DSP 场景')
    }
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
    return this.getDspSceneState()
  }

  async getDspGraphStatus(): Promise<DspGraphStatus> {
    try {
      let status: DspGraphStatus
      if (this.audioServiceBinding) {
        status = await this.audioServiceBinding.getDspGraphStatusAsync()
      } else if (this.native && typeof this.native.GetDspGraphStatus === 'function') {
        status = parseDspGraphStatusOrThrow(this.native.GetDspGraphStatus())
      } else {
        throw new Error('native audio binding does not support GetDspGraphStatus')
      }
      this.observeNativeDspGraphStatus(status)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.dspGraphApplyState = 'failed'
      this.dspGraphApplyError = message
      this.lastNativeError = message
    }
    return this.decorateDspGraphStatus(
      this.lastNativeDspGraphStatus ?? this.createDspGraphStatusFallback()
    )
  }

  async scanVst3Module(modulePath: string): Promise<Vst3ScanDescriptor> {
    const native = this.native
    if (!native) throw new Error('未加载 twilight_audio_node.node')
    let raw: string | Vst3ScanDescriptor | undefined
    try {
      raw =
        typeof native.callAsync === 'function'
          ? ((await native.callAsync('ScanVst3Module', [modulePath])) as
              | string
              | Vst3ScanDescriptor)
          : native.ScanVst3Module?.(modulePath)
    } catch (error) {
      this.lastNativeError = error instanceof Error ? error.message : String(error)
      throw new Error(this.lastNativeError)
    }
    const descriptor = parseNativeJson<Vst3ScanDescriptor | null>(raw, null)
    if (!isVst3ScanDescriptor(descriptor)) {
      throw new Error('原生音频引擎未返回有效 VST3 描述')
    }
    this.lastNativeError = ''
    return {
      classId: descriptor.classId.trim(),
      name: descriptor.name.trim(),
      vendor: descriptor.vendor.trim(),
      version: descriptor.version.trim(),
      ...(descriptor.category ? { category: descriptor.category.trim() } : {}),
      ...(Array.isArray(descriptor.supportedLayouts)
        ? { supportedLayouts: [...descriptor.supportedLayouts] }
        : {}),
      ...(Array.isArray(descriptor.parameters)
        ? { parameters: descriptor.parameters.map((parameter) => ({ ...parameter })) }
        : {})
    }
  }

  async setAudioProcessing(
    settings: Partial<AudioProcessingSettings>
  ): Promise<AudioProcessingSettings> {
    const previousMode = this.processing.volumeNormalization
    const previousMasterSwitchExplicit = this.masterSwitchExplicit
    if (typeof settings.dspEnabled === 'boolean' || typeof settings.directMode === 'boolean') {
      this.masterSwitchExplicit = true
    }
    const nextProcessing = this.mergeAudioProcessingSettings(settings)
    if (audioProcessingSettingsEqual(nextProcessing, this.processing)) return this.processing

    const previousProcessing = this.processing
    const defaultScene = this.dspScenes.find((scene) => scene.id === 'default')
    const previousDefaultGraph = defaultScene?.graph
    const previousOutputInfo = this.playbackInfo.outputInfo
    const directModeChanged = previousProcessing.directMode !== nextProcessing.directMode

    // Restore the saved rate/routing before the stored graph can become active again.
    if (previousProcessing.directMode && !nextProcessing.directMode) {
      await this.applyDirectModeRuntimeOverrides(false)
    }

    this.processing = nextProcessing
    if (defaultScene) {
      // Preserve HiFi sample-rate lock and balance/phase when rewriting the legacy graph.
      defaultScene.graph = createLegacyDspGraph({
        ...this.processing,
        outputStage: defaultScene.graph.outputStage,
        stereoImage: extractStereoImageFromGraph(defaultScene.graph)
      })
    }
    const sourceIsDsd =
      sourceLooksDsd(this.playbackInfo.source) ||
      this.playbackInfo.codec.trim().toLowerCase() === 'dsd' ||
      this.playbackInfo.outputInfo.isDsd === true

    if (sourceIsDsd) {
      // dsdMode 保留引擎报告的实际传输（native/dop/pcm）；这里只维护源描述字段与
      // 强制 PCM 的提示，避免把请求模式当成已生效链路盖掉引擎事实。
      const isForcedPcm = this.processing.dsdOutputMode === 'pcm'

      this.playbackInfo.outputInfo = {
        ...this.playbackInfo.outputInfo,
        isDsd: true,
        dsdRate: this.playbackInfo.outputInfo.dsdRate || this.playbackInfo.dsdRate || 0,
        perfectReasonCode: isForcedPcm
          ? 'dsd_converted_to_pcm'
          : this.playbackInfo.outputInfo.perfectReasonCode === 'dsd_converted_to_pcm'
            ? ''
            : this.playbackInfo.outputInfo.perfectReasonCode,
        perfectReason: isForcedPcm
          ? 'DSD 当前已转换为 PCM 输出'
          : this.playbackInfo.outputInfo.perfectReason === 'DSD 当前已转换为 PCM 输出'
            ? ''
            : this.playbackInfo.outputInfo.perfectReason,
        capabilityReason: isForcedPcm
          ? 'DSD 当前已转换为 PCM 输出'
          : this.playbackInfo.outputInfo.capabilityReason === 'DSD 当前已转换为 PCM 输出'
            ? ''
            : this.playbackInfo.outputInfo.capabilityReason
      }
      this.syncPlaybackOutputMirrorsFromOutputInfo()
    }
    try {
      if (!previousProcessing.directMode && nextProcessing.directMode) {
        this.syncNativeDspPluginChain()
      }
      await this.applyNativeDspSettings('更新 DSP 配置', { previousProcessing })
      if (!previousProcessing.directMode && nextProcessing.directMode) {
        await this.applyDirectModeRuntimeOverrides(true)
      }
      if (previousProcessing.directMode && !nextProcessing.directMode) {
        this.syncNativeDspPluginChain()
      }
    } catch (error) {
      this.masterSwitchExplicit = previousMasterSwitchExplicit
      this.processing = previousProcessing
      if (defaultScene && previousDefaultGraph) defaultScene.graph = previousDefaultGraph
      this.playbackInfo.outputInfo = previousOutputInfo
      if (directModeChanged) {
        try {
          await this.applyDirectModeRuntimeOverrides(previousProcessing.directMode)
        } catch {
          // The following graph rollback remains authoritative if a route ACK also fails.
        }
      }
      this.syncNativeDspPluginChain()
      await this.applyNativeDspGraph('DSP configuration rollback')
      this.updateOutputPerfect()
      this.publishPlaybackInfo()
      throw error
    }
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
    await this.syncLoudnormModeTransition(previousMode, this.processing.volumeNormalization)
    return this.processing
  }

  getAudioProcessing(): AudioProcessingSettings {
    return this.processing
  }

  async loadImpulseResponse(path: string): Promise<ConvolverInfo> {
    await this.setAudioProcessing({
      convolverEnabled: true,
      convolverIrPath: path
    })
    this.lastConvolverInfoCache = null
    this.updateNativeInfoSnapshot()
    return this.getConvolverInfo()
  }

  async unloadImpulseResponse(): Promise<ConvolverInfo> {
    const nextProcessing = this.mergeAudioProcessingSettings({
      convolverEnabled: false,
      convolverIrPath: ''
    })
    if (audioProcessingSettingsEqual(nextProcessing, this.processing))
      return this.getConvolverInfo()

    await this.setAudioProcessing(nextProcessing)
    this.lastConvolverInfoCache = null
    this.updateNativeInfoSnapshot()
    return this.getConvolverInfo()
  }

  getConvolverInfo(): ConvolverInfo {
    const canUseIdleCache = !this.processing.convolverIrPath && !this.nativeConvolverIrPath
    const now = this.scheduler.now()
    const cached = this.lastConvolverInfoCache
    if (canUseIdleCache && cached && now - cached.readAt <= CONVOLVER_INFO_CACHE_TTL_MS) {
      return cached.info
    }
    const info = parseNativeJson(this.native?.GetConvolverInfo?.(), {
      loaded: false,
      active: false,
      bypassed: false,
      irResampled: false,
      path: '',
      sampleRate: 0,
      channels: 0,
      lengthFrames: 0,
      lengthMs: 0,
      partitionSize: 0,
      latencyFrames: 0,
      overrunCount: 0,
      bypassCount: 0,
      lastProcessMs: 0,
      maxProcessMs: 0,
      channelMappingMode: '',
      warning: '',
      lastError: ''
    })
    if (canUseIdleCache && !info.loaded && !info.active) {
      this.lastConvolverInfoCache = {
        readAt: now,
        info
      }
    }
    return info
  }

  async setEqBands(settings: Partial<AudioProcessingSettings>): Promise<AudioProcessingSettings> {
    return this.setAudioProcessing(settings)
  }

  async setEqPreset(preset: {
    eqMode: EqMode
    eqPreamp: number
    eqBands: EqualizerBand[]
  }): Promise<AudioProcessingSettings> {
    return this.setAudioProcessing({
      ...preset,
      eqEnabled: true
    })
  }

  async setCrossfeedStrength(strength: number): Promise<AudioProcessingSettings> {
    return this.setAudioProcessing({
      crossfeedEnabled: strength > 0,
      crossfeedStrength: strength
    })
  }

  async setReplayGainMode(
    mode: VolumeNormalizationMode,
    preamp = this.processing.replayGainPreamp,
    fallback = this.processing.replayGainFallback,
    clip = this.processing.replayGainClip
  ): Promise<AudioProcessingSettings> {
    // Route through setAudioProcessing so default-scene graph + dual DSP path stay aligned.
    return this.setAudioProcessing({
      volumeNormalization: mode,
      replayGainPreamp: preamp,
      replayGainFallback: fallback,
      replayGainClip: clip
    })
  }

  setNativeDspPluginChain(chainJson: string): void {
    if (chainJson === this.nativeDspPluginChainJson) return

    this.nativeDspPluginChainJson = chainJson
    this.lastNativeDspPluginStatusCache = null
    this.syncNativeDspPluginChain()
  }

  getEffectiveNativeDspPluginChainJson(): string {
    return this.processing.directMode ? '{"plugins":[]}' : this.nativeDspPluginChainJson
  }

  private syncNativeDspPluginChain(): void {
    const chainJson = this.getEffectiveNativeDspPluginChainJson()
    this.tryNative('更新原生 DSP 插件链', (native) => {
      native.SetDspPluginChain?.(chainJson)
    })
  }

  getNativeDspPluginStatus(): unknown {
    const now = this.scheduler.now()
    const cached = this.lastNativeDspPluginStatusCache
    if (cached && now - cached.readAt <= NATIVE_DSP_PLUGIN_STATUS_CACHE_TTL_MS) {
      return cached.status
    }
    const status = parseNativeJson(this.native?.GetDspPluginStatus?.(), { plugins: [] })
    this.lastNativeDspPluginStatusCache = {
      readAt: now,
      status
    }
    return status
  }

  private mergeAudioProcessingSettings(
    settings: Partial<AudioProcessingSettings>
  ): AudioProcessingSettings {
    const normalized = normalizeAudioProcessingSettings({ ...this.processing, ...settings })
    const { dspEnabled, directMode } = resolveProcessingMasterState(
      normalized,
      settings.dspEnabled,
      settings.directMode
    )
    return {
      ...normalized,
      directMode,
      dspEnabled
    }
  }

  applyNativeDspSettings(
    context: string,
    _options: { previousProcessing?: AudioProcessingSettings } = {},
    throwOnGraphFailure = true
  ): Promise<DspGraphStatus> {
    const application = throwOnGraphFailure
      ? this.applyNativeDspGraphOrThrow(context)
      : this.applyNativeDspGraph(context)
    return application.then((status) => {
      if (status.applyState === 'applied') {
        this.nativeConvolverIrPath = this.processing.convolverIrPath
      }
      return status
    })
  }
}
