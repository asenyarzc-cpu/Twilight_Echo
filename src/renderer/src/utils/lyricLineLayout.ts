import type { LyricTimelineEntry } from './lyricTimeline.ts'

/**
 * The cascade lives here. Apple Music does not move a block of lines; it gives
 * every line its own spring target plus a *delay*, and the delay grows as the
 * layout walks down the list. The result is a wave that travels down from the
 * active line rather than a rigid translation.
 *
 * Two details matter and are easy to lose:
 *
 * - The delay only accumulates once a line has reached the visible area, so the
 *   off-screen backlog above does not eat the whole delay budget.
 * - The per-step increment *shrinks* below the anchor, so the wave tightens as it
 *   travels instead of smearing out.
 *
 * This module is pure geometry. It takes measured heights and returns targets;
 * the controller owns the springs and the DOM.
 */

/**
 * Scale is carried as a percentage, matching the spring epsilon. Springs settle
 * at 0.01, so a 100 -> 97 range resolves cleanly while a 1.0 -> 0.97 range would
 * fall inside the settle threshold and never animate.
 */
export const LYRIC_SCALE_ACTIVE = 104
export const LYRIC_SCALE_PRESENTED = 102
export const LYRIC_SCALE_INACTIVE = 100
export const LYRIC_SCALE_BACKGROUND = 75

export const LYRIC_OPACITY_SINGING = 1
export const LYRIC_OPACITY_PRESENTED = 0.86
export const LYRIC_OPACITY_PAST = 0.68
export const LYRIC_OPACITY_FUTURE = 0.46
export const LYRIC_OPACITY_NORMAL = LYRIC_OPACITY_FUTURE
export const LYRIC_OPACITY_NON_DYNAMIC = LYRIC_OPACITY_FUTURE
/** Not zero: a fully transparent line gets optimised out and pops on return. */
export const LYRIC_OPACITY_HIDDEN = 0.00001

export const LYRIC_BLUR_PER_INDEX = 0.35
export const LYRIC_BLUR_MAX = 4
export const LYRIC_NARROW_VIEWPORT_PX = 1024
export const LYRIC_NARROW_BLUR_SCALE = 0.8

export const LYRIC_CASCADE_BASE_DELAY = 0.032
export const LYRIC_CASCADE_DECAY = 1.05
export const LYRIC_CASCADE_MAX_DELAY = 0.096

/** Range the built-in scale amount spans: 100 (idle) up to 104 (singing). */
export const LYRIC_SCALE_RANGE = LYRIC_SCALE_ACTIVE - LYRIC_SCALE_INACTIVE
export const LYRIC_PRESENTED_SCALE_RANGE = LYRIC_SCALE_PRESENTED - LYRIC_SCALE_INACTIVE

export const LYRIC_ALIGN_POSITION = 0.35
export const LYRIC_INTERLUDE_DOTS_GAP_PX = 40
export const LYRIC_INTERLUDE_DOTS_OFFSET_PX = 10

export type LyricAlignAnchor = 'top' | 'center' | 'bottom'

export interface LyricLayoutLine {
  index: number
  height: number
  /** Reserved for background voices; they collapse while playing. */
  isBackground?: boolean
}

export interface LyricLayoutOptions {
  lines: readonly LyricLayoutLine[]
  timeline?: readonly LyricTimelineEntry[]
  /** Index the view is anchored to. */
  scrollToIndex: number
  /** Lines whose concrete vocal span contains the playhead. */
  hot?: ReadonlySet<number>
  buffered: ReadonlySet<number>
  viewportHeight: number
  viewportWidth?: number
  /** Fraction of the visible area the anchor sits at. */
  alignPosition?: number
  alignAnchor?: LyricAlignAnchor
  /** Manual browse displacement, in pixels. */
  scrollOffset?: number
  /** Space covered by an overlay such as the player bar. */
  bottomReservedPx?: number
  isPlaying?: boolean
  /** Suppresses the cascade so a scrub lands immediately. */
  isSeeking?: boolean
  enableScale?: boolean
  enableBlur?: boolean
  hidePassedLines?: boolean
  isNonDynamic?: boolean
  /**
   * Line indices the focus window keeps. Everything else collapses out of the
   * flow, the same way a background voice does, so the kept lines sit together
   * instead of floating in the gaps the hidden ones left behind. `null` keeps
   * the whole timeline.
   */
  focusWindow?: ReadonlySet<number> | null
  /**
   * Multiplier for lines that have not been presented yet, 0-1. Applied only to
   * those lines: folding it into the presented or non-dynamic opacities as well
   * would compound two dimmings into one unreadable wash.
   */
  inactiveDim?: number
  /** Scales the inactive-line shrink, 0-1 of the built-in amount. */
  scaleIntensity?: number
  /** Scales the depth blur, 0-1 of the built-in amount. */
  blurIntensity?: number
  /** Multiplier on the cascade delay. 1 is the built-in rhythm. */
  cascadeSpeedFactor?: number
  /** Present and at least the minimum duration. */
  interludeAfterIndex?: number | null
  interludeDotsHeight?: number
}

