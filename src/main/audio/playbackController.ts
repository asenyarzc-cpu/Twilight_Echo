import type {
  AudioEnginePlayResult,
  AudioEngineQueueItem,
  AudioEngineScheduler,
  AudioEngineServiceNativeBinding,
  AudioOutputId,
  AudioProcessingSettings,
  NativeAudioBinding,
  OutputConfig,
  OutputInfo,
  PlaybackInfo,
  PlayMode,
  VisualizationData,
  VisualizationOptions
} from './audioEngineTypes.ts'
import {
  PLAYBACK_INFO_CACHE_TTL_MS,
  UPCOMING_TRACK_CACHE_TTL_MS,
  VISUALIZATION_CACHE_TTL_MS,
  advanceSoftPlaybackPosition,
  clampNumber,
  clampQueueItemPosition,
  createFallbackVisualizationData,
  createInactiveVisualizationData,
  createPlaybackInfoFanoutSignature,
  getAlsaPlaybackDeviceCandidates,
  inferCodec,
  nativePlayMode,
  normalizeDsdState,
  normalizeOutputConversionInfo,
  normalizeOutputProviderImplementation,
  normalizeVisualizationData,
  normalizeVisualizationOptions,
  parseNativeJson,
  resolveQueueIndexForSource,
  sourceLooksDsd,
  withPrecomputedVisualizerBars
} from './audioEngineHelpers.ts'
import { playModeWrapsAtQueueEnd } from '../../shared/playbackModes.ts'
import { audioEngineError, nativeAudioError } from './engineErrors.ts'
import { rendererFallbackAllowed } from './nativeBinding.ts'
import type { DspGraphConfig } from '../../shared/dspGraph.ts'

export interface PlaybackControllerHost {
  getNative(): NativeAudioBinding | null
  getAudioServiceBinding(): AudioEngineServiceNativeBinding | null
  getScheduler(): AudioEngineScheduler
  getLastNativeError(): string
  setLastNativeError(error: string): void
  isDestroyed(): boolean
  getNativePlaybackActive(): boolean
  setNativePlaybackActive(value: boolean): void
  getNativeOutputRouteSynced(): boolean
  setNativeOutputRouteSynced(value: boolean): void
  getPendingNativeSource(): string | null
  setPendingNativeSource(value: string | null): void
  getOutput(): AudioOutputId
  setOutput(value: AudioOutputId): void
  getDevice(): string
  setDevice(value: string): void
  getExclusiveMode(): boolean
  setExclusiveMode(value: boolean): void
  getOutputConfig(): OutputConfig
  setOutputConfig(value: OutputConfig): void
  createDeviceCapabilityRefreshSignature(info: PlaybackInfo): string
  invalidateAudioDeviceOptionsCache(reason: string): void
  getProcessing(): AudioProcessingSettings
  getActiveDspGraph(): DspGraphConfig
  getNativeBackendId(): string
  shouldFallbackFromAsio(output: AudioOutputId): boolean
  restoreAudioServiceOutputRoute(
    contextPrefix?: string
  ): Promise<{ synced: boolean; errors: string[] }>
  applyNativeDspGraph(context: string): Promise<unknown>
  applyNativeDspGraphOrThrow(context: string): Promise<unknown>
  applyNativeDspSettings(
    context: string,
    options?: { previousProcessing?: AudioProcessingSettings },
    throwOnGraphFailure?: boolean
  ): Promise<unknown>
  refreshResolvedDspScene(): {
    graph: DspGraphConfig
    requiresPcmFallback: boolean
    scene?: { id?: string } | null
  }
  updateOutputPerfect(): void
  refreshOutputInfoFromNative(resetDefaults: boolean): void
  pollAudioDeviceOptionsForChanges(): void
  prepareLoudnormForPlay(source: string): Promise<void>
  tryNative(
    context: string,
    command: (native: NativeAudioBinding) => void,
    logFailure?: boolean
  ): boolean
  isNativeVolumeSynced(): boolean
  markNativeVolumeSynced(value: boolean): void
  canVerifyNativeVolume(): boolean
  callNativeMaybeAsync(
    context: string,
    method: keyof NativeAudioBinding,
    ...args: unknown[]
  ): Promise<boolean>
  emit(event: string, payload?: unknown): void
}

// While paused/stopped with no in-flight transition the native state cannot
// advance on its own, so the 250ms tick only refreshes the service cache every
// Nth tick; demand reads (getPlaybackInfo) still bypass this via the TTL gate.
const NATIVE_IDLE_POLL_INTERVAL_TICKS = 4

export class PlaybackController {
  queue: AudioEngineQueueItem[] = []
  queueJson = '[]'
  playbackInfo: PlaybackInfo
  timer: NodeJS.Timeout | null = null
  lastTick = 0
  lastNativePlaybackInfoTickReadAt = Number.NEGATIVE_INFINITY
  nativeIdlePollTick = 0
  lastNativeReportedPosition = Number.NaN
  pendingNativePositionTarget: number | null = null
  nativeConfigRevisionObserved = false
  nativeConfigRevisionEpochPending = false
  lastRawRequestedConfigRevision = 0
  lastRawAppliedConfigRevision = 0
  configRevisionBase = 0
  publicRequestedConfigRevision = 0
  publicAppliedConfigRevision = 0
  lastEmittedAppliedConfigRevision = 0
  pendingConfigAppliedEvent: {
    requestedConfigRevision: number
    appliedConfigRevision: number
  } | null = null
  lastPlaybackInfoFanoutKey = ''
  lastPublishedDuration: number | null = null
  lastVisualizationCache: {
    key: string
    state: PlaybackInfo['state']
    source: string
    readAt: number
    data: VisualizationData
  } | null = null
  lastSpectrumCache: {
    points: number
    state: PlaybackInfo['state']
    source: string
    readAt: number
    data: number[]
  } | null = null
  lastUpcomingTrackCache: {
    readAt: number
    track: AudioEngineQueueItem | null
  } | null = null

  private readonly host: PlaybackControllerHost

  constructor(host: PlaybackControllerHost, initialPlaybackInfo: PlaybackInfo) {
    this.host = host
    this.playbackInfo = initialPlaybackInfo
    this.lastTick = host.getScheduler().now()
  }

  private get native(): NativeAudioBinding | null {
    return this.host.getNative()
  }

  private get scheduler(): AudioEngineScheduler {
    return this.host.getScheduler()
  }

  private get lastNativeError(): string {
    return this.host.getLastNativeError()
  }

  private set lastNativeError(value: string) {
    this.host.setLastNativeError(value)
  }

  private get destroyed(): boolean {
    return this.host.isDestroyed()
  }

  private get nativePlaybackActive(): boolean {
    return this.host.getNativePlaybackActive()
  }

  private set nativePlaybackActive(value: boolean) {
    this.host.setNativePlaybackActive(value)
  }

  private get nativeOutputRouteSynced(): boolean {
    return this.host.getNativeOutputRouteSynced()
  }

  private set nativeOutputRouteSynced(value: boolean) {
    this.host.setNativeOutputRouteSynced(value)
  }

  private get pendingNativeSource(): string | null {
    return this.host.getPendingNativeSource()
  }

  private set pendingNativeSource(value: string | null) {
    this.host.setPendingNativeSource(value)
  }

  private get output(): AudioOutputId {
    return this.host.getOutput()
  }

  private set output(value: AudioOutputId) {
    this.host.setOutput(value)
  }

  private get device(): string {
    return this.host.getDevice()
  }

  private set device(value: string) {
    this.host.setDevice(value)
  }

  private get exclusiveMode(): boolean {
    return this.host.getExclusiveMode()
  }

  private set exclusiveMode(value: boolean) {
    this.host.setExclusiveMode(value)
  }

  private get outputConfig(): OutputConfig {
    return this.host.getOutputConfig()
  }

