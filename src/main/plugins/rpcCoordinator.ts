import { randomUUID } from 'crypto'
import type { TwilightMediaProviderMethod } from './types.ts'

export const PLUGIN_RPC_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const IDEMPOTENT_PROVIDER_WRITE_METHODS = new Set<TwilightMediaProviderMethod>([
  'likeTrack',
  'followArtist',
  'followUser',
  'createPlaylist',
  'deletePlaylist',
  'addTracksToPlaylist',
  'removeTracksFromPlaylist',
  'completeCloudUpload',
  'createDownload'
])

export function resolveProviderIdempotencyKey(
  method: TwilightMediaProviderMethod,
  suppliedKey: string | undefined
): string | undefined {
  if (!IDEMPOTENT_PROVIDER_WRITE_METHODS.has(method)) return undefined
  const key = suppliedKey?.trim() || randomUUID()
  if (!PLUGIN_RPC_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error('Provider idempotency key is invalid.')
  }
  return key
}

export function normalizeInternalNcmRequestOptions(raw: unknown): { idempotencyKey?: string } {
  if (raw == null) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('ncmRequest options 必须是对象')
  }
  const record = raw as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'idempotencyKey')) {
    throw new Error('ncmRequest options 包含不支持的字段')
  }
  const key = record.idempotencyKey
  if (key == null) return {}
  if (typeof key !== 'string' || !PLUGIN_RPC_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error('ncmRequest idempotency key 无效')
  }
  return { idempotencyKey: key }
}

export const DEFAULT_MAX_PLUGIN_RPC_CONCURRENCY = 4
export const DEFAULT_MAX_PLUGIN_RPC_QUEUE = 32
export const DEFAULT_PLUGIN_RPC_CIRCUIT_FAILURE_THRESHOLD = 3
export const DEFAULT_PLUGIN_RPC_CIRCUIT_INITIAL_BACKOFF_MS = 1_000
export const DEFAULT_PLUGIN_RPC_CIRCUIT_MAX_BACKOFF_MS = 30_000
export const DEFAULT_PLUGIN_RPC_LATE_RESULT_TTL_MS = 5 * 60_000
export const DEFAULT_PLUGIN_RPC_IDEMPOTENCY_TTL_MS = 5 * 60_000
export const DEFAULT_MAX_PLUGIN_RPC_LATE_RESULTS = 256
export const DEFAULT_MAX_PLUGIN_RPC_IDEMPOTENCY_RECORDS = 512

export type PluginRpcKind = 'provider' | 'ui-command'

export interface PluginRpcIdempotency {
  /** A namespace chosen by the caller, usually plugin/provider/method. */
  scope: string
  key: string
  /** Reject accidental reuse of one key for a different request payload. */
  fingerprint: string
}

export interface PluginRpcRequestOptions<TMetadata> {
  requestId: string
  pluginId: string
  kind: PluginRpcKind
  timeoutMs: number
  metadata: TMetadata
  dispatch: () => void
  cancel?: (reason: string) => void
  onTimeout?: (error: Error) => void
  signal?: AbortSignal
  idempotency?: PluginRpcIdempotency
}

export type PluginRpcResult = { ok: true; value: unknown } | { ok: false; error: string }

export type PluginRpcCompletion<TMetadata> =
  | { status: 'settled'; metadata: TMetadata; result: PluginRpcResult }
  | { status: 'late' | 'unknown' | 'wrong-plugin' }

export interface PluginRpcCoordinatorOptions {
  maxConcurrencyPerPlugin?: number
  maxQueuePerPlugin?: number
  circuitFailureThreshold?: number
  circuitInitialBackoffMs?: number
  circuitMaxBackoffMs?: number
  lateResultTtlMs?: number
  idempotencyTtlMs?: number
  maxLateResults?: number
  maxIdempotencyRecords?: number
  now?: () => number
}

