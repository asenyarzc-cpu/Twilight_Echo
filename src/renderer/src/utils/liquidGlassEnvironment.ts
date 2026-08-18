export type LiquidGlassContext = 'bright' | 'dark' | 'balanced' | 'busy'
export type LiquidGlassTone = 'light' | 'dark'

export interface LiquidGlassEnvironment {
  context: LiquidGlassContext
  /** Mean relative luminance of the sampled backdrop, in [0, 1]. */
  luminance: number
  variables: Record<string, string>
}

/**
 * A light-tone glass flips to its dark profile once the backdrop is bright
 * enough that the light material would lose its edge. Sits just under the
 * `bright` context boundary so adaptive tone trails the context classification
 * instead of oscillating against it.
 */
export const ADAPTIVE_TONE_LUMINANCE_THRESHOLD = 0.62

export function resolveAdaptiveGlassTone(
  meanLuminance: number,
  currentTone: LiquidGlassTone
): LiquidGlassTone {
  if (
    currentTone === 'light' &&
    Number.isFinite(meanLuminance) &&
    meanLuminance >= ADAPTIVE_TONE_LUMINANCE_THRESHOLD
  ) {
    return 'dark'
  }
  return currentTone
}

const MIN_ALPHA = 128
const MAX_CONTEXT_ALPHA = 0.68
const MIN_CONTEXT_ALPHA = 0.24

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function relativeLuminance(red: number, green: number, blue: number): number {
  const channel = (value: number): number => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return channel(red) * 0.2126 + channel(green) * 0.7152 + channel(blue) * 0.0722
}

function variablesFor(
  red: number,
  green: number,
  blue: number,
  luminance: number,
  variance: number,
  fallback: boolean
): LiquidGlassEnvironment {
  const busy = variance >= 0.034
  const context: LiquidGlassContext = busy
    ? 'busy'
    : luminance >= 0.68
      ? 'bright'
      : luminance <= 0.32
        ? 'dark'
        : 'balanced'
  const darkLabels = luminance <= 0.52
  const density = clamp(
    0.3 + Math.abs(luminance - 0.5) * 0.28 + (busy ? 0.12 : 0) + (fallback ? 0.05 : 0),
    MIN_CONTEXT_ALPHA,
    MAX_CONTEXT_ALPHA
  )
  const shadow = clamp(0.1 + (darkLabels ? 0.15 : 0.05) + (busy ? 0.11 : 0), 0.1, 0.36)
  const label = darkLabels ? '248 250 252' : '15 23 42'
  const labelChannels = label.split(' ').map((value) => Number(value))
  const materialWeight = darkLabels ? 0.2 : 0.22
  const materialRed = Math.round(red * (1 - materialWeight) + labelChannels[0] * materialWeight)
  const materialGreen = Math.round(green * (1 - materialWeight) + labelChannels[1] * materialWeight)
  const materialBlue = Math.round(blue * (1 - materialWeight) + labelChannels[2] * materialWeight)
  const surfaceAlpha = density.toFixed(3)
  const shadowAlpha = shadow.toFixed(3)
  const rimAlpha = (darkLabels ? 0.48 : 0.62).toFixed(3)

  return {
    context,
    luminance,
    variables: {
      '--te-lg-context-rgb': `${red}, ${green}, ${blue}`,
      '--te-lg-context-surface-alpha': surfaceAlpha,
      '--te-lg-context-shadow-alpha': shadowAlpha,
      '--te-lg-context-rim-alpha': rimAlpha,
      '--te-lg-context-label-rgb': label.replaceAll(' ', ', '),
      '--te-lg-context-surface': `rgb(${red} ${green} ${blue} / ${surfaceAlpha})`,
      '--te-lg-context-surface-solid': `rgb(${red} ${green} ${blue})`,
      '--te-lg-context-material': `rgb(${materialRed} ${materialGreen} ${materialBlue} / ${surfaceAlpha})`,
      '--te-lg-context-label': `rgb(${label})`,
      '--te-lg-context-shadow': `rgb(${label} / ${shadowAlpha})`,
      '--te-lg-context-rim': `rgb(255 255 255 / ${rimAlpha})`
    }
  }
}

function parseCssColor(value: string): [number, number, number] | null {
  const normalized = value.trim().toLowerCase()
  const hex = normalized.match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return [0, 1, 2].map((index) => Number.parseInt(hex[index] + hex[index], 16)) as [
        number,
        number,
        number
      ]
    }
    if (hex.length === 6 || hex.length === 8) {
      return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [
        number,
        number,
        number
      ]
    }
  }

  const rgb = normalized.match(
    /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/
  )
  if (!rgb) return null
  const channels = rgb.slice(1, 4).map((channel) => {
    const isPercent = channel.endsWith('%')
    const numeric = Number.parseFloat(channel)
    return Math.round((isPercent ? numeric * 2.55 : numeric) * 10) / 10
  })
  if (channels.some((channel) => !Number.isFinite(channel))) return null
  return channels.map((channel) => clamp(channel, 0, 255)) as [number, number, number]
}

export function analyzeLiquidGlassColor(
  color: string,
  isDarkFallback: boolean
): LiquidGlassEnvironment {
  const parsed = parseCssColor(color)
  if (!parsed) return fallbackLiquidGlassEnvironment(isDarkFallback)
  const [red, green, blue] = parsed
  return variablesFor(red, green, blue, relativeLuminance(red, green, blue), 0, true)
}

export function fallbackLiquidGlassEnvironment(isDark: boolean): LiquidGlassEnvironment {
  return isDark
    ? variablesFor(26, 32, 44, 0.014, 0, true)
    : variablesFor(241, 245, 249, 0.907, 0, true)
}

export function analyzeLiquidGlassPixels(
  pixels: Uint8ClampedArray,
  isDarkFallback: boolean
): LiquidGlassEnvironment {
  let weight = 0
  let red = 0
  let green = 0
  let blue = 0
  let luminance = 0

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]
    if (alpha < MIN_ALPHA) continue
    const normalizedAlpha = alpha / 255
    const pixelLuminance = relativeLuminance(pixels[index], pixels[index + 1], pixels[index + 2])
    weight += normalizedAlpha
    red += pixels[index] * normalizedAlpha
    green += pixels[index + 1] * normalizedAlpha
    blue += pixels[index + 2] * normalizedAlpha
    luminance += pixelLuminance * normalizedAlpha
  }

  if (weight === 0) return fallbackLiquidGlassEnvironment(isDarkFallback)

  const meanLuminance = luminance / weight
  let variance = 0
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]
    if (alpha < MIN_ALPHA) continue
    const normalizedAlpha = alpha / 255
    const delta =
      relativeLuminance(pixels[index], pixels[index + 1], pixels[index + 2]) - meanLuminance
    variance += delta * delta * normalizedAlpha
  }

  return variablesFor(
    Math.round(red / weight),
    Math.round(green / weight),
    Math.round(blue / weight),
    meanLuminance,
    variance / weight,
    false
  )
}

export function extractCssImageUrl(value: string): string | null {
  const match = value.trim().match(/^url\((['"]?)(.*?)\1\)$/i)
  return match?.[2].trim() || null
}

export function isTrustedLiquidGlassImageUrl(value: string): boolean {
  return /^(?:background:|theme-asset:|cover:|twilight-media:|blob:|data:image\/)/i.test(
    value.trim()
  )
}
