import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./lyricsLoaderController.ts', import.meta.url), 'utf8')

function extractInternalFunctionBody(sourceText: string, functionName: string): string {
  const signature = new RegExp(
    `function ${functionName}(?:<[^>]*>)?\\([^)]*\\)[:\\w\\s<>\\[\\]'|]*\\s*\\{`
  )
  const match = sourceText.match(signature)
  assert.ok(match?.index != null, `${functionName} function should exist`)
  const bodyStart = match.index + match[0].length - 1

  let depth = 0
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) return sourceText.slice(bodyStart + 1, index)
  }
  assert.fail(`${functionName} body should close`)
}

test('lyrics loader baselines and counters stay bounded with an explicit limit', () => {
  assert.match(source, /const AUTOMATIC_LYRICS_BASELINE_LIMIT = \d+/)
  assert.match(source, /const LYRICS_TRACK_COUNTER_LIMIT = \d+/)

  const prune = extractInternalFunctionBody(source, 'pruneLyricsTrackMemory')
  assert.match(
    prune,
    /pruneMapToLimit\(automaticLyricsBaselines, activeTrackId, AUTOMATIC_LYRICS_BASELINE_LIMIT\)/
  )
  assert.match(
    prune,
    /pruneMapToLimit\(lyricsLoadGenerationByTrackId, activeTrackId, LYRICS_TRACK_COUNTER_LIMIT\)/
  )
  assert.match(
    prune,
    /pruneMapToLimit\(lyricsRetryAttemptsByTrackId, activeTrackId, LYRICS_TRACK_COUNTER_LIMIT\)/
  )
})

test('pruning runs on every track change and never evicts the active track entry', () => {
  const onTrackChanged = extractInternalFunctionBody(source, 'onTrackChanged')
  assert.match(onTrackChanged, /pruneLyricsTrackMemory\(trackId\)/)

  const pruneMap = extractInternalFunctionBody(source, 'pruneMapToLimit')
  assert.match(pruneMap, /if \(key === activeTrackId\) continue/)
  // Eviction must stop as soon as the map is within budget.
  assert.match(pruneMap, /if \(map\.size <= limit\) break/)
})

test('baseline restore path stays wired through the bounded map', () => {
  assert.match(source, /automaticLyricsBaselines\.get\(triggerTrack\.id\)/)
  assert.match(
    source,
    /automaticLyricsBaselines\.set\(triggerTrack\.id, \{ \.\.\.triggerTrack \}\)/
  )
  const clear = extractInternalFunctionBody(source, 'clearLyricsBaselines')
  assert.match(clear, /automaticLyricsBaselines\.clear\(\)/)
})
