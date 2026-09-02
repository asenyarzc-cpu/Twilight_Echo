import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SOFTWARE_VOLUME } from '../../../shared/audioProcessingOptions.ts'
import type { AudioProcessingSettings } from '../types/settings.ts'
import { clampSoftwareVolume, cloneAudioProcessingSettings } from './playerAudioSettings.ts'

function makeSettings(): AudioProcessingSettings {
  return {
    dspEnabled: false,
    directMode: false,
    clipGuard: true,
    fftEnabled: true,
    fftResolution: 8192,
    highResolution: true,
    dsdToPcm: false,
    dsdOutputMode: 'auto',
    dsdRatePolicy: 'pcm-fallback',
    dsdRoute: {
      enabled: false,
      backend: '',
      device: '',
      applyToPcmToDsd: true,
      strictPassthrough: false
    },
    sacdProgramMode: 'auto',
    eqEnabled: false,
    eqMode: 'graphic',
    eqPreamp: 0,
    eqBands: [
      { frequency: 31, gain: 0, q: 1, filterType: 'peak' },
      { frequency: 1000, gain: -2, q: 0.7, filterType: 'peak' }
    ],
    volumeNormalization: 'off',
    replayGainPreamp: 0,
    replayGainFallback: 0,
    replayGainClip: true,
    convolverEnabled: false,
    convolverIrPath: '',
    crossfeedEnabled: false,
    crossfeedStrength: 0,
    crossfeedDelayMs: 0.35,
    crossfeedCutoffHz: 700,
    gapless: true,
    crossfadeSeconds: 0
  }
}

test('cloneAudioProcessingSettings deep-copies eqBands', () => {
  const settings = makeSettings()
  const cloned = cloneAudioProcessingSettings(settings)
  assert.notEqual(cloned, settings)
  assert.notEqual(cloned.eqBands, settings.eqBands)
  assert.notEqual(cloned.eqBands[0], settings.eqBands[0])
  cloned.eqBands[0]!.gain = 12
  assert.equal(settings.eqBands[0]!.gain, 0)
})

test('cloneAudioProcessingSettings deep-copies dsdRoute', () => {
  const settings = makeSettings()
  settings.dsdRoute.backend = 'asio'
  settings.dsdRoute.device = 'asio:proxy'
  const cloned = cloneAudioProcessingSettings(settings)
  assert.notEqual(cloned.dsdRoute, settings.dsdRoute)
  cloned.dsdRoute.backend = 'alsa'
  cloned.dsdRoute.device = 'hw:0'
  assert.equal(settings.dsdRoute.backend, 'asio')
  assert.equal(settings.dsdRoute.device, 'asio:proxy')
})

test('clampSoftwareVolume clamps, rounds, and falls back for invalid values', () => {
  assert.equal(clampSoftwareVolume(0.5), 0.5)
  assert.equal(clampSoftwareVolume(-1), 0)
  assert.equal(clampSoftwareVolume(2), 1)
  assert.equal(clampSoftwareVolume(0.1236), 0.124)
  assert.equal(clampSoftwareVolume(Number.NaN), DEFAULT_SOFTWARE_VOLUME)
  assert.equal(clampSoftwareVolume(Number.POSITIVE_INFINITY), DEFAULT_SOFTWARE_VOLUME)
  assert.equal(clampSoftwareVolume(Number.NEGATIVE_INFINITY), DEFAULT_SOFTWARE_VOLUME)
})
