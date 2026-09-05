const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const DEFAULT_PROBE = path.join(__dirname, 'miniaudio-ab-format-matrix-probe.cjs')

const PROVIDERS = [
  { controlValue: 'legacy', implementation: 'legacy-native', miniaudioVersion: null },
  { controlValue: 'miniaudio', implementation: 'miniaudio', miniaudioVersion: '0.11.25' }
]

const DEFAULT_PLAYBACK_DURATION_MS = 1200
const FORMAT_MATRIX_STARTUP_GRACE_MS = 30000
const PROBE_PROCESS_GRACE_MS = 10000
const MIN_FORMAT_MATRIX_TIMEOUT_MS = 60000

const FIXTURE_FAULTS = {
  'init-fail': { status: 'fail', reason: 'backend_open_failure' },
  'start-fail': { status: 'fail', reason: 'backend_start_failure' },
  'device-lost': { status: 'fail', reason: 'device_invalidated' },
  'notification-during-stop': { status: 'pass', reason: 'notification_ignored_during_stop' },
  'service-crash': { status: 'fail', reason: 'audio.service_crashed' },
  'invalid-provider': { status: 'fail', reason: 'invalid_provider_configuration' }
}

function usage() {
  return [
    'Usage:',
    '  pnpm run smoke:miniaudio-ab -- --case artifacts/shared-wasapi-case.json --output artifacts/shared-wasapi-ab.json',
    '',
    'Runs the same Windows Shared WASAPI case in independent legacy and miniaudio child processes.',
    'The emitted artifact is always software-only evidence; it cannot count as real-device coverage.',
    '',
    'Options:',
    '  --case <path>              A/B case JSON with publicBackend, platformStableDeviceId, and testInput.',
    '  --probe <path>             JSON-only probe adapter. Defaults to the audio-format-matrix adapter.',
    '  --probe-arg <value>        Extra probe argument; may be repeated.',
    '  --iterations <count>       Repeat the same provider switch case. Default: 1.',
    '  --output <path>            Write the artifact and print its SHA-256 receipt.',
    '  --json                     Print the artifact JSON.',
    '  --fixture-probe            Internal software fixture used only by the node:test contract.',
    '  --help                     Show this help.'
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    casePath: '',
    probe: DEFAULT_PROBE,
    probeArgs: [],
    iterations: 1,
    output: '',
    json: false,
    fixtureProbe: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`)
      return argv[index]
    }
    if (arg === '--case') options.casePath = next()
    else if (arg === '--probe') options.probe = next()
    else if (arg === '--probe-arg') options.probeArgs.push(next())
    else if (arg === '--iterations') options.iterations = Number(next())
    else if (arg === '--output') options.output = next()
    else if (arg === '--json') options.json = true
    else if (arg === '--fixture-probe') options.fixtureProbe = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.help && !options.fixtureProbe && !options.casePath) {
    throw new Error(`Missing --case\n${usage()}`)
  }
  if (
    !Number.isInteger(options.iterations) ||
    options.iterations < 1 ||
    options.iterations > 100000
  ) {
    throw new Error('--iterations must be an integer between 1 and 100000')
  }
  return options
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hashJson(value) {
  return sha256(canonicalJson(value))
}

function readJson(filePath, label = 'JSON') {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`)
  }
}

function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}

function normalizeCase(raw) {
  if (!isPlainObject(raw)) throw new Error('A/B case must be a JSON object')
  const id = requireText(raw.id, 'case.id')
  const publicBackend = requireText(raw.publicBackend, 'case.publicBackend')
  if (publicBackend !== 'wasapi') {
    throw new Error('MA-104 only permits publicBackend="wasapi" for Windows Shared PCM A/B')
  }
  const platformStableDeviceId = requireText(
    raw.platformStableDeviceId,
    'case.platformStableDeviceId'
  )
  if (platformStableDeviceId === 'auto') {
    throw new Error('case.platformStableDeviceId must be an explicit endpoint stable ID, not auto')
  }
  if (!isPlainObject(raw.testInput)) throw new Error('case.testInput must be a JSON object')
  const expected = isPlainObject(raw.expectedResult) ? raw.expectedResult : { status: 'pass' }
  const status = expected.status || 'pass'
  if (!['pass', 'fail'].includes(status)) {
    throw new Error('case.expectedResult.status must be pass or fail')
  }
  return {
    schemaVersion: Number(raw.schemaVersion || 1),
    id,
    publicBackend,
    platformStableDeviceId,
    testInput: raw.testInput,
    fault: typeof raw.fault === 'string' ? raw.fault : '',
    expectedResult: {
      status,
      reason: typeof expected.reason === 'string' ? expected.reason : ''
    }
  }
}

function readCase(casePath) {
  return normalizeCase(readJson(path.resolve(casePath), 'A/B case'))
}

