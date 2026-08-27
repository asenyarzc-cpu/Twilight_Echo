const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

const dsdRateByName = new Map([
  ['dsd64', 2822400],
  ['d64', 2822400],
  ['64fs', 2822400],
  ['dsd128', 5644800],
  ['d128', 5644800],
  ['128fs', 5644800],
  ['dsd256', 11289600],
  ['d256', 11289600],
  ['256fs', 11289600],
  ['dsd512', 22579200],
  ['d512', 22579200],
  ['512fs', 22579200]
])

function usage() {
  return [
    'Usage:',
    '  pnpm run smoke:asio-native-dsd -- --device "My ASIO DAC" --fixture-dir D:\\DSDFixtures',
    '  node scripts/asio-native-dsd-smoke.cjs --device "asio:Driver Name" --fixture D:\\test-dsd64.dsf',
    '',
    'Options:',
    '  --device <name-or-id>       Required unless TAE_ASIO_DEVICE is set.',
    '  --fixture <path>            DSF/DFF fixture. Can be passed multiple times.',
    '  --fixture-dir <dir>         Directory containing DSF/DFF fixtures.',
    '  --buffer <frames>           ASIO preferred buffer size. Default: 256.',
    '  --duration-ms <ms>          Playback duration per rate. Default: 1800.',
    '  --module <path>             Native twilight_audio_node.node path.',
    '  --json                      Print JSON only.',
    '  --help                      Show this help.'
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    device: process.env.TAE_ASIO_DEVICE || '',
    fixtures: [],
    fixtureDir: process.env.TAE_ASIO_DSD_FIXTURE_DIR || '',
    buffer: Number(process.env.TAE_ASIO_BUFFER || 256),
    durationMs: Number(process.env.TAE_ASIO_DURATION_MS || 1800),
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
    else if (arg === '--fixture') options.fixtures.push(next())
    else if (arg === '--fixture-dir') options.fixtureDir = next()
    else if (arg === '--buffer') options.buffer = Number(next())
    else if (arg === '--duration-ms') options.durationMs = Number(next())
    else if (arg === '--module') options.modulePath = next()
    else if (arg === '--json') options.json = true
    else if (arg === '--worker') options.worker = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (!Number.isFinite(options.buffer) || options.buffer < 0)
    throw new Error('--buffer must be non-negative')
  if (!Number.isFinite(options.durationMs) || options.durationMs < 250) {
    throw new Error('--duration-ms must be at least 250')
  }
  return options
}

function loadNative(modulePath) {
  const candidates = [
    modulePath,
    path.join(root, 'audio-engine', 'build', 'mingw-static', 'twilight_audio_node.node'),
    path.join(root, 'audio-engine', 'build', 'default', 'twilight_audio_node.node'),
    path.join(root, 'resources', 'audio-engine', 'twilight_audio_node.node'),
    path.join(root, 'out', 'renderer', 'audio-engine', 'twilight_audio_node.node')
  ].filter(Boolean)
  const selected = candidates.find((candidate) => fs.existsSync(candidate))
  if (!selected)
    throw new Error('Cannot find twilight_audio_node.node. Build the native engine first.')
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

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveDevice(devices, query) {
  const asioDevices = devices.filter(
    (device) => device.backend === 'asio' || String(device.id || '').startsWith('asio:')
  )
  const exact = asioDevices.filter(
    (device) => device.id === query || device.label === query || device.name === query
  )
  if (exact.length === 1) return exact[0]
  const q = normalize(query)
  const fuzzy = asioDevices.filter(
    (device) =>
      normalize(device.id).includes(q) || normalize(device.label || device.name).includes(q)
  )
  if (fuzzy.length === 1) return fuzzy[0]
  const list = asioDevices
    .map((device) => `  - ${device.label || device.name} | id=${device.id}`)
    .join('\n')
  if (fuzzy.length === 0)
    throw new Error(`No ASIO device matched "${query}". Available ASIO devices:\n${list}`)
  throw new Error(`Device selector "${query}" matched multiple ASIO devices:\n${list}`)
}

function inferDsdRate(filePath) {
  const name = path
    .basename(filePath)
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  for (const [token, rate] of dsdRateByName) {
    if (name.includes(token)) return rate
  }
  return 0
}

function collectFixtures(options) {
  const files = [...options.fixtures]
  if (options.fixtureDir) {
    for (const entry of fs.readdirSync(options.fixtureDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const full = path.join(options.fixtureDir, entry.name)
      if (/\.(dsf|dff)$/i.test(full)) files.push(full)
    }
  }
  const byRate = new Map()
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`Missing fixture: ${file}`)
    if (!/\.(dsf|dff)$/i.test(file)) continue
    const rate = inferDsdRate(file)
    if (rate > 0 && !byRate.has(rate)) byRate.set(rate, file)
  }
  return byRate
}

function safeStop(audio) {
  try {
    audio.Stop()
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function compactInfo(info) {
  const output = info.outputInfo || {}
  return {
    state: info.state,
    source: info.source,
    isDsd: info.isDsd,
    dsdMode: output.dsdMode || info.dsdMode,
    dsdRate: output.dsdRate || info.dsdRate,
    outputPerfect: output.outputPerfect,
    sourceExact: output.sourceExact,
    perfectReasonCode: output.perfectReasonCode,
    perfectReason: output.perfectReason,
    actualBackend: output.actualBackend || info.actualBackend,
    deviceName: output.actualDeviceName || output.deviceName,
    actualOutputFormat: output.actualOutputFormat,
    actualSampleRate: output.actualSampleRate,
    actualBitDepth: output.actualBitDepth,
    actualChannels: output.actualChannels,
    bufferSizeFrames: output.bufferSizeFrames,
    latencyInfo: output.latencyInfo,
    nativeDsdRuntimeState: output.nativeDsdRuntimeState,
    nativeDsdRequestedRate: output.nativeDsdRequestedRate,
    nativeDsdActualRate: output.nativeDsdActualRate,
    nativeDsdRuntimeReason: output.nativeDsdRuntimeReason,
    diagnostics: output.diagnostics || {}
  }
}

function assertNativeDsd(label, info, rate) {
  expect(
    info.actualBackend === 'asio',
    `${label}: expected ASIO backend, got ${info.actualBackend}`
  )
  expect(info.dsdMode === 'native', `${label}: expected dsdMode=native, got ${info.dsdMode}`)
  expect(
    info.nativeDsdRuntimeState === 'proven',
    `${label}: expected nativeDsdRuntimeState=proven, got ${info.nativeDsdRuntimeState}`
  )
  expect(info.nativeDsdRequestedRate === rate, `${label}: requested Native DSD rate mismatch`)
  expect(info.nativeDsdActualRate === rate, `${label}: actual Native DSD rate mismatch`)
  expect(
    info.outputPerfect === true,
    `${label}: expected outputPerfect=true, got ${info.outputPerfect}`
  )
  expect(info.sourceExact === true, `${label}: expected sourceExact=true, got ${info.sourceExact}`)
  expect(
    !info.perfectReasonCode,
    `${label}: expected empty perfectReasonCode, got ${info.perfectReasonCode}`
  )
  const diagnostics = info.diagnostics || {}
  expect(
    (diagnostics.sessionUnderrunCount || 0) === 0,
    `${label}: underruns=${diagnostics.sessionUnderrunCount}`
  )
  expect(
    (diagnostics.sessionBufferDropCount || 0) === 0,
    `${label}: bufferDrops=${diagnostics.sessionBufferDropCount}`
  )
  expect(
    (diagnostics.deviceLostCount || 0) === 0,
    `${label}: deviceLost=${diagnostics.deviceLostCount}`
  )
  expect(!diagnostics.lastError, `${label}: lastError=${diagnostics.lastError}`)
}

async function runRate({ audio, device, rate, fixture, buffer, durationMs }) {
  const label = `ASIO Native DSD ${rate}Hz`
  safeStop(audio)
  audio.SetVolume(1)
  audio.SetReplayGainMode('off', 0, 0, true)
  audio.SetEqBands(JSON.stringify({ enabled: false, bands: [] }))
  audio.SetCrossfeedStrength(0)
  audio.SetDspConfig(
    JSON.stringify({ enabled: false, dsdOutputMode: 'native', crossfadeSeconds: 0 })
  )
  audio.SetOutputBackend('asio')
  audio.SetOutputDevice(device.id)
  audio.SetOutputConfig(JSON.stringify({ preferredBufferSize: buffer, routingMode: 'auto' }))
  audio.Play(fixture, 0)
  await sleep(durationMs)
  const info = compactInfo(parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo'))
  safeStop(audio)
  assertNativeDsd(label, info, rate)
  return { ok: true, label, rate, fixture, info }
}

function printSummary(summary) {
  console.log(`Native module: ${summary.modulePath}`)
  console.log(`ASIO device: ${summary.device.label || summary.device.name}`)
  console.log(`Device id: ${summary.device.id}`)
  console.log(`Advertised Native DSD rates: ${summary.nativeDsdSampleRates.join(', ') || '(none)'}`)
  console.log(`Tested Native DSD rates: ${summary.testRates.join(', ')}`)
  for (const result of summary.results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.label}`)
    if (result.info) {
      console.log(
        `  format=${result.info.actualOutputFormat}/${result.info.actualSampleRate}Hz/${result.info.actualChannels}ch state=${result.info.nativeDsdRuntimeState} outputPerfect=${result.info.outputPerfect}`
      )
      if (result.info.nativeDsdRuntimeReason)
        console.log(`  reason=${result.info.nativeDsdRuntimeReason}`)
    }
    if (result.error) console.log(`  error=${result.error}`)
  }
}

function runInIsolatedWorker() {
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
      finish(reject, new Error('ASIO Native DSD worker timed out after 30000ms'))
    }, 30000)

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('message', (message) => {
      child.kill()
      if (message && message.type === 'summary') finish(resolve, message.summary)
      else finish(reject, new Error(message?.error || 'ASIO Native DSD worker returned no summary'))
    })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) => {
      if (settled) return
      const detail = stderr.trim()
      finish(
        reject,
        new Error(
          `ASIO Native DSD worker exited before returning a result (code=${code}, signal=${signal || 'none'})${detail ? `: ${detail}` : ''}`
        )
      )
    })
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (!options.device) throw new Error('Missing --device.\n' + usage())

  if (!options.worker) {
    const summary = await runInIsolatedWorker()
    summary.execution = { isolatedWorker: true, workerTermination: 'forced-after-result' }
    if (options.json) console.log(JSON.stringify(summary, null, 2))
    else printSummary(summary)
    if (summary.results.some((result) => !result.ok)) process.exitCode = 1
    return
  }

  const { audio, modulePath } = loadNative(options.modulePath)
  const devices = parseJson(audio.EnumerateDevices(), 'EnumerateDevices')
  const device = resolveDevice(devices, options.device)
  const nativeDsdSampleRates = [
    ...new Set(device.nativeDsdSampleRates || device.supportedDsdRates || [])
  ].sort((a, b) => a - b)

  const fixtures = collectFixtures(options)
  const fixtureRates = [...fixtures.keys()].sort((a, b) => a - b)
  const testRates = nativeDsdSampleRates.length > 0 ? nativeDsdSampleRates : fixtureRates
  expect(
    testRates.length > 0,
    'No Native DSD rates to test. Provide DSF/DFF fixtures named with dsd64/dsd128/dsd256/dsd512.'
  )
  const missing = testRates.filter((rate) => !fixtures.has(rate))
  if (missing.length > 0) {
    throw new Error(
      `Missing DSF/DFF fixtures for advertised Native DSD rates: ${missing.join(', ')}`
    )
  }

  const results = []
  for (const rate of testRates) {
    try {
      results.push(
        await runRate({
          audio,
          device,
          rate,
          fixture: fixtures.get(rate),
          buffer: options.buffer,
          durationMs: options.durationMs
        })
      )
    } catch (error) {
      safeStop(audio)
      let info = null
      try {
        info = compactInfo(parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo'))
      } catch (_) {}
      results.push({
        ok: false,
        label: `ASIO Native DSD ${rate}Hz`,
        rate,
        fixture: fixtures.get(rate),
        error: error && error.message,
        info
      })
    }
  }

  const summary = {
    modulePath,
    deviceSelector: options.device,
    device,
    nativeDsdSampleRates,
    testRates,
    results
  }
  if (typeof process.send === 'function') process.send({ type: 'summary', summary })
  else if (options.json) console.log(JSON.stringify(summary, null, 2))
  else printSummary(summary)
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
