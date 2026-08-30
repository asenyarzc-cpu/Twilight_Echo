export const TELEMETRY_SCHEMA_VERSION = 1

export const TELEMETRY_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export interface TelemetryBaseFields {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  installId: string
  sessionId: string
  timestamp: number
  appVersion: string
  platform: string
  arch: string
}

export type TelemetryAppStartEvent = TelemetryBaseFields & {
  type: 'app_start'
}

export type TelemetrySessionSummaryEvent = TelemetryBaseFields & {
  type: 'session_summary'
  listeningSeconds: number
  sessionSeconds: number
}

export type TelemetryEvent = TelemetryAppStartEvent | TelemetrySessionSummaryEvent

export interface TelemetryBatchRequest {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  events: TelemetryEvent[]
}

export function isTelemetryId(value: unknown): value is string {
  return typeof value === 'string' && TELEMETRY_ID_PATTERN.test(value)
}

function isTelemetryBaseFields(value: unknown): value is TelemetryBaseFields {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === TELEMETRY_SCHEMA_VERSION &&
    isTelemetryId(record.installId) &&
    isTelemetryId(record.sessionId) &&
    typeof record.timestamp === 'number' &&
    Number.isFinite(record.timestamp) &&
    record.timestamp >= 0 &&
    typeof record.appVersion === 'string' &&
    record.appVersion.length > 0 &&
    record.appVersion.length <= 64 &&
    typeof record.platform === 'string' &&
    record.platform.length > 0 &&
    record.platform.length <= 32 &&
    typeof record.arch === 'string' &&
    record.arch.length > 0 &&
    record.arch.length <= 32
  )
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (!isTelemetryBaseFields(record)) return false
  if (record.type === 'app_start') return true
  if (record.type === 'session_summary') {
    return (
      isNonNegativeFiniteNumber(record.listeningSeconds) &&
      isNonNegativeFiniteNumber(record.sessionSeconds)
    )
  }
  return false
}

export function isTelemetryBatchRequest(value: unknown): value is TelemetryBatchRequest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== TELEMETRY_SCHEMA_VERSION) return false
  if (!Array.isArray(record.events) || record.events.length === 0) return false
  return record.events.every(isTelemetryEvent)
}
