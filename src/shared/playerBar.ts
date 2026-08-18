/**
 * Player bar presentation — shared contract.
 *
 * The playbar has two shapes. `standard` is the full bar (cover, inline
 * progress, time labels). `mini` is a longer, progress-free pill: it drops the
 * cover, the inline progress row and the bottom border rail, keeping only the
 * track info and transport. The rail stays in the DOM behind `display: none`
 * so a future "show rail" option can restore seeking on the mini shape.
 *
 * Visibility is a separate dimension from shape, with three steps: `visible`
 * keeps the bar on screen, `autoHide` tucks it away until the pointer
 * approaches the bottom edge, and `hidden` removes it entirely with no reveal
 * gesture at all. Both dimensions follow the same global + now-playing-override
 * structure, so the now-playing page can use a different shape, a different
 * visibility, or both. `resolvePlayerBarPresentation` is the single place that
 * decides what applies, so the shell only reads the resolved value.
 */

export type PlayerBarMode = 'standard' | 'mini'

/** Playing-page shape; `inherit` follows the global `mode`. */
export type PlayerBarPageMode = PlayerBarMode | 'inherit'

export const PLAYER_BAR_MODES: readonly PlayerBarMode[] = ['standard', 'mini']

/**
 * `autoHide` still needs the mini shape to resolve (a standard bar's inline
 * progress row is its only progress readout, so it never tucks away), while
 * `hidden` applies to both shapes — nothing is revealed, so nothing is lost.
 */
export type PlayerBarVisibility = 'visible' | 'autoHide' | 'hidden'

/** Playing-page visibility; `inherit` follows the global `visibility`. */
export type PlayerBarPageVisibility = PlayerBarVisibility | 'inherit'

export const PLAYER_BAR_VISIBILITIES: readonly PlayerBarVisibility[] = [
  'visible',
  'autoHide',
  'hidden'
]

export interface PlayerBarSettings {
  /** Shape used everywhere except the now-playing page. */
  mode: PlayerBarMode
  /** Shape used on the now-playing page. */
  playingPageMode: PlayerBarPageMode
  /** Visibility used everywhere except the now-playing page. */
  visibility: PlayerBarVisibility
  /** Visibility used on the now-playing page. */
  playingPageVisibility: PlayerBarPageVisibility
  /** Pointer must come within this many px of the viewport bottom to reveal. */
  revealThresholdPx: number
  /** Delay before hiding once the pointer leaves the reveal zone. */
  hideDelayMs: number
}

interface Bound {
  min: number
  max: number
}

export const PLAYER_BAR_BOUNDS: Readonly<Record<'revealThresholdPx' | 'hideDelayMs', Bound>> = {
  revealThresholdPx: { min: 24, max: 400 },
  hideDelayMs: { min: 0, max: 5000 }
}

export const DEFAULT_PLAYER_BAR_SETTINGS: PlayerBarSettings = {
  mode: 'standard',
  playingPageMode: 'inherit',
  visibility: 'visible',
  playingPageVisibility: 'inherit',
  revealThresholdPx: 120,
  hideDelayMs: 900
}

function clamp(value: unknown, bound: Bound, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(bound.max, Math.max(bound.min, value)))
}

export function normalizePlayerBarMode(value: unknown): PlayerBarMode {
  return value === 'mini' ? 'mini' : 'standard'
}

export function normalizePlayerBarPageMode(value: unknown): PlayerBarPageMode {
  if (value === 'mini' || value === 'standard') return value
  return 'inherit'
}

export function normalizePlayerBarVisibility(value: unknown): PlayerBarVisibility {
  return value === 'autoHide' || value === 'hidden' ? value : 'visible'
}

export function normalizePlayerBarPageVisibility(value: unknown): PlayerBarPageVisibility {
  if (value === 'visible' || value === 'autoHide' || value === 'hidden') return value
  return 'inherit'
}

