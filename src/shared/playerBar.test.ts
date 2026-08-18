import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_PLAYER_BAR_SETTINGS,
  PLAYER_BAR_BOUNDS,
  PLAYER_BAR_MODES,
  PLAYER_BAR_VISIBILITIES,
  clonePlayerBarSettings,
  normalizePlayerBarMode,
  normalizePlayerBarPageMode,
  normalizePlayerBarPageVisibility,
  normalizePlayerBarSettings,
  normalizePlayerBarVisibility,
  playerBarAutoHideApplies,
  resolvePlayerBarPresentation,
  resolveSeekTargetSeconds
} from './playerBar.ts'

test('player bar defaults keep the existing standard shape', () => {
  assert.deepEqual(DEFAULT_PLAYER_BAR_SETTINGS, {
    mode: 'standard',
    playingPageMode: 'inherit',
    visibility: 'visible',
    playingPageVisibility: 'inherit',
    revealThresholdPx: 120,
    hideDelayMs: 900
  })
  assert.deepEqual([...PLAYER_BAR_MODES], ['standard', 'mini'])
  assert.deepEqual([...PLAYER_BAR_VISIBILITIES], ['visible', 'autoHide', 'hidden'])
})

test('mode normalization falls back to standard for anything unrecognized', () => {
  assert.equal(normalizePlayerBarMode('mini'), 'mini')
  assert.equal(normalizePlayerBarMode('standard'), 'standard')
  assert.equal(normalizePlayerBarMode('compact'), 'standard')
  assert.equal(normalizePlayerBarMode(undefined), 'standard')
  assert.equal(normalizePlayerBarMode(null), 'standard')
  assert.equal(normalizePlayerBarMode(1), 'standard')
})

test('page mode normalization falls back to inherit', () => {
  assert.equal(normalizePlayerBarPageMode('mini'), 'mini')
  assert.equal(normalizePlayerBarPageMode('standard'), 'standard')
  assert.equal(normalizePlayerBarPageMode('inherit'), 'inherit')
  assert.equal(normalizePlayerBarPageMode('nonsense'), 'inherit')
  assert.equal(normalizePlayerBarPageMode(undefined), 'inherit')
})

test('visibility normalization falls back to visible', () => {
  assert.equal(normalizePlayerBarVisibility('visible'), 'visible')
  assert.equal(normalizePlayerBarVisibility('autoHide'), 'autoHide')
  assert.equal(normalizePlayerBarVisibility('hidden'), 'hidden')
  assert.equal(normalizePlayerBarVisibility('inherit'), 'visible')
  assert.equal(normalizePlayerBarVisibility('gone'), 'visible')
  assert.equal(normalizePlayerBarVisibility(true), 'visible')
  assert.equal(normalizePlayerBarVisibility(undefined), 'visible')
})

test('page visibility normalization falls back to inherit', () => {
  assert.equal(normalizePlayerBarPageVisibility('visible'), 'visible')
  assert.equal(normalizePlayerBarPageVisibility('autoHide'), 'autoHide')
  assert.equal(normalizePlayerBarPageVisibility('hidden'), 'hidden')
  assert.equal(normalizePlayerBarPageVisibility('inherit'), 'inherit')
  assert.equal(normalizePlayerBarPageVisibility('nonsense'), 'inherit')
  assert.equal(normalizePlayerBarPageVisibility(undefined), 'inherit')
})

test('settings normalization clamps and rounds numeric fields', () => {
  const low = normalizePlayerBarSettings({ revealThresholdPx: -50, hideDelayMs: -1 })
  assert.equal(low.revealThresholdPx, PLAYER_BAR_BOUNDS.revealThresholdPx.min)
  assert.equal(low.hideDelayMs, PLAYER_BAR_BOUNDS.hideDelayMs.min)

  const high = normalizePlayerBarSettings({ revealThresholdPx: 9999, hideDelayMs: 99_999 })
  assert.equal(high.revealThresholdPx, PLAYER_BAR_BOUNDS.revealThresholdPx.max)
  assert.equal(high.hideDelayMs, PLAYER_BAR_BOUNDS.hideDelayMs.max)

  const fractional = normalizePlayerBarSettings({ revealThresholdPx: 130.6, hideDelayMs: 240.4 })
  assert.equal(fractional.revealThresholdPx, 131)
  assert.equal(fractional.hideDelayMs, 240)
})

test('settings normalization survives garbage input', () => {
  for (const raw of [undefined, null, 42, 'mini', [], { mode: {}, hideDelayMs: 'soon' }]) {
    assert.deepEqual(normalizePlayerBarSettings(raw), DEFAULT_PLAYER_BAR_SETTINGS)
  }
  assert.equal(normalizePlayerBarSettings({ revealThresholdPx: Number.NaN }).revealThresholdPx, 120)
  assert.equal(
    normalizePlayerBarSettings({ hideDelayMs: Number.POSITIVE_INFINITY }).hideDelayMs,
    900
  )
})

