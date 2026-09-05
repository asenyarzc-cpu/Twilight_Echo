import type {
  AudioDeviceOption,
  AudioEngineConfig,
  AudioEngineManagerDependencies,
  AudioEngineScheduler,
  AudioOutputId,
  AudioOutputOption,
  AudioOutputState,
  ChannelRoutingMode,
  NativeAudioBinding,
  OutputConfig,
  OutputConfigApplyStatus,
  PlaybackInfo
} from './audioEngineTypes.ts'
import {
  AUDIO_DEVICE_OPTIONS_CACHE_TTL_MS,
  AUDIO_DEVICE_OPTIONS_DEFAULT_FOLLOW_POLL_MS,
  AUDIO_DEVICE_OPTIONS_HOTPLUG_POLL_MS,
  DEFAULT_AUDIO_DEVICE_OPTION,
  createDefaultPlaybackInfo,
  deviceCompatibleWithOutput,
  deviceOptionBelongsToAsio,
  getAudioOutputOptions,
  isDefaultAudioDeviceAlias,
  normalizeAudioDevice,
  normalizeAudioDeviceOptions,
  normalizeAudioOutput,
  normalizeOutputConfig,
  outputConfigsEqual,
  parseNativeJson,
  supportsAudioExclusive
} from './audioEngineHelpers.ts'
import { deviceOptionsForOutput } from '../../shared/audioDeviceRouting.ts'
import { audioEngineError, nativeAudioError } from './engineErrors.ts'

export interface OutputRouterHost {
  getNative(): NativeAudioBinding | null
  getPlaybackInfo(): PlaybackInfo
  setPlaybackInfo(info: PlaybackInfo): void
  getLastNativeError(): string
  getScheduler(): AudioEngineScheduler
  isDestroyed(): boolean
  getNativeOutputRouteSynced(): boolean
  setNativeOutputRouteSynced(value: boolean): void
  setNativePlaybackActive(value: boolean): void
  callNativeMaybeAsync(
    context: string,
    method: keyof NativeAudioBinding,
    ...args: unknown[]
  ): Promise<boolean>
  applyNativeDspGraphOrThrow(context: string): Promise<unknown>
  readNativePlaybackInfo(): PlaybackInfo | null
  readNativePlaybackInfoAsync(): Promise<PlaybackInfo | null>
  mergeNativePlaybackInfo(nativeInfo: PlaybackInfo): PlaybackInfo
  updateOutputPerfect(): void
  publishPlaybackInfo(): void
  syncPlaybackOutputMirrorsFromOutputInfo(): void
  emit(event: string, payload?: unknown): void
}

export class OutputRouter {
  output: AudioOutputId
  device: string
  exclusiveMode: boolean
  outputConfig: OutputConfig
  private directRoutingOverride: ChannelRoutingMode | null = null
  outputConfigRevision = 0
  outputConfigApplyGeneration = 0
  outputConfigServiceGeneration = 0
  outputConfigApplyQueue: Promise<void> = Promise.resolve()
  outputConfigApplyStatus: OutputConfigApplyStatus = {
    requestedRevision: 0,
    appliedRevision: 0,
    failedRevision: 0,
    state: 'idle',
    error: '',
    generation: 0
  }
  deviceOptionsProvider?: () => AudioDeviceOption[] | null
  lastAudioDeviceOptionsCache: {
    selectedDevice: string
    readAt: number
    options: AudioDeviceOption[]
  } | null = null
  lastAudioDeviceOptionsSignature = ''
  lastAudioDeviceOptionsProbeAt = Number.NEGATIVE_INFINITY
  lastFollowedDefaultDeviceId = ''
  autoDeviceRebindInFlight: Promise<void> | null = null
  /** Last explicit device per backend, so a backend switch is not a device reset. */
  private readonly lastDeviceByOutput = new Map<AudioOutputId, string>()

  private readonly host: OutputRouterHost

  constructor(
    host: OutputRouterHost,
    config: Pick<
      AudioEngineConfig,
      'audioOutput' | 'audioDevice' | 'exclusiveMode' | 'audioOutputConfig'
    >,
    dependencies: Pick<AudioEngineManagerDependencies, 'deviceOptionsProvider'>
  ) {
    this.host = host
    this.deviceOptionsProvider = dependencies.deviceOptionsProvider
    this.output = normalizeAudioOutput(config.audioOutput)
    this.device = normalizeAudioDevice(config.audioDevice)
    this.exclusiveMode = Boolean(config.exclusiveMode)
    this.outputConfig = normalizeOutputConfig(config.audioOutputConfig)
    // Compatible device resolution needs options; defer until host playbackInfo exists.
  }

  /** Call after host playbackInfo is ready and native binding may be available. */
  initializeDeviceSelection(): void {
    this.device = this.resolveCompatibleDevice(this.output, this.device)
    this.exclusiveMode = this.exclusiveMode && supportsAudioExclusive(this.output)
  }

