import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LIQUID_GLASS,
  DEFAULT_LIQUID_GLASS_DARK,
  DEFAULT_LIQUID_GLASS_HOME_CARDS,
  DEFAULT_LIQUID_GLASS_LIGHT,
  LIQUID_GLASS_BOUNDS,
  LIQUID_GLASS_CARD_SELECTOR,
  liquidGlassCssVariables,
  liquidGlassExpandedCssVariables,
  liquidGlassHomeCardCssVariables,
  normalizeLiquidGlass,
  normalizeLiquidGlassCoverage,
  normalizeLiquidGlassTheme,
  normalizeSurfaceMaterial,
  LIQUID_GLASS_SPECULAR_MAP_CEILING,
  resolveAberrationBlur,
  resolveChannelScales,
  resolveExpandedLiquidGlassTheme,
  resolveSpecularMapStrength,
  SURFACE_MATERIALS
} from './liquidGlass.ts'

test('surface material normalization only accepts known values', () => {
  assert.equal(normalizeSurfaceMaterial('liquidGlass'), 'liquidGlass')
  assert.equal(normalizeSurfaceMaterial('standard'), 'standard')
  assert.equal(normalizeSurfaceMaterial('LiquidGlass'), 'standard')
  assert.equal(normalizeSurfaceMaterial(undefined), 'standard')
  assert.equal(normalizeSurfaceMaterial(null), 'standard')
  assert.equal(normalizeSurfaceMaterial(1), 'standard')
  assert.deepEqual([...SURFACE_MATERIALS], ['standard', 'liquidGlass'])
})

test('clear glass selector is restricted to the media-rich dashboard hero', () => {
  assert.equal(LIQUID_GLASS_CARD_SELECTOR, '.home .feature-card')
})

test('theme normalization falls back per field and clamps to bounds', () => {
  const normalized = normalizeLiquidGlassTheme(
    {
      displacementScale: 9999,
      blurAmount: -40,
      saturation: 'nope',
      aberrationIntensity: Number.NaN,
      specularOpacity: 61,
      tintOpacity: 250
    },
    DEFAULT_LIQUID_GLASS_LIGHT
  )

  assert.equal(normalized.displacementScale, LIQUID_GLASS_BOUNDS.displacementScale.max)
  assert.equal(normalized.blurAmount, LIQUID_GLASS_BOUNDS.blurAmount.min)
  // non-numeric input must fall back, not clamp to a bound
  assert.equal(normalized.saturation, DEFAULT_LIQUID_GLASS_LIGHT.saturation)
  assert.equal(normalized.aberrationIntensity, DEFAULT_LIQUID_GLASS_LIGHT.aberrationIntensity)
  assert.equal(normalized.specularOpacity, 61)
  assert.equal(normalized.tintOpacity, LIQUID_GLASS_BOUNDS.tintOpacity.max)
})

test('non-finite numbers fall back rather than pinning to a bound', () => {
  // Infinity/-Infinity are numbers but not usable values, so they are treated
  // like a wrong type. Silently pinning them to a bound would hide bad input.
  const normalized = normalizeLiquidGlassTheme(
    { tintOpacity: Infinity, blurAmount: -Infinity, saturation: Number.NaN },
    DEFAULT_LIQUID_GLASS_LIGHT
  )

  assert.equal(normalized.tintOpacity, DEFAULT_LIQUID_GLASS_LIGHT.tintOpacity)
  assert.equal(normalized.blurAmount, DEFAULT_LIQUID_GLASS_LIGHT.blurAmount)
  assert.equal(normalized.saturation, DEFAULT_LIQUID_GLASS_LIGHT.saturation)
})

test('theme normalization accepts non-object input', () => {
  assert.deepEqual(
    normalizeLiquidGlassTheme(undefined, DEFAULT_LIQUID_GLASS_DARK),
    DEFAULT_LIQUID_GLASS_DARK
  )
  assert.deepEqual(
    normalizeLiquidGlassTheme('glass', DEFAULT_LIQUID_GLASS_DARK),
    DEFAULT_LIQUID_GLASS_DARK
  )
})

