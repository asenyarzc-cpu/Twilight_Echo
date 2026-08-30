import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Electron sandboxed preload scripts can only require the polyfilled
// `electron` module plus a small set of Node builtins. Importing anything
// else (for example node:crypto) fails the whole preload at runtime, which
// leaves window.api undefined and blanks the renderer.
const ALLOWED_SANDBOX_NODE_BUILTINS = new Set(['events', 'timers', 'url'])

const COMMON_NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib'
])

function collectNodeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /from\s+['"]node:([^'"]+)['"]/g,
    /require\(['"]node:([^'"]+)['"]\)/g,
    /import\s*\(\s*['"]node:([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

function collectBareBuiltinSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/from\s+['"]([^'"./][^'"]*)['"]/g)) {
    const specifier = match[1]
    if (COMMON_NODE_BUILTINS.has(specifier)) specifiers.push(specifier)
  }
  for (const match of source.matchAll(/require\(['"]([^'"])['"]\)/g)) {
    const specifier = match[1]
    if (COMMON_NODE_BUILTINS.has(specifier)) specifiers.push(specifier)
  }
  return specifiers
}

test('sandboxed preload only imports Node builtins supported by the sandbox', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const banned = [...collectNodeSpecifiers(source), ...collectBareBuiltinSpecifiers(source)].filter(
    (name) => !ALLOWED_SANDBOX_NODE_BUILTINS.has(name)
  )

  assert.deepEqual(
    banned,
    [],
    `sandboxed preload imports Node builtins that Electron cannot load: ${banned.join(', ')}`
  )
})
