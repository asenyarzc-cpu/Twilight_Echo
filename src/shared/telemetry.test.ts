import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TELEMETRY_SCHEMA_VERSION,
  isTelemetryBatchRequest,
  isTelemetryEvent,
  isTelemetryId,
  type TelemetryAppStartEvent,
  type TelemetrySessionSummaryEvent
} from './telemetry.ts'

const INSTALL_ID = '4f0d9c2a-1b3e-4d5f-9a6b-7c8d9e0f1a2b'
const SESSION_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

function makeAppStart(overrides: Partial<TelemetryAppStartEvent> = {}): TelemetryAppStartEvent {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    installId: INSTALL_ID,
    sessionId: SESSION_ID,
    timestamp: 1756224000000,
    appVersion: '1.1.0',
    platform: 'win32',
    arch: 'x64',
    type: 'app_start',
    ...overrides
  }
}

function makeSessionSummary(
  overrides: Partial<TelemetrySessionSummaryEvent> = {}
): TelemetrySessionSummaryEvent {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    installId: INSTALL_ID,
    sessionId: SESSION_ID,
    timestamp: 1756227600000,
    appVersion: '1.1.0',
    platform: 'win32',
    arch: 'x64',
    type: 'session_summary',
    listeningSeconds: 1800,
    sessionSeconds: 3600,
    ...overrides
  }
}

test('accepts canonical uuid-shaped identifiers', () => {
  assert.equal(isTelemetryId(INSTALL_ID), true)
  assert.equal(isTelemetryId(INSTALL_ID.toUpperCase()), true)
  assert.equal(isTelemetryId('not-an-id'), false)
  assert.equal(isTelemetryId(''), false)
  assert.equal(isTelemetryId(42), false)
})

test('accepts well-formed app start and session summary events', () => {
  assert.equal(isTelemetryEvent(makeAppStart()), true)
  assert.equal(isTelemetryEvent(makeSessionSummary()), true)
})

test('rejects events with tampered identity, timing, or payload fields', () => {
  assert.equal(isTelemetryEvent(makeAppStart({ installId: 'spoofed' })), false)
  assert.equal(isTelemetryEvent(makeAppStart({ sessionId: '' })), false)
  assert.equal(isTelemetryEvent(makeAppStart({ schemaVersion: 99 as never })), false)
  assert.equal(isTelemetryEvent(makeAppStart({ timestamp: Number.NaN })), false)
  assert.equal(isTelemetryEvent(makeAppStart({ timestamp: -1 })), false)
  assert.equal(isTelemetryEvent(makeAppStart({ appVersion: '' })), false)
  assert.equal(isTelemetryEvent(makeAppStart({ type: 'unknown' as never })), false)
  assert.equal(isTelemetryEvent(makeSessionSummary({ listeningSeconds: -5 })), false)
  assert.equal(isTelemetryEvent(makeSessionSummary({ sessionSeconds: Number.NaN })), false)
  assert.equal(isTelemetryEvent(null), false)
})

test('batch request requires schema version and at least one valid event', () => {
  assert.equal(
    isTelemetryBatchRequest({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      events: [makeAppStart(), makeSessionSummary()]
    }),
    true
  )
  assert.equal(
    isTelemetryBatchRequest({ schemaVersion: TELEMETRY_SCHEMA_VERSION, events: [] }),
    false
  )
  assert.equal(isTelemetryBatchRequest({ schemaVersion: 2, events: [makeAppStart()] }), false)
  assert.equal(
    isTelemetryBatchRequest({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      events: [makeAppStart({ installId: 'spoofed' })]
    }),
    false
  )
})
