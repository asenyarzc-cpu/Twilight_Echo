const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createMinimalPe } = require('./pe-fixture.cjs')
const {
  SMTC_RUNTIME_FILE,
  SMTC_SOURCE_FILES,
  selfTestStagedSmtc,
  stagedSmtcFile
} = require('./prepare-smtc-msvc.cjs')

test('staged SMTC reuse is rejected when native sources are newer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-smtc-staging-'))
  try {
    const nativeDir = path.join(root, 'resources', 'audio-engine')
    fs.mkdirSync(nativeDir, { recursive: true })
    const staged = path.join(nativeDir, SMTC_RUNTIME_FILE)
    fs.writeFileSync(staged, createMinimalPe())
    const oldTime = new Date(Date.now() - 10_000)
    fs.utimesSync(staged, oldTime, oldTime)

    for (const relativePath of SMTC_SOURCE_FILES) {
      const source = path.join(root, relativePath)
      fs.mkdirSync(path.dirname(source), { recursive: true })
      fs.writeFileSync(source, 'source')
    }

    const result = stagedSmtcFile(root)
    assert.equal(result.stale, true)
    assert.equal(result.complete, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('staged SMTC self-test validates the expected N-API surface', () => {
  assert.doesNotThrow(() =>
    selfTestStagedSmtc('fixture.node', () => ({
      Create() {},
      Update() {},
      Destroy() {},
      SelfTest: () => true
    }))
  )
  assert.throws(
    () => selfTestStagedSmtc('fixture.node', () => ({ SelfTest: () => true })),
    /failed its N-API self-test/
  )
})