/**
 * Visibility used to be a single `autoHideOnPlayingPage` boolean scoped to the
 * now-playing page. Settings written before the three-step visibility exists
 * still carry it, so migrate a stored `true` onto the playing-page override and
 * leave the global step alone — the bar keeps hiding exactly where it did.
 */
function resolvePlayingPageVisibility(value: Record<string, unknown>): PlayerBarPageVisibility {
  if (value.playingPageVisibility !== undefined) {
    return normalizePlayerBarPageVisibility(value.playingPageVisibility)
  }
  return value.autoHideOnPlayingPage === true ? 'autoHide' : 'inherit'
}

export function normalizePlayerBarSettings(raw: unknown): PlayerBarSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    mode: normalizePlayerBarMode(value.mode),
    playingPageMode: normalizePlayerBarPageMode(value.playingPageMode),
    visibility: normalizePlayerBarVisibility(value.visibility),
    playingPageVisibility: resolvePlayingPageVisibility(value),
    revealThresholdPx: clamp(
      value.revealThresholdPx,
      PLAYER_BAR_BOUNDS.revealThresholdPx,
      DEFAULT_PLAYER_BAR_SETTINGS.revealThresholdPx
    ),
    hideDelayMs: clamp(
      value.hideDelayMs,
      PLAYER_BAR_BOUNDS.hideDelayMs,
      DEFAULT_PLAYER_BAR_SETTINGS.hideDelayMs
    )
  }
}

export function clonePlayerBarSettings(value: PlayerBarSettings): PlayerBarSettings {
  return { ...value }
}

export interface PlayerBarPresentation {
  mode: PlayerBarMode
  /** Bar stays tucked away until the pointer approaches the bottom edge. */
  autoHide: boolean
  /** Bar is gone with no reveal gesture; settings is the way back. */
  hidden: boolean
}

export interface PlayerBarContext {
  onPlayingPage: boolean
}

/**
 * Resolve both dimensions for the current page, then narrow the visibility step
 * to what the shape can actually do:
 *
 * - `hidden` always wins and applies to either shape — nothing is revealed, so
 *   the standard bar loses nothing it could have shown.
 * - `autoHide` additionally needs the mini shape, because a standard bar's
 *   inline progress row is its only progress readout. On a standard bar it
 *   degrades to plainly visible rather than silently hiding the progress.
 *
 * The two flags are mutually exclusive: `hidden` implies not `autoHide`.
 */
export function resolvePlayerBarPresentation(
  settings: PlayerBarSettings,
  context: PlayerBarContext
): PlayerBarPresentation {
  const pageMode = settings.playingPageMode
  const mode: PlayerBarMode = context.onPlayingPage
    ? pageMode === 'inherit'
      ? settings.mode
      : pageMode
    : settings.mode

  const pageVisibility = settings.playingPageVisibility
  const visibility: PlayerBarVisibility = context.onPlayingPage
    ? pageVisibility === 'inherit'
      ? settings.visibility
      : pageVisibility
    : settings.visibility

  const hidden = visibility === 'hidden'
  return { mode, autoHide: !hidden && visibility === 'autoHide' && mode === 'mini', hidden }
}

/** Whether `autoHide` can take effect for a page, for disabling dependent UI. */
export function playerBarAutoHideApplies(
  settings: PlayerBarSettings,
  context: PlayerBarContext
): boolean {
  return resolvePlayerBarPresentation(settings, context).autoHide
}

/**
 * Map a 0..1 rail position to a seek target. Returns null when the timeline has
 * no usable length (live stream, duration not reported yet) so callers skip the
 * seek instead of jumping to 0.
 */
export function resolveSeekTargetSeconds(ratio: number, durationSeconds: number): number | null {
  if (!Number.isFinite(ratio) || !Number.isFinite(durationSeconds)) return null
  if (durationSeconds <= 0) return null
  if (ratio < 0 || ratio > 1) return null
  return Math.min(durationSeconds, Math.max(0, ratio * durationSeconds))
}
