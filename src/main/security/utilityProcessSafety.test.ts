import assert from 'node:assert/strict'
import test from 'node:test'

const {
  MAX_UTILITY_PROCESS_ERROR_TEXT_BYTES,
  MAX_UTILITY_PROCESS_REQUEST_ID_BYTES,
  UtilityProcessLogBudget,
  asUtilityProcessMessageRecord,
  inspectUtilityProcessMessage,
  inspectUtilityProcessPayload,
  isBoundedUtf8String,
  parseUtilityProcessResponse
} = (await import(
  new URL('./utilityProcessSafety.ts', import.meta.url).href
)) as typeof import('./utilityProcessSafety')

test('accepts only ordinary utility-process message records', () => {
  assert.deepEqual(asUtilityProcessMessageRecord({ kind: 'response' }), { kind: 'response' })
  assert.deepEqual(asUtilityProcessMessageRecord(Object.create(null)), Object.create(null))
  assert.equal(asUtilityProcessMessageRecord(null), null)
  assert.equal(asUtilityProcessMessageRecord([]), null)
  assert.equal(asUtilityProcessMessageRecord(new Date()), null)
  assert.equal(
    asUtilityProcessMessageRecord(
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('blocked')
          }
        }
      )
    ),
    null
  )
})

test('bounds UTF-8 fields and JSON-compatible utility-process messages', () => {
  assert.equal(isBoundedUtf8String('你好', 6), true)
  assert.equal(isBoundedUtf8String('你好', 5), false)
  assert.equal(isBoundedUtf8String('ok', -1), false)

  assert.deepEqual(inspectUtilityProcessMessage({ kind: 'ready' }, 1024), { ok: true })
  assert.deepEqual(inspectUtilityProcessMessage(undefined, 1024), {
    ok: false,
    reason: 'invalid'
  })
  assert.deepEqual(inspectUtilityProcessMessage({ data: 'x'.repeat(1024) }, 32), {
    ok: false,
    reason: 'too-large'
  })

  assert.deepEqual(inspectUtilityProcessPayload(undefined, 0), { ok: true })
  assert.deepEqual(
    inspectUtilityProcessPayload(() => undefined, 1024),
    {
      ok: false,
      reason: 'invalid'
    }
  )
})

test('parses only bounded response envelopes', () => {
  const valid = {
    kind: 'response',
    requestId: 'request-1',
    ok: true,
    value: { active: true }
  }
  assert.deepEqual(parseUtilityProcessResponse(valid), {
    ok: true,
    response: {
      requestId: 'request-1',
      ok: true,
      value: { active: true }
    }
  })

  assert.deepEqual(parseUtilityProcessResponse({ ...valid, requestId: '' }), {
    ok: false,
    reason: 'invalid-envelope'
  })
  assert.deepEqual(
    parseUtilityProcessResponse({
      ...valid,
      requestId: 'x'.repeat(MAX_UTILITY_PROCESS_REQUEST_ID_BYTES + 1)
    }),
    { ok: false, reason: 'invalid-envelope' }
  )
  assert.deepEqual(
    parseUtilityProcessResponse({
      ...valid,
      error: 'x'.repeat(MAX_UTILITY_PROCESS_ERROR_TEXT_BYTES + 1)
    }),
    { ok: false, reason: 'invalid-error' }
  )
  assert.deepEqual(parseUtilityProcessResponse({ ...valid, kind: 'fatal' }), {
    ok: false,
    reason: 'invalid-envelope'
  })
})

test('bounds utility-process logs and rejects invalid budgets', () => {
  assert.throws(() => new UtilityProcessLogBudget(-1, 3), RangeError)
  assert.throws(() => new UtilityProcessLogBudget(3, Number.NaN), RangeError)

  const budget = new UtilityProcessLogBudget(5, 3)
  assert.deepEqual(budget.capture(Buffer.from('abcdef')), {
    text: 'abc',
    notice: '[utility process output truncated]'
  })
  assert.deepEqual(budget.capture(Buffer.from('1234')), { text: '12', notice: null })
  assert.deepEqual(budget.capture(Buffer.from('z')), { text: null, notice: null })

  budget.reset()
  assert.deepEqual(budget.capture(Buffer.from('wxyz')), {
    text: 'wxy',
    notice: '[utility process output truncated]'
  })
})
