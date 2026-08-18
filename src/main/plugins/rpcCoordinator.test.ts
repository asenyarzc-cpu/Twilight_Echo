import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeInternalNcmRequestOptions,
  PluginRpcCoordinator,
  resolveProviderIdempotencyKey
} from './rpcCoordinator.ts'

function request(
  coordinator: PluginRpcCoordinator,
  requestId: string,
  options: {
    timeoutMs?: number
    dispatches?: string[]
    cancellations?: string[]
    signal?: AbortSignal
    idempotency?: { scope: string; key: string; fingerprint: string }
  } = {}
): Promise<string> {
  return coordinator.request<string, { requestId: string }>({
    requestId,
    pluginId: 'com.example.provider',
    kind: 'provider',
    timeoutMs: options.timeoutMs ?? 10_000,
    metadata: { requestId },
    dispatch: () => options.dispatches?.push(requestId),
    cancel: (reason) => options.cancellations?.push(`${requestId}:${reason}`),
    signal: options.signal,
    idempotency: options.idempotency
  })
}

test('plugin lifecycle cancellation rejects active RPCs immediately and quarantines their results', async () => {
  const coordinator = new PluginRpcCoordinator()
  const dispatches: string[] = []
  const cancellations: string[] = []
  const pending = request(coordinator, 'provider-1', { dispatches, cancellations })

  assert.deepEqual(dispatches, ['provider-1'])
  assert.equal(coordinator.getPendingCount('com.example.provider'), 1)
  assert.equal(coordinator.cancelPlugin('com.example.provider', 'Plugin was disabled.'), 1)

  await assert.rejects(pending, /disabled/)
  assert.equal(cancellations.length, 1)
  assert.equal(coordinator.getPendingCount('com.example.provider'), 0)
  assert.deepEqual(
    coordinator.complete('com.example.provider', 'provider-1', { ok: true, value: 'late result' }),
    { status: 'late' }
  )
})

test('external abort cancels active and queued RPC work promptly', async () => {
  const coordinator = new PluginRpcCoordinator({ maxConcurrencyPerPlugin: 1 })
  const cancellations: string[] = []
  const activeController = new AbortController()
  const queuedController = new AbortController()
  const active = request(coordinator, 'abort-active', {
    cancellations,
    signal: activeController.signal
  })
  const queued = request(coordinator, 'abort-queued', {
    cancellations,
    signal: queuedController.signal
  })

  queuedController.abort(new Error('queued cancelled'))
  await assert.rejects(queued, /queued cancelled/)
  assert.deepEqual(cancellations, [])

  activeController.abort(new Error('active cancelled'))
  await assert.rejects(active, /active cancelled/)
  assert.equal(cancellations.length, 1)
  assert.match(cancellations[0], /abort-active:active cancelled/)
  assert.equal(coordinator.getPendingCount('com.example.provider'), 0)
  assert.deepEqual(
    coordinator.complete('com.example.provider', 'abort-active', { ok: true, value: 'late' }),
    { status: 'late' }
  )
})

test('an already aborted signal prevents RPC dispatch', async () => {
  const coordinator = new PluginRpcCoordinator()
  const dispatches: string[] = []
  const controller = new AbortController()
  controller.abort(new Error('cancel before request'))
  await assert.rejects(
    request(coordinator, 'already-aborted', { dispatches, signal: controller.signal }),
    /cancel before request/
  )
  assert.deepEqual(dispatches, [])
})

test('a timed out RPC sends cancellation and late success cannot settle a newer state', async () => {
  const coordinator = new PluginRpcCoordinator({ lateResultTtlMs: 1_000 })
  const cancellations: string[] = []
  const pending = request(coordinator, 'provider-timeout', { timeoutMs: 10, cancellations })

  await assert.rejects(pending, /timed out/)
  assert.equal(cancellations.length, 1)
  assert.deepEqual(
    coordinator.complete('com.example.provider', 'provider-timeout', {
      ok: true,
      value: 'too late'
    }),
    { status: 'late' }
  )
  assert.equal(coordinator.getLateResultCount(), 1)
  await assert.rejects(
    () => request(coordinator, 'provider-timeout'),
    /quarantined after a prior settlement/
  )
})

test('per-plugin concurrency, bounded queue, and circuit backoff prevent overload storms', async () => {
  let now = 0
  const coordinator = new PluginRpcCoordinator({
    maxConcurrencyPerPlugin: 1,
    maxQueuePerPlugin: 1,
    circuitFailureThreshold: 1,
    circuitInitialBackoffMs: 100,
    circuitMaxBackoffMs: 400,
    now: () => now
  })
  const dispatches: string[] = []
  const first = request(coordinator, 'first', { dispatches })
  const queued = request(coordinator, 'queued', { dispatches })

  await assert.rejects(() => request(coordinator, 'overflow', { dispatches }), /queue is full/)
  const firstRejected = assert.rejects(first, /first failed/)
  const queuedRejected = assert.rejects(queued, /circuit is open/)
  coordinator.complete('com.example.provider', 'first', { ok: false, error: 'first failed' })
  await firstRejected
  await queuedRejected
  assert.deepEqual(dispatches, ['first'])

  await assert.rejects(() => request(coordinator, 'blocked', { dispatches }), /circuit is open/)

  now = 100
  const probe = request(coordinator, 'probe', { dispatches })
  await assert.rejects(() => request(coordinator, 'while-probing', { dispatches }), /half-open/)
  coordinator.complete('com.example.provider', 'probe', { ok: true, value: 'recovered' })
  await assert.doesNotReject(probe)

  const recovered = request(coordinator, 'recovered', { dispatches })
  coordinator.complete('com.example.provider', 'recovered', { ok: true, value: 'healthy' })
  assert.equal(await recovered, 'healthy')
  assert.deepEqual(dispatches, ['first', 'probe', 'recovered'])
})

