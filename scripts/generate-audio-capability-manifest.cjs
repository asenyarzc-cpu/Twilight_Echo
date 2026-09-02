const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { readPeImports } = require('./pe-imports.cjs')
const { readStagedAudioRuntimeObservation } = require('./staged-audio-runtime-observation.cjs')

const NATIVE_ARTIFACT_EXTENSIONS = new Set(['.dll', '.node', '.exe', '.so', '.dylib'])
const CUDA_IMPORT = /^(?:cudart(?:64)?|nvcuda|nvrtc(?:64)?)(?:[._-]|$)/i
const OTHER_GPU_IMPORTS = [
  ['opencl', /^opencl(?:[._-]|$)/i],
  ['vulkan', /^vulkan(?:[._-]|$)/i],
  ['direct3d12', /^d3d12(?:[._-]|$)/i],
  ['metal', /^metal(?:[._-]|$)/i],
  ['rocm', /^(?:amdhip64|hiprtc|hsa-runtime)(?:[._-]|$)/i]
]

function listNativeArtifacts(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listNativeArtifacts(entryPath))
    else if (NATIVE_ARTIFACT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      files.push(entryPath)
  }
  return files.sort()
}

function readImports(filePath) {
  try {
    return { status: 'ok', values: readPeImports(filePath) }
  } catch (error) {
    return {
      status: 'unavailable',
      values: [],
      reason:
        error instanceof Error && /not a PE binary/i.test(error.message) ? 'not-pe' : 'unreadable'
    }
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function artifactFacts(filePath, artifactDir) {
  const binary = fs.readFileSync(filePath)
  const importInspection = readImports(filePath)
  return {
    path: path.relative(artifactDir, filePath).replaceAll('\\', '/'),
    bytes: binary.length,
    sha256: sha256(binary),
    imports: importInspection.values,
    importInspection: {
      status: importInspection.status,
      ...(importInspection.reason ? { reason: importInspection.reason } : {})
    },
    hasPcmToDsdModulator:
      binary.includes(Buffer.from('PCM to DSD modulator supports DSD64')) ||
      binary.includes(Buffer.from('PcmToDsdModulator')),
    hasMiniaudioProvider: binary.includes(
      Buffer.from('twilight-miniaudio-provider:miniaudio-0.11.25')
    ),
    hasSwr: binary.includes(Buffer.from('swresample')) || binary.includes(Buffer.from('SWResample'))
  }
}

function runtimeResamplerStatus(runtimeStatus) {
  const outputStage = runtimeStatus?.outputStage ?? runtimeStatus
  const engine = outputStage?.resamplerEngine
  if (engine !== 'swr' && engine !== 'soxr') {
    return { actualEngine: null, fallback: null, observed: false }
  }
  return {
    actualEngine: engine,
    fallback: outputStage.resamplerFallback === true,
    observed: true
  }
}

function runtimeObservation(runtimeStatus) {
  if (!runtimeStatus || typeof runtimeStatus !== 'object') return null
  const observation = runtimeStatus.observation
  if (!observation || typeof observation !== 'object') return null
  const capabilities = runtimeStatus.capabilities
  return {
    schemaVersion: observation.schemaVersion,
    source: observation.source,
    artifactSha256: observation.artifactSha256,
    capabilities:
      capabilities && typeof capabilities === 'object'
        ? {
            asio: capabilities.asio,
            ebur128: capabilities.ebur128,
            nativeDsdProvider: capabilities.nativeDsdProvider
          }
        : {}
  }
}

function loadRuntimeStatus(filePath) {
  if (!filePath) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function createAudioCapabilityManifest({ artifactDir, runtimeStatus = null }) {
  const absoluteArtifactDir = path.resolve(artifactDir)
  const artifacts = listNativeArtifacts(absoluteArtifactDir).map((filePath) =>
    artifactFacts(filePath, absoluteArtifactDir)
  )
  const engineArtifacts = artifacts.filter((artifact) =>
    /twilight-audio-engine\.(?:dll|so|dylib)$/i.test(artifact.path)
  )
  const importInspectionComplete = artifacts.every(
    (artifact) => artifact.importInspection.status === 'ok'
  )
  const imports = artifacts
    .filter((artifact) => artifact.importInspection.status === 'ok')
    .flatMap((artifact) => artifact.imports)
  const cudaImports = imports.filter((name) => CUDA_IMPORT.test(name))
  const detectedOtherGpuBackends = OTHER_GPU_IMPORTS.filter(([, matcher]) =>
    imports.some((name) => matcher.test(name))
  ).map(([name]) => name)
  const pcmToDsdCompiled = engineArtifacts.some((artifact) => artifact.hasPcmToDsdModulator)
  const miniaudioCompiled = engineArtifacts.some((artifact) => artifact.hasMiniaudioProvider)
  const swrCompiled = engineArtifacts.some((artifact) => artifact.hasSwr)
  const resamplerRuntime = runtimeResamplerStatus(runtimeStatus)

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    artifactDirectory: '.',
    runtimeObservation: runtimeObservation(runtimeStatus),
    nativeArtifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      imports: artifact.imports,
      importInspection: artifact.importInspection
    })),
    capabilities: {
      pcmSrc: {
        swr: { compiled: swrCompiled },
        soxr: {
          buildMode: 'ffmpeg-runtime-probe',
          actualEngine: resamplerRuntime.actualEngine,
          fallback: resamplerRuntime.fallback,
          observed: resamplerRuntime.observed
        }
      },
      pcmToDsd: {
        compiled: pcmToDsdCompiled,
        backend: pcmToDsdCompiled ? 'cpu' : null,
        experimentalRates: pcmToDsdCompiled ? ['dsd64', 'dsd128', 'dsd256'] : []
      },
      cuda: {
        compiled: cudaImports.length > 0 ? true : importInspectionComplete ? false : null,
        imports: cudaImports,
        importInspectionComplete
      },
      otherGpuBackends: {
        detected: detectedOtherGpuBackends,
        importInspectionComplete
      },
      miniaudio: {
        compiled: miniaudioCompiled,
        version: miniaudioCompiled ? '0.11.25' : null,
        enabledBackends: miniaudioCompiled ? ['wasapi'] : [],
        runtimeStatus: 'unverified',
        deviceStatus: 'unverified'
      }
    }
  }
}

