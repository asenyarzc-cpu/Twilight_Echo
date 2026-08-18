import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDisplacementPixels,
  CARD_DISPLACEMENT_BUCKET,
  clearDisplacementMapCache,
  DEFAULT_RIM_FRACTION,
  getDisplacementMapUrl,
  NEUTRAL_BYTE,
  PLAYBAR_DISPLACEMENT_BUCKET,
  rimMagnitude,
  roundedRectSDF,
  sdfNormal,
  sdfRimDisplacement,
  smoothStep,
  type RoundedRectShape
} from './liquidGlassDisplacement.ts'

const SQUARE_SHAPE: RoundedRectShape = { halfWidth: 32, halfHeight: 32, radius: 7.04 }

test('smoothStep clamps to its edges and eases between them', () => {
  assert.equal(smoothStep(0, 1, -5), 0)
  assert.equal(smoothStep(0, 1, 0), 0)
  assert.equal(smoothStep(0, 1, 1), 1)
  assert.equal(smoothStep(0, 1, 5), 1)
  assert.equal(smoothStep(0, 1, 0.5), 0.5)

  // eased, not linear
  assert.ok(smoothStep(0, 1, 0.25) < 0.25)
  assert.ok(smoothStep(0, 1, 0.75) > 0.75)
})

test('smoothStep handles an inverted edge pair', () => {
  assert.equal(smoothStep(0.8, 0, 0.9), 0)
  assert.equal(smoothStep(0.8, 0, -0.1), 1)
})

test('roundedRectSDF is negative inside and positive outside', () => {
  assert.ok(roundedRectSDF(0, 0, 0.3, 0.2, 0.1) < 0, 'center is inside')
  assert.ok(roundedRectSDF(5, 5, 0.3, 0.2, 0.1) > 0, 'far corner is outside')
})

test('roundedRectSDF is symmetric across both axes', () => {
  const base = roundedRectSDF(0.17, 0.09, 0.3, 0.2, 0.6)
  assert.equal(roundedRectSDF(-0.17, 0.09, 0.3, 0.2, 0.6), base)
  assert.equal(roundedRectSDF(0.17, -0.09, 0.3, 0.2, 0.6), base)
  assert.equal(roundedRectSDF(-0.17, -0.09, 0.3, 0.2, 0.6), base)
})

test('rim magnitude peaks at the border and vanishes toward the middle', () => {
  assert.equal(rimMagnitude(0, DEFAULT_RIM_FRACTION), 1, 'border refracts fully')
  assert.equal(rimMagnitude(1, DEFAULT_RIM_FRACTION), 1, 'other border too')
  assert.equal(rimMagnitude(0.5, DEFAULT_RIM_FRACTION), 0, 'middle is clean')
})

test('rim magnitude decreases monotonically from border to middle', () => {
  let previous = Infinity
  for (let i = 0; i <= 20; i++) {
    const value = rimMagnitude(i / 40, DEFAULT_RIM_FRACTION)
    assert.ok(value <= previous + 1e-12, `not monotonic at ${i / 40}: ${value} > ${previous}`)
    previous = value
  }
})

test('rim magnitude stays within [0, 1] and is symmetric', () => {
  for (let i = 0; i <= 50; i++) {
    const u = i / 50
    const value = rimMagnitude(u, DEFAULT_RIM_FRACTION)
    assert.ok(value >= 0 && value <= 1, `out of range at ${u}: ${value}`)
    assert.ok(
      Math.abs(value - rimMagnitude(1 - u, DEFAULT_RIM_FRACTION)) < 1e-12,
      `asymmetric at ${u}`
    )
  }
})

test('a wider rim fraction refracts further inward', () => {
  const probe = 0.25
  assert.ok(
    rimMagnitude(probe, 0.8) > rimMagnitude(probe, 0.2),
    'wider rim reaches deeper into the surface'
  )
})

