import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { createRequire } from 'module'
import type {
  LocalLibraryScanBatch,
  LocalLibraryFileIdentity,
  LocalLibraryScanIdentityBatch,
  LocalLibraryScanProgress,
  LocalLibraryScanWorkerMessage,
  LocalLibraryScanWorkerRequest,
  LocalLibraryWorkerScanRequest,
  LocalLibraryWorkerScanResult
} from '../../shared/localLibraryScan.ts'

const require = createRequire(import.meta.url)

type UtilityProcessLike = {
  postMessage: (message: LocalLibraryScanWorkerRequest) => void
  kill: () => void
  on: (
    event: 'message' | 'exit' | 'error',
    listener:
      | ((message: LocalLibraryScanWorkerMessage) => void)
      | ((code: number | null) => void)
      | ((error: unknown, location?: string) => void)
  ) => void
}

type ElectronModule = {
  utilityProcess?: {
    fork: (
      modulePath: string,
      args?: string[],
      options?: { serviceName?: string; stdio?: 'pipe' }
    ) => UtilityProcessLike
  }
}

type PendingScan = {
  resolve: (result: LocalLibraryWorkerScanResult) => void
  reject: (error: Error) => void
  onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void
  onBatch?: (batch: LocalLibraryScanBatch) => void
  onIdentityBatch?: (batch: LocalLibraryScanIdentityBatch) => void
  onAttemptReset?: () => void
  watchdog: NodeJS.Timeout | null
  request: LocalLibraryWorkerScanRequest
  lastFilePaths: string[]
  restartCount: number
  restarting: boolean
  paused: boolean
  identities: LocalLibraryFileIdentity[]
  completedFilePaths: Set<string>
  parsedFileCount: number
}

export interface LocalLibraryScanRunner {
  scan(
    jobId: string,
    request: LocalLibraryWorkerScanRequest,
    onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void,
    onBatch?: (batch: LocalLibraryScanBatch) => void,
    onIdentityBatch?: (batch: LocalLibraryScanIdentityBatch) => void,
    onAttemptReset?: () => void
  ): Promise<LocalLibraryWorkerScanResult>
  pause(requestId: string): void
  resume(requestId: string): void
  cancel(requestId: string): void
  destroy(): void
}

export interface LocalLibraryScanServiceClientOptions {
  serviceEntry: string
  startupTimeoutMs?: number
  scanWatchdogMs?: number
  electron?: ElectronModule
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_SCAN_WATCHDOG_MS = 60_000
const MAX_SCAN_WORKER_RESTARTS = 3

export class LocalLibraryScanServiceClient extends EventEmitter implements LocalLibraryScanRunner {
  private readonly options: LocalLibraryScanServiceClientOptions
  private readonly scanWatchdogMs: number
  private child: UtilityProcessLike | null = null
  private readyPromise: Promise<void> | null = null
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private readonly pending = new Map<string, PendingScan>()
  private stopped = false
  private unavailableError = ''

  constructor(options: LocalLibraryScanServiceClientOptions) {
    super()
    this.options = options
    this.scanWatchdogMs =
      typeof options.scanWatchdogMs === 'number' && Number.isFinite(options.scanWatchdogMs)
        ? Math.max(100, Math.floor(options.scanWatchdogMs))
        : DEFAULT_SCAN_WATCHDOG_MS
  }

  async scan(
    jobId: string,
    request: LocalLibraryWorkerScanRequest,
    onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void,
    onBatch?: (batch: LocalLibraryScanBatch) => void,
    onIdentityBatch?: (batch: LocalLibraryScanIdentityBatch) => void,
    onAttemptReset?: () => void
  ): Promise<LocalLibraryWorkerScanResult> {
    await this.waitUntilReady()
    const child = this.child
    if (!child)
      throw new Error(this.unavailableError || 'local library scan service is unavailable')
    const requestId = jobId || randomUUID()
    return await new Promise<LocalLibraryWorkerScanResult>((resolve, reject) => {
      const pending: PendingScan = {
        resolve,
        reject,
        onProgress,
        onBatch,
        onIdentityBatch,
        onAttemptReset,
        watchdog: null,
        request,
        lastFilePaths: [],
        restartCount: 0,
        restarting: false,
        paused: false,
        identities: [],
        completedFilePaths: new Set(),
        parsedFileCount: 0
      }
      this.pending.set(requestId, pending)
      this.sendPendingScan(requestId, pending, child)
    })
  }