  private set outputConfig(value: OutputConfig) {
    this.host.setOutputConfig(value)
  }

  private get processing(): AudioProcessingSettings {
    return this.host.getProcessing()
  }

  private getNativeBackendId(): string {
    return this.host.getNativeBackendId()
  }

  private shouldFallbackFromAsio(output: AudioOutputId): boolean {
    return this.host.shouldFallbackFromAsio(output)
  }

  private restoreAudioServiceOutputRoute(
    contextPrefix?: string
  ): Promise<{ synced: boolean; errors: string[] }> {
    return this.host.restoreAudioServiceOutputRoute(contextPrefix)
  }

  private applyNativeDspGraph(context: string): Promise<unknown> {
    return this.host.applyNativeDspGraph(context)
  }

  private updateOutputPerfect(): void {
    this.host.updateOutputPerfect()
  }

  private pollAudioDeviceOptionsForChanges(): void {
    this.host.pollAudioDeviceOptionsForChanges()
  }

  private prepareLoudnormForPlay(source: string): Promise<void> {
    return this.host.prepareLoudnormForPlay(source)
  }

  private tryNative(
    context: string,
    command: (native: NativeAudioBinding) => void,
    logFailure = true
  ): boolean {
    return this.host.tryNative(context, command, logFailure)
  }

  private callNativeMaybeAsync(
    context: string,
    method: keyof NativeAudioBinding,
    ...args: unknown[]
  ): Promise<boolean> {
    return this.host.callNativeMaybeAsync(context, method, ...args)
  }

  private emit(event: string, payload?: unknown): void {
    this.host.emit(event, payload)
  }

  private createDeviceCapabilityRefreshSignature(info: PlaybackInfo): string {
    return this.host.createDeviceCapabilityRefreshSignature(info)
  }

  private invalidateAudioDeviceOptionsCache(reason: string): void {
    this.host.invalidateAudioDeviceOptionsCache(reason)
  }

  clearTimer(): void {
    if (this.timer) {
      this.scheduler.clearInterval(this.timer)
      this.timer = null
    }
  }

  resetCachesOnServiceCrash(): void {
    this.lastVisualizationCache = null
    this.lastSpectrumCache = null
    this.invalidateUpcomingTrackCache()
    this.lastNativePlaybackInfoTickReadAt = Number.NEGATIVE_INFINITY
    this.lastNativeReportedPosition = Number.NaN
    this.pendingNativePositionTarget = null
    this.nativeConfigRevisionEpochPending = true
  }

  async play(source: string, startTime = 0): Promise<AudioEnginePlayResult> {
    if (!source) throw audioEngineError('audio.source_empty', 'playback source is empty')
    this.invalidateUpcomingTrackCache()
    await this.prepareLoudnormForPlay(source)
    const current = this.queue[this.playbackInfo.queueIndex]
    const duration = current?.source === source ? (current.duration ?? 0) : 0
    const boundedStartTime = clampQueueItemPosition(current, startTime)
    const firstErrorContext = {
      output: this.output,
      device: this.device,
      exclusiveMode: this.exclusiveMode,
      outputConfig: this.outputConfig
    }
    let nativeStarted = await this.tryNativePlay(
      '播放',
      source,
      boundedStartTime,
      firstErrorContext.output !== 'asio'
    )
    let nativeFallbackReason = ''
    if (!nativeStarted && this.shouldFallbackFromAsio(firstErrorContext.output)) {
      nativeFallbackReason = this.lastNativeError || 'ASIO 输出不可用'
      this.output = 'wasapi'
      this.device = 'auto'
      this.exclusiveMode = false
      this.nativeOutputRouteSynced = false
      const fallbackRoute = await this.restoreAudioServiceOutputRoute('ASIO 失败后应用 WASAPI 兜底')
      this.nativeOutputRouteSynced = fallbackRoute.synced
      if (fallbackRoute.synced) {
        nativeStarted = await this.tryNativePlay('WASAPI 兜底播放', source, boundedStartTime)
      } else {
        this.lastNativeError = fallbackRoute.errors.join('\n') || this.lastNativeError
      }
      if (!nativeStarted) {
        this.output = firstErrorContext.output
        this.device = firstErrorContext.device
        this.exclusiveMode = firstErrorContext.exclusiveMode
        this.outputConfig = firstErrorContext.outputConfig
      }
    }
    if (
      !nativeStarted &&
      firstErrorContext.output === 'alsa' &&
      firstErrorContext.device === 'auto'
    ) {
      nativeFallbackReason = this.lastNativeError || 'ALSA 默认输出不可用'
      for (const candidate of getAlsaPlaybackDeviceCandidates()) {
        const deviceSynced = await this.callNativeMaybeAsync(
          `切换 ALSA 兜底输出设备 ${candidate}`,
          'SetOutputDevice',
          candidate
        )
        if (!deviceSynced) continue
        nativeStarted = await this.tryNativePlay(
          `ALSA 兜底播放 ${candidate}`,
          source,
          boundedStartTime,
          false
        )
        if (nativeStarted) {
          this.device = candidate
          this.nativeOutputRouteSynced = true
          break
        }
      }
      if (!nativeStarted) {
        this.device = firstErrorContext.device
        await this.callNativeMaybeAsync('恢复 ALSA 默认输出设备', 'SetOutputDevice', this.device)
      }
    }
    if (!nativeStarted && !rendererFallbackAllowed()) {
      const detail =
        this.lastNativeError ||
        parseNativeJson(this.native?.GetLastError?.(), { message: '' }).message ||
        ''
      throw nativeAudioError('audio.play_failed', 'native playback failed', detail)
    }
    this.nativePlaybackActive = nativeStarted
    this.pendingNativeSource = nativeStarted ? source : null
    const nativeInfo = nativeStarted ? this.readNativePlaybackInfo() : null
    if (nativeInfo?.source === source) {
      this.pendingNativeSource = null
    }
    const isDsd = sourceLooksDsd(source)
    const nativeDsd = nativeInfo ? normalizeDsdState(nativeInfo.outputInfo, nativeInfo) : null
    const playbackIsDsd = isDsd || nativeDsd?.isDsd === true
    const playbackDsdMode = nativeDsd?.isDsd
      ? nativeDsd.dsdMode
      : playbackIsDsd
        ? 'unsupported'
        : 'pcm'
    const playbackDsdRate = nativeDsd?.isDsd ? nativeDsd.dsdRate : 0
    // A single-file CUE queue deliberately contains adjacent logical tracks with the same
    // source. Preserve the selected queue index when it already points at this source; a plain
    // findIndex(source) would incorrectly snap every later CUE track back to the first one.
    const indexedQueueItem = this.queue[this.playbackInfo.queueIndex]
    const sourceQueueIndex =
      indexedQueueItem?.source === source
        ? this.playbackInfo.queueIndex
        : this.queue.findIndex((item) => item.source === source)
    const preservedPlaybackRate = this.playbackInfo.playbackRate ?? 1
    this.playbackInfo = {
      ...this.playbackInfo,
      ...nativeInfo,
      state: 'playing',
      position: boundedStartTime,
      duration,
      source,
      queueIndex: sourceQueueIndex >= 0 ? sourceQueueIndex : this.playbackInfo.queueIndex,
      codec: inferCodec(source),
      isDsd: playbackIsDsd,
      dsdMode: playbackDsdMode,
      dsdRate: playbackDsdRate,
      // Native play() does not receive rate as an argument; reassert the app-layer rate
      // so a default 1.0 from GetPlaybackInfo cannot clobber a non-unity rate.
      playbackRate: preservedPlaybackRate,
      // Same for volume: native GetPlaybackInfo may report unity if a startup
      // SetVolume was dropped before the service engine existed. Keep the
      // app-layer volume authoritative and reassert it below.
      volume: this.playbackInfo.volume,
      outputInfo: nativeInfo?.outputInfo
        ? {
            ...nativeInfo.outputInfo,
            isDsd: playbackIsDsd,
            dsdMode: playbackDsdMode,
            dsdRate: playbackDsdRate
          }
        : this.playbackInfo.outputInfo
    }
    if (nativeStarted && Math.abs(preservedPlaybackRate - 1) > 0.001) {
      this.tryNative('播放后同步倍速', (native) => native.SetPlaybackRate(preservedPlaybackRate))
    }
    if (nativeStarted) {
      // Native play carries info_.volume into the pipeline, but reassert it
      // after a successful start so a restored engine can never stay at unity
      // loudness if a startup SetVolume was lost before the pipeline existed.
      this.tryNative('播放后应用音量', (native) => native.SetVolume(this.playbackInfo.volume))
    }
    await this.applyNativeDspGraph('播放源格式变更后解析 DSP 场景')
    this.lastTick = this.scheduler.now()
    const nativePositionConfirmed =
      nativeInfo?.source === source &&
      nativeInfo.state !== 'stopped' &&
      Number.isFinite(nativeInfo.position) &&
      Math.abs(nativeInfo.position - boundedStartTime) <= 5
    this.lastNativeReportedPosition =
      nativePositionConfirmed && nativeInfo ? nativeInfo.position : Number.NaN
    this.pendingNativePositionTarget = nativePositionConfirmed ? null : boundedStartTime
    this.emit('start-file')
    this.publishDuration(this.playbackInfo.duration, { force: true })
    this.publishProperty('pause', false)
    this.publishPlaybackInfo()
    return {
      nativeStarted,
      fallbackReason:
        nativeFallbackReason || (nativeStarted ? '' : this.lastNativeError || '原生音频引擎不可用')
    }
  }

