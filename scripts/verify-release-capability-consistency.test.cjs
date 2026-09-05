const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createMinimalPe } = require('./pe-fixture.cjs')
const { createAudioCapabilityManifest } = require('./generate-audio-capability-manifest.cjs')
const {
  CAPABILITY_STATES,
  assertCapabilityProductClaims,
  binaryManifestFacts,
  createReleaseCapabilityStatus,
  verifyReleaseCapabilityConsistency
} = require('./verify-release-capability-consistency.cjs')
const packageJson = require('../package.json')

function fixtureDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-release-capability-'))
}

function writeDeclaration(filePath, status) {
  const rows = Object.entries(status.capabilities)
    .map(
      ([name, value]) =>
        `| ${name} | \`${value.status}\` | \`${value.buildStatus}\` | \`${value.runtimeStatus}\` | \`${value.deviceVerification}\` |`
    )
    .join('\n')
  fs.writeFileSync(
    filePath,
    `| Capability | Product status | Build presence | Runtime observation | Real-device verification |\n| --- | --- | --- | --- | --- |\n${rows}\n`
  )
}

function writeFixture(directory, options = {}) {
  fs.writeFileSync(
    path.join(directory, 'twilight-audio-engine.dll'),
    createMinimalPe({ imports: options.engineImports ?? [] })
  )
  fs.writeFileSync(
    path.join(directory, 'twilight_audio_node.node'),
    createMinimalPe({ imports: ['twilight-audio-engine.dll', ...(options.nodeImports ?? [])] })
  )
  fs.writeFileSync(path.join(directory, 'twilight-asio-helper.exe'), createMinimalPe())
  for (const helper of options.helpers ?? []) {
    fs.writeFileSync(path.join(directory, helper), createMinimalPe())
  }
  const binaryManifest = createAudioCapabilityManifest({ artifactDir: directory })
  const runtimeStatus = options.runtime
    ? {
        outputStage: options.runtime.outputStage,
        observation: {
          schemaVersion: 1,
          source: 'audio-engine-runtime-observation',
          artifactSha256: Object.fromEntries(
            binaryManifest.nativeArtifacts.map((artifact) => [artifact.path, artifact.sha256])
          )
        },
        capabilities: options.runtime.capabilities ?? {}
      }
    : null
  const manifest = createAudioCapabilityManifest({ artifactDir: directory, runtimeStatus })
  fs.writeFileSync(
    path.join(directory, 'audio-capabilities.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  const status = createReleaseCapabilityStatus({ nativeDir: directory, manifest })
  fs.writeFileSync(
    path.join(directory, 'release-capability-status.json'),
    `${JSON.stringify(status, null, 2)}\n`
  )
  const declaration = path.join(directory, 'release-capability-status.md')
  writeDeclaration(declaration, status)
  fs.writeFileSync(path.join(directory, 'README.md'), 'PCM SRC；实验性 PCM→DSD64/128/256')
  return { declaration, manifest, status, runtimeStatus }
}

test('controlled capability statuses retain staged-build and real-device dimensions', () => {
  const directory = fixtureDirectory()
  try {
    const { declaration } = writeFixture(directory)
    const result = verifyReleaseCapabilityConsistency({
      nativeDir: directory,
      declaration,
      productRoot: directory
    })
    assert.deepEqual(result.status.controlledStates, CAPABILITY_STATES)
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(result.status.capabilities.ASIO).filter(([key]) => key !== 'evidence')
      ),
      {
        status: 'unverified',
        buildStatus: 'unverified',
        runtimeStatus: 'unverified',
        deviceVerification: 'unverified'
      }
    )
    assert.equal(result.status.capabilities.VST3.status, 'not-built')
    assert.equal(result.status.capabilities.CUDA.status, 'not-built')
    assert.equal(result.status.capabilities['Native DSD provider'].deviceVerification, 'unverified')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('provider runtime facts do not masquerade as staged binary drift', () => {
  const directory = fixtureDirectory()
  try {
    const manifest = createAudioCapabilityManifest({ artifactDir: directory })
    const observed = structuredClone(manifest)
    observed.capabilities.pcmOutputProvider.activeProvider = 'miniaudio'
    observed.capabilities.pcmOutputProvider.runtimeObservation = 'available'
    observed.capabilities.pcmOutputProvider.deviceVerification = 'unverified'
    assert.deepEqual(binaryManifestFacts(observed), binaryManifestFacts(manifest))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('ASIO-disabled runtime evidence reports not-built instead of inferring support from the core DLL', () => {
  const directory = fixtureDirectory()
  try {
    const { declaration } = writeFixture(directory, {
      runtime: { capabilities: { asio: { enabled: false } } }
    })
    const result = verifyReleaseCapabilityConsistency({
      nativeDir: directory,
      declaration,
      productRoot: directory
    })
    assert.equal(result.status.capabilities.ASIO.status, 'not-built')
    assert.equal(result.status.capabilities.ASIO.buildStatus, 'not-built')
    assert.equal(
      result.status.capabilities.ASIO.evidence.build.provenance,
      'audio-engine-runtime-observation'
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('provenanced runtime observations pass and control SoXR, ebur128, and Native DSD provider states', () => {
  const directory = fixtureDirectory()
  try {
    const { declaration } = writeFixture(directory, {
      runtime: {
        outputStage: { resamplerEngine: 'soxr', resamplerFallback: false },
        capabilities: {
          asio: { enabled: true },
          ebur128: { available: true },
          nativeDsdProvider: { available: true }
        }
      }
    })
    const result = verifyReleaseCapabilityConsistency({
      nativeDir: directory,
      declaration,
      productRoot: directory
    })
    assert.equal(result.status.capabilities.ASIO.status, 'experimental')
    assert.equal(result.status.capabilities.SoXR.status, 'available')
    assert.equal(result.status.capabilities.ebur128.status, 'available')
    assert.equal(result.status.capabilities['Native DSD provider'].status, 'available')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a staged VST3 host without its scanner is rejected', () => {
  const directory = fixtureDirectory()
  try {
    assert.throws(
      () => writeFixture(directory, { helpers: ['twilight-vst3-host.exe'] }),
      /VST3 helper staging is incomplete/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a missing staged dynamic dependency is rejected', () => {
  const directory = fixtureDirectory()
  try {
    const { declaration } = writeFixture(directory, { engineImports: ['libmissing-runtime.dll'] })
    assert.throws(
      () =>
        verifyReleaseCapabilityConsistency({
          nativeDir: directory,
          declaration,
          productRoot: directory
        }),
      /Missing runtime dependency beside the native binaries: libmissing-runtime\.dll/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('manifest binary drift and incorrect product declarations are rejected', () => {
  const directory = fixtureDirectory()
  try {
    const { declaration } = writeFixture(directory)
    fs.appendFileSync(path.join(directory, 'twilight-audio-engine.dll'), 'drift')
    assert.throws(
      () =>
        verifyReleaseCapabilityConsistency({
          nativeDir: directory,
          declaration,
          productRoot: directory
        }),
      /Audio capability manifest drifted/
    )

    const repaired = createAudioCapabilityManifest({ artifactDir: directory })
    fs.writeFileSync(
      path.join(directory, 'audio-capabilities.json'),
      `${JSON.stringify(repaired, null, 2)}\n`
    )
    const status = createReleaseCapabilityStatus({ nativeDir: directory, manifest: repaired })
    fs.writeFileSync(
      path.join(directory, 'release-capability-status.json'),
      `${JSON.stringify(status, null, 2)}\n`
    )
    fs.writeFileSync(
      declaration,
      fs
        .readFileSync(declaration, 'utf8')
        .replace('| CUDA | `not-built` |', '| CUDA | `available` |')
    )
    assert.throws(
      () =>
        verifyReleaseCapabilityConsistency({
          nativeDir: directory,
          declaration,
          productRoot: directory
        }),
      /Release capability declaration drifted for CUDA/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('staged helper hashes and fake runtime provenance cannot drift from manifest facts', () => {
  const directory = fixtureDirectory()
  try {
    const { declaration, manifest } = writeFixture(directory, {
      helpers: ['twilight-vst3-host.exe', 'twilight-vst3-scanner.exe']
    })
    assert.deepEqual(
      manifest.nativeArtifacts
        .filter((artifact) => artifact.path.endsWith('.exe'))
        .map((artifact) => artifact.path)
        .sort(),
      ['twilight-asio-helper.exe', 'twilight-vst3-host.exe', 'twilight-vst3-scanner.exe']
    )
    fs.appendFileSync(path.join(directory, 'twilight-vst3-host.exe'), 'drift')
    assert.throws(
      () =>
        verifyReleaseCapabilityConsistency({
          nativeDir: directory,
          declaration,
          productRoot: directory
        }),
      /Audio capability manifest drifted/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('unprovenanced and hash-mismatched runtime observations are rejected', () => {
  const directory = fixtureDirectory()
  try {
    const { declaration, manifest } = writeFixture(directory)
    manifest.capabilities.pcmSrc.soxr = { actualEngine: 'soxr', fallback: false, observed: true }
    fs.writeFileSync(
      path.join(directory, 'audio-capabilities.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    assert.throws(
      () =>
        verifyReleaseCapabilityConsistency({
          nativeDir: directory,
          declaration,
          productRoot: directory
        }),
      /Runtime SoXR observation requires provenance/
    )

    const observed = createAudioCapabilityManifest({
      artifactDir: directory,
      runtimeStatus: {
        outputStage: { resamplerEngine: 'soxr', resamplerFallback: false },
        observation: {
          schemaVersion: 1,
          source: 'audio-engine-runtime-observation',
          artifactSha256: { 'twilight-audio-engine.dll': 'fake' }
        },
        capabilities: {}
      }
    })
    fs.writeFileSync(
      path.join(directory, 'audio-capabilities.json'),
      `${JSON.stringify(observed, null, 2)}\n`
    )
    assert.throws(
      () =>
        verifyReleaseCapabilityConsistency({
          nativeDir: directory,
          declaration,
          productRoot: directory
        }),
      /Runtime observation provenance does not match staged native artifacts/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('unverified or not-built capabilities cannot receive positive current release claims', () => {
  const directory = fixtureDirectory()
  try {
    const { status } = writeFixture(directory)
    const notes = path.join(directory, 'docs', 'release-notes')
    const settings = path.join(directory, 'src', 'renderer', 'src', 'components', 'settings-page')
    fs.mkdirSync(notes, { recursive: true })
    fs.mkdirSync(settings, { recursive: true })
    fs.writeFileSync(
      path.join(settings, 'DspSettingsSection.vue'),
      '<span>本构建未包含 VST3 扫描/宿主组件。</span>'
    )
    fs.writeFileSync(path.join(notes, 'current.md'), 'ASIO is available in this release.')
    assert.throws(
      () => assertCapabilityProductClaims(directory, status),
      /ASIO is unverified; positive product claim is not permitted/
    )
    fs.writeFileSync(path.join(notes, 'current.md'), 'VST3 is supported in this release.')
    assert.throws(
      () => assertCapabilityProductClaims(directory, status),
      /VST3 is not-built; positive product claim is not permitted/
    )
    fs.writeFileSync(
      path.join(notes, 'current.md'),
      'VST3 helpers are staged, so VST3 is available in this release.'
    )
    assert.throws(
      () => assertCapabilityProductClaims(directory, status),
      /VST3 is not-built; positive product claim is not permitted/
    )
    fs.writeFileSync(
      path.join(notes, 'current.md'),
      'ASIO remains unverified. VST3 is available only when its host and scanner helpers are staged.'
    )
    assert.doesNotThrow(() => assertCapabilityProductClaims(directory, status))
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.1.1' }))
    fs.writeFileSync(path.join(notes, '1.1.1.md'), 'ASIO is available in this release.')
    assert.throws(
      () => assertCapabilityProductClaims(directory, status),
      /ASIO is unverified; positive product claim is not permitted/
    )
    fs.rmSync(path.join(notes, '1.1.1.md'))
    fs.writeFileSync(
      path.join(notes, '1.1.0.md'),
      'ASIO is available in this historical repair note.'
    )
    assert.doesNotThrow(() => assertCapabilityProductClaims(directory, status))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('experimental capabilities cannot be described as generally available', () => {
  const directory = fixtureDirectory()
  try {
    const { status } = writeFixture(directory, {
      runtime: { capabilities: { asio: { enabled: true } } }
    })
    const notes = path.join(directory, 'docs', 'release-notes')
    fs.mkdirSync(notes, { recursive: true })
    fs.writeFileSync(path.join(notes, 'current.md'), 'ASIO is available and experimental.')
    assert.throws(
      () => assertCapabilityProductClaims(directory, status),
      /ASIO is experimental; positive product claim is not permitted/
    )
    fs.writeFileSync(path.join(notes, 'current.md'), 'ASIO is an experimental capability.')
    assert.doesNotThrow(() => assertCapabilityProductClaims(directory, status))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('release preflight and packaged release both retain capability consistency verification', () => {
  assert.match(
    packageJson.scripts['test:release-artifacts'],
    /verify-release-capability-consistency\.test\.cjs/
  )
  assert.match(
    packageJson.scripts['test:release-artifacts'],
    /staged-audio-runtime-observation\.test\.cjs/
  )
  assert.match(packageJson.scripts['gate:release:preflight'], /generate:release-capability-status/)
  assert.match(packageJson.scripts['gate:release:preflight'], /verify:release-capabilities/)
  assert.ok(
    packageJson.scripts['gate:release:preflight'].lastIndexOf(
      'generate:release-capability-status'
    ) > packageJson.scripts['gate:release:preflight'].indexOf('test:no-real-device')
  )
  assert.match(
    fs.readFileSync(path.join(__dirname, 'build-windows-release.cjs'), 'utf8'),
    /verifyReleaseCapabilityConsistency\(/
  )
})