test('settings normalization defaults followPointer on and keeps both tones', () => {
  const normalized = normalizeLiquidGlass({})
  assert.equal(normalized.coverage, 'functional')
  assert.equal(normalized.followPointer, true)
  assert.equal(normalized.adaptiveTone, true)
  assert.deepEqual(normalized.light, DEFAULT_LIQUID_GLASS_LIGHT)
  assert.deepEqual(normalized.dark, DEFAULT_LIQUID_GLASS_DARK)
  assert.deepEqual(normalized.homeCards, DEFAULT_LIQUID_GLASS_HOME_CARDS)
  assert.equal(normalized.navigationEnabled, false)
  assert.equal(normalized.playbarEnabled, false)
  assert.equal(normalized.settingsNavigationEnabled, false)

  assert.equal(normalizeLiquidGlass({ followPointer: false }).followPointer, false)
  // only an explicit false disables it
  assert.equal(normalizeLiquidGlass({ followPointer: 0 }).followPointer, true)
})

test('coverage normalization only enables the explicit expanded mode', () => {
  assert.equal(normalizeLiquidGlassCoverage('expanded'), 'expanded')
  assert.equal(normalizeLiquidGlassCoverage('functional'), 'functional')
  assert.equal(normalizeLiquidGlassCoverage('legacy'), 'functional')
  assert.equal(normalizeLiquidGlass({ coverage: 'expanded' }).coverage, 'expanded')
  assert.equal(normalizeLiquidGlass({ coverage: true }).coverage, 'functional')
})

test('normalization never aliases the exported default objects', () => {
  const normalized = normalizeLiquidGlass({})
  normalized.light.blurAmount = 1
  normalized.dark.blurAmount = 2

  assert.notEqual(normalized.light, DEFAULT_LIQUID_GLASS_LIGHT)
  assert.notEqual(normalized.dark, DEFAULT_LIQUID_GLASS_DARK)
  // Values track the tuned defaults in liquidGlass.ts. The point of the test is
  // that mutating a normalized copy never writes through to the exported
  // constants, so these read the real defaults rather than a placeholder 0.
  assert.equal(DEFAULT_LIQUID_GLASS_LIGHT.blurAmount, 5)
  assert.equal(DEFAULT_LIQUID_GLASS_DARK.blurAmount, 5)
  assert.equal(DEFAULT_LIQUID_GLASS.light.blurAmount, 5)
  assert.equal(DEFAULT_LIQUID_GLASS.dark.elasticity, 10)
  assert.equal(DEFAULT_LIQUID_GLASS.overLight, false)
  assert.equal(DEFAULT_LIQUID_GLASS.coverage, 'functional')
  assert.equal(DEFAULT_LIQUID_GLASS.homeCards.enabled, false)
})

test('expanded profiles cap high-cost optical parameters without mutating the source', () => {
  const source = {
    displacementScale: 80,
    blurAmount: 28,
    saturation: 180,
    aberrationIntensity: 2,
    elasticity: 60,
    specularOpacity: 70,
    tintOpacity: 12
  }
  const expanded = resolveExpandedLiquidGlassTheme(source)
  assert.deepEqual(expanded, {
    // Percent of the physically correct lens amplitude, not a pixel count.
    displacementScale: 35,
    blurAmount: 16,
    saturation: 150,
    aberrationIntensity: 0.5,
    elasticity: 0,
    specularOpacity: 36,
    tintOpacity: 12
  })
  assert.equal(source.displacementScale, 80)
})

