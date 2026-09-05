const {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { NATIVE_RUNTIME_FILES, stripNativeFile } = require('./release-artifact-strip.cjs')
const { createAudioCapabilityManifest } = require('./generate-audio-capability-manifest.cjs')
const { createReleaseCapabilityStatus } = require('./verify-release-capability-consistency.cjs')
const { stagedVst3Files } = require('./prepare-vst3-msvc.cjs')
const { readStagedAudioRuntimeObservation } = require('./staged-audio-runtime-observation.cjs')

function refreshAudioCapabilityArtifacts(nativeDir, runtimeStatus) {
  const manifest = createAudioCapabilityManifest({ artifactDir: nativeDir, runtimeStatus })
  writeFileSync(
    join(nativeDir, 'audio-capabilities.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  writeFileSync(
    join(nativeDir, 'release-capability-status.json'),
    `${JSON.stringify(createReleaseCapabilityStatus({ nativeDir, manifest }), null, 2)}\n`
  )
}

function preparePackagedAudioStaging(root, { nativeOverrides = {} } = {}) {
  const sourceDir = join(root, 'resources', 'audio-engine')
  const vst3 = stagedVst3Files(root)
  if (!vst3.complete) {
    const invalid = [
      ...vst3.missing,
      ...vst3.wrongArchitecture.map((file) => `${file} is not a Windows x64 PE`)
    ]
    throw new Error(
      `Windows packaging requires complete x64 VST3 helpers and VC runtime files; missing or invalid ${invalid.join(', ')}. Run pnpm run prepare:vst3-msvc first.`
    )
  }
  const temporaryDir = mkdtempSync(join(tmpdir(), 'twilight-packaged-audio-'))
  const nativeDir = join(temporaryDir, 'audio-engine')
  mkdirSync(nativeDir)
  for (const name of readdirSync(sourceDir)) {
    if (!NATIVE_RUNTIME_FILES.includes(name)) {
      cpSync(join(sourceDir, name), join(nativeDir, name), { recursive: true })
    }
  }
  for (const name of NATIVE_RUNTIME_FILES) {
    const sourcePath = nativeOverrides[name] || join(sourceDir, name)
    if (!existsSync(sourcePath)) continue
    const workingPath = join(temporaryDir, `${name}.strip-input`)
    copyFileSync(sourcePath, workingPath)
    stripNativeFile(workingPath)
    copyFileSync(workingPath, join(nativeDir, name))
    rmSync(workingPath, { force: true })
  }
  const binaryManifest = createAudioCapabilityManifest({ artifactDir: nativeDir })
  const runtimeStatus = readStagedAudioRuntimeObservation({
    artifactDir: nativeDir,
    manifest: binaryManifest
  })
  refreshAudioCapabilityArtifacts(nativeDir, runtimeStatus)

  const sourceConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const stagedConfig = sourceConfig.replace(
    '  - from: resources/audio-engine',
    `  - from: '${nativeDir.replaceAll('\\', '/')}'`
  )
  if (stagedConfig === sourceConfig) throw new Error('Audio engine resource entry was not found')
  const configPath = join(temporaryDir, 'electron-builder.yml')
  writeFileSync(configPath, stagedConfig)
  return {
    configPath,
    dispose: () => {
      try {
        rmSync(temporaryDir, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 })
        return true
      } catch (_error) {
        console.warn(`Unable to remove packaged audio staging directory: ${temporaryDir}`)
        return false
      }
    }
  }
}

module.exports = { preparePackagedAudioStaging, refreshAudioCapabilityArtifacts }