  private get native(): NativeAudioBinding | null {
    return this.host.getNative()
  }

  private get playbackInfo(): PlaybackInfo {
    return this.host.getPlaybackInfo()
  }

  private set playbackInfo(info: PlaybackInfo) {
    this.host.setPlaybackInfo(info)
  }

  private get lastNativeError(): string {
    return this.host.getLastNativeError()
  }

  private get scheduler(): AudioEngineScheduler {
    return this.host.getScheduler()
  }

  private get destroyed(): boolean {
    return this.host.isDestroyed()
  }

  private get nativeOutputRouteSynced(): boolean {
    return this.host.getNativeOutputRouteSynced()
  }

  private set nativeOutputRouteSynced(value: boolean) {
    this.host.setNativeOutputRouteSynced(value)
  }

  private setNativePlaybackActive(value: boolean): void {
    this.host.setNativePlaybackActive(value)
  }

  private callNativeMaybeAsync(
    context: string,
    method: keyof NativeAudioBinding,
    ...args: unknown[]
  ): Promise<boolean> {
    return this.host.callNativeMaybeAsync(context, method, ...args)
  }

  private applyNativeDspGraphOrThrow(context: string): Promise<unknown> {
    return this.host.applyNativeDspGraphOrThrow(context)
  }

  private readNativePlaybackInfo(): PlaybackInfo | null {
    return this.host.readNativePlaybackInfo()
  }

  private readNativePlaybackInfoAsync(): Promise<PlaybackInfo | null> {
    return this.host.readNativePlaybackInfoAsync()
  }