test('idempotency keys coalesce repeated write attempts and reject payload reuse', async () => {
  const coordinator = new PluginRpcCoordinator()
  const dispatches: string[] = []
  const idempotency = {
    scope: 'com.example.provider:example:likeTrack',
    key: 'like-42',
    fingerprint: '[42,true]'
  }
  const first = request(coordinator, 'write-1', { dispatches, idempotency })
  const retry = request(coordinator, 'write-2', { dispatches, idempotency })

  assert.strictEqual(retry, first)
  assert.deepEqual(dispatches, ['write-1'])
  coordinator.complete('com.example.provider', 'write-1', { ok: true, value: 'liked' })
  assert.equal(await first, 'liked')
  assert.equal(await retry, 'liked')

  const replay = request(coordinator, 'write-3', { dispatches, idempotency })
  assert.strictEqual(replay, first)
  assert.equal(await replay, 'liked')
  assert.deepEqual(dispatches, ['write-1'])

  await assert.rejects(
    () =>
      request(coordinator, 'write-conflict', {
        dispatches,
        idempotency: { ...idempotency, fingerprint: '[42,false]' }
      }),
    /different request payload/
  )
})

test('an unknown timeout outcome retries with the same key instead of replaying the rejection', async () => {
  const coordinator = new PluginRpcCoordinator()
  const dispatches: string[] = []
  const idempotency = {
    scope: 'com.example.provider:example:likeTrack',
    key: 'like-timeout-42',
    fingerprint: '[42,true]'
  }
  const first = request(coordinator, 'write-timeout-1', {
    dispatches,
    timeoutMs: 10,
    idempotency
  })
  await assert.rejects(first, /timed out/)

  const retry = request(coordinator, 'write-timeout-2', { dispatches, idempotency })
  assert.notStrictEqual(retry, first)
  assert.deepEqual(dispatches, ['write-timeout-1', 'write-timeout-2'])
  coordinator.complete('com.example.provider', 'write-timeout-2', {
    ok: true,
    value: 'liked once'
  })
  assert.equal(await retry, 'liked once')
})

test('resolves provider write idempotency keys and validates supplied keys', () => {
  assert.equal(resolveProviderIdempotencyKey('likeTrack', ' key-1 '), 'key-1')
  assert.match(
    resolveProviderIdempotencyKey('createDownload', undefined) as string,
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
  )
  assert.equal(resolveProviderIdempotencyKey('getPlaybackUrl', 'ignored'), undefined)
  assert.throws(() => resolveProviderIdempotencyKey('likeTrack', 'bad key'), /invalid/)
})

test('normalizes built-in NCM request idempotency options', () => {
  assert.deepEqual(normalizeInternalNcmRequestOptions(undefined), {})
  assert.deepEqual(normalizeInternalNcmRequestOptions({ idempotencyKey: 'retry-1' }), {
    idempotencyKey: 'retry-1'
  })
  assert.throws(() => normalizeInternalNcmRequestOptions([]), /必须是对象/)
  assert.throws(() => normalizeInternalNcmRequestOptions({ other: true }), /不支持的字段/)
  assert.throws(() => normalizeInternalNcmRequestOptions({ idempotencyKey: 'bad key' }), /无效/)
  assert.throws(() => normalizeInternalNcmRequestOptions({ idempotencyKey: ' retry-1 ' }), /无效/)
})

test('in-flight idempotency records do not expire or get evicted before their outcome is known', async () => {
  let now = 0
  const coordinator = new PluginRpcCoordinator({
    idempotencyTtlMs: 100,
    maxIdempotencyRecords: 1,
    now: () => now
  })
  const dispatches: string[] = []
  const idempotency = {
    scope: 'com.example.provider:example:likeTrack',
    key: 'like-42',
    fingerprint: '[42,true]'
  }
  const first = request(coordinator, 'write-pending', { dispatches, idempotency })

  now = 1_000
  const retry = request(coordinator, 'write-pending-retry', { dispatches, idempotency })
  assert.strictEqual(retry, first)
  assert.deepEqual(dispatches, ['write-pending'])
  await assert.rejects(
    () =>
      request(coordinator, 'other-write', {
        idempotency: {
          scope: 'com.example.provider:example:followArtist',
          key: 'follow-7',
          fingerprint: '[7,true]'
        }
      }),
    /registry is full of in-flight/
  )

  coordinator.complete('com.example.provider', 'write-pending', { ok: true, value: 'liked' })
  assert.equal(await first, 'liked')
  assert.equal(await retry, 'liked')
})