function assertControlledProductClaims(root) {
  const productFiles = [
    path.join(root, 'README.md'),
    ...listMarkdownFiles(path.join(root, 'docs', 'release-notes')),
    ...listFilesMatching(
      path.join(root, 'src', 'renderer', 'src', 'components'),
      /Settings.*\.vue$/
    )
  ]
  for (const filePath of productFiles) {
    const text = fs.readFileSync(filePath, 'utf8')
    if (hasUnsupportedProductClaim(text)) {
      throw new Error(`Unsupported playback capability claim in ${path.relative(root, filePath)}`)
    }
  }

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  if (!readme.includes('PCM SRC') || !readme.includes('实验性 PCM→DSD64/128/256')) {
    throw new Error(
      'README must retain the approved PCM SRC and experimental PCM→DSD64/128/256 wording'
    )
  }

  const dspSettings = path.join(
    root,
    'src',
    'renderer',
    'src',
    'components',
    'settings-page',
    'DspSettingsSection.vue'
  )
  if (fs.existsSync(dspSettings)) {
    const text = fs.readFileSync(dspSettings, 'utf8')
    if (!text.includes('本构建未包含 VST3')) {
      throw new Error('Renderer settings must retain the VST3 not-built capability copy')
    }
  }
}

function hasUnsupportedProductClaim(text) {
  const controlledCapability =
    /CUDA\s*(?:加速|SDM|acceleration)|GPU\s+acceleration|GPU\s*(?:音频|audio|升频|resampl(?:er|ing)|SDM)|(?:(?:完整高品质|高品质|完整)|(?:full(?:\s+high-quality)?|high-quality))\s*SDM/gi
  const positiveClaim = /(?:已支持|支持|已实现|available|supported|implemented|enabled|included)/i
  const negativeClaim =
    /(?:未|不|尚未|没有|禁止|不得|\b(?:not|no|without|unavailable|unsupported)\b)/i
  for (const match of text.matchAll(controlledCapability)) {
    const start = Math.max(0, (match.index ?? 0) - 48)
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 64)
    const context = text.slice(start, end)
    if (positiveClaim.test(context) && !negativeClaim.test(context)) return true
  }
  return false
}

function listMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listMarkdownFiles(entryPath))
    else if (path.extname(entry.name).toLowerCase() === '.md') files.push(entryPath)
  }
  return files
}

function listFilesMatching(directory, matcher) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFilesMatching(entryPath, matcher))
    else if (matcher.test(entry.name)) files.push(entryPath)
  }
  return files
}

function parseArgs(argv) {
  const options = { artifactDir: '', output: '', runtimeStatus: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!['--artifact-dir', '--output', '--runtime-status'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    if (argument === '--artifact-dir') options.artifactDir = value
    if (argument === '--output') options.output = value
    if (argument === '--runtime-status') options.runtimeStatus = value
  }
  if (!options.artifactDir) throw new Error('--artifact-dir is required')
  if (!options.output) throw new Error('--output is required')
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const binaryManifest = createAudioCapabilityManifest({ artifactDir: options.artifactDir })
  const runtimeStatus = options.runtimeStatus
    ? loadRuntimeStatus(options.runtimeStatus)
    : readStagedAudioRuntimeObservation({
        artifactDir: options.artifactDir,
        manifest: binaryManifest
      })
  const manifest = createAudioCapabilityManifest({
    artifactDir: options.artifactDir,
    runtimeStatus
  })
  const output = path.resolve(options.output)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Audio capability manifest written: ${output}`)
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
  assertControlledProductClaims,
  createAudioCapabilityManifest,
  hasUnsupportedProductClaim,
  listFilesMatching,
  listNativeArtifacts,
  parseArgs,
  runtimeResamplerStatus
}
