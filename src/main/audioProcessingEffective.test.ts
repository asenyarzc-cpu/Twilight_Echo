import assert from 'node:assert/strict'
import test from 'node:test'

import type { AudioProcessingSettings } from './audioEngineManager'

const { buildEffectiveAudioProcessingSettings } = (await import(
  new URL('./audio/audioProcessingEffective.ts', import.meta.url).href
)) as typeof import('./audio/audioProcessingEffective.ts')

test('effective processing keeps manual EQ unchanged when OPRA is disabled', () => {
  const manual: Partial<AudioProcessingSettings> = {
    dspEnabled: false,
    eqEnabled: true,
    eqMode: 'graphic',
    eqPreamp: -1,
    eqBands: [{ frequency: 1000, gain: 3, q: 1, filterType: 'peak' }]
  }

  const effective = buildEffectiveAudioProcessingSettings(manual, {
    enabled: false,
    preampDb: -6,
    bands: [{ frequency: 105, gain: -5, q: 0.7, filterType: 'lowShelf' }]
  })

  assert.equal(effective.eqMode, 'graphic')
  assert.equal(effective.eqPreamp, -1)
  assert.equal(effective.eqBands.length, 10)
  assert.equal(effective.eqBands[0].frequency, 1000)
})

test('effective processing keeps OPRA configured but bypassed when equalizer is disabled', () => {
  const effective = buildEffectiveAudioProcessingSettings(
    {
      dspEnabled: true,
      eqEnabled: false,
      eqMode: 'graphic',
      eqPreamp: -1,
      eqBands: [{ frequency: 1000, gain: 3, q: 1, filterType: 'peak' }]
    },
    {
      enabled: true,
      preampDb: -6.5,
      bands: [{ frequency: 105, gain: -13, q: 0.19, filterType: 'lowShelf' }]
    }
  )

  assert.equal(effective.dspEnabled, true)
  assert.equal(effective.eqEnabled, false)
  assert.equal(effective.eqMode, 'graphic')
  assert.equal(effective.eqPreamp, -1)
  assert.equal(effective.eqBands.length, 10)
  assert.equal(effective.eqBands[0].frequency, 1000)
})

test('effective processing does not let OPRA override the DSP master bypass', () => {
  const effective = buildEffectiveAudioProcessingSettings(
    {
      dspEnabled: false,
      eqEnabled: true,
      eqMode: 'parametric',
      eqPreamp: -1,
      eqBands: [{ frequency: 1000, gain: 3, q: 1, filterType: 'peak' }]
    },
    {
      enabled: true,
      preampDb: -6.5,
      bands: [{ frequency: 105, gain: -13, q: 0.19, filterType: 'lowShelf' }]
    }
  )

  assert.equal(effective.dspEnabled, false)
  assert.equal(effective.eqEnabled, true)
  assert.equal(effective.eqPreamp, -1)
  assert.equal(effective.eqBands.length, 1)
  assert.equal(effective.eqBands[0].frequency, 1000)
})

test('effective processing forces parametric EQ and stacks OPRA with enabled graphic EQ', () => {
  const effective = buildEffectiveAudioProcessingSettings(
    {
      dspEnabled: true,
      eqEnabled: true,
      eqMode: 'graphic',
      eqPreamp: -1,
      eqBands: [{ frequency: 1000, gain: 3, q: 1, filterType: 'peak' }]
    },
    {
      enabled: true,
      preampDb: -6.5,
      bands: [
        { frequency: 105, gain: -13, q: 0.19, filterType: 'lowShelf' },
        { frequency: 10000, gain: 7.5, q: 20, filterType: 'highShelf' }
      ]
    }
  )

  assert.equal(effective.dspEnabled, true)
  assert.equal(effective.eqEnabled, true)
  assert.equal(effective.eqMode, 'parametric')
  assert.equal(effective.eqPreamp, -7.5)
  assert.equal(effective.eqBands.length, 12)
  assert.deepEqual(effective.eqBands.slice(0, 2), [
    {
      frequency: 105,
      gain: -13,
      q: 0.19,
      filterType: 'lowShelf',
      enabled: true,
      channelMask: 0xffffffff
    },
    {
      frequency: 10000,
      gain: 7.5,
      q: 20,
      filterType: 'highShelf',
      enabled: true,
      channelMask: 0xffffffff
    }
  ])
  assert.equal(effective.eqBands[2].frequency, 1000)
})

test('effective processing stacks OPRA with parametric EQ without truncating OPRA ranges', () => {
  const effective = buildEffectiveAudioProcessingSettings(
    {
      dspEnabled: true,
      eqEnabled: true,
      eqMode: 'parametric',
      eqPreamp: 2,
      eqBands: [{ frequency: 250, gain: 22, q: 18, filterType: 'peak' }]
    },
    {
      enabled: true,
      preampDb: -4,
      bands: [{ frequency: 50, gain: -24, q: 0.1, filterType: 'peak' }]
    }
  )

  assert.equal(effective.eqPreamp, -2)
  assert.deepEqual(effective.eqBands, [
    {
      frequency: 50,
      gain: -24,
      q: 0.1,
      filterType: 'peak',
      enabled: true,
      channelMask: 0xffffffff
    },
    {
      frequency: 250,
      gain: 22,
      q: 18,
      filterType: 'peak',
      enabled: true,
      channelMask: 0xffffffff
    }
  ])
})