test('channel scales trail red to produce aberration and never invert', () => {
  const scales = resolveChannelScales(70, 2)
  assert.equal(scales.red, 70)
  assert.ok(scales.green < scales.red, 'green trails red')
  assert.ok(scales.blue < scales.green, 'blue trails green')

  // zero aberration collapses the channels together (no fringing)
  const flat = resolveChannelScales(70, 0)
  assert.equal(flat.red, flat.green)
  assert.equal(flat.green, flat.blue)

  // extreme aberration must not push a channel negative
  const extreme = resolveChannelScales(10, 8)
  assert.ok(extreme.green >= 0)
  assert.ok(extreme.blue >= 0)
})

test('channel scales stay at zero when displacement is off', () => {
  const off = resolveChannelScales(0, 4)
  assert.deepEqual(off, { red: 0, green: 0, blue: 0 })
})

test('aberration blur stays in a usable range', () => {
  assert.equal(resolveAberrationBlur(0), 0.5)
  assert.ok(resolveAberrationBlur(8) >= 0.1, 'blur never reaches zero or negative')
  assert.ok(resolveAberrationBlur(2) < resolveAberrationBlur(0), 'more aberration, less softening')
})

test('css variables carry units the stylesheet expects', () => {
  const vars = liquidGlassCssVariables({
    displacementScale: 70,
    blurAmount: 16,
    saturation: 140,
    aberrationIntensity: 2,
    elasticity: 40,
    specularOpacity: 55,
    tintOpacity: 12
  })

  assert.equal(vars['--te-lg-displacement'], '70')
  assert.equal(vars['--te-lg-blur'], '16px')
  assert.equal(vars['--te-lg-saturate'], '140%')
  assert.equal(vars['--te-lg-aberration'], '2')
  assert.equal(vars['--te-lg-elasticity'], '40')
  // opacities are emitted as 0-1 ratios for direct use in color functions
  assert.equal(vars['--te-lg-specular'], '0.550')
  assert.equal(vars['--te-lg-tint'], '0.120')
})

test('homepage cards normalize independently and emit their own variables', () => {
  const normalized = normalizeLiquidGlass({
    homeCards: {
      enabled: true,
      overLight: true,
      light: { blurAmount: 22, tintOpacity: 31 }
    }
  })
  assert.equal(normalized.homeCards.enabled, true)
  assert.equal(normalized.homeCards.overLight, true)
  assert.equal(normalized.homeCards.light.blurAmount, 22)
  assert.equal(normalized.homeCards.light.tintOpacity, 31)
  assert.notEqual(normalized.homeCards.light, DEFAULT_LIQUID_GLASS_HOME_CARDS.light)

  const variables = liquidGlassHomeCardCssVariables(normalized.homeCards.light)
  assert.equal(variables['--te-home-lg-blur'], '22px')
  assert.equal(variables['--te-home-lg-tint'], '0.310')
  assert.equal(variables['--te-home-lg-displacement'], '95')
})

test('expanded CSS variables carry the bounded profile units', () => {
  const variables = liquidGlassExpandedCssVariables({
    displacementScale: 70,
    blurAmount: 20,
    saturation: 180,
    aberrationIntensity: 2,
    elasticity: 40,
    specularOpacity: 55,
    tintOpacity: 12
  })
  assert.equal(variables['--te-lg-expanded-displacement'], '35')
  assert.equal(variables['--te-lg-expanded-blur'], '16px')
  assert.equal(variables['--te-lg-expanded-saturate'], '150%')
  assert.equal(variables['--te-lg-expanded-aberration'], '0.5')
  assert.equal(variables['--te-lg-expanded-elasticity'], '0')
  assert.equal(variables['--te-lg-expanded-specular'], '0.360')
})

test('independent shared targets normalize to strict booleans', () => {
  const enabled = normalizeLiquidGlass({
    navigationEnabled: true,
    playbarEnabled: true,
    settingsNavigationEnabled: true
  })
  assert.equal(enabled.navigationEnabled, true)
  assert.equal(enabled.playbarEnabled, true)
  assert.equal(enabled.settingsNavigationEnabled, true)

  const invalid = normalizeLiquidGlass({
    navigationEnabled: 1,
    playbarEnabled: 1,
    settingsNavigationEnabled: 'yes'
  })
  assert.equal(invalid.navigationEnabled, false)
  assert.equal(invalid.playbarEnabled, false)
  assert.equal(invalid.settingsNavigationEnabled, false)
})