test('sdfNormal is a unit vector pointing outward', () => {
  const straightEdge = sdfNormal(-31.5, 0.5, SQUARE_SHAPE)
  assert.equal(straightEdge.x, -1, 'left edge normal points left')
  assert.equal(straightEdge.y, 0, 'left edge normal has no Y component')
  assert.ok(Math.hypot(straightEdge.x, straightEdge.y) - 1 < 1e-12, 'unit length')

  const corner = sdfNormal(28.5, -28.5, SQUARE_SHAPE)
  const length = Math.hypot(corner.x, corner.y)
  assert.ok(Math.abs(length - 1) < 1e-12, `corner normal is unit length, got ${length}`)
  assert.ok(corner.x > 0 && corner.y < 0, 'top-right corner normal points up-right')
  assert.ok(Math.abs(Math.abs(corner.x) - Math.abs(corner.y)) < 1e-12, '45° on the diagonal')
})

test('sdfRimDisplacement points inward on every side', () => {
  const rimWidth = DEFAULT_RIM_FRACTION * 64
  assert.ok(sdfRimDisplacement(-31.5, 0, SQUARE_SHAPE, rimWidth).x > 0, 'left pushes right')
  assert.ok(sdfRimDisplacement(31.5, 0, SQUARE_SHAPE, rimWidth).x < 0, 'right pushes left')
  assert.ok(sdfRimDisplacement(0, -31.5, SQUARE_SHAPE, rimWidth).y > 0, 'top pushes down')
  assert.ok(sdfRimDisplacement(0, 31.5, SQUARE_SHAPE, rimWidth).y < 0, 'bottom pushes up')
})

test('sdfRimDisplacement is zero at the exact center', () => {
  const center = sdfRimDisplacement(0, 0, SQUARE_SHAPE, DEFAULT_RIM_FRACTION * 64)
  assert.equal(center.x, 0)
  assert.equal(center.y, 0)
  assert.equal(center.magnitude, 0)
})

test('sdfRimDisplacement is antisymmetric about the center', () => {
  const rimWidth = DEFAULT_RIM_FRACTION * 64
  const a = sdfRimDisplacement(-24, -20, SQUARE_SHAPE, rimWidth)
  const b = sdfRimDisplacement(24, 20, SQUARE_SHAPE, rimWidth)
  assert.ok(Math.abs(a.x + b.x) < 1e-12, 'x mirrors')
  assert.ok(Math.abs(a.y + b.y) < 1e-12, 'y mirrors')
  assert.equal(a.magnitude, b.magnitude, 'magnitude mirrors')
})

test('corner regions refract diagonally, straight edges stay single-axis', () => {
  const rimWidth = DEFAULT_RIM_FRACTION * 64
  // Top-right corner area: both channels deviate, pointing diagonally inward.
  const corner = sdfRimDisplacement(28.5, -28.5, SQUARE_SHAPE, rimWidth)
  assert.ok(corner.x < 0, 'corner pulls left (inward)')
  assert.ok(corner.y > 0, 'corner pulls down (inward)')
  assert.ok(Math.abs(corner.x) > 0.1 && Math.abs(corner.y) > 0.1, 'both axes are engaged')

  // Straight left edge midpoint: purely horizontal.
  const edge = sdfRimDisplacement(-31.5, 0.5, SQUARE_SHAPE, rimWidth)
  assert.ok(edge.x > 0.1, 'edge pulls inward on X')
  assert.equal(edge.y, 0, 'edge has no Y component')
})

test('pixel buffer has RGBA length and encodes rim magnitude in alpha', () => {
  const w = 24
  const h = 16
  const pixels = buildDisplacementPixels(w, h)

  assert.equal(pixels.length, w * h * 4)
  assert.ok(pixels instanceof Uint8ClampedArray)
  const alpha = (x: number, y: number): number => pixels[(y * w + x) * 4 + 3]
  assert.ok(alpha(Math.trunc(w / 2), Math.trunc(h / 2)) <= 2, 'center magnitude is zero')
  assert.ok(alpha(0, Math.trunc(h / 2)) > 200, 'border magnitude is near full')
})

