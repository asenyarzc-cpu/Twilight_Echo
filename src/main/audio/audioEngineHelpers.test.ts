import assert from 'node:assert/strict'
import test from 'node:test'
import type { EqualizerBand, PlaybackInfo } from './audioEngineTypes.ts'

const {
  DEFAULT_OUTPUT_CONFIG,
  MAX_SOFT_PLAYBACK_CLOCK_GAP_SECONDS,
  advanceSoftPlaybackPosition,
  audioProcessingSettingsEqual,
  createDefaultPlaybackInfo,
  eqBandsEqual,
  nativePlayMode,
  normalizeAudioProcessingSettings,
  normalizeOutputConversionInfo,
  normalizeOutputProviderImplementation,
  parseDspGraphStatusOrThrow,
  parseNativeJson,
  resolveProcessingMasterState,
  resolveQueueIndexForSource
} = (await import(
  new URL('./audioEngineHelpers.ts', import.meta.url).href
)) as typeof import('./audioEngineHelpers')

function deeplyNestedJson(depth: number): string {
  return `${'['.repeat(depth)}0${']'.repeat(depth)}`
}

function makePlaybackInfo(overrides: Partial<PlaybackInfo> = {}): PlaybackInfo {
  return {
    ...createDefaultPlaybackInfo('wasapi', 'auto', false, DEFAULT_OUTPUT_CONFIG),
    ...overrides
  }
}

test('native audio JSON parsers reject over-nested worker output without changing valid output', () => {
  const fallback = { state: 'stopped' }
  assert.equal(parseNativeJson(deeplyNestedJson(128), fallback), fallback)
  assert.deepEqual(parseNativeJson('{"state":"playing"}', fallback), { state: 'playing' })
  assert.throws(
    () => parseDspGraphStatusOrThrow(deeplyNestedJson(128)),
    /native audio engine returned invalid DSP graph status JSON/
  )
})

test('output conversion facts normalize old payloads without claiming unavailable details', () => {
  assert.equal(normalizeOutputProviderImplementation(undefined), 'legacy-native')
  assert.equal(normalizeOutputProviderImplementation('invalid'), 'legacy-native')
  assert.deepEqual(normalizeOutputConversionInfo(undefined, true), {
    sampleFormatConverted: false,
    sampleRateConverted: true,
    channelLayoutConverted: false,
    source: 'unavailable'
  })
  assert.deepEqual(
    normalizeOutputConversionInfo(
      {
        sampleFormatConverted: true,
        sampleRateConverted: true,
        channelLayoutConverted: true,
        source: 'backend-runtime'
      },
      false
    ),
    {
      sampleFormatConverted: true,
      sampleRateConverted: false,
      channelLayoutConverted: true,
      source: 'backend-runtime'
    }
  )
})

test('default playback output preserves shared mixer reason with legacy provider facts', () => {
  const info = createDefaultPlaybackInfo('wasapi', 'auto', false, DEFAULT_OUTPUT_CONFIG)
  assert.equal(info.outputInfo.providerImplementation, 'legacy-native')
  assert.deepEqual(info.outputInfo.conversionInfo, {
    sampleFormatConverted: false,
    sampleRateConverted: false,
    channelLayoutConverted: false,
    source: 'unavailable'
  })
  assert.equal(info.outputInfo.perfectReasonCode, 'shared_mixer')
})

test('resolveProcessingMasterState reconciles modules, master switch, and direct mode', () => {
  const base = {
    dspEnabled: false,
    directMode: false,
    eqEnabled: false,
    eqPreamp: 0,
    volumeNormalization: 'off' as const,
    convolverEnabled: false,
    convolverIrPath: '',
    crossfeedEnabled: false,
    crossfeedStrength: 0
  }
  // Enabling EQ exits direct mode and turns the DSP master on.
  assert.deepEqual(resolveProcessingMasterState({ ...base, eqEnabled: true }), {
    dspEnabled: true,
    directMode: false
  })
  // A stale persisted directMode with an enabled module is healed.
  assert.deepEqual(resolveProcessingMasterState({ ...base, directMode: true, eqEnabled: true }), {
    dspEnabled: true,
    directMode: false
  })
  // An explicit master-switch off always wins.
  assert.deepEqual(resolveProcessingMasterState({ ...base, eqEnabled: true }, false), {
    dspEnabled: false,
    directMode: true
  })
  // No module and no explicit intent keeps the current state.
  assert.deepEqual(resolveProcessingMasterState({ ...base, dspEnabled: true, directMode: false }), {
    dspEnabled: true,
    directMode: false
  })
  // Explicit direct mode without modules stays direct.
  assert.deepEqual(resolveProcessingMasterState(base, undefined, true), {
    dspEnabled: false,
    directMode: true
  })
})