export interface LyricLineTarget {
  index: number
  top: number
  /** Percentage. Divide by 100 for a CSS scale. */
  scale: number
  opacity: number
  blur: number
  /** Seconds. Feeds `LyricSpring.setTargetPosition(top, delay)`. */
  delay: number
  presented: boolean
}

export interface LyricLayoutResult {
  lines: LyricLineTarget[]
  /** Vertical position for the interlude dots, or `null` when not shown. */
  interludeDotsTop: number | null
  /** `[min, max]` manual browse range. */
  scrollBoundary: [number, number]
  /** Total content height, used for the bottom spacer. */
  contentBottom: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function computeLyricLayout(options: LyricLayoutOptions): LyricLayoutResult {
  const {
    lines,
    scrollToIndex: requestedScrollIndex,
    hot: providedHot,
    buffered,
    viewportHeight,
    viewportWidth = Number.POSITIVE_INFINITY,
    alignPosition = LYRIC_ALIGN_POSITION,
    alignAnchor = 'center',
    scrollOffset = 0,
    bottomReservedPx = 0,
    isPlaying = true,
    isSeeking = false,
    enableScale = true,
    enableBlur = true,
    hidePassedLines = false,
    isNonDynamic = false,
    focusWindow = null,
    inactiveDim = 1,
    scaleIntensity = 1,
    blurIntensity = 1,
    cascadeSpeedFactor = 1,
    interludeAfterIndex = null,
    interludeDotsHeight = 0
  } = options

  const visibleHeight = Math.max(0, viewportHeight - Math.max(0, bottomReservedPx))
  const hot = providedHot ?? buffered
  const dim = clamp(inactiveDim, 0, 1)
  const scaleAmount = clamp(scaleIntensity, 0, 1)
  const blurAmount = clamp(blurIntensity, 0, 1)

  /**
   * Outside the focus window a line collapses rather than merely fading: leaving
   * its height in the flow would space the surviving lines apart by the gaps the
   * hidden ones used to fill.
   */
  const isFocusHidden = (lineIndex: number): boolean =>
    focusWindow != null && isPlaying && !focusWindow.has(lineIndex)

  // `scrollToIndex` is a *line* index, but the caller may hand us a sparse or
  // partial set of rows, so array position and line index are not interchangeable.
  // Resolve the anchor by line index and keep the two apart from here on;
  // conflating them makes a sparse set anchor to the wrong row and write targets
  // to indices that do not exist.
  let anchorPosition = lines.findIndex((line) => line.index === requestedScrollIndex)
  if (anchorPosition < 0) {
    anchorPosition = lines.findIndex((line) => line.index >= requestedScrollIndex)
    if (anchorPosition < 0) anchorPosition = Math.max(0, lines.length - 1)
  }
  const scrollToIndex = lines[anchorPosition]?.index ?? requestedScrollIndex

  // Height of everything above the anchor. Background voices collapse while
  // playing, so they must not push the anchor down. Focus-hidden lines collapse
  // for the same reason — counting them would leave the anchor stranded below a
  // stack of invisible rows.
  let stackedAbove = 0
  for (let position = 0; position < anchorPosition; position += 1) {
    const line = lines[position]
    if (!line) continue
    if (line.isBackground && isPlaying) continue
    if (isFocusHidden(line.index)) continue
    stackedAbove += line.height
  }

  let curPos = -scrollOffset - stackedAbove + visibleHeight * clamp(alignPosition, 0, 1)

  const anchorLine = lines[anchorPosition]
  if (anchorLine) {
    if (alignAnchor === 'center') curPos -= anchorLine.height / 2
    else if (alignAnchor === 'bottom') curPos -= anchorLine.height
  }

  const scrollBoundaryMin = -stackedAbove
  const latestPresented = buffered.size > 0 ? Math.max(...buffered) : -1
  const blurScale = viewportWidth <= LYRIC_NARROW_VIEWPORT_PX ? LYRIC_NARROW_BLUR_SCALE : 1
  const singingScale = enableScale
    ? LYRIC_SCALE_INACTIVE + LYRIC_SCALE_RANGE * scaleAmount
    : LYRIC_SCALE_INACTIVE
  const presentedScale = enableScale
    ? LYRIC_SCALE_INACTIVE + LYRIC_PRESENTED_SCALE_RANGE * scaleAmount
    : LYRIC_SCALE_INACTIVE

  const results: LyricLineTarget[] = []
  let interludeDotsTop: number | null = null
  let dotsPlaced = false
  let delay = 0
  let baseDelay = LYRIC_CASCADE_BASE_DELAY * Math.max(0, cascadeSpeedFactor)

  for (let position = 0; position < lines.length; position += 1) {
    const line = lines[position]
    const lineIndex = line.index
    const singing = hot.has(lineIndex)
    const presented = buffered.has(lineIndex)
    const focused = singing || presented
    const focusHidden = isFocusHidden(lineIndex)

    if (
      !dotsPlaced &&
      interludeAfterIndex != null &&
      (lineIndex === scrollToIndex + 1 || (lineIndex === scrollToIndex && interludeAfterIndex < 0))
    ) {
      dotsPlaced = true
      interludeDotsTop = curPos + LYRIC_INTERLUDE_DOTS_OFFSET_PX
      curPos += interludeDotsHeight + LYRIC_INTERLUDE_DOTS_GAP_PX
    }

    let opacity: number
    if (focusHidden) {
      opacity = LYRIC_OPACITY_HIDDEN
    } else if (hidePassedLines && isPlaying && lineIndex < scrollToIndex) {
      opacity = LYRIC_OPACITY_HIDDEN
    } else if (singing) {
      opacity = LYRIC_OPACITY_SINGING
    } else if (presented) {
      opacity = LYRIC_OPACITY_PRESENTED
    } else if (lineIndex < scrollToIndex) {
      opacity = LYRIC_OPACITY_PAST * dim
    } else {
      opacity = (isNonDynamic ? LYRIC_OPACITY_NON_DYNAMIC : LYRIC_OPACITY_FUTURE) * dim
    }

    let blur = 0
    if (enableBlur && !focused) {
      const distance =
        lineIndex < scrollToIndex
          ? Math.abs(scrollToIndex - lineIndex) + 1
          : Math.abs(lineIndex - Math.max(scrollToIndex, latestPresented))
      blur =
        clamp((1 + distance) * LYRIC_BLUR_PER_INDEX * blurScale, 0, LYRIC_BLUR_MAX) * blurAmount
    }

    let scale = LYRIC_SCALE_INACTIVE
    if (isPlaying) {
      if (singing) scale = singingScale
      else if (presented) scale = presentedScale
      else if (line.isBackground) scale = LYRIC_SCALE_BACKGROUND
    }

    results.push({ index: lineIndex, top: curPos, scale, opacity, blur, delay, presented })

    if ((!line.isBackground || focused || !isPlaying) && !focusHidden) curPos += line.height

    // Only lines that have reached the visible area consume delay, and the step
    // tightens below the anchor.
    if (curPos >= 0 && !isSeeking) {
      if (!line.isBackground && !focusHidden) {
        delay = Math.min(LYRIC_CASCADE_MAX_DELAY, delay + baseDelay)
      }
      if (lineIndex >= scrollToIndex) baseDelay /= LYRIC_CASCADE_DECAY
    }
  }

  return {
    lines: results,
    interludeDotsTop,
    scrollBoundary: [
      scrollBoundaryMin,
      Math.max(scrollBoundaryMin, curPos + scrollOffset - visibleHeight / 2)
    ],
    contentBottom: curPos
  }
}

/** True when a line's box intersects the viewport, with one line of slack. */
export function isLyricLineInSight(top: number, height: number, viewportHeight: number): boolean {
  return !(top > viewportHeight + height || top + height < -height)
}
