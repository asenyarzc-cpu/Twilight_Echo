import assert from 'node:assert/strict'
import test from 'node:test'
import { BASE_HIGHLIGHT_ANGLE } from './liquidGlassPointer.ts'
import {
  buildDisplacementPixels,
  NOMINAL_CARD_GEOMETRY,
  NOMINAL_PLAYBAR_GEOMETRY,
  roundedRectSDF,
  type RoundedRectShape
} from './liquidGlassDisplacement.ts'
import {
  BAYER_8X8,
  bayerOffset,
  buildSpecularPixels as buildSpecularRaster,
  clearSpecularMapCache,
  DEFAULT_SPECULAR_ANGLE_DEG,
  getSpecularMapUrl,
  lightVectorFromAngle,
  liquidRel,
  screenCombine,
  SPECULAR_EDGE_BAND_PX,
  SPECULAR_MIN_INCIDENCE,
  specularIntensity,
  specularTerms
} from './liquidGlassSpecular.ts'

/**
 * The fractions the maps used to be baked with, kept here as test geometry. The
 * production path now measures a real element instead, but the field's shape is
 * what these assertions are about, so a fixed shape keeps them deterministic.
 */
const RIM_FRACTION = 0.16
const CORNER_FRACTION = 0.22

const SQUARE_SHAPE: RoundedRectShape = { halfWidth: 32, halfHeight: 32, radius: 14.08 }
const SQUARE_RIM = RIM_FRACTION * 64
const LIGHT = lightVectorFromAngle(DEFAULT_SPECULAR_ANGLE_DEG)

/**
 * Bakes at a size with the legacy fraction-derived shape. `buildSpecularPixels`
 * now takes a geometry with an absolute radius and band width; expressing the old
 * fractions through it keeps every assertion below comparable.
 */
function buildSpecularPixels(
  width: number,
  height: number,
  rimFraction: number = RIM_FRACTION,
  cornerFraction: number = CORNER_FRACTION,
  angleDegrees: number = DEFAULT_SPECULAR_ANGLE_DEG
): Uint8ClampedArray {
  const short = Math.min(width, height)
  return buildSpecularRaster(
    {
      width,
      height,
      radius: cornerFraction * short,
      blurRadius: rimFraction * short
    },
    angleDegrees
  ).pixels
}

/** Alpha of the baked map at a pixel. */
function alphaAt(pixels: Uint8ClampedArray, width: number, x: number, y: number): number {
  return pixels[(y * width + x) * 4 + 3]
}

/**
 * A point on the rim at a fixed depth, found by marching inward from outside the
 * shape along a ray from the center.
 *
 * Comparing two rim points only isolates incidence if both sit at the same depth:
 * the sheen falls off steeply inward, so a shallower point with poor incidence can
 * outshine a deeper point with perfect incidence. Every directional assertion below
 * therefore sweeps at constant depth rather than picking coordinates by hand.
 */
function rimPointAtDepth(
  angleDegrees: number,
  depth: number,
  shape: RoundedRectShape
): { x: number; y: number } {
  const radians = (angleDegrees * Math.PI) / 180
  const dirX = Math.cos(radians)
  const dirY = Math.sin(radians)
  const target = -depth
  let low = 0
  let high = Math.hypot(shape.halfWidth, shape.halfHeight) * 2
  // The SDF decreases monotonically inward along the ray, so bisect on it.
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2
    const distance = roundedRectSDF(
      dirX * mid,
      dirY * mid,
      shape.halfWidth,
      shape.halfHeight,
      shape.radius
    )
    if (distance > target) high = mid
    else low = mid
  }
  const radius = (low + high) / 2
  return { x: dirX * radius, y: dirY * radius }
}

