const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const FII0_ENDPOINT = '{0.0.0.00000000}.{64bab304-9988-4784-9139-9b470461a8dc}'
const FII0_PNP_INSTANCE = 'USB\\VID_2972&PID_0045&MI_00\\8&20B8252&0&0000'
const OPERATING_SYSTEM_DEFAULT = 'auto'
const SUPPORTED_PROVIDERS = ['legacy', 'miniaudio']
const SUPPORTED_SCENARIOS = ['default-switch', 'hotplug', 'explicit-disappearance']

const POLICY_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
namespace TwilightOperationalPolicy {
  public enum Role { Console = 0, Multimedia = 1, Communications = 2 }
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
  public class Client { }
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Config {
    [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr p);
    [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, bool c, out IntPtr p);
    [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr p, IntPtr e);
    [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, bool s, out long d, out long m);
    [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr p);
    [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr p);
    [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr p);
    [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, bool s, IntPtr p);
    [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, bool s, IntPtr p);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, Role role);
    [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, bool visible);
  }
  public static class Operations {
    public static int SetDefault(string id, Role role) {
      return ((Config)new Client()).SetDefaultEndpoint(id, role);
    }
    public static int SetVisibility(string id, bool visible) {
      return ((Config)new Client()).SetEndpointVisibility(id, visible);
    }
  }
}
`

function usage() {
  return [
    'Usage:',
    '  pnpm run smoke:windows-audio-operational -- --scenario default-switch --provider both --json',
    '  pnpm run smoke:windows-audio-operational -- --scenario explicit-disappearance --provider miniaudio --json',
    '',
    'Runs explicit Windows-only operational checks against the FiiO M series endpoint.',
    'The default-switch check changes the Windows console/multimedia/communications endpoint',
    'temporarily and restores the original endpoint in a finally path.',
    'The hotplug check uses a controlled PnP disable/enable transition; it is not a physical USB unplug.',
    'The explicit-disappearance check hides and restores the non-default FiiO endpoint; it is not a physical USB unplug.',
    '',
    'Options:',
    '  --scenario <name>          default-switch, hotplug, or explicit-disappearance. Default: default-switch.',
    '  --provider <name|both>     legacy, miniaudio, or both. Default: both.',
    '  --device <endpoint-id>     Explicit FiiO endpoint. Default: the known FiiO M series ID.',
    '  --duration-ms <ms>         Playback observation window. Default: 1500.',
    '  --module <path>             Native twilight_audio_node.node path.',
    '  --source <path>             Optional WAV fixture.',
    '  --output <path>             Write a raw JSON receipt.',
    '  --evidence-output <path>    Write an operational evidence envelope when applicable.',
    '  --json                      Print JSON only.',
    '  --help                      Show this help.'
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    scenario: 'default-switch',
    providers: [...SUPPORTED_PROVIDERS],
    device: FII0_ENDPOINT,
    durationMs: 1500,
    modulePath: process.env.TAE_AUDIO_NODE || '',
    source: '',
    output: '',
    evidenceOutput: '',
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
    if (arg === '--scenario') options.scenario = next()
    else if (arg === '--provider') {
      const value = next()
      options.providers = value === 'both' ? [...SUPPORTED_PROVIDERS] : [value]
    } else if (arg === '--device') options.device = next()
    else if (arg === '--duration-ms') options.durationMs = Number(next())
    else if (arg === '--module') options.modulePath = next()
    else if (arg === '--source') options.source = next()
    else if (arg === '--output') options.output = next()
    else if (arg === '--evidence-output') options.evidenceOutput = next()
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (options.help) return options
  if (!SUPPORTED_SCENARIOS.includes(options.scenario)) {
    throw new Error(`--scenario must be one of: ${SUPPORTED_SCENARIOS.join(', ')}`)
  }
  if (options.providers.some((provider) => !SUPPORTED_PROVIDERS.includes(provider))) {
    throw new Error(`--provider must be legacy, miniaudio, or both`)
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs < 500) {
    throw new Error('--duration-ms must be at least 500')
  }
  if (!options.device || options.device === OPERATING_SYSTEM_DEFAULT) {
    throw new Error('--device must be an explicit FiiO endpoint, not auto')
  }
  return options
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function loadNative(modulePath) {
  const candidates = [
    modulePath,
    path.join(root, 'audio-engine', 'build', 'mingw-static', 'twilight_audio_node.node'),
    path.join(root, 'resources', 'audio-engine', 'twilight_audio_node.node'),
    path.join(root, 'out', 'renderer', 'audio-engine', 'twilight_audio_node.node')
  ].filter(Boolean)
  const selected = candidates.find((candidate) => fs.existsSync(candidate))
  if (!selected) throw new Error('Cannot find twilight_audio_node.node')
  process.env.PATH = `${path.dirname(selected)}${path.delimiter}${process.env.PATH || ''}`
  return { audio: require(selected), modulePath: selected }
}

function parseNativeJson(value, label) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`)
  }
}

