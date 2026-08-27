/**
 * Liquid glass specular highlight map generation.
 *
 * A CSS gradient can place a highlight at an angle, but it cannot make that
 * highlight follow the surface: on a rounded rect the bright band has to bend
 * around each corner, brightest where the surface normal points at the light and
 * dimmest where it points across it. That relationship is per-pixel trigonometry
 * between the SDF normal and the light direction, which no gradient can express.
 *
 * So the highlight is baked the same way the displacement map is — once per
 * aspect bucket, at runtime, into a data URL — and fed to the filter chain as a
 * second `feImage`. RGB is pure white and the intensity rides in alpha, because
 * `feBlend mode="screen"` over a premultiplied white pixel of alpha `a` resolves
 * to `c + (1 - c) * a`: a straight lerp toward white by the highlight amount.
 * That is exactly the accumulation a shader would write by hand.
 *
 * The light is *directional*, not a point. A point light placed inside the
 * surface is degenerate on a symmetric shape: the outward normal is exactly
 * anti-aligned with the direction to the light at every diagonal corner, so all
 * four corners resolve to the same incidence and the highlight goes flat where it
 * matters most. A constant light vector keeps incidence swinging across the whole
 * rim and is scale-invariant, so one baked map is valid at any element size.
 *
 * Two terms make up the highlight, mirroring how a real lens edge catches light:
 * a tight band right at the boundary (the rim catch) and a wider, softer bloom
 * falling off inward (the body sheen). The rim term keeps a floor on incidence so
 * the boundary stays visible all the way around instead of dropping out on the
 * shadow side. The sheen reads incidence as two lobes — a strong one facing the
 * light and a weaker one directly opposite — because a glass body also picks up
 * light transmitted through it, which is what puts a faint counter-highlight on
 * the far corner.
 *
 * Intensity is baked at full scale; `--te-lg-specular` is applied by the filter
 * chain instead, so user tuning never invalidates the raster.
 *
 * Geometry deliberately reuses `liquidGlassDisplacement`'s rounded-rect shape and
 * bucket sizes, and the filter binds this image with the same subregion
 * attributes as the displacement map. The two rasters are therefore co-registered
 * by construction: the highlight lands on the same rim the refraction bends,
 * whatever mapping the UA applies to the shared primitive subregion.
 *
 * The math is DOM-free so it can be unit tested; only `getSpecularMapUrl` touches
 * canvas.
 */

import {
  geometryKey,
  liquidRel,
  resolveRasterGeometry,
  roundedRectSDF,
  sdfNormal,
  type DisplacementGeometry,
  type DisplacementRaster,
  type DisplacementVector,
  type RoundedRectShape
} from './liquidGlassDisplacement.ts'

/**
 * Re-exported so callers that only reason about the highlight do not need to know
 * the curve is shared with the refraction field. One definition, two consumers.
 */
export { liquidRel }

/** Same raster shape as the displacement map: bytes plus the size they were baked at. */
export type SpecularRaster = DisplacementRaster

/**
 * Light direction in CSS `linear-gradient` degrees, so the baked highlight and
 * the CSS sheen layers share one convention. 135deg is the app's `--te-lg-angle`
 * default: the gradient runs toward the bottom-right, meaning the light is up and
 * to the left.
 */
export const DEFAULT_SPECULAR_ANGLE_DEG = 135

/**
 * Width in px of the tight catch right at the boundary. Kept near a hairline: the
 * band is clamped to 1, so any width much above this leaves a saturated plateau
 * along the lit edge instead of a line with a falling edge.
 */
export const SPECULAR_EDGE_BAND_PX = 1.5

/**
 * Falloff/incidence exponent. Governs how far the body sheen carries inward, and
 * it is the difference between a lit edge and a milky surface — at 2.2 the sheen
 * still put ~28% of the surface above the visible threshold, which reads as haze
 * rather than glass.
 */
export const SPECULAR_EXPONENT = 3.4

/**
 * Incidence floor for the rim catch. Without it the boundary vanishes on the
 * side facing away from the light, which reads as a broken outline rather than a
 * lit edge. Set only as high as that job needs: the floor is a `max`, so a
 * generous value flattens every shadow-side normal onto one constant and the
 * outline stops looking lit at all.
 */
export const SPECULAR_MIN_INCIDENCE = 0.1

/** Weight of the lobe facing the light, and of the transmitted counter-lobe. */
export const SPECULAR_PRIMARY_LOBE = 0.72
export const SPECULAR_COUNTER_LOBE = 0.3

/**
 * Unit vector pointing *toward* the light for a CSS gradient angle.
 *
 * A CSS gradient at angle `a` runs toward `(sin a, -cos a)` in screen space (y
 * down), placing its first colour stop at the opposite end. The light therefore
 * sits along the negation of the gradient direction.
 */
export function lightVectorFromAngle(angleDegrees: number): DisplacementVector {
  const radians = (angleDegrees * Math.PI) / 180
  return { x: -Math.sin(radians), y: Math.cos(radians) }
}

/** Screen-combines two bounded intensities so stacked highlights stay in [0, 1]. */
export function screenCombine(a: number, b: number): number {
  return a + b - a * b
}

export interface SpecularTerms {
  /** Tight catch along the boundary itself. */
  rim: number
  /** Wider bloom falling off inward from the boundary. */
  sheen: number
}

