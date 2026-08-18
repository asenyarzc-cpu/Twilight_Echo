import { EventEmitter } from 'events'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { fork as forkNodeChildProcess, spawnSync } from 'child_process'
import type {
  AudioDeviceOption,
  AudioEngineQueueItem,
  ConvolverInfo,
  NativeAudioBinding,
  NativeAudioMetadata,
  PlayMode,
  PlaybackInfo,
  VisualizationData,
  VolumeNormalizationMode
} from './audioEngineManager'
import type { BpmAnalysisResult } from './bpm/bpmCache'
import type { DspGraphStatus } from '../shared/dspGraph.ts'
import { getNativeAddonCandidates } from './audio/nativeBinding.ts'
import { tryParseJsonWithNestingLimit } from './security/jsonSafety.ts'
import {
  asUtilityProcessMessageRecord,
  inspectUtilityProcessMessage,
  inspectUtilityProcessPayload,
  isBoundedUtf8String,
  parseUtilityProcessResponse,
  UtilityProcessLogBudget,
  MAX_UTILITY_PROCESS_CONTROL_MESSAGE_BYTES,
  MAX_UTILITY_PROCESS_ERROR_TEXT_BYTES
} from './security/utilityProcessSafety.ts'
import {
  mergeDspStatePayload,
  validateAudioServiceCapabilities,
  type AudioServiceCapabilities,
  type DspStatePayload
} from '../shared/audioServiceContract.ts'

const require = createRequire(import.meta.url)

type UtilityProcessLike = {
  postMessage: (message: AudioServiceRequest) => void
  kill: () => void
  on: (
    event: 'message' | 'exit' | 'error',
    listener:
      | ((message: unknown) => void)
      | ((code: number | null) => void)
      | ((error: unknown, location?: string) => void)
  ) => void
  stdout?: { on: (event: 'data', listener: (chunk: Buffer) => void) => void }
  stderr?: { on: (event: 'data', listener: (chunk: Buffer) => void) => void }
}

type ElectronModule = {
  utilityProcess?: {
    fork: (
      modulePath: string,
      args?: string[],
      options?: { serviceName?: string; stdio?: 'pipe'; env?: NodeJS.ProcessEnv }
    ) => UtilityProcessLike
  }
}

type AudioServiceRequest = {
  kind: 'request'
  requestId: string
  method: keyof NativeAudioBinding
  args: unknown[]
}

const MAX_VISUALIZATION_CACHE_KEYS = 8
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 128
const DEFAULT_TOPOLOGY_REQUEST_TIMEOUT_MS = 20_000
const AUDIO_SERVICE_BUSY_CODE = 'ERR_AUDIO_SERVICE_BUSY'
const AUDIO_SERVICE_TIMEOUT_CODE = 'ERR_AUDIO_SERVICE_TIMEOUT'
const MAX_AUDIO_SERVICE_DEFAULT_RESPONSE_BYTES = 1024 * 1024
const MAX_AUDIO_SERVICE_VISUALIZATION_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_AUDIO_SERVICE_MESSAGE_BYTES =
  MAX_AUDIO_SERVICE_VISUALIZATION_RESPONSE_BYTES + MAX_UTILITY_PROCESS_CONTROL_MESSAGE_BYTES
const AUDIO_SERVICE_INVALID_MESSAGE = 'audio service returned an invalid or oversized message'

// Native calls that may legally block the audio service's single JS thread far
// beyond the control deadline: FFmpeg open/probe on slow disks or network
// sources, device stop/close joins and exclusive reopens, DSP graph
// compilation (convolver IRs), ASIO driver enumeration, and the VST3 scanner
// (which carries its own 8s native budget). Timing out here only fails the
// individual request — the native side is internally bounded, so killing the
// service mid-flight is the watchdog misfire that turns any legitimate slow
// operation into a crash/restart loop.
const SLOW_NATIVE_METHODS = new Set<string>([
  'Play',
  'Stop',
  'Next',
  'Previous',
  'Seek',
  'SetOutputDevice',
  'SetOutputBackend',
  'SetOutputConfig',
  'LoadQueue',
  'AddToQueue',
  'RemoveFromQueue',
  'SetDspConfig',
  'SetDspGraph',
  'ApplyDspState',
  'SetDspPluginChain',
  'LoadImpulseResponse',
  'UnloadImpulseResponse',
  'SetEqBands',
  'SetEqPreset',
  'SetCrossfeedStrength',
  'SetReplayGainMode',
  'GetMetadata',
  'EnumerateDevices',
  'EnumerateBackends',
  'GetEngineCapabilities',
  'ScanVst3Module'
])

// A child that survives this long is considered stable: the exponential
// restart backoff resets after it.
const AUDIO_SERVICE_STABLE_CHILD_MS = 60_000
const MAX_AUDIO_SERVICE_RESTART_BACKOFF_MS = 30_000

function isSlowNativeMethod(method: keyof NativeAudioBinding): boolean {
  return SLOW_NATIVE_METHODS.has(String(method))
}

