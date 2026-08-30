/**
 * Liquid glass displacement map generation.
 *
 * The SVG filter chain needs a displacement map whose R channel encodes X offset
 * and B channel encodes Y offset (0x80 = no displacement). Rather than shipping
 * prebaked base64 JPEGs — the reference implementation carries ~41KB of them and
 * the renderer CSS chunk budget is 400KB — the map is generated once at runtime
 * and cached per geometry.
 *
 * The field is the reference material's lens profile, and the important property
 * is that **displacement magnitude is bounded by the corner radius**, not chosen
 * freely. At the boundary a pixel samples exactly `radius` px inward along the
 * surface normal, and the offset decays to zero by the inner edge of the
 * refracting band. Since the offset is always inward and never longer than the
 * radius, every sample lands inside the surface — which is the whole point: a
 * boundary pixel shows content from just inside the edge, not from beyond it.
 *
 * That bound is what an unconstrained `feDisplacementMap scale` broke: displacing
 * 46px inside a ~10px rim pushed samples clear across the surface onto unrelated
 * content, which is what doubled text and cover art at the playbar's edge.
 * Amplitude is therefore derived from geometry (`displacementScaleForRadius`) and
 * the user setting is a multiplier on top of it.
 *
 * Direction lives in RGB. Alpha is opaque throughout: a transparent region loses
 * its RGB to premultiplied decoding, and a neutral 128 that decodes to 0 reads as a
 * full-amplitude displacement rather than none — see `buildDisplacementPixels`.
 *
 * The math is DOM-free so it can be unit tested; only `getDisplacementMapUrl`
 * touches canvas.
 */

/**
 * Geometry of one glass surface, in CSS pixels, with its real corner radius.
 *
 * Maps used to be baked per aspect-ratio bucket and stretched with
 * `preserveAspectRatio="xMidYMid slice"`. A wide strip baked at 512x64 put its
 * corner arc at ~14px in map space and then scaled it horizontally, so the rim
 * field never lined up with the radius actually painted on screen. Baking at the
 * measured size keeps the field registered with the visible corner.
 */
export interface DisplacementGeometry {
  width: number
  height: number
  /** Corner radius in px — also the ceiling on displacement magnitude. */
  radius: number
  /**
   * Depth in px over which refraction fades to nothing. Defaults to the radius,
   * which makes the refracting band exactly as deep as the corner arc.
   */
  blurRadius?: number
}

/** Byte value meaning "no displacement" for a signed channel. */
export const NEUTRAL_BYTE = 128

/** Shaping constants of the refraction curve, from the reference material. */
const REL_INPUT_EXPONENT = 1.75
const REL_INNER_EXPONENT = 1.25
const REL_OUTER_EXPONENT = 2

/**
 * Largest map baked in either axis. A surface wider than this is baked at the cap
 * and sampled with `preserveAspectRatio="none"`; the field is a function of depth
 * from the boundary, so stretching the flat middle of a long edge costs nothing
 * visible while the corners stay proportionate.
 */
export const MAX_DISPLACEMENT_MAP_AXIS = 1024

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

/**
 * How far a pixel may be displaced, in px: `radius` at the boundary falling to 0
 * at depth `radius`. This is the geometric ceiling that keeps every sample inside
 * the surface — the reference shader's
 * `clamp(glassRadius + signedDistance, 0, ...)`.
 */
export function refractionDistance(signedDistance: number, radius: number): number {
  return Math.min(radius, Math.max(0, radius + signedDistance))
}

/**
 * Fraction of the surface that is *not* refracted at a given normalized depth:
 * 0 at the boundary (fully refracting) easing to 1 at the inner edge of the band
 * (perfectly clear), where `t` is depth divided by the band width.
 *
 * A sharper, non-linear lens profile than a smoothstep — it concentrates the bend
 * hard against the boundary, which is what keeps the middle of a surface
 * optically open instead of hazing over.
 */
export function liquidRel(t: number): number {
  const normalized = Math.pow(Math.min(1, Math.max(0, 1 - t)), REL_INPUT_EXPONENT)
  return 1 - Math.pow(1 - Math.pow(1 - normalized, REL_INNER_EXPONENT), REL_OUTER_EXPONENT)
}

