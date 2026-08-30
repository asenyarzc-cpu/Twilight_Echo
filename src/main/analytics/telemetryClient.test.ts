import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TELEMETRY_SCHEMA_VERSION } from '../../shared/telemetry.ts'
import { TelemetryClient, isAllowedTelemetryEndpoint } from './telemetryClient.ts'
import { startTelemetryMockServer } from './telemetryMockServer.ts'

const FIXED_INSTALL_ID = '11111111-2222-4333-8444-555555555555'
const FIXED_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PREEXISTING_SESSION_ID = 'cccccccc-dddd-4eee-8fff-000000000000'

interface ClientHarness {
  stateDir: string
  currentTime: number
  makeClient(overrides?: Partial<ConstructorParameters<typeof TelemetryClient>[0]>): TelemetryClient
  readQueueFile(): unknown[]
  cleanup(): void
}

function createHarness(): ClientHarness {
  const stateDir = mkdtempSync(join(tmpdir(), 'twilight-telemetry-'))
  const harness: ClientHarness = {
    stateDir,
    currentTime: 1_756_224_000_000,
    makeClient(overrides = {}) {
      // 构造顺序：首次调用生成 installId，第二次生成 sessionId。
      const ids = [FIXED_INSTALL_ID, FIXED_SESSION_ID]
      let idIndex = 0
      return new TelemetryClient({
        endpointUrl: '',
        stateDir,
        appVersion: '1.1.0',
        platform: 'win32',
        arch: 'x64',
        now: () => harness.currentTime,
        randomId: () => {
          const id = ids[idIndex] ?? ids[ids.length - 1]
          idIndex += 1
          return id
        },
        ...overrides
      })
    },
    readQueueFile() {
      try {
        return JSON.parse(readFileSync(join(stateDir, 'event-queue.json'), 'utf-8')) as unknown[]
      } catch {
        return []
      }
    },
    cleanup() {
      rmSync(stateDir, { recursive: true, force: true })
    }
  }
  return harness
}

test('install id is generated once and reused across sessions', () => {
  const harness = createHarness()
  try {
    const first = harness.makeClient()
    const second = harness.makeClient()
    assert.equal(first.getInstallId(), FIXED_INSTALL_ID)
    assert.equal(second.getInstallId(), FIXED_INSTALL_ID)
    const secondInstallId = '99999999-8888-4777-8666-555555555555'
    const reloaded = harness.makeClient({ randomId: () => secondInstallId })
    assert.equal(reloaded.getInstallId(), FIXED_INSTALL_ID)
  } finally {
    harness.cleanup()
  }
})

test('start queues an app start event with stable session identity', () => {
  const harness = createHarness()
  try {
    const client = harness.makeClient()
    client.start()
    const queue = harness.readQueueFile()
    assert.equal(queue.length, 1)
    const event = queue[0] as Record<string, unknown>
    assert.equal(event.type, 'app_start')
    assert.equal(event.installId, FIXED_INSTALL_ID)
    assert.equal(event.sessionId, FIXED_SESSION_ID)
    assert.equal(event.schemaVersion, TELEMETRY_SCHEMA_VERSION)
    client.dispose()
  } finally {
    harness.cleanup()
  }
})

test('listening seconds accumulate only while playback state is playing', () => {
  const harness = createHarness()
  try {
    const client = harness.makeClient()
    client.observePlayback({ state: 'playing' })
    harness.currentTime += 30_000
    client.observePlayback({ state: 'paused' })
    harness.currentTime += 60_000
    client.observePlayback({ state: 'playing' })
    harness.currentTime += 15_000
    client.observePlayback({ state: 'paused' })
    assert.equal(client.getListeningSeconds(), 45)
    void client.endSession()
    const queue = harness.readQueueFile()
    const summary = queue.find(
      (event) => (event as Record<string, unknown>).type === 'session_summary'
    ) as Record<string, unknown>
    assert.equal(summary.listeningSeconds, 45)
    assert.ok(typeof summary.sessionSeconds === 'number' && summary.sessionSeconds >= 45)
  } finally {
    harness.cleanup()
  }
})

