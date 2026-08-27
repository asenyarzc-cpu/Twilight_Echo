const fs = require('node:fs')
const { spawn } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

const AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aiff',
  '.dff',
  '.dsf',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav'
])

function usage() {
  return [
    'Usage:',
    '  pnpm run smoke:audio-format-matrix -- --manifest D:\\fixtures\\matrix.json --json',
    '  pnpm run smoke:audio-format-matrix -- --fixture-dir D:\\fixtures --playback --backend wasapi-exclusive --device "My DAC"',
    '',
    'Options:',
    '  --manifest <path>           Fixture manifest JSON. Defaults to TAE_AUDIO_FIXTURE_MANIFEST.',
    '  --fixture-dir <dir>         Directory scan fallback. Defaults to TAE_AUDIO_FIXTURES_DIR.',
    '  --playback                  Run native playback probes in addition to metadata checks.',
    '  --backend <id>              Playback backend: wasapi, wasapi-exclusive, asio, coreaudio, alsa. Default: wasapi-exclusive.',
    '  --device <name-or-id>       Device selector. Required for playback unless backend can use auto intentionally.',
    '  --buffer <frames>           Preferred backend buffer size. Default: 256.',
    '  --duration-ms <ms>          Playback duration per fixture. Default: 1200.',
    '  --module <path>             Native twilight_audio_node.node path. Defaults to TAE_AUDIO_NODE or build outputs.',
    '  --json                      Print JSON only.',
    '  --help                      Show this help.'
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    manifest: process.env.TAE_AUDIO_FIXTURE_MANIFEST || '',
    fixtureDir: process.env.TAE_AUDIO_FIXTURES_DIR || '',
    playback: false,
    backend: process.env.TAE_AUDIO_MATRIX_BACKEND || 'wasapi-exclusive',
    device: process.env.TAE_AUDIO_MATRIX_DEVICE || '',
    buffer: Number(process.env.TAE_AUDIO_MATRIX_BUFFER || 256),
    durationMs: Number(process.env.TAE_AUDIO_MATRIX_DURATION_MS || 1200),
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
    if (arg === '--manifest') options.manifest = next()
    else if (arg === '--fixture-dir') options.fixtureDir = next()
    else if (arg === '--playback') options.playback = true
    else if (arg === '--backend') options.backend = next()
    else if (arg === '--device') options.device = next()
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
  if (!Number.isFinite(options.durationMs) || options.durationMs < 100)
    throw new Error('--duration-ms must be at least 100')
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
  process.env.PATH = `${path.dirname(selected)}${path.delimiter}${process.env.PATH || ''}`
  return { audio: require(selected), modulePath: selected }
}

function parseJson(raw, context) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error && error.message}`)
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveDevice(devices, selector) {
  if (!selector || selector === 'auto')
    return devices.find((device) => device.id === 'auto') || { id: 'auto', label: 'auto' }
  const exact = devices.filter(
    (device) => device.id === selector || device.label === selector || device.name === selector
  )
  if (exact.length === 1) return exact[0]
  const query = normalizeText(selector)
  const fuzzy = devices.filter(
    (device) =>
      normalizeText(device.id).includes(query) ||
      normalizeText(device.label).includes(query) ||
      normalizeText(device.name).includes(query)
  )
  if (fuzzy.length === 1) return fuzzy[0]
  const list = devices
    .map((device) => `  - ${device.label || device.name || device.id} | id=${device.id}`)
    .join('\n')
  if (fuzzy.length === 0)
    throw new Error(`No device matched "${selector}". Available devices:\n${list}`)
  throw new Error(`Device selector "${selector}" matched multiple devices:\n${list}`)
}

function sourceWithSacdQuery(source, fixture) {
  const area = fixture.area || fixture.sacdArea
  const track = fixture.track ?? fixture.sacdTrack
  if (!area && !track) return source
  const separator = source.includes('?') ? '&' : '?'
  const parts = []
  if (area) parts.push(`area=${encodeURIComponent(area)}`)
  if (track !== undefined && track !== null)
    parts.push(`track=${encodeURIComponent(String(track))}`)
  return `${source}${separator}${parts.join('&')}`
}

function normalizeFixture(raw, index, baseDir) {
  const candidate = typeof raw === 'string' ? { path: raw } : { ...raw }
  const rawPath = candidate.path || candidate.source || candidate.file
  if (!rawPath) throw new Error(`Fixture ${index} is missing path/source/file`)
  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath)
  const source = sourceWithSacdQuery(resolvedPath, candidate)
  return {
    id: candidate.id || candidate.label || path.basename(resolvedPath),
    label: candidate.label || candidate.id || path.basename(source),
    path: resolvedPath,
    source,
    format: candidate.format || path.extname(resolvedPath).slice(1).toLowerCase(),
    codec: candidate.codec || '',
    sampleRate: Number(candidate.sampleRate || 0),
    bitDepth: Number(candidate.bitDepth || 0),
    channelCount: Number(candidate.channelCount || candidate.channels || 0),
    dsdRate: Number(candidate.dsdRate || 0),
    area: candidate.area || candidate.sacdArea || '',
    track: candidate.track ?? candidate.sacdTrack ?? null,
    isDst:
      candidate.isDst === true ||
      candidate.dst === true ||
      normalizeText(candidate.codec) === 'dst',
    expectPlayable: candidate.playable,
    expectedOutputMode: candidate.expectedOutputMode || candidate.outputMode || '',
    expectedReasonCode: candidate.expectedReasonCode || candidate.reasonCode || '',
    raw: candidate
  }
}

function loadManifest(manifestPath) {
  const resolved = path.resolve(manifestPath)
  const document = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  const list = Array.isArray(document)
    ? document
    : document.fixtures || document.matrix || document.samples
  if (!Array.isArray(list))
    throw new Error('Fixture manifest must be an array or contain fixtures/matrix/samples array')
  return list.map((fixture, index) => normalizeFixture(fixture, index, path.dirname(resolved)))
}

function scanFixtureDir(fixtureDir) {
  const rootDir = path.resolve(fixtureDir)
  const fixtures = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        fixtures.push(full)
      if (fixtures.length >= 256) return
    }
  }
  walk(rootDir)
  fixtures.sort()
  return fixtures.map((file, index) => normalizeFixture({ path: file }, index, rootDir))
}

function assertEqual(errors, actual, expected, label) {
  if (expected === undefined || expected === null || expected === '' || expected === 0) return
  if (actual !== expected) errors.push(`${label}: expected ${expected}, got ${actual}`)
}

function pickSacdTrack(metadata, fixture) {
  if (!Array.isArray(metadata.isoTracks) || metadata.isoTracks.length === 0) return null
  if (!fixture.area && fixture.track === null) return metadata.isoTracks[0]
  return (
    metadata.isoTracks.find((track) => {
      const source = String(track.source || '')
      const areaOk = !fixture.area || source.includes(`area=${fixture.area}`)
      const trackOk = fixture.track === null || source.includes(`track=${fixture.track}`)
      return areaOk && trackOk
    }) || null
  )
}

function runMetadataProbe(audio, fixture) {
  const metadata = parseJson(audio.GetMetadata(fixture.path), `GetMetadata(${fixture.label})`)
  const selected = /\.iso$/i.test(fixture.path)
    ? pickSacdTrack(metadata, fixture) || metadata
    : metadata
  const errors = []
  if (!fs.existsSync(fixture.path)) errors.push(`missing file: ${fixture.path}`)
  assertEqual(errors, selected.sampleRate, fixture.sampleRate, 'sampleRate')
  assertEqual(errors, selected.bitDepth, fixture.bitDepth, 'bitDepth')
  assertEqual(errors, selected.channelCount, fixture.channelCount, 'channelCount')
  assertEqual(errors, selected.dsdRate, fixture.dsdRate, 'dsdRate')
  if (fixture.codec && normalizeText(selected.codec) !== normalizeText(fixture.codec)) {
    errors.push(`codec: expected ${fixture.codec}, got ${selected.codec}`)
  }
  if (fixture.expectPlayable !== undefined && selected.playable !== fixture.expectPlayable) {
    errors.push(`playable: expected ${fixture.expectPlayable}, got ${selected.playable}`)
  }
  if (fixture.expectedReasonCode && selected.reasonCode !== fixture.expectedReasonCode) {
    errors.push(`reasonCode: expected ${fixture.expectedReasonCode}, got ${selected.reasonCode}`)
  }
  if (fixture.isDst) {
    if (selected.codec !== 'dst')
      errors.push(`DST fixture expected codec=dst, got ${selected.codec}`)
    if (
      selected.reasonCode !== 'dst_dsd_provider_unavailable' &&
      fixture.expectedReasonCode !== 'dst_dsd_provider_failed'
    ) {
      errors.push(
        `DST fixture must report DSD-preserving provider state, got ${selected.reasonCode || '(empty)'}`
      )
    }
  }
  return {
    ok: errors.length === 0,
    fixture: fixture.label,
    source: fixture.source,
    selected,
    metadata,
    errors
  }
}

function compactPlaybackInfo(info) {
  const output = info.outputInfo || {}
  return {
    state: info.state,
    source: info.source,
    codec: info.codec,
    isDsd: output.isDsd ?? info.isDsd,
    dsdMode: output.dsdMode || info.dsdMode,
    dsdRate: output.dsdRate || info.dsdRate,
    actualBackend: output.actualBackend || info.actualBackend,
    actualOutputFormat: output.actualOutputFormat || info.actualOutputFormat,
    actualSampleRate: output.actualSampleRate || info.actualSampleRate,
    actualBitDepth: output.actualBitDepth || info.actualBitDepth,
    actualChannels: output.actualChannels || info.actualChannels,
    accessMode: output.accessMode,
    outputPerfect: output.outputPerfect,
    sourceExact: output.sourceExact,
    pcmPassthrough: output.pcmPassthrough,
    perfectReasonCode: output.perfectReasonCode || info.perfectReasonCode,
    perfectReason: output.perfectReason || info.perfectReason,
    latencyInfo: output.latencyInfo,
    diagnostics: output.diagnostics || {}
  }
}

function safeStop(audio) {
  try {
    audio.Stop()
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dsdModeForFixture(fixture) {
  const mode = normalizeText(fixture.expectedOutputMode)
  if (mode === 'native' || mode === 'dop' || mode === 'pcm') return mode
  return 'auto'
}

async function runPlaybackProbe(audio, fixture, options, device) {
  const errors = []
  let info = null
  let lastError = null
  safeStop(audio)
  try {
    audio.SetVolume(1)
    audio.SetReplayGainMode('off', 0, 0, true)
    audio.SetEqBands(JSON.stringify({ enabled: false, bands: [] }))
    audio.SetCrossfeedStrength(0)
    audio.SetDspConfig(
      JSON.stringify({
        enabled: false,
        dsdOutputMode: dsdModeForFixture(fixture),
        crossfadeSeconds: 0
      })
    )
    audio.SetOutputBackend(options.backend)
    audio.SetOutputDevice(device.id)
    audio.SetOutputConfig(
      JSON.stringify({ preferredBufferSize: options.buffer, routingMode: 'auto' })
    )
    audio.Play(fixture.source, 0)
    await sleep(options.durationMs)
    info = compactPlaybackInfo(parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo'))

    if (fixture.expectedOutputMode)
      assertEqual(errors, info.dsdMode, fixture.expectedOutputMode, 'dsdMode')
    if (fixture.expectedReasonCode)
      assertEqual(errors, info.perfectReasonCode, fixture.expectedReasonCode, 'perfectReasonCode')
    if (fixture.sampleRate && !fixture.isDst && info.actualSampleRate <= 0)
      errors.push('actualSampleRate missing')
    if (!info.actualBackend) errors.push('actualBackend missing')
    const diagnostics = info.diagnostics || {}
    if (diagnostics.lastError) errors.push(`diagnostics.lastError=${diagnostics.lastError}`)
  } catch (error) {
    errors.push(error && error.message ? error.message : String(error))
    try {
      info = compactPlaybackInfo(parseJson(audio.GetPlaybackInfo(), 'GetPlaybackInfo'))
    } catch (_) {}
    try {
      lastError = parseJson(audio.GetLastError(), 'GetLastError')
    } catch (_) {}
  } finally {
    safeStop(audio)
  }
  return {
    ok: errors.length === 0,
    fixture: fixture.label,
    source: fixture.source,
    backend: options.backend,
    device,
    info,
    lastError,
    errors
  }
}

function printHumanSummary(summary) {
  console.log(`Native module: ${summary.modulePath}`)
  console.log(`Fixtures: ${summary.fixtures.length}`)
  if (summary.playback) {
    console.log(
      `Playback: backend=${summary.options.backend} device=${summary.device.label || summary.device.id}`
    )
  }
  for (const result of summary.results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.fixture}`)
    if (result.selected) {
      console.log(
        `  metadata codec=${result.selected.codec || '(unknown)'} sr=${result.selected.sampleRate || 0} bit=${result.selected.bitDepth || 0} ch=${result.selected.channelCount || 0} playable=${result.selected.playable}`
      )
      if (result.selected.reasonCode) console.log(`  reasonCode=${result.selected.reasonCode}`)
    }
    if (result.info) {
      const latency = result.info.latencyInfo || {}
      console.log(
        `  playback backend=${result.info.actualBackend || '(none)'} format=${result.info.actualOutputFormat || '(none)'}/${result.info.actualSampleRate || 0}Hz/${result.info.actualChannels || 0}ch outputPerfect=${result.info.outputPerfect} reason=${result.info.perfectReasonCode || '(none)'} latency=${latency.totalLatencyMs ?? 0}ms`
      )
    }
    for (const error of result.errors || []) console.log(`  error=${error}`)
  }
}

