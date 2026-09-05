const assert = require('node:assert/strict')
const test = require('node:test')

const {
  FII0_ENDPOINT,
  SUPPORTED_SCENARIOS,
  buildProviderChildArgs,
  compactInfo,
  expectedProviderImplementation,
  findDevice,
  parseArgs,
  physicalDefaultId
} = require('./windows-audio-operational-smoke.cjs')

const devices = [
  { id: 'auto', label: '系统默认', isDefault: true },
  { id: FII0_ENDPOINT, label: '扬声器 (2- FiiO M series)', isDefault: false },
  { id: 'realtek', label: '扬声器 (Realtek(R) Audio)', isDefault: true }
]

test('operational smoke parser keeps the Windows scenario and provider contract narrow', () => {
  const options = parseArgs([
    '--scenario',
    'hotplug',
    '--provider',
    'miniaudio',
    '--duration-ms',
    '900'
  ])
  assert.deepEqual(options.providers, ['miniaudio'])
  assert.equal(options.scenario, 'hotplug')
  assert.equal(options.durationMs, 900)
  assert.deepEqual(SUPPORTED_SCENARIOS, ['default-switch', 'hotplug', 'explicit-disappearance'])
})

test('operational smoke accepts controlled explicit endpoint disappearance', () => {
  const options = parseArgs([
    '--scenario',
    'explicit-disappearance',
    '--provider',
    'legacy',
    '--duration-ms',
    '900'
  ])
  assert.equal(options.scenario, 'explicit-disappearance')
  assert.deepEqual(buildProviderChildArgs(options, 'legacy').slice(0, 6), [
    __filename.replace('.test.cjs', '.cjs'),
    '--scenario',
    'explicit-disappearance',
    '--provider',
    'legacy',
    '--device'
  ])
})

test('operational smoke resolves exactly one explicit endpoint and rejects auto', () => {
  assert.equal(findDevice(devices, FII0_ENDPOINT).label, '扬声器 (2- FiiO M series)')
  assert.throws(() => parseArgs(['--device', 'auto']), /explicit FiiO endpoint/)
  assert.throws(() => findDevice(devices, '扬声器'), /Device selector matched 0 devices/)
})

test('operational smoke identifies the physical console default', () => {
  assert.equal(physicalDefaultId(devices), 'realtek')
  assert.equal(physicalDefaultId([{ id: 'auto', isDefault: true }]), '')
})

test('operational smoke compacts output facts and diagnostics', () => {
  const info = compactInfo({
    state: 'stopped',
    source: 'tone.wav',
    actualBackend: 'wasapi',
    outputInfo: {
      actualDeviceId: FII0_ENDPOINT,
      actualDeviceName: '扬声器 (2- FiiO M series)',
      providerImplementation: 'miniaudio',
      actualOutputFormat: 'float32',
      actualSampleRate: 48000,
      actualBitDepth: 32,
      actualChannels: 2,
      accessMode: 'shared',
      bufferSizeFrames: 1056,
      diagnostics: { sessionUnderrunCount: 0, deviceLostCount: 1, lastError: 'device lost' }
    }
  })
  assert.deepEqual(info, {
    state: 'stopped',
    source: 'tone.wav',
    actualBackend: 'wasapi',
    actualDeviceId: FII0_ENDPOINT,
    actualDeviceName: '扬声器 (2- FiiO M series)',
    providerImplementation: 'miniaudio',
    actualOutputFormat: 'float32',
    actualSampleRate: 48000,
    actualBitDepth: 32,
    actualChannels: 2,
    accessMode: 'shared',
    bufferSizeFrames: 1056,
    outputPerfect: undefined,
    perfectReasonCode: '',
    diagnostics: {
      sessionUnderrunCount: 0,
      sessionBufferDropCount: 0,
      sessionRecoveryCount: 0,
      deviceLostCount: 1,
      lastError: 'device lost'
    }
  })
})

test('operational smoke isolates provider selection in the child environment', () => {
  const args = buildProviderChildArgs(
    {
      scenario: 'default-switch',
      provider: 'miniaudio',
      device: FII0_ENDPOINT,
      durationMs: 900,
      modulePath: 'C:\\audio\\twilight_audio_node.node',
      source: 'C:\\audio\\tone.wav'
    },
    'miniaudio'
  )
  assert.equal(args[args.indexOf('--provider') + 1], 'miniaudio')
  assert.equal(args[args.indexOf('--device') + 1], FII0_ENDPOINT)
  assert.equal(args.includes('--output'), false)
  assert.equal(args.includes('--evidence-output'), false)
  assert.equal(expectedProviderImplementation('legacy'), 'legacy-native')
  assert.equal(expectedProviderImplementation('miniaudio'), 'miniaudio')
})