/** Combined intensity at a fixed depth and rim angle. */
function intensityAtAngle(angleDegrees: number, depth: number): number {
  const point = rimPointAtDepth(angleDegrees, depth, SQUARE_SHAPE)
  return specularIntensity(point.x, point.y, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
}

/** Sheen term alone at a fixed depth and rim angle. */
function sheenAtAngle(angleDegrees: number, depth: number): number {
  const point = rimPointAtDepth(angleDegrees, depth, SQUARE_SHAPE)
  return specularTerms(point.x, point.y, SQUARE_SHAPE, SQUARE_RIM, LIGHT).sheen
}

test('the baked light angle matches the CSS highlight convention', () => {
  // Both layers must agree, otherwise the baked rim and the CSS sheen light the
  // surface from two different directions.
  assert.equal(DEFAULT_SPECULAR_ANGLE_DEG, BASE_HIGHLIGHT_ANGLE)
})

test('light vector points up-left for the default angle', () => {
  const light = lightVectorFromAngle(DEFAULT_SPECULAR_ANGLE_DEG)
  assert.ok(light.x < 0, 'light is to the left')
  assert.ok(light.y < 0, 'light is above (screen y grows downward)')
  assert.ok(Math.abs(Math.hypot(light.x, light.y) - 1) < 1e-12, 'unit length')
  assert.ok(Math.abs(Math.abs(light.x) - Math.abs(light.y)) < 1e-12, '45° on the diagonal')
})

test('light vector is a unit vector at every angle and rotates with it', () => {
  for (let angle = 0; angle < 360; angle += 15) {
    const light = lightVectorFromAngle(angle)
    assert.ok(Math.abs(Math.hypot(light.x, light.y) - 1) < 1e-12, `not unit length at ${angle}deg`)
  }
  // 0deg lights from below, 90deg from the left, 180deg from above.
  assert.ok(lightVectorFromAngle(0).y > 0.999, '0deg lights from below')
  assert.ok(lightVectorFromAngle(90).x < -0.999, '90deg lights from the left')
  assert.ok(lightVectorFromAngle(180).y < -0.999, '180deg lights from above')
  assert.ok(lightVectorFromAngle(270).x > 0.999, '270deg lights from the right')
})

test('opposite angles produce opposite light directions', () => {
  const a = lightVectorFromAngle(135)
  const b = lightVectorFromAngle(315)
  assert.ok(Math.abs(a.x + b.x) < 1e-12, 'x inverts')
  assert.ok(Math.abs(a.y + b.y) < 1e-12, 'y inverts')
})

test('liquidRel runs from fully refracting at the boundary to clear at the rim', () => {
  assert.ok(liquidRel(0) < 1e-9, 'boundary refracts fully')
  assert.ok(liquidRel(1) > 1 - 1e-9, 'rim inner edge is clear')
  assert.ok(liquidRel(0.5) > 0 && liquidRel(0.5) < 1, 'mid-rim is in between')
})

test('liquidRel increases monotonically and stays bounded', () => {
  let previous = -Infinity
  for (let i = 0; i <= 50; i++) {
    const value = liquidRel(i / 50)
    assert.ok(value >= 0 && value <= 1, `out of range at ${i / 50}: ${value}`)
    assert.ok(value >= previous - 1e-12, `not monotonic at ${i / 50}`)
    previous = value
  }
})

test('liquidRel clamps outside its domain', () => {
  assert.equal(liquidRel(-2), liquidRel(0))
  assert.equal(liquidRel(3), liquidRel(1))
})

test('liquidRel concentrates the bend against the boundary', () => {
  // A smoothstep would sit at 0.5 mid-rim. The lens profile must be well past
  // that, or the refraction spreads into the middle of the surface as haze.
  assert.ok(liquidRel(0.5) > 0.6, `mid-rim was ${liquidRel(0.5)}`)
})

test('screenCombine is bounded, commutative, and saturating', () => {
  assert.equal(screenCombine(0, 0), 0)
  assert.equal(screenCombine(1, 0), 1)
  assert.equal(screenCombine(0, 1), 1)
  assert.equal(screenCombine(1, 1), 1)
  assert.equal(screenCombine(0.5, 0.5), 0.75)
  assert.equal(screenCombine(0.3, 0.7), screenCombine(0.7, 0.3))
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const value = screenCombine(i / 10, j / 10)
      assert.ok(value >= 0 && value <= 1, `out of range at ${i},${j}`)
    }
  }
})