test('alpha magnitude decreases monotonically from border to center', () => {
  const size = 64
  const pixels = buildDisplacementPixels(size, size)
  const y = size / 2
  let previous = Infinity
  for (let x = 0; x <= size / 2; x++) {
    const value = pixels[(y * size + x) * 4 + 3]
    assert.ok(value <= previous + 1, `not monotonic at x=${x}: ${value} > ${previous}`)
    previous = value
  }
})

test('G and B channels carry the same Y offset', () => {
  const pixels = buildDisplacementPixels(20, 20)
  for (let p = 0; p < pixels.length; p += 4) {
    assert.equal(pixels[p + 1], pixels[p + 2], `G/B mismatch at byte ${p}`)
  }
})

test('map center is neutral so the middle of a surface is not displaced', () => {
  const size = 32
  const pixels = buildDisplacementPixels(size, size)
  const mid = ((size / 2) * size + size / 2) * 4

  assert.ok(Math.abs(pixels[mid] - NEUTRAL_BYTE) <= 2, `R center ${pixels[mid]}`)
  assert.ok(Math.abs(pixels[mid + 1] - NEUTRAL_BYTE) <= 2, `G center ${pixels[mid + 1]}`)
})

test('map carries strong displacement at the border', () => {
  const size = 64
  const pixels = buildDisplacementPixels(size, size)
  const y = size / 2

  const leftR = pixels[(y * size + 0) * 4]
  const rightR = pixels[(y * size + (size - 1)) * 4]

  // border must deviate hard from neutral, or nothing visibly refracts
  assert.ok(leftR - NEUTRAL_BYTE > 100, `left border R was ${leftR}`)
  assert.ok(NEUTRAL_BYTE - rightR > 100, `right border R was ${rightR}`)
})

test('displacement is strongest at the border and weakest at the center', () => {
  const size = 64
  const pixels = buildDisplacementPixels(size, size)
  const y = size / 2
  const deviation = (x: number): number => {
    const value = pixels[(y * size + Math.trunc(x)) * 4]
    assert.equal(typeof value, 'number', `no pixel at x=${x}`)
    return Math.abs(value - NEUTRAL_BYTE)
  }

  // Probes stay inside the rim (0.16 of the short axis ≈ 10px) so the falloff
  // is visible before the field reaches its clean center.
  assert.ok(deviation(0) > deviation(2), 'border beats near-rim')
  assert.ok(deviation(2) > deviation(size / 2), 'near-rim beats center')
})

test('map is symmetric left-to-right and top-to-bottom', () => {
  const size = 32
  const pixels = buildDisplacementPixels(size, size)
  const at = (x: number, y: number, channel: number): number => pixels[(y * size + x) * 4 + channel]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // R mirrors with inverted sign around neutral. Neutral is 128 while the byte
      // midpoint is 127.5, so quantization allows one unit of slack.
      const left = at(x, y, 0) - NEUTRAL_BYTE
      const right = at(size - 1 - x, y, 0) - NEUTRAL_BYTE
      assert.ok(Math.abs(left + right) <= 1, `R asymmetry at ${x},${y}: ${left} vs ${right}`)
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const top = at(x, y, 1) - NEUTRAL_BYTE
      const bottom = at(x, size - 1 - y, 1) - NEUTRAL_BYTE
      assert.ok(Math.abs(top + bottom) <= 1, `G asymmetry at ${x},${y}: ${top} vs ${bottom}`)
    }
  }
})

