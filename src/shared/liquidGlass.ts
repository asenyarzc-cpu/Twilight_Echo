/**
 * Liquid glass surface material — shared contract.
 *
 * The material is a switchable alternative to the standard card/playbar surface.
 * Its refraction comes from an SVG filter chain (feImage displacement map ->
 * per-channel feDisplacementMap -> screen blend -> edge mask), applied to a
 * dedicated warp layer that also carries backdrop-filter. Content is a sibling
 * of that layer so it stays sharp.
 *
 * `feDisplacementMap scale` and `feImage href` are SVG attributes and cannot read
 * CSS variables, so the renderer reads the resolved `--te-lg-*` values back out of
 * computed style and binds them as attributes.
 */

export type SurfaceMaterial = 'standard' | 'liquidGlass'
export type LiquidGlassCoverage = 'functional' | 'expanded'

export const SURFACE_MATERIALS: readonly SurfaceMaterial[] = ['standard', 'liquidGlass']

/** Filter ids referenced from CSS. Cards and the playbar differ in aspect ratio. */
export const LIQUID_GLASS_CARD_FILTER_ID = 'te-lg-card'
export const LIQUID_GLASS_EXPANDED_CARD_FILTER_ID = 'te-lg-expanded-card'
export const LIQUID_GLASS_HOME_CARD_FILTER_ID = 'te-lg-home-card'
export const LIQUID_GLASS_PLAYBAR_FILTER_ID = 'te-lg-playbar'
export const LIQUID_GLASS_TUNING_CHANGED_EVENT = 'twilight:liquid-glass-tuning-changed'
export const LIQUID_GLASS_OFFSCREEN_CLASS = 'te-liquid-glass-offscreen'
export const LIQUID_GLASS_BUDGET_CLASS = 'te-liquid-glass-budget'
export const LIQUID_GLASS_MAX_VISIBLE_EXPANDED_SURFACES = 24

/** Clear glass is reserved for the dashboard's media-rich Hero treatment. */
export const LIQUID_GLASS_HOME_CARD_SELECTOR = '.home .feature-card'

/** Selector used by the pointer tracker and visibility observer. */
export const LIQUID_GLASS_CARD_SELECTOR = LIQUID_GLASS_HOME_CARD_SELECTOR

/** Explicit content surfaces used only by the opt-in expanded coverage mode. */
export const LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR = [
  '.artist-card',
  '.album-card',
  '.playlist-card',
  '.glass-card',
  '.signal-card',
  '.chart-card',
  '.profile-card',
  '.recent-card',
  '.ranking-card'
].join(',')

export interface LiquidGlassTheme {
  /** Displacement magnitude in px fed to feDisplacementMap. */
  displacementScale: number
  /** Backdrop blur radius in px. */
  blurAmount: number
  /** Backdrop saturation in percent. */
  saturation: number
  /** Chromatic aberration strength; drives per-channel scale falloff. */
  aberrationIntensity: number
  /** How strongly the surface reaches toward the cursor (percent). */
  elasticity: number
  /** Specular rim/highlight opacity in percent. */
  specularOpacity: number
  /** Surface tint opacity in percent. */
  tintOpacity: number
}

export interface LiquidGlassSettings {
  /** Functional chrome by default; expanded also applies a bounded card profile. */
  coverage: LiquidGlassCoverage
  /** Highlight gradient angle follows the pointer (rAF-throttled). */
  followPointer: boolean
  /** Tint the glass dark on light backgrounds for visibility ("Over Light"). */
  overLight: boolean
  /**
   * Flip to the dark glass profile automatically when the sampled backdrop is
   * bright, instead of waiting on the manual overLight switch. The renderer's
   * environment analysis publishes the decision as `data-te-lg-adaptive-tone`.
   */
  adaptiveTone: boolean
  light: LiquidGlassTheme
  dark: LiquidGlassTheme
  /** Enables title bar and main navigation independently. */
  navigationEnabled: boolean
  /** Enables the playbar independently while reusing the global glass profile. */
  playbarEnabled: boolean
  /** Enables the settings navigation independently while reusing the global profile. */
  settingsNavigationEnabled: boolean
  /** Optional liquid-glass profile applied only to the local dashboard cards. */
  homeCards: LiquidGlassHomeCardsSettings
}