interface PluginCircuitState {
  consecutiveFailures: number
  openUntil: number | null
  probeRequestId: string | null
}

interface PluginRpcState {
  active: Map<string, PendingPluginRpc<unknown>>
  queue: PendingPluginRpc<unknown>[]
  circuit: PluginCircuitState
  cancelling: boolean
}

interface PendingPluginRpc<TMetadata> {
  requestId: string
  pluginId: string
  kind: PluginRpcKind
  timeoutMs: number
  metadata: TMetadata
  dispatch: () => void
  cancel?: (reason: string) => void
  onTimeout?: (error: Error) => void
  signal?: AbortSignal
  abortListener?: () => void
  idempotency?: {
    cacheKey: string
    fingerprint: string
  }
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  dispatched: boolean
  settled: boolean
  circuitProbe: boolean
}

interface IdempotencyRecord {
  fingerprint: string
  promise: Promise<unknown>
  expiresAt: number
  status: 'in-flight' | 'succeeded' | 'unknown-outcome'
}

/**
 * Owns the lifecycle of calls sent from the main process to one plugin host.
 * The coordinator intentionally has no Electron dependency so overload and
 * cancellation behaviour can be verified with normal Node tests.
 */
export class PluginRpcCoordinator {
  private readonly maxConcurrencyPerPlugin: number
  private readonly maxQueuePerPlugin: number
  private readonly circuitFailureThreshold: number
  private readonly circuitInitialBackoffMs: number
  private readonly circuitMaxBackoffMs: number
  private readonly lateResultTtlMs: number
  private readonly idempotencyTtlMs: number
  private readonly maxLateResults: number
  private readonly maxIdempotencyRecords: number
  private readonly now: () => number
  private readonly states = new Map<string, PluginRpcState>()
  private readonly pendingById = new Map<string, PendingPluginRpc<unknown>>()
  private readonly lateResults = new Map<string, number>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()

  constructor(options: PluginRpcCoordinatorOptions = {}) {
    this.maxConcurrencyPerPlugin = positiveInteger(
      options.maxConcurrencyPerPlugin,
      DEFAULT_MAX_PLUGIN_RPC_CONCURRENCY,
      'maxConcurrencyPerPlugin'
    )
    this.maxQueuePerPlugin = positiveInteger(
      options.maxQueuePerPlugin,
      DEFAULT_MAX_PLUGIN_RPC_QUEUE,
      'maxQueuePerPlugin'
    )
    this.circuitFailureThreshold = positiveInteger(
      options.circuitFailureThreshold,
      DEFAULT_PLUGIN_RPC_CIRCUIT_FAILURE_THRESHOLD,
      'circuitFailureThreshold'
    )
    this.circuitInitialBackoffMs = positiveInteger(
      options.circuitInitialBackoffMs,
      DEFAULT_PLUGIN_RPC_CIRCUIT_INITIAL_BACKOFF_MS,
      'circuitInitialBackoffMs'
    )
    this.circuitMaxBackoffMs = positiveInteger(
      options.circuitMaxBackoffMs,
      DEFAULT_PLUGIN_RPC_CIRCUIT_MAX_BACKOFF_MS,
      'circuitMaxBackoffMs'
    )
    this.lateResultTtlMs = positiveInteger(
      options.lateResultTtlMs,
      DEFAULT_PLUGIN_RPC_LATE_RESULT_TTL_MS,
      'lateResultTtlMs'
    )
    this.idempotencyTtlMs = positiveInteger(
      options.idempotencyTtlMs,
      DEFAULT_PLUGIN_RPC_IDEMPOTENCY_TTL_MS,
      'idempotencyTtlMs'
    )
    this.maxLateResults = positiveInteger(
      options.maxLateResults,
      DEFAULT_MAX_PLUGIN_RPC_LATE_RESULTS,
      'maxLateResults'
    )
    this.maxIdempotencyRecords = positiveInteger(
      options.maxIdempotencyRecords,
      DEFAULT_MAX_PLUGIN_RPC_IDEMPOTENCY_RECORDS,
      'maxIdempotencyRecords'
    )
    this.now = options.now ?? Date.now
  }

