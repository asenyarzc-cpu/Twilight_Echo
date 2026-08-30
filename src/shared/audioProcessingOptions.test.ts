import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DSD_ROUTE,
  DEFAULT_SOFTWARE_VOLUME,
  equalizerBandAltersSignal,
  equalizerSettingsAlterSignal,
  DSD_OUTPUT_MODE_OPTIONS,
  GAPLESS_BLOCKED_REASONS,
  HIFI_STATUS_COPY,
  LOUDNORM_TARGET_LUFS,
  LOUDNORM_TRUE_PEAK_CEILING_DB,
  UNITY_SOFTWARE_VOLUME,
  VOLUME_NORMALIZATION_OPTIONS,
  dsdOutputModeValues,
  dsdRouteSettingsEqual,
  dsdRouteTargetsDistinctRoute,
  gaplessBlockedReasonCopy,
  gaplessRuntimeStatusCopy,
  isDsdOutputMode,
  isDsdRouteSettings,
  isGaplessBlockedReason,
  isVolumeNormalizationMode,
  labelForVolumeNormalization,
  loudnormStatusCopy,
  normalizeDsdRouteSettings,
  requiresMeasuredLoudnorm,
  volumeNormalizationValues,
  withDsdRoutePatch
} from './audioProcessingOptions.ts'

test('volume normalization options always include distinct loudnorm (never track-only)', () => {
  const values = volumeNormalizationValues()
  assert.deepEqual(values, ['off', 'track', 'album', 'loudnorm'])
  assert.equal(VOLUME_NORMALIZATION_OPTIONS.length, 4)
  assert.ok(VOLUME_NORMALIZATION_OPTIONS.some((option) => option.value === 'loudnorm'))
  assert.ok(labelForVolumeNormalization('loudnorm').toLowerCase().includes('loudnorm'))
  assert.equal(requiresMeasuredLoudnorm('loudnorm'), true)
  assert.equal(requiresMeasuredLoudnorm('track'), false)
  assert.equal(isVolumeNormalizationMode('loudnorm'), true)
  assert.equal(isVolumeNormalizationMode('track_alias'), false)
})

test('DSD output mode options cover direct output routes', () => {
  assert.deepEqual(dsdOutputModeValues(), ['auto', 'pcm', 'dop', 'native'])
  assert.equal(DSD_OUTPUT_MODE_OPTIONS.length, 4)
  assert.equal(isDsdOutputMode('dop'), true)
  assert.equal(isDsdOutputMode('native-dsd'), false)
  assert.equal(isDsdOutputMode('unknown'), false)
})

test('loudnorm defaults and unity volume contract stay Stage-1 honest', () => {
  assert.equal(LOUDNORM_TARGET_LUFS, -23)
  assert.equal(LOUDNORM_TRUE_PEAK_CEILING_DB, -1)
  assert.equal(DEFAULT_SOFTWARE_VOLUME, 0.7)
  assert.equal(UNITY_SOFTWARE_VOLUME, 1)
  assert.notEqual(DEFAULT_SOFTWARE_VOLUME, UNITY_SOFTWARE_VOLUME)
  assert.match(HIFI_STATUS_COPY.volumeNotUnityHint, /70%/)
  assert.match(HIFI_STATUS_COPY.loudnormActive, /EBU R128/)
  assert.equal(loudnormStatusCopy('cached'), HIFI_STATUS_COPY.loudnormCached)
  assert.equal(loudnormStatusCopy('measuring'), HIFI_STATUS_COPY.loudnormMeasuring)
  assert.equal(loudnormStatusCopy('idle'), '')
})

test('gapless runtime status distinguishes intent, active, preload, and blocked reasons', () => {
  assert.deepEqual(GAPLESS_BLOCKED_REASONS, [
    'disabled',
    'dsd_path',
    'typed_passthrough',
    'crossfade',
    'format_mismatch'
  ])
  assert.equal(isGaplessBlockedReason('crossfade'), true)
  assert.equal(isGaplessBlockedReason('unknown'), false)
  assert.equal(gaplessBlockedReasonCopy('crossfade'), HIFI_STATUS_COPY.gaplessBlockedCrossfade)
  assert.equal(gaplessBlockedReasonCopy('dsd_path'), HIFI_STATUS_COPY.gaplessBlockedDsd)
  assert.equal(gaplessRuntimeStatusCopy({ intentEnabled: false }), HIFI_STATUS_COPY.gaplessOff)
  assert.equal(
    gaplessRuntimeStatusCopy({
      intentEnabled: true,
      gaplessBlockedReason: 'crossfade'
    }),
    HIFI_STATUS_COPY.gaplessBlockedCrossfade
  )
  assert.equal(
    gaplessRuntimeStatusCopy({
      intentEnabled: true,
      gaplessActive: true,
      preloadReady: true
    }),
    HIFI_STATUS_COPY.gaplessPreload
  )
  assert.equal(
    gaplessRuntimeStatusCopy({
      intentEnabled: true,
      gaplessActive: true,
      preloadReady: false
    }),
    HIFI_STATUS_COPY.gaplessActive
  )
  assert.equal(gaplessRuntimeStatusCopy({ intentEnabled: true }), HIFI_STATUS_COPY.gaplessOn)
})