function playbackDurationMs(testInput) {
  const args = testInput?.formatMatrixArgs
  if (!Array.isArray(args)) {
    const fallback = Number(testInput?.durationMs)
    return Number.isFinite(fallback) && fallback >= 100 ? fallback : DEFAULT_PLAYBACK_DURATION_MS
  }

  let durationMs = null
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--duration-ms') continue
    if (durationMs !== null) throw new Error('formatMatrixArgs must not repeat --duration-ms')
    const value = Number(args[index + 1])
    if (!Number.isFinite(value) || value < 100) {
      throw new Error('formatMatrixArgs --duration-ms must be a number of at least 100')
    }
    durationMs = value
  }
  return durationMs ?? DEFAULT_PLAYBACK_DURATION_MS
}

function formatMatrixTimeoutMs(caseDefinition) {
  return Math.max(
    MIN_FORMAT_MATRIX_TIMEOUT_MS,
    playbackDurationMs(caseDefinition.testInput) + FORMAT_MATRIX_STARTUP_GRACE_MS
  )
}

function probeProcessTimeoutMs(caseDefinition) {
  return formatMatrixTimeoutMs(caseDefinition) + PROBE_PROCESS_GRACE_MS
}

function nonNegativeNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0)
    throw new Error(`${label} must be a non-negative number`)
  return number
}

function conversionValue(value) {
  return typeof value === 'boolean' ? value : 'unknown'
}

function formatValue(value) {
  return isPlainObject(value) ? value : 'unknown'
}

function normalizeProbeResult(raw, expected, processId) {
  if (!isPlainObject(raw)) throw new Error('Probe result must be a JSON object')
  if (raw.providerImplementation !== expected.provider.implementation) {
    throw new Error(
      `Probe providerImplementation mismatch: expected ${expected.provider.implementation}, got ${raw.providerImplementation || '(missing)'}`
    )
  }
  if (raw.publicBackend !== expected.case.publicBackend) {
    throw new Error(
      `Probe publicBackend mismatch: expected ${expected.case.publicBackend}, got ${raw.publicBackend || '(missing)'}`
    )
  }
  if (raw.platformStableDeviceIdHash !== expected.platformStableDeviceIdHash) {
    throw new Error('Probe platformStableDeviceIdHash does not match the A/B case')
  }
  if (raw.testInputHash !== expected.testInputHash) {
    throw new Error('Probe testInputHash does not match the A/B case')
  }
  const result = isPlainObject(raw.result)
    ? raw.result
    : { status: raw.ok === true ? 'pass' : raw.ok === false ? 'fail' : '' }
  if (!['pass', 'fail'].includes(result.status)) {
    throw new Error('Probe result.status must be pass or fail')
  }
  const actualDeviceId = typeof raw.actualDeviceId === 'string' ? raw.actualDeviceId.trim() : ''
  if (result.status === 'pass' && !actualDeviceId) {
    throw new Error('Passing probe result must report actualDeviceId')
  }
  const actualDeviceIdHash = actualDeviceId ? sha256(actualDeviceId) : ''
  if (actualDeviceIdHash && actualDeviceIdHash !== expected.platformStableDeviceIdHash) {
    throw new Error('Probe actualDeviceId does not match the A/B case')
  }

  return {
    providerImplementation: raw.providerImplementation,
    miniaudioVersion: expected.provider.miniaudioVersion,
    publicBackend: raw.publicBackend,
    platformStableDeviceIdHash: raw.platformStableDeviceIdHash,
    actualDeviceIdHash,
    testInputHash: raw.testInputHash,
    requestedFormat: formatValue(raw.requestedFormat),
    callbackFormat: formatValue(raw.callbackFormat),
    actualBackendFormat: formatValue(raw.actualBackendFormat),
    conversionInfo: {
      sampleFormatConverted: conversionValue(raw.conversionInfo?.sampleFormatConverted),
      sampleRateConverted: conversionValue(raw.conversionInfo?.sampleRateConverted),
      channelLayoutConverted: conversionValue(raw.conversionInfo?.channelLayoutConverted),
      source: typeof raw.conversionInfo?.source === 'string' ? raw.conversionInfo.source : 'unknown'
    },
    buffer: {
      bufferSizeFrames: nonNegativeNumber(
        raw.buffer?.bufferSizeFrames,
        'Probe buffer.bufferSizeFrames'
      ),
      periodSizeFrames: nonNegativeNumber(
        raw.buffer?.periodSizeFrames,
        'Probe buffer.periodSizeFrames'
      ),
      latencyFrames: nonNegativeNumber(raw.buffer?.latencyFrames, 'Probe buffer.latencyFrames'),
      latencyMs: nonNegativeNumber(raw.buffer?.latencyMs, 'Probe buffer.latencyMs')
    },
    counters: {
      callbackCount: nonNegativeNumber(raw.counters?.callbackCount, 'Probe counters.callbackCount'),
      deadlineMissCount: nonNegativeNumber(
        raw.counters?.deadlineMissCount,
        'Probe counters.deadlineMissCount'
      ),
      underrunCount: nonNegativeNumber(raw.counters?.underrunCount, 'Probe counters.underrunCount'),
      recoveryCount: nonNegativeNumber(raw.counters?.recoveryCount, 'Probe counters.recoveryCount'),
      rerouteCount: nonNegativeNumber(raw.counters?.rerouteCount, 'Probe counters.rerouteCount'),
      deviceLostCount: nonNegativeNumber(
        raw.counters?.deviceLostCount,
        'Probe counters.deviceLostCount'
      )
    },
    openDurationMs: nonNegativeNumber(raw.openDurationMs, 'Probe openDurationMs'),
    closeDurationMs: nonNegativeNumber(raw.closeDurationMs, 'Probe closeDurationMs'),
    result: {
      status: result.status,
      reason: typeof result.reason === 'string' ? result.reason : ''
    },
    execution: {
      processId,
      providerControl: expected.provider.controlValue
    }
  }
}

