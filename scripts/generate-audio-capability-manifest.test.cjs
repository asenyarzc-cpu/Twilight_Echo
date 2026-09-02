const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createMinimalPe } = require('./pe-fixture.cjs')
const {
  assertControlledProductClaims,
  createAudioCapabilityManifest,
  runtimeResamplerStatus
} = require('./generate-audio-capability-manifest.cjs')

function fixtureDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-audio-capability-'))
}

test('missing staged native artifacts report no compiled playback capabilities', () => {
  const directory = fixtureDirectory()
  try {
    const manifest = createAudioCapabilityManifest({ artifactDir: directory })
    assert.equal(manifest.nativeArtifacts.length, 0)
    assert.equal(manifest.capabilities.pcmSrc.swr.compiled, false)
    assert.equal(manifest.capabilities.pcmToDsd.compiled, false)
    assert.equal(manifest.capabilities.pcmToDsd.backend, null)
    assert.equal(manifest.capabilities.cuda.compiled, false)
    assert.equal(manifest.capabilities.cuda.importInspectionComplete, true)
    assert.deepEqual(manifest.capabilities.otherGpuBackends, {
      detected: [],
      importInspectionComplete: true
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('native artifact facts inspect every staged native binary for GPU imports', () => {
  const directory = fixtureDirectory()
  try {
    const engine = path.join(directory, 'twilight-audio-engine.dll')
    fs.writeFileSync(
      engine,
      createMinimalPe({
        imports: ['swresample-5.dll'],
        trailer: 'PCM to DSD modulator supports DSD64 SWResample'
      })
    )
    fs.writeFileSync(
      path.join(directory, 'twilight_audio_node.node'),
      createMinimalPe({ imports: ['cudart64_12.dll'] })
    )
    fs.writeFileSync(
      path.join(directory, 'gpu-helper.dll'),
      createMinimalPe({ imports: ['OpenCL.dll'] })
    )
    fs.writeFileSync(
      path.join(directory, 'twilight-vst3-host.exe'),
      createMinimalPe({ imports: ['libvst3-runtime.dll'] })
    )
    const manifest = createAudioCapabilityManifest({ artifactDir: directory })
    assert.equal(manifest.capabilities.pcmSrc.swr.compiled, true)
    assert.equal(manifest.capabilities.pcmToDsd.compiled, true)
    assert.equal(manifest.capabilities.pcmToDsd.backend, 'cpu')
    assert.deepEqual(manifest.capabilities.pcmToDsd.experimentalRates, [
      'dsd64',
      'dsd128',
      'dsd256'
    ])
    assert.equal(manifest.capabilities.cuda.compiled, true)
    assert.deepEqual(manifest.capabilities.cuda.imports, ['cudart64_12.dll'])
    assert.equal(manifest.capabilities.cuda.importInspectionComplete, true)
    assert.deepEqual(manifest.capabilities.otherGpuBackends, {
      detected: ['opencl'],
      importInspectionComplete: true
    })
    const helper = manifest.nativeArtifacts.find(
      (artifact) => artifact.path === 'twilight-vst3-host.exe'
    )
    assert.equal(helper?.importInspection.status, 'ok')
    assert.deepEqual(helper?.imports, ['libvst3-runtime.dll'])
    assert.match(helper?.sha256 || '', /^[a-f0-9]{64}$/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CUDA-related binary text alone cannot advertise a CUDA backend', () => {
  const directory = fixtureDirectory()
  try {
    fs.writeFileSync(
      path.join(directory, 'twilight-audio-engine.dll'),
      createMinimalPe({ trailer: 'cuda GPU CUDA SDM marketing text' })
    )
    const manifest = createAudioCapabilityManifest({ artifactDir: directory })
    assert.equal(manifest.capabilities.cuda.compiled, false)
    assert.deepEqual(manifest.capabilities.cuda.imports, [])
    assert.deepEqual(manifest.capabilities.otherGpuBackends, {
      detected: [],
      importInspectionComplete: true
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('unreadable native import tables remain observable and do not prove GPU absence', () => {
  const directory = fixtureDirectory()
  try {
    fs.writeFileSync(path.join(directory, 'gpu-helper.so'), 'not a portable executable')
    const manifest = createAudioCapabilityManifest({ artifactDir: directory })
    assert.equal(manifest.nativeArtifacts[0].importInspection.status, 'unavailable')
    assert.equal(manifest.nativeArtifacts[0].importInspection.reason, 'not-pe')
    assert.equal(manifest.capabilities.cuda.compiled, null)
    assert.equal(manifest.capabilities.cuda.importInspectionComplete, false)
    assert.deepEqual(manifest.capabilities.otherGpuBackends, {
      detected: [],
      importInspectionComplete: false
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SoXR reports only the observed runtime engine and fallback state', () => {
  assert.deepEqual(runtimeResamplerStatus(null), {
    actualEngine: null,
    fallback: null,
    observed: false
  })
  assert.deepEqual(runtimeResamplerStatus({ resamplerEngine: 'soxr', resamplerFallback: false }), {
    actualEngine: 'soxr',
    fallback: false,
    observed: true
  })
  assert.deepEqual(
    runtimeResamplerStatus({ outputStage: { resamplerEngine: 'swr', resamplerFallback: true } }),
    { actualEngine: 'swr', fallback: true, observed: true }
  )
})

test('product documentation retains approved wording and rejects unsupported CUDA or full SDM claims', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-capability-docs-'))
  try {
    fs.mkdirSync(path.join(root, 'docs', 'release-notes'), { recursive: true })
    fs.writeFileSync(path.join(root, 'README.md'), 'PCM SRC；实验性 PCM→DSD64/128/256')
    fs.writeFileSync(path.join(root, 'docs', 'release-notes', 'ok.md'), 'CPU-only release')
    assert.doesNotThrow(() => assertControlledProductClaims(root))
    const settingsDir = path.join(root, 'src', 'renderer', 'src', 'components', 'settings-page')
    fs.mkdirSync(settingsDir, { recursive: true })
    const settings = path.join(settingsDir, 'DspSettingsSection.vue')
    fs.writeFileSync(settings, '<span>本构建未包含 VST3</span>')
    assert.doesNotThrow(() => assertControlledProductClaims(root))
    fs.writeFileSync(settings, '<span>CUDA GPU acceleration is available</span>')
    assert.throws(
      () => assertControlledProductClaims(root),
      /Unsupported playback capability claim/
    )
    fs.writeFileSync(settings, '<span>本构建未包含 VST3</span>')
    fs.writeFileSync(
      path.join(root, 'docs', 'release-notes', 'bad.md'),
      'CUDA acceleration is supported'
    )
    assert.throws(
      () => assertControlledProductClaims(root),
      /Unsupported playback capability claim/
    )
    fs.writeFileSync(path.join(root, 'docs', 'release-notes', 'bad.md'), 'full SDM is available')
    assert.throws(
      () => assertControlledProductClaims(root),
      /Unsupported playback capability claim/
    )
    fs.writeFileSync(
      path.join(root, 'docs', 'release-notes', 'bad.md'),
      'CUDA acceleration is not supported; high-quality SDM remains unavailable'
    )
    assert.doesNotThrow(() => assertControlledProductClaims(root))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repository product documentation has no unsupported CUDA or complete SDM claim', () => {
  assert.doesNotThrow(() => assertControlledProductClaims(path.join(__dirname, '..')))
})