test('the legacy auto-hide boolean migrates onto the playing-page visibility', () => {
  // Settings written before the three-step visibility carried only this flag.
  assert.equal(
    normalizePlayerBarSettings({ mode: 'mini', autoHideOnPlayingPage: true }).playingPageVisibility,
    'autoHide'
  )
  // The global step is untouched, so the bar keeps hiding only where it did.
  assert.equal(
    normalizePlayerBarSettings({ mode: 'mini', autoHideOnPlayingPage: true }).visibility,
    'visible'
  )
  assert.equal(
    normalizePlayerBarSettings({ autoHideOnPlayingPage: false }).playingPageVisibility,
    'inherit'
  )
  // Only a literal true migrated, so a truthy string cannot flip it.
  assert.equal(
    normalizePlayerBarSettings({ autoHideOnPlayingPage: 'yes' }).playingPageVisibility,
    'inherit'
  )
  // Once the new field exists it wins, even against a stale legacy flag.
  assert.equal(
    normalizePlayerBarSettings({ autoHideOnPlayingPage: true, playingPageVisibility: 'hidden' })
      .playingPageVisibility,
    'hidden'
  )
  assert.equal(
    normalizePlayerBarSettings({ autoHideOnPlayingPage: true, playingPageVisibility: 'visible' })
      .playingPageVisibility,
    'visible'
  )
  // The legacy key never survives into the normalized shape.
  assert.equal(
    'autoHideOnPlayingPage' in normalizePlayerBarSettings({ autoHideOnPlayingPage: true }),
    false
  )
})

test('cloning produces an independent object', () => {
  const source = normalizePlayerBarSettings({ mode: 'mini', hideDelayMs: 300 })
  const copy = clonePlayerBarSettings(source)
  assert.deepEqual(copy, source)
  assert.notEqual(copy, source)
  copy.hideDelayMs = 1200
  assert.equal(source.hideDelayMs, 300)
})

test('playing page mode inherits the global shape when set to inherit', () => {
  const settings = normalizePlayerBarSettings({ mode: 'mini', playingPageMode: 'inherit' })
  assert.equal(resolvePlayerBarPresentation(settings, { onPlayingPage: true }).mode, 'mini')
  assert.equal(resolvePlayerBarPresentation(settings, { onPlayingPage: false }).mode, 'mini')
})

test('playing page mode overrides the global shape only on the playing page', () => {
  const settings = normalizePlayerBarSettings({ mode: 'standard', playingPageMode: 'mini' })
  assert.equal(resolvePlayerBarPresentation(settings, { onPlayingPage: true }).mode, 'mini')
  assert.equal(resolvePlayerBarPresentation(settings, { onPlayingPage: false }).mode, 'standard')

  const inverse = normalizePlayerBarSettings({ mode: 'mini', playingPageMode: 'standard' })
  assert.equal(resolvePlayerBarPresentation(inverse, { onPlayingPage: true }).mode, 'standard')
  assert.equal(resolvePlayerBarPresentation(inverse, { onPlayingPage: false }).mode, 'mini')
})

test('the migrated auto-hide still needs the playing page and the mini shape', () => {
  const enabled = normalizePlayerBarSettings({
    mode: 'mini',
    playingPageMode: 'inherit',
    autoHideOnPlayingPage: true
  })
  assert.equal(resolvePlayerBarPresentation(enabled, { onPlayingPage: true }).autoHide, true)
  // The global step stayed `visible`, so elsewhere the bar is still present.
  assert.equal(resolvePlayerBarPresentation(enabled, { onPlayingPage: false }).autoHide, false)

  const standardOnPlayingPage = normalizePlayerBarSettings({
    mode: 'mini',
    playingPageMode: 'standard',
    autoHideOnPlayingPage: true
  })
  assert.equal(
    resolvePlayerBarPresentation(standardOnPlayingPage, { onPlayingPage: true }).autoHide,
    false
  )

  const settingOff = normalizePlayerBarSettings({ mode: 'mini', autoHideOnPlayingPage: false })
  assert.equal(resolvePlayerBarPresentation(settingOff, { onPlayingPage: true }).autoHide, false)
})