  pause(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (pending) {
      pending.paused = true
      if (pending.watchdog) clearTimeout(pending.watchdog)
      pending.watchdog = null
    }
    this.sendControl({ kind: 'pause', requestId })
  }

  resume(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (pending) {
      pending.paused = false
      this.armWatchdog(requestId, pending)
    }
    this.sendControl({ kind: 'resume', requestId })
  }

  cancel(requestId: string): void {
    this.sendControl({ kind: 'cancel', requestId })
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.clearPending(requestId, pending)
    this.rejectPendingExcept(
      null,
      new Error('local library scan service was stopped for cancellation')
    )
    this.detachChild()
    pending.resolve(createCancelledScanResult(pending.request.mode))
  }

  destroy(): void {
    this.stopped = true
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    const error = new Error('local library scan service stopped')
    this.rejectReady?.(error)
    this.rejectReady = null
    this.resolveReady = null
    for (const [requestId, pending] of this.pending) {
      this.clearPending(requestId, pending)
      pending.reject(error)
    }
    this.pending.clear()
    try {
      this.child?.kill()
    } catch {
      // The process is already gone.
    }
    this.child = null
  }

  private start(): boolean {
    if (this.stopped) return false
    if (this.child || this.readyPromise) return true
    const electron = this.options.electron ?? (require('electron') as ElectronModule)
    if (!electron.utilityProcess) {
      this.unavailableError = 'Electron utilityProcess is unavailable for local library scanning'
      return false
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    try {
      const child = electron.utilityProcess.fork(this.options.serviceEntry, [], {
        serviceName: 'twilight-local-library-scan',
        stdio: 'pipe'
      })
      this.child = child
      child.on('message', (message) => {
        if (this.child !== child) return
        this.handleMessage(message as LocalLibraryScanWorkerMessage)
      })
      child.on('error', (error) => {
        if (this.child !== child) return
        this.handleExit(error instanceof Error ? error.message : String(error))
      })
      child.on('exit', (code) => {
        if (this.child !== child) return
        this.handleExit(`local library scan service exited (${code ?? 'unknown'})`)
      })
      this.startupTimer = setTimeout(() => {
        this.handleExit('local library scan service startup timed out')
      }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
      return true
    } catch (error) {
      this.handleExit(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  private async waitUntilReady(): Promise<void> {
    if (!this.readyPromise && !this.child && !this.unavailableError) this.start()
    if (this.unavailableError) throw new Error(this.unavailableError)
    await this.readyPromise
  }

  private handleMessage(message: LocalLibraryScanWorkerMessage): void {
    if (message.kind === 'ready') {
      if (this.startupTimer) clearTimeout(this.startupTimer)
      this.startupTimer = null
      this.resolveReady?.()
      this.resolveReady = null
      this.rejectReady = null
      this.emit('ready')
      for (const [requestId, pending] of this.pending) {
        if (!pending.restarting) continue
        pending.restarting = false
        this.sendPendingScan(requestId, pending, this.child)
      }
      return
    }
    if (message.kind === 'progress') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.touchWatchdog(pending)
      pending.onProgress?.(message.progress)
      return
    }
    if (message.kind === 'activity') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      pending.lastFilePaths = message.activity.filePaths
      this.touchWatchdog(pending)
      return
    }
    if (message.kind === 'batch') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.touchWatchdog(pending)
      for (const filePath of message.batch.parsedFilePaths) pending.completedFilePaths.add(filePath)
      const trackPaths = new Set(
        message.batch.parsedTracks.flatMap((track) =>
          track &&
          typeof track === 'object' &&
          'filePath' in track &&
          typeof track.filePath === 'string'
            ? [track.filePath]
            : []
        )
      )
      pending.parsedFileCount += trackPaths.size
      pending.onBatch?.(message.batch)
      return
    }
    if (message.kind === 'identity-batch') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.touchWatchdog(pending)
      pending.identities.push(...message.batch.identities)
      pending.onIdentityBatch?.(message.batch)
      return
    }
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.clearPending(message.requestId, pending)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error))
  }

