import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// node --test strip-only mode cannot load this module (TS parameter properties),
// so the wiring is pinned with source assertions instead — the same convention
// the renderer store tests use for cross-cutting internals.
const source = readFileSync(new URL('./providerDownloadManager.ts', import.meta.url), 'utf8')

function extractMethodBody(name: string): string {
  // Anchor at line start so call sites (`this.receiveFile(`) cannot win.
  const signature = new RegExp(`^\\s{2}(?:private |public )?(?:async )?${name}\\(`, 'm')
  const match = source.match(signature)
  assert.ok(match?.index != null, `${name} should exist`)
  const bodyStart = source.indexOf('{', match.index + match[0].length)
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) return source.slice(bodyStart + 1, index)
  }
  assert.fail(`${name} body should close`)
}

test('per-chunk download progress is throttled by interval or step', () => {
  assert.match(source, /const PROGRESS_EMIT_INTERVAL_MS = 250/)
  assert.match(source, /const PROGRESS_EMIT_STEP = 0\.01/)

  const receiveFile = extractMethodBody('receiveFile')
  // The transform callback must gate patch() on the throttle budget.
  assert.match(
    receiveFile,
    /nowMs - lastProgressEmitAt >= PROGRESS_EMIT_INTERVAL_MS \|\|[\s\S]*?nextProgress - lastProgressEmitValue >= PROGRESS_EMIT_STEP/
  )
  assert.match(receiveFile, /if \([\s\S]*?\) \{\s*lastProgressEmitAt = nowMs/)
  // Terminal completion still patches progress: 1 immediately, outside the throttle.
  assert.match(receiveFile, /status: 'completed',\s*progress: 1/)
})

test('terminal tasks are retained up to a bounded budget', () => {
  assert.match(source, /const TERMINAL_TASK_RETENTION = \d+/)

  const prune = extractMethodBody('pruneTerminalTasks')
  assert.match(prune, /TERMINAL_STATUSES\.has\(task\.status\)/)
  assert.match(prune, /this\.tasks\.delete\(taskId\)/)
  assert.match(prune, /terminalCount <= TERMINAL_TASK_RETENTION/)

  // Pruning fires both when a task reaches a terminal status and when a task
  // is created already terminal.
  const patch = extractMethodBody('patch')
  assert.match(patch, /TERMINAL_STATUSES\.has\(patch\.status\)\) this\.pruneTerminalTasks\(\)/)
  const create = extractMethodBody('create')
  assert.match(create, /TERMINAL_STATUSES\.has\(task\.status\)\) this\.pruneTerminalTasks\(\)/)
})

test('partial download artifacts are still cleaned up on failure', () => {
  const receiveFile = extractMethodBody('receiveFile')
  assert.match(receiveFile, /await rm\(partPath, \{ force: true \}\)\.catch\(\(\) => undefined\)/)
})
