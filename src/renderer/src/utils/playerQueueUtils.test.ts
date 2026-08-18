import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shuffleArray } from './playerQueueUtils.ts'

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

test('shuffleArray returns a permutation and leaves the input unchanged', () => {
  const input = Array.from({ length: 50 }, (_, index) => index)
  const original = [...input]
  for (let i = 0; i < 200; i++) {
    const result = shuffleArray(input)
    assert.equal(result.length, input.length)
    assert.deepEqual(sorted(result), sorted(original))
  }
  assert.deepEqual(input, original)
})
