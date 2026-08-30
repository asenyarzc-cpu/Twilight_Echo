import assert from 'node:assert/strict'
import test from 'node:test'

const {
  inspectJsonValueWithLimits,
  isJsonNestingWithinLimit,
  parseJsonWithNestingLimit,
  tryParseJsonWithNestingLimit
} = (await import(
  new URL('./jsonSafety.ts', import.meta.url).href
)) as typeof import('./jsonSafety')

function deeplyNestedJson(depth: number): string {
  return `${'['.repeat(depth)}0${']'.repeat(depth)}`
}

test('bounds untrusted JSON text without counting brackets in quoted strings', () => {
  assert.equal(isJsonNestingWithinLimit('{"message":"[[[]]]"}'), true)
  assert.equal(isJsonNestingWithinLimit(deeplyNestedJson(128)), false)

  assert.deepEqual(tryParseJsonWithNestingLimit('{"ok":true}'), {
    ok: true,
    value: { ok: true }
  })
  assert.deepEqual(tryParseJsonWithNestingLimit(deeplyNestedJson(128)), {
    ok: false,
    reason: 'too-deep'
  })
  assert.deepEqual(tryParseJsonWithNestingLimit('{broken'), {
    ok: false,
    reason: 'invalid'
  })
  assert.deepEqual(parseJsonWithNestingLimit('{"ok":true}'), { ok: true })
  assert.throws(() => parseJsonWithNestingLimit(deeplyNestedJson(128)), /too deeply nested/)
})

test('bounds in-memory JSON values before they cross a trust boundary', () => {
  assert.deepEqual(inspectJsonValueWithLimits({ ok: true, label: 'short' }, 1024), { ok: true })
  assert.deepEqual(inspectJsonValueWithLimits('x'.repeat(1024), 64), {
    ok: false,
    reason: 'too-large'
  })

  let nested: unknown = { leaf: true }
  for (let index = 0; index < 128; index += 1) nested = { child: nested }
  assert.deepEqual(inspectJsonValueWithLimits(nested, 1024 * 1024), {
    ok: false,
    reason: 'too-deep'
  })

  const circular: { self?: unknown } = {}
  circular.self = circular
  assert.deepEqual(inspectJsonValueWithLimits(circular, 1024), {
    ok: false,
    reason: 'invalid'
  })
  assert.deepEqual(inspectJsonValueWithLimits({ value: BigInt(1) }, 1024), {
    ok: false,
    reason: 'invalid'
  })
  assert.deepEqual(inspectJsonValueWithLimits({ text: '[[[]]]' }, 1024), { ok: true })

  for (const value of [undefined, () => undefined, Symbol('top-level')]) {
    assert.deepEqual(inspectJsonValueWithLimits(value, 1024), {
      ok: false,
      reason: 'invalid'
    })
  }
})