  async togglePause(): Promise<void> {
    const native = this.native
    if (!native) {
      this.lastNativeError = '未加载 twilight_audio_node.node'
      return
    }

    // Service 模式：异步等待 utility 进程执行完毕，读取真实状态
    if (typeof native.callAsync === 'function') {
      try {
        await native.callAsync('Pause', [])
        // 等待原生引擎更新状态后读取真实播放信息
        const raw = await native.callAsync('GetPlaybackInfo', [])
        const realInfo = parseNativeJson(
          raw as string | PlaybackInfo | undefined,
          null as PlaybackInfo | null
        )
        if (realInfo) {
          this.playbackInfo = this.mergeNativePlaybackInfo(
            this.normalizePlaybackInfo(realInfo, true)
          )
        }
        this.lastTick = this.scheduler.now()
        this.publishProperty('pause', this.playbackInfo.state !== 'playing')
        this.publishPlaybackInfo()
        return
      } catch (err) {
        // 异步调用失败，回退到同步路径
        const message = err instanceof Error ? err.message : String(err)
        this.lastNativeError = message
        console.warn('原生音频引擎异步暂停/继续失败，回退同步路径：', message)
      }
    }

    // 直接 N-API 模式：Pause() 同步阻塞，GetPlaybackInfo() 立即返回真实状态
    this.tryNative('暂停/继续', (n) => n.Pause())
    const nativeInfo = this.readNativePlaybackInfo()
    if (nativeInfo) {
      this.playbackInfo = this.mergeNativePlaybackInfo(nativeInfo)
    }
    this.lastTick = this.scheduler.now()
    this.publishProperty('pause', this.playbackInfo.state !== 'playing')
    this.publishPlaybackInfo()
  }

  async pause(): Promise<void> {
    // 真正的硬暂停：如果已经暂停则不操作，避免 toggle 语义导致的反向翻转
    if (this.playbackInfo.state === 'paused' || this.playbackInfo.state === 'stopped') {
      return
    }
    await this.togglePause()
  }

  async seek(time: number): Promise<void> {
    const position = clampQueueItemPosition(this.queue[this.playbackInfo.queueIndex], time)
    if (this.playbackInfo.state !== 'playing' && Object.is(position, this.playbackInfo.position)) {
      return
    }
    this.tryNative('跳转', (native) => native.Seek(position))
    this.playbackInfo.position = position
    this.lastTick = this.scheduler.now()
    this.lastNativeReportedPosition = Number.NaN
    this.pendingNativePositionTarget = position
    this.publishProperty('time-pos', position)
    this.publishPlaybackInfo()
  }

  async setVolume(volume: number): Promise<void> {
    const normalized = clampNumber(volume, 0, 1, 1)
    const alreadyReported = Object.is(normalized, this.playbackInfo.volume)
    // The native side starts at unity and only becomes "synced" after the
    // awaited restore path confirms a SetVolume. Without this guard split, a
    // failed startup restore would leave playbackInfo at the saved volume while
    // the native engine stays loud, and every renderer push would be dropped
    // as a no-op here.
    if (alreadyReported && this.host.isNativeVolumeSynced()) return
    const applied = this.tryNative('设置音量', (native) => native.SetVolume(normalized))
    this.playbackInfo.volume = normalized
    if (applied && this.host.canVerifyNativeVolume()) {
      // In-process binding: SetVolume succeeded synchronously. The audio service
      // binding is fire-and-forget, so only the awaited restore step may mark
      // the native volume as synced there.
      this.host.markNativeVolumeSynced(true)
    }
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
  }

  async setPlaybackRate(rate: number): Promise<void> {
    const normalized = clampNumber(rate, 0.5, 2, 1)
    // Round to 3 decimals to avoid float chatter.
    const rounded = Math.round(normalized * 1000) / 1000
    if (Object.is(rounded, this.playbackInfo.playbackRate ?? 1)) return
    this.tryNative('设置倍速', (native) => native.SetPlaybackRate(rounded))
    this.playbackInfo.playbackRate = rounded
    // Non-unity rate requires resampling and breaks bit-perfect, same as non-unity volume.
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
  }

