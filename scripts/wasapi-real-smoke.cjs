const fs = require('node:fs')
const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function usage() {
  return [
    'Usage:',
    '  pnpm run smoke:wasapi -- --device "扬声器 (2- FiiO M series)"',
    '  node scripts/wasapi-real-smoke.cjs --device "{endpoint-id}" --buffer 256',
    '',
    'Options:',
    '  --device <name-or-id>       Required unless TAE_WASAPI_DEVICE is set. Use "auto" only intentionally.',
    '  --buffer <frames>           Exclusive preferred buffer size. Default: 256.',
    '  --duration-ms <ms>          Playback duration per probe. Default: 1200.',
    '  --volume <0..1>             Non-bit-perfect smoke volume. Default: 0.02.',
    '  --expect-bit-perfect        Fail when the adaptive silent exclusive probe is not outputPerfect.',
    '  --skip-bit-perfect-probe    Only run Shared and Exclusive hardware smoke.',
    '  --format-matrix             Also run generated WAV probes across s16/s24/s32/f32 source formats.',
    '  --module <path>             Native twilight_audio_node.node path.',
    '  --json                      Print JSON only.',
    '  --help                      Show this help.'
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    device: process.env.TAE_WASAPI_DEVICE || '',
    buffer: Number(process.env.TAE_WASAPI_BUFFER || 256),
    durationMs: Number(process.env.TAE_WASAPI_DURATION_MS || 1200),
    volume: Number(process.env.TAE_WASAPI_VOLUME || 0.02),
    expectBitPerfect: process.env.TAE_WASAPI_EXPECT_BIT_PERFECT === '1',
    skipBitPerfectProbe: process.env.TAE_WASAPI_SKIP_BIT_PERFECT_PROBE === '1',
    formatMatrix: process.env.TAE_WASAPI_FORMAT_MATRIX === '1',
    modulePath: process.env.TAE_AUDIO_NODE || '',
    json: false,
    worker: false,
    help: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`)
      return argv[i]
    }

    if (arg === '--device') options.device = next()
    else if (arg === '--buffer') options.buffer = Number(next())
    else if (arg === '--duration-ms') options.durationMs = Number(next())
    else if (arg === '--volume') options.volume = Number(next())
    else if (arg === '--expect-bit-perfect') options.expectBitPerfect = true
    else if (arg === '--skip-bit-perfect-probe') options.skipBitPerfectProbe = true
    else if (arg === '--format-matrix') options.formatMatrix = true
    else if (arg === '--module') options.modulePath = next()
    else if (arg === '--json') options.json = true
    else if (arg === '--worker') options.worker = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (!Number.isFinite(options.buffer) || options.buffer < 0) {
    throw new Error('--buffer must be a non-negative number')
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs < 100) {
    throw new Error('--duration-ms must be at least 100')
  }
  if (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 1) {
    throw new Error('--volume must be between 0 and 1')
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
      [
        'Cannot find twilight_audio_node.node.',
        'Build and stage the native engine first:',
        '  pnpm run configure:audio-engine:mingw',
        '  pnpm run build:audio-engine:mingw'
      ].join('\n')
    )
  }

  const nativeDir = path.dirname(selected)
  process.env.PATH = `${nativeDir}${path.delimiter}${process.env.PATH || ''}`
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
      'Missing --device. Pass a device name such as "扬声器 (2- FiiO M series)" or an endpoint id.'
    )
  if (query === 'auto') {
    const auto = devices.find((device) => device.id === 'auto')
    if (!auto) throw new Error('The native device list did not include auto')
    return auto
  }

  const exact = devices.filter((device) => device.id === query || device.label === query)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) throw new Error(`Device selector matched multiple exact devices: ${query}`)

  const queryText = normalized(query)
  const fuzzy = devices.filter(
    (device) =>
      normalized(device.label).includes(queryText) || normalized(device.id).includes(queryText)
  )
  if (fuzzy.length === 1) return fuzzy[0]

  const list = devices
    .map((device) => `  - ${device.label} | id=${device.id} | default=${Boolean(device.isDefault)}`)
    .join('\n')
  if (fuzzy.length === 0)
    throw new Error(`No device matched "${query}". Available devices:\n${list}`)
  throw new Error(`Device selector "${query}" matched multiple devices:\n${list}`)
}

function compactPlaybackInfo(info) {
  const output = info.outputInfo || {}
  return {
    state: info.state,
    source: info.source,
    codec: info.codec,
    decodedSampleRate: info.decodedSampleRate,
    decodedBitDepth: info.decodedBitDepth,
    decodedChannels: info.decodedChannels,
    decodedSampleFormat: info.decodedSampleFormat,
    outputBackend: info.outputBackend,
    actualBackend: info.actualBackend || output.actualBackend,
    outputDevice: info.outputDevice,
    deviceName: output.actualDeviceName || output.deviceName,
    actualOutputFormat: output.actualOutputFormat,
    actualSampleRate: output.actualSampleRate,
    actualBitDepth: output.actualBitDepth,
    actualChannels: output.actualChannels,
    accessMode: output.accessMode,
    devicePathKind: output.devicePathKind,
    exclusive: output.exclusive,
    bufferSizeFrames: output.bufferSizeFrames,
    latencyFrames: output.latencyFrames,
    latencyMs: output.latencyMs,
    latencyInfo: output.latencyInfo,
    supportsOutputPerfect: output.supportsOutputPerfect,
    outputPerfect: output.outputPerfect,
    pcmPassthrough: output.pcmPassthrough,
    sourceExact: output.sourceExact,
    resampled: output.resampled,
    perfectReasonCode: output.perfectReasonCode,
    perfectReason: output.perfectReason,
    diagnostics: output.diagnostics
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function assertDeviceFacts(label, info, device) {
  expect(info.deviceName, `${label}: missing actual device name`)
  if (device.id !== 'auto') {
    expect(
      normalized(info.deviceName).includes(normalized(device.label)),
      `${label}: actual device "${info.deviceName}" does not match selected "${device.label}"`
    )
  }
  expect(info.actualOutputFormat, `${label}: missing actual output format`)
  expect(info.actualSampleRate > 0, `${label}: missing actual sample rate`)
  expect(info.actualBitDepth > 0, `${label}: missing actual bit depth`)
  expect(info.actualChannels > 0, `${label}: missing actual channel count`)
  expect(info.bufferSizeFrames > 0, `${label}: missing buffer size`)
  expect(
    info.latencyInfo && info.latencyInfo.totalLatencyMs >= info.latencyInfo.bufferLatencyMs,
    `${label}: invalid latency facts`
  )
}

function assertNoBackendFailures(label, info) {
  const diagnostics = info.diagnostics || {}
  expect(
    diagnostics.sessionUnderrunCount === 0,
    `${label}: underrun count is ${diagnostics.sessionUnderrunCount}`
  )
  expect(
    diagnostics.sessionBufferDropCount === 0,
    `${label}: buffer drop count is ${diagnostics.sessionBufferDropCount}`
  )
  expect(
    diagnostics.deviceLostCount === 0,
    `${label}: device lost count is ${diagnostics.deviceLostCount}`
  )
  expect(!diagnostics.lastError, `${label}: backend reported lastError=${diagnostics.lastError}`)
}

function assertShared(label, info, device) {
  assertDeviceFacts(label, info, device)
  assertNoBackendFailures(label, info)
  expect(
    info.actualBackend === 'wasapi',
    `${label}: expected actualBackend=wasapi, got ${info.actualBackend}`
  )
  expect(info.accessMode === 'shared', `${label}: expected shared access, got ${info.accessMode}`)
  expect(
    info.supportsOutputPerfect === false,
    `${label}: shared mode must not support outputPerfect`
  )
  expect(info.outputPerfect === false, `${label}: shared mode must not be outputPerfect`)
  expect(
    info.perfectReasonCode === 'shared_mixer',
    `${label}: expected perfectReasonCode=shared_mixer, got ${info.perfectReasonCode}`
  )
}

function assertExclusive(label, info, device) {
  assertDeviceFacts(label, info, device)
  assertNoBackendFailures(label, info)
  expect(
    info.actualBackend === 'wasapi-exclusive',
    `${label}: expected actualBackend=wasapi-exclusive, got ${info.actualBackend}`
  )
  expect(
    info.accessMode === 'exclusive',
    `${label}: expected exclusive access, got ${info.accessMode}`
  )
  expect(info.exclusive === true, `${label}: expected exclusive=true`)
  expect(
    info.supportsOutputPerfect === true,
    `${label}: exclusive mode should support outputPerfect`
  )
}

function wavEncodingForOutputFormat(probeFormat) {
  const sampleFormat = probeFormat.actualOutputFormat
  if (sampleFormat === 'int16')
    return { formatTag: 1, bits: 16, bytesPerSample: 2, suffix: 's16le' }
  if (sampleFormat === 'int24')
    return { formatTag: 1, bits: 24, bytesPerSample: 3, suffix: 's24le' }
  if (sampleFormat === 'int32')
    return { formatTag: 1, bits: 32, bytesPerSample: 4, suffix: 's32le' }
  if (sampleFormat === 'float32')
    return { formatTag: 3, bits: 32, bytesPerSample: 4, suffix: 'f32le' }
  throw new Error(`Cannot generate an exact WAV probe for output sample format: ${sampleFormat}`)
}

function probeFormatFromExclusiveInfo(info) {
  if (!info)
    throw new Error('Cannot run bit-perfect probe without successful exclusive output facts')
  return {
    actualOutputFormat: info.actualOutputFormat,
    actualSampleRate: info.actualSampleRate,
    actualBitDepth: info.actualBitDepth,
    actualChannels: info.actualChannels
  }
}

function writeSilenceWav(filePath, probeFormat) {
  const encoding = wavEncodingForOutputFormat(probeFormat)
  const sampleRate = probeFormat.actualSampleRate
  const channels = probeFormat.actualChannels
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new Error('Cannot generate WAV probe without sample rate')
  if (!Number.isFinite(channels) || channels <= 0)
    throw new Error('Cannot generate WAV probe without channel count')

  const seconds = 2
  const blockAlign = channels * encoding.bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = sampleRate * seconds * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(encoding.formatTag, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(encoding.bits, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  fs.writeFileSync(filePath, buffer)
  return { ...probeFormat, wavEncoding: encoding.suffix }
}

function writeHardwareSmokeTone(filePath) {
  const sampleRate = 48000
  const channels = 2
  const seconds = 2
  const bits = 16
  const bytesPerSample = bits / 8
  const blockAlign = channels * bytesPerSample
  const frameCount = sampleRate * seconds
  const dataSize = frameCount * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 3276)
    const offset = 44 + frame * blockAlign
    buffer.writeInt16LE(sample, offset)
    buffer.writeInt16LE(sample, offset + bytesPerSample)
  }

  fs.writeFileSync(filePath, buffer)
}

function staticFormatMatrix() {
  return [
    {
      label: 'WASAPI Exclusive format matrix s16/48k/2ch',
      actualOutputFormat: 'int16',
      actualSampleRate: 48000,
      actualBitDepth: 16,
      actualChannels: 2
    },
    {
      label: 'WASAPI Exclusive format matrix s24/96k/2ch',
      actualOutputFormat: 'int24',
      actualSampleRate: 96000,
      actualBitDepth: 24,
      actualChannels: 2
    },
    {
      label: 'WASAPI Exclusive format matrix s32/48k/2ch',
      actualOutputFormat: 'int32',
      actualSampleRate: 48000,
      actualBitDepth: 32,
      actualChannels: 2
    },
    {
      label: 'WASAPI Exclusive format matrix f32/48k/2ch',
      actualOutputFormat: 'float32',
      actualSampleRate: 48000,
      actualBitDepth: 32,
      actualChannels: 2
    }
  ]
}

function matrixProbeMatchesActual(probeFormat, info) {
  return (
    info.actualOutputFormat === probeFormat.actualOutputFormat &&
    info.actualSampleRate === probeFormat.actualSampleRate &&
    info.actualBitDepth === probeFormat.actualBitDepth &&
    info.actualChannels === probeFormat.actualChannels
  )
}

function assertMatrixHonesty(label, info, probeFormat) {
  if (info.outputPerfect) {
    expect(
      info.pcmPassthrough === true,
      `${label}: outputPerfect=true must also report pcmPassthrough=true`
    )
    expect(!info.perfectReasonCode, `${label}: outputPerfect=true must clear perfectReasonCode`)
    expect(
      matrixProbeMatchesActual(probeFormat, info),
      `${label}: outputPerfect=true but probe and actual output formats differ`
    )
    return
  }

  expect(
    Boolean(info.perfectReasonCode),
    `${label}: non-perfect matrix probe must report perfectReasonCode`
  )
  if (matrixProbeMatchesActual(probeFormat, info)) {
    throw new Error(
      `${label}: exact matrix probe was not outputPerfect; reason=${info.perfectReasonCode}`
    )
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeStop(audio) {
  try {
    audio.Stop()
  } catch (_) {
    // Best-effort cleanup after a failed open/start.
  }
}

function cleanupTempDir(tempDir) {
  try {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100
    })
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error && error.code)) throw error
  }
}

function resetProcessing(audio, volume) {
  audio.SetVolume(volume)
  audio.SetReplayGainMode('off', 0, 0, true)
  audio.SetEqBands(JSON.stringify({ enabled: false, bands: [] }))
  audio.SetCrossfeedStrength(0)
  audio.SetDspConfig(JSON.stringify({ crossfadeSeconds: 0 }))
}

async function runPlayback({ audio, label, backend, device, source, buffer, durationMs, volume }) {
  safeStop(audio)
  resetProcessing(audio, volume)
  audio.SetOutputBackend(backend)
  audio.SetOutputDevice(device.id)
  audio.SetOutputConfig(JSON.stringify({ preferredBufferSize: buffer, routingMode: 'auto' }))
  audio.Play(source, 0)
  await sleep(durationMs)
  const info = compactPlaybackInfo(parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo'))
  safeStop(audio)

  if (backend === 'wasapi') assertShared(label, info, device)
  else if (backend === 'wasapi-exclusive') assertExclusive(label, info, device)
  else throw new Error(`${label}: unsupported backend ${backend}`)

  return { ok: true, label, backend, requestedBufferSize: buffer, volume, source, info }
}

async function runBitPerfectProbe({
  audio,
  device,
  buffer,
  durationMs,
  expectBitPerfect,
  probeFormat
}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-wasapi-'))
  const encoding = wavEncodingForOutputFormat(probeFormat)
  const source = path.join(
    tempDir,
    `wasapi-silence-${encoding.suffix}-${probeFormat.actualSampleRate}hz-${probeFormat.actualChannels}ch.wav`
  )
  const writtenProbeFormat = writeSilenceWav(source, probeFormat)

  const label = 'WASAPI Exclusive bit-perfect probe'
  try {
    const result = await runPlayback({
      audio,
      label,
      backend: 'wasapi-exclusive',
      device,
      source,
      buffer,
      durationMs,
      volume: 1
    })
    if (expectBitPerfect) {
      expect(
        result.info.pcmPassthrough === true,
        `${label}: expected pcmPassthrough=true, got ${result.info.pcmPassthrough}`
      )
      expect(
        result.info.outputPerfect === true,
        `${label}: expected outputPerfect=true, got ${result.info.outputPerfect}`
      )
      expect(
        !result.info.perfectReasonCode,
        `${label}: expected empty perfectReasonCode, got ${result.info.perfectReasonCode}`
      )
    }
    result.expectBitPerfect = expectBitPerfect
    result.probeFormat = writtenProbeFormat
    return result
  } finally {
    safeStop(audio)
    cleanupTempDir(tempDir)
  }
}

async function runFormatMatrix({ audio, device, buffer, durationMs }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-wasapi-matrix-'))
  const results = []
  try {
    for (const probeFormat of staticFormatMatrix()) {
      const encoding = wavEncodingForOutputFormat(probeFormat)
      const source = path.join(
        tempDir,
        `wasapi-matrix-${encoding.suffix}-${probeFormat.actualSampleRate}hz-${probeFormat.actualChannels}ch.wav`
      )
      const writtenProbeFormat = writeSilenceWav(source, probeFormat)
      try {
        const result = await runPlayback({
          audio,
          label: probeFormat.label,
          backend: 'wasapi-exclusive',
          device,
          source,
          buffer,
          durationMs,
          volume: 1
        })
        assertMatrixHonesty(probeFormat.label, result.info, probeFormat)
        result.probeFormat = writtenProbeFormat
        result.matrixExactMatch = matrixProbeMatchesActual(probeFormat, result.info)
        results.push(result)
      } catch (error) {
        safeStop(audio)
        let info = null
        let lastError = null
        try {
          info = compactPlaybackInfo(parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo'))
        } catch (_) {}
        try {
          lastError = parseJson(audio.GetLastError(), 'GetLastError')
        } catch (_) {}
        results.push({
          ok: false,
          label: probeFormat.label,
          backend: 'wasapi-exclusive',
          error: error && error.message,
          info,
          lastError,
          probeFormat: writtenProbeFormat
        })
      }
    }
    return results
  } finally {
    safeStop(audio)
    cleanupTempDir(tempDir)
  }
}

function printHumanSummary(summary) {
  console.log(`Native module: ${summary.modulePath}`)
  console.log(`Selected device: ${summary.device.label}`)
  console.log(`Endpoint id: ${summary.device.id}`)
  console.log('')
  for (const result of summary.results) {
    const status = result.ok ? 'PASS' : 'FAIL'
    console.log(`${status} ${result.label}`)
    if (result.info) {
      const latency = result.info.latencyInfo || {}
      console.log(
        `  backend=${result.info.actualBackend} access=${result.info.accessMode} format=${result.info.actualOutputFormat}/${result.info.actualBitDepth}bit/${result.info.actualSampleRate}Hz/${result.info.actualChannels}ch`
      )
      if (result.probeFormat) {
        console.log(
          `  probe=${result.probeFormat.wavEncoding}/${result.probeFormat.actualSampleRate}Hz/${result.probeFormat.actualChannels}ch`
        )
      }
      if (typeof result.matrixExactMatch === 'boolean') {
        console.log(`  matrixExactMatch=${result.matrixExactMatch}`)
      }
      console.log(
        `  buffer=${result.info.bufferSizeFrames} frames latency=${latency.totalLatencyMs}ms outputPerfect=${result.info.outputPerfect} reason=${result.info.perfectReasonCode || '(none)'}`
      )
    }
    if (result.error) console.log(`  error=${result.error}`)
  }
}

function workerTimeoutMs(options) {
  const probeCount =
    2 +
    (options.skipBitPerfectProbe ? 0 : 1) +
    (options.formatMatrix ? staticFormatMatrix().length : 0)
  return Math.max(30000, probeCount * options.durationMs + 10000)
}

function runInIsolatedWorker(options) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--worker')
  const child = spawn(process.execPath, [__filename, '--worker', ...args], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let stderr = ''
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(reject, new Error(`WASAPI smoke worker timed out after ${workerTimeoutMs(options)}ms`))
    }, workerTimeoutMs(options))

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('message', (message) => {
      child.kill()
      if (message && message.type === 'summary') {
        finish(resolve, message.summary)
      } else {
        finish(
          reject,
          new Error(
            message && message.error ? message.error : 'WASAPI smoke worker returned no summary'
          )
        )
      }
    })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) => {
      if (settled) return
      const detail = stderr.trim()
      finish(
        reject,
        new Error(
          `WASAPI smoke worker exited before returning a result (code=${code}, signal=${signal || 'none'})${detail ? `: ${detail}` : ''}`
        )
      )
    })
  })
}

async function runWorker(options) {
  const { audio, modulePath } = loadNative(options.modulePath)
  const devices = parseJson(audio.EnumerateDevices(), 'EnumerateDevices')
  const device = resolveDevice(devices, options.device)
  const toneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-wasapi-tone-'))
  try {
    const tonePath = path.join(toneDir, 'wasapi-hardware-smoke-tone.wav')
    writeHardwareSmokeTone(tonePath)

    const results = []
    let exclusiveProbeFormat = null
    for (const test of [
      {
        label: 'WASAPI Shared hardware smoke',
        backend: 'wasapi',
        source: tonePath,
        volume: options.volume
      },
      {
        label: 'WASAPI Exclusive hardware smoke',
        backend: 'wasapi-exclusive',
        source: tonePath,
        volume: options.volume
      }
    ]) {
      try {
        const result = await runPlayback({
          audio,
          label: test.label,
          backend: test.backend,
          device,
          source: test.source,
          buffer: test.backend === 'wasapi-exclusive' ? options.buffer : 0,
          durationMs: options.durationMs,
          volume: test.volume
        })
        results.push(result)
        if (test.backend === 'wasapi-exclusive') {
          exclusiveProbeFormat = probeFormatFromExclusiveInfo(result.info)
        }
      } catch (error) {
        safeStop(audio)
        let info = null
        let lastError = null
        try {
          info = compactPlaybackInfo(parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo'))
        } catch (_) {}
        try {
          lastError = parseJson(audio.GetLastError(), 'GetLastError')
        } catch (_) {}
        results.push({
          ok: false,
          label: test.label,
          backend: test.backend,
          error: error && error.message,
          info,
          lastError
        })
      }
    }

    if (!options.skipBitPerfectProbe) {
      try {
        results.push(
          await runBitPerfectProbe({
            audio,
            device,
            buffer: options.buffer,
            durationMs: options.durationMs,
            expectBitPerfect: options.expectBitPerfect,
            probeFormat: exclusiveProbeFormat
          })
        )
      } catch (error) {
        safeStop(audio)
        let info = null
        let lastError = null
        try {
          info = compactPlaybackInfo(parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo'))
        } catch (_) {}
        try {
          lastError = parseJson(audio.GetLastError(), 'GetLastError')
        } catch (_) {}
        results.push({
          ok: false,
          label: 'WASAPI Exclusive bit-perfect probe',
          backend: 'wasapi-exclusive',
          error: error && error.message,
          info,
          lastError,
          expectBitPerfect: options.expectBitPerfect
        })
      }
    }

    if (options.formatMatrix) {
      results.push(
        ...(await runFormatMatrix({
          audio,
          device,
          buffer: options.buffer,
          durationMs: options.durationMs
        }))
      )
    }

    const summary = {
      modulePath,
      deviceSelector: options.device,
      device,
      options: {
        buffer: options.buffer,
        durationMs: options.durationMs,
        volume: options.volume,
        expectBitPerfect: options.expectBitPerfect,
        skipBitPerfectProbe: options.skipBitPerfectProbe,
        formatMatrix: options.formatMatrix
      },
      results
    }

    if (typeof process.send === 'function') process.send({ type: 'summary', summary })
    else if (options.json) console.log(JSON.stringify(summary, null, 2))
    else printHumanSummary(summary)
  } finally {
    cleanupTempDir(toneDir)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (!options.device) throw new Error('Missing --device.\n' + usage())

  if (options.worker) {
    await runWorker(options)
    return
  }

  const summary = await runInIsolatedWorker(options)
  summary.execution = { isolatedWorker: true, workerTermination: 'forced-after-result' }
  if (options.json) console.log(JSON.stringify(summary, null, 2))
  else printHumanSummary(summary)
  if (summary.results.some((result) => !result.ok)) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error)
    if (typeof process.send === 'function') process.send({ type: 'error', error: message })
    else console.error(message)
    process.exitCode = 1
  })
}

module.exports = {
  cleanupTempDir,
  parseArgs,
  staticFormatMatrix,
  workerTimeoutMs
}
