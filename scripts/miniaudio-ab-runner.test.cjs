const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const runnerPath = path.join(__dirname, 'miniaudio-ab-runner.cjs')
const {
  FIXTURE_FAULTS,
  formatMatrixTimeoutMs,
  parseArgs,
  playbackDurationMs,
  probeProcessTimeoutMs,
  runCase,
  runSeries,
  writeArtifact
} = require('./miniaudio-ab-runner.cjs')

function withCase(document, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-miniaudio-ab-runner-'))
  try {
    const casePath = path.join(directory, 'case.json')
    fs.writeFileSync(casePath, JSON.stringify(document))
    return callback({ directory, casePath })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function baseCase(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'shared-wasapi-explicit-device',
    publicBackend: 'wasapi',
    platformStableDeviceId: '{0.0.0.00000000}.{stable-endpoint}',
    testInput: {
      fixture: 'silence.wav',
      durationMs: 1200,
      requestedFormat: { sampleFormat: 'float32', sampleRate: 48000, channels: 2 }
    },
    ...overrides
  }
}

function runFixtureCase(casePath) {
  return runCase({
    casePath,
    probe: runnerPath,
    probeArgs: ['--fixture-probe']
  })
}

test('miniaudio A/B runner isolates providers and preserves unknown conversion facts', () => {
  withCase(baseCase(), ({ casePath }) => {
    const artifact = runFixtureCase(casePath)

    assert.equal(artifact.kind, 'miniaudio-shared-pcm-ab')
    assert.equal(artifact.evidenceKind, 'software-only')
    assert.equal(artifact.case.publicBackend, 'wasapi')
    assert.equal(artifact.runs.legacy.providerImplementation, 'legacy-native')
    assert.equal(artifact.runs.miniaudio.providerImplementation, 'miniaudio')
    assert.equal(artifact.runs.miniaudio.miniaudioVersion, '0.11.25')
    assert.notEqual(
      artifact.runs.legacy.execution.processId,
      artifact.runs.miniaudio.execution.processId
    )
    assert.equal(artifact.runs.legacy.execution.providerControl, 'legacy')
    assert.equal(artifact.runs.miniaudio.execution.providerControl, 'miniaudio')
    assert.equal(artifact.runs.legacy.conversionInfo.sampleRateConverted, 'unknown')
    assert.equal(artifact.runs.miniaudio.conversionInfo.sampleRateConverted, false)
    assert.equal(artifact.runs.legacy.platformStableDeviceIdHash.length, 64)
    assert.equal(
      artifact.runs.legacy.platformStableDeviceIdHash,
      artifact.runs.miniaudio.platformStableDeviceIdHash
    )
    assert.equal(
      artifact.runs.legacy.actualDeviceIdHash,
      crypto.createHash('sha256').update(baseCase().platformStableDeviceId).digest('hex')
    )
    assert.equal(
      artifact.runs.legacy.actualDeviceIdHash,
      artifact.runs.miniaudio.actualDeviceIdHash
    )
    assert.equal(artifact.runs.legacy.testInputHash, artifact.runs.miniaudio.testInputHash)
    assert.equal(
      artifact.diff.some((item) => item.field === 'conversionInfo' && !item.equal),
      true
    )
  })
})

test('miniaudio A/B runner records stable results for software fault fixtures', () => {
  for (const [fault, expectedResult] of Object.entries(FIXTURE_FAULTS)) {
    withCase(baseCase({ fault, expectedResult }), ({ casePath }) => {
      const artifact = runFixtureCase(casePath)
      for (const run of Object.values(artifact.runs)) {
        assert.deepEqual(run.result, expectedResult, fault)
      }
      if (fault === 'device-lost') {
        assert.equal(artifact.runs.miniaudio.counters.deviceLostCount, 1)
        assert.equal(artifact.runs.miniaudio.counters.rerouteCount, 1)
      }
    })
  }
})

test('miniaudio A/B runner rejects mismatched provider, device hash, and timing facts', () => {
  const failures = [
    ['wrong-provider', /providerImplementation mismatch/],
    ['wrong-device-hash', /platformStableDeviceIdHash/],
    ['wrong-actual-device-id', /actualDeviceId/],
    ['invalid-duration', /openDurationMs/]
  ]
  for (const [fault, expectedError] of failures) {
    withCase(baseCase({ fault }), ({ casePath }) => {
      assert.throws(() => runFixtureCase(casePath), expectedError)
    })
  }
})

test('miniaudio A/B runner writes a separately hashable software-only artifact', () => {
  withCase(baseCase(), ({ casePath, directory }) => {
    const artifact = runFixtureCase(casePath)
    const outputPath = path.join(directory, 'artifact.json')
    const receipt = writeArtifact(artifact, outputPath)

    assert.equal(receipt.path, outputPath)
    assert.equal(
      receipt.sha256,
      crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex')
    )
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    assert.equal(written.evidenceKind, 'software-only')
    assert.equal(written.case.platformStableDeviceId, undefined)
  })
})

test('miniaudio A/B runner can repeat provider switches without a test-time delay', () => {
  withCase(baseCase(), ({ casePath }) => {
    const artifact = runSeries({
      casePath,
      probe: runnerPath,
      probeArgs: ['--fixture-probe'],
      iterations: 2
    })
    assert.equal(artifact.kind, 'miniaudio-shared-pcm-ab-series')
    assert.equal(artifact.iterations, 2)
    assert.equal(artifact.cases.length, 2)
    assert.equal(artifact.evidenceKind, 'software-only')
  })
})

test('miniaudio A/B runner gives documented long cases enough child-process time', () => {
  const caseDefinition = baseCase({
    testInput: {
      formatMatrixArgs: ['--manifest', 'fixtures/one.json', '--duration-ms', '14400000'],
      requestedFormat: { sampleFormat: 'float32', sampleRate: 48000, channels: 2 }
    }
  })

  assert.equal(playbackDurationMs(caseDefinition.testInput), 14400000)
  assert.equal(formatMatrixTimeoutMs(caseDefinition), 14430000)
  assert.equal(probeProcessTimeoutMs(caseDefinition), 14440000)
})

test('miniaudio A/B runner rejects ambiguous or invalid duration arguments before spawning', () => {
  const invalidCases = [
    baseCase({
      testInput: { formatMatrixArgs: ['--manifest', 'fixtures/one.json', '--duration-ms'] }
    }),
    baseCase({
      testInput: {
        formatMatrixArgs: [
          '--manifest',
          'fixtures/one.json',
          '--duration-ms',
          '1200',
          '--duration-ms',
          '1300'
        ]
      }
    })
  ]
  assert.throws(() => formatMatrixTimeoutMs(invalidCases[0]), /at least 100/)
  assert.throws(() => formatMatrixTimeoutMs(invalidCases[1]), /must not repeat/)
})

test('miniaudio A/B runner rejects ambiguous control inputs before spawning probes', () => {
  assert.throws(() => parseArgs([]), /Missing --case/)
  assert.throws(
    () => parseArgs(['--case', 'case.json', '--iterations', '0']),
    /between 1 and 100000/
  )
  withCase(baseCase({ publicBackend: 'wasapi-exclusive' }), ({ casePath }) => {
    assert.throws(() => runFixtureCase(casePath), /publicBackend="wasapi"/)
  })
  withCase(baseCase({ platformStableDeviceId: 'auto' }), ({ casePath }) => {
    assert.throws(() => runFixtureCase(casePath), /not auto/)
  })
})