  /**
   * Native A-B loop. Pass end <= start (or negative) to clear.
   * Returns whether the native binding accepted the call (soft A-B remains the fallback).
   */
  async setLoopRange(startSeconds: number, endSeconds: number): Promise<boolean> {
    const start =
      typeof startSeconds === 'number' && Number.isFinite(startSeconds)
        ? Math.max(0, startSeconds)
        : -1
    const end =
      typeof endSeconds === 'number' && Number.isFinite(endSeconds) ? Math.max(0, endSeconds) : -1
    if (!this.native || typeof this.native.SetLoopRange !== 'function') return false
    try {
      this.tryNative('设置 A-B 循环', (native) => {
        native.SetLoopRange?.(start, end)
      })
      return true
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    if (
      this.playbackInfo.state === 'stopped' &&
      this.playbackInfo.position === 0 &&
      !this.nativePlaybackActive
    ) {
      return
    }
    if (this.nativePlaybackActive) {
      const stopped = await this.callNativeMaybeAsync('停止', 'Stop')
      if (!stopped) {
        const nativeInfo = await this.readNativePlaybackInfoAsync()
        if (nativeInfo) this.playbackInfo = this.mergeNativePlaybackInfo(nativeInfo)
        this.publishPlaybackInfo()
        throw nativeAudioError('audio.stop_failed', 'native stop failed', this.lastNativeError)
      }
    } else {
      this.tryNative('停止', (native) => native.Stop())
    }
    this.nativePlaybackActive = false
    this.pendingNativeSource = null
    this.pendingNativePositionTarget = null
    this.lastNativeReportedPosition = Number.NaN
    this.playbackInfo.state = 'stopped'
    this.playbackInfo.position = 0
    this.publishProperty('pause', true)
    this.publishProperty('eof-reached', false)
    this.publishPlaybackInfo()
  }

  async loadQueue(items: AudioEngineQueueItem[], startIndex = 0): Promise<void> {
    const nextQueue = [...items]
    const nextQueueIndex =
      nextQueue.length > 0 ? Math.min(Math.max(0, startIndex), nextQueue.length - 1) : -1
    const nextQueueJson = JSON.stringify(nextQueue)
    if (nextQueueJson === this.queueJson && nextQueueIndex === this.playbackInfo.queueIndex) return

    const previousQueueJson = this.queueJson
    const previousQueueIndex = this.playbackInfo.queueIndex
    const hasPreviousQueue = this.queue.length > 0
    try {
      const queueLoaded = await this.callNativeMaybeAsync(
        '加载队列',
        'LoadQueue',
        nextQueueJson,
        nextQueueIndex
      )
      if (!queueLoaded) {
        throw nativeAudioError(
          'audio.queue_load_failed',
          'native queue load failed',
          this.lastNativeError
        )
      }
      const playModeSynced = await this.callNativeMaybeAsync(
        '加载队列后同步播放模式',
        'SetPlayMode',
        nativePlayMode(this.playbackInfo.playMode)
      )
      if (!playModeSynced) {
        throw nativeAudioError(
          'audio.play_mode_sync_failed',
          'native play-mode sync failed',
          this.lastNativeError
        )
      }
    } catch (error) {
      // In service mode a rejected LoadQueue does not prove the native side
      // never ran (slow-tier timeouts reject while the load may still land),
      // which would leave the engine on the new queue while the local mirror
      // keeps the old one. Best-effort restore closes that divergence.
      if (hasPreviousQueue) {
        this.rollbackQueueAfterFailedLoad(previousQueueJson, previousQueueIndex)
      }
      throw error
    }

    this.queue = nextQueue
    this.queueJson = nextQueueJson
    this.playbackInfo.queueIndex = nextQueueIndex
    this.invalidateUpcomingTrackCache()
    this.emit('queue-change', this.queue)
  }

  private rollbackQueueAfterFailedLoad(queueJson: string, queueIndex: number): void {
    const native = this.native
    const callAsync = native?.callAsync?.bind(native)
    if (typeof callAsync !== 'function') return
    void (async () => {
      await callAsync('LoadQueue', [queueJson, queueIndex])
      await callAsync('SetPlayMode', [nativePlayMode(this.playbackInfo.playMode)])
    })().catch((error) => {
      console.warn(
        '[音频引擎] 队列加载失败后的回滚未完成：',
        error instanceof Error ? error.message : String(error)
      )
    })
  }

  async next(): Promise<void> {
    if (this.queue.length === 0) return
    this.invalidateUpcomingTrackCache()
    const fallbackIndex = (this.playbackInfo.queueIndex + 1) % this.queue.length
    let nextIndex = fallbackIndex
    const targetSource = this.queue[nextIndex]?.source
    if (this.nativePlaybackActive && this.native?.Next) {
      let nativeInfo: PlaybackInfo | null = null
      if (typeof this.native.callAsync === 'function') {
        try {
          await this.native.callAsync('Next', [])
          nativeInfo = await this.readNativePlaybackInfoAsync()
          this.lastNativeError = ''
        } catch (err) {
          this.lastNativeError = err instanceof Error ? err.message : String(err)
        }
      } else if (this.tryNative('下一首', (native) => native.Next?.())) {
        nativeInfo = this.readNativePlaybackInfo()
      }
      if (
        nativeInfo &&
        nativeInfo.state === 'playing' &&
        nativeInfo.queueIndex >= 0 &&
        nativeInfo.queueIndex < this.queue.length &&
        nativeInfo.source ===
          (this.playbackInfo.playMode === 'shuffle'
            ? this.queue[nativeInfo.queueIndex]?.source
            : targetSource)
      ) {
        nextIndex = nativeInfo.queueIndex
        this.pendingNativeSource = null
        this.playbackInfo = this.mergeNativePlaybackInfo(nativeInfo)
        this.emit('start-file')
        this.publishPlaybackInfo()
        return
      }
    }
    this.playbackInfo.queueIndex = nextIndex
    await this.play(this.queue[nextIndex].source, 0)
  }

  async previous(): Promise<void> {
    if (this.queue.length === 0) return
    this.invalidateUpcomingTrackCache()
    const fallbackIndex =
      this.playbackInfo.queueIndex <= 0 ? this.queue.length - 1 : this.playbackInfo.queueIndex - 1
    let nextIndex = fallbackIndex
    const targetSource = this.queue[nextIndex]?.source
    if (this.nativePlaybackActive && this.native?.Previous) {
      let nativeInfo: PlaybackInfo | null = null
      if (typeof this.native.callAsync === 'function') {
        try {
          await this.native.callAsync('Previous', [])
          nativeInfo = await this.readNativePlaybackInfoAsync()
          this.lastNativeError = ''
        } catch (err) {
          this.lastNativeError = err instanceof Error ? err.message : String(err)
        }
      } else if (this.tryNative('上一首', (native) => native.Previous?.())) {
        nativeInfo = this.readNativePlaybackInfo()
      }
      if (
        nativeInfo &&
        nativeInfo.state === 'playing' &&
        nativeInfo.queueIndex >= 0 &&
        nativeInfo.queueIndex < this.queue.length &&
        nativeInfo.source ===
          (this.playbackInfo.playMode === 'shuffle'
            ? this.queue[nativeInfo.queueIndex]?.source
            : targetSource)
      ) {
        nextIndex = nativeInfo.queueIndex
        this.pendingNativeSource = null
        this.playbackInfo = this.mergeNativePlaybackInfo(nativeInfo)
        this.emit('start-file')
        this.publishPlaybackInfo()
        return
      }
    }
    this.playbackInfo.queueIndex = nextIndex
    await this.play(this.queue[nextIndex].source, 0)
  }

  async setPlayMode(mode: PlayMode): Promise<void> {
    if (mode === this.playbackInfo.playMode) return
    // Native QueueManager anchors the current queue item while rebuilding shuffle
    // order, so the new policy affects only the next manual/EOF advancement.
    const playModeSynced = await this.callNativeMaybeAsync(
      '切换播放模式',
      'SetPlayMode',
      nativePlayMode(mode)
    )
    if (!playModeSynced) {
      throw nativeAudioError(
        'audio.play_mode_switch_failed',
        'native play-mode switch failed',
        this.lastNativeError
      )
    }
    this.playbackInfo.playMode = mode
    this.invalidateUpcomingTrackCache()
    this.publishPlaybackInfo()
  }

  getUpcomingTrack(): AudioEngineQueueItem | null {
    const now = this.scheduler.now()
    const cached = this.lastUpcomingTrackCache
    if (cached && now - cached.readAt <= UPCOMING_TRACK_CACHE_TTL_MS) {
      return cached.track
    }
    try {
      const track = parseNativeJson(
        this.native?.GetUpcomingTrack?.(),
        null as AudioEngineQueueItem | null
      )
      this.lastUpcomingTrackCache = { readAt: now, track }
      return track
    } catch {
      return this.playbackInfo.upcomingTrack
    }
  }

  async getPlaybackInfo(): Promise<PlaybackInfo> {
    const now = this.scheduler.now()
    if (
      this.nativePlaybackActive &&
      now - this.lastNativePlaybackInfoTickReadAt > PLAYBACK_INFO_CACHE_TTL_MS
    ) {
      const nativeInfo = this.readNativePlaybackInfo()
      if (nativeInfo) {
        this.playbackInfo = this.mergeNativePlaybackInfo(nativeInfo)
        this.lastNativePlaybackInfoTickReadAt = now
      }
    }
    return { ...this.playbackInfo, nativePlaybackActive: this.nativePlaybackActive }
  }

  getSpectrumData(points = 64): number[] {
    const now = this.scheduler.now()
    const cached = this.lastSpectrumCache
    if (
      cached &&
      cached.points === points &&
      cached.state === this.playbackInfo.state &&
      cached.source === this.playbackInfo.source &&
      now - cached.readAt <= VISUALIZATION_CACHE_TTL_MS
    ) {
      return [...cached.data]
    }
    const cache = (data: number[]): number[] => {
      this.lastSpectrumCache = {
        points,
        state: this.playbackInfo.state,
        source: this.playbackInfo.source,
        readAt: now,
        data: [...data]
      }
      return [...data]
    }
    try {
      const nativeSpectrum = this.native?.GetSpectrumData?.(points)
      if (nativeSpectrum) return cache(nativeSpectrum)
    } catch {
      // Keep the visualizer alive while native playback is still optional.
    }
    return cache(
      Array.from({ length: points }, (_, index) => {
        const x = index / Math.max(1, points - 1)
        return (Math.sin((x * 12 + this.playbackInfo.position) * Math.PI) + 1) * 0.25
      })
    )
  }

  getVisualizationData(options: VisualizationOptions = {}): VisualizationData {
    const normalizedOptions = normalizeVisualizationOptions(options)
    const cacheKey = JSON.stringify(normalizedOptions)
    const now = this.scheduler.now()
    const cached = this.lastVisualizationCache
    if (
      cached &&
      cached.key === cacheKey &&
      cached.state === this.playbackInfo.state &&
      cached.source === this.playbackInfo.source &&
      now - cached.readAt <= VISUALIZATION_CACHE_TTL_MS
    ) {
      return cached.data
    }
    const cache = (data: VisualizationData): VisualizationData => {
      const cachedData = withPrecomputedVisualizerBars(data, normalizedOptions)
      this.lastVisualizationCache = {
        key: cacheKey,
        state: this.playbackInfo.state,
        source: this.playbackInfo.source,
        readAt: now,
        data: cachedData
      }
      return cachedData
    }
    let fallbackReason = this.native?.GetVisualizationData
      ? 'Native visualization tap returned no samples'
      : 'Native visualization tap unavailable'
    try {
      const nativeData = parseNativeJson(
        this.native?.GetVisualizationData?.(cacheKey),
        null as VisualizationData | null
      )
      if (nativeData) {
        const normalizedData = normalizeVisualizationData(nativeData, normalizedOptions)
        if (normalizedData.active || this.playbackInfo.state !== 'playing') {
          return cache(normalizedData)
        }
        fallbackReason = normalizedData.reason || 'Native visualization tap returned no samples'
      } else {
        fallbackReason = 'Native visualization tap unavailable'
      }
    } catch {
      fallbackReason = 'Native visualization tap unavailable'
      // Keep the renderer visualizer alive while native playback is still optional.
    }
    if (this.playbackInfo.state === 'playing') {
      return cache(
        createFallbackVisualizationData(
          normalizedOptions,
          this.playbackInfo.actualSampleRate,
          now / 1000,
          fallbackReason
        )
      )
    }
    return cache(
      createInactiveVisualizationData(
        normalizedOptions,
        this.playbackInfo.actualSampleRate,
        fallbackReason === 'Native visualization tap unavailable'
          ? 'native-unavailable'
          : 'stopped',
        fallbackReason === 'Native visualization tap unavailable' ? fallbackReason : ''
      )
    )
  }

  startClock(): void {
    if (this.timer) return
    this.lastTick = this.scheduler.now()
    this.timer = this.scheduler.setInterval(() => this.tick(), 250)
  }

  readNativePlaybackInfo(): PlaybackInfo | null {
    try {
      const info = parseNativeJson(this.native?.GetPlaybackInfo?.(), null as PlaybackInfo | null)
      if (!info) return null
      return this.normalizePlaybackInfo(info, true)
    } catch {
      return null
    }
  }

  async readNativePlaybackInfoAsync(): Promise<PlaybackInfo | null> {
    if (!this.native || typeof this.native.callAsync !== 'function')
      return this.readNativePlaybackInfo()
    try {
      const raw = (await this.native.callAsync('GetPlaybackInfo', [])) as
        | string
        | PlaybackInfo
        | undefined
      const info = parseNativeJson<PlaybackInfo | null>(raw, null)
      if (!info) return null
      return this.normalizePlaybackInfo(info, true)
    } catch {
      return null
    }
  }

  private resolveNativeTickPosition(
    nativePosition: number,
    softPosition: number,
    canConfirmPendingTarget: boolean
  ): number {
    if (!Number.isFinite(nativePosition)) return softPosition
    const soft = Number.isFinite(softPosition) ? softPosition : 0
    const pendingTarget = this.pendingNativePositionTarget
    if (pendingTarget !== null) {
      if (!canConfirmPendingTarget) return soft
      const tolerance = Math.max(5, Math.abs(soft - pendingTarget) + 0.75)
      if (Math.abs(nativePosition - pendingTarget) <= tolerance) {
        this.pendingNativePositionTarget = null
        this.lastNativeReportedPosition = nativePosition
        return Math.max(0, nativePosition)
      }
      return soft
    }

    const lastNative = this.lastNativeReportedPosition
    this.lastNativeReportedPosition = nativePosition

    if (Number.isFinite(lastNative) && nativePosition > lastNative + 0.02) {
      return nativePosition
    }
    if (nativePosition > soft + 0.05) return nativePosition
    if (Number.isFinite(lastNative) && nativePosition + 1.25 < lastNative) {
      return Math.max(0, nativePosition)
    }
    if (nativePosition <= 0.05 && soft > 1.5) return Math.max(0, nativePosition)
    return soft
  }

  mergeNativePlaybackInfo(nativeInfo: PlaybackInfo): PlaybackInfo {
    const playbackRate =
      typeof nativeInfo.playbackRate === 'number' && Number.isFinite(nativeInfo.playbackRate)
        ? clampNumber(nativeInfo.playbackRate, 0.5, 2, this.playbackInfo.playbackRate ?? 1)
        : (this.playbackInfo.playbackRate ?? 1)
    const previousPosition = this.playbackInfo.position
    const resolvedPosition = this.resolveNativeTickPosition(
      typeof nativeInfo.position === 'number' ? nativeInfo.position : previousPosition,
      previousPosition,
      (!this.pendingNativeSource || nativeInfo.source === this.pendingNativeSource) &&
        nativeInfo.state !== 'stopped'
    )
    const waitingForNativePosition = this.pendingNativePositionTarget !== null

    if (!this.pendingNativeSource) {
      return resolveQueueIndexForSource(this.queue, {
        ...this.playbackInfo,
        ...nativeInfo,
        state: waitingForNativePosition ? this.playbackInfo.state : nativeInfo.state,
        position: resolvedPosition,
        playbackRate,
        volume: this.playbackInfo.volume,
        nativePlaybackActive: waitingForNativePosition
          ? this.nativePlaybackActive
          : nativeInfo.nativePlaybackActive
      })
    }

    if (nativeInfo.source === this.pendingNativeSource) {
      this.pendingNativeSource = null
      return resolveQueueIndexForSource(this.queue, {
        ...this.playbackInfo,
        ...nativeInfo,
        state: waitingForNativePosition ? this.playbackInfo.state : nativeInfo.state,
        position: resolvedPosition,
        playbackRate,
        volume: this.playbackInfo.volume,
        nativePlaybackActive: waitingForNativePosition
          ? this.nativePlaybackActive
          : nativeInfo.nativePlaybackActive
      })
    }

    return {
      ...this.playbackInfo,
      position: resolvedPosition,
      duration: this.playbackInfo.duration || nativeInfo.duration,
      // Native GetPlaybackInfo can report unity while a startup SetVolume is
      // still in flight or was dropped before the service engine existed.
      // Keep the app-layer saved volume authoritative so a transient unity
      // report can never poison a later restore and leave the engine loud.
      volume: this.playbackInfo.volume,
      playbackRate,
      requestedConfigRevision: nativeInfo.requestedConfigRevision,
      appliedConfigRevision: nativeInfo.appliedConfigRevision,
      outputInfo: nativeInfo.outputInfo,
      nativePlaybackActive: this.nativePlaybackActive
    }
  }

  private mapNativeConfigRevisions(
    requestedConfigRevision: number,
    appliedConfigRevision: number
  ): { requestedConfigRevision: number; appliedConfigRevision: number } {
    const rawRequestedConfigRevision = Number.isFinite(requestedConfigRevision)
      ? Math.max(0, Math.trunc(requestedConfigRevision))
      : this.lastRawRequestedConfigRevision
    const rawAppliedConfigRevision = Number.isFinite(appliedConfigRevision)
      ? Math.max(0, Math.trunc(appliedConfigRevision))
      : this.lastRawAppliedConfigRevision

    if (
      this.nativeConfigRevisionObserved &&
      (this.nativeConfigRevisionEpochPending ||
        rawRequestedConfigRevision < this.lastRawRequestedConfigRevision)
    ) {
      this.configRevisionBase = this.publicRequestedConfigRevision - rawRequestedConfigRevision
    }

    this.nativeConfigRevisionObserved = true
    this.nativeConfigRevisionEpochPending = false
    this.lastRawRequestedConfigRevision = rawRequestedConfigRevision
    this.lastRawAppliedConfigRevision = rawAppliedConfigRevision
    this.publicRequestedConfigRevision = Math.max(
      this.publicRequestedConfigRevision,
      this.configRevisionBase + rawRequestedConfigRevision
    )
    if (rawAppliedConfigRevision > 0) {
      this.publicAppliedConfigRevision = Math.max(
        this.publicAppliedConfigRevision,
        this.configRevisionBase + rawAppliedConfigRevision
      )
    }

    const pendingAppliedRevision = this.pendingConfigAppliedEvent?.appliedConfigRevision ?? 0
    if (
      this.publicAppliedConfigRevision > this.lastEmittedAppliedConfigRevision &&
      this.publicAppliedConfigRevision > pendingAppliedRevision
    ) {
      this.pendingConfigAppliedEvent = {
        requestedConfigRevision: this.publicRequestedConfigRevision,
        appliedConfigRevision: this.publicAppliedConfigRevision
      }
    }

    return {
      requestedConfigRevision: this.publicRequestedConfigRevision,
      appliedConfigRevision: this.publicAppliedConfigRevision
    }
  }

  normalizePlaybackInfo(info: PlaybackInfo, nativeRevisions = false): PlaybackInfo {
    const preferNonEmpty = (...values: Array<string | undefined | null>): string => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) return value
      }
      return ''
    }
    const expectedBackend = this.getNativeBackendId()
    const normalizeBackendId = (value: string | undefined | null): string =>
      value === 'wasapi-shared' ? 'wasapi' : value?.trim() || ''
    const reportedBackend = preferNonEmpty(info.outputInfo?.backend, info.outputBackend)
    const reportedActualBackend = preferNonEmpty(
      info.outputInfo?.actualBackend,
      info.actualBackend,
      reportedBackend
    )
    const staleNativeOutputRoute =
      this.nativeOutputRouteSynced &&
      [reportedBackend, reportedActualBackend].some(
        (backend) =>
          backend.length > 0 && normalizeBackendId(backend) !== normalizeBackendId(expectedBackend)
      )
    const canonicalOutput = staleNativeOutputRoute ? this.playbackInfo.outputInfo : info.outputInfo
    const outputInfo: OutputInfo = {
      ...this.playbackInfo.outputInfo,
      ...(canonicalOutput ?? {})
    }
    const resampled =
      typeof canonicalOutput?.resampled === 'boolean'
        ? canonicalOutput.resampled
        : outputInfo.resampled === true
    outputInfo.resampled = resampled
    outputInfo.providerImplementation = normalizeOutputProviderImplementation(
      canonicalOutput?.providerImplementation ?? outputInfo.providerImplementation
    )
    outputInfo.conversionInfo = normalizeOutputConversionInfo(
      canonicalOutput?.conversionInfo ?? outputInfo.conversionInfo,
      resampled
    )
    const sourceExact = canonicalOutput?.sourceExact ?? info.sourceExact ?? false
    const outputPerfect = canonicalOutput?.outputPerfect ?? info.outputPerfect ?? false
    const perfectReason = canonicalOutput?.perfectReason ?? info.perfectReason ?? ''
    const perfectReasonCode = canonicalOutput?.perfectReasonCode ?? info.perfectReasonCode ?? ''
    const supportsOutputPerfect =
      canonicalOutput?.supportsOutputPerfect ??
      info.supportsOutputPerfect ??
      outputInfo.supportsOutputPerfect ??
      false
    const normalizedDsd = normalizeDsdState(canonicalOutput, info)
    const sourceIsDsd = sourceLooksDsd(info.source || this.playbackInfo.source)
    const isDsd = normalizedDsd.isDsd || sourceIsDsd
    const dsdMode = !isDsd
      ? 'pcm'
      : this.processing.dsdOutputMode === 'pcm'
        ? 'pcm'
        : normalizedDsd.isDsd
          ? normalizedDsd.dsdMode
          : 'unsupported'
    const dsdRate = normalizedDsd.dsdRate
    const latencyInfo =
      canonicalOutput?.latencyInfo ?? info.latencyInfo ?? this.playbackInfo.latencyInfo
    const diagnostics =
      canonicalOutput?.diagnostics ?? info.diagnostics ?? this.playbackInfo.diagnostics
    let requestedConfigRevision = Number.isFinite(info.requestedConfigRevision)
      ? Math.max(0, Math.trunc(info.requestedConfigRevision))
      : this.playbackInfo.requestedConfigRevision
    let appliedConfigRevision = Number.isFinite(info.appliedConfigRevision)
      ? Math.max(0, Math.trunc(info.appliedConfigRevision))
      : this.playbackInfo.appliedConfigRevision
    if (nativeRevisions) {
      const mappedRevisions = this.mapNativeConfigRevisions(
        requestedConfigRevision,
        appliedConfigRevision
      )
      requestedConfigRevision = mappedRevisions.requestedConfigRevision
      appliedConfigRevision = mappedRevisions.appliedConfigRevision
    }
    outputInfo.sourceExact = sourceExact
    outputInfo.outputPerfect = outputPerfect
    outputInfo.supportsOutputPerfect = supportsOutputPerfect
    outputInfo.perfectReason =
      isDsd && dsdMode === 'pcm' && normalizedDsd.dsdMode !== 'pcm'
        ? 'DSD 当前已转换为 PCM 输出'
        : perfectReason
    outputInfo.perfectReasonCode =
      isDsd && dsdMode === 'pcm' && normalizedDsd.dsdMode !== 'pcm'
        ? 'dsd_converted_to_pcm'
        : perfectReasonCode
    outputInfo.isDsd = isDsd
    outputInfo.dsdMode = dsdMode
    outputInfo.dsdRate = dsdRate
    outputInfo.backend = staleNativeOutputRoute
      ? expectedBackend
      : preferNonEmpty(canonicalOutput?.backend, info.outputBackend, expectedBackend)
    outputInfo.actualBackend = staleNativeOutputRoute
      ? expectedBackend
      : preferNonEmpty(canonicalOutput?.actualBackend, outputInfo.backend)
    outputInfo.accessMode = preferNonEmpty(
      canonicalOutput?.accessMode,
      outputInfo.exclusive ? 'exclusive' : 'shared'
    )
    outputInfo.devicePathKind = preferNonEmpty(canonicalOutput?.devicePathKind, 'default')
    outputInfo.capabilityReason = preferNonEmpty(canonicalOutput?.capabilityReason, perfectReason)
    outputInfo.deviceName = preferNonEmpty(
      canonicalOutput?.deviceName,
      info.outputDevice,
      this.device
    )
    outputInfo.actualDeviceName = preferNonEmpty(
      canonicalOutput?.actualDeviceName,
      outputInfo.deviceName
    )
    outputInfo.driverName = preferNonEmpty(canonicalOutput?.driverName, info.driverName)
    outputInfo.actualDriverName = preferNonEmpty(
      canonicalOutput?.actualDriverName,
      outputInfo.driverName
    )
    outputInfo.driverVersion = canonicalOutput?.driverVersion ?? info.driverVersion ?? 0
    outputInfo.actualDriverVersion = canonicalOutput?.actualDriverVersion ?? info.driverVersion ?? 0
    outputInfo.pcmPassthrough = outputInfo.pcmPassthrough === true
    outputInfo.actualOutputFormat =
      canonicalOutput?.actualOutputFormat ?? info.actualOutputFormat ?? ''
    outputInfo.actualSampleRate = canonicalOutput?.actualSampleRate ?? info.actualSampleRate ?? 0
    outputInfo.actualBitDepth = canonicalOutput?.actualBitDepth ?? info.actualBitDepth ?? 0
    outputInfo.actualChannels = canonicalOutput?.actualChannels ?? info.actualChannels ?? 0
    outputInfo.outputSampleRate = canonicalOutput?.outputSampleRate ?? info.outputSampleRate ?? 0
    outputInfo.outputBitDepth = canonicalOutput?.outputBitDepth ?? info.outputBitDepth ?? 0
    outputInfo.bufferSizeFrames = canonicalOutput?.bufferSizeFrames ?? info.bufferSizeFrames ?? 0
    outputInfo.latencyFrames = canonicalOutput?.latencyFrames ?? info.latencyFrames ?? 0
    outputInfo.latencyMs = canonicalOutput?.latencyMs ?? info.latencyMs ?? 0
    outputInfo.channelRoutingMode =
      canonicalOutput?.channelRoutingMode ??
      info.channelRoutingMode ??
      this.outputConfig.routingMode
    outputInfo.deviceRecovered = canonicalOutput?.deviceRecovered ?? info.deviceRecovered ?? false
    outputInfo.recoveryCount = canonicalOutput?.recoveryCount ?? info.recoveryCount ?? 0
    outputInfo.latencyInfo = latencyInfo
    outputInfo.diagnostics = diagnostics
    const playbackRate =
      typeof info.playbackRate === 'number' && Number.isFinite(info.playbackRate)
        ? clampNumber(info.playbackRate, 0.5, 2, this.playbackInfo.playbackRate ?? 1)
        : (this.playbackInfo.playbackRate ?? 1)

    return {
      ...info,
      playbackRate,
      requestedConfigRevision,
      appliedConfigRevision,
      outputInfo,
      outputBackend: outputInfo.backend,
      outputDevice: outputInfo.deviceName,
      actualBackend: outputInfo.actualBackend,
      accessMode: outputInfo.accessMode,
      devicePathKind: outputInfo.devicePathKind,
      driverName: preferNonEmpty(
        outputInfo.driverName,
        outputInfo.actualDriverName,
        info.driverName
      ),
      driverVersion:
        outputInfo.driverVersion || outputInfo.actualDriverVersion || info.driverVersion || 0,
      actualOutputFormat: outputInfo.actualOutputFormat,
      actualSampleRate: outputInfo.actualSampleRate,
      actualBitDepth: outputInfo.actualBitDepth,
      actualChannels: outputInfo.actualChannels,
      decodedSampleRate: info.decodedSampleRate || 0,
      decodedBitDepth: info.decodedBitDepth || 0,
      decodedChannels: info.decodedChannels || 0,
      decodedSampleFormat: info.decodedSampleFormat || '',
      bufferSizeFrames: outputInfo.bufferSizeFrames,
      latencyFrames: outputInfo.latencyFrames,
      latencyMs: outputInfo.latencyMs,
      latencyInfo,
      channelRoutingMode: outputInfo.channelRoutingMode,
      supportsOutputPerfect,
      sourceExact,
      diagnostics,
      deviceRecovered: outputInfo.deviceRecovered === true,
      recoveryCount: outputInfo.recoveryCount,
      outputSampleRate: outputInfo.outputSampleRate,
      outputBitDepth: outputInfo.outputBitDepth,
      channelCount: outputInfo.actualChannels || info.channelCount || 0,
      outputPerfect,
      pcmPassthrough: outputInfo.pcmPassthrough === true,
      isDsd,
      dsdMode,
      dsdRate,
      perfectReasonCode: outputInfo.perfectReasonCode,
      capabilityReason: outputInfo.capabilityReason,
      crossfadeActive: info.crossfadeActive === true || this.processing.crossfadeSeconds > 0,
      crossfadeSeconds: info.crossfadeSeconds || this.processing.crossfadeSeconds || 0,
      gaplessActive: info.gaplessActive === true,
      preloadReady: info.preloadReady === true,
      gaplessBlockedReason:
        typeof info.gaplessBlockedReason === 'string' ? info.gaplessBlockedReason : '',
      streamTitle: typeof info.streamTitle === 'string' ? info.streamTitle : '',
      perfectReason: outputInfo.perfectReason,
      nativePlaybackActive: this.nativePlaybackActive
    }
  }

  syncPlaybackOutputMirrorsFromOutputInfo(): void {
    const outputInfo = this.playbackInfo.outputInfo
    this.playbackInfo.actualBackend = outputInfo.actualBackend || outputInfo.backend || ''
    this.playbackInfo.accessMode = outputInfo.accessMode || ''
    this.playbackInfo.devicePathKind = outputInfo.devicePathKind || ''
    this.playbackInfo.actualOutputFormat = outputInfo.actualOutputFormat || ''
    this.playbackInfo.actualSampleRate = outputInfo.actualSampleRate || 0
    this.playbackInfo.actualBitDepth = outputInfo.actualBitDepth || 0
    this.playbackInfo.actualChannels = outputInfo.actualChannels || 0
    this.playbackInfo.bufferSizeFrames = outputInfo.bufferSizeFrames || 0
    this.playbackInfo.latencyFrames = outputInfo.latencyFrames || 0
    this.playbackInfo.latencyMs = outputInfo.latencyMs || 0
    this.playbackInfo.latencyInfo = outputInfo.latencyInfo
    this.playbackInfo.channelRoutingMode =
      outputInfo.channelRoutingMode || this.outputConfig.routingMode
    this.playbackInfo.supportsOutputPerfect = outputInfo.supportsOutputPerfect === true
    this.playbackInfo.sourceExact = outputInfo.sourceExact === true
    this.playbackInfo.diagnostics = outputInfo.diagnostics
    this.playbackInfo.deviceRecovered = outputInfo.deviceRecovered === true
    this.playbackInfo.recoveryCount = outputInfo.recoveryCount || 0
    this.playbackInfo.outputSampleRate = outputInfo.outputSampleRate || 0
    this.playbackInfo.outputBitDepth = outputInfo.outputBitDepth || 0
    this.playbackInfo.outputPerfect = outputInfo.outputPerfect === true
    this.playbackInfo.pcmPassthrough = outputInfo.pcmPassthrough === true
    this.playbackInfo.perfectReason = outputInfo.perfectReason || ''
    this.playbackInfo.perfectReasonCode = outputInfo.perfectReasonCode || ''
    this.playbackInfo.capabilityReason = outputInfo.capabilityReason || ''
    this.playbackInfo.isDsd = outputInfo.isDsd === true
    this.playbackInfo.dsdMode =
      outputInfo.isDsd === true ? outputInfo.dsdMode || 'unsupported' : 'pcm'
    this.playbackInfo.dsdRate = outputInfo.isDsd === true ? outputInfo.dsdRate || 0 : 0
  }

  tick(): void {
    if (this.destroyed) return

    this.pollAudioDeviceOptionsForChanges()

    if (this.nativePlaybackActive) {
      const nativeIdle =
        this.playbackInfo.state !== 'playing' &&
        this.pendingNativeSource === null &&
        this.pendingNativePositionTarget === null
      if (nativeIdle) {
        this.nativeIdlePollTick += 1
        if (this.nativeIdlePollTick < NATIVE_IDLE_POLL_INTERVAL_TICKS) {
          this.publishProperty('time-pos', this.playbackInfo.position)
          return
        }
      }
      this.nativeIdlePollTick = 0
      const previousCapabilitySignature = this.createDeviceCapabilityRefreshSignature(
        this.playbackInfo
      )
      const wasPlaying = this.playbackInfo.state === 'playing'
      const previousSource = this.playbackInfo.source
      const previousQueueIndex = this.playbackInfo.queueIndex
      const previousPosition = this.playbackInfo.position
      const now = this.scheduler.now()
      const elapsed = (now - this.lastTick) / 1000
      const rate = this.playbackInfo.playbackRate ?? 1
      if (this.playbackInfo.state === 'playing') {
        this.playbackInfo.position = advanceSoftPlaybackPosition(
          previousPosition,
          elapsed,
          rate,
          this.playbackInfo.duration
        )
      }
      this.lastTick = now

      const nativeInfo = this.readNativePlaybackInfo()
      if (nativeInfo) {
        this.playbackInfo = this.mergeNativePlaybackInfo(nativeInfo)
        const nativeIdentityPending = this.pendingNativeSource !== null
        const nextCapabilitySignature = this.createDeviceCapabilityRefreshSignature(
          this.playbackInfo
        )
        if (nextCapabilitySignature !== previousCapabilitySignature) {
          this.invalidateAudioDeviceOptionsCache('native-output-diagnostics-changed')
        }
        this.lastNativePlaybackInfoTickReadAt = now
        this.publishProperty('time-pos', this.playbackInfo.position)
        if (this.playbackInfo.duration > 0) {
          this.publishDuration(this.playbackInfo.duration)
        }
        this.publishPlaybackInfo({ dedupePositionOnly: true })
        const switchedTrack =
          !nativeIdentityPending &&
          nativeInfo.state !== 'stopped' &&
          ((nativeInfo.source && nativeInfo.source !== previousSource) ||
            (nativeInfo.queueIndex >= 0 && nativeInfo.queueIndex !== previousQueueIndex))
        if (switchedTrack) {
          // A fully delegated native queue advances without a renderer EOF
          // callback. Report its boundary in the main process so sleep timers
          // retain the same semantics as renderer-managed playback.
          if (this.queue.length > 1) this.emit('sleep-timer-boundary', { boundary: 'trackEnd' })
          // A looping native queue never stops, so passing the last entry is the
          // only queue boundary it will ever produce. The renderer path reports
          // queueEnd right before it wraps (advanceAfterPlaybackEnded), so mirror
          // that order here — otherwise "stop at end of queue" would never fire
          // once the queue is delegated.
          if (
            this.queue.length > 1 &&
            playModeWrapsAtQueueEnd(this.playbackInfo.playMode) &&
            previousQueueIndex === this.queue.length - 1 &&
            nativeInfo.queueIndex === 0
          ) {
            this.emit('sleep-timer-boundary', { boundary: 'queueEnd' })
          }
          this.emit('start-file')
        }
        if (
          wasPlaying &&
          !nativeIdentityPending &&
          this.pendingNativePositionTarget === null &&
          nativeInfo.state === 'stopped'
        ) {
          // Trust the engine's own verdict instead of comparing indexes:
          // upcomingTrack is null exactly when its queue manager cannot advance
          // any further. The old index comparison misread a looping or repeating
          // queue as finished, and read the last entry of a shuffled native play
          // order as mid-queue.
          const isAtEnd = this.queue.length === 0 || !nativeInfo.upcomingTrack
          if (isAtEnd) {
            // 播放结束：保持 nativePlaybackActive=true 以便持续轮询原生真实状态，
            // 避免状态发散后无法自我纠正。下次 play() 会重新设置状态。
            this.publishProperty('eof-reached', true)
            // A native single-track queue and the final item in a delegated
            // queue do not produce a renderer EOF callback. They are still a
            // track boundary before they are a queue boundary, so emit both in
            // that order. The following tick sees `wasPlaying === false`,
            // which prevents a duplicate terminal boundary.
            this.emit('sleep-timer-boundary', { boundary: 'trackEnd' })
            this.emit('sleep-timer-boundary', { boundary: 'queueEnd' })
          }
        }
        return
      }

      this.publishProperty('time-pos', this.playbackInfo.position)
      return
    }

    if (this.playbackInfo.state !== 'playing') return
    const now = this.scheduler.now()
    const elapsed = (now - this.lastTick) / 1000
    this.lastTick = now
    this.playbackInfo.position = advanceSoftPlaybackPosition(
      this.playbackInfo.position,
      elapsed,
      this.playbackInfo.playbackRate ?? 1,
      this.playbackInfo.duration
    )
    if (
      this.playbackInfo.duration > 0 &&
      this.playbackInfo.position >= this.playbackInfo.duration
    ) {
      this.playbackInfo.position = this.playbackInfo.duration
      this.playbackInfo.state = 'stopped'
      this.publishProperty('time-pos', this.playbackInfo.position)
      this.publishProperty('eof-reached', true)
      this.emit('end-file', { reason: 'eof' })
      return
    }
    this.publishProperty('time-pos', this.playbackInfo.position)
  }

  invalidateUpcomingTrackCache(): void {
    this.lastUpcomingTrackCache = null
  }

  async tryNativePlay(
    context: string,
    source: string,
    startTime: number,
    logFailure = true
  ): Promise<boolean> {
    if (!this.native) {
      this.lastNativeError = '未加载 twilight_audio_node.node'
      return false
    }
    if (typeof this.native.callAsync === 'function') {
      try {
        await this.native.callAsync('Play', [source, startTime])
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
    return this.tryNative(context, (native) => native.Play(source, startTime), logFailure)
  }

  publishProperty(name: string, data: unknown): void {
    this.emit('property-change', { name, data })
  }

  publishDuration(duration: number, options: { force?: boolean } = {}): void {
    if (!options.force && Object.is(duration, this.lastPublishedDuration)) return
    this.lastPublishedDuration = duration
    this.publishProperty('duration', duration)
  }

  createPlaybackInfoFanoutKey(): string {
    return createPlaybackInfoFanoutSignature(this.playbackInfo, this.nativePlaybackActive)
  }

  publishPlaybackInfo(options: { dedupePositionOnly?: boolean } = {}): void {
    const fanoutKey = this.createPlaybackInfoFanoutKey()
    if (options.dedupePositionOnly && fanoutKey === this.lastPlaybackInfoFanoutKey) return

    this.lastPlaybackInfoFanoutKey = fanoutKey
    this.emit('playback-info', {
      ...this.playbackInfo,
      nativePlaybackActive: this.nativePlaybackActive
    })
    this.publishPendingConfigAppliedEvent()
  }

  publishPendingConfigAppliedEvent(): void {
    const event = this.pendingConfigAppliedEvent
    if (!event || this.playbackInfo.appliedConfigRevision < event.appliedConfigRevision) return

    this.pendingConfigAppliedEvent = null
    this.lastEmittedAppliedConfigRevision = event.appliedConfigRevision
    this.emit('config-applied', event)
  }
}