test('the lit edge outshines the shadow edge', () => {
  // Light is up-left, so the left and top edges face it.
  const left = specularIntensity(-31.5, 0, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  const right = specularIntensity(31.5, 0, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  const top = specularIntensity(0, -31.5, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  const bottom = specularIntensity(0, 31.5, SQUARE_SHAPE, SQUARE_RIM, LIGHT)

  assert.ok(left > right, `left ${left} should beat right ${right}`)
  assert.ok(top > bottom, `top ${top} should beat bottom ${bottom}`)
})

test('the highlight bends around the corners instead of snapping to an axis', () => {
  // The whole point of baking this: at equal depth the lit corner is the
  // brightest place on the rim, because its normal points straight at the light.
  const litCorner = intensityAtAngle(225, 0.5)
  const litEdge = intensityAtAngle(180, 0.5)
  const shadowCorner = intensityAtAngle(45, 0.5)

  assert.ok(litCorner > 0, 'lit corner catches light')
  assert.ok(litCorner > shadowCorner, `lit corner ${litCorner} beats shadow ${shadowCorner}`)
  // A CSS gradient cannot do this: it varies along one axis, so it can never make
  // the corner outshine the edge midpoints flanking it.
  assert.ok(litCorner > litEdge, `corner ${litCorner} should beat edge ${litEdge}`)
})

test('incidence peaks exactly on the lit diagonal', () => {
  // Sweeping the rim at constant depth isolates incidence from falloff. The peak
  // must land on the light's own diagonal, 225deg for an up-left light.
  const depth = 4
  let brightestAngle = -1
  let brightest = -1
  for (let angle = 0; angle < 360; angle += 5) {
    const sheen = sheenAtAngle(angle, depth)
    if (sheen > brightest) {
      brightest = sheen
      brightestAngle = angle
    }
  }
  assert.equal(brightestAngle, 225, `peak sat at ${brightestAngle}deg`)
  assert.ok(brightest > 0, 'the peak actually carries a highlight')

  /* Falloff is only observable across the rounded corner's arc (215deg..235deg
     here): along a straight edge the normal is constant, so every sample there
     shares one incidence by construction. Walking outward from the diagonal to
     the arc's end and on to the flat edge is what shows the highlight bending
     around the corner. */
  assert.ok(sheenAtAngle(225, depth) > sheenAtAngle(220, depth), 'peak beats mid-arc')
  assert.ok(sheenAtAngle(220, depth) > sheenAtAngle(215, depth), 'mid-arc beats arc end')
  assert.ok(sheenAtAngle(215, depth) > sheenAtAngle(210, depth), 'arc end beats the flat edge')
  // The flat left edge holds one value (the normal is constant along it), then the
  // shadow side drops out entirely.
  assert.ok(
    Math.abs(sheenAtAngle(210, depth) - sheenAtAngle(180, depth)) < 1e-12,
    'straight edge is uniform'
  )
  assert.ok(sheenAtAngle(180, depth) > sheenAtAngle(135, depth), 'lit edge beats shadow edge')
})

test('the two corners across the lit diagonal mirror each other', () => {
  // Symmetric shape, symmetric light: the top-right and bottom-left corners sit
  // at the same incidence, so neither may be favoured.
  const topRight = specularIntensity(25, -25, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  const bottomLeft = specularIntensity(-25, 25, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  assert.ok(
    Math.abs(topRight - bottomLeft) < 1e-9,
    `cross-diagonal corners differ: ${topRight} vs ${bottomLeft}`
  )
})

test('the rim keeps an incidence floor so the boundary never breaks', () => {
  // Bottom-right edge faces away from an up-left light, yet the glass boundary
  // must still be traced all the way around.
  const shadowEdge = specularTerms(31.5, 0, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  assert.ok(shadowEdge.rim > 0, 'shadow-side rim still catches something')
  assert.ok(
    shadowEdge.rim >= SPECULAR_MIN_INCIDENCE * 0.99,
    `shadow rim ${shadowEdge.rim} should respect the floor`
  )
})

test('the rim catch is confined to a narrow band at the boundary', () => {
  const atEdge = specularTerms(-31.5, 0, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  const pastBand = specularTerms(
    -32 + SPECULAR_EDGE_BAND_PX + 1,
    0,
    SQUARE_SHAPE,
    SQUARE_RIM,
    LIGHT
  )
  assert.ok(atEdge.rim > 0, 'boundary has a rim catch')
  assert.equal(pastBand.rim, 0, 'rim catch does not reach past its band')
})

test('the sheen decays inward and dies at the rim inner edge', () => {
  // Straight down the lit diagonal, holding incidence fixed while depth grows.
  const probes = [0.5, 2, 5, 8].map((depth) => sheenAtAngle(225, depth))
  for (let i = 1; i < probes.length; i++) {
    assert.ok(
      probes[i] < probes[i - 1],
      `sheen must decay inward, failed at probe ${i}: ${probes[i]} >= ${probes[i - 1]}`
    )
  }
  // Past the rim's inner edge the highlight is gone entirely.
  assert.equal(sheenAtAngle(225, SQUARE_RIM), 0, 'sheen dies at the rim inner edge')

  const center = specularTerms(0, 0, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  assert.equal(center.sheen, 0, 'center has no sheen')
  assert.equal(center.rim, 0, 'center has no rim catch')
})

test('the center of a surface stays optically clear', () => {
  assert.equal(specularIntensity(0, 0, SQUARE_SHAPE, SQUARE_RIM, LIGHT), 0)
})

test('points outside the shape contribute nothing', () => {
  const outside = specularTerms(200, 200, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
  assert.equal(outside.rim, 0)
  assert.equal(outside.sheen, 0)
  assert.equal(specularIntensity(200, 200, SQUARE_SHAPE, SQUARE_RIM, LIGHT), 0)
})

test('intensity stays within [0, 1] across the whole surface', () => {
  for (let y = -32; y <= 32; y += 0.5) {
    for (let x = -32; x <= 32; x += 0.5) {
      const value = specularIntensity(x, y, SQUARE_SHAPE, SQUARE_RIM, LIGHT)
      assert.ok(value >= 0 && value <= 1, `out of range at ${x},${y}: ${value}`)
    }
  }
})

test('rotating the light rotates the highlight', () => {
  const fromLeft = lightVectorFromAngle(90)
  const fromRight = lightVectorFromAngle(270)

  const leftEdgeUnderLeftLight = specularIntensity(-31.5, 0, SQUARE_SHAPE, SQUARE_RIM, fromLeft)
  const leftEdgeUnderRightLight = specularIntensity(-31.5, 0, SQUARE_SHAPE, SQUARE_RIM, fromRight)
  assert.ok(
    leftEdgeUnderLeftLight > leftEdgeUnderRightLight,
    'the left edge is brighter when lit from the left'
  )

  const rightEdgeUnderRightLight = specularIntensity(31.5, 0, SQUARE_SHAPE, SQUARE_RIM, fromRight)
  assert.ok(
    Math.abs(rightEdgeUnderRightLight - leftEdgeUnderLeftLight) < 1e-9,
    'the effect is symmetric under a mirrored light'
  )
})

test('the Bayer tile is a zero-mean permutation of its 64 levels', () => {
  assert.equal(BAYER_8X8.length, 64)
  const sum = BAYER_8X8.reduce((total, value) => total + value, 0)
  assert.ok(Math.abs(sum) < 1e-12, `dither must not shift the mean, sum was ${sum}`)

  // Every one of the 64 ordered levels appears exactly once.
  const levels = new Set(BAYER_8X8.map((value) => Math.round(value * 64 + 31.5)))
  assert.equal(levels.size, 64, 'each ordered level appears exactly once')

  for (const value of BAYER_8X8) {
    assert.ok(value > -0.5 && value < 0.5, `offset out of range: ${value}`)
  }
})

test('the dither offset tiles every 8 px on both axes', () => {
  assert.equal(bayerOffset(0, 0), bayerOffset(8, 8))
  assert.equal(bayerOffset(3, 5), bayerOffset(11, 13))
  assert.equal(bayerOffset(7, 1), bayerOffset(63, 49))
})

test('pixel buffer has RGBA length and pure white RGB', () => {
  const w = 24
  const h = 16
  const pixels = buildSpecularPixels(w, h)

  assert.equal(pixels.length, w * h * 4)
  assert.ok(pixels instanceof Uint8ClampedArray)
  for (let p = 0; p < pixels.length; p += 4) {
    // Screen-blending relies on the highlight being colourless; any tint here
    // would push the glass toward that hue.
    assert.equal(pixels[p], 255, `R must be white at byte ${p}`)
    assert.equal(pixels[p + 1], 255, `G must be white at byte ${p}`)
    assert.equal(pixels[p + 2], 255, `B must be white at byte ${p}`)
  }
})

test('the baked map is bright at the lit rim and transparent inside', () => {
  const size = 64
  const pixels = buildSpecularPixels(size, size)

  const litEdge = alphaAt(pixels, size, 0, size / 2)
  const shadowEdge = alphaAt(pixels, size, size - 1, size / 2)
  const center = alphaAt(pixels, size, size / 2, size / 2)

  assert.ok(litEdge > 120, `lit edge should be strong, was ${litEdge}`)
  assert.ok(litEdge > shadowEdge, `lit ${litEdge} should beat shadow ${shadowEdge}`)
  assert.equal(center, 0, 'the middle of the surface is untouched')
})

test('the baked map lights the corners, which is what a gradient cannot do', () => {
  const size = 64
  const pixels = buildSpecularPixels(size, size)
  const inset = 6

  const litCorner = alphaAt(pixels, size, inset, inset)
  const shadowCorner = alphaAt(pixels, size, size - 1 - inset, size - 1 - inset)

  assert.ok(litCorner > 0, 'lit corner catches light')
  assert.ok(litCorner > shadowCorner, `lit corner ${litCorner} beats shadow ${shadowCorner}`)
})

test('the baked map is symmetric about the lit diagonal', () => {
  const size = 48
  const pixels = buildSpecularPixels(size, size)

  // Transposing mirrors across the up-left/down-right diagonal the light sits on,
  // so alpha must be preserved. One byte of slack absorbs the dither.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = alphaAt(pixels, size, x, y)
      const mirrored = alphaAt(pixels, size, y, x)
      assert.ok(
        Math.abs(value - mirrored) <= 1,
        `diagonal asymmetry at ${x},${y}: ${value} vs ${mirrored}`
      )
    }
  }
})

test('alpha decays from the lit border inward', () => {
  const size = 64
  const pixels = buildSpecularPixels(size, size)
  const border = alphaAt(pixels, size, 0, size / 2)
  const nearRim = alphaAt(pixels, size, 4, size / 2)

  assert.ok(border > nearRim, `border ${border} should beat near-rim ${nearRim}`)
  assert.ok(nearRim > alphaAt(pixels, size, size / 2, size / 2), 'near-rim beats the center')
})

test('the clear interior is exactly transparent, not merely dim', () => {
  const size = 64
  const pixels = buildSpecularPixels(size, size)
  // Dithering a dead region would sprinkle stray white pixels across the middle
  // of every glass surface.
  for (let y = size / 2 - 4; y <= size / 2 + 4; y++) {
    for (let x = size / 2 - 4; x <= size / 2 + 4; x++) {
      assert.equal(alphaAt(pixels, size, x, y), 0, `stray highlight at ${x},${y}`)
    }
  }
})

test('non-square buckets keep a highlight on the wide playbar strip', () => {
  const width = 128
  const height = 16
  const pixels = buildSpecularPixels(width, height)
  assert.equal(pixels.length, width * height * 4)

  const topEdge = alphaAt(pixels, width, width / 2, 0)
  const bottomEdge = alphaAt(pixels, width, width / 2, height - 1)
  assert.ok(topEdge > 0, 'the top edge of the strip catches light')
  assert.ok(topEdge > bottomEdge, `top ${topEdge} should beat bottom ${bottomEdge}`)

  const leftEdge = alphaAt(pixels, width, 0, height / 2)
  const rightEdge = alphaAt(pixels, width, width - 1, height / 2)
  assert.ok(leftEdge > rightEdge, `left ${leftEdge} should beat right ${rightEdge}`)
})

test('rotating the light rotates the baked map', () => {
  const size = 48
  const litFromLeft = buildSpecularPixels(size, size, RIM_FRACTION, CORNER_FRACTION, 90)
  const litFromRight = buildSpecularPixels(size, size, RIM_FRACTION, CORNER_FRACTION, 270)

  const leftUnderLeft = alphaAt(litFromLeft, size, 0, size / 2)
  const leftUnderRight = alphaAt(litFromRight, size, 0, size / 2)
  assert.ok(leftUnderLeft > leftUnderRight, 'the lit side follows the angle')
})

test('a wider rim fraction spreads the sheen further inward', () => {
  const size = 64
  const narrow = buildSpecularPixels(size, size, 0.1)
  const wide = buildSpecularPixels(size, size, 0.4)
  // Probe on the lit diagonal, past the narrow rim but inside the wide one.
  const probe = 12
  assert.ok(
    alphaAt(wide, size, probe, probe) > alphaAt(narrow, size, probe, probe),
    'a wider rim reaches deeper'
  )
})

test('invalid sizes are rejected rather than producing a broken map', () => {
  assert.throws(() => buildSpecularPixels(0, 10), /invalid specular map size/)
  assert.throws(() => buildSpecularPixels(10, 0), /invalid specular map size/)
  assert.throws(() => buildSpecularPixels(-4, 4), /invalid specular map size/)
})

test('fractional layout sizes are rounded rather than rejected', () => {
  // Measured geometry comes from getBoundingClientRect, which is fractional at
  // most zoom levels. Rejecting it would leave the surface unfiltered.
  const raster = buildSpecularRaster({ width: 24.6, height: 16.2, radius: 4 })
  assert.equal(raster.width, 25)
  assert.equal(raster.height, 16)
  assert.equal(raster.pixels.length, 25 * 16 * 4)
})

test('the specular map reuses the displacement geometry so the two stay registered', () => {
  // Same resolver, same rounded-rect shape, same refraction depth: the highlight
  // has to land on the rim the refraction bends, not near it.
  for (const geometry of [NOMINAL_CARD_GEOMETRY, NOMINAL_PLAYBAR_GEOMETRY]) {
    const specular = buildSpecularRaster(geometry)
    const displacement = buildDisplacementPixels(geometry)
    assert.equal(specular.width, displacement.width)
    assert.equal(specular.height, displacement.height)
    assert.equal(specular.pixels.length, displacement.pixels.length)
  }
})

test('map url generation degrades to empty string without a DOM', () => {
  clearSpecularMapCache()
  // node test env has no document; callers are expected to skip the highlight
  assert.equal(typeof globalThis.document, 'undefined')
  assert.equal(getSpecularMapUrl(NOMINAL_CARD_GEOMETRY), '')
})