type PendingRequest = {
  method: keyof NativeAudioBinding
  slow: boolean
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type AudioServiceError = Error & {
  code?: string
}

type CoalescedControlRequest = {
  args: unknown[]
  inFlight: boolean
  scheduled: boolean
}

type DspStateWaiter = {
  revision: number
  resolve: (status: DspGraphStatus) => void
  reject: (error: Error) => void
}

type QueuedDspState = {
  revision: number
  payload: DspStatePayload
  waiters: DspStateWaiter[]
}

export interface AudioEngineServiceBindingOptions {
  serviceEntry: string
  requestTimeoutMs?: number
  topologyRequestTimeoutMs?: number
  restartDelayMs?: number
  maxInFlightRequests?: number
  electron?: ElectronModule
}

export class AudioEngineServiceBinding extends EventEmitter implements NativeAudioBinding {
  private readonly options: AudioEngineServiceBindingOptions
  private child: UtilityProcessLike | null = null
  private pending = new Map<string, PendingRequest>()
  private requestTimeoutMs: number
  private topologyRequestTimeoutMs: number
  private restartDelayMs: number
  private maxInFlightRequests: number
  private stopped = false
  private restarting = false
  private generation = 0
  private slowPendingCount = 0
  private restartAttempts = 0
  private lastChildSpawnedAt = 0
  private cacheRequestSerial = new Map<string, number>()
  private cacheRequestsInFlight = new Set<string>()
  private lastPlaybackInfo: string | PlaybackInfo | null = null
  private lastDspStatus: string | { plugins: unknown[] } = { plugins: [] }
  private lastDspGraphStatus: DspGraphStatus = createEmptyDspGraphStatus()
  private serviceCapabilities: AudioServiceCapabilities | null = null
  private lastConvolverInfo: string | ConvolverInfo | null = null
  private lastVisualizationDataByKey = new Map<string, string | VisualizationData>()
  private visualizationCacheKeys = new Set<string>()
  private visualizationRequestKeyByCacheKey = new Map<string, string>()
  private lastDevices: string | AudioDeviceOption[] | null = null
  private lastUpcomingTrack: string | AudioEngineQueueItem | null = null
  private lastErrorJson = '{"message":""}'
  private coalescedControls = new Map<keyof NativeAudioBinding, CoalescedControlRequest>()
  private desiredDspState: DspStatePayload | null = null
  private queuedDspState: QueuedDspState | null = null
  private dspStateInFlight = false
  private dspStateFlushScheduled = false
  private readonly processLogBudget = new UtilityProcessLogBudget()

  constructor(options: AudioEngineServiceBindingOptions) {
    super()
    this.options = options
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1500
    this.topologyRequestTimeoutMs = Math.max(
      this.requestTimeoutMs,
      options.topologyRequestTimeoutMs ?? DEFAULT_TOPOLOGY_REQUEST_TIMEOUT_MS
    )
    this.restartDelayMs = options.restartDelayMs ?? 500
    this.maxInFlightRequests = Math.max(
      1,
      Math.floor(options.maxInFlightRequests ?? DEFAULT_MAX_IN_FLIGHT_REQUESTS)
    )
  }

  /**
   * 异步调用原生方法并等待 utility 进程返回结果。
   * 用于 play/pause 等需要确认真实状态的控制命令。
   */
  callAsync(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'AnalyzeBpm' || method === 'AnalyzeLoudness') {
      return Promise.reject(new Error(`${method} must use the isolated audio analysis service`))
    }
    return this.call(method as keyof NativeAudioBinding, args)
  }

  Play(source: string, startTime?: number): void {
    this.fireAndForget('Play', [source, startTime])
  }

  Pause(): void {
    this.fireAndForget('Pause', [])
  }

  Stop(): void {
    this.fireAndForget('Stop', [])
  }

  Seek(time: number): void {
    this.coalescedFireAndForget('Seek', [time])
  }

  SetVolume(volume: number): void {
    this.coalescedFireAndForget('SetVolume', [volume])
  }

  SetPlaybackRate(rate: number): void {
    this.coalescedFireAndForget('SetPlaybackRate', [rate])
  }

  SetLoopRange(startSeconds: number, endSeconds: number): void {
    this.coalescedFireAndForget('SetLoopRange', [startSeconds, endSeconds])
  }

  SetOutputDevice(device: string): void {
    this.fireAndForget('SetOutputDevice', [device])
  }

  SetOutputBackend(backend: string): void {
    this.fireAndForget('SetOutputBackend', [backend])
  }

  SetOutputConfig(json: string): void {
    this.fireAndForget('SetOutputConfig', [json])
  }

  LoadQueue(queueJson: string, startIndex: number): void {
    this.fireAndForget('LoadQueue', [queueJson, startIndex])
  }

  Next(): void {
    this.fireAndForget('Next', [])
  }

  Previous(): void {
    this.fireAndForget('Previous', [])
  }

  SetPlayMode(mode: PlayMode): void {
    this.fireAndForget('SetPlayMode', [mode])
  }

  SetDspConfig(json: string): void {
    this.fireAndForget('SetDspConfig', [json])
  }

  ApplyDspState(revision: number, json: string): void {
    let payload: DspStatePayload
    try {
      payload = parseDspStatePayload(json, revision)
    } catch (error) {
      this.recordTransientFailure(error instanceof Error ? error.message : String(error))
      return
    }
    // NativeAudioBinding's fire-and-forget entry point receives complete
    // graph snapshots. Preserve its historical replacement semantics; callers
    // using the queued async API can intentionally submit field-level patches.
    payload = { ...payload, graphUpdateMode: 'replace' }
    void this.applyDspState(revision, payload).catch((error) => {
      this.recordTransientFailure(error instanceof Error ? error.message : String(error))
    })
  }

  SetDspGraph(json: string): void {
    void this.applyDspGraph(json).catch((error) => {
      this.recordTransientFailure(error instanceof Error ? error.message : String(error))
    })
  }

  GetDspGraphStatus(): string | DspGraphStatus {
    this.refreshCache('GetDspGraphStatus', [], (value) => {
      this.cacheDspGraphStatus(value)
    })
    return this.lastDspGraphStatus
  }

  async applyDspGraph(json: string): Promise<DspGraphStatus> {
    const requestedRevision = parseRequestedDspGraphRevision(json)
    const parsed = parseJsonObject(json, 'DSP graph payload')
    const payload = parseDspStatePayload(
      JSON.stringify({
        ...parsed,
        graphUpdateMode: 'replace',
        processing: this.desiredDspState?.processing ?? {}
      }),
      requestedRevision
    )
    return this.applyDspState(requestedRevision, payload)
  }

  applyDspState(revision: number, payload: DspStatePayload): Promise<DspGraphStatus> {
    assertPositiveDspRevision(revision)
    const normalized = normalizeDspStatePayload(payload, revision)
    this.desiredDspState = mergeDspStatePayload(this.desiredDspState, normalized)
    this.lastDspGraphStatus = {
      ...this.lastDspGraphStatus,
      requestedRevision: revision,
      applyState: 'pending',
      applyError: ''
    }
    return new Promise<DspGraphStatus>((resolve, reject) => {
      const waiter: DspStateWaiter = { revision, resolve, reject }
      if (this.queuedDspState) {
        this.queuedDspState.revision = revision
        this.queuedDspState.payload = { ...this.desiredDspState! }
        this.queuedDspState.waiters.push(waiter)
      } else {
        this.queuedDspState = {
          revision,
          payload: { ...this.desiredDspState! },
          waiters: [waiter]
        }
      }
      this.scheduleDspStateFlush()
    })
  }

  async getDspGraphStatusAsync(): Promise<DspGraphStatus> {
    const status = parseDspGraphStatus(await this.call('GetDspGraphStatus', []))
    this.cacheDspGraphStatus(status)
    return this.lastDspGraphStatus
  }

  LoadImpulseResponse(path: string): void {
    this.fireAndForget('LoadImpulseResponse', [path])
  }

  UnloadImpulseResponse(): void {
    this.fireAndForget('UnloadImpulseResponse', [])
  }

  GetConvolverInfo(): string | ConvolverInfo {
    this.refreshCache('GetConvolverInfo', [], (value) => {
      this.lastConvolverInfo = value as string | ConvolverInfo
    })
    return this.lastConvolverInfo ?? '{"loaded":false,"active":false}'
  }

  SetEqBands(json: string): void {
    this.fireAndForget('SetEqBands', [json])
  }

  SetEqPreset(json: string): void {
    this.fireAndForget('SetEqPreset', [json])
  }

  SetCrossfeedStrength(strength: number): void {
    this.fireAndForget('SetCrossfeedStrength', [strength])
  }

  SetReplayGainMode(
    mode: VolumeNormalizationMode,
    preamp: number,
    fallback: number,
    clip: boolean
  ): void {
    this.fireAndForget('SetReplayGainMode', [mode, preamp, fallback, clip])
  }

  SetDspPluginChain(json: string): void {
    this.fireAndForget('SetDspPluginChain', [json])
  }

  GetDspPluginStatus(): string | { plugins: unknown[] } {
    this.refreshCache('GetDspPluginStatus', [], (value) => {
      this.lastDspStatus = value as string | { plugins: unknown[] }
    })
    return this.lastDspStatus
  }

  GetMetadata(source: string): string | NativeAudioMetadata {
    void source
    return '{"error":"metadata requires async audio service RPC"}'
  }

  GetPlaybackInfo(): string | PlaybackInfo {
    this.refreshCache('GetPlaybackInfo', [], (value) => {
      this.lastPlaybackInfo = value as string | PlaybackInfo
    })
    return this.lastPlaybackInfo ?? '{"state":"stopped"}'
  }

  GetUpcomingTrack(): string | AudioEngineQueueItem | null {
    this.refreshCache('GetUpcomingTrack', [], (value) => {
      this.lastUpcomingTrack = value as string | AudioEngineQueueItem | null
    })
    return this.lastUpcomingTrack
  }

  GetSpectrumData(points?: number): number[] {
    void points
    return []
  }

  GetVisualizationData(optionsJson: string): string | VisualizationData {
    const cacheKey = optionsJson || '{}'
    this.touchVisualizationCacheKey(cacheKey, optionsJson)
    this.refreshCache('GetVisualizationData', [optionsJson], (value) => {
      this.touchVisualizationCacheKey(cacheKey, optionsJson)
      this.lastVisualizationDataByKey.set(cacheKey, value as string | VisualizationData)
    })
    return (
      this.lastVisualizationDataByKey.get(cacheKey) ??
      '{"spectrum":[],"waveform":[],"peakDb":-120,"rmsDb":-120,"lufsMomentary":null,"spectrogram":[],"sampleRate":0,"active":false}'
    )
  }

  AnalyzeBpm(source: string, optionsJson?: string): string | BpmAnalysisResult {
    void source
    void optionsJson
    return '{"error":"BPM analysis requires the isolated audio analysis service"}'
  }

  AnalyzeLoudness(source: string, optionsJson?: string): string {
    void source
    void optionsJson
    return '{"error":"loudness analysis requires the isolated audio analysis service"}'
  }

  EnumerateDevices(): string | AudioDeviceOption[] {
    this.refreshCache('EnumerateDevices', [], (value) => {
      this.lastDevices = value as string | AudioDeviceOption[]
    })
    return this.lastDevices ?? '[]'
  }

  EnumerateBackends(): string {
    return '[]'
  }

  GetEngineCapabilities(): string {
    return JSON.stringify({
      audioPluginSystem: true,
      nativeDsp: true,
      audioService: true,
      audioServiceProtocolVersion: this.serviceCapabilities?.protocolVersion ?? null,
      dspGraphRevisionAck: this.serviceCapabilities?.dspGraphRevisionAck === true
    })
  }

  GetLastError(): string {
    return this.lastErrorJson
  }

  async getMetadataAsync(source: string): Promise<string | NativeAudioMetadata> {
    return (await this.call('GetMetadata', [source])) as string | NativeAudioMetadata
  }

  destroy(): void {
    this.stopped = true
    this.rejectQueuedDspState(new Error('音频服务已停止'))
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('音频服务已停止'))
    }
    this.pending.clear()
    this.slowPendingCount = 0
    this.coalescedControls.clear()
    this.child?.kill()
    this.child = null
  }

  private start(): void {
    if (this.stopped || this.child || this.restarting) return
    if (shouldUseNodeAudioService()) {
      this.startNodeChildProcess()
      return
    }
    const electron = this.options.electron ?? resolveElectron()
    if (!electron?.utilityProcess) {
      this.recordFailure('当前运行时不支持 Electron utilityProcess')
      return
    }
    try {
      const child = electron.utilityProcess.fork(this.options.serviceEntry, [], {
        serviceName: 'twilight-audio-engine',
        stdio: 'pipe',
        env: audioServiceEnv()
      })
      this.child = child
      this.lastChildSpawnedAt = Date.now()
      this.processLogBudget.reset()
      child.on('message', (message) => {
        if (this.child !== child) return
        this.handleMessage(message)
      })
      child.on('exit', (code) => {
        if (this.child !== child) return
        this.handleExit(`音频服务进程退出：${code ?? 'unknown'}`)
      })
      child.on('error', (error, location) => {
        if (this.child !== child) return
        this.handleExit(
          `音频服务进程错误：${location ?? ''} ${error instanceof Error ? error.message : String(error)}`
        )
      })
      child.stdout?.on('data', (chunk) => {
        if (this.child !== child) return
        this.emitProcessLog('log', chunk)
      })
      child.stderr?.on('data', (chunk) => {
        if (this.child !== child) return
        this.emitProcessLog('error-log', chunk)
      })
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : String(error))
    }
  }

  private startNodeChildProcess(): void {
    try {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const child = forkNodeChildProcess(this.options.serviceEntry, [], {
        execPath: resolveNodeAudioServiceExecutable(),
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
      const wrappedChild: UtilityProcessLike = {
        postMessage: (message) => {
          if (!child.send(message)) throw new Error('音频服务 IPC 发送失败')
        },
        kill: () => {
          child.kill()
        },
        on: (event, listener) => {
          if (event === 'message') {
            child.on('message', listener as (message: unknown) => void)
          } else if (event === 'exit') {
            child.on('exit', listener as (code: number | null) => void)
          } else {
            child.on('error', listener as (error: unknown) => void)
          }
        },
        stdout: child.stdout ?? undefined,
        stderr: child.stderr ?? undefined
      }
      this.child = wrappedChild
      this.lastChildSpawnedAt = Date.now()
      this.processLogBudget.reset()
      wrappedChild.on('message', (message) => {
        if (this.child !== wrappedChild) return
        this.handleMessage(message)
      })
      wrappedChild.on('exit', (code) => {
        if (this.child !== wrappedChild) return
        this.handleExit(`音频服务进程退出：${code ?? 'unknown'}`)
      })
      wrappedChild.on('error', (error) => {
        if (this.child !== wrappedChild) return
        this.handleExit(
          `音频服务进程错误：${error instanceof Error ? error.message : String(error)}`
        )
      })
      wrappedChild.stdout?.on('data', (chunk) => {
        if (this.child !== wrappedChild) return
        this.emitProcessLog('log', chunk)
      })
      wrappedChild.stderr?.on('data', (chunk) => {
        if (this.child !== wrappedChild) return
        this.emitProcessLog('error-log', chunk)
      })
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : String(error))
    }
  }

  private emitProcessLog(event: 'log' | 'error-log', chunk: Buffer): void {
    const capture = this.processLogBudget.capture(chunk)
    if (capture.text) this.emit(event, capture.text)
    if (capture.notice) this.emit(event, capture.notice)
  }

  private handleMessage(message: unknown): void {
    const record = asUtilityProcessMessageRecord(message)
    if (!record) {
      this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
      return
    }

    let kind: unknown
    try {
      kind = record.kind
    } catch {
      this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
      return
    }

    if (kind === 'ready') {
      if (!inspectUtilityProcessMessage(record, MAX_UTILITY_PROCESS_CONTROL_MESSAGE_BYTES).ok) {
        this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
        return
      }
      try {
        const capabilityError = validateAudioServiceCapabilities(record.capabilities)
        if (capabilityError) {
          this.handleFatal(capabilityError)
          return
        }
        this.serviceCapabilities =
          (record.capabilities as AudioServiceCapabilities | undefined) ?? null
        this.emit('ready', this.serviceCapabilities)
      } catch {
        this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
      }
      return
    }

    if (kind === 'fatal') {
      if (!inspectUtilityProcessMessage(record, MAX_UTILITY_PROCESS_CONTROL_MESSAGE_BYTES).ok) {
        this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
        return
      }
      try {
        if (
          record.error !== undefined &&
          !isBoundedUtf8String(record.error, MAX_UTILITY_PROCESS_ERROR_TEXT_BYTES)
        ) {
          this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
          return
        }
        this.handleFatal(
          typeof record.error === 'string' && record.error.trim()
            ? record.error
            : '音频服务启动失败'
        )
      } catch {
        this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
      }
      return
    }

    if (kind !== 'response') {
      this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
      return
    }
    if (!inspectUtilityProcessMessage(record, MAX_AUDIO_SERVICE_MESSAGE_BYTES).ok) {
      this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
      return
    }

    const parsed = parseUtilityProcessResponse(record)
    if (!parsed.ok) {
      this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
      return
    }

    const { response } = parsed
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    if (
      !inspectUtilityProcessPayload(response.value, this.responseByteLimitForMethod(pending.method))
        .ok
    ) {
      this.handleProtocolViolation(AUDIO_SERVICE_INVALID_MESSAGE)
      return
    }

    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    if (pending.slow) this.slowPendingCount -= 1
    if (response.ok) pending.resolve(response.value)
    else pending.reject(new Error(response.error ?? '音频服务调用失败'))
  }

  private handleProtocolViolation(reason: string): void {
    const child = this.child
    if (!child || this.stopped) return
    this.child = null
    try {
      child.kill()
    } catch {
      // The child was detached before termination, so a late exit cannot race recovery.
    }
    this.handleExit(reason)
  }

  private handleFatal(reason: string): void {
    const child = this.child
    this.child = null
    try {
      child?.kill()
    } catch {
      // The service already reported fatal startup failure; keep the original reason.
    }
    this.handleExit(reason, { restart: false })
  }

  private handleExit(reason: string, options: { restart?: boolean } = {}): void {
    if (this.stopped) return
    this.recordFailure(reason)
    this.child = null
    this.generation += 1
    this.clearServiceDerivedCaches()
    this.emit('crash', reason)
    if (options.restart === false) return
    if (this.restarting) return
    this.restarting = true
    // Exponential backoff over consecutive short-lived children so a
    // deterministic failure source (bad driver, hostile source) cannot run a
    // ~2s crash/restart storm. A child that survived a full stability window
    // resets the ladder.
    const livedMs = Date.now() - this.lastChildSpawnedAt
    this.restartAttempts = livedMs < AUDIO_SERVICE_STABLE_CHILD_MS ? this.restartAttempts + 1 : 1
    const backoffMs = Math.min(
      this.restartDelayMs * 2 ** (this.restartAttempts - 1),
      MAX_AUDIO_SERVICE_RESTART_BACKOFF_MS
    )
    setTimeout(() => {
      this.restarting = false
      this.start()
    }, backoffMs)
  }

  private fireAndForget(method: keyof NativeAudioBinding, args: unknown[]): void {
    void this.call(method, args).catch((error) => {
      if (isAudioServiceBusyError(error)) {
        this.recordTransientFailure(error.message)
        return
      }
      this.recordFailure(error instanceof Error ? error.message : String(error))
    })
  }

  private coalescedFireAndForget(method: keyof NativeAudioBinding, args: unknown[]): void {
    let request = this.coalescedControls.get(method)
    if (!request) {
      request = { args, inFlight: false, scheduled: false }
      this.coalescedControls.set(method, request)
    } else {
      request.args = args
    }

    if (request.inFlight || request.scheduled) return
    request.scheduled = true
    queueMicrotask(() => this.flushCoalescedControl(method))
  }

  private flushCoalescedControl(method: keyof NativeAudioBinding): void {
    const request = this.coalescedControls.get(method)
    if (!request || request.inFlight || this.stopped) return

    request.scheduled = false
    request.inFlight = true
    const args = request.args
    void this.call(method, args)
      .catch((error) => {
        if (isAudioServiceBusyError(error)) {
          this.recordTransientFailure(error.message)
          return
        }
        this.recordFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        const latest = this.coalescedControls.get(method)
        if (!latest) return
        latest.inFlight = false
        if (latest.args === args || this.stopped) {
          this.coalescedControls.delete(method)
          return
        }
        latest.scheduled = true
        queueMicrotask(() => this.flushCoalescedControl(method))
      })
  }

  private scheduleDspStateFlush(): void {
    if (this.dspStateInFlight || this.dspStateFlushScheduled || this.stopped) return
    this.dspStateFlushScheduled = true
    queueMicrotask(() => {
      this.dspStateFlushScheduled = false
      void this.flushDspState()
    })
  }

  private async flushDspState(): Promise<void> {
    if (this.dspStateInFlight || this.stopped) return
    const batch = this.queuedDspState
    if (!batch) return
    this.queuedDspState = null
    this.dspStateInFlight = true
    try {
      await this.call('ApplyDspState', [batch.revision, JSON.stringify(batch.payload)])
      const status = await this.waitForDspStateRevision(batch.revision)
      const latestRequested = this.lastDspGraphStatus.requestedRevision ?? batch.revision
      if (status.revision >= latestRequested) {
        this.lastDspGraphStatus = {
          ...status,
          requestedRevision: latestRequested,
          appliedRevision: status.revision,
          applyState: 'applied',
          applyError: ''
        }
      }
      for (const waiter of batch.waiters) {
        waiter.resolve({
          ...status,
          requestedRevision: waiter.revision,
          appliedRevision: status.revision,
          applyState: 'applied',
          applyError: ''
        })
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (batch.revision >= (this.lastDspGraphStatus.requestedRevision ?? 0)) {
        this.lastDspGraphStatus = {
          ...this.lastDspGraphStatus,
          requestedRevision: batch.revision,
          applyState: 'failed',
          applyError: failure.message
        }
      }
      this.recordTransientFailure(failure.message)
      for (const waiter of batch.waiters) waiter.reject(failure)
    } finally {
      this.dspStateInFlight = false
      this.scheduleDspStateFlush()
    }
  }

  private async waitForDspStateRevision(revision: number): Promise<DspGraphStatus> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = parseDspGraphStatus(await this.call('GetDspGraphStatus', []))
      this.cacheDspGraphStatus(status)
      if (status.revision >= revision) return status
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`DSP graph ACK revision mismatch: requested ${revision}`)
  }

  private rejectQueuedDspState(error: Error): void {
    const queued = this.queuedDspState
    this.queuedDspState = null
    this.dspStateFlushScheduled = false
    if (!queued) return
    for (const waiter of queued.waiters) waiter.reject(error)
  }

  private refreshCache(
    method: keyof NativeAudioBinding,
    args: unknown[],
    apply: (value: unknown) => void
  ): void {
    const cacheKey = `${String(method)}:${JSON.stringify(args)}`
    if (this.cacheRequestsInFlight.has(cacheKey)) return
    this.cacheRequestsInFlight.add(cacheKey)
    const serial = (this.cacheRequestSerial.get(cacheKey) ?? 0) + 1
    this.cacheRequestSerial.set(cacheKey, serial)
    void this.call(method, args)
      .then((value) => {
        if (this.cacheRequestSerial.get(cacheKey) !== serial) return
        apply(value)
      })
      .catch((error) => {
        if (this.cacheRequestSerial.get(cacheKey) !== serial) return
        this.lastErrorJson = JSON.stringify({
          message: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        this.cacheRequestsInFlight.delete(cacheKey)
      })
  }

  private touchVisualizationCacheKey(cacheKey: string, optionsJson: string): void {
    const requestCacheKey = this.visualizationRequestCacheKey(optionsJson)
    this.visualizationRequestKeyByCacheKey.set(cacheKey, requestCacheKey)
    this.visualizationCacheKeys.delete(cacheKey)
    this.visualizationCacheKeys.add(cacheKey)
    while (this.visualizationCacheKeys.size > MAX_VISUALIZATION_CACHE_KEYS) {
      const oldest = this.visualizationCacheKeys.values().next().value as string | undefined
      if (!oldest) return
      this.visualizationCacheKeys.delete(oldest)
      this.lastVisualizationDataByKey.delete(oldest)
      const oldestRequestCacheKey = this.visualizationRequestKeyByCacheKey.get(oldest)
      this.visualizationRequestKeyByCacheKey.delete(oldest)
      if (oldestRequestCacheKey) {
        this.cacheRequestSerial.delete(oldestRequestCacheKey)
        this.cacheRequestsInFlight.delete(oldestRequestCacheKey)
      }
    }
  }

  private visualizationRequestCacheKey(optionsJson: string): string {
    return `GetVisualizationData:${JSON.stringify([optionsJson])}`
  }

  private clearServiceDerivedCaches(): void {
    this.lastDspStatus = { plugins: [] }
    this.lastDspGraphStatus = createEmptyDspGraphStatus()
    this.serviceCapabilities = null
    this.lastPlaybackInfo = '{"state":"stopped"}'
    this.lastConvolverInfo = null
    this.lastVisualizationDataByKey.clear()
    this.visualizationCacheKeys.clear()
    this.visualizationRequestKeyByCacheKey.clear()
    this.lastDevices = null
    this.lastUpcomingTrack = null
    this.cacheRequestSerial.clear()
    this.cacheRequestsInFlight.clear()
    this.desiredDspState = null
  }

  private cacheDspGraphStatus(value: unknown): void {
    const status = parseDspGraphStatus(value)
    if (status.revision < this.lastDspGraphStatus.revision) return
    const requestedRevision = this.lastDspGraphStatus.requestedRevision ?? status.revision
    const applied = status.revision >= requestedRevision
    const applyState =
      requestedRevision === 0 ? 'idle' : applied ? 'applied' : this.lastDspGraphStatus.applyState
    this.lastDspGraphStatus = {
      ...status,
      requestedRevision,
      appliedRevision: status.revision,
      applyState,
      applyError: applied ? '' : this.lastDspGraphStatus.applyError
    }
  }

  private call(method: keyof NativeAudioBinding, args: unknown[]): Promise<unknown> {
    if (!this.child && !this.restarting) this.start()
    const child = this.child
    if (!child) return Promise.reject(new Error('音频服务不可用'))
    if (this.pending.size >= this.maxInFlightRequests) {
      return Promise.reject(createAudioServiceBusyError(method))
    }
    const requestId = randomUUID()
    const generation = this.generation
    const slow = isSlowNativeMethod(method)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (!pending || generation !== this.generation || this.child !== child) return
        const error = createAudioServiceTimeoutError(method)
        clearTimeout(pending.timer)
        this.pending.delete(requestId)
        if (pending.slow) this.slowPendingCount -= 1
        pending.reject(error)
        // Never kill on a slow-tier timeout: the native side is internally
        // bounded. And while any slow-tier request is still in flight, the
        // service's single JS thread may be legitimately busy — a fast-tier
        // timeout here is collateral, not evidence of a wedged child.
        if (pending.slow || this.slowPendingCount > 0) return
        this.restartUnresponsiveService(child, generation, error.message)
      }, this.requestTimeoutForMethod(method))
      this.pending.set(requestId, {
        method,
        slow,
        resolve: (value) => {
          if (generation !== this.generation) return
          resolve(value)
        },
        reject,
        timer
      })
      if (slow) this.slowPendingCount += 1
      try {
        child.postMessage({ kind: 'request', requestId, method, args })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        if (slow) this.slowPendingCount -= 1
        const message = err instanceof Error ? err.message : String(err)
        this.recordTransientFailure(message)
        reject(err)
      }
    })
  }

  private restartUnresponsiveService(
    child: UtilityProcessLike,
    generation: number,
    reason: string
  ): void {
    if (this.stopped || generation !== this.generation || this.child !== child) return
    this.child = null
    try {
      child.kill()
    } catch {
      // The timeout recovery path still advances the generation and schedules a replacement.
    }
    this.handleExit(reason)
  }

  private recordFailure(message: string): void {
    this.lastErrorJson = JSON.stringify({ message })
    this.coalescedControls.clear()
    this.slowPendingCount = 0
    this.rejectQueuedDspState(new Error(message))
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
      this.pending.delete(requestId)
    }
  }

  private responseByteLimitForMethod(method: keyof NativeAudioBinding): number {
    return method === 'GetVisualizationData'
      ? MAX_AUDIO_SERVICE_VISUALIZATION_RESPONSE_BYTES
      : MAX_AUDIO_SERVICE_DEFAULT_RESPONSE_BYTES
  }

  private requestTimeoutForMethod(method: keyof NativeAudioBinding): number {
    // Slow-tier methods (device reopen, FFmpeg probe, DSP graph compile, the
    // 8s-budget VST3 scanner) legally block the service's single JS thread far
    // beyond the control deadline. They are still generation-fenced by call(),
    // but must neither fail fast nor trigger the unresponsive-service kill
    // while a driver negotiates the new stream.
    return isSlowNativeMethod(method) ? this.topologyRequestTimeoutMs : this.requestTimeoutMs
  }

  private recordTransientFailure(message: string): void {
    this.lastErrorJson = JSON.stringify({ message })
  }
}

