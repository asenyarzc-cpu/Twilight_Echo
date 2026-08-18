import assert from 'node:assert/strict'
import test from 'node:test'
import type { EqualizerBand, HeadphoneCompensationSettings } from '../types/settings'
import {
  DEFAULT_BAND_FREQUENCIES,
  FREQUENCY_TICKS,
  GAIN_TICKS,
  builtInEqPresets,
  clampNumber,
  cloneBands,
  defaultEqBands,
  defaultAudioProcessing,
  filterTypes,
  formatActiveCompensationTitle,
  formatFrequency,
  formatOpraStatus,
  frequencyToX,
  gainToY,
  getFillStyle,
  getThumbTop,
  isGainDisabled,
  normalizeAudioProcessing,
  normalizeFilterType,
  opraApplyButtonLabel,
  patchBand,
  responseToPath
} from './equalizerPageLogic.ts'

function makeBand(patch: Partial<EqualizerBand> = {}): EqualizerBand {
  return { frequency: 1000, gain: 0, q: 1, filterType: 'peak', ...patch }
}

test('default graphic bands cover the standard ten-band board', () => {
  assert.deepEqual(
    defaultEqBands.map((band) => band.frequency),
    DEFAULT_BAND_FREQUENCIES
  )
  assert.equal(defaultEqBands.length, 10)
  assert.equal(defaultAudioProcessing.eqMode, 'graphic')
  assert.equal(defaultAudioProcessing.eqBands, defaultEqBands)
})

test('preset normalization clamps bands and modes without mutating source arrays', () => {
  const source = [makeBand({ frequency: 1, gain: 100, q: 100, filterType: 'notch' })]
  const normalized = normalizeAudioProcessing({
    eqMode: 'parametric',
    eqBands: source
  })
  assert.equal(normalized.eqMode, 'parametric')
  assert.equal(normalized.eqBands.length, 1)
  assert.equal(normalized.eqBands[0].frequency, 20)
  assert.equal(normalized.eqBands[0].gain, 24)
  assert.equal(normalized.eqBands[0].q, 20)
  assert.equal(normalized.eqBands[0].filterType, 'notch')

  const graphic = normalizeAudioProcessing({
    eqMode: 'graphic',
    eqBands: [makeBand({ frequency: 100, gain: 99, q: 99, filterType: 'allPass' })]
  })
  assert.equal(graphic.eqBands.length, defaultEqBands.length)
  assert.equal(graphic.eqBands[0].frequency, 100)
  assert.equal(graphic.eqBands[0].gain, 12)
  assert.equal(graphic.eqBands[0].q, 8)
  assert.equal(graphic.eqBands[0].filterType, 'allPass')
  assert.equal(source[0].frequency, 1)
})

test('normalization preserves per-band bypass and channel routing in both modes', () => {
  // Dropping these silently re-enabled bypassed bands on the next edit: the
  // main-process normalizer defaults `enabled` back to true, so the engine
  // changed the audio while the editor state stayed unchanged.
  const graphic = normalizeAudioProcessing({
    eqMode: 'graphic',
    eqBands: [makeBand({ frequency: 31, enabled: false, channelMask: 1 })]
  })
  assert.equal(graphic.eqBands[0].enabled, false)
  assert.equal(graphic.eqBands[0].channelMask, 1)

  const parametric = normalizeAudioProcessing({
    eqMode: 'parametric',
    eqBands: [makeBand({ frequency: 1000, enabled: false, channelMask: 2 })]
  })
  assert.equal(parametric.eqBands[0].enabled, false)
  assert.equal(parametric.eqBands[0].channelMask, 2)

  // Bands that never carried the flags must stay flag-free rather than gain a
  // synthesized default.
  const bare = normalizeAudioProcessing({
    eqMode: 'graphic',
    eqBands: [makeBand({ frequency: 31 })]
  })
  assert.equal('enabled' in bare.eqBands[0], false)
  assert.equal('channelMask' in bare.eqBands[0], false)
})