export interface LiquidGlassHomeCardsSettings {
  enabled: boolean
  /** Tint the homepage dark profile over a light background for legibility. */
  overLight: boolean
  light: LiquidGlassTheme
  dark: LiquidGlassTheme
}

interface Bound {
  min: number
  max: number
}

export const LIQUID_GLASS_BOUNDS: Readonly<Record<keyof LiquidGlassTheme, Bound>> = {
  displacementScale: { min: 0, max: 140 },
  blurAmount: { min: 0, max: 40 },
  saturation: { min: 80, max: 200 },
  aberrationIntensity: { min: 0, max: 8 },
  elasticity: { min: 0, max: 100 },
  specularOpacity: { min: 0, max: 100 },
  tintOpacity: { min: 0, max: 100 }
}

/**
 * Tuned against the Apple material: a thin refracting rim with a fully clear
 * center (see DEFAULT_RIM_FRACTION), restrained chromatic fringing, and a
 * bright shape-following specular. Legibility comes from blur and saturation,
 * not from darkening — dark-mode tint stays low so the backdrop's colour shows
 * through the way Apple's clear material does.
 */
export const DEFAULT_LIQUID_GLASS_LIGHT: LiquidGlassTheme = {
  displacementScale: 46,
  blurAmount: 12,
  saturation: 140,
  aberrationIntensity: 0.7,
  elasticity: 12,
  specularOpacity: 68,
  tintOpacity: 3
}

export const DEFAULT_LIQUID_GLASS_DARK: LiquidGlassTheme = {
  displacementScale: 50,
  blurAmount: 14,
  saturation: 144,
  aberrationIntensity: 0.9,
  elasticity: 10,
  specularOpacity: 68,
  tintOpacity: 5
}

export const DEFAULT_LIQUID_GLASS_HOME_CARDS: LiquidGlassHomeCardsSettings = {
  enabled: false,
  overLight: false,
  light: { ...DEFAULT_LIQUID_GLASS_LIGHT },
  dark: { ...DEFAULT_LIQUID_GLASS_DARK }
}

export const DEFAULT_LIQUID_GLASS: LiquidGlassSettings = {
  coverage: 'functional',
  followPointer: true,
  overLight: false,
  adaptiveTone: true,
  light: DEFAULT_LIQUID_GLASS_LIGHT,
  dark: DEFAULT_LIQUID_GLASS_DARK,
  navigationEnabled: false,
  playbarEnabled: false,
  settingsNavigationEnabled: false,
  homeCards: DEFAULT_LIQUID_GLASS_HOME_CARDS
}

function clamp(value: unknown, bound: Bound, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(bound.max, Math.max(bound.min, value))
}

export function normalizeSurfaceMaterial(value: unknown): SurfaceMaterial {
  return value === 'liquidGlass' ? 'liquidGlass' : 'standard'
}

export function normalizeLiquidGlassCoverage(value: unknown): LiquidGlassCoverage {
  return value === 'expanded' ? 'expanded' : 'functional'
}

export function normalizeLiquidGlassTheme(
  raw: unknown,
  defaults: LiquidGlassTheme
): LiquidGlassTheme {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    displacementScale: clamp(
      t.displacementScale,
      LIQUID_GLASS_BOUNDS.displacementScale,
      defaults.displacementScale
    ),
    blurAmount: clamp(t.blurAmount, LIQUID_GLASS_BOUNDS.blurAmount, defaults.blurAmount),
    saturation: clamp(t.saturation, LIQUID_GLASS_BOUNDS.saturation, defaults.saturation),
    aberrationIntensity: clamp(
      t.aberrationIntensity,
      LIQUID_GLASS_BOUNDS.aberrationIntensity,
      defaults.aberrationIntensity
    ),
    elasticity: clamp(t.elasticity, LIQUID_GLASS_BOUNDS.elasticity, defaults.elasticity),
    specularOpacity: clamp(
      t.specularOpacity,
      LIQUID_GLASS_BOUNDS.specularOpacity,
      defaults.specularOpacity
    ),
    tintOpacity: clamp(t.tintOpacity, LIQUID_GLASS_BOUNDS.tintOpacity, defaults.tintOpacity)
  }
}

