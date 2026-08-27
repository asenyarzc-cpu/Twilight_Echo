import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  loadJsonFileWithBackup,
  writeJsonFileAtomic,
  type JsonFileOptions
} from '../persistence/jsonFile.ts'
import {
  TELEMETRY_SCHEMA_VERSION,
  isTelemetryEvent,
  isTelemetryId,
  type TelemetryBatchRequest,
  type TelemetryEvent
} from '../../shared/telemetry.ts'

export interface TelemetryPlaybackSnapshot {
  state: 'stopped' | 'playing' | 'paused'
}

export interface TelemetryClientOptions {
  endpointUrl: string
  stateDir: string
  appVersion: string
  platform: string
  arch: string
  fetchImpl?: typeof fetch
  now?: () => number
  randomId?: () => string
  flushIntervalMs?: number
  checkpointIntervalMs?: number
  maxQueuedEvents?: number
  requestTimeoutMs?: number
}

const DEFAULT_FLUSH_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_MAX_QUEUED_EVENTS = 120
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// Wall-clock guard: a session segment longer than this is treated as a clock
// anomaly (sleep/hibernate/skew) instead of real listening time.
const MAX_SEGMENT_SECONDS = 8 * 3600

const INSTALL_ID_FILE_OPTIONS: JsonFileOptions<{ installId: string }> = {
  label: 'Telemetry install id',
  maxBytes: 4096,
  validate: (value): value is { installId: string } =>
    Boolean(value) &&
    typeof value === 'object' &&
    isTelemetryId((value as { installId?: unknown }).installId)
}

const EVENT_QUEUE_FILE_OPTIONS: JsonFileOptions<TelemetryEvent[]> = {
  label: 'Telemetry event queue',
  maxBytes: 1024 * 1024,
  validate: (value): value is TelemetryEvent[] =>
    Array.isArray(value) && value.every(isTelemetryEvent)
}

export function isAllowedTelemetryEndpoint(endpointUrl: string): boolean {
  try {
    const parsed = new URL(endpointUrl)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol === 'http:') {
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    }
    return false
  } catch {
    return false
  }
}

export class TelemetryClient {
  private readonly endpointUrl: string
  private readonly stateDir: string
  private readonly appVersion: string
  private readonly platform: string
  private readonly arch: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly flushIntervalMs: number
  private readonly checkpointIntervalMs: number
  private readonly maxQueuedEvents: number
  private readonly requestTimeoutMs: number

  private readonly installId: string
  private readonly sessionId: string
  private readonly sessionStartedAt: number
  private queue: TelemetryEvent[] = []
  private playingSinceMs: number | null = null
  private listeningSeconds = 0
  private reportedListeningSeconds = 0
  private flushTimer: NodeJS.Timeout | null = null
  private checkpointTimer: NodeJS.Timeout | null = null
  private flushing = false
  private flushRequestedWhileBusy = false
  private started = false
  private sessionEnded = false

  constructor(options: TelemetryClientOptions) {
    this.endpointUrl = options.endpointUrl.trim()
    this.stateDir = options.stateDir
    this.appVersion = options.appVersion
    this.platform = options.platform
    this.arch = options.arch
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS
    this.maxQueuedEvents = options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.installId = this.loadOrCreateInstallId()
    this.sessionId = this.randomId()
    this.sessionStartedAt = this.now()
    this.queue = this.loadEventQueue()
  }

  getInstallId(): string {
    return this.installId
  }

  getSessionId(): string {
    return this.sessionId
  }

  getListeningSeconds(): number {
    return this.listeningSeconds
  }

  getQueuedEventCount(): number {
    return this.queue.length
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.enqueue({ ...this.baseFields(), type: 'app_start' })
    this.schedulePeriodicFlush()
    this.scheduleCheckpoint()
    void this.flush()
  }

  observePlayback(snapshot: TelemetryPlaybackSnapshot): void {
    if (this.sessionEnded) return
    if (snapshot.state === 'playing') {
      if (this.playingSinceMs === null) this.playingSinceMs = this.now()
      return
    }
    this.closePlayingSegment()
  }

  // 运行期检查点：把累计听歌时长以快照形式入队，进程被硬杀时最多损失一个间隔。
  checkpoint(): void {
    if (this.sessionEnded) return
    this.closePlayingSegment()
    this.enqueueListeningSnapshot()
  }

  async endSession(): Promise<void> {
    if (this.sessionEnded) return
    this.sessionEnded = true
    this.closePlayingSegment()
    this.clearTimers()
    this.enqueueListeningSnapshot()
    await this.flush()
  }

  dispose(): void {
    this.clearTimers()
  }