test('band patches are clamped by the active mode and never mutate inputs', () => {
  const source = [makeBand({ frequency: 1000, gain: 0, q: 1 })]
  const parametric = patchBand(source, 0, { frequency: 100000, gain: 100, q: 100 }, 'parametric')
  assert.equal(parametric[0].frequency, 24000)
  assert.equal(parametric[0].gain, 24)
  assert.equal(parametric[0].q, 20)
  const graphic = patchBand(source, 0, { gain: 100, q: 100 }, 'graphic')
  assert.equal(graphic[0].gain, 12)
  assert.equal(graphic[0].q, 8)
  assert.deepEqual(source, [makeBand({ frequency: 1000, gain: 0, q: 1 })])
})

test('unknown filter types normalize to peak and cloneBands is deep by one level', () => {
  assert.equal(normalizeFilterType('unknown'), 'peak')
  assert.equal(normalizeFilterType('lowShelf'), 'lowShelf')
  const source = [makeBand({ gain: 4 })]
  const clone = cloneBands(source)
  clone[0].gain = 8
  assert.equal(source[0].gain, 4)
  assert.equal(clone[0].gain, 8)
})

test('response mapping is logarithmic and bounded like the old page helpers', () => {
  assert.equal(frequencyToX(20), 0)
  assert.equal(frequencyToX(20000), 100)
  assert.equal(gainToY(18), 0)
  assert.equal(gainToY(0), 50)
  assert.equal(gainToY(-18), 100)
  assert.equal(formatFrequency(1000), '1k')
  assert.equal(formatFrequency(999), '999')
  assert.equal(clampNumber(10, 0, 5, 2), 5)
  assert.equal(clampNumber('bad', 0, 5, 2), 2)
})

test('response path renders SVG coordinates and clamps out-of-range gain', () => {
  const path = responseToPath([
    { frequency: 20, db: 0 },
    { frequency: 20000, db: 50 }
  ])
  assert.match(path, /^M0\.00,50\.00 L100\.00,0\.00$/)
  const empty = responseToPath([])
  assert.equal(empty, '')
})

test('slider geometry preserves positive and negative fill direction', () => {
  assert.equal(getThumbTop(0, 24), '50%')
  assert.equal(getThumbTop(24, 24), '0%')
  assert.equal(getThumbTop(-24, 24), '100%')
  assert.deepEqual(getFillStyle(6, 12), { bottom: '50%', height: '25%' })
  assert.deepEqual(getFillStyle(-6, 12), { top: '50%', height: '25%' })
})

test('filter gain availability and preset/tab constants are stable', () => {
  assert.equal(isGainDisabled(makeBand({ filterType: 'peak' })), false)
  assert.equal(isGainDisabled(makeBand({ filterType: 'lowPass' })), true)
  assert.equal(isGainDisabled(undefined), true)
  assert.equal(builtInEqPresets.length, 4)
  assert.equal(filterTypes.length, 8)
  assert.equal(FREQUENCY_TICKS.length, 11)
  assert.equal(GAIN_TICKS.length, 7)
})

test('OPRA status and compensation copy are human-readable', () => {
  assert.equal(formatOpraStatus(null), 'OPRA 未加载')
  assert.equal(formatOpraStatus({ loading: true } as never), 'OPRA 正在加载')
  assert.equal(
    formatOpraStatus({
      loaded: true,
      loading: false,
      source: 'network',
      profileCount: 1234
    } as never),
    '已刷新 · 1,234 profiles'
  )
  assert.equal(
    formatOpraStatus({ loaded: false, loading: false, lastError: 'cache gone' } as never),
    '离线：cache gone'
  )
  assert.equal(
    formatActiveCompensationTitle({ enabled: false, eqId: 'x' } as HeadphoneCompensationSettings),
    '未启用耳机补偿'
  )
  assert.equal(
    formatActiveCompensationTitle({
      enabled: true,
      eqId: 'x',
      vendorName: 'Sony',
      productName: 'MDR-Z1R'
    } as HeadphoneCompensationSettings),
    'Sony MDR-Z1R'
  )
  assert.equal(opraApplyButtonLabel('a', 'b', ''), 'Apply')
  assert.equal(opraApplyButtonLabel('a', 'a', ''), 'In Use')
  assert.equal(opraApplyButtonLabel('a', 'b', 'b'), 'Applying')
})