  private mergeNativePlaybackInfo(nativeInfo: PlaybackInfo): PlaybackInfo {
    return this.host.mergeNativePlaybackInfo(nativeInfo)
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

  private emit(event: string, payload?: unknown): void {
    this.host.emit(event, payload)
  }

  bumpServiceGeneration(): void {
    this.outputConfigServiceGeneration += 1
    if (this.outputConfigApplyStatus.state === 'pending') {
      // caller supplies reason via failPending if needed
    }
  }

  failPendingOutputConfig(reason: string, generation: number): void {
    if (this.outputConfigApplyStatus.state === 'pending') {
      this.outputConfigApplyStatus = {
        ...this.outputConfigApplyStatus,
        failedRevision: this.outputConfigApplyStatus.requestedRevision,
        state: 'failed',
        error: reason,
        generation
      }
    }
  }

  async restoreAudioServiceOutputRoute(
    contextPrefix = '音频服务恢复后应用'
  ): Promise<{ synced: boolean; errors: string[] }> {
    const results: Array<{ ok: boolean; error: string }> = []
    results.push(
      await this.restoreAudioServiceOutputRouteStep(
        'output-backend',
        `${contextPrefix}输出后端`,
        'SetOutputBackend',
        this.getNativeBackendId()
      )
    )
    results.push(
      await this.restoreAudioServiceOutputRouteStep(
        'output-device',
        `${contextPrefix}输出设备`,
        'SetOutputDevice',
        this.device
      )
    )
    results.push(
      await this.restoreAudioServiceOutputRouteStep(
        'output-config',
        `${contextPrefix}输出配置`,
        'SetOutputConfig',
        JSON.stringify(this.getEffectiveOutputConfig())
      )
    )
    const synced = results.every((result) => result.ok)
    if (synced) this.rememberFollowedDefaultDeviceFromOptions()
    return {
      synced,
      errors: results.filter((result) => !result.ok).map((result) => result.error)
    }
  }

  async restoreAudioServiceOutputRouteStep(
    id: string,
    context: string,
    method: keyof NativeAudioBinding,
    ...args: unknown[]
  ): Promise<{ ok: boolean; error: string }> {
    const ok = await this.callNativeMaybeAsync(context, method, ...args)
    return {
      ok,
      error: ok ? '' : `${id}: ${this.lastNativeError || context}`
    }
  }

  async setExclusiveMode(enabled: boolean): Promise<AudioOutputState> {
    if (enabled && !supportsAudioExclusive(this.output)) {
      throw audioEngineError(
        'audio.exclusive_unsupported',
        `${this.output} does not support exclusive mode`,
        { backend: this.output }
      )
    }
    if (this.nativeOutputRouteSynced && enabled === this.exclusiveMode) {
      return await this.getAudioOutputState()
    }

    await this.runOutputRouteTransaction({
      context: 'exclusive-mode',
      nextOutput: this.output,
      nextDevice: this.device,
      nextExclusiveMode: enabled,
      nextConfig: this.outputConfig,
      errorCode: 'audio.exclusive_switch_failed',
      errorMessage: 'exclusive mode switch failed',
      cacheReason: 'exclusive-mode-changed'
    })
    await this.applyNativeDspGraphOrThrow('独占模式切换后解析 DSP 场景')
    return await this.getAudioOutputState()
  }

  async getExclusiveMode(): Promise<boolean> {
    return this.exclusiveMode
  }

  async setAudioOutput(output: AudioOutputId, device?: string): Promise<AudioOutputState> {
    const nextOutput = normalizeAudioOutput(output)
    const outputChanged = nextOutput !== this.output
    // Switching backend used to hard-reset the device to 'auto', discarding an
    // explicit pick every time the user compared two backends. Remember the
    // outgoing selection per backend and restore it on the way back.
    if (outputChanged) this.lastDeviceByOutput.set(this.output, this.device)
    const requestedDevice =
      device ?? (outputChanged ? (this.lastDeviceByOutput.get(nextOutput) ?? 'auto') : this.device)
    const nextDevice = this.resolveCompatibleDevice(
      nextOutput,
      normalizeAudioDevice(requestedDevice)
    )
    const nextExclusiveMode = supportsAudioExclusive(nextOutput) ? this.exclusiveMode : false
    if (
      this.nativeOutputRouteSynced &&
      nextOutput === this.output &&
      nextDevice === this.device &&
      nextExclusiveMode === this.exclusiveMode
    ) {
      return await this.getAudioOutputState()
    }

    await this.runOutputRouteTransaction({
      context: 'audio-output',
      nextOutput,
      nextDevice,
      nextExclusiveMode,
      nextConfig: this.outputConfig,
      errorCode: 'audio.output_switch_failed',
      errorMessage: 'audio output switch failed',
      cacheReason: 'audio-output-changed'
    })
    await this.applyNativeDspGraphOrThrow('输出后端切换后解析 DSP 场景')
    return await this.getAudioOutputState()
  }

  async setAudioDevice(device: string): Promise<AudioOutputState> {
    const nextDevice = this.resolveCompatibleDevice(this.output, normalizeAudioDevice(device))
    if (this.nativeOutputRouteSynced && nextDevice === this.device)
      return await this.getAudioOutputState()

    await this.runOutputRouteTransaction({
      context: 'audio-device',
      nextOutput: this.output,
      nextDevice,
      nextExclusiveMode: this.exclusiveMode,
      nextConfig: this.outputConfig,
      errorCode: 'audio.device_switch_failed',
      errorMessage: 'audio output device switch failed',
      cacheReason: 'audio-device-changed'
    })
    this.rememberFollowedDefaultDeviceFromOptions()
    await this.applyNativeDspGraphOrThrow('输出设备切换后解析 DSP 场景')
    return await this.getAudioOutputState()
  }

  async setOutputConfig(config: Partial<OutputConfig>): Promise<void> {
    const revision = ++this.outputConfigRevision
    const generation = ++this.outputConfigApplyGeneration
    this.outputConfigApplyStatus = {
      ...this.outputConfigApplyStatus,
      requestedRevision: revision,
      state: 'pending',
      error: '',
      generation
    }

    const queued = this.outputConfigApplyQueue.then(async () => {
      const serviceGeneration = this.outputConfigServiceGeneration
      const changed = await this.applyOutputConfigDirect(config)
      if (serviceGeneration !== this.outputConfigServiceGeneration) {
        throw audioEngineError(
          'audio.service_restarted_during_topology',
          'audio service restarted while updating the output topology'
        )
      }
      if (changed) {
        const nativeInfo = await this.readNativePlaybackInfoAsync()
        if (serviceGeneration !== this.outputConfigServiceGeneration) {
          throw audioEngineError(
            'audio.service_restarted_during_ack',
            'audio service restarted while reading the output topology ACK'
          )
        }
        if (nativeInfo) {
          this.playbackInfo = this.mergeNativePlaybackInfo(nativeInfo)
          this.publishPlaybackInfo()
        }
      }
      if (generation === this.outputConfigApplyGeneration) {
        this.outputConfigApplyStatus = {
          ...this.outputConfigApplyStatus,
          appliedRevision: revision,
          state: 'applied',
          error: '',
          generation
        }
      }
    })
    this.outputConfigApplyQueue = queued.catch(() => undefined)
    try {
      await queued
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (generation === this.outputConfigApplyGeneration) {
        this.outputConfigApplyStatus = {
          ...this.outputConfigApplyStatus,
          failedRevision: revision,
          state: 'failed',
          error: message,
          generation
        }
      }
      throw error
    }
  }

  getOutputConfig(): OutputConfig {
    return { ...this.outputConfig }
  }

  getEffectiveOutputConfig(): OutputConfig {
    return this.effectiveOutputConfig(this.outputConfig)
  }

  async setDirectRoutingOverride(enabled: boolean): Promise<void> {
    const nextOverride: ChannelRoutingMode | null = enabled ? 'auto' : null
    if (this.directRoutingOverride === nextOverride) return

    const previousOverride = this.directRoutingOverride
    this.directRoutingOverride = nextOverride
    this.nativeOutputRouteSynced = false
    const applied = await this.callNativeMaybeAsync(
      '应用直通声道路由',
      'SetOutputConfig',
      JSON.stringify(this.getEffectiveOutputConfig())
    )
    if (!applied) {
      this.directRoutingOverride = previousOverride
      throw nativeAudioError(
        'audio.direct_routing_failed',
        'direct channel routing apply failed',
        this.lastNativeError
      )
    }
    this.nativeOutputRouteSynced = true
    this.playbackInfo.outputInfo.channelRoutingMode = this.getEffectiveOutputConfig().routingMode
  }

  getOutputConfigApplyStatus(): OutputConfigApplyStatus {
    return { ...this.outputConfigApplyStatus }
  }

  private async applyOutputConfigDirect(config: Partial<OutputConfig>): Promise<boolean> {
    const nextConfig = normalizeOutputConfig({ ...this.outputConfig, ...config })
    if (outputConfigsEqual(nextConfig, this.outputConfig)) return false

    await this.runOutputRouteTransaction({
      context: 'output-config',
      nextOutput: this.output,
      nextDevice: this.device,
      nextExclusiveMode: this.exclusiveMode,
      nextConfig,
      errorCode: 'audio.output_config_failed',
      errorMessage: 'output config apply failed',
      cacheReason: 'output-config-changed'
    })
    this.playbackInfo.outputInfo.channelRoutingMode = this.getEffectiveOutputConfig().routingMode
    await this.applyNativeDspGraphOrThrow('输出配置切换后解析 DSP 场景')
    return true
  }

  private async runOutputRouteTransaction(options: {
    context: string
    nextOutput: AudioOutputId
    nextDevice: string
    nextExclusiveMode: boolean
    nextConfig: OutputConfig
    errorCode: string
    errorMessage: string
    cacheReason: string
    expectedActualDeviceId?: string
  }): Promise<void> {
    const snapshot = {
      output: this.output,
      device: this.device,
      exclusiveMode: this.exclusiveMode,
      outputConfig: { ...this.outputConfig },
      effectiveConfig: { ...this.getEffectiveOutputConfig() },
      nativeBackendId: this.getNativeBackendId(),
      playbackInfo: { ...this.playbackInfo, outputInfo: { ...this.playbackInfo.outputInfo } },
      volume: this.playbackInfo.volume,
      serviceGeneration: this.outputConfigServiceGeneration
    }
    const targetNativeBackendId = this.getNativeBackendIdFor(
      options.nextOutput,
      options.nextExclusiveMode
    )
    const targetEffectiveConfig = this.effectiveOutputConfig(options.nextConfig)

    this.emitOutputRouteTransaction(options.context, 'prepare')
    this.assertOutputTargetAvailable(options.nextOutput, options.nextDevice)
    this.emitOutputRouteTransaction(options.context, 'validate')

    const muteSynced = await this.callNativeMaybeAsync('输出切换事务静音', 'SetVolume', 0)
    if (!muteSynced) {
      throw nativeAudioError(options.errorCode, options.errorMessage, this.lastNativeError)
    }
    this.emitOutputRouteTransaction(options.context, 'mute')

    try {
      this.nativeOutputRouteSynced = false
      this.emitOutputRouteTransaction(options.context, 'open-target')
      await this.applyOutputRouteStepsOrThrow(
        options.context,
        targetNativeBackendId,
        options.nextDevice,
        targetEffectiveConfig
      )
      if (snapshot.serviceGeneration !== this.outputConfigServiceGeneration) {
        throw audioEngineError(
          'audio.service_restarted_during_topology',
          'audio service restarted while updating the output topology'
        )
      }
      this.emitOutputRouteTransaction(options.context, 'verify-target-ready')
      const targetInfo = await this.readNativePlaybackInfoAsync()
      if (snapshot.playbackInfo.state !== 'stopped') {
        const targetBackend = targetInfo?.outputInfo.actualBackend || targetInfo?.actualBackend
        const actualDevice =
          targetInfo?.outputInfo.actualDeviceName || targetInfo?.outputDevice || ''
        const actualDeviceId = targetInfo?.outputInfo.actualDeviceId || ''
        const targetOption = this.getFreshAudioDeviceOptions().find(
          (entry) => entry.id === options.nextDevice
        )
        const acceptedDeviceNames = new Set(
          [options.nextDevice, targetOption?.label, targetOption?.name].filter(
            (value): value is string => Boolean(value)
          )
        )
        let actualDeviceMatches = true
        if (options.expectedActualDeviceId) {
          actualDeviceMatches = actualDeviceId === options.expectedActualDeviceId
        } else if (!isDefaultAudioDeviceAlias(options.nextDevice)) {
          actualDeviceMatches = actualDeviceId
            ? actualDeviceId === options.nextDevice
            : acceptedDeviceNames.has(actualDevice)
        }
        if (
          !targetInfo ||
          targetBackend !== targetNativeBackendId ||
          !actualDeviceMatches ||
          targetInfo.state !== snapshot.playbackInfo.state ||
          targetInfo.source !== snapshot.playbackInfo.source
        ) {
          throw audioEngineError(
            'audio.output_target_not_ready',
            'target output route did not preserve the active playback session',
            {
              expectedBackend: targetNativeBackendId,
              actualBackend: targetBackend || '',
              expectedDevice: options.nextDevice,
              expectedActualDeviceId: options.expectedActualDeviceId || '',
              actualDeviceId,
              actualDevice,
              expectedState: snapshot.playbackInfo.state,
              actualState: targetInfo?.state || 'unavailable'
            }
          )
        }
      }
      if (snapshot.serviceGeneration !== this.outputConfigServiceGeneration) {
        throw audioEngineError(
          'audio.service_restarted_during_ack',
          'audio service restarted while reading the output topology ACK'
        )
      }

      this.output = options.nextOutput
      this.device = options.nextDevice
      this.exclusiveMode = options.nextExclusiveMode
      this.outputConfig = options.nextConfig
      this.invalidateAudioDeviceOptionsCache(options.cacheReason)
      this.nativeOutputRouteSynced = true
      this.emitOutputRouteTransaction(options.context, 'commit')
      this.refreshOutputInfoFromNative(true)
      const unmuteSynced = await this.callNativeMaybeAsync(
        '输出切换事务恢复音量',
        'SetVolume',
        snapshot.volume
      )
      if (!unmuteSynced) {
        throw nativeAudioError(options.errorCode, options.errorMessage, this.lastNativeError)
      }
      this.playbackInfo.volume = snapshot.volume
      this.emitOutputRouteTransaction(options.context, 'unmute')
      this.publishPlaybackInfo()
    } catch (error) {
      const rollback = await this.rollbackOutputRouteTransaction(options.context, snapshot)
      if (!rollback) {
        this.nativeOutputRouteSynced = false
        await this.callNativeMaybeAsync('输出切换事务安全停止', 'Stop')
        this.setNativePlaybackActive(false)
        this.playbackInfo = {
          ...snapshot.playbackInfo,
          state: 'stopped',
          nativePlaybackActive: false
        }
        this.publishPlaybackInfo()
        this.emitOutputRouteTransaction(options.context, 'safe-stop')
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw nativeAudioError(options.errorCode, options.errorMessage, detail)
    }
  }

  private async applyOutputRouteStepsOrThrow(
    context: string,
    backend: string,
    device: string,
    config: OutputConfig
  ): Promise<void> {
    const backendSynced = await this.callNativeMaybeAsync(
      `${context} 输出切换事务应用 backend`,
      'SetOutputBackend',
      backend
    )
    if (!backendSynced) throw new Error(this.lastNativeError || 'SetOutputBackend failed')
    const deviceSynced = await this.callNativeMaybeAsync(
      `${context} 输出切换事务应用 device`,
      'SetOutputDevice',
      device
    )
    if (!deviceSynced) throw new Error(this.lastNativeError || 'SetOutputDevice failed')
    const configSynced = await this.callNativeMaybeAsync(
      `${context} 输出切换事务应用 config`,
      'SetOutputConfig',
      JSON.stringify(config)
    )
    if (!configSynced) throw new Error(this.lastNativeError || 'SetOutputConfig failed')
  }

  private async rollbackOutputRouteTransaction(
    context: string,
    snapshot: {
      output: AudioOutputId
      device: string
      exclusiveMode: boolean
      outputConfig: OutputConfig
      effectiveConfig: OutputConfig
      nativeBackendId: string
      playbackInfo: PlaybackInfo
      volume: number
      serviceGeneration: number
    }
  ): Promise<boolean> {
    this.emitOutputRouteTransaction(context, 'rollback')
    try {
      await this.applyOutputRouteStepsOrThrow(
        `${context} rollback`,
        snapshot.nativeBackendId,
        snapshot.device,
        snapshot.effectiveConfig
      )
      if (snapshot.serviceGeneration !== this.outputConfigServiceGeneration) return false
      const unmuteSynced = await this.callNativeMaybeAsync(
        '输出切换事务回滚恢复音量',
        'SetVolume',
        snapshot.volume
      )
      if (!unmuteSynced) return false
      this.output = snapshot.output
      this.device = snapshot.device
      this.exclusiveMode = snapshot.exclusiveMode
      this.outputConfig = snapshot.outputConfig
      this.playbackInfo = snapshot.playbackInfo
      this.nativeOutputRouteSynced = true
      this.invalidateAudioDeviceOptionsCache('output-route-rollback')
      this.publishPlaybackInfo()
      return true
    } catch {
      return false
    }
  }

  private assertOutputTargetAvailable(output: AudioOutputId, device: string): void {
    if (isDefaultAudioDeviceAlias(device)) return
    const options = this.getFreshAudioDeviceOptions()
    const option = options.find((entry) => entry.id === device)
    const available =
      output === 'asio'
        ? Boolean(option && deviceOptionBelongsToAsio(option))
        : deviceCompatibleWithOutput(output, device, options)
    if (available) return
    throw audioEngineError(
      'audio.output_target_unavailable',
      'target output device is unavailable',
      {
        output,
        device
      }
    )
  }

  private getFreshAudioDeviceOptions(): AudioDeviceOption[] {
    const injectedDevices = this.deviceOptionsProvider?.()
    if (Array.isArray(injectedDevices) && injectedDevices.length > 0) {
      return normalizeAudioDeviceOptions(injectedDevices)
    }
    return this.readNativeAudioDeviceOptions()
  }

  private getNativeBackendIdFor(output: AudioOutputId, exclusiveMode: boolean): string {
    if (output === 'wasapi' && exclusiveMode) return 'wasapi-exclusive'
    if (output === 'coreaudio' && exclusiveMode) return 'coreaudio-exclusive'
    return output
  }

  private emitOutputRouteTransaction(context: string, phase: string): void {
    this.emit('output-route-transaction', { context, phase, at: new Date().toISOString() })
  }

  async getAudioOutput(): Promise<AudioOutputId> {
    return this.output
  }

  getAudioOutputOptions(): AudioOutputOption[] {
    return getAudioOutputOptions()
  }

  async getAudioOutputState(): Promise<AudioOutputState> {
    return {
      output: this.output,
      device: this.device,
      exclusiveMode: this.exclusiveMode,
      exclusiveAvailable: supportsAudioExclusive(this.output),
      outputOptions: getAudioOutputOptions(),
      deviceOptions: this.getAudioDeviceOptions()
    }
  }

  notifyAudioDeviceOptionsChanged(reason = 'platform-device-change'): void {
    if (this.destroyed) return
    this.lastAudioDeviceOptionsProbeAt = Number.NEGATIVE_INFINITY
    this.invalidateAudioDeviceOptionsCache(reason)
    void this.maybeRebindAutoOutputDevice(reason)
  }

  getNativeBackendId(): string {
    if (this.output === 'wasapi' && this.exclusiveMode) return 'wasapi-exclusive'
    if (this.output === 'coreaudio' && this.exclusiveMode) return 'coreaudio-exclusive'
    return this.output
  }

  resolveCompatibleDevice(output: AudioOutputId, device: string): string {
    const normalized = normalizeAudioDevice(device)
    const options = this.getAudioDeviceOptions()
    if (output === 'asio') return this.resolveCompatibleAsioDevice(normalized, options)
    return deviceCompatibleWithOutput(output, normalized, options) ? normalized : 'auto'
  }

  private resolveCompatibleAsioDevice(normalized: string, options: AudioDeviceOption[]): string {
    const asioOptions = deviceOptionsForOutput('asio', options)
    // Nothing is known about the catalog yet. This runs from the manager
    // constructor too, before the audio service is up, so rewriting the selection
    // here silently discarded a persisted ASIO driver on every launch.
    if (asioOptions.length === 0) return normalized

    if (normalized.startsWith('asio:')) {
      if (asioOptions.some((option) => option.id === normalized)) return normalized
      const legacyName = normalized.slice('asio:'.length)
      const matches = asioOptions.filter((option) => option.label === legacyName)
      if (matches.length === 1) return matches[0].id
      // An ambiguous legacy display name must not be resolved to one of its
      // candidates. Keep it unresolved so the backend reports it by name.
      if (matches.length > 1) return normalized
    }

    // Either no explicit pick, or a driver that is genuinely gone from a catalog
    // we can read. ASIO has no system-default endpoint, so leaving 'auto' here
    // lets whichever driver enumerates first win while the picker shows an inert
    // "系统默认" row — on a machine with FL Studio / Voicemeeter / ASIO4ALL
    // registered that is essentially never the user's DAC. Bind an explicit
    // driver instead, so the selection is visible and one click from correction.
    return asioOptions[0]?.id ?? normalized
  }

  shouldFallbackFromAsio(output: AudioOutputId): boolean {
    return output === 'asio'
  }

  resetOutputInfoDefaults(): void {
    const fallback = createDefaultPlaybackInfo(
      this.output,
      this.device,
      this.exclusiveMode,
      this.getEffectiveOutputConfig()
    )
    this.playbackInfo.outputBackend = this.getNativeBackendId()
    this.playbackInfo.outputDevice = this.device
    this.playbackInfo.actualBackend = this.getNativeBackendId()
    this.playbackInfo.outputInfo = {
      ...fallback.outputInfo,
      backend: this.getNativeBackendId(),
      actualBackend: this.getNativeBackendId()
    }
    this.syncPlaybackOutputMirrorsFromOutputInfo()
  }

  refreshOutputInfoFromNative(resetDefaults: boolean): void {
    if (resetDefaults) this.resetOutputInfoDefaults()
    const nativeInfo = this.readNativePlaybackInfo()
    if (nativeInfo) this.playbackInfo = this.mergeNativePlaybackInfo(nativeInfo)
    this.updateOutputPerfect()
    this.publishPlaybackInfo()
  }

  getAudioDeviceOptions(): AudioDeviceOption[] {
    const injectedDevices = this.deviceOptionsProvider?.()
    if (Array.isArray(injectedDevices) && injectedDevices.length > 0) {
      return normalizeAudioDeviceOptions(injectedDevices)
    }
    const now = this.scheduler.now()
    const cached = this.lastAudioDeviceOptionsCache
    if (
      cached &&
      cached.selectedDevice === this.device &&
      now - cached.readAt <= AUDIO_DEVICE_OPTIONS_CACHE_TTL_MS
    ) {
      return cached.options
    }
    const options = this.readNativeAudioDeviceOptions()
    this.lastAudioDeviceOptionsCache = {
      selectedDevice: this.device,
      readAt: now,
      options
    }
    this.lastAudioDeviceOptionsSignature = this.createAudioDeviceOptionsSignature(options)
    return options
  }

  private readNativeAudioDeviceOptions(): AudioDeviceOption[] {
    let nativeDevices: unknown = null
    try {
      nativeDevices = parseNativeJson(
        this.native?.EnumerateDevices?.(),
        null as AudioDeviceOption[] | null
      )
    } catch {
      // Fall through to the stable default device.
    }
    const normalizedDevices = normalizeAudioDeviceOptions(nativeDevices)
    return normalizedDevices.length > 0 ? normalizedDevices : [{ ...DEFAULT_AUDIO_DEVICE_OPTION }]
  }

  invalidateAudioDeviceOptionsCache(reason: string): void {
    this.lastAudioDeviceOptionsCache = null
    this.emit('audio-device-options-changed', { reason })
  }

  pollAudioDeviceOptionsForChanges(): void {
    if (!this.native || this.deviceOptionsProvider) return
    const now = this.scheduler.now()
    const pollMs =
      this.device === 'auto'
        ? AUDIO_DEVICE_OPTIONS_DEFAULT_FOLLOW_POLL_MS
        : AUDIO_DEVICE_OPTIONS_HOTPLUG_POLL_MS
    if (now - this.lastAudioDeviceOptionsProbeAt < pollMs) return
    this.lastAudioDeviceOptionsProbeAt = now

    const options = this.readNativeAudioDeviceOptions()
    const signature = this.createAudioDeviceOptionsSignature(options)
    if (
      this.lastAudioDeviceOptionsSignature &&
      signature !== this.lastAudioDeviceOptionsSignature
    ) {
      this.lastAudioDeviceOptionsCache = {
        selectedDevice: this.device,
        readAt: now,
        options
      }
      this.lastAudioDeviceOptionsSignature = signature
      this.emit('audio-device-options-changed', { reason: 'audio-device-hotplug' })
      void this.maybeRebindAutoOutputDevice('audio-device-hotplug')
      return
    }
    this.lastAudioDeviceOptionsSignature = signature
    // Signature can be stable on some hosts while the default endpoint still flips; always check.
    void this.maybeRebindAutoOutputDevice('audio-device-default-follow-poll')
  }

  private resolvePhysicalDefaultDeviceId(options: AudioDeviceOption[]): string {
    const physical = options.find(
      (option) =>
        option.isDefault === true &&
        option.id &&
        option.id !== DEFAULT_AUDIO_DEVICE_OPTION.id &&
        !isDefaultAudioDeviceAlias(option.id)
    )
    return physical?.id || ''
  }

  private rememberFollowedDefaultDeviceFromOptions(
    options: AudioDeviceOption[] = this.readNativeAudioDeviceOptions()
  ): void {
    if (this.device !== 'auto') {
      this.lastFollowedDefaultDeviceId = ''
      return
    }
    const defaultId = this.resolvePhysicalDefaultDeviceId(options)
    if (defaultId) this.lastFollowedDefaultDeviceId = defaultId
  }

  private maybeRebindAutoOutputDevice(reason: string): void {
    if (this.destroyed) return
    if (this.device !== 'auto') return
    if (!this.native || !this.nativeOutputRouteSynced) return
    if (this.autoDeviceRebindInFlight) return

    // ASIO has no OS-default endpoint to follow. A selection still sitting on
    // 'auto' means the driver catalog was unreadable when it was resolved (the
    // manager resolves this in its constructor, before the audio service is up),
    // and 'auto' then lets whichever driver enumerates first win. Promote it to
    // an explicit driver now that the catalog can be read.
    if (this.output === 'asio') {
      this.autoDeviceRebindInFlight = this.promoteAutoAsioDevice(reason).finally(() => {
        this.autoDeviceRebindInFlight = null
      })
      return
    }

    // Always follow OS default while selection is `auto`. When idle, SetOutputDevice only
    // updates the preferred endpoint; when playing/paused the native path rebinds in place.
    this.autoDeviceRebindInFlight = this.rebindAutoOutputDevice(reason).finally(() => {
      this.autoDeviceRebindInFlight = null
    })
  }

  private async promoteAutoAsioDevice(reason: string): Promise<void> {
    if (this.destroyed || this.output !== 'asio' || this.device !== 'auto') return
    const explicit = this.resolveCompatibleAsioDevice('auto', this.readNativeAudioDeviceOptions())
    if (explicit === 'auto') return
    try {
      await this.setAudioDevice(explicit)
    } catch (error) {
      console.warn(`绑定 ASIO 输出驱动失败（${reason}）：`, error)
    }
  }

  private async rebindAutoOutputDevice(reason: string): Promise<void> {
    if (this.destroyed || this.device !== 'auto' || !this.native) return

    try {
      const options = this.readNativeAudioDeviceOptions()
      const now = this.scheduler.now()
      this.lastAudioDeviceOptionsCache = {
        selectedDevice: this.device,
        readAt: now,
        options
      }
      this.lastAudioDeviceOptionsSignature = this.createAudioDeviceOptionsSignature(options)

      const defaultId = this.resolvePhysicalDefaultDeviceId(options)
      if (!defaultId) return

      // First observation only latches the current OS default; rebind only when it changes later.
      if (!this.lastFollowedDefaultDeviceId) {
        this.lastFollowedDefaultDeviceId = defaultId
        return
      }
      if (defaultId === this.lastFollowedDefaultDeviceId) return

      const previousFollowed = this.lastFollowedDefaultDeviceId
      this.lastFollowedDefaultDeviceId = defaultId
      try {
        if (this.playbackInfo.state === 'stopped') {
          const deviceSynced = await this.callNativeMaybeAsync(
            '跟随系统默认输出设备',
            'SetOutputDevice',
            'auto'
          )
          if (!deviceSynced) {
            throw nativeAudioError(
              'audio.default_device_rebind_failed',
              'following the system default output device failed',
              this.lastNativeError
            )
          }
          this.refreshOutputInfoFromNative(true)
          return
        }
        await this.runOutputRouteTransaction({
          context: 'audio-device-default-follow',
          nextOutput: this.output,
          nextDevice: 'auto',
          nextExclusiveMode: this.exclusiveMode,
          nextConfig: this.outputConfig,
          errorCode: 'audio.default_device_rebind_failed',
          errorMessage: 'following the system default output device failed',
          cacheReason: 'audio-device-default-follow',
          expectedActualDeviceId: defaultId
        })
      } catch (error) {
        this.lastFollowedDefaultDeviceId = previousFollowed
        console.warn(`跟随系统默认输出设备失败（${reason}）：`, error)
        return
      }
      if (this.playbackInfo.state === 'playing' || this.playbackInfo.state === 'paused') {
        try {
          await this.applyNativeDspGraphOrThrow('系统默认输出设备切换后解析 DSP 场景')
        } catch (error) {
          console.warn(`系统默认输出设备切换后解析 DSP 场景失败（${reason}）：`, error)
        }
      }
    } catch (error) {
      console.warn(`跟随系统默认输出设备失败（${reason}）：`, error)
    }
  }

  private createAudioDeviceOptionsSignature(options: AudioDeviceOption[]): string {
    return options
      .map((device) =>
        [
          device.id,
          device.label,
          device.isDefault ? '1' : '0',
          device.backend || '',
          device.pathKind || '',
          device.capabilityVersion || 0,
          device.dopSupportState || '',
          device.nativeDsdSupportState || '',
          (device.sampleRates || []).join(','),
          (device.bitDepths || []).join(','),
          (device.dopCarrierSampleRates || []).join(','),
          (device.nativeDsdSampleRates || []).join(',')
        ].join(':')
      )
      .join('|')
  }

  private effectiveOutputConfig(config: OutputConfig): OutputConfig {
    return this.directRoutingOverride === null
      ? { ...config }
      : { ...config, routingMode: this.directRoutingOverride }
  }

  createDeviceCapabilityRefreshSignature(info: PlaybackInfo): string {
    const diagnostics = info.outputInfo.diagnostics
    return [
      info.outputInfo.actualBackend,
      info.outputInfo.actualDeviceName,
      info.outputInfo.devicePathKind,
      diagnostics.deviceLostCount,
      diagnostics.driverRestartCount,
      diagnostics.driverXrunCount ?? 0,
      info.outputInfo.deviceRecovered,
      info.outputInfo.recoveryCount
    ].join('|')
  }
}