test('auto-hide can now apply globally, and degrades to visible on a standard bar', () => {
  const everywhere = normalizePlayerBarSettings({ mode: 'mini', visibility: 'autoHide' })
  for (const onPlayingPage of [true, false]) {
    const resolved = resolvePlayerBarPresentation(everywhere, { onPlayingPage })
    assert.equal(resolved.autoHide, true)
    assert.equal(resolved.hidden, false)
  }

  // A standard bar keeps its inline progress row instead of tucking away.
  const standard = normalizePlayerBarSettings({ mode: 'standard', visibility: 'autoHide' })
  const resolvedStandard = resolvePlayerBarPresentation(standard, { onPlayingPage: false })
  assert.equal(resolvedStandard.autoHide, false)
  assert.equal(resolvedStandard.hidden, false)
})

test('fully hidden applies to both shapes and never reports auto-hide', () => {
  for (const mode of PLAYER_BAR_MODES) {
    const settings = normalizePlayerBarSettings({ mode, visibility: 'hidden' })
    for (const onPlayingPage of [true, false]) {
      const resolved = resolvePlayerBarPresentation(settings, { onPlayingPage })
      assert.equal(resolved.hidden, true)
      // Mutually exclusive: a hidden bar has no reveal gesture to arm.
      assert.equal(resolved.autoHide, false)
      // Shape resolution is unaffected by visibility.
      assert.equal(resolved.mode, mode)
    }
  }
})

test('visibility and shape are independent, each with its own playing-page override', () => {
  // Mini + auto-hide on the playing page, standard + always visible elsewhere:
  // the pairing the mini bar shipped with, expressed in the new contract.
  const coexist = normalizePlayerBarSettings({
    mode: 'standard',
    playingPageMode: 'mini',
    visibility: 'visible',
    playingPageVisibility: 'autoHide'
  })
  assert.deepEqual(resolvePlayerBarPresentation(coexist, { onPlayingPage: true }), {
    mode: 'mini',
    autoHide: true,
    hidden: false
  })
  assert.deepEqual(resolvePlayerBarPresentation(coexist, { onPlayingPage: false }), {
    mode: 'standard',
    autoHide: false,
    hidden: false
  })

  // Hidden everywhere except the playing page, where the mini bar auto-hides.
  const hiddenOutside = normalizePlayerBarSettings({
    mode: 'mini',
    visibility: 'hidden',
    playingPageVisibility: 'autoHide'
  })
  assert.deepEqual(resolvePlayerBarPresentation(hiddenOutside, { onPlayingPage: false }), {
    mode: 'mini',
    autoHide: false,
    hidden: true
  })
  assert.deepEqual(resolvePlayerBarPresentation(hiddenOutside, { onPlayingPage: true }), {
    mode: 'mini',
    autoHide: true,
    hidden: false
  })

  // And the inverse: visible while browsing, gone on the playing page.
  const hiddenOnPage = normalizePlayerBarSettings({
    mode: 'mini',
    visibility: 'visible',
    playingPageVisibility: 'hidden'
  })
  assert.equal(resolvePlayerBarPresentation(hiddenOnPage, { onPlayingPage: true }).hidden, true)
  assert.equal(resolvePlayerBarPresentation(hiddenOnPage, { onPlayingPage: false }).hidden, false)
})

test('the auto-hide applicability helper matches the resolved presentation', () => {
  const cases: { visibility: string; mode: string; onPlayingPage: boolean }[] = [
    { visibility: 'autoHide', mode: 'mini', onPlayingPage: true },
    { visibility: 'autoHide', mode: 'standard', onPlayingPage: true },
    { visibility: 'hidden', mode: 'mini', onPlayingPage: false },
    { visibility: 'visible', mode: 'mini', onPlayingPage: false }
  ]
  for (const { visibility, mode, onPlayingPage } of cases) {
    const settings = normalizePlayerBarSettings({ mode, visibility })
    assert.equal(
      playerBarAutoHideApplies(settings, { onPlayingPage }),
      resolvePlayerBarPresentation(settings, { onPlayingPage }).autoHide
    )
  }
})

test('seek mapping converts a 0..1 ratio into seconds', () => {
  assert.equal(resolveSeekTargetSeconds(0, 240), 0)
  assert.equal(resolveSeekTargetSeconds(0.5, 240), 120)
  assert.equal(resolveSeekTargetSeconds(1, 240), 240)
})

test('seek mapping refuses unusable timelines and out-of-range ratios', () => {
  assert.equal(resolveSeekTargetSeconds(0.5, 0), null)
  assert.equal(resolveSeekTargetSeconds(0.5, -10), null)
  assert.equal(resolveSeekTargetSeconds(0.5, Number.NaN), null)
  assert.equal(resolveSeekTargetSeconds(0.5, Number.POSITIVE_INFINITY), null)
  assert.equal(resolveSeekTargetSeconds(Number.NaN, 240), null)
  assert.equal(resolveSeekTargetSeconds(-0.01, 240), null)
  assert.equal(resolveSeekTargetSeconds(1.01, 240), null)
})
