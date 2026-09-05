const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildMatrixArgs,
  formatMatrixTimeoutMs,
  normalizeSummary
} = require('./miniaudio-ab-format-matrix-probe.cjs')

test('miniaudio A/B format-matrix adapter owns backend and stable device arguments', () => {
  const args = buildMatrixArgs(
    {
      testInput: { formatMatrixArgs: ['--manifest', 'fixtures/one.json', '--duration-ms', '100'] }
    },
    '{0.0.0.00000000}.{endpoint}'
  )
  assert.deepEqual(args, [
    '--manifest',
    'fixtures/one.json',
    '--duration-ms',
    '100',
    '--playback',
    '--backend',
    'wasapi',
    '--device',
    '{0.0.0.00000000}.{endpoint}',
    '--json'
  ])
})

test('miniaudio A/B format-matrix adapter rejects caller attempts to split A/B inputs', () => {
  assert.throws(
    () =>
      buildMatrixArgs(
        {
          testInput: { formatMatrixArgs: ['--manifest', 'fixtures/one.json', '--device', 'other'] }
        },
        'endpoint'
      ),
    /must not override --backend, --device, --json, or --worker/
  )
})

test('miniaudio A/B format-matrix adapter preserves a runner-derived long timeout', () => {
  assert.equal(formatMatrixTimeoutMs('14430000'), 14430000)
  assert.equal(formatMatrixTimeoutMs('invalid'), 60000)
})

test('miniaudio A/B format-matrix adapter forwards the backend-reported actual device id', () => {
  const originalStableId = process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID
  const originalStableIdHash = process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID_HASH
  const originalTestInputHash = process.env.TAE_AUDIO_AB_TEST_INPUT_HASH
  process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID = 'endpoint-a'
  process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID_HASH = 'a'.repeat(64)
  process.env.TAE_AUDIO_AB_TEST_INPUT_HASH = 'b'.repeat(64)
  try {
    const normalized = normalizeSummary(
      {
        playback: true,
        options: { backend: 'wasapi' },
        device: { id: 'endpoint-a' },
        results: [
          {
            ok: true,
            selected: {},
            playback: {
              info: {
                providerImplementation: 'miniaudio',
                actualDeviceId: 'endpoint-a',
                callbackFormat: {},
                actualOutputFormat: 'float32',
                actualSampleRate: 48000,
                actualBitDepth: 32,
                actualChannels: 2,
                conversionInfo: {},
                diagnostics: {},
                renderPerformance: {}
              },
              timing: {}
            }
          }
        ]
      },
      { testInput: {} }
    )
    assert.equal(normalized.actualDeviceId, 'endpoint-a')
  } finally {
    if (originalStableId === undefined) delete process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID
    else process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID = originalStableId
    if (originalStableIdHash === undefined)
      delete process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID_HASH
    else process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID_HASH = originalStableIdHash
    if (originalTestInputHash === undefined) delete process.env.TAE_AUDIO_AB_TEST_INPUT_HASH
    else process.env.TAE_AUDIO_AB_TEST_INPUT_HASH = originalTestInputHash
  }
})
