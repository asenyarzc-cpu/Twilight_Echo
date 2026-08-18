import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADAPTIVE_TONE_LUMINANCE_THRESHOLD,
  analyzeLiquidGlassColor,
  analyzeLiquidGlassPixels,
  extractCssImageUrl,
  fallbackLiquidGlassEnvironment,
  isTrustedLiquidGlassImageUrl,
  resolveAdaptiveGlassTone
} from './liquidGlassEnvironment.ts'

function pixels(...values: number[]): Uint8ClampedArray {
  return new Uint8ClampedArray(values)
}

test('bright and dark samples choose opposing label contrast', () => {
  const bright = analyzeLiquidGlassPixels(pixels(250, 248, 244, 255), false)
  const dark = analyzeLiquidGlassPixels(pixels(12, 18, 28, 255), false)

  assert.equal(bright.context, 'bright')
  assert.equal(bright.variables['--te-lg-context-label-rgb'], '15, 23, 42')
  assert.equal(dark.context, 'dark')
  assert.equal(dark.variables['--te-lg-context-label-rgb'], '248, 250, 252')
})

test('solid colour backgrounds produce a visible material substrate', () => {
  const light = analyzeLiquidGlassColor('#ffffff', false)
  const dark = analyzeLiquidGlassColor('#17181a', false)

  assert.equal(light.context, 'bright')
  assert.equal(dark.context, 'dark')
  assert.match(light.variables['--te-lg-context-material'], /^rgb\(/)
  assert.match(dark.variables['--te-lg-context-material'], /^rgb\(/)
  assert.notEqual(
    light.variables['--te-lg-context-material'],
    light.variables['--te-lg-context-surface']
  )
})

test('invalid solid colours use the deterministic environment fallback', () => {
  assert.deepEqual(
    analyzeLiquidGlassColor('linear-gradient(#fff, #000)', true),
    fallbackLiquidGlassEnvironment(true)
  )
})

test('busy image samples keep all generated material values bounded', () => {
  const environment = analyzeLiquidGlassPixels(
    pixels(0, 0, 0, 255, 255, 255, 255, 255, 0, 60, 190, 255, 255, 160, 0, 255),
    false
  )

  assert.equal(environment.context, 'busy')
  const density = Number(environment.variables['--te-lg-context-surface-alpha'])
  const shadow = Number(environment.variables['--te-lg-context-shadow-alpha'])
  assert.ok(density >= 0.24 && density <= 0.68)
  assert.ok(shadow >= 0.1 && shadow <= 0.36)
})

test('transparent or unreadable pixels use deterministic tone fallbacks', () => {
  const transparent = analyzeLiquidGlassPixels(pixels(255, 255, 255, 0), true)
  assert.deepEqual(transparent, fallbackLiquidGlassEnvironment(true))
  assert.equal(transparent.context, 'dark')
})

test('adaptive tone flips light glass over a bright backdrop only', () => {
  assert.equal(resolveAdaptiveGlassTone(0.9, 'light'), 'dark', 'bright backdrop darkens light glass')
  assert.equal(
    resolveAdaptiveGlassTone(ADAPTIVE_TONE_LUMINANCE_THRESHOLD, 'light'),
    'dark',
    'threshold is inclusive'
  )
  assert.equal(resolveAdaptiveGlassTone(0.4, 'light'), 'light', 'dim backdrop keeps light glass')
  assert.equal(resolveAdaptiveGlassTone(0.9, 'dark'), 'dark', 'dark glass never flips to light')
  assert.equal(resolveAdaptiveGlassTone(0.1, 'dark'), 'dark')
  assert.equal(resolveAdaptiveGlassTone(Number.NaN, 'light'), 'light', 'invalid sample is inert')
})

test('sampled environments expose their luminance for the adaptive decision', () => {
  const bright = analyzeLiquidGlassPixels(pixels(250, 248, 244, 255), false)
  const dark = analyzeLiquidGlassPixels(pixels(12, 18, 28, 255), false)
  assert.ok(bright.luminance > ADAPTIVE_TONE_LUMINANCE_THRESHOLD)
  assert.ok(dark.luminance < ADAPTIVE_TONE_LUMINANCE_THRESHOLD)
  assert.equal(
    typeof fallbackLiquidGlassEnvironment(false).luminance,
    'number',
    'fallback environments carry luminance too'
  )
})

test('only app-owned image URLs are admitted to the sampler', () => {
  for (const source of [
    'background://wallpaper',
    'theme-asset://asset/theme/cover.webp',
    'cover:current',
    'twilight-media:local/cover',
    'blob:app-resource',
    'data:image/png;base64,AAAA'
  ]) {
    assert.equal(isTrustedLiquidGlassImageUrl(source), true, source)
  }
  assert.equal(isTrustedLiquidGlassImageUrl('https://example.test/cover.jpg'), false)
  assert.equal(isTrustedLiquidGlassImageUrl('javascript:alert(1)'), false)
})

test('CSS url extraction rejects gradients and preserves known image resources', () => {
  assert.equal(extractCssImageUrl('url("background://wallpaper")'), 'background://wallpaper')
  assert.equal(
    extractCssImageUrl("url('theme-asset://asset/theme/cover.webp')"),
    'theme-asset://asset/theme/cover.webp'
  )
  assert.equal(extractCssImageUrl('linear-gradient(#fff, #000)'), null)
  assert.equal(extractCssImageUrl('none'), null)
})
