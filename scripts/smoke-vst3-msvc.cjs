const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const {
  resolveVst3MsvcBuildDirectory,
  resolveVst3MsvcEnvironment,
  validateVst3MsvcToolchain
} = require('./vst3-msvc-toolchain.cjs')

const A_DELAY_CLASS_ID = '0CDBB66985D548A9BFD8371909D24BB3'
const RENDER_TIMEOUT_MS = 15_000

function fail(message) {
  console.error(message)
  process.exit(1)
}

function findExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) || ''
}

function findHost(buildDir) {
  return findExisting([
    join(buildDir, 'bin', 'Release', 'twilight-vst3-host.exe'),
    join(buildDir, 'Release', 'twilight-vst3-host.exe'),
    join(buildDir, 'twilight-vst3-host.exe')
  ])
}

function findAdelayFixture(environment, buildDir, sdkRoot) {
  const fixturePath = environment.TAE_VST3_FIXTURE_PATH
    ? resolve(environment.TAE_VST3_FIXTURE_PATH)
    : ''
  return findExisting([
    fixturePath,
    join(dirname(buildDir), 'sdk-fixture', 'VST3', 'Release', 'adelay.vst3'),
    join(sdkRoot, 'VST3', 'Release', 'adelay.vst3')
  ])
}

function createAdelayComponentState() {
  const state = Buffer.alloc(8)
  // ADelay saves its normalized delay value followed by the bypass state.
  // Zero is valid and makes its fixed one-sample delay observable in 256 frames.
  state.writeFloatLE(0, 0)
  state.writeInt32LE(0, 4)
  return state
}

function createVstPreset(classId, componentState) {
  if (!/^[0-9A-F]{32}$/.test(classId))
    throw new Error('VST3 class ID must be 32 uppercase hex characters')
  const headerSize = 48
  const chunkListSize = 28
  const componentOffset = headerSize
  const chunkListOffset = componentOffset + componentState.length
  const preset = Buffer.alloc(chunkListOffset + chunkListSize)

  preset.write('VST3', 0, 'ascii')
  preset.writeInt32LE(1, 4)
  preset.write(classId, 8, 32, 'ascii')
  preset.writeBigInt64LE(BigInt(chunkListOffset), 40)
  componentState.copy(preset, componentOffset)
  preset.write('List', chunkListOffset, 'ascii')
  preset.writeInt32LE(1, chunkListOffset + 4)
  preset.write('Comp', chunkListOffset + 8, 'ascii')
  preset.writeBigInt64LE(BigInt(componentOffset), chunkListOffset + 12)
  preset.writeBigInt64LE(BigInt(componentState.length), chunkListOffset + 20)
  return preset
}

function runRenderTest(host, modulePath, statePath, stateFormat) {
  const result = spawnSync(
    host,
    [
      '--render-test',
      '--module',
      modulePath,
      '--class-id',
      A_DELAY_CLASS_ID,
      '--sample-rate',
      '48000',
      '--channels',
      '2',
      '--state',
      statePath,
      '--state-format',
      stateFormat
    ],
    { encoding: 'utf8', timeout: RENDER_TIMEOUT_MS, windowsHide: true }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `VST3 host ${stateFormat} render failed (${result.status ?? 'unknown'}): ${(result.stderr || result.stdout || '').trim()}`
    )
  }
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw new Error(`VST3 host returned malformed render JSON: ${result.stdout.trim()}`)
  }
  if (
    report.status !== 'processed' ||
    typeof report.outputPeak !== 'number' ||
    report.outputPeak < 0.2 ||
    !Number.isInteger(report.nonSilentSamples) ||
    report.nonSilentSamples < 2
  ) {
    throw new Error(
      `VST3 ${stateFormat} state did not affect the ADelay render: ${JSON.stringify(report)}`
    )
  }
  return report
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    fail('VST3 state smoke validation is available only on Windows x64.')
  const root = resolve(__dirname, '..')
  const environment = resolveVst3MsvcEnvironment()
  const toolchain = validateVst3MsvcToolchain({ env: environment })
  if (!toolchain.ok) fail(toolchain.message)
  const buildDir = resolveVst3MsvcBuildDirectory(environment, root)
  const host = findHost(buildDir)
  if (!host)
    fail(`VST3 host helper is not built under ${buildDir}. Run pnpm run build:vst3-msvc first.`)
  const fixture = findAdelayFixture(environment, buildDir, toolchain.sdkRoot)
  if (!fixture) {
    fail(
      'ADelay validation fixture was not found. Set TAE_VST3_FIXTURE_PATH to an externally built fixed-SDK ADelay .vst3 bundle.'
    )
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'twilight-vst3-state-smoke-'))
  try {
    const componentState = createAdelayComponentState()
    const rawStatePath = join(temporaryRoot, 'adelay.vststate')
    const presetPath = join(temporaryRoot, 'adelay.vstpreset')
    await writeFile(rawStatePath, componentState)
    await writeFile(presetPath, createVstPreset(A_DELAY_CLASS_ID, componentState))

    const componentStateReport = runRenderTest(host, fixture, rawStatePath, 'componentState')
    const presetReport = runRenderTest(host, fixture, presetPath, 'preset')
    console.log(
      JSON.stringify({
        status: 'passed',
        fixture: 'ADelay',
        componentState: componentStateReport,
        preset: presetReport
      })
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

void main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
