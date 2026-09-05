const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const matrixScript = path.join(__dirname, 'audio-format-matrix.cjs')
const DEFAULT_FORMAT_MATRIX_TIMEOUT_MS = 60000

function readCase() {
  try {
    const parsed = JSON.parse(process.env.TAE_AUDIO_AB_CASE || '')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('TAE_AUDIO_AB_CASE must be an object')
    }
    return parsed
  } catch (error) {
    throw new Error(`Invalid TAE_AUDIO_AB_CASE: ${error.message}`)
  }
}

function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}

function buildMatrixArgs(caseDefinition, stableDeviceId) {
  const args = caseDefinition.testInput?.formatMatrixArgs
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new Error('case.testInput.formatMatrixArgs must be a string array')
  }
  const controlled = new Set(['--backend', '--device', '--json', '--worker'])
  if (args.some((arg) => controlled.has(arg))) {
    throw new Error('formatMatrixArgs must not override --backend, --device, --json, or --worker')
  }
  return [...args, '--playback', '--backend', 'wasapi', '--device', stableDeviceId, '--json']
}

function parseJson(text, label) {
  try {
    return JSON.parse(
      String(text || '')
        .replace(/^\uFEFF/, '')
        .trim()
    )
  } catch (error) {
    throw new Error(`${label} did not emit valid JSON: ${error.message}`)
  }
}

function formatMatrixTimeoutMs(value = process.env.TAE_AUDIO_AB_FORMAT_MATRIX_TIMEOUT_MS) {
  const timeoutMs = Number(value)
  return Number.isFinite(timeoutMs) && timeoutMs >= DEFAULT_FORMAT_MATRIX_TIMEOUT_MS
    ? timeoutMs
    : DEFAULT_FORMAT_MATRIX_TIMEOUT_MS
}

function resultReason(result) {
  const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : []
  if (errors.length > 0) return errors.join('; ')
  if (result.lastError?.message) return String(result.lastError.message)
  return result.ok === false ? 'format_matrix_failed' : ''
}

function normalizeSummary(summary, caseDefinition) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new Error('audio-format-matrix summary must be an object')
  }
  if (summary.playback !== true || summary.options?.backend !== 'wasapi') {
    throw new Error('audio-format-matrix did not run the required Shared WASAPI playback case')
  }
  const stableDeviceId = requireText(
    process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID,
    'TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID'
  )
  if (summary.device?.id !== stableDeviceId) {
    throw new Error('audio-format-matrix did not retain the requested stable device ID')
  }
  if (!Array.isArray(summary.results) || summary.results.length !== 1) {
    throw new Error('each A/B case must produce exactly one audio-format-matrix fixture result')
  }
  const result = summary.results[0]
  const playback = result.playback
  const info = playback?.info || result.info
  if (!info || typeof info !== 'object') {
    throw new Error('audio-format-matrix result is missing playback output facts')
  }
  const diagnostics = info.diagnostics || {}
  const renderPerformance = info.renderPerformance || {}
  const timing = playback?.timing || {}
  return {
    providerImplementation: info.providerImplementation,
    publicBackend: 'wasapi',
    platformStableDeviceIdHash: process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID_HASH,
    actualDeviceId: typeof info.actualDeviceId === 'string' ? info.actualDeviceId.trim() : '',
    testInputHash: process.env.TAE_AUDIO_AB_TEST_INPUT_HASH,
    requestedFormat: caseDefinition.testInput.requestedFormat || {
      codec: result.selected?.codec || '',
      sampleRate: result.selected?.sampleRate || 0,
      bitDepth: result.selected?.bitDepth || 0,
      channels: result.selected?.channelCount || 0
    },
    callbackFormat: info.callbackFormat,
    actualBackendFormat: {
      sampleFormat: info.actualOutputFormat,
      sampleRate: info.actualSampleRate,
      bitDepth: info.actualBitDepth,
      channels: info.actualChannels
    },
    conversionInfo: info.conversionInfo,
    buffer: {
      bufferSizeFrames: info.bufferSizeFrames || 0,
      periodSizeFrames: info.periodSizeFrames || 0,
      latencyFrames: info.latencyFrames || 0,
      latencyMs: info.latencyMs || 0
    },
    counters: {
      callbackCount: renderPerformance.callbackCount || 0,
      deadlineMissCount: renderPerformance.deadlineMissCount || 0,
      underrunCount: diagnostics.sessionUnderrunCount || 0,
      recoveryCount: diagnostics.sessionRecoveryCount || 0,
      rerouteCount: diagnostics.driverRestartCount || 0,
      deviceLostCount: diagnostics.deviceLostCount || 0
    },
    openDurationMs: timing.openDurationMs || 0,
    closeDurationMs: timing.closeDurationMs || 0,
    result: { status: result.ok === true ? 'pass' : 'fail', reason: resultReason(result) }
  }
}

function run() {
  const caseDefinition = readCase()
  if (caseDefinition.publicBackend !== 'wasapi') {
    throw new Error('Only publicBackend="wasapi" is supported by the Shared PCM A/B adapter')
  }
  const stableDeviceId = requireText(
    process.env.TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID,
    'TAE_AUDIO_AB_PLATFORM_STABLE_DEVICE_ID'
  )
  const startedAt = process.hrtime.bigint()
  const result = spawnSync(
    process.execPath,
    [matrixScript, ...buildMatrixArgs(caseDefinition, stableDeviceId)],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: formatMatrixTimeoutMs(),
      windowsHide: true
    }
  )
  if (result.error) throw new Error(`audio-format-matrix failed: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(`audio-format-matrix exited ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  const summary = parseJson(result.stdout, 'audio-format-matrix')
  const probe = normalizeSummary(summary, caseDefinition)
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  if (probe.openDurationMs === 0) probe.openDurationMs = elapsedMs
  process.stdout.write(JSON.stringify(probe))
}

if (require.main === module) {
  try {
    run()
  } catch (error) {
    console.error(error && error.message ? error.message : error)
    process.exitCode = 1
  }
}

module.exports = { buildMatrixArgs, formatMatrixTimeoutMs, normalizeSummary }