  async flush(): Promise<boolean> {
    // 投递进行中时登记补跑，避免检查点入队的事件滞留到下一个周期。
    if (this.flushing) {
      this.flushRequestedWhileBusy = true
      return false
    }
    if (!this.endpointUrl || !isAllowedTelemetryEndpoint(this.endpointUrl)) return false
    if (this.queue.length === 0) return false
    this.flushing = true
    // 快照而非引用：在途期间 checkpoint/endSession 可能继续入队，切片只能移除已发送的部分。
    const batch = [...this.queue]
    const payload: TelemetryBatchRequest = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      events: batch
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
      try {
        const response = await this.fetchImpl(this.endpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        })
        if (response.ok) {
          this.queue = this.queue.slice(batch.length)
          this.persistQueue()
          return true
        }
        return false
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    } finally {
      this.flushing = false
      if (this.flushRequestedWhileBusy && this.queue.length > 0) {
        this.flushRequestedWhileBusy = false
        void this.flush()
      }
    }
  }

  private baseFields(): TelemetryEvent {
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      installId: this.installId,
      sessionId: this.sessionId,
      timestamp: this.now(),
      appVersion: this.appVersion,
      platform: this.platform,
      arch: this.arch,
      type: 'app_start'
    }
  }

  private closePlayingSegment(): void {
    if (this.playingSinceMs === null) return
    const elapsedSeconds = (this.now() - this.playingSinceMs) / 1000
    this.playingSinceMs = null
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return
    this.listeningSeconds += Math.min(elapsedSeconds, MAX_SEGMENT_SECONDS)
  }

  private enqueue(event: TelemetryEvent): void {
    this.queue.push(event)
    if (this.queue.length > this.maxQueuedEvents) {
      this.queue = this.queue.slice(this.queue.length - this.maxQueuedEvents)
    }
    this.persistQueue()
  }

  private enqueueListeningSnapshot(): void {
    const totalSeconds = Math.round(this.listeningSeconds)
    if (totalSeconds <= this.reportedListeningSeconds) return
    this.enqueue({
      ...this.baseFields(),
      type: 'session_summary',
      listeningSeconds: totalSeconds,
      sessionSeconds: Math.max(0, Math.round((this.now() - this.sessionStartedAt) / 1000))
    })
    this.reportedListeningSeconds = totalSeconds
    void this.flush()
  }

  private schedulePeriodicFlush(): void {
    if (!this.endpointUrl || this.flushTimer) return
    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.flushIntervalMs)
    this.flushTimer.unref?.()
  }

  private scheduleCheckpoint(): void {
    if (!this.endpointUrl || this.checkpointTimer) return
    this.checkpointTimer = setInterval(() => {
      this.checkpoint()
    }, this.checkpointIntervalMs)
    this.checkpointTimer.unref?.()
  }

  private clearTimers(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer)
      this.checkpointTimer = null
    }
  }

  private persistQueue(): void {
    try {
      writeJsonFileAtomic(
        this.queueFilePath(),
        JSON.stringify(this.queue),
        EVENT_QUEUE_FILE_OPTIONS,
        this.queue
      )
    } catch (error) {
      console.warn(
        '[telemetry] 事件队列持久化失败：',
        error instanceof Error ? error.message : error
      )
    }
  }

  private loadEventQueue(): TelemetryEvent[] {
    try {
      const result = loadJsonFileWithBackup(this.queueFilePath(), EVENT_QUEUE_FILE_OPTIONS)
      if (result.status === 'loaded' || result.status === 'recovered') {
        const queue = result.value.filter((event) => event.sessionId !== this.sessionId)
        return queue.slice(Math.max(0, queue.length - this.maxQueuedEvents))
      }
    } catch (error) {
      console.warn(
        '[telemetry] 事件队列不可用，已重置：',
        error instanceof Error ? error.message : error
      )
    }
    return []
  }

  private loadOrCreateInstallId(): string {
    try {
      const result = loadJsonFileWithBackup(this.installIdFilePath(), INSTALL_ID_FILE_OPTIONS)
      if (result.status === 'loaded' || result.status === 'recovered') {
        return result.value.installId
      }
    } catch (error) {
      console.warn(
        '[telemetry] 安装标识不可用，已重新生成：',
        error instanceof Error ? error.message : error
      )
    }
    const installId = this.randomId()
    try {
      writeJsonFileAtomic(
        this.installIdFilePath(),
        JSON.stringify({ installId }),
        INSTALL_ID_FILE_OPTIONS,
        { installId }
      )
    } catch (error) {
      console.warn(
        '[telemetry] 安装标识持久化失败：',
        error instanceof Error ? error.message : error
      )
    }
    return installId
  }

  private installIdFilePath(): string {
    return join(this.stateDir, 'install-id.json')
  }

  private queueFilePath(): string {
    return join(this.stateDir, 'event-queue.json')
  }
}