test('new tuning fields normalize and clamp to their bounds', () => {
  const normalized = normalizeLiquidGlassTheme(
    {
      displacementScale: 90,
      blurAmount: 0,
      saturation: 100,
      aberrationIntensity: 1.5,
      elasticity: 999,
      specularOpacity: 41,
      tintOpacity: 10
    },
    DEFAULT_LIQUID_GLASS_LIGHT
  )
  assert.equal(normalized.elasticity, 100)
  assert.equal(normalized.displacementScale, 90)
  assert.equal(normalized.blurAmount, 0)
  assert.equal(normalized.saturation, 100)
})

test('over light flag normalizes to a strict boolean', () => {
  assert.equal(normalizeLiquidGlass({ overLight: true }).overLight, true)
  assert.equal(normalizeLiquidGlass({ overLight: 1 }).overLight, false)
  assert.equal(normalizeLiquidGlass({}).overLight, false)
})

test('adaptive tone defaults on and only an explicit false disables it', () => {
  assert.equal(normalizeLiquidGlass({}).adaptiveTone, true)
  assert.equal(normalizeLiquidGlass({ adaptiveTone: true }).adaptiveTone, true)
  assert.equal(normalizeLiquidGlass({ adaptiveTone: false }).adaptiveTone, false)
  assert.equal(normalizeLiquidGlass({ adaptiveTone: 0 }).adaptiveTone, true)
})

test('specular map strength scales the setting by the ceiling', () => {
  assert.equal(resolveSpecularMapStrength(0), 0)
  assert.equal(resolveSpecularMapStrength(100), LIQUID_GLASS_SPECULAR_MAP_CEILING)
  assert.equal(resolveSpecularMapStrength(50), LIQUID_GLASS_SPECULAR_MAP_CEILING * 0.5)
})

test('specular map strength stays well under full white', () => {
  // The baked highlight stacks with the CSS rim and sheen layers, which read the
  // same setting. A ceiling at or near 1 blows the rim out to plain white.
  assert.ok(LIQUID_GLASS_SPECULAR_MAP_CEILING > 0, 'the highlight must be visible')
  assert.ok(LIQUID_GLASS_SPECULAR_MAP_CEILING < 1, 'the highlight must leave headroom')
  for (let opacity = 0; opacity <= 100; opacity += 5) {
    const strength = resolveSpecularMapStrength(opacity)
    assert.ok(strength >= 0 && strength < 1, `out of range at ${opacity}: ${strength}`)
  }
})

test('specular map strength clamps out-of-range and non-finite input', () => {
  assert.equal(resolveSpecularMapStrength(-20), 0)
  assert.equal(resolveSpecularMapStrength(500), LIQUID_GLASS_SPECULAR_MAP_CEILING)
  assert.equal(resolveSpecularMapStrength(Number.NaN), 0)
  assert.equal(
    resolveSpecularMapStrength(Number.POSITIVE_INFINITY),
    LIQUID_GLASS_SPECULAR_MAP_CEILING
  )
})

test('specular map strength rises monotonically with the setting', () => {
  let previous = -1
  for (let opacity = 0; opacity <= 100; opacity += 5) {
    const strength = resolveSpecularMapStrength(opacity)
    assert.ok(strength > previous, `not monotonic at ${opacity}`)
    previous = strength
  }
})

test('the default profiles produce a visible but restrained baked highlight', () => {
  for (const theme of [DEFAULT_LIQUID_GLASS_LIGHT, DEFAULT_LIQUID_GLASS_DARK]) {
    const strength = resolveSpecularMapStrength(theme.specularOpacity)
    assert.ok(strength > 0.2, `default highlight too faint: ${strength}`)
    assert.ok(strength < 0.5, `default highlight too strong: ${strength}`)
  }
})