function assertExpectedResult(result, expectedResult, provider) {
  if (result.result.status !== expectedResult.status) {
    throw new Error(
      `${provider.implementation} result.status mismatch: expected ${expectedResult.status}, got ${result.result.status}`
    )
  }
  if (expectedResult.reason && result.result.reason !== expectedResult.reason) {
    throw new Error(
      `${provider.implementation} result.reason mismatch: expected ${expectedResult.reason}, got ${result.result.reason || '(missing)'}`
    )
  }
}

function runProbe(caseDefinition, provider, probePath, probeArgs) {
  const platformStableDeviceIdHash = sha256(caseDefinition.platformStableDeviceId)
  const testInputHash = hashJson(caseDefinition.testInput)
  const formatMatrixTimeout = formatMatrixTimeoutMs(caseDefinition)
  const environment = {
    ...process.env,
    TWILIGHT_AUDIO_PCM_PROVIDER: provider.controlValue,
    TAE_AUDIO_AB_PROVIDER: provider.implementation,
    TAE_AUDIO_AB_CASE: JSON.stringify(caseDefinition),
    TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID: caseDefinition.platformStableDeviceId,
    TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID_HASH: platformStableDeviceIdHash,
    TAE_AUDIO_AB_TEST_INPUT_HASH: testInputHash,
    TAE_AUDIO_AB_FAULT: caseDefinition.fault,
    TAE_AUDIO_AB_FORMAT_MATRIX_TIMEOUT_MS: String(formatMatrixTimeout)
  }
  const result = spawnSync(process.execPath, [probePath, ...probeArgs], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    timeout: probeProcessTimeoutMs(caseDefinition),
    windowsHide: true
  })
  if (result.error)
    throw new Error(`A/B ${provider.controlValue} probe failed: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(
      `A/B ${provider.controlValue} probe exited ${result.status}${detail ? `: ${detail}` : ''}`
    )
  }
  let raw
  try {
    raw = JSON.parse(
      String(result.stdout || '')
        .replace(/^\uFEFF/, '')
        .trim()
    )
  } catch (error) {
    throw new Error(`A/B ${provider.controlValue} probe did not emit valid JSON: ${error.message}`)
  }
  const normalized = normalizeProbeResult(
    raw,
    { provider, case: caseDefinition, platformStableDeviceIdHash, testInputHash },
    result.pid
  )
  assertExpectedResult(normalized, caseDefinition.expectedResult, provider)
  return normalized
}

function buildCaseDiff(legacy, miniaudio) {
  const fields = [
    'requestedFormat',
    'callbackFormat',
    'actualBackendFormat',
    'actualDeviceIdHash',
    'conversionInfo',
    'buffer',
    'counters',
    'openDurationMs',
    'closeDurationMs',
    'result'
  ]
  return fields.map((field) => ({
    field,
    legacy: legacy[field],
    miniaudio: miniaudio[field],
    equal: canonicalJson(legacy[field]) === canonicalJson(miniaudio[field])
  }))
}

function runCase(options) {
  const caseDefinition = readCase(options.casePath)
  const probePath = path.resolve(options.probe || DEFAULT_PROBE)
  if (!fs.existsSync(probePath)) throw new Error(`Probe does not exist: ${probePath}`)
  const results = Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider.controlValue,
      runProbe(caseDefinition, provider, probePath, options.probeArgs || [])
    ])
  )
  if (results.legacy.execution.processId === results.miniaudio.execution.processId) {
    throw new Error('A/B providers must run in distinct child processes')
  }
  return {
    schemaVersion: 1,
    kind: 'miniaudio-shared-pcm-ab',
    evidenceKind: 'software-only',
    generatedAt: new Date().toISOString(),
    case: {
      id: caseDefinition.id,
      fault: caseDefinition.fault || null,
      publicBackend: caseDefinition.publicBackend,
      platformStableDeviceIdHash: sha256(caseDefinition.platformStableDeviceId),
      testInput: caseDefinition.testInput,
      testInputHash: hashJson(caseDefinition.testInput),
      expectedResult: caseDefinition.expectedResult
    },
    runs: results,
    diff: buildCaseDiff(results.legacy, results.miniaudio)
  }
}

function runSeries(options) {
  if (options.iterations === 1) return runCase(options)
  const cases = []
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    cases.push(runCase(options))
  }
  return {
    schemaVersion: 1,
    kind: 'miniaudio-shared-pcm-ab-series',
    evidenceKind: 'software-only',
    generatedAt: new Date().toISOString(),
    iterations: cases.length,
    case: cases[0].case,
    cases
  }
}

function writeArtifact(artifact, outputPath) {
  const resolved = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const text = `${JSON.stringify(artifact, null, 2)}\n`
  fs.writeFileSync(resolved, text)
  return { path: resolved, sha256: sha256(text) }
}

function fixtureProbe() {
  const provider = process.env.TAE_AUDIO_AB_PROVIDER
  const fault = process.env.TAE_AUDIO_AB_FAULT || ''
  const caseDefinition = JSON.parse(process.env.TAE_AUDIO_AB_CASE || '{}')
  const faultResult = FIXTURE_FAULTS[fault] || { status: 'pass', reason: '' }
  const result = {
    providerImplementation: provider,
    publicBackend: process.env.TAE_AUDIO_AB_PUBLIC_BACKEND || caseDefinition.publicBackend,
    platformStableDeviceIdHash: process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID_HASH,
    actualDeviceId:
      fault === 'wrong-actual-device-id'
        ? '{0.0.0.00000000}.{wrong-endpoint}'
        : process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID,
    testInputHash: process.env.TAE_AUDIO_AB_TEST_INPUT_HASH,
    requestedFormat: caseDefinition.testInput?.requestedFormat || {
      sampleRate: 48000,
      channels: 2
    },
    callbackFormat: { sampleFormat: 'float32', sampleRate: 48000, channels: 2 },
    actualBackendFormat: { sampleFormat: 'float32', sampleRate: 48000, channels: 2 },
    conversionInfo:
      provider === 'miniaudio'
        ? {
            sampleFormatConverted: false,
            sampleRateConverted: false,
            channelLayoutConverted: false,
            source: 'backend-runtime'
          }
        : {
            sampleFormatConverted: 'unknown',
            sampleRateConverted: 'unknown',
            channelLayoutConverted: 'unknown',
            source: 'unavailable'
          },
    buffer: { bufferSizeFrames: 480, periodSizeFrames: 240, latencyFrames: 480, latencyMs: 10 },
    counters: {
      callbackCount: 8,
      deadlineMissCount: 0,
      underrunCount: 0,
      recoveryCount: fault === 'device-lost' ? 1 : 0,
      rerouteCount: fault === 'device-lost' ? 1 : 0,
      deviceLostCount: fault === 'device-lost' ? 1 : 0
    },
    openDurationMs: fault === 'invalid-duration' ? -1 : 4,
    closeDurationMs: 1,
    result: faultResult
  }
  if (fault === 'wrong-provider') result.providerImplementation = 'wrong-provider'
  if (fault === 'wrong-device-hash') result.platformStableDeviceIdHash = '0'.repeat(64)
  process.stdout.write(JSON.stringify(result))
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (options.fixtureProbe) {
    fixtureProbe()
    return
  }
  const artifact = runSeries(options)
  const receipt = options.output ? writeArtifact(artifact, options.output) : null
  const output = receipt ? { ...artifact, artifact: receipt } : artifact
  if (options.json || !receipt) console.log(JSON.stringify(output, null, 2))
  else console.log(`${receipt.path}\n${receipt.sha256}`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error && error.message ? error.message : error)
    process.exitCode = 1
  }
}

module.exports = {
  DEFAULT_PROBE,
  FIXTURE_FAULTS,
  canonicalJson,
  DEFAULT_PLAYBACK_DURATION_MS,
  FORMAT_MATRIX_STARTUP_GRACE_MS,
  MIN_FORMAT_MATRIX_TIMEOUT_MS,
  PROBE_PROCESS_GRACE_MS,
  formatMatrixTimeoutMs,
  hashJson,
  normalizeCase,
  normalizeProbeResult,
  parseArgs,
  playbackDurationMs,
  probeProcessTimeoutMs,
  runCase,
  runSeries,
  writeArtifact
}
