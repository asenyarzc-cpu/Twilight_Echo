const path = require('node:path')

function booleanFact(value) {
  return typeof value === 'boolean' ? value : undefined
}

function readStagedAudioRuntimeObservation({ artifactDir, manifest, loadAddon = require }) {
  try {
    const addon = loadAddon(path.join(path.resolve(artifactDir), 'twilight_audio_node.node'))
    if (!addon || typeof addon.GetEngineCapabilities !== 'function') return null
    const raw = addon.GetEngineCapabilities()
    const capabilities = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!capabilities || typeof capabilities !== 'object') return null
    const features = capabilities.features
    if (!features || typeof features !== 'object') return null
    return {
      observation: {
        schemaVersion: 1,
        source: 'audio-engine-runtime-observation',
        artifactSha256: Object.fromEntries(
          manifest.nativeArtifacts.map((artifact) => [artifact.path, artifact.sha256])
        )
      },
      capabilities: {
        asio: { enabled: booleanFact(features.asio) },
        ebur128: { available: booleanFact(features.ebur128) },
        nativeDsdProvider: { available: booleanFact(features.sacdIsoDstDsdProvider) }
      }
    }
  } catch {
    return null
  }
}

module.exports = { readStagedAudioRuntimeObservation }
