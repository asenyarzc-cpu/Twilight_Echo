const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function usage() {
  return [
    'Usage:',
    '  pnpm run smoke:audio-performance -- --device "Desk DAC" --duration-seconds 300 --json',
    '',
    'Runs an opt-in real WASAPI Exclusive performance soak. It is not a default CI test.',
    '',
    'Options:',
    '  --device <name-or-id>       Required unless TAE_WASAPI_DEVICE is set.',
    '  --duration-seconds <secs>   Soak duration. Default: 300; minimum: 60.',
    '  --buffer <frames>           Exclusive preferred buffer size. Default: 256.',
    '  --volume <0..1>             Playback volume. Default: 0.02.',
    '  --source <path>             Optional PCM WAV fixture; otherwise a generated WAV is used.',
    '  --module <path>             Native twilight_audio_node.node path.',
    '  --max-deadline-misses <n>   Maximum callback deadline misses. Default: 0.',
    '  --max-callback-load <pct>   Maximum mean callback deadline load. Default: 80.',
    '  --json                      Print JSON only.',
    '  --help                      Show this help.'
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    device: process.env.TAE_WASAPI_DEVICE || '',
    durationSeconds: Number(process.env.TAE_AUDIO_PERFORMANCE_SOAK_SECONDS || 300),
    buffer: Number(process.env.TAE_WASAPI_BUFFER || 256),
    volume: Number(process.env.TAE_WASAPI_VOLUME || 0.02),
    source: '',
    modulePath: process.env.TAE_AUDIO_NODE || '',
    maxDeadlineMisses: Number(process.env.TAE_AUDIO_PERFORMANCE_MAX_DEADLINE_MISSES || 0),
    maxCallbackLoad: Number(process.env.TAE_AUDIO_PERFORMANCE_MAX_CALLBACK_LOAD || 80),
    json: false,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`)
      return argv[index]
    }
    if (arg === '--device') options.device = next()
    else if (arg === '--duration-seconds') options.durationSeconds = Number(next())
    else if (arg === '--buffer') options.buffer = Number(next())
    else if (arg === '--volume') options.volume = Number(next())
    else if (arg === '--source') options.source = next()
    else if (arg === '--module') options.modulePath = next()
    else if (arg === '--max-deadline-misses') options.maxDeadlineMisses = Number(next())
    else if (arg === '--max-callback-load') options.maxCallbackLoad = Number(next())
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 60) {
    throw new Error('--duration-seconds must be at least 60')
  }
  if (!Number.isFinite(options.buffer) || options.buffer < 1)
    throw new Error('--buffer must be at least 1')
  if (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 1) {
    throw new Error('--volume must be between 0 and 1')
  }
  if (!Number.isInteger(options.maxDeadlineMisses) || options.maxDeadlineMisses < 0) {
    throw new Error('--max-deadline-misses must be a non-negative integer')
  }
  if (!Number.isFinite(options.maxCallbackLoad) || options.maxCallbackLoad <= 0) {
    throw new Error('--max-callback-load must be positive')
  }
  return options
}

function loadNative(modulePath) {
  const candidates = [
    modulePath,
    path.join(root, 'audio-engine', 'build', 'mingw-static', 'twilight_audio_node.node'),
    path.join(root, 'resources', 'audio-engine', 'twilight_audio_node.node'),
    path.join(root, 'out', 'renderer', 'audio-engine', 'twilight_audio_node.node')
  ].filter(Boolean)
  const selected = candidates.find((candidate) => fs.existsSync(candidate))
  if (!selected) {
    throw new Error(
      'Cannot find twilight_audio_node.node. Build and stage the native engine before running a real-device soak.'
    )
  }
  process.env.PATH = `${path.dirname(selected)}${path.delimiter}${process.env.PATH || ''}`
  return { audio: require(selected), modulePath: selected }
}

function parseJson(raw, context) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error && error.message}`)
  }
}