  request<T, TMetadata = unknown>(options: PluginRpcRequestOptions<TMetadata>): Promise<T> {
    if (!options.requestId.trim())
      return Promise.reject(new Error('Plugin RPC request id is required.'))
    if (!options.pluginId.trim())
      return Promise.reject(new Error('Plugin RPC plugin id is required.'))
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      return Promise.reject(new Error('Plugin RPC timeout must be a positive number.'))
    }
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal))
    this.pruneExpiredEntries()
    if (this.pendingById.has(options.requestId)) {
      return Promise.reject(
        new Error(`Plugin RPC request id is already pending: ${options.requestId}`)
      )
    }
    if (this.lateResults.has(options.requestId)) {
      return Promise.reject(
        new Error(
          `Plugin RPC request id is quarantined after a prior settlement: ${options.requestId}`
        )
      )
    }
    const idempotency = options.idempotency ? this.prepareIdempotency<T>(options.idempotency) : null
    if (idempotency?.existing) return idempotency.existing

    const state = this.stateFor(options.pluginId)
    const circuitError = this.reserveCircuitProbe(state, options.pluginId, options.requestId)
    if (circuitError) return Promise.reject(circuitError)
    if (
      state.active.size >= this.maxConcurrencyPerPlugin &&
      state.queue.length >= this.maxQueuePerPlugin
    ) {
      this.clearCircuitProbe(state, options.requestId)
      return Promise.reject(
        new Error(
          `Plugin ${options.pluginId} RPC queue is full (${this.maxQueuePerPlugin} waiting requests).`
        )
      )
    }

    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((resolveRequest, rejectRequest) => {
      resolve = resolveRequest as (value: unknown) => void
      reject = rejectRequest
    })
    const pending: PendingPluginRpc<TMetadata> = {
      requestId: options.requestId,
      pluginId: options.pluginId,
      kind: options.kind,
      timeoutMs: options.timeoutMs,
      metadata: options.metadata,
      dispatch: options.dispatch,
      cancel: options.cancel,
      onTimeout: options.onTimeout,
      signal: options.signal,
      idempotency: idempotency?.record,
      resolve,
      reject,
      timer: null,
      dispatched: false,
      settled: false,
      circuitProbe: state.circuit.probeRequestId === options.requestId
    }
    this.pendingById.set(pending.requestId, pending as PendingPluginRpc<unknown>)
    if (idempotency?.record) {
      this.idempotency.set(idempotency.record.cacheKey, {
        fingerprint: idempotency.record.fingerprint,
        promise,
        expiresAt: Number.POSITIVE_INFINITY,
        status: 'in-flight'
      })
    }
    pending.timer = setTimeout(() => this.timeout(pending.requestId), pending.timeoutMs)
    if (pending.signal) {
      pending.abortListener = () => this.abort(pending.requestId)
      pending.signal.addEventListener('abort', pending.abortListener, { once: true })
      if (pending.signal.aborted) this.abort(pending.requestId)
    }

    if (pending.settled) return promise
    if (state.active.size < this.maxConcurrencyPerPlugin) {
      this.start(state, pending as PendingPluginRpc<unknown>)
    } else {
      state.queue.push(pending as PendingPluginRpc<unknown>)
    }
    return promise
  }

  complete<TMetadata>(
    pluginId: string,
    requestId: string,
    result: PluginRpcResult
  ): PluginRpcCompletion<TMetadata> {
    this.pruneExpiredEntries()
    const pending = this.pendingById.get(requestId)
    if (!pending) {
      return this.lateResults.has(requestId) ? { status: 'late' } : { status: 'unknown' }
    }
    if (pending.pluginId !== pluginId) return { status: 'wrong-plugin' }
    if (!pending.dispatched) return { status: 'unknown' }

    const state = this.stateFor(pluginId)
    if (result.ok) {
      this.settle(state, pending, { kind: 'success', value: result.value })
    } else {
      this.settle(state, pending, { kind: 'remote-error', error: new Error(result.error) })
    }
    return { status: 'settled', metadata: pending.metadata as TMetadata, result }
  }

  /** Reject queued and active requests before a host is stopped or discarded. */
  cancelPlugin(pluginId: string, reason: string): number {
    const state = this.states.get(pluginId)
    if (!state) return 0
    const error = new Error(reason)
    let cancelled = 0
    state.cancelling = true
    try {
      for (const pending of [...state.active.values()]) {
        this.addLateResult(pending.requestId)
        try {
          pending.cancel?.(reason)
        } catch {
          // A dead utility process can reject postMessage. The caller still gets a prompt rejection.
        }
        this.settle(state, pending, { kind: 'cancelled-active', error })
        cancelled += 1
      }
      for (const pending of [...state.queue]) {
        this.settle(state, pending, { kind: 'cancelled-queued', error })
        cancelled += 1
      }
    } finally {
      state.cancelling = false
    }
    this.cleanupState(pluginId, state)
    return cancelled
  }

  getPendingCount(pluginId: string): number {
    const state = this.states.get(pluginId)
    return state ? state.active.size + state.queue.length : 0
  }

  getMetadata<TMetadata>(pluginId: string, requestId: string): TMetadata | null {
    const pending = this.pendingById.get(requestId)
    if (!pending || !pending.dispatched || pending.pluginId !== pluginId) return null
    return pending.metadata as TMetadata
  }

  getLateResultCount(): number {
    this.pruneExpiredEntries()
    return this.lateResults.size
  }

  private start(state: PluginRpcState, pending: PendingPluginRpc<unknown>): void {
    if (pending.settled) return
    pending.dispatched = true
    state.active.set(pending.requestId, pending)
    try {
      pending.dispatch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.settle(state, pending, { kind: 'remote-error', error: new Error(message) })
    }
  }

  private abort(requestId: string): void {
    const pending = this.pendingById.get(requestId)
    if (!pending || pending.settled) return
    const state = this.stateFor(pending.pluginId)
    const error = abortError(pending.signal)
    if (pending.dispatched) {
      this.addLateResult(pending.requestId)
      try {
        pending.cancel?.(error.message)
      } catch {
        // The utility process may have exited between abort and cancellation.
      }
      this.settle(state, pending, { kind: 'cancelled-active', error })
    } else {
      this.settle(state, pending, { kind: 'cancelled-queued', error })
    }
  }

  private timeout(requestId: string): void {
    const pending = this.pendingById.get(requestId)
    if (!pending || pending.settled) return
    const state = this.stateFor(pending.pluginId)
    const error = new Error(
      `Plugin ${pending.pluginId} ${pending.kind} RPC timed out after ${pending.timeoutMs}ms.`
    )
    if (pending.dispatched) {
      this.addLateResult(pending.requestId)
      try {
        pending.cancel?.(error.message)
      } catch {
        // The utility process may have exited between timeout and cancellation.
      }
      this.settle(state, pending, { kind: 'timeout-active', error })
    } else {
      this.settle(state, pending, { kind: 'timeout-queued', error })
    }
    try {
      pending.onTimeout?.(error)
    } catch {
      // A caller-owned timeout observer must not break coordinator cleanup.
    }
  }

  private settle(
    state: PluginRpcState,
    pending: PendingPluginRpc<unknown>,
    outcome:
      | { kind: 'success'; value: unknown }
      | {
          kind:
            | 'remote-error'
            | 'timeout-active'
            | 'timeout-queued'
            | 'cancelled-active'
            | 'cancelled-queued'
          error: Error
        }
  ): void {
    if (pending.settled) return
    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
    pending.abortListener = undefined
    this.pendingById.delete(pending.requestId)
    if (pending.dispatched) state.active.delete(pending.requestId)
    else {
      const index = state.queue.indexOf(pending)
      if (index >= 0) state.queue.splice(index, 1)
    }
    this.clearCircuitProbe(state, pending.requestId)

    const preserveSucceededIdempotency = outcome.kind === 'success'
    const preserveUnknownIdempotency =
      (outcome.kind === 'timeout-active' || outcome.kind === 'cancelled-active') &&
      pending.dispatched
    if (pending.idempotency) {
      const record = this.idempotency.get(pending.idempotency.cacheKey)
      if (!preserveSucceededIdempotency && !preserveUnknownIdempotency) {
        this.idempotency.delete(pending.idempotency.cacheKey)
      } else if (record) {
        record.status = preserveSucceededIdempotency ? 'succeeded' : 'unknown-outcome'
        record.expiresAt = this.now() + this.idempotencyTtlMs
      }
    }

    if (outcome.kind === 'success') {
      this.recordSuccess(state, pending)
      pending.resolve(outcome.value)
    } else {
      if (outcome.kind === 'remote-error' || outcome.kind === 'timeout-active') {
        this.recordFailure(state, pending)
      }
      pending.reject(outcome.error)
    }
    this.drain(pending.pluginId, state)
    this.cleanupState(pending.pluginId, state)
  }

  private drain(pluginId: string, state: PluginRpcState): void {
    if (state.cancelling) return
    while (state.active.size < this.maxConcurrencyPerPlugin && state.queue.length > 0) {
      const pending = state.queue.shift()
      if (!pending || pending.settled) continue
      if (this.circuitBlocksQueuedRequest(state, pending)) {
        this.settle(state, pending, {
          kind: 'cancelled-queued',
          error: this.circuitError(pluginId, state.circuit.openUntil ?? this.now())
        })
        continue
      }
      this.start(state, pending)
    }
  }

  private recordSuccess(state: PluginRpcState, pending: PendingPluginRpc<unknown>): void {
    if (pending.circuitProbe) {
      state.circuit.consecutiveFailures = 0
      state.circuit.openUntil = null
      return
    }
    if (state.circuit.openUntil === null) state.circuit.consecutiveFailures = 0
  }

  private recordFailure(state: PluginRpcState, pending: PendingPluginRpc<unknown>): void {
    state.circuit.consecutiveFailures += 1
    if (state.circuit.consecutiveFailures < this.circuitFailureThreshold) return
    const exponent = state.circuit.consecutiveFailures - this.circuitFailureThreshold
    const backoff = Math.min(
      this.circuitMaxBackoffMs,
      this.circuitInitialBackoffMs * 2 ** Math.min(exponent, 30)
    )
    state.circuit.openUntil = this.now() + backoff
    state.circuit.probeRequestId = null
    for (const queued of [...state.queue]) {
      this.settle(state, queued, {
        kind: 'cancelled-queued',
        error: this.circuitError(pending.pluginId, state.circuit.openUntil)
      })
    }
  }

  private reserveCircuitProbe(
    state: PluginRpcState,
    pluginId: string,
    requestId: string
  ): Error | null {
    const openUntil = state.circuit.openUntil
    if (openUntil === null) return null
    if (this.now() < openUntil) return this.circuitError(pluginId, openUntil)
    if (state.circuit.probeRequestId) {
      return new Error('Plugin RPC circuit is half-open; wait for the recovery probe to finish.')
    }
    state.circuit.probeRequestId = requestId
    return null
  }

  private circuitBlocksQueuedRequest(
    state: PluginRpcState,
    pending: PendingPluginRpc<unknown>
  ): boolean {
    const openUntil = state.circuit.openUntil
    if (openUntil === null) return false
    if (pending.circuitProbe) return this.now() < openUntil
    return true
  }

  private circuitError(pluginId: string, openUntil: number): Error {
    const retryAfterMs = Math.max(0, openUntil - this.now())
    return new Error(`Plugin ${pluginId} RPC circuit is open; retry after ${retryAfterMs}ms.`)
  }

  private clearCircuitProbe(state: PluginRpcState, requestId: string): void {
    if (state.circuit.probeRequestId === requestId) state.circuit.probeRequestId = null
  }

  private prepareIdempotency<T>(idempotency: PluginRpcIdempotency): {
    existing?: Promise<T>
    record?: { cacheKey: string; fingerprint: string }
  } {
    if (!idempotency.scope || !idempotency.key || !idempotency.fingerprint) {
      return { existing: Promise.reject(new Error('Plugin RPC idempotency data is incomplete.')) }
    }
    const cacheKey = `${idempotency.scope}\u0000${idempotency.key}`
    const existing = this.idempotency.get(cacheKey)
    if (existing) {
      if (existing.fingerprint !== idempotency.fingerprint) {
        return {
          existing: Promise.reject(
            new Error('Plugin RPC idempotency key is already bound to a different request payload.')
          )
        }
      }
      if (existing.status !== 'unknown-outcome') {
        return { existing: existing.promise as Promise<T> }
      }
      return { record: { cacheKey, fingerprint: idempotency.fingerprint } }
    }
    this.evictSettledIdempotencyRecords(this.maxIdempotencyRecords - 1)
    if (this.idempotency.size >= this.maxIdempotencyRecords) {
      return {
        existing: Promise.reject(
          new Error('Plugin RPC idempotency registry is full of in-flight write operations.')
        )
      }
    }
    return { record: { cacheKey, fingerprint: idempotency.fingerprint } }
  }

  private stateFor(pluginId: string): PluginRpcState {
    const existing = this.states.get(pluginId)
    if (existing) return existing
    const created: PluginRpcState = {
      active: new Map(),
      queue: [],
      circuit: { consecutiveFailures: 0, openUntil: null, probeRequestId: null },
      cancelling: false
    }
    this.states.set(pluginId, created)
    return created
  }

  private cleanupState(pluginId: string, state: PluginRpcState): void {
    if (state.active.size !== 0 || state.queue.length !== 0) return
    if (state.circuit.consecutiveFailures !== 0) return
    if (state.circuit.openUntil !== null && this.now() < state.circuit.openUntil) return
    this.states.delete(pluginId)
  }

  private addLateResult(requestId: string): void {
    this.lateResults.set(requestId, this.now() + this.lateResultTtlMs)
    this.trimLateResults()
  }

  private pruneExpiredEntries(): void {
    const now = this.now()
    for (const [requestId, expiresAt] of this.lateResults) {
      if (expiresAt <= now) this.lateResults.delete(requestId)
    }
    for (const [cacheKey, record] of this.idempotency) {
      if (record.status !== 'in-flight' && record.expiresAt <= now) {
        this.idempotency.delete(cacheKey)
      }
    }
    this.trimLateResults()
    this.evictSettledIdempotencyRecords(this.maxIdempotencyRecords)
  }

  private trimLateResults(): void {
    while (this.lateResults.size > this.maxLateResults) {
      const oldest = this.lateResults.keys().next().value
      if (oldest === undefined) break
      this.lateResults.delete(oldest)
    }
  }

  private evictSettledIdempotencyRecords(maximumSize: number): void {
    if (this.idempotency.size <= maximumSize) return
    for (const [cacheKey, record] of this.idempotency) {
      if (record.status === 'in-flight') continue
      this.idempotency.delete(cacheKey)
      if (this.idempotency.size <= maximumSize) return
    }
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  if (reason != null) return new Error(String(reason))
  return new Error('Plugin RPC request was aborted.')
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return selected
}
