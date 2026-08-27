import { inspectJsonValueWithLimits, type JsonValueLimitResult } from './jsonSafety.ts'

export const MAX_UTILITY_PROCESS_CONTROL_MESSAGE_BYTES = 64 * 1024
export const MAX_UTILITY_PROCESS_ERROR_TEXT_BYTES = 16 * 1024
export const MAX_UTILITY_PROCESS_REQUEST_ID_BYTES = 256
export const MAX_UTILITY_PROCESS_LOG_CHUNK_BYTES = 16 * 1024
export const MAX_UTILITY_PROCESS_LOG_BYTES = 256 * 1024

const OUTPUT_TRUNCATED_NOTICE = '[utility process output truncated]'

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
}

export type UtilityProcessMessageRecord = Record<string, unknown>

export type UtilityProcessResponseEnvelope = {
  requestId: string
  ok: boolean
  value: unknown
  error?: string
}

export type UtilityProcessResponseParseResult =
  | { ok: true; response: UtilityProcessResponseEnvelope }
  | { ok: false; reason: 'invalid-envelope' | 'invalid-error' }

/**
 * Electron and Node IPC deserialize messages as ordinary records. Require that
 * narrow shape explicitly so malformed utility-process data cannot throw while
 * the caller is trying to decide how to recover.
 */
export function asUtilityProcessMessageRecord(value: unknown): UtilityProcessMessageRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || prototype === Object.prototype
      ? (value as UtilityProcessMessageRecord)
      : null
  } catch {
    return null
  }
}

export function isBoundedUtf8String(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  )
}

export function inspectUtilityProcessMessage(
  message: unknown,
  maxBytes: number
): JsonValueLimitResult {
  return inspectJsonValueWithLimits(message, maxBytes)
}

/**
 * A successful utility-process response may intentionally carry no value for
 * void RPC methods. Treat only that explicit absence as a zero-byte payload;
 * all other payloads remain subject to the JSON safety boundary.
 */
export function inspectUtilityProcessPayload(
  value: unknown,
  maxBytes: number
): JsonValueLimitResult {
  if (value !== undefined) return inspectJsonValueWithLimits(value, maxBytes)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer')
  }
  return { ok: true }
}

/**
 * Parses only the stable response envelope. The separately configured payload
 * budget is checked by the client after it knows which request produced it.
 */
export function parseUtilityProcessResponse(message: unknown): UtilityProcessResponseParseResult {
  const record = asUtilityProcessMessageRecord(message)
  if (!record) return { ok: false, reason: 'invalid-envelope' }

  try {
    if (record.kind !== 'response') return { ok: false, reason: 'invalid-envelope' }
    if (
      !isBoundedUtf8String(record.requestId, MAX_UTILITY_PROCESS_REQUEST_ID_BYTES) ||
      !record.requestId
    ) {
      return { ok: false, reason: 'invalid-envelope' }
    }
    if (typeof record.ok !== 'boolean') return { ok: false, reason: 'invalid-envelope' }
    if (
      record.error !== undefined &&
      !isBoundedUtf8String(record.error, MAX_UTILITY_PROCESS_ERROR_TEXT_BYTES)
    ) {
      return { ok: false, reason: 'invalid-error' }
    }
    return {
      ok: true,
      response: {
        requestId: record.requestId,
        ok: record.ok,
        value: record.value,
        ...(typeof record.error === 'string' ? { error: record.error } : {})
      }
    }
  } catch {
    return { ok: false, reason: 'invalid-envelope' }
  }
}

export type UtilityProcessLogCapture = {
  text: string | null
  notice: string | null
}

/**
 * Bounds both a single utility-process log chunk and the total amount emitted
 * during one process lifetime. This protects arbitrary EventEmitter listeners
 * in addition to the bounded diagnostic ring.
 */
export class UtilityProcessLogBudget {
  private emittedBytes = 0
  private truncationNotified = false
  private readonly maxBytes: number
  private readonly maxChunkBytes: number

  constructor(
    maxBytes = MAX_UTILITY_PROCESS_LOG_BYTES,
    maxChunkBytes = MAX_UTILITY_PROCESS_LOG_CHUNK_BYTES
  ) {
    assertNonNegativeSafeInteger(maxBytes, 'maxBytes')
    assertNonNegativeSafeInteger(maxChunkBytes, 'maxChunkBytes')
    this.maxBytes = maxBytes
    this.maxChunkBytes = maxChunkBytes
  }

  reset(): void {
    this.emittedBytes = 0
    this.truncationNotified = false
  }

  capture(chunk: Buffer): UtilityProcessLogCapture {
    const remaining = Math.max(0, this.maxBytes - this.emittedBytes)
    const allowed = Math.min(chunk.byteLength, this.maxChunkBytes, remaining)
    const text = allowed > 0 ? chunk.subarray(0, allowed).toString('utf8') : null
    this.emittedBytes += allowed

    const truncated = chunk.byteLength > allowed
    const notice = truncated && !this.truncationNotified ? OUTPUT_TRUNCATED_NOTICE : null
    if (notice) this.truncationNotified = true
    return { text, notice }
  }
}