function normalized(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveDevice(devices, query) {
  if (!query)
    throw new Error(
      'Missing --device. Select an actual WASAPI endpoint; do not use this soak in CI.'
    )
  const exact = devices.filter((device) => device.id === query || device.label === query)
  if (exact.length === 1) return exact[0]
  const needle = normalized(query)
  const fuzzy = devices.filter(
    (device) => normalized(device.id).includes(needle) || normalized(device.label).includes(needle)
  )
  if (fuzzy.length === 1) return fuzzy[0]
  const available = devices.map((device) => `  - ${device.label} | id=${device.id}`).join('\n')
  if (fuzzy.length === 0)
    throw new Error(`No device matched "${query}". Available devices:\n${available}`)
  throw new Error(`Device selector "${query}" is ambiguous. Available devices:\n${available}`)
}

function writeLongSilenceWav(filePath, durationSeconds) {
  const sampleRate = 48000
  const channels = 2
  const bits = 16
  const bytesPerSample = bits / 8
  const frameCount = Math.ceil((durationSeconds + 2) * sampleRate)
  const dataBytes = frameCount * channels * bytesPerSample
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  header.writeUInt16LE(channels * bytesPerSample, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  const descriptor = fs.openSync(filePath, 'w')
  try {
    fs.writeSync(descriptor, header)
    const block = Buffer.alloc(1024 * 1024)
    let remaining = dataBytes
    while (remaining > 0) {
      const size = Math.min(remaining, block.length)
      fs.writeSync(descriptor, block, 0, size)
      remaining -= size
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, position)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
      position += bytes
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function compactPlaybackInfo(info) {
  const output = info.outputInfo || {}
  return {
    state: info.state,
    position: info.position,
    duration: info.duration,
    outputBackend: info.outputBackend,
    outputDevice: info.outputDevice,
    actualBackend: info.actualBackend || output.actualBackend,
    deviceName: output.actualDeviceName || output.deviceName,
    driverName: output.actualDriverName || output.driverName,
    driverVersion: output.actualDriverVersion || output.driverVersion,
    actualOutputFormat: output.actualOutputFormat,
    actualSampleRate: output.actualSampleRate,
    actualBitDepth: output.actualBitDepth,
    actualChannels: output.actualChannels,
    exclusive: output.exclusive,
    accessMode: output.accessMode,
    bufferSizeFrames: output.bufferSizeFrames,
    latencyInfo: output.latencyInfo,
    diagnostics: output.diagnostics || {},
    renderPerformance: output.renderPerformance || {}
  }
}

function delta(before = {}, after = {}, fields) {
  return Object.fromEntries(
    fields.map((field) => [field, Number(after[field] || 0) - Number(before[field] || 0)])
  )
}

function performanceDelta(before = {}, after = {}) {
  return delta(before, after, [
    'callbackCount',
    'totalCallbackNanoseconds',
    'totalDeadlineNanoseconds',
    'deadlineMissCount'
  ])
}

function callbackDeadlineLoadPercent(performance = {}) {
  const deadline = Number(performance.totalDeadlineNanoseconds || 0)
  if (deadline <= 0) return 0
  return (Number(performance.totalCallbackNanoseconds || 0) * 100) / deadline
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeStop(audio) {
  try {
    audio.Stop()
  } catch {
    // Keep the original failure as the reported result.
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function runSoak(options) {
  const { audio, modulePath } = loadNative(options.modulePath)
  const devices = parseJson(audio.GetOutputDevices(), 'GetOutputDevices')
  const device = resolveDevice(Array.isArray(devices) ? devices : [], options.device)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-performance-soak-'))
  const generatedSource = !options.source
  const source = options.source
    ? path.resolve(options.source)
    : path.join(tempDir, 'performance-soak.wav')
  if (!fs.existsSync(source) && !generatedSource)
    throw new Error(`Source fixture does not exist: ${source}`)
  if (generatedSource) writeLongSilenceWav(source, options.durationSeconds)

  try {
    safeStop(audio)
    audio.SetVolume(options.volume)
    audio.SetReplayGainMode('off', 0, 0, true)
    audio.SetEqBands(JSON.stringify({ enabled: false, bands: [] }))
    audio.SetCrossfeedStrength(0)
    audio.SetDspConfig(JSON.stringify({ crossfadeSeconds: 0 }))
    audio.SetOutputBackend('wasapi-exclusive')
    audio.SetOutputDevice(device.id)
    audio.SetOutputConfig(
      JSON.stringify({ preferredBufferSize: options.buffer, routingMode: 'auto' })
    )
    audio.Play(source, 0)
    await sleep(1000)
    const before = compactPlaybackInfo(
      parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo before soak')
    )
    expect(
      before.actualBackend === 'wasapi-exclusive',
      `Expected WASAPI Exclusive, got ${before.actualBackend}`
    )
    expect(
      before.exclusive === true && before.accessMode === 'exclusive',
      'Backend did not open an exclusive device'
    )
    expect(before.bufferSizeFrames > 0, 'Missing actual exclusive buffer size')
    expect(
      before.renderPerformance.callbackCount > 0,
      'No native render callbacks observed before soak'
    )

    await sleep(options.durationSeconds * 1000)
    const after = compactPlaybackInfo(
      parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo after soak')
    )
    const diagnostics = delta(before.diagnostics, after.diagnostics, [
      'sessionUnderrunCount',
      'sessionBufferDropCount',
      'sessionRecoveryCount',
      'deviceLostCount'
    ])
    const renderPerformance = performanceDelta(before.renderPerformance, after.renderPerformance)
    const callbackLoad = callbackDeadlineLoadPercent(renderPerformance)
    expect(after.state === 'playing', `Playback stopped during soak (state=${after.state})`)
    expect(renderPerformance.callbackCount > 0, 'No render callbacks were observed during soak')
    expect(
      after.position >= options.durationSeconds * 0.85,
      'Playback position did not advance through the soak'
    )
    expect(
      diagnostics.sessionUnderrunCount === 0,
      `Observed ${diagnostics.sessionUnderrunCount} underruns`
    )
    expect(
      diagnostics.sessionBufferDropCount === 0,
      `Observed ${diagnostics.sessionBufferDropCount} buffer drops`
    )
    expect(
      diagnostics.deviceLostCount === 0,
      `Observed ${diagnostics.deviceLostCount} device-loss events`
    )
    expect(
      renderPerformance.deadlineMissCount <= options.maxDeadlineMisses,
      `Observed ${renderPerformance.deadlineMissCount} callback deadline misses`
    )
    expect(
      callbackLoad <= options.maxCallbackLoad,
      `Mean callback deadline load ${callbackLoad}% exceeds ${options.maxCallbackLoad}%`
    )

    return {
      schemaVersion: 1,
      kind: 'real-device-performance-soak',
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      modulePath,
      device: { id: device.id, label: device.label },
      results: [
        {
          id: 'wasapi-exclusive-performance-soak',
          label: 'WASAPI Exclusive real-device performance soak',
          backend: 'wasapi-exclusive',
          ok: true,
          info: after,
          metrics: {
            execution: 'real-device',
            durationSeconds: options.durationSeconds,
            source: {
              path: source,
              generated: generatedSource,
              sha256: sha256(source),
              bytes: fs.statSync(source).size
            },
            requested: {
              bufferSizeFrames: options.buffer,
              volume: options.volume,
              maxDeadlineMisses: options.maxDeadlineMisses,
              maxCallbackDeadlineLoadPercent: options.maxCallbackLoad
            },
            renderPerformance,
            callbackDeadlineLoadPercent: callbackLoad,
            diagnostics
          }
        }
      ]
    }
  } finally {
    safeStop(audio)
    if (generatedSource) fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function printHumanSummary(summary) {
  const result = summary.results[0]
  const metrics = result.metrics
  console.log(`WASAPI Exclusive real-device performance soak: ${result.ok ? 'PASS' : 'FAIL'}`)
  console.log(`  device=${summary.device.label}`)
  console.log(
    `  duration=${metrics.durationSeconds}s callbacks=${metrics.renderPerformance.callbackCount}`
  )
  console.log(
    `  deadlineLoad=${metrics.callbackDeadlineLoadPercent}% deadlineMisses=${metrics.renderPerformance.deadlineMissCount}`
  )
  console.log(
    `  underruns=${metrics.diagnostics.sessionUnderrunCount} drops=${metrics.diagnostics.sessionBufferDropCount}`
  )
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const summary = await runSoak(options)
  if (options.json) console.log(JSON.stringify(summary, null, 2))
  else printHumanSummary(summary)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error)
    process.exitCode = 1
  })
}

module.exports = { callbackDeadlineLoadPercent, parseArgs, performanceDelta }