/**
 * Both highlight terms at a pixel-space point, before they are combined.
 *
 * `facing` is the cosine between the outward surface normal and the direction to
 * the light: 1 where the surface squarely faces the light, 0 where it faces
 * across it, -1 where it faces away.
 */
export function specularTerms(
  x: number,
  y: number,
  shape: RoundedRectShape,
  rimWidth: number,
  lightVector: DisplacementVector
): SpecularTerms {
  const signedDistance = roundedRectSDF(x, y, shape.halfWidth, shape.halfHeight, shape.radius)
  // Outside the shape entirely; the filter clips this away regardless.
  if (signedDistance > 0) return { rim: 0, sheen: 0 }

  const depth = -signedDistance
  const t = Math.min(1, depth / Math.max(1e-6, rimWidth))

  const normal = sdfNormal(x, y, shape)
  const facing = normal.x * lightVector.x + normal.y * lightVector.y

  const rimBand = Math.min(1, Math.max(0, SPECULAR_EDGE_BAND_PX - depth))
  const rim = rimBand * Math.max(SPECULAR_MIN_INCIDENCE, facing)

  const rel = liquidRel(t)
  // Dips slightly mid-rim and recovers at both ends, so the sheen does not read
  // as a single flat ramp across the band.
  const bodyWeight = 1 - rel * Math.pow(1 - rel, 2)
  const falloff = Math.pow(1 - t, SPECULAR_EXPONENT)
  const lobe = Math.max(0, facing * SPECULAR_PRIMARY_LOBE, -facing * SPECULAR_COUNTER_LOBE)
  const sheen = bodyWeight * falloff * Math.pow(lobe, SPECULAR_EXPONENT)

  return { rim, sheen }
}

/** Combined highlight intensity in [0, 1] at a pixel-space point. */
export function specularIntensity(
  x: number,
  y: number,
  shape: RoundedRectShape,
  rimWidth: number,
  lightVector: DisplacementVector
): number {
  const terms = specularTerms(x, y, shape, rimWidth, lightVector)
  return Math.min(1, Math.max(0, screenCombine(terms.rim, terms.sheen)))
}

/**
 * Ordered 8x8 Bayer matrix, offset to be zero-mean over the tile.
 *
 * The highlight is a wide, very gradual ramp toward white, which is precisely the
 * case where quantizing to 256 alpha steps shows as visible contour rings. A
 * zero-mean ordered offset applied before rounding trades those rings for
 * sub-pixel noise, at no runtime cost since it is baked into the raster.
 */
export const BAYER_8X8: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21
].map((value) => (value - 31.5) / 64)

/** Zero-mean ordered dither offset in (-0.5, 0.5) for a pixel. */
export function bayerOffset(x: number, y: number): number {
  return BAYER_8X8[(y & 7) * 8 + (x & 7)]
}

/**
 * Builds RGBA bytes for the specular map: RGB is pure white throughout and A
 * carries the highlight intensity. Screen-blending that over the refracted
 * surface lerps it toward white by exactly the intensity, so no channel needs to
 * encode colour.
 */
export function buildSpecularPixels(
  geometry: DisplacementGeometry,
  angleDegrees: number = DEFAULT_SPECULAR_ANGLE_DEG
): SpecularRaster {
  if (
    !Number.isFinite(geometry.width) ||
    !Number.isFinite(geometry.height) ||
    geometry.width < 1 ||
    geometry.height < 1
  ) {
    throw new Error(`invalid specular map size: ${geometry.width}x${geometry.height}`)
  }

  // Same resolver as the displacement map, so the highlight lands on exactly the
  // rim the refraction bends.
  const { width, height, shape, blurRadius } = resolveRasterGeometry(geometry)
  const rimWidth = blurRadius
  const lightVector = lightVectorFromAngle(angleDegrees)

  const pixels = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    // Sample at pixel centers so the field stays symmetric for any size.
    const py = y + 0.5 - height / 2
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - width / 2
      const intensity = specularIntensity(px, py, shape, rimWidth, lightVector)

      const p = (y * width + x) * 4
      pixels[p] = 255
      pixels[p + 1] = 255
      pixels[p + 2] = 255
      // Dither only where there is a gradient to band; leave the dead interior
      // exactly transparent so the middle of a surface stays untouched.
      pixels[p + 3] = intensity <= 0 ? 0 : intensity * 255 + bayerOffset(x, y)
    }
  }

  return { pixels, width, height }
}

const cache = new Map<string, string>()

/**
 * Renders the map to a data URL, memoized per geometry. Returns an empty string
 * when canvas is unavailable (non-DOM context), letting callers skip the highlight
 * rather than throw.
 */
export function getSpecularMapUrl(
  geometry: DisplacementGeometry,
  angleDegrees: number = DEFAULT_SPECULAR_ANGLE_DEG
): string {
  const key = `${geometryKey(geometry)}@${angleDegrees}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  if (typeof document === 'undefined') return ''

  const raster = buildSpecularPixels(geometry, angleDegrees)
  const canvas = document.createElement('canvas')
  canvas.width = raster.width
  canvas.height = raster.height
  const context = canvas.getContext('2d')
  if (!context) return ''

  const imageData = context.createImageData(raster.width, raster.height)
  imageData.data.set(raster.pixels)
  context.putImageData(imageData, 0, 0)

  const url = canvas.toDataURL()
  cache.set(key, url)
  return url
}

/** Test hook — the cache is process-lifetime otherwise. */
export function clearSpecularMapCache(): void {
  cache.clear()
}