function enumerateDevices(audio) {
  const devices = parseNativeJson(audio.EnumerateDevices(), 'EnumerateDevices')
  if (!Array.isArray(devices)) throw new Error('EnumerateDevices did not return an array')
  return devices
}

function physicalDefaultId(devices) {
  return (
    devices.find(
      (device) => device.id && device.id !== OPERATING_SYSTEM_DEFAULT && device.isDefault === true
    )?.id || ''
  )
}

function findDevice(devices, selector) {
  const matches = devices.filter((device) => device.id === selector || device.label === selector)
  if (matches.length !== 1) {
    const available = devices
      .map((device) => `${device.label || device.id} (${device.id})`)
      .join(', ')
    throw new Error(
      `Device selector matched ${matches.length} devices: ${selector}; available: ${available}`
    )
  }
  return matches[0]
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function runPowerShell(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { cwd: root, encoding: 'utf8', windowsHide: true }
  )
}

function setWindowsDefaultEndpoint(endpointId) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Add-Type -TypeDefinition @'${POLICY_SOURCE}'@ -ErrorAction Stop`,
    `$endpoint = ${psQuote(endpointId)}`,
    'foreach ($role in [TwilightOperationalPolicy.Role]::Console, [TwilightOperationalPolicy.Role]::Multimedia, [TwilightOperationalPolicy.Role]::Communications) {',
    '  $hr = [TwilightOperationalPolicy.Operations]::SetDefault($endpoint, $role)',
    '  if ($hr -ne 0) { throw "SetDefaultEndpoint failed with HRESULT=$hr" }',
    '}'
  ].join('\n')
  runPowerShell(script)
}

function setEndpointVisibility(endpointId, visible) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Add-Type -TypeDefinition @'${POLICY_SOURCE}'@ -ErrorAction Stop`,
    `$endpoint = ${psQuote(endpointId)}`,
    `$visible = ${visible ? '$true' : '$false'}`,
    '$hr = [TwilightOperationalPolicy.Operations]::SetVisibility($endpoint, $visible)',
    'if ($hr -ne 0) { throw "SetEndpointVisibility failed with HRESULT=$hr" }'
  ].join('\n')
  runPowerShell(script)
}

function setPnpState(instanceId, enabled) {
  const cmd = enabled ? 'Enable-PnpDevice' : 'Disable-PnpDevice'
  const script = [
    '$ErrorActionPreference = "Stop"',
    `${cmd} -InstanceId ${psQuote(instanceId)} -Confirm:$false -ErrorAction Stop | Out-Null`
  ].join('\n')
  runPowerShell(script)
}

