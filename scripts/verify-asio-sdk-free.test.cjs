const assert = require('node:assert/strict')
const test = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const {
  FORBIDDEN_CONTENT,
  FORBIDDEN_PATHS,
  IGNORED_DIRECTORIES
} = require('./verify-asio-sdk-free.cjs')

test('ASIO SDK removal gate catches SDK paths and includes without matching internal compatibility headers', () => {
  assert.equal(
    FORBIDDEN_PATHS.some((pattern) =>
      pattern.test('audio-engine/third_party/ASIOSDK/common/asio.h')
    ),
    true
  )
  assert.equal(
    FORBIDDEN_PATHS.some((pattern) => pattern.test('audio-engine/output/asio/abi/AsioAbi.h')),
    false
  )
  assert.equal(
    FORBIDDEN_CONTENT.some((pattern) => pattern.test('#include "asiosys.h"')),
    true
  )
  assert.equal(
    FORBIDDEN_CONTENT.some((pattern) => pattern.test('#include "AsioAbi.h"')),
    false
  )
})

test('ASIO SDK removal gate ignores WorkBuddy project data and generated directories', () => {
  assert.equal(IGNORED_DIRECTORIES.has('.workbuddy'), true)
  assert.equal(IGNORED_DIRECTORIES.has('node_modules'), true)
  assert.equal(IGNORED_DIRECTORIES.has('build'), true)
})

test('Windows x64 ASIO runtime is enabled by default with an explicit opt-out', () => {
  const source = readFileSync(
    join(__dirname, '..', 'audio-engine', 'output', 'asio', 'RealAsioHost.cpp'),
    'utf8'
  )

  assert.match(source, /std::getenv\("TWILIGHT_DISABLE_ASIO"\)/)
  assert.match(source, /return !value \|\| std::string_view\(value\) != "1";/)
  assert.doesNotMatch(source, /TWILIGHT_EXPERIMENTAL_ASIO_ABI/)
  assert.match(source, /if \(!asioEnabled\(\)\) return \{\};/)
  assert.match(source, /ASIO backend is disabled by TWILIGHT_DISABLE_ASIO=1/)
})

test('ASIO device catalog exports a user-facing label instead of exposing only the CLSID id', () => {
  const source = readFileSync(
    join(__dirname, '..', 'audio-engine', 'output', 'asio', 'AsioHostQueries.cpp'),
    'utf8'
  )

  assert.match(source, /\\"label\\":\\"/)
  assert.match(source, /jsonEscape\(device\.name\)/)
})
