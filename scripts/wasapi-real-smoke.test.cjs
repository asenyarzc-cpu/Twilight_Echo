const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  cleanupTempDir,
  parseArgs,
  staticFormatMatrix,
  workerTimeoutMs
} = require('./wasapi-real-smoke.cjs')

test('cleanupTempDir removes a smoke probe directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-wasapi-test-'))
  fs.writeFileSync(path.join(directory, 'probe.wav'), Buffer.alloc(1))

  cleanupTempDir(directory)

  assert.equal(fs.existsSync(directory), false)
})

test('worker timeout includes every requested matrix probe', () => {
  const options = parseArgs(['--device', 'test', '--duration-ms', '1000', '--format-matrix'])

  assert.equal(
    workerTimeoutMs(options),
    Math.max(30000, (2 + 1 + staticFormatMatrix().length) * 1000 + 10000)
  )
})