test('DSD route defaults to off so existing installs keep current behavior', () => {
  assert.equal(DEFAULT_DSD_ROUTE.enabled, false)
  assert.equal(DEFAULT_DSD_ROUTE.backend, '')
  assert.equal(DEFAULT_DSD_ROUTE.device, '')
  assert.equal(DEFAULT_DSD_ROUTE.strictPassthrough, false)
  // PCM->DSD opt-in defaults on: if a user configures a proxy route at all,
  // upconverted DSD belongs on the same wire as decoded DSD.
  assert.equal(DEFAULT_DSD_ROUTE.applyToPcmToDsd, true)
  assert.ok(isDsdRouteSettings(DEFAULT_DSD_ROUTE))
})

test('DSD route normalization trims ids and coerces missing fields', () => {
  assert.deepEqual(normalizeDsdRouteSettings(undefined), DEFAULT_DSD_ROUTE)
  assert.deepEqual(normalizeDsdRouteSettings({}), DEFAULT_DSD_ROUTE)
  assert.deepEqual(normalizeDsdRouteSettings({ enabled: true, device: '  foo_dsd_asio  ' }), {
    enabled: true,
    backend: '',
    device: 'foo_dsd_asio',
    applyToPcmToDsd: true,
    strictPassthrough: false
  })
  // Non-boolean junk must not enable a route or strict mode.
  const coerced = normalizeDsdRouteSettings({ enabled: 'yes', strictPassthrough: 1 })
  assert.equal(coerced.enabled, false)
  assert.equal(coerced.strictPassthrough, false)
})

test('DSD route only diverges from the main output when a target is named', () => {
  assert.equal(dsdRouteTargetsDistinctRoute(DEFAULT_DSD_ROUTE), false)
  // Enabled but with no backend/device named is a no-op, not a broken route.
  assert.equal(dsdRouteTargetsDistinctRoute({ ...DEFAULT_DSD_ROUTE, enabled: true }), false)
  assert.equal(
    dsdRouteTargetsDistinctRoute({ ...DEFAULT_DSD_ROUTE, enabled: true, device: 'foo_dsd_asio' }),
    true
  )
  assert.equal(
    dsdRouteTargetsDistinctRoute({ ...DEFAULT_DSD_ROUTE, enabled: true, backend: 'asio' }),
    true
  )
  // Disabled wins over a named target.
  assert.equal(
    dsdRouteTargetsDistinctRoute({ ...DEFAULT_DSD_ROUTE, device: 'foo_dsd_asio' }),
    false
  )
})

test('DSD route equality detects every field so route edits reach the engine', () => {
  const base = { ...DEFAULT_DSD_ROUTE, enabled: true, device: 'foo_dsd_asio' }
  assert.ok(dsdRouteSettingsEqual(base, { ...base }))
  assert.equal(dsdRouteSettingsEqual(base, { ...base, enabled: false }), false)
  assert.equal(dsdRouteSettingsEqual(base, { ...base, backend: 'asio' }), false)
  assert.equal(dsdRouteSettingsEqual(base, { ...base, device: 'other' }), false)
  assert.equal(dsdRouteSettingsEqual(base, { ...base, applyToPcmToDsd: false }), false)
  assert.equal(dsdRouteSettingsEqual(base, { ...base, strictPassthrough: true }), false)
})

test('withDsdRoutePatch preserves untouched fields across a shallow merge', () => {
  const current = {
    enabled: true,
    backend: 'asio',
    device: 'foo_dsd_asio',
    applyToPcmToDsd: false,
    strictPassthrough: true
  }
  // The naive { enabled } patch is exactly what would wipe backend/device.
  assert.deepEqual(withDsdRoutePatch(current, { enabled: false }), {
    ...current,
    enabled: false
  })
  assert.deepEqual(withDsdRoutePatch(current, { device: '  other  ' }), {
    ...current,
    device: 'other'
  })
})

test('a flat gain band is transparent while a filter band never is', () => {
  assert.equal(equalizerBandAltersSignal({ gain: 0, filterType: 'peak' }), false)
  assert.equal(equalizerBandAltersSignal({ gain: 0, filterType: 'lowShelf' }), false)
  assert.equal(equalizerBandAltersSignal({ gain: 0.5, filterType: 'peak' }), true)
  // Filters reshape the signal at any gain, so the enable flag alone counts.
  assert.equal(equalizerBandAltersSignal({ gain: 0, filterType: 'highPass' }), true)
  assert.equal(equalizerBandAltersSignal({ gain: 0, filterType: 'notch' }), true)
  assert.equal(equalizerBandAltersSignal({ gain: 6, filterType: 'peak', enabled: false }), false)
})

test('an enabled but untouched equalizer does not count as processing', () => {
  const flatBands = [
    { frequency: 31, gain: 0, q: 1, filterType: 'peak' as const },
    { frequency: 1000, gain: 0, q: 1, filterType: 'peak' as const }
  ]
  // This is what blocked DSD passthrough for anyone who had ever switched the EQ
  // on: the toggle was read instead of what the EQ would do.
  assert.equal(
    equalizerSettingsAlterSignal({ eqEnabled: true, eqPreamp: 0, eqBands: flatBands }),
    false
  )
  assert.equal(
    equalizerSettingsAlterSignal({ eqEnabled: true, eqPreamp: -3, eqBands: flatBands }),
    true
  )
  assert.equal(
    equalizerSettingsAlterSignal({
      eqEnabled: true,
      eqPreamp: 0,
      eqBands: [{ ...flatBands[0], gain: 2 }]
    }),
    true
  )
  assert.equal(
    equalizerSettingsAlterSignal({ eqEnabled: false, eqPreamp: -6, eqBands: flatBands }),
    false
  )
})
