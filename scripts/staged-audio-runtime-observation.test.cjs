const assert = require('node:assert/strict')
const test = require('node:test')

const { readStagedAudioRuntimeObservation } = require('./staged-audio-runtime-observation.cjs')

const manifest = {
  nativeArtifacts: [
    { path: 'twilight-audio-engine.dll', sha256: 'engine' },
    { path: 'twilight_audio_node.node', sha256: 'node' },
    { path: 'twilight-asio-helper.exe', sha256: 'helper' }
  ]
}

test('staged addon observations bind engine capability facts to every artifact hash', () => {
  const observation = readStagedAudioRuntimeObservation({
    artifactDir: 'C:/staged',
    manifest,
    loadAddon: () => ({
      GetEngineCapabilities: () =>
        JSON.stringify({
          features: { asio: true, ebur128: true, sacdIsoDstDsdProvider: false }
        })
    })
  })
  assert.deepEqual(observation, {
    observation: {
      schemaVersion: 1,
      source: 'audio-engine-runtime-observation',
      artifactSha256: {
        'twilight-audio-engine.dll': 'engine',
        'twilight_audio_node.node': 'node',
        'twilight-asio-helper.exe': 'helper'
      }
    },
    capabilities: {
      asio: { enabled: true },
      ebur128: { available: true },
      nativeDsdProvider: { available: false }
    }
  })
})

test('an unloadable staged addon provides no capability fact', () => {
  assert.equal(
    readStagedAudioRuntimeObservation({
      artifactDir: 'C:/staged',
      manifest,
      loadAddon: () => {
        throw new Error('missing runtime')
      }
    }),
    null
  )
})
