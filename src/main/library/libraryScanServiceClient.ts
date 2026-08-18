import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { createRequire } from 'module'
import type {
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
}

export interface LocalLibraryScanRunner {
  scan(
    jobId: string,
    request: LocalLibraryWorkerScanRequest,
    onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void
  ): Promise<LocalLibraryWorkerScanResult>
  pause(requestId: string): void
  resume(requestId: string): void
  cancel(requestId: string): void
  destroy(): void
}

export interface LocalLibraryScanServiceClientOptions {
  serviceEntry: string
  startupTimeoutMs?: number
  electron?: ElectronModule
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000

export class LocalLibraryScanServiceClient extends EventEmitter implements LocalLibraryScanRunner {
  private readonly options: LocalLibraryScanServiceClientOptions
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
  }

  async scan(
    jobId: string,
    request: LocalLibraryWorkerScanRequest,
    onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void
  ): Promise<LocalLibraryWorkerScanResult> {
    await this.waitUntilReady()
    const child = this.child
    if (!child)
      throw new Error(this.unavailableError || 'local library scan service is unavailable')
    const requestId = jobId || randomUUID()
    return await new Promise<LocalLibraryWorkerScanResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress })
      try {
        child.postMessage({ kind: 'scan', requestId, request })
      } catch (error) {
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  pause(requestId: string): void {
    this.sendControl({ kind: 'pause', requestId })
  }

  resume(requestId: string): void {
    this.sendControl({ kind: 'resume', requestId })
  }

  cancel(requestId: string): void {
    this.sendControl({ kind: 'cancel', requestId })
  }

  destroy(): void {
    this.stopped = true
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    const error = new Error('local library scan service stopped')
    this.rejectReady?.(error)
    this.rejectReady = null
    this.resolveReady = null
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    try {
      this.child?.kill()
    } catch {
      // The process is already gone.
    }
    this.child = null
  }

  private start(): void {
    if (this.stopped || this.child || this.readyPromise) return
    const electron = this.options.electron ?? (require('electron') as ElectronModule)
    if (!electron.utilityProcess) {
      this.unavailableError = 'Electron utilityProcess is unavailable for local library scanning'
      return
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
      child.on('message', (message) => this.handleMessage(message as LocalLibraryScanWorkerMessage))
      child.on('error', (error) =>
        this.handleExit(error instanceof Error ? error.message : String(error))
      )
      child.on('exit', (code) =>
        this.handleExit(`local library scan service exited (${code ?? 'unknown'})`)
      )
      this.startupTimer = setTimeout(() => {
        this.handleExit('local library scan service startup timed out')
      }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    } catch (error) {
      this.handleExit(error instanceof Error ? error.message : String(error))
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
      return
    }
    if (message.kind === 'progress') {
      const pending = this.pending.get(message.requestId)
      pending?.onProgress?.(message.progress)
      return
    }
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error))
  }

  private handleExit(reason: string): void {
    if (this.stopped) return
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    this.unavailableError = reason
    const error = new Error(reason)
    this.rejectReady?.(error)
    this.rejectReady = null
    this.resolveReady = null
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.child = null
    this.readyPromise = null
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
