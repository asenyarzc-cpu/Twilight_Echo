/**
 * Liquid glass displacement map generation.
 *
 * The SVG filter chain needs a displacement map whose R channel encodes X offset
 * and B channel encodes Y offset (0x80 = no displacement). Rather than shipping
 * prebaked base64 JPEGs — the reference implementation carries ~41KB of them and
 * the renderer CSS chunk budget is 400KB — the map is generated once at runtime
 * and cached per aspect bucket.
 *
 * The map encodes an SDF-normal rim field: displacement follows the gradient of a
 * rounded-rect signed distance function (the inward surface normal) multiplied by
 * a rim magnitude profile, so corners bend diagonally the way a real lens edge
 * does. Feeding the raw SDF *distance* into the map instead — the reference
 * implementation's `shader` mode — comes out nearly flat across the interior,
 * which reads as a translate, not a lens. Direction lives in RGB; the rim
 * magnitude rides along in the alpha channel as a continuous edge mask for the
 * filter chain.
 *
 * The math is DOM-free so it can be unit tested; only `getDisplacementMapUrl`
 * touches canvas.
 */

export interface DisplacementBucket {
  width: number
  height: number
}

/**
 * Maps are generated per aspect-ratio bucket, not per element. `feImage` uses
 * `preserveAspectRatio="xMidYMid slice"`, so one map serves every element sharing
 * a rough aspect. Cards are near-square; the playbar is a wide strip.
 */
export const CARD_DISPLACEMENT_BUCKET: DisplacementBucket = { width: 256, height: 256 }
export const PLAYBAR_DISPLACEMENT_BUCKET: DisplacementBucket = { width: 512, height: 64 }

/**
 * Width of the refracting rim as a fraction of the map's short axis. The rim is a
 * fixed physical thickness of the glass edge, so one fraction serves both axes.
 * Small values keep the center clear and the edge tight, like Apple's material.
 */
export const DEFAULT_RIM_FRACTION = 0.16

/** Corner radius of the map's rounded rect as a fraction of the short axis. */
export const DEFAULT_CORNER_FRACTION = 0.22

/** Byte value meaning "no displacement" for a signed channel. */
export const NEUTRAL_BYTE = 128