function devicePresent(instanceId) {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$device = Get-PnpDevice -InstanceId ${psQuote(instanceId)} -ErrorAction SilentlyContinue`,
    'if ($device -and $device.Status -eq "OK") { exit 0 }',
    'exit 1'
  ].join('\n')
  try {
    runPowerShell(script)
    return true
  } catch {
    return false
  }
}

function compactInfo(info) {
  const output = info?.outputInfo || {}
  const diagnostics = output.diagnostics || info?.diagnostics || {}
  return {
    state: info?.state || '',
    source: info?.source || '',
    actualBackend: output.actualBackend || info?.actualBackend || '',
    actualDeviceId: output.actualDeviceId || '',
    actualDeviceName: output.actualDeviceName || output.deviceName || '',
    providerImplementation: output.providerImplementation || '',
    actualOutputFormat: output.actualOutputFormat || '',
    actualSampleRate: output.actualSampleRate || 0,
    actualBitDepth: output.actualBitDepth || 0,
    actualChannels: output.actualChannels || 0,
    accessMode: output.accessMode || '',
    bufferSizeFrames: output.bufferSizeFrames || 0,
    outputPerfect: output.outputPerfect,
    perfectReasonCode: output.perfectReasonCode || '',
    diagnostics: {
      sessionUnderrunCount: diagnostics.sessionUnderrunCount || 0,
      sessionBufferDropCount: diagnostics.sessionBufferDropCount || 0,
      sessionRecoveryCount: diagnostics.sessionRecoveryCount || 0,
      deviceLostCount: diagnostics.deviceLostCount || 0,
      lastError: diagnostics.lastError || ''
    }
  }
}

function createTone(filePath) {
  const sampleRate = 48000
  const channels = 2
  const seconds = 12
  const blockAlign = channels * 2
  const dataSize = sampleRate * seconds * blockAlign
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
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let frame = 0; frame < sampleRate * seconds; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 3276)
    const offset = 44 + frame * blockAlign
    buffer.writeInt16LE(sample, offset)
    buffer.writeInt16LE(sample, offset + 2)
  }
  fs.writeFileSync(filePath, buffer)
}

async function readManagerInfo(manager) {
  return compactInfo(await manager.getPlaybackInfo())
}

function waitFor(predicate, timeoutMs = 5000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      Promise.resolve()
        .then(predicate)
        .then((value) => {
          if (value) return resolve(value)
          if (Date.now() - started >= timeoutMs)
            return reject(new Error('timed out waiting for state'))
          setTimeout(check, intervalMs)
        })
        .catch(reject)
    }
    check()
  })
}

async function createManager(provider, device, native) {
  process.env.TWILIGHT_AUDIO_SERVICE = '0'
  process.env.TWILIGHT_AUDIO_PCM_PROVIDER = provider
  const { AudioEngineManager } = await import('../src/main/audioEngineManager.ts')
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      volume: 0.02,
      audioOutput: 'wasapi',
      audioDevice: device,
      audioOutputConfig: { preferredBufferSize: 256, routingMode: 'auto' }
    },
    { nativeBinding: native }
  )
  await manager.start()
  return manager
}

function expectedProviderImplementation(provider) {
  return provider === 'miniaudio' ? 'miniaudio' : 'legacy-native'
}

function cleanupTempDir(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    return false
  }
  return true
}

function routeEvents(manager) {
  const events = []
  manager.on('output-route-transaction', (event) => events.push(event))
  manager.on('audio-device-options-changed', (event) =>
    events.push({ type: 'device-options', ...event })
  )
  return events
}

async function startPlayback(manager, source) {
  await manager.play(source, 0)
  await sleep(700)
}

async function runDefaultSwitch(provider, options, native, source, initialDefault, target) {
  const manager = await createManager(provider, 'auto', native)
  const events = routeEvents(manager)
  try {
    await startPlayback(manager, source)
    const before = await readManagerInfo(manager)
    setWindowsDefaultEndpoint(target.id)
    await sleep(500)
    manager.notifyAudioDeviceOptionsChanged('operational-default-switch')
    await waitFor(async () => (await readManagerInfo(manager)).actualDeviceId === target.id)
    const afterTarget = await readManagerInfo(manager)

    setWindowsDefaultEndpoint(initialDefault)
    await sleep(500)
    manager.notifyAudioDeviceOptionsChanged('operational-default-restore')
    await waitFor(async () => (await readManagerInfo(manager)).actualDeviceId === initialDefault)
    const afterRestore = await readManagerInfo(manager)
    const providerFactsMatch = [before, afterTarget, afterRestore].every(
      (info) => info.providerImplementation === expectedProviderImplementation(provider)
    )
    const ok =
      before.actualDeviceId === initialDefault &&
      afterTarget.actualDeviceId === target.id &&
      afterRestore.actualDeviceId === initialDefault &&
      afterTarget.state === 'playing' &&
      afterRestore.state === 'playing' &&
      providerFactsMatch &&
      [before, afterTarget, afterRestore].every(
        (info) => info.actualBackend === 'wasapi' && info.accessMode === 'shared'
      )
    return {
      provider,
      scenario: 'default-switch',
      status: ok ? 'pass' : 'fail',
      ok,
      initialDefault,
      targetDefault: target.id,
      phases: { before, afterTarget, afterRestore },
      providerFactsMatch,
      routeEvents: events,
      notes: ok
        ? 'Console default switched to FiiO and back while Shared playback stayed active.'
        : 'Default switch did not preserve the expected stable endpoint or playback state.'
    }
  } catch (error) {
    return {
      provider,
      scenario: 'default-switch',
      status: 'fail',
      ok: false,
      initialDefault,
      targetDefault: target.id,
      routeEvents: events,
      error: error.message
    }
  } finally {
    await manager.stop().catch(() => undefined)
    manager.destroy()
  }
}

async function runHotplug(provider, options, native, source, device) {
  const manager = await createManager(provider, device.id, native)
  const events = routeEvents(manager)
  let disabled = false
  let before = null
  let afterLoss = null
  let afterReplug = null
  try {
    await startPlayback(manager, source)
    before = await readManagerInfo(manager)
    setPnpState(FII0_PNP_INSTANCE, false)
    disabled = true
    await waitFor(() => !devicePresent(FII0_PNP_INSTANCE), 5000)
    manager.notifyAudioDeviceOptionsChanged('operational-pnp-disable')
    await sleep(1000)
    afterLoss = await readManagerInfo(manager)
    setPnpState(FII0_PNP_INSTANCE, true)
    disabled = false
    await waitFor(() => devicePresent(FII0_PNP_INSTANCE), 10000)
    manager.notifyAudioDeviceOptionsChanged('operational-pnp-enable')
    await sleep(1000)
    afterReplug = await readManagerInfo(manager)
    const providerFactsMatch =
      before.providerImplementation === expectedProviderImplementation(provider)
    const noSilentFallback =
      afterLoss.actualDeviceId === device.id || afterLoss.actualDeviceId === ''
        ? !afterLoss.actualDeviceId || afterLoss.actualDeviceId === device.id
        : false
    const stoppedOrReported =
      afterLoss.state === 'stopped' || Boolean(afterLoss.diagnostics.lastError)
    const ok =
      before.actualDeviceId === device.id &&
      providerFactsMatch &&
      noSilentFallback &&
      stoppedOrReported
    return {
      provider,
      scenario: 'hotplug',
      status: ok ? 'pass' : 'fail',
      ok,
      device: device.id,
      phases: { before, afterLoss, afterReplug },
      providerFactsMatch,
      routeEvents: events,
      notes:
        'Controlled PnP disable/enable on the real FiiO endpoint; this is not physical USB unplug/replug. Explicit-device loss must stop or report failure and must not fall back to Realtek.'
    }
  } catch (error) {
    return {
      provider,
      scenario: 'hotplug',
      status: 'skip',
      ok: false,
      device: device.id,
      phases: { before, afterLoss, afterReplug },
      routeEvents: events,
      error: error.message,
      notes:
        'The controlled PnP transition could not be completed; no physical unplug was inferred.'
    }
  } finally {
    if (disabled) setPnpState(FII0_PNP_INSTANCE, true)
    await manager.stop().catch(() => undefined)
    manager.destroy()
  }
}

async function runExplicitDisappearance(provider, native, source, device) {
  let manager = null
  let hidden = false
  let before = null
  let afterLoss = null
  let afterRestore = null
  let lossError = ''
  let hiddenCatalog = null
  let restoredCatalog = null
  const eventBuckets = []
  const stopManager = async () => {
    if (!manager) return
    await manager.stop().catch(() => undefined)
    manager.destroy()
    manager = null
  }
  try {
    manager = await createManager(provider, device.id, native)
    eventBuckets.push(routeEvents(manager))
    await startPlayback(manager, source)
    before = await readManagerInfo(manager)
    await stopManager()

    setEndpointVisibility(device.id, false)
    hidden = true
    await waitFor(() => !enumerateDevices(native).some((entry) => entry.id === device.id), 5000)
    hiddenCatalog = enumerateDevices(native)

    manager = await createManager(provider, device.id, native)
    eventBuckets.push(routeEvents(manager))
    try {
      await manager.play(source, 0)
      await sleep(700)
    } catch (error) {
      lossError = error.message
    }
    afterLoss = await readManagerInfo(manager)
    await stopManager()

    setEndpointVisibility(device.id, true)
    hidden = false
    await waitFor(() => enumerateDevices(native).some((entry) => entry.id === device.id), 5000)
    restoredCatalog = enumerateDevices(native)

    manager = await createManager(provider, device.id, native)
    eventBuckets.push(routeEvents(manager))
    await startPlayback(manager, source)
    afterRestore = await readManagerInfo(manager)
    const providerFactsMatch =
      before.providerImplementation === expectedProviderImplementation(provider) &&
      afterRestore.providerImplementation === expectedProviderImplementation(provider)
    const noSilentFallback = !afterLoss.actualDeviceId || afterLoss.actualDeviceId === device.id
    const noDefaultFallback = !/Realtek/i.test(afterLoss.actualDeviceName)
    const stoppedOrReported =
      afterLoss.state === 'stopped' || Boolean(afterLoss.diagnostics.lastError)
    const ok =
      before.actualDeviceId === device.id &&
      hiddenCatalog.every((entry) => entry.id !== device.id) &&
      Boolean(lossError) &&
      noSilentFallback &&
      noDefaultFallback &&
      stoppedOrReported &&
      restoredCatalog.some((entry) => entry.id === device.id) &&
      afterRestore.actualDeviceId === device.id &&
      afterRestore.state === 'playing' &&
      providerFactsMatch
    return {
      provider,
      scenario: 'explicit-disappearance',
      status: ok ? 'pass' : 'fail',
      ok,
      device: device.id,
      phases: { before, afterLoss, afterRestore },
      catalog: {
        hidden: hiddenCatalog.map((entry) => entry.id),
        restored: restoredCatalog.map((entry) => entry.id)
      },
      lossError,
      providerFactsMatch,
      noSilentFallback,
      noDefaultFallback,
      stoppedOrReported,
      routeEvents: eventBuckets.flat(),
      notes:
        'Controlled endpoint visibility hide/show on the real FiiO endpoint; this is not physical USB unplug/replug. A missing explicit endpoint must fail closed without falling back to Realtek, then recover only after an explicit reopen.'
    }
  } catch (error) {
    return {
      provider,
      scenario: 'explicit-disappearance',
      status: 'skip',
      ok: false,
      device: device.id,
      phases: { before, afterLoss, afterRestore },
      catalog: {
        hidden: hiddenCatalog ? hiddenCatalog.map((entry) => entry.id) : [],
        restored: restoredCatalog ? restoredCatalog.map((entry) => entry.id) : []
      },
      lossError,
      routeEvents: eventBuckets.flat(),
      error: error.message,
      notes:
        'The controlled endpoint visibility transition could not be completed; no physical unplug or device-loss PASS was inferred.'
    }
  } finally {
    await stopManager()
    if (hidden) setEndpointVisibility(device.id, true)
  }
}

function resolveOperationalContext(native, deviceSelector, scenario) {
  const devices = enumerateDevices(native)
  const selected = findDevice(devices, deviceSelector)
  if (selected.label !== '扬声器 (2- FiiO M series)') {
    throw new Error(`Refusing to run against non-FiiO device: ${selected.label || selected.id}`)
  }
  const initialDefault = physicalDefaultId(devices)
  if (!initialDefault)
    throw new Error('Cannot determine the current Windows console output endpoint')
  const defaultDevice = findDevice(devices, initialDefault)
  const target = initialDefault === selected.id ? defaultDevice : selected
  if (scenario === 'default-switch' && target.id === initialDefault)
    throw new Error('No second active output endpoint is available for default-switch')
  if (scenario === 'explicit-disappearance' && selected.id === initialDefault)
    throw new Error('Refusing to hide the current system default endpoint')
  return { devices, selected, initialDefault, target }
}

function buildProviderChildArgs(options, provider) {
  const args = [
    __filename,
    '--scenario',
    options.scenario,
    '--provider',
    provider,
    '--device',
    options.device,
    '--duration-ms',
    String(options.durationMs),
    '--json'
  ]
  if (options.modulePath) args.push('--module', options.modulePath)
  if (options.source) args.push('--source', options.source)
  return args
}

function runProviderInChild(options, provider) {
  const child = spawnSync(process.execPath, buildProviderChildArgs(options, provider), {
    cwd: root,
    env: {
      ...process.env,
      TWILIGHT_AUDIO_PCM_PROVIDER: provider,
      TAE_OPERATIONAL_PROVIDER_WORKER: '1'
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  const stderr = String(child.stderr || '').trim()
  let summary = null
  try {
    summary = JSON.parse(
      String(child.stdout || '')
        .replace(/^\uFEFF/, '')
        .trim()
    )
  } catch (error) {
    return {
      provider,
      scenario: options.scenario,
      status: 'fail',
      ok: false,
      error: `isolated provider process emitted invalid JSON: ${error.message}; ${stderr}`.trim()
    }
  }
  if (!summary || !Array.isArray(summary.results) || summary.results.length !== 1) {
    return {
      provider,
      scenario: options.scenario,
      status: 'fail',
      ok: false,
      error: 'isolated provider process returned an invalid operational summary'
    }
  }
  const result = summary.results[0]
  if (child.status !== 0 && result.status === 'pass') {
    result.status = 'fail'
    result.ok = false
    result.error = `isolated provider process exited with code ${child.status}${stderr ? `: ${stderr}` : ''}`
  }
  return { summary, result }
}

function rawResultInfo(result) {
  const phases = result.phases || {}
  const all = Object.values(phases).filter(Boolean)
  const last = all[all.length - 1] || {}
  const diagnostics = all.reduce(
    (sum, info) => ({
      underrunCount: sum.underrunCount + Number(info.diagnostics?.sessionUnderrunCount || 0),
      deviceLostCount: sum.deviceLostCount + Number(info.diagnostics?.deviceLostCount || 0)
    }),
    { underrunCount: 0, deviceLostCount: 0 }
  )
  return { last, diagnostics }
}

function relativeArtifact(filePath) {
  const resolved = path.resolve(filePath)
  const relative = path.relative(root, resolved)
  return relative && !relative.startsWith('..') ? relative.replaceAll(path.sep, '/') : resolved
}

function buildOperationalEnvelope(raw, rawPath, result) {
  const details = rawResultInfo(result)
  const artifact = path.resolve(rawPath)
  const scenario = result.scenario || raw.scenario
  const controlledDisappearance = scenario === 'explicit-disappearance'
  const operationalResult = {
    scenario,
    status: result.status === 'pass' ? 'pass' : result.status,
    surface: 'WASAPI Shared',
    device: '扬声器 (2- FiiO M series)',
    driver: 'FiiO M series / Windows USB Audio endpoint',
    format: `${details.last.actualOutputFormat || 'unknown'}/${details.last.actualSampleRate || 0}Hz/${details.last.actualChannels || 0}ch`,
    bufferFrames: Number(details.last.bufferSizeFrames || 256),
    playbackDurationSeconds: Math.max(1, Number(raw.options?.durationMs || 1000) / 1000),
    expectedState: controlledDisappearance
      ? 'controlled explicit endpoint disappearance fails or stops without falling back to the system default, then succeeds after explicit reopen'
      : 'explicit device loss stops or reports failure without falling back to the system default',
    observedState: `${
      controlledDisappearance
        ? 'controlled endpoint visibility hide/show'
        : 'controlled PnP disable/enable'
    }; finalState=${details.last.state || 'unknown'}; actualDeviceId=${details.last.actualDeviceId || '(empty)'}`,
    artifact: relativeArtifact(artifact),
    artifactSha256: sha256(artifact),
    capturedAt: raw.generatedAt,
    inputCommand:
      'pnpm run smoke:windows-audio-operational -- --scenario ' +
      scenario +
      ' --provider ' +
      result.provider +
      ' --json',
    evidenceKind: 'software-only',
    switchCount: 0,
    underrunCount: details.diagnostics.underrunCount,
    deviceLostCount: details.diagnostics.deviceLostCount,
    recoveryCount: 0,
    notes: result.notes
  }
  return { operationalResults: [operationalResult] }
}

function writeSummaryArtifacts(summary, options, result) {
  if (options.output) {
    const outputPath = path.resolve(options.output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`)
    summary.artifact = { path: relativeArtifact(outputPath), sha256: sha256(outputPath) }
  }
  if (options.evidenceOutput) {
    if (!['hotplug', 'explicit-disappearance'].includes(options.scenario) || !result)
      throw new Error(
        '--evidence-output currently requires --scenario hotplug|explicit-disappearance --provider legacy|miniaudio'
      )
    if (!options.output) throw new Error('--evidence-output requires --output')
    const evidencePath = path.resolve(options.evidenceOutput)
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify(buildOperationalEnvelope(summary, options.output, result), null, 2)}\n`
    )
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (process.platform !== 'win32') throw new Error('This operational smoke is Windows-only')
  if (options.providers.length === 1 && process.env.TAE_OPERATIONAL_PROVIDER_WORKER !== '1') {
    const isolated = runProviderInChild(options, options.providers[0])
    if (!isolated.summary) {
      console.error(isolated.error)
      process.exitCode = 1
      return
    }
    writeSummaryArtifacts(isolated.summary, options, isolated.result)
    if (options.json) console.log(JSON.stringify(isolated.summary, null, 2))
    else
      console.log(
        `${isolated.result.status.toUpperCase()} ${options.providers[0]} ${options.scenario}`
      )
    if (isolated.result.status !== 'pass') process.exitCode = 1
    return
  }
  process.env.TWILIGHT_AUDIO_PCM_PROVIDER =
    options.providers.length === 1 ? options.providers[0] : 'legacy'
  const { audio: native, modulePath } = loadNative(options.modulePath)
  const context = resolveOperationalContext(native, options.device, options.scenario)
  const { selected, initialDefault, target } = context

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-windows-audio-operational-'))
  const source = options.source ? path.resolve(options.source) : path.join(tempDir, 'tone.wav')
  if (!fs.existsSync(source)) createTone(source)
  const generatedAt = new Date().toISOString()
  const results = []
  try {
    if (options.providers.length > 1) {
      for (const provider of options.providers) {
        const isolated = runProviderInChild(options, provider)
        results.push(isolated.result || isolated)
      }
    } else {
      for (const provider of options.providers) {
        if (options.scenario === 'default-switch') {
          results.push(
            await runDefaultSwitch(provider, options, native, source, initialDefault, target)
          )
        } else if (options.scenario === 'hotplug') {
          results.push(await runHotplug(provider, options, native, source, selected))
        } else {
          results.push(await runExplicitDisappearance(provider, native, source, selected))
        }
      }
    }
  } finally {
    if (options.scenario === 'default-switch') {
      try {
        setWindowsDefaultEndpoint(initialDefault)
      } catch (error) {
        results.push({
          scenario: 'default-restore',
          status: 'fail',
          ok: false,
          error: error.message
        })
      }
    }
    cleanupTempDir(tempDir)
  }

  const summary = {
    schemaVersion: 1,
    kind: 'windows-audio-operational-smoke',
    evidenceKind: options.scenario === 'default-switch' ? 'real-device' : 'software-only',
    generatedAt,
    platform: process.platform,
    modulePath,
    scenario: options.scenario,
    device: selected,
    initialDefault,
    targetDefault: target.id,
    options: {
      providers: options.providers,
      durationMs: options.durationMs,
      source: options.source || 'generated 48kHz/16-bit stereo tone'
    },
    results
  }
  writeSummaryArtifacts(summary, options, results.length === 1 ? results[0] : null)
  if (options.json) console.log(JSON.stringify(summary, null, 2))
  else {
    for (const result of results)
      console.log(`${result.status.toUpperCase()} ${result.provider} ${result.scenario}`)
    if (options.output) console.log(`Raw receipt: ${path.resolve(options.output)}`)
  }
  if (results.some((result) => result.status !== 'pass')) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error))
    process.exitCode = 1
  })
}

module.exports = {
  FII0_ENDPOINT,
  SUPPORTED_PROVIDERS,
  SUPPORTED_SCENARIOS,
  buildOperationalEnvelope,
  buildProviderChildArgs,
  compactInfo,
  expectedProviderImplementation,
  findDevice,
  parseArgs,
  physicalDefaultId
}