test('endSession skips a session summary when nothing was listened', () => {
  const harness = createHarness()
  try {
    const client = harness.makeClient()
    void client.endSession()
    const queue = harness.readQueueFile()
    assert.equal(
      queue.some((event) => (event as Record<string, unknown>).type === 'session_summary'),
      false
    )
  } finally {
    harness.cleanup()
  }
})

test('clock anomalies are capped per playing segment', () => {
  const harness = createHarness()
  try {
    const client = harness.makeClient()
    client.observePlayback({ state: 'playing' })
    harness.currentTime += 30 * 3600 * 1000
    client.observePlayback({ state: 'stopped' })
    assert.equal(client.getListeningSeconds(), 8 * 3600)
    client.observePlayback({ state: 'playing' })
    harness.currentTime -= 60_000
    client.observePlayback({ state: 'paused' })
    assert.equal(client.getListeningSeconds(), 8 * 3600)
    client.dispose()
  } finally {
    harness.cleanup()
  }
})

test('checkpoint emits cumulative snapshots only when listening time has grown', () => {
  const harness = createHarness()
  try {
    const client = harness.makeClient()
    client.observePlayback({ state: 'playing' })
    harness.currentTime += 30_000
    client.observePlayback({ state: 'paused' })

    client.checkpoint()
    const readSummaries = () =>
      harness
        .readQueueFile()
        .filter((event) => (event as Record<string, unknown>).type === 'session_summary') as Array<
        Record<string, unknown>
      >
    const summaries = readSummaries()
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].listeningSeconds, 30)
    assert.ok(typeof summaries[0].sessionSeconds === 'number' && summaries[0].sessionSeconds >= 30)

    harness.currentTime += 10 * 60_000
    client.checkpoint()
    assert.equal(readSummaries().length, 1)
    assert.equal(client.getQueuedEventCount(), 1)
    client.dispose()
  } finally {
    harness.cleanup()
  }
})

test('endSession only reports listening time not already covered by a checkpoint', () => {
  const harness = createHarness()
  try {
    const client = harness.makeClient()
    client.observePlayback({ state: 'playing' })
    harness.currentTime += 30_000
    client.observePlayback({ state: 'paused' })
    void client.checkpoint()
    client.observePlayback({ state: 'playing' })
    harness.currentTime += 15_000
    client.observePlayback({ state: 'paused' })
    void client.endSession()

    const summaries = harness
      .readQueueFile()
      .filter((event) => (event as Record<string, unknown>).type === 'session_summary') as Array<
      Record<string, unknown>
    >
    assert.deepEqual(
      summaries.map((event) => event.listeningSeconds),
      [30, 45]
    )
    assert.equal(client.getQueuedEventCount(), 2)
  } finally {
    harness.cleanup()
  }
})

test('start schedules periodic checkpoints while playing', async () => {
  const harness = createHarness()
  const server = await startTelemetryMockServer(0)
  try {
    const wallStart = Date.now()
    const clockStart = 1_756_224_000_000
    const client = harness.makeClient({
      endpointUrl: server.url,
      checkpointIntervalMs: 10,
      // 假时钟按 1000 倍速推进，保证 10ms 间隔内能累计出非零的整秒数。
      now: () => clockStart + (Date.now() - wallStart) * 1000
    })
    client.start()
    client.observePlayback({ state: 'playing' })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
    client.dispose()

    const delivered = server.received.flatMap((batch) => batch.events)
    assert.equal(
      delivered.some((event) => event.type === 'app_start'),
      true
    )
    const checkpoints = delivered.filter((event) => event.type === 'session_summary')
    assert.ok(checkpoints.length >= 1)
    assert.ok(checkpoints[0].listeningSeconds > 0)
  } finally {
    await server.close()
    harness.cleanup()
  }
})