export function canUseAudioEngineService(): boolean {
  if (process.env.TWILIGHT_AUDIO_SERVICE === '0') return false
  if (shouldUseNodeAudioService()) return true
  return Boolean(resolveElectron()?.utilityProcess)
}

function shouldUseNodeAudioService(): boolean {
  return process.env.TWILIGHT_AUDIO_SERVICE_NODE === '1'
}

function resolveNodeAudioServiceExecutable(): string {
  return process.env.TWILIGHT_AUDIO_NODE_EXECUTABLE || process.env.NODE || 'node'
}

function resolveElectron(): ElectronModule | null {
  try {
    const electron = require('electron') as ElectronModule | string
    return typeof electron === 'object' && electron ? electron : null
  } catch {
    return null
  }
}

function createAudioServiceBusyError(method: keyof NativeAudioBinding): AudioServiceError {
  const error = new Error(`音频服务请求过多：${String(method)}`) as AudioServiceError
  error.code = AUDIO_SERVICE_BUSY_CODE
  return error
}

function createAudioServiceTimeoutError(method: keyof NativeAudioBinding): AudioServiceError {
  const error = new Error(`音频服务调用超时：${String(method)}`) as AudioServiceError
  error.code = AUDIO_SERVICE_TIMEOUT_CODE
  return error
}

