const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  assertControlledProductClaims,
  createAudioCapabilityManifest,
  listFilesMatching
} = require('./generate-audio-capability-manifest.cjs')
const { listNativeBinaries, listRuntimeDependencies } = require('./verify-release-artifacts.cjs')

const CAPABILITY_STATES = Object.freeze([
  'available',
  'experimental',
  'unverified',
  'not-built',
  'unsupported'
])
const CONTROLLED_CAPABILITIES = Object.freeze([
  'ASIO',
  'VST3',
  'SoXR',
  'ebur128',
  'CUDA',
  'Native DSD provider'
])
const REQUIRED_VST3_HELPERS = Object.freeze(['twilight-vst3-host.exe', 'twilight-vst3-scanner.exe'])

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Unable to read ${label}: ${filePath}: ${error instanceof Error ? error.message : error}`
    )
  }
}

function binaryManifestFacts(manifest) {
  const {
    generatedAt: _generatedAt,
    runtimeObservation: _runtimeObservation,
    capabilities,
    ...binary
  } = manifest
  const { pcmSrc, ...otherCapabilities } = capabilities ?? {}
  const { soxr: _soxr, ...pcmSrcBinary } = pcmSrc ?? {}
  const { pcmOutputProvider, ...capabilitiesWithoutProviderRuntime } = otherCapabilities
  const pcmOutputProviderBinary = pcmOutputProvider
    ? {
        ...pcmOutputProvider,
        activeProvider: null,
        runtimeObservation: 'unverified',
        deviceVerification: 'unverified'
      }
    : null
  return {
    ...binary,
    capabilities: {
      ...capabilitiesWithoutProviderRuntime,
      ...(pcmSrc ? { pcmSrc: pcmSrcBinary } : {}),
      ...(pcmOutputProvider ? { pcmOutputProvider: pcmOutputProviderBinary } : {})
    }
  }
}

function assertManifestMatchesArtifacts(nativeDir, manifestPath) {
  const staged = readJson(manifestPath, 'audio capability manifest')
  const observed = createAudioCapabilityManifest({ artifactDir: nativeDir })
  assert.deepEqual(
    binaryManifestFacts(staged),
    binaryManifestFacts(observed),
    `Audio capability manifest drifted from staged binaries: ${manifestPath}`
  )
  return staged
}

function assertVst3HelperPair(nativeDir) {
  const present = REQUIRED_VST3_HELPERS.filter((name) => fs.existsSync(path.join(nativeDir, name)))
  if (present.length !== 0 && present.length !== REQUIRED_VST3_HELPERS.length) {
    const missing = REQUIRED_VST3_HELPERS.filter((name) => !present.includes(name))
    throw new Error(
      `VST3 helper staging is incomplete; missing ${missing.join(', ')} beside ${present.join(', ')}`
    )
  }
  return present.length === REQUIRED_VST3_HELPERS.length
}

function allImportsInspectable(manifest) {
  return manifest.nativeArtifacts.every((artifact) => artifact.importInspection?.status === 'ok')
}

function observationCapability(observation, name, key) {
  const value = observation?.capabilities?.[name]
  return value && typeof value === 'object' && typeof value[key] === 'boolean' ? value[key] : null
}

function assertPermittedRuntimeObservation(manifest) {
  const soxr = manifest.capabilities?.pcmSrc?.soxr
  const observation = manifest.runtimeObservation
  if (!observation) {
    assert.equal(soxr?.observed, false, 'Runtime SoXR observation requires provenance')
    return null
  }
  assert.equal(observation.schemaVersion, 1, 'Runtime observation schemaVersion must be 1')
  assert.equal(
    observation.source,
    'audio-engine-runtime-observation',
    'Runtime observation source is not permitted'
  )
  const expectedHashes = Object.fromEntries(
    manifest.nativeArtifacts.map((artifact) => [artifact.path, artifact.sha256])
  )
  assert.deepEqual(
    observation.artifactSha256,
    expectedHashes,
    'Runtime observation provenance does not match staged native artifacts'
  )
  assert.ok(
    observation.capabilities && typeof observation.capabilities === 'object',
    'Runtime observation capabilities must be an object'
  )
  if ('activeProvider' in observation) {
    assert.ok(
      observation.activeProvider === null ||
        observation.activeProvider === 'legacy' ||
        observation.activeProvider === 'miniaudio',
      'Runtime observation activeProvider is invalid'
    )
  }
  if (soxr?.observed) {
    assert.ok(['swr', 'soxr'].includes(soxr.actualEngine), 'Runtime SoXR engine is invalid')
    assert.equal(typeof soxr.fallback, 'boolean', 'Runtime SoXR fallback is invalid')
  }
  return observation
}

function evidence(state, reason, provenance) {
  return { state, reason, provenance }
}

function capabilityStatus(status, buildStatus, runtimeStatus, deviceVerification, facts) {
  return { status, buildStatus, runtimeStatus, deviceVerification, evidence: facts }
}

function createReleaseCapabilityStatus({ nativeDir, manifest }) {
  listNativeBinaries(nativeDir)
  const importsInspectable = allImportsInspectable(manifest)
  const vst3HelpersPresent = assertVst3HelperPair(nativeDir)
  const observation = assertPermittedRuntimeObservation(manifest)
  const soxr = manifest.capabilities?.pcmSrc?.soxr
  const cuda = manifest.capabilities?.cuda
  const asioEnabled = observationCapability(observation, 'asio', 'enabled')
  const ebur128Available = observationCapability(observation, 'ebur128', 'available')
  const nativeDsdProviderAvailable = observationCapability(
    observation,
    'nativeDsdProvider',
    'available'
  )
  const provenance = observation?.source ?? 'no-runtime-observation'
  const asioBuild =
    asioEnabled === true ? 'available' : asioEnabled === false ? 'not-built' : 'unverified'
  const vst3Build = vst3HelpersPresent && importsInspectable ? 'available' : 'not-built'
  const soxrRuntime =
    soxr?.observed && soxr.actualEngine === 'soxr' && soxr.fallback === false
      ? 'available'
      : 'unverified'
  const ebur128Build =
    ebur128Available === true
      ? 'available'
      : ebur128Available === false
        ? 'not-built'
        : 'unverified'
  const nativeDsdBuild =
    nativeDsdProviderAvailable === true
      ? 'available'
      : nativeDsdProviderAvailable === false
        ? 'not-built'
        : 'unverified'
  const cudaBuild =
    cuda?.compiled === true ? 'available' : cuda?.compiled === false ? 'not-built' : 'unverified'
  return {
    schemaVersion: 1,
    artifactDirectory: '.',
    controlledStates: CAPABILITY_STATES,
    capabilities: {
      ASIO: {
        ...capabilityStatus(
          asioBuild === 'available' ? 'experimental' : asioBuild,
          asioBuild,
          asioEnabled === true ? 'available' : 'unverified',
          'unverified',
          {
            build: evidence(asioBuild, 'runtime build observation', provenance),
            runtime: evidence(
              asioEnabled === true ? 'available' : 'unverified',
              'no ASIO device observation',
              provenance
            ),
            device: evidence(
              'unverified',
              'real-device evidence is required',
              'audio-smoke-evidence'
            )
          }
        )
      },
      VST3: {
        ...capabilityStatus(
          vst3Build,
          vst3Build,
          vst3HelpersPresent ? 'unverified' : 'not-built',
          'unverified',
          {
            build: evidence(
              vst3Build,
              'VST3 helper pair and PE import facts',
              'staged-native-artifact'
            ),
            runtime: evidence(
              vst3HelpersPresent ? 'unverified' : 'not-built',
              'no VST3 runtime observation',
              'no-runtime-observation'
            ),
            device: evidence(
              'unverified',
              'third-party plugin/runtime validation is absent',
              'not-run'
            )
          }
        )
      },
      SoXR: {
        ...capabilityStatus(soxrRuntime, 'unverified', soxrRuntime, 'unverified', {
          build: evidence(
            'unverified',
            'FFmpeg runtime engine has no standalone import fact',
            'manifest'
          ),
          runtime: evidence(
            soxrRuntime,
            soxr?.observed ? `observed ${soxr.actualEngine}` : 'no runtime observation',
            provenance
          ),
          device: evidence('unverified', 'no real-device surface was observed', 'not-run')
        })
      },
      ebur128: {
        ...capabilityStatus(
          ebur128Build,
          ebur128Build,
          ebur128Available === true ? 'available' : 'unverified',
          'unverified',
          {
            build: evidence(ebur128Build, 'runtime build observation', provenance),
            runtime: evidence(
              ebur128Available === true ? 'available' : 'unverified',
              'no ebur128 processing observation',
              provenance
            ),
            device: evidence('unverified', 'no real-device evidence was supplied', 'not-run')
          }
        )
      },
      CUDA: {
        ...capabilityStatus(
          cudaBuild === 'available' ? 'experimental' : cudaBuild,
          cudaBuild,
          cudaBuild === 'available' ? 'unverified' : 'not-built',
          'unverified',
          {
            build: evidence(
              cudaBuild,
              'CUDA imports across staged native artifacts',
              'audio-capabilities.json'
            ),
            runtime: evidence(
              cudaBuild === 'available' ? 'unverified' : 'not-built',
              'no GPU runtime observation',
              'no-runtime-observation'
            ),
            device: evidence('unverified', 'no GPU hardware evidence was supplied', 'not-run')
          }
        )
      },
      'Native DSD provider': {
        ...capabilityStatus(
          nativeDsdBuild,
          nativeDsdBuild,
          nativeDsdProviderAvailable === true ? 'available' : 'unverified',
          'unverified',
          {
            build: evidence(nativeDsdBuild, 'runtime build observation', provenance),
            runtime: evidence(
              nativeDsdProviderAvailable === true ? 'available' : 'unverified',
              'no Native DSD provider route observation',
              provenance
            ),
            device: evidence(
              'unverified',
              'real DAC/provider evidence is required',
              'audio-smoke-evidence'
            )
          }
        )
      }
    }
  }
}

function parseDeclaration(documentPath) {
  const text = fs.readFileSync(documentPath, 'utf8')
  const rows = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\|\s*(ASIO|VST3|SoXR|ebur128|CUDA|Native DSD provider)\s*\|\s*`?([a-z-]+)`?\s*\|\s*`?([a-z-]+)`?\s*\|\s*`?([a-z-]+)`?\s*\|\s*`?([a-z-]+)`?\s*\|\s*$/
    )
    if (match) {
      rows.set(match[1], {
        status: match[2],
        buildStatus: match[3],
        runtimeStatus: match[4],
        deviceVerification: match[5]
      })
    }
  }
  return rows
}

function assertDeclarationMatchesStatus(documentPath, status) {
  const declared = parseDeclaration(documentPath)
  for (const capability of CONTROLLED_CAPABILITIES) {
    assert.deepEqual(
      declared.get(capability),
      declarationFields(status.capabilities[capability]),
      `Release capability declaration drifted for ${capability}: ${documentPath}`
    )
  }
}

function declarationFields(status) {
  const { status: productStatus, buildStatus, runtimeStatus, deviceVerification } = status
  return { status: productStatus, buildStatus, runtimeStatus, deviceVerification }
}

function assertStatusArtifactMatches(statusPath, expected) {
  assert.deepEqual(
    readJson(statusPath, 'release capability status'),
    expected,
    `Release capability status drifted from staged facts: ${statusPath}`
  )
}

const PRODUCT_CAPABILITY_PATTERNS = Object.freeze({
  ASIO: /\bASIO\b/gi,
  VST3: /\bVST3\b/gi,
  SoXR: /\bSoXR\b/gi,
  ebur128: /\bebur128\b|\bEBU\s*R128\b/gi,
  'Native DSD provider': /\bNative DSD provider\b|\bDSD-preserving provider\b/gi
})
const POSITIVE_CAPABILITY_COPY =
  /(?:\bavailable\b|\bsupported\b|\benabled\b|\bincluded\b|可用|支持|已支持|包含|提供|启用)/i
const SAFE_CONDITIONAL_OR_NEGATIVE_COPY =
  /(?:\b(?:not|no|without|unavailable|unsupported|unverified|not-built)\b|未验证|未构建|不可用|不支持|尚未|本构建未包含|不作为默认|仅当|只有在|仅在|取决于|条件|\bonly\s+when\b|\bif\b|\bwhen\b.*\b(?:staged|included|verified)\b)/i
function currentProductClaimFiles(root) {
  const releaseNotes = path.join(root, 'docs', 'release-notes')
  const packagePath = path.join(root, 'package.json')
  const currentVersion = fs.existsSync(packagePath)
    ? readJson(packagePath, 'product package metadata').version
    : null
  const currentNotes = fs.existsSync(releaseNotes)
    ? fs
        .readdirSync(releaseNotes, { withFileTypes: true })
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.md')
        .filter(
          (entry) =>
            !/^\d+\.\d+\.\d+(?:[-.].*)?\.md$/i.test(entry.name) ||
            (currentVersion && entry.name === `${currentVersion}.md`)
        )
        .map((entry) => path.join(releaseNotes, entry.name))
    : []
  return [
    path.join(root, 'README.md'),
    ...currentNotes,
    ...listFilesMatching(
      path.join(root, 'src', 'renderer', 'src', 'components'),
      /Settings.*\.vue$/
    )
  ].filter((filePath) => fs.existsSync(filePath))
}

function assertCapabilityProductClaims(root, status) {
  for (const filePath of currentProductClaimFiles(root)) {
    const text = fs.readFileSync(filePath, 'utf8')
    for (const [capability, pattern] of Object.entries(PRODUCT_CAPABILITY_PATTERNS)) {
      const productStatus = status.capabilities[capability].status
      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0
        const lineStart = text.lastIndexOf('\n', index) + 1
        const lineEnd = text.indexOf('\n', index)
        const context = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
        if (!POSITIVE_CAPABILITY_COPY.test(context)) continue
        const conditionalOrNegative = SAFE_CONDITIONAL_OR_NEGATIVE_COPY.test(context)
        if (productStatus === 'available' || conditionalOrNegative) continue
        throw new Error(
          `${capability} is ${productStatus}; positive product claim is not permitted in ${path.relative(root, filePath)}`
        )
      }
    }
  }
}

function verifyReleaseCapabilityConsistency(options) {
  const nativeDir = path.resolve(options.nativeDir)
  const manifestPath = path.join(nativeDir, 'audio-capabilities.json')
  assert.ok(fs.existsSync(nativeDir), `Staged native directory does not exist: ${nativeDir}`)
  assert.ok(fs.existsSync(manifestPath), `Missing audio capability manifest: ${manifestPath}`)
  const manifest = assertManifestMatchesArtifacts(nativeDir, manifestPath)
  const nativeBinaries = listNativeBinaries(nativeDir)
  const runtimeDependencies = listRuntimeDependencies(nativeDir, nativeBinaries)
  const status = createReleaseCapabilityStatus({ nativeDir, manifest })
  const productRoot = path.resolve(options.productRoot || path.join(__dirname, '..'))
  assertControlledProductClaims(productRoot)
  assertCapabilityProductClaims(productRoot, status)
  assertDeclarationMatchesStatus(path.resolve(options.declaration), status)
  const statusPath = path.join(nativeDir, 'release-capability-status.json')
  if (options.output) {
    fs.writeFileSync(path.resolve(options.output), `${JSON.stringify(status, null, 2)}\n`)
  } else {
    assert.ok(fs.existsSync(statusPath), `Missing release capability status: ${statusPath}`)
    assertStatusArtifactMatches(statusPath, status)
  }
  return { manifest, nativeBinaries, runtimeDependencies, status }
}

function parseArgs(argv) {
  const options = { nativeDir: '', declaration: '', output: '', productRoot: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!['--native-dir', '--declaration', '--output', '--product-root'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    if (argument === '--native-dir') options.nativeDir = value
    if (argument === '--declaration') options.declaration = value
    if (argument === '--output') options.output = value
    if (argument === '--product-root') options.productRoot = value
  }
  if (!options.nativeDir) throw new Error('--native-dir is required')
  if (!options.declaration) throw new Error('--declaration is required')
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = verifyReleaseCapabilityConsistency(options)
  console.log(
    `Release capability consistency verified: ${result.nativeBinaries.length} native binaries, ${result.runtimeDependencies.length} runtime dependencies`
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

module.exports = {
  CAPABILITY_STATES,
  CONTROLLED_CAPABILITIES,
  REQUIRED_VST3_HELPERS,
  assertDeclarationMatchesStatus,
  assertManifestMatchesArtifacts,
  assertCapabilityProductClaims,
  assertPermittedRuntimeObservation,
  assertStatusArtifactMatches,
  assertVst3HelperPair,
  binaryManifestFacts,
  createReleaseCapabilityStatus,
  declarationFields,
  parseArgs,
  parseDeclaration,
  verifyReleaseCapabilityConsistency
}