test('corner pixels deviate on both channels while edge midpoints stay single-axis', () => {
  const size = 64
  const pixels = buildDisplacementPixels(size, size)
  const at = (x: number, y: number, channel: number): number =>
    pixels[(y * size + x) * 4 + channel]

  // Top-right corner region: diagonal inward pull engages R and G together.
  const cornerR = at(size - 4, 3, 0) - NEUTRAL_BYTE
  const cornerG = at(size - 4, 3, 1) - NEUTRAL_BYTE
  assert.ok(cornerR < -20, `corner R deviates inward, was ${cornerR}`)
  assert.ok(cornerG > 20, `corner G deviates inward, was ${cornerG}`)

  // Left edge midpoint: R only.
  assert.ok(at(0, size / 2, 0) - NEUTRAL_BYTE > 100, 'edge R deviates')
  assert.ok(Math.abs(at(0, size / 2, 1) - NEUTRAL_BYTE) <= 2, 'edge G stays neutral')
})

test('non-square buckets are supported for the wide playbar strip', () => {
  const pixels = buildDisplacementPixels(64, 8)
  assert.equal(pixels.length, 64 * 8 * 4)

  // The short axis still refracts on a wide strip. On an 8px axis the first pixel
  // center already sits ~6% inward, so the peak is below the full-border value.
  const midX = 32
  const topG = pixels[(0 * 64 + midX) * 4 + 1]
  const bottomG = pixels[(7 * 64 + midX) * 4 + 1]
  assert.ok(topG - NEUTRAL_BYTE > 60, `top edge G was ${topG}`)
  assert.ok(NEUTRAL_BYTE - bottomG > 60, `bottom edge G was ${bottomG}`)

  // and the long axis refracts independently of the short one
  const midY = 4
  const leftR = pixels[(midY * 64 + 0) * 4]
  assert.ok(leftR - NEUTRAL_BYTE > 60, `left edge R was ${leftR}`)
})

test('a wider corner fraction rounds more of the map', () => {
  const size = 64
  const y = 3
  const sharp = buildDisplacementPixels(size, size, DEFAULT_RIM_FRACTION, 0.05)
  const round = buildDisplacementPixels(size, size, DEFAULT_RIM_FRACTION, 0.45)

  // Near the top edge but off to the side, the sharper map still sits on a
  // straight edge (Y-only displacement) while the rounder map is past its corner
  // start and gains an X component.
  const sharpX = sharp[(y * size + 58) * 4] - NEUTRAL_BYTE
  const roundX = round[(y * size + 58) * 4] - NEUTRAL_BYTE
  assert.ok(Math.abs(sharpX) <= 2, `sharp map corner should not pull on X, was ${sharpX}`)
  assert.ok(roundX < -5, `round map corner should pull inward on X, was ${roundX}`)
})

test('invalid sizes are rejected rather than producing a broken map', () => {
  assert.throws(() => buildDisplacementPixels(0, 10), /invalid displacement map size/)
  assert.throws(() => buildDisplacementPixels(10, 0), /invalid displacement map size/)
  assert.throws(() => buildDisplacementPixels(-4, 4), /invalid displacement map size/)
  assert.throws(() => buildDisplacementPixels(4.5, 4), /invalid displacement map size/)
})

test('bucket presets are sane and distinct', () => {
  assert.ok(CARD_DISPLACEMENT_BUCKET.width > 0 && CARD_DISPLACEMENT_BUCKET.height > 0)
  assert.ok(
    PLAYBAR_DISPLACEMENT_BUCKET.width > PLAYBAR_DISPLACEMENT_BUCKET.height,
    'playbar bucket is a wide strip'
  )
  assert.notEqual(
    `${CARD_DISPLACEMENT_BUCKET.width}x${CARD_DISPLACEMENT_BUCKET.height}`,
    `${PLAYBAR_DISPLACEMENT_BUCKET.width}x${PLAYBAR_DISPLACEMENT_BUCKET.height}`
  )
})

test('map url generation degrades to empty string without a DOM', () => {
  clearDisplacementMapCache()
  // node test env has no document; callers are expected to skip the filter
  assert.equal(typeof globalThis.document, 'undefined')
  assert.equal(getDisplacementMapUrl(CARD_DISPLACEMENT_BUCKET), '')
})