  private sendPendingScan(
    requestId: string,
    pending: PendingScan,
    child: UtilityProcessLike | null
  ): void {
    if (!child) {
      pending.restarting = true
      return
    }
    this.armWatchdog(requestId, pending)
    try {
      child.postMessage({ kind: 'scan', requestId, request: pending.request })
      if (pending.paused) child.postMessage({ kind: 'pause', requestId })
    } catch (error) {
      this.clearPending(requestId, pending)
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private armWatchdog(requestId: string, pending: PendingScan): void {
    if (pending.watchdog) clearTimeout(pending.watchdog)
    if (pending.paused) return
    pending.watchdog = setTimeout(() => {
      if (this.pending.get(requestId) !== pending) return
      const skippedPaths = Array.from(new Set(pending.lastFilePaths))
      if (skippedPaths.length === 0 || pending.restartCount >= MAX_SCAN_WORKER_RESTARTS) {
        this.clearPending(requestId, pending)
        const error = new Error(
          `local library scan worker stopped responding after ${this.scanWatchdogMs}ms`
        )
        this.rejectPendingExcept(null, error)
        this.detachChild()
        pending.reject(error)
        this.emit('service-error', error)
        return
      }

      pending.restartCount += 1
      pending.restarting = true
      const canResume =
        pending.request.streamResults === true &&
        pending.identities.length > 0 &&
        (pending.request.mode !== 'watch' ||
          !pending.request.changes?.length ||
          pending.request.changes.some((change) => change.kind === 'reconcile'))
      if (!canResume) {
        pending.onAttemptReset?.()
        pending.identities = []
        pending.completedFilePaths.clear()
        pending.parsedFileCount = 0
      }
      pending.lastFilePaths = []
      pending.request = {
        ...pending.request,
        skipParsePaths: Array.from(
          new Set([...(pending.request.skipParsePaths ?? []), ...skippedPaths])
        ),
        ...(canResume
          ? {
              resumeCheckpoint: {
                identities: pending.identities,
                completeIdentitySnapshot:
                  pending.request.mode !== 'watch' ||
                  !pending.request.changes?.length ||
                  pending.request.changes.some((change) => change.kind === 'reconcile'),
                completedFilePaths: Array.from(pending.completedFilePaths),
                parsedFileCount: pending.parsedFileCount
              }
            }
          : {})
      }
      this.rejectPendingExcept(requestId, new Error('local library scan service is restarting'))
      if (pending.watchdog) clearTimeout(pending.watchdog)
      pending.watchdog = null
      this.detachChild()
      if (!this.start() && this.pending.get(requestId) === pending) {
        this.clearPending(requestId, pending)
        const error = new Error(
          this.unavailableError || 'local library scan service is unavailable after restart'
        )
        pending.reject(error)
        this.emit('service-error', error)
      }
    }, this.scanWatchdogMs)
  }

  private touchWatchdog(pending: PendingScan): void {
    for (const [requestId, candidate] of this.pending) {
      if (candidate !== pending) continue
      this.armWatchdog(requestId, pending)
      return
    }
  }

  private detachChild(): void {
    const child = this.child
    this.child = null
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    this.readyPromise = null
    this.resolveReady = null
    this.rejectReady = null
    this.unavailableError = ''
    try {
      child?.kill()
    } catch {
      // The process is already gone.
    }
  }

  private clearPending(requestId: string, pending: PendingScan): void {
    if (this.pending.get(requestId) !== pending) return
    this.pending.delete(requestId)
    if (pending.watchdog) clearTimeout(pending.watchdog)
    pending.watchdog = null
  }

  private rejectPendingExcept(requestId: string | null, error: Error): void {
    for (const [candidateId, pending] of this.pending) {
      if (candidateId === requestId) continue
      this.clearPending(candidateId, pending)
      pending.reject(error)
    }
  }

  private handleExit(reason: string): void {
    if (this.stopped || (!this.child && !this.readyPromise)) return
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    const error = new Error(reason)
    this.rejectReady?.(error)
    this.rejectReady = null
    this.resolveReady = null
    for (const [requestId, pending] of this.pending) {
      this.clearPending(requestId, pending)
      pending.reject(error)
    }
    this.pending.clear()
    this.child = null
    this.readyPromise = null
    this.unavailableError = ''
    this.emit('service-error', error)
  }

  private sendControl(message: Exclude<LocalLibraryScanWorkerRequest, { kind: 'scan' }>): void {
    try {
      this.child?.postMessage(message)
    } catch {
      // The request will fail through the active scan promise when the child exits.
    }
  }
}

function createCancelledScanResult(
  mode: LocalLibraryWorkerScanRequest['mode']
): LocalLibraryWorkerScanResult {
  return {
    mode,
    completeIdentitySnapshot: false,
    identities: [],
    parsedTracks: [],
    parsedFilePaths: [],
    removedFilePaths: [],
    skippedUnchanged: 0,
    parsedFileCount: 0,
    cancelled: true
  }
}