export function normalizeLiquidGlass(raw: unknown): LiquidGlassSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const homeCards = (
    typeof value.homeCards === 'object' && value.homeCards !== null ? value.homeCards : {}
  ) as Record<string, unknown>
  return {
    coverage: normalizeLiquidGlassCoverage(value.coverage),
    followPointer: value.followPointer !== false,
    overLight: value.overLight === true,
    adaptiveTone: value.adaptiveTone !== false,
    light: normalizeLiquidGlassTheme(value.light, DEFAULT_LIQUID_GLASS_LIGHT),
    dark: normalizeLiquidGlassTheme(value.dark, DEFAULT_LIQUID_GLASS_DARK),
    navigationEnabled: value.navigationEnabled === true,
    playbarEnabled: value.playbarEnabled === true,
    settingsNavigationEnabled: value.settingsNavigationEnabled === true,
    homeCards: {
      enabled: homeCards.enabled === true,
      overLight: homeCards.overLight === true,
      light: normalizeLiquidGlassTheme(homeCards.light, DEFAULT_LIQUID_GLASS_HOME_CARDS.light),
      dark: normalizeLiquidGlassTheme(homeCards.dark, DEFAULT_LIQUID_GLASS_HOME_CARDS.dark)
    }
  }
}

/**
 * Expanded content surfaces use a deliberately restrained derivative of the
 * shared profile. This keeps the functional chrome tunable without turning
 * large content cards into high-contrast plastic panels.
 */
export function resolveExpandedLiquidGlassTheme(theme: LiquidGlassTheme): LiquidGlassTheme {
  return {
    displacementScale: Math.min(theme.displacementScale, 16),
    blurAmount: Math.min(theme.blurAmount, 16),
    saturation: Math.min(theme.saturation, 150),
    aberrationIntensity: Math.min(theme.aberrationIntensity, 0.5),
    elasticity: 0,
    specularOpacity: Math.min(theme.specularOpacity, 36),
    tintOpacity: theme.tintOpacity
  }
}

export interface LiquidGlassChannelScales {
  red: number
  green: number
  blue: number
}

/**
 * Per-channel displacement scales. The red channel carries the base displacement
 * and green/blue trail behind it, which is what separates into chromatic fringing
 * at the refracted edge. Scales stay non-negative so a high aberration value at a
 * low displacement cannot flip the channel direction.
 */
export function resolveChannelScales(
  displacementScale: number,
  aberrationIntensity: number
): LiquidGlassChannelScales {
  const base = Math.max(0, displacementScale)
  const step = Math.max(0, aberrationIntensity) * 0.05
  return {
    red: base,
    green: Math.max(0, base * (1 - step)),
    blue: Math.max(0, base * (1 - step * 2))
  }
}

/** Softening applied after the channel blend; mirrors the reference falloff. */
export function resolveAberrationBlur(aberrationIntensity: number): number {
  return Math.max(0.1, 0.5 - Math.max(0, aberrationIntensity) * 0.1)
}

export function liquidGlassCssVariables(theme: LiquidGlassTheme): Record<string, string> {
  return liquidGlassCssVariablesWithPrefix(theme, '--te-lg')
}

/** Homepage cards keep an independent profile while reusing the same shader contract. */
export function liquidGlassHomeCardCssVariables(theme: LiquidGlassTheme): Record<string, string> {
  return liquidGlassCssVariablesWithPrefix(theme, '--te-home-lg')
}

export function liquidGlassExpandedCssVariables(theme: LiquidGlassTheme): Record<string, string> {
  return liquidGlassCssVariablesWithPrefix(
    resolveExpandedLiquidGlassTheme(theme),
    '--te-lg-expanded'
  )
}

function liquidGlassCssVariablesWithPrefix(
  theme: LiquidGlassTheme,
  prefix: '--te-lg' | '--te-home-lg' | '--te-lg-expanded'
): Record<string, string> {
  return {
    [`${prefix}-displacement`]: String(theme.displacementScale),
    [`${prefix}-blur`]: `${theme.blurAmount}px`,
    [`${prefix}-saturate`]: `${theme.saturation}%`,
    [`${prefix}-aberration`]: String(theme.aberrationIntensity),
    [`${prefix}-elasticity`]: String(theme.elasticity),
    [`${prefix}-specular`]: (theme.specularOpacity / 100).toFixed(3),
    [`${prefix}-tint`]: (theme.tintOpacity / 100).toFixed(3)
  }
}