function isAudioServiceBusyError(error: unknown): error is AudioServiceError {
  return error instanceof Error && (error as AudioServiceError).code === AUDIO_SERVICE_BUSY_CODE
}

function createEmptyDspGraphStatus(): DspGraphStatus {
  return {
    revision: 0,
    requestedRevision: 0,
    appliedRevision: 0,
    applyState: 'idle',
    applyError: '',
    activeSceneId: null,
    totalLatencyFrames: 0,
    totalTailFrames: 0,
    nodes: []
  }
}

function parseRequestedDspGraphRevision(json: string): number {
  const value = parseJsonObject(json, 'DSP graph payload')
  const revision = (value as { revision?: unknown }).revision
  if (!Number.isSafeInteger(revision) || (revision as number) <= 0) {
    throw new Error('DSP graph payload requires a positive integer revision')
  }
  return revision as number
}

function parseJsonObject(json: string, label: string): Record<string, unknown> {
  const parsed = tryParseJsonWithNestingLimit(json)
  if (!parsed.ok) throw new Error(`${label} must be valid JSON`)
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new Error(`${label} must be an object`)
  }
  return parsed.value as Record<string, unknown>
}

function assertPositiveDspRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error('DSP state requires a positive integer revision')
  }
}

function parseDspStatePayload(json: string, revision: number): DspStatePayload {
  return normalizeDspStatePayload(
    parseJsonObject(json, 'DSP state payload') as unknown as DspStatePayload,
    revision
  )
}