export interface RefractionSample extends DisplacementVector {
  /** Offset magnitude as a fraction of `radius`; 1 at the boundary, 0 when clear. */
  magnitude: number
}

/**
 * Inward refraction offset at a pixel-space point, normalized to [-1, 1] against
 * the radius. The direction is the SDF normal negated (pointing toward the
 * centre) and the magnitude is `refractionDistance * (1 - liquidRel)`, so it is
 * strongest at the boundary and exactly zero once the surface reads clear.
 */
export function refractionOffset(
  x: number,
  y: number,
  shape: RoundedRectShape,
  blurRadius: number
): RefractionSample {
  const signedDistance = roundedRectSDF(x, y, shape.halfWidth, shape.halfHeight, shape.radius)
  // Outside the shape entirely; the filter clips this away regardless.
  if (signedDistance > 0 || shape.radius <= 0) return { x: 0, y: 0, magnitude: 0 }

  const distance = refractionDistance(signedDistance, shape.radius)
  const depth = -signedDistance
  const rel = liquidRel(Math.min(1, depth / Math.max(1e-6, blurRadius)))
  const magnitude = (distance / shape.radius) * (1 - rel)

  const normal = sdfNormal(x, y, shape)
  // Zero the clear interior instead of returning -0, which strict equality
  // distinguishes.
  const inward = (component: number): number => {
    const value = -component * magnitude
    return value === 0 ? 0 : value
  }
  return { x: inward(normal.x), y: inward(normal.y), magnitude }
}

/**
 * `feDisplacementMap scale` that reproduces the geometric offset exactly.
 *
 * The primitive shifts by `scale * (channel - 0.5)`, and the channel encodes the
 * normalized offset as `offset * 0.5 + 0.5`. A unit-magnitude offset therefore
 * shifts by `scale * 0.5`, so a physically correct amplitude of `radius` px needs
 * `scale = 2 * radius`. `strength` scales that: 1 is the true lens, lower is a
 * shallower one.
 */
export function displacementScaleForRadius(radius: number, strength: number): number {
  if (!Number.isFinite(radius) || !Number.isFinite(strength)) return 0
  return Math.max(0, radius) * 2 * Math.max(0, strength)
}

export interface DisplacementRaster {
  pixels: Uint8ClampedArray
  width: number
  height: number
}

/**
 * Resolves the geometry a map is actually baked at. Long surfaces are capped so a
 * full-width playbar does not rasterize a 1180-px-wide canvas on every resize;
 * the shape is scaled to match so corners keep their proportion.
 */
export function resolveRasterGeometry(geometry: DisplacementGeometry): {
  width: number
  height: number
  shape: RoundedRectShape
  blurRadius: number
} {
  const width = Math.max(1, Math.round(geometry.width))
  const height = Math.max(1, Math.round(geometry.height))
  const scale = Math.min(1, MAX_DISPLACEMENT_MAP_AXIS / Math.max(width, height))
  const rasterWidth = Math.max(1, Math.round(width * scale))
  const rasterHeight = Math.max(1, Math.round(height * scale))
  // The radius is clamped to the short half-axis: a pill's radius is reported as
  // 999px by `border-radius: 999px`, which would otherwise blow past the shape.
  const radius = Math.max(0, Math.min(geometry.radius * scale, rasterWidth / 2, rasterHeight / 2))
  const blurRadius = Math.max(1e-6, (geometry.blurRadius ?? geometry.radius) * scale)

  return {
    width: rasterWidth,
    height: rasterHeight,
    shape: { halfWidth: rasterWidth / 2, halfHeight: rasterHeight / 2, radius },
    blurRadius
  }
}