test('MAX_SOFT_PLAYBACK_CLOCK_GAP_SECONDS is 1.5', () => {
  assert.equal(MAX_SOFT_PLAYBACK_CLOCK_GAP_SECONDS, 1.5)
})

test('nativePlayMode maps supported modes and falls back otherwise', () => {
  assert.equal(nativePlayMode('sequential'), 'sequential')
  assert.equal(nativePlayMode('repeat'), 'repeat')
  // Both looping modes ride native listLoop: the renderer hands over an already
  // shuffled queue, so the engine must wrap that order rather than re-permute it.
  assert.equal(nativePlayMode('listLoop'), 'listLoop')
  assert.equal(nativePlayMode('shuffle'), 'listLoop')
  // heart loads only the current track and lets the renderer own every boundary.
  assert.equal(nativePlayMode('heart'), 'sequential')
  assert.equal(nativePlayMode('unknown' as Parameters<typeof nativePlayMode>[0]), 'sequential')
})

test('resolveQueueIndexForSource returns info unchanged when no correction is needed', () => {
  const queue = [
    { id: 'one', source: 'one.flac' },
    { id: 'two', source: 'two.flac' }
  ]
  const noSource = makePlaybackInfo({ queueIndex: 1 })
  assert.equal(resolveQueueIndexForSource(queue, noSource), noSource)

  const matchingSource = makePlaybackInfo({ source: 'one.flac', queueIndex: 0 })
  assert.equal(resolveQueueIndexForSource(queue, matchingSource), matchingSource)

  const missingSource = makePlaybackInfo({ source: 'missing.flac', queueIndex: 0 })
  assert.equal(resolveQueueIndexForSource(queue, missingSource), missingSource)
})

test('resolveQueueIndexForSource copies with corrected queue index when source exists elsewhere', () => {
  const queue = [
    { id: 'one', source: 'one.flac' },
    { id: 'two', source: 'two.flac' },
    { id: 'three', source: 'one.flac' }
  ]
  const info = makePlaybackInfo({ source: 'two.flac', queueIndex: 0 })
  const resolved = resolveQueueIndexForSource(queue, info)

  assert.notEqual(resolved, info)
  assert.equal(resolved.queueIndex, 1)
  assert.equal(resolved.source, 'two.flac')
})

test('advanceSoftPlaybackPosition applies the soft playback clock rule', () => {
  assert.equal(advanceSoftPlaybackPosition(10, 0.25, 1, 20), 10.25)
  assert.equal(advanceSoftPlaybackPosition(10, 0.25, 1.5, 20), 10.375)
  assert.equal(advanceSoftPlaybackPosition(10, 0.25, 1.5, 10.2), 10.2)
  assert.equal(advanceSoftPlaybackPosition(10, 0.25, 1.5, 0), 10.375)
  assert.equal(advanceSoftPlaybackPosition(10, 2.5, 1, 20), 10)
  assert.equal(advanceSoftPlaybackPosition(10, -1, 1, 20), 10)
})

function makeEqBands(patch: Partial<EqualizerBand> = {}): EqualizerBand[] {
  return [{ frequency: 1000, gain: 0, q: 1, filterType: 'peak', ...patch }]
}

test('eqBandsEqual compares per-band bypass and channel routing', () => {
  // dspOrchestrator.setAudioProcessing early-returns when settings compare
  // equal, so ignoring these left a bypass toggle still processing audio.
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands({ enabled: false })), false)
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands({ channelMask: 1 })), false)

  // Absent flags stay equivalent to their defaults so unrelated writes are
  // still short-circuited.
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands({ enabled: true })), true)
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands({ channelMask: 0xffffffff })), true)
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands()), true)
})

test('audioProcessingSettingsEqual treats a band bypass toggle as a real change', () => {
  const left = normalizeAudioProcessingSettings({ eqMode: 'graphic' })
  const right = normalizeAudioProcessingSettings({
    eqMode: 'graphic',
    eqBands: left.eqBands.map((band, index) =>
      index === 2 ? { ...band, enabled: false } : { ...band }
    )
  })
  assert.equal(audioProcessingSettingsEqual(left, right), false)
  assert.equal(audioProcessingSettingsEqual(left, { ...left }), true)
})

test('normalizeAudioProcessingSettings keeps graphic band gains through a round trip', () => {
  const first = normalizeAudioProcessingSettings({ eqMode: 'graphic' })
  const edited = normalizeAudioProcessingSettings({
    ...first,
    eqBands: first.eqBands.map((band, index) => (index === 3 ? { ...band, gain: 5 } : { ...band }))
  })
  assert.equal(edited.eqBands[3].gain, 5)
  assert.equal(normalizeAudioProcessingSettings({ ...edited }).eqBands[3].gain, 5)
})