test('events survive an offline session and deliver to a live endpoint end to end', async () => {
  const harness = createHarness()
  const server = await startTelemetryMockServer(0)
  try {
    const offline = harness.makeClient()
    offline.start()
    offline.observePlayback({ state: 'playing' })
    harness.currentTime += 120_000
    await offline.endSession()
    assert.equal(offline.getQueuedEventCount(), 2)
    assert.equal(server.received.length, 0)

    const online = harness.makeClient({
      endpointUrl: server.url
    })
    assert.equal(online.getQueuedEventCount(), 2)
    const delivered = await online.flush()
    assert.equal(delivered, true)
    assert.equal(online.getQueuedEventCount(), 0)

    const events = server.received.flatMap((batch) => batch.events)
    assert.deepEqual(
      events.map((event) => event.type),
      ['app_start', 'session_summary']
    )
    const summary = events.find((event) => event.type === 'session_summary')
    assert.ok(summary && summary.type === 'session_summary')
    assert.equal(summary.listeningSeconds, 120)
    assert.equal(summary.installId, FIXED_INSTALL_ID)
    assert.equal(harness.readQueueFile().length, 0)
    online.dispose()
  } finally {
    await server.close()
    harness.cleanup()
  }
})

test('failed deliveries keep the queue intact for the next attempt', async () => {
  const harness = createHarness()
  try {
    const client = harness.makeClient({
      endpointUrl: 'http://127.0.0.1:1/v1/events',
      requestTimeoutMs: 2000
    })
    client.start()
    assert.equal(client.getQueuedEventCount(), 1)
    assert.equal(await client.flush(), false)
    assert.equal(client.getQueuedEventCount(), 1)
    assert.equal(harness.readQueueFile().length, 1)
    client.dispose()
  } finally {
    harness.cleanup()
  }
})

test('endpoint policy allows https and localhost http only', async () => {
  assert.equal(isAllowedTelemetryEndpoint('https://telemetry.example.com/v1/events'), true)
  assert.equal(isAllowedTelemetryEndpoint('http://localhost:8787/v1/events'), true)
  assert.equal(isAllowedTelemetryEndpoint('http://127.0.0.1:8787/v1/events'), true)
  assert.equal(isAllowedTelemetryEndpoint('http://telemetry.example.com/v1/events'), false)
  assert.equal(isAllowedTelemetryEndpoint('ftp://example.com'), false)
  assert.equal(isAllowedTelemetryEndpoint('not a url'), false)

  const harness = createHarness()
  try {
    let fetchCalls = 0
    const client = harness.makeClient({
      endpointUrl: 'http://telemetry.example.com/v1/events',
      fetchImpl: (async () => {
        fetchCalls += 1
        return new Response(null, { status: 200 })
      }) as typeof fetch
    })
    client.start()
    assert.equal(await client.flush(), false)
    assert.equal(fetchCalls, 0)
    assert.equal(client.getQueuedEventCount(), 1)
    client.dispose()
  } finally {
    harness.cleanup()
  }
})

test('queued events are capped to the newest entries on load', () => {
  const harness = createHarness()
  try {
    const events = Array.from({ length: 5 }, (_, index) => ({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      installId: FIXED_INSTALL_ID,
      sessionId: PREEXISTING_SESSION_ID,
      timestamp: 1_756_224_000_000 + index,
      appVersion: '1.1.0',
      platform: 'win32',
      arch: 'x64',
      type: 'app_start'
    }))
    mkdirSync(harness.stateDir, { recursive: true })
    writeFileSync(join(harness.stateDir, 'event-queue.json'), JSON.stringify(events), 'utf-8')
    const client = harness.makeClient({
      maxQueuedEvents: 2
    })
    assert.equal(client.getQueuedEventCount(), 2)
    client.dispose()
  } finally {
    harness.cleanup()
  }
})

test('mock server validates the batch contract and records accepted events', async () => {
  const server = await startTelemetryMockServer(0)
  try {
    const rejected = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: TELEMETRY_SCHEMA_VERSION, events: [] })
    })
    assert.equal(rejected.status, 400)

    const accepted = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        events: [
          {
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            installId: FIXED_INSTALL_ID,
            sessionId: FIXED_SESSION_ID,
            timestamp: 1_756_224_000_000,
            appVersion: '1.1.0',
            platform: 'win32',
            arch: 'x64',
            type: 'app_start'
          }
        ]
      })
    })
    assert.equal(accepted.status, 200)
    assert.equal(server.received.length, 1)
    assert.equal(server.received[0].events.length, 1)
  } finally {
    await server.close()
  }
})