function normalizeDspStatePayload(payload: DspStatePayload, revision: number): DspStatePayload {
  assertPositiveDspRevision(revision)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('DSP state payload must be an object')
  }
  const processing = payload.processing
  const graph = payload.graph
  if (!processing || typeof processing !== 'object' || Array.isArray(processing)) {
    throw new Error('DSP state payload requires a processing object')
  }
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new Error('DSP state payload requires a graph object')
  }
  if (payload.graphUpdateMode !== undefined && payload.graphUpdateMode !== 'replace') {
    throw new Error('DSP graph update mode must be replace when specified')
  }
  return {
    ...payload,
    revision,
    processing: { ...processing },
    graph: { ...graph }
  }
}

function parseDspGraphStatus(value: unknown): DspGraphStatus {
  let parsed = value
  if (typeof parsed === 'string') {
    const parsedJson = tryParseJsonWithNestingLimit(parsed)
    if (!parsedJson.ok) {
      throw new Error('audio service returned invalid DSP graph status JSON')
    }
    parsed = parsedJson.value
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('audio service returned an invalid DSP graph status')
  }
  const status = parsed as Partial<DspGraphStatus>
  if (!Number.isSafeInteger(status.revision) || (status.revision as number) < 0) {
    throw new Error('audio service returned an invalid DSP graph revision')
  }
  if (!Array.isArray(status.nodes)) {
    throw new Error('audio service returned DSP graph status without nodes')
  }
  return status as DspGraphStatus
}

