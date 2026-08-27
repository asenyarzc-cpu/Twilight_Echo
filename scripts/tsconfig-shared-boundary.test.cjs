'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

function readConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'))
}

test('node and web composite projects explicitly include shared contracts', () => {
  for (const name of ['tsconfig.node.json', 'tsconfig.web.json']) {
    const config = readConfig(name)
    assert.equal(config.compilerOptions?.composite, true)
    assert.ok(config.include?.includes('src/shared/**/*'), `${name} must include src/shared/**/*`)
  }
})

test('web project includes the preload public types without exposing runtime modules', () => {
  const webConfig = readConfig('tsconfig.web.json')
  assert.ok(
    webConfig.include?.includes('src/preload/types.ts'),
    'tsconfig.web.json must include the preload type surface imported by renderer stores'
  )

  const preloadTypes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'preload', 'types.ts'),
    'utf8'
  )
  assert.doesNotMatch(
    preloadTypes,
    /from\s+['"](?:electron|node:|fs|path)['"]/,
    'preload types must not expose runtime modules to the renderer'
  )
  assert.doesNotMatch(
    preloadTypes,
    /import\s+(?!type\b)/,
    'preload types must only import type-only shared contracts'
  )
})