function runAsioInIsolatedWorker() {
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
      finish(reject, new Error('ASIO playback worker timed out after 30000ms'))
    }, 30000)

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('message', (message) => {
      child.kill()
      if (message && message.type === 'summary') {
        finish(resolve, message.summary)
      } else {
        finish(reject, new Error(message?.error || 'ASIO playback worker returned no summary'))
      }
    })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) => {
      if (settled) return
      const detail = stderr.trim()
      finish(
        reject,
        new Error(
          `ASIO playback worker exited before returning a result (code=${code}, signal=${signal || 'none'})${detail ? `: ${detail}` : ''}`
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

  if (options.playback && options.backend === 'asio' && !options.worker) {
    const summary = await runAsioInIsolatedWorker()
    summary.execution = { isolatedWorker: true, workerTermination: 'forced-after-result' }
    if (options.json) console.log(JSON.stringify(summary, null, 2))
    else printHumanSummary(summary)
    if (summary.results.some((result) => !result.ok)) process.exitCode = 1
    return
  }

  let fixtures = []
  if (options.manifest) fixtures = loadManifest(options.manifest)
  else if (options.fixtureDir) fixtures = scanFixtureDir(options.fixtureDir)
  else throw new Error('Missing --manifest or --fixture-dir.\n' + usage())
  if (fixtures.length === 0) throw new Error('No audio fixtures found')

  const { audio, modulePath } = loadNative(options.modulePath)
  let device = null
  if (options.playback) {
    const devices = parseJson(audio.EnumerateDevices(), 'EnumerateDevices')
    device = resolveDevice(devices, options.device || 'auto')
  }

  const results = []
  for (const fixture of fixtures) {
    const metadataResult = runMetadataProbe(audio, fixture)
    if (options.playback && metadataResult.ok && metadataResult.selected?.playable !== false) {
      const playbackResult = await runPlaybackProbe(audio, fixture, options, device)
      results.push({
        ...metadataResult,
        playback: playbackResult,
        info: playbackResult.info,
        errors: [...metadataResult.errors, ...playbackResult.errors],
        ok: playbackResult.ok
      })
    } else {
      results.push(metadataResult)
    }
  }

  const summary = {
    modulePath,
    manifest: options.manifest || null,
    fixtureDir: options.fixtureDir || null,
    playback: options.playback,
    options: {
      backend: options.backend,
      buffer: options.buffer,
      durationMs: options.durationMs
    },
    device,
    fixtures,
    results
  }

  if (options.worker && typeof process.send === 'function')
    process.send({ type: 'summary', summary })
  else if (options.json) console.log(JSON.stringify(summary, null, 2))
  else printHumanSummary(summary)
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