/**
 * Builds RGBA bytes for the displacement map. R holds X offset, G and B both hold
 * Y offset — the filter selects R and B, and G is kept in sync so the map is also
 * readable as a conventional offset map.
 *
 * Alpha is fully opaque everywhere, and must stay that way. The profile used to
 * ride in alpha as an edge mask, which left the whole clear interior at alpha 0;
 * Chromium decodes an image into premultiplied storage, so every transparent pixel
 * lost its RGB and the neutral 128 became 0. `feDisplacementMap` reads that as
 * `scale * (0 - 0.5)` — a full-amplitude shift of the *entire* backdrop, per
 * channel and at slightly different amounts, which is why the surface showed the
 * content behind it offset and colour-fringed across the middle instead of bending
 * only at the rim. The mask itself is long gone (masking refraction against an
 * feImage-derived alpha makes Chromium drop the whole backdrop-filter — see
 * `scripts/backdrop-filter-url-probe.test.cjs`), so nothing reads alpha now.
 */
export function buildDisplacementPixels(geometry: DisplacementGeometry): DisplacementRaster {
  if (
    !Number.isFinite(geometry.width) ||
    !Number.isFinite(geometry.height) ||
    geometry.width < 1 ||
    geometry.height < 1
  ) {
    throw new Error(`invalid displacement map size: ${geometry.width}x${geometry.height}`)
  }

  const { width, height, shape, blurRadius } = resolveRasterGeometry(geometry)
  const pixels = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    // Sample at pixel centers so the field stays symmetric for any size.
    const py = y + 0.5 - height / 2
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - width / 2
      const sample = refractionOffset(px, py, shape, blurRadius)

      // Map [-1, 1] onto the byte range around neutral.
      const r = sample.x * 0.5 + 0.5
      const g = sample.y * 0.5 + 0.5

      const p = (y * width + x) * 4
      pixels[p] = r * 255
      pixels[p + 1] = g * 255
      pixels[p + 2] = g * 255
      pixels[p + 3] = 255
    }
  }

  return { pixels, width, height }
}

const cache = new Map<string, string>()

export function geometryKey(geometry: DisplacementGeometry): string {
  const { width, height, shape, blurRadius } = resolveRasterGeometry(geometry)
  return `${width}x${height}@${shape.radius.toFixed(2)}@${blurRadius.toFixed(2)}`
}

/**
 * Renders the map to a data URL, memoized per geometry. Returns an empty string
 * when canvas is unavailable (non-DOM context), letting callers skip the filter
 * rather than throw.
 */
export function getDisplacementMapUrl(geometry: DisplacementGeometry): string {
  const key = geometryKey(geometry)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  if (typeof document === 'undefined') return ''

  const raster = buildDisplacementPixels(geometry)
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
export function clearDisplacementMapCache(): void {
  cache.clear()
}

/**
 * Geometry used before a surface has been measured, and whenever one is absent
 * from the DOM. These match the shipped CSS — the playbar is `1180x72` at radius
 * 22 (`PlayerBar.css`), a dashboard feature card is near-square at radius 18 —
 * so the very first paint is already close and measurement only refines it.
 */
export const NOMINAL_PLAYBAR_GEOMETRY: DisplacementGeometry = {
  width: 1180,
  height: 72,
  radius: 22
}

export const NOMINAL_CARD_GEOMETRY: DisplacementGeometry = {
  width: 320,
  height: 320,
  radius: 18
}

/**
 * Reads a surface's real size and corner radius out of layout.
 *
 * The radius has to come from computed style rather than being assumed: the
 * playbar is 22px, cards are 18px, and pill controls declare `border-radius:
 * 999px`. `resolveRasterGeometry` clamps the last case down to the short
 * half-axis, so a pill resolves to a true capsule instead of overflowing.
 *
 * Returns null when the element has no layout box yet (display:none, or measured
 * before first paint), letting callers keep the nominal geometry rather than
 * baking a degenerate 0x0 map.
 */
export function measureSurfaceGeometry(element: Element): DisplacementGeometry | null {
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius)
  return {
    width: rect.width,
    height: rect.height,
    radius: Number.isFinite(radius) ? radius : Math.min(rect.width, rect.height) * 0.2
  }
}

/** Whether two geometries differ enough to be worth re-rasterizing. */
export function geometryChanged(
  a: DisplacementGeometry | null,
  b: DisplacementGeometry | null
): boolean {
  if (!a || !b) return a !== b
  return geometryKey(a) !== geometryKey(b)
}