export function smoothStep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Signed distance to a rounded rectangle centered on the origin. */
export function roundedRectSDF(
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  radius: number
): number {
  const qx = Math.abs(x) - halfWidth + radius
  const qy = Math.abs(y) - halfHeight + radius
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

/**
 * Relative refraction magnitude for one axis, given a normalized coordinate in
 * [0, 1]. Returns 1 at the border and eases to 0 at the inner edge of the rim.
 */
export function rimMagnitude(coordinate: number, rimFraction: number): number {
  const distanceToBorder = Math.min(coordinate, 1 - coordinate)
  const rim = Math.max(1e-6, rimFraction * 0.5)
  const normalized = Math.min(1, Math.max(0, distanceToBorder / rim))
  return 1 - smoothStep(0, 1, normalized)
}

export interface DisplacementVector {
  x: number
  y: number
}

export interface RoundedRectShape {
  halfWidth: number
  halfHeight: number
  radius: number
}

/**
 * Outward unit normal of the rounded rect at a pixel-space point — the analytic
 * gradient of `roundedRectSDF`. Straight edges are axis-aligned; corner regions
 * are diagonal, which is what makes a rounded corner refract along its own
 * normal instead of snapping to the nearest axis.
 */
export function sdfNormal(x: number, y: number, shape: RoundedRectShape): DisplacementVector {
  const qx = Math.abs(x) - shape.halfWidth + shape.radius
  const qy = Math.abs(y) - shape.halfHeight + shape.radius
  const sx = x < 0 ? -1 : 1
  const sy = y < 0 ? -1 : 1
  if (qx > 0 && qy > 0) {
    const length = Math.hypot(qx, qy)
    return { x: (sx * qx) / length, y: (sy * qy) / length }
  }
  if (qx > qy) return { x: sx, y: 0 }
  return { x: 0, y: sy }
}

export interface RimDisplacementSample extends DisplacementVector {
  /** Rim magnitude in [0, 1]; 1 at/outside the border, eased to 0 at the rim's inner edge. */
  magnitude: number
}

/**
 * Inward rim displacement at a pixel-space point: the SDF normal negated (so it
 * points toward the center) scaled by the rim magnitude profile. Beyond the rim
 * the sample is exactly zero, keeping the middle of a surface unrefracted.
 * Values are relative; `feDisplacementMap scale` sets the real amplitude.
 */
export function sdfRimDisplacement(
  x: number,
  y: number,
  shape: RoundedRectShape,
  rimWidth: number
): RimDisplacementSample {
  const distanceInside = Math.max(
    0,
    -roundedRectSDF(x, y, shape.halfWidth, shape.halfHeight, shape.radius)
  )
  const magnitude = 1 - smoothStep(0, Math.max(1e-6, rimWidth), distanceInside)
  const normal = sdfNormal(x, y, shape)
  // Zero the dead rim instead of returning -0, which strict equality distinguishes.
  const inward = (component: number): number => {
    const value = -component * magnitude
    return value === 0 ? 0 : value
  }
  return { x: inward(normal.x), y: inward(normal.y), magnitude }
}

/**
 * Builds RGBA bytes for the displacement map. R holds X offset, G and B both hold
 * Y offset — the filter selects R and B, and G is kept in sync so the map is also
 * readable as a conventional offset map. A holds the rim magnitude as a
 * continuous edge mask; `feDisplacementMap` ignores it and the filter chain reads
 * it through `feComponentTransfer`.
 */
export function buildDisplacementPixels(
  width: number,
  height: number,
  rimFraction: number = DEFAULT_RIM_FRACTION,
  cornerFraction: number = DEFAULT_CORNER_FRACTION
): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`invalid displacement map size: ${width}x${height}`)
  }

  const shape: RoundedRectShape = {
    halfWidth: width / 2,
    halfHeight: height / 2,
    radius: Math.min(1, Math.max(0, cornerFraction)) * Math.min(width, height)
  }
  const rimWidth = rimFraction * Math.min(width, height)

  const pixels = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    // Sample at pixel centers so the field stays symmetric for any size.
    const py = y + 0.5 - height / 2
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - width / 2
      const sample = sdfRimDisplacement(px, py, shape, rimWidth)

      // Map [-1, 1] onto the byte range around neutral.
      const r = sample.x * 0.5 + 0.5
      const g = sample.y * 0.5 + 0.5

      const p = (y * width + x) * 4
      pixels[p] = r * 255
      pixels[p + 1] = g * 255
      pixels[p + 2] = g * 255
      pixels[p + 3] = sample.magnitude * 255
    }
  }

  return pixels
}

const cache = new Map<string, string>()

function bucketKey(
  bucket: DisplacementBucket,
  rimFraction: number,
  cornerFraction: number
): string {
  return `${bucket.width}x${bucket.height}@${rimFraction}@${cornerFraction}`
}

/**
 * Renders the map to a data URL, memoized per bucket. Returns an empty string when
 * canvas is unavailable (non-DOM context), letting callers skip the filter rather
 * than throw.
 */
export function getDisplacementMapUrl(
  bucket: DisplacementBucket,
  rimFraction: number = DEFAULT_RIM_FRACTION,
  cornerFraction: number = DEFAULT_CORNER_FRACTION
): string {
  const key = bucketKey(bucket, rimFraction, cornerFraction)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  if (typeof document === 'undefined') return ''

  const canvas = document.createElement('canvas')
  canvas.width = bucket.width
  canvas.height = bucket.height
  const context = canvas.getContext('2d')
  if (!context) return ''

  const imageData = context.createImageData(bucket.width, bucket.height)
  imageData.data.set(
    buildDisplacementPixels(bucket.width, bucket.height, rimFraction, cornerFraction)
  )
  context.putImageData(imageData, 0, 0)

  const url = canvas.toDataURL()
  cache.set(key, url)
  return url
}

/** Test hook — the cache is process-lifetime otherwise. */
export function clearDisplacementMapCache(): void {
  cache.clear()
}
