import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderWriteIdempotencyCoordinator } from './providerWriteIdempotency.ts'

test('provider write retries reuse one key until the logical write succeeds', () => {
  let nextKey = 0
  const coordinator = new ProviderWriteIdempotencyCoordinator({
    createKey: () => `write-${++nextKey}`
  })

  const first = coordinator.begin('ncm', 'likeTrack', [42, true])
  first.settle(false)
  const retry = coordinator.begin('ncm', 'likeTrack', [42, true])

  assert.equal(first.idempotencyKey, 'write-1')
  assert.equal(retry.idempotencyKey, 'write-1')
  retry.settle(true)

  const nextExplicitAction = coordinator.begin('ncm', 'likeTrack', [42, true])
  assert.equal(nextExplicitAction.idempotencyKey, 'write-2')
})

test('provider write keys do not collide across changed payloads or targets', () => {
  let nextKey = 0
  const coordinator = new ProviderWriteIdempotencyCoordinator({
    createKey: () => `write-${++nextKey}`
  })

  const like = coordinator.begin('ncm', 'likeTrack', [42, true])
  like.settle(false)
  const unlike = coordinator.begin('ncm', 'likeTrack', [42, false])
  const otherTrack = coordinator.begin('ncm', 'likeTrack', [43, true])
  const otherMethod = coordinator.begin('ncm', 'followArtist', [42, true])

  assert.deepEqual(
    [
      like.idempotencyKey,
      unlike.idempotencyKey,
      otherTrack.idempotencyKey,
      otherMethod.idempotencyKey
    ],
    ['write-1', 'write-2', 'write-3', 'write-4']
  )
})

test('explicit caller keys pass through and failed retry state expires within a bound', () => {
  let now = 0
  let nextKey = 0
  const coordinator = new ProviderWriteIdempotencyCoordinator({
    now: () => now,
    createKey: () => `write-${++nextKey}`,
    retryTtlMs: 100,
    maxEntries: 2
  })

  const explicit = coordinator.begin('ncm', 'likeTrack', [42, true], 'caller-owned')
  assert.equal(explicit.idempotencyKey, 'caller-owned')
  assert.equal(coordinator.size, 0)

  const first = coordinator.begin('ncm', 'likeTrack', [42, true])
  first.settle(false)
  now = 100
  const afterExpiry = coordinator.begin('ncm', 'likeTrack', [42, true])
  assert.notEqual(afterExpiry.idempotencyKey, first.idempotencyKey)
})

test('in-flight renderer write keys neither expire nor get evicted by the bounded registry', () => {
  let now = 0
  let nextKey = 0
  const coordinator = new ProviderWriteIdempotencyCoordinator({
    now: () => now,
    createKey: () => `write-${++nextKey}`,
    retryTtlMs: 100,
    maxEntries: 1
  })
  const first = coordinator.begin('ncm', 'likeTrack', [42, true])

  now = 1_000
  const concurrentRetry = coordinator.begin('ncm', 'likeTrack', [42, true])
  assert.equal(concurrentRetry.idempotencyKey, first.idempotencyKey)
  assert.throws(
    () => coordinator.begin('ncm', 'likeTrack', [43, true]),
    /registry is full of in-flight/
  )

  first.settle(false)
  concurrentRetry.settle(false)
  const otherTarget = coordinator.begin('ncm', 'likeTrack', [43, true])
  assert.notEqual(otherTarget.idempotencyKey, first.idempotencyKey)
})