/**
 * Electron 自带 Chromium 的 libffmpeg.so，与引擎链接的系统 libav* 同名符号
 * 抢占全局符号表，导致音频服务（utility 进程）里 FFmpeg 协议注册表损坏
 * —— avformat_open_input 对本地文件/HTTP 一律报 “Protocol not found”
 * （-1330794744 / AVERROR_PROTOCOL_NOT_FOUND）。
 * 在 fork 前用 LD_PRELOAD 预载系统 libav*，保证引擎的 FFmpeg 符号解析一致。
 * 仅 Linux + 动态链接系统 FFmpeg 时生效；静态链接构建下 ldd 无 libav* 输出，自动跳过。
 */
function systemFfmpegPreloadPaths(): string[] {
  if (process.platform !== 'linux') return []
  try {
    const addon = getNativeAddonCandidates().find((candidate) => existsSync(candidate))
    if (!addon) return []
    const result = spawnSync('ldd', [addon], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout) return []
    const wanted = new Set(['libavformat', 'libavcodec', 'libavutil', 'libswresample'])
    const paths: string[] = []
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\S+\.so[^\s]*)\s*=>\s*(\/\S+)/.exec(line)
      if (!match) continue
      const base = match[1].split('.')[0]
      if (wanted.has(base) && !paths.includes(match[2])) paths.push(match[2])
    }
    return paths
  } catch {
    return []
  }
}

function audioServiceEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (process.platform === 'linux') {
    const preload = systemFfmpegPreloadPaths()
    if (preload.length > 0) {
      const existing =
        typeof env.LD_PRELOAD === 'string' && env.LD_PRELOAD ? env.LD_PRELOAD + ':' : ''
      env.LD_PRELOAD = existing + preload.join(':')
    }
  }
  return env
}
