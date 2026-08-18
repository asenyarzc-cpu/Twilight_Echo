import {
  requestAnimationFrameWithFallback,
  type AnimationFrameFallbackScheduler
} from './animationFrameFallback.ts'
import {
  computeLyricLayout,
  isLyricLineInSight,
  LYRIC_ALIGN_POSITION,
  type LyricAlignAnchor,
  type LyricLayoutLine
} from './lyricLineLayout.ts'
import {
  LYRIC_BG_SCALE_SPRING,
  LYRIC_POS_Y_SPRING,
  LYRIC_SCALE_SPRING,
  LyricSpring
} from './lyricSpring.ts'

/**
 * Owns lyric motion. The previous implementation animated `viewport.scrollTop`,
 * which forced every line to share one position and made Apple's cascade
 * mathematically impossible: a single scalar cannot express lines arriving at
 * different times. `scrollTop` also clamps at both ends and quantises to whole
 * pixels, so it could not give each line an independent target.
 *
 * Here each line is absolutely positioned and owns a `posY` and a `scale` spring.
 * One rAF loop advances them all. Manual browsing moves a `scrollOffset` that
 * feeds the layout instead of touching native scroll, so the container can stay
 * `overflow: hidden` and wheel handlers can stay passive.
 */

const FRAME_FALLBACK_MS = 120

/** Manual browsing releases back to follow after this long untouched. */
export const LYRIC_MANUAL_BROWSE_RESET_MS = 5000

export interface LyricRowElement {
  offsetHeight: number
  scrollHeight?: number
  style: {
    setProperty(property: string, value: string): void
    removeProperty(property: string): void
  }
  isConnected?: boolean
}

export interface LyricStageElement {
  clientHeight: number
  clientWidth: number
}

export interface LyricViewportControllerOptions {
  /** Resolves once Vue has committed the timeline and rows are measurable. */
  afterLayout: () => Promise<void>
  onManualBrowseChange: (active: boolean) => void
  getActiveIndex?: () => number
  /** Lines whose concrete vocal span contains the playhead. */
  getHotIndices?: () => ReadonlySet<number>
  /** Presented (hot plus held) lines. Falls back to the active index. */
  getBufferedIndices?: () => ReadonlySet<number>
  alignPosition?: number
  /**
   * Read per layout rather than captured at construction, so the anchor can move
   * while the page is open. Takes precedence over `alignPosition`.
   */
  getAlignPosition?: () => number
  alignAnchor?: LyricAlignAnchor
  /**
   * Vertical space at the bottom covered by an overlay such as the player bar,
   * which must not count as visible lyric area.
   */
  getBottomReservedPx?: () => number
  /** Visual breathing room between absolute rows. */
  getRowGapPx?: () => number
  /** Motion preference. `false` snaps and skips blur, for reduced motion. */
  isSpringEnabled?: () => boolean
  isBlurEnabled?: () => boolean
  isScaleEnabled?: () => boolean
  isPlaying?: () => boolean
  isNonDynamic?: () => boolean
  /** Line indices the focus window keeps, or `null` for the whole timeline. */
  getFocusWindow?: () => ReadonlySet<number> | null
  /** Opacity multiplier for lines that have not been presented yet, 0-1. */
  getInactiveDim?: () => number
  getScaleIntensity?: () => number
  getBlurIntensity?: () => number
  getCascadeSpeedFactor?: () => number
  shouldHidePassedLines?: () => boolean
  getInterludeAfterIndex?: () => number | null
  getInterludeDotsHeight?: () => number
  /** Called with the dots position each frame, or `null` when hidden. */
  onInterludeDotsTop?: (top: number | null) => void
  frameScheduler?: AnimationFrameFallbackScheduler
}

export interface LyricFollowOptions {
  mode?: 'spring' | 'snap' | 'resize'
}

interface RowState {
  element: LyricRowElement
  posY: LyricSpring
  scale: LyricSpring
  height: number
  isBackground: boolean
  lastTop: number | null
  lastScale: number | null
  lastOpacity: number | null
  lastBlur: number | null
  lastIntrinsicHeight: number | null
  inSight: boolean
}

/** Hidden windows pause rAF, so animating is pointless and drags on timers. */
function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function createLyricViewportController(options: LyricViewportControllerOptions) {
  const rows = new Map<number, RowState>()
  const fallbackAlignPosition = options.alignPosition ?? LYRIC_ALIGN_POSITION
  const alignAnchor = options.alignAnchor ?? 'center'

  let stage: LyricStageElement | null = null
  let activeTrackId = ''
  let activation = 0
  let followRequest = 0
  let manualBrowse = false
  let manualBrowseTimer: number | null = null
  let scrollOffset = 0
  let scrollBoundary: [number, number] = [0, 0]
  let cancelFrame: (() => void) | null = null
  let cancelResize: (() => void) | null = null
  let lastFrameNow: number | null = null
  let interludeDotsTop: number | null = null
  let hasCommittedLayout = false

  const scheduler = options.frameScheduler
  const springEnabled = (): boolean => options.isSpringEnabled?.() ?? true

  const isCurrent = (token: number, request: number): boolean =>
    token === activation && request === followRequest && Boolean(activeTrackId)

  function setManualBrowse(next: boolean): void {
    if (manualBrowse === next) return
    manualBrowse = next
    options.onManualBrowseChange(next)
  }

  function clearManualBrowseTimer(): void {
    if (manualBrowseTimer == null) return
    if (scheduler) scheduler.clearTimeout(manualBrowseTimer)
    else if (typeof window !== 'undefined') window.clearTimeout(manualBrowseTimer)
    manualBrowseTimer = null
  }

  function bufferedIndices(): ReadonlySet<number> {
    const provided = options.getBufferedIndices?.()
    // An empty set is meaningful, not missing data: during an interlude nothing
    // is presented, and that is exactly when every line should soften.
    if (provided) return provided
    const active = options.getActiveIndex?.() ?? -1
    return active >= 0 ? new Set([active]) : new Set<number>()
  }

  function layoutLines(): LyricLayoutLine[] {
    const indices = [...rows.keys()].sort((left, right) => left - right)
    return indices.map((index) => {
      const row = rows.get(index) as RowState
      // Culled rows use `content-visibility: hidden`, which applies size
      // containment. `offsetHeight` then collapses to padding, and feeding that
      // back in packs later lines on top of each other after a downward browse.
      if (row.inSight) {
        const measured = Math.max(row.element.offsetHeight, row.element.scrollHeight ?? 0)
        if (measured > 0) row.height = measured
      }
      return {
        index,
        height: row.height + Math.max(0, options.getRowGapPx?.() ?? 0),
        isBackground: row.isBackground
      }
    })
  }

  /** Recompute targets and hand each line its own spring target plus delay. */
  function applyLayout(force: boolean, isSeeking = false): void {
    if (!stage || rows.size === 0) return

    // `getActiveIndex` returns -1 before any line is presented; the layout is
    // expecting a real line index, so pin to the first row instead of leaving
    // the anchor stranded off the timeline.
    const rawIndex = options.getActiveIndex?.() ?? 0
    const scrollToIndex = rawIndex >= 0 ? rawIndex : 0

    const result = computeLyricLayout({
      lines: layoutLines(),
      scrollToIndex,
      hot: options.getHotIndices?.() ?? bufferedIndices(),
      buffered: bufferedIndices(),
      viewportHeight: stage.clientHeight,
      viewportWidth: stage.clientWidth,
      alignPosition: options.getAlignPosition?.() ?? fallbackAlignPosition,
      alignAnchor,
      scrollOffset,
      bottomReservedPx: Math.max(0, options.getBottomReservedPx?.() ?? 0),
      isPlaying: options.isPlaying?.() ?? true,
      // Manual browsing is a rigid translation: cascade delay would leave the
      // lines below waiting on the active row and they would pile up on screen.
      isSeeking: isSeeking || !springEnabled() || manualBrowse,
      enableScale: options.isScaleEnabled?.() ?? true,
      enableBlur: options.isBlurEnabled?.() ?? true,
      isNonDynamic: options.isNonDynamic?.() ?? false,
      hidePassedLines: options.shouldHidePassedLines?.() ?? false,
      // Focus mode collapses outsiders onto the same y. Yield it while the user
      // is reading ahead, the same way pause already does.
      focusWindow: manualBrowse ? null : (options.getFocusWindow?.() ?? null),
      inactiveDim: options.getInactiveDim?.() ?? 1,
      scaleIntensity: options.getScaleIntensity?.() ?? 1,
      blurIntensity: options.getBlurIntensity?.() ?? 1,
      cascadeSpeedFactor: options.getCascadeSpeedFactor?.() ?? 1,
      interludeAfterIndex: options.getInterludeAfterIndex?.() ?? null,
      interludeDotsHeight: options.getInterludeDotsHeight?.() ?? 0
    })

    scrollBoundary = result.scrollBoundary
    interludeDotsTop = result.interludeDotsTop
    options.onInterludeDotsTop?.(interludeDotsTop)

    const snap = force || !hasCommittedLayout || !springEnabled() || isDocumentHidden()

    for (const target of result.lines) {
      const row = rows.get(target.index)
      if (!row) continue

      if (snap) {
        row.posY.setPosition(target.top)
        row.scale.setPosition(target.scale)
      } else {
        // The delay is the cascade: identical springs, staggered departures.
        row.posY.setTargetPosition(target.top, target.delay)
        row.scale.setTargetPosition(target.scale)
      }

      writeRowStatics(row, target.opacity, target.blur)
    }

    if (snap) {
      commitRows()
      hasCommittedLayout = true
    } else scheduleFrame()
  }

  function writeRowStatics(row: RowState, opacity: number, blur: number): void {
    if (row.lastOpacity !== opacity) {
      row.lastOpacity = opacity
      row.element.style.setProperty('--lyric-line-opacity', opacity.toFixed(5))
    }
    const nextBlur = springEnabled() && (options.isBlurEnabled?.() ?? true) ? blur : 0
    if (row.lastBlur !== nextBlur) {
      row.lastBlur = nextBlur
      row.element.style.setProperty('--lyric-line-blur', `${nextBlur.toFixed(3)}px`)
    }
  }

  /** Write spring positions to the DOM. Culled rows keep a top so a later browse cannot stack them. */
  function commitRows(): boolean {
    if (!stage) return true
    const viewportHeight = stage.clientHeight
    let settled = true

    for (const row of rows.values()) {
      row.element.style.setProperty('--lyric-line-ready', '1')
      const top = row.posY.getCurrentPosition()
      const scale = row.scale.getCurrentPosition()
      if (!row.posY.arrived() || !row.scale.arrived()) settled = false

      const inSight = isLyricLineInSight(top, row.height, viewportHeight)
      if (inSight !== row.inSight) {
        row.inSight = inSight
        row.element.style.setProperty('--lyric-line-in-sight', inSight ? '1' : '0')
      }

      if (row.lastTop !== top || row.lastScale !== scale) {
        row.lastTop = top
        row.lastScale = scale
        row.element.style.setProperty('--lyric-line-top', `${top.toFixed(2)}px`)
        row.element.style.setProperty('--lyric-line-scale', (scale / 100).toFixed(5))
      }
      if (row.lastIntrinsicHeight !== row.height && row.height > 0) {
        row.lastIntrinsicHeight = row.height
        row.element.style.setProperty('contain-intrinsic-size', `auto ${row.height.toFixed(2)}px`)
      }
    }

    return settled
  }

  function scheduleFrame(): void {
    if (cancelFrame || !springEnabled()) return
    cancelFrame = requestAnimationFrameWithFallback(
      (now) => {
        cancelFrame = null
        if (isDocumentHidden()) {
          for (const row of rows.values()) {
            row.posY.setPosition(row.posY.getTargetPosition())
            row.scale.setPosition(row.scale.getTargetPosition())
          }
          commitRows()
          lastFrameNow = null
          return
        }

        const delta = lastFrameNow == null ? 1 / 60 : Math.min(0.05, (now - lastFrameNow) / 1000)
        lastFrameNow = now
        for (const row of rows.values()) {
          row.posY.update(delta)
          row.scale.update(delta)
        }

        if (commitRows()) lastFrameNow = null
        else scheduleFrame()
      },
      FRAME_FALLBACK_MS,
      scheduler
    )
  }

  function cancelFollow(): void {
    followRequest += 1
    cancelFrame?.()
    cancelFrame = null
    lastFrameNow = null
  }

  function attach(element: LyricStageElement | null): void {
    stage = element
  }

  function detach(element?: LyricStageElement | null): void {
    if (!element || stage === element) stage = null
  }

  function activate(trackId: string): void {
    if (trackId === activeTrackId) return
    activation += 1
    cancelFollow()
    clearManualBrowseTimer()
    rows.clear()
    scrollOffset = 0
    hasCommittedLayout = false
    activeTrackId = trackId
    setManualBrowse(false)
  }

  function registerRow(index: number, element: LyricRowElement | null, isBackground = false): void {
    if (!element) {
      const current = rows.get(index)
      // Vue can run an older ref callback after its replacement has registered.
      if (current && current.element.isConnected === true) return
      rows.delete(index)
      return
    }

    const existing = rows.get(index)
    if (existing && existing.element === element) {
      existing.isBackground = isBackground
      return
    }

    // A replacement row starts at the absolute-position default (y=0). Hide it
    // until the next committed layout has given it its own position so rapidly
    // switching tracks or seeking cannot briefly pile every new line together.
    element.style.setProperty('--lyric-line-ready', '0')

    rows.set(index, {
      element,
      posY: new LyricSpring(existing?.posY.getCurrentPosition() ?? 0, LYRIC_POS_Y_SPRING),
      scale: new LyricSpring(
          existing?.scale.getCurrentPosition() ?? 100,
        isBackground ? LYRIC_BG_SCALE_SPRING : LYRIC_SCALE_SPRING
      ),
      height: Math.max(
        element.offsetHeight,
        element.scrollHeight ?? 0,
        existing?.height ?? 0
      ),
      isBackground,
      lastTop: null,
      lastScale: null,
      lastOpacity: null,
      lastBlur: null,
      lastIntrinsicHeight: null,
      inSight: true
    })
  }

  async function follow(index: number, followOptions: LyricFollowOptions = {}): Promise<void> {
    if (!activeTrackId || index < 0 || manualBrowse) return
    cancelFollow()
    const token = activation
    const request = followRequest
    const mode = followOptions.mode ?? 'spring'

    await options.afterLayout()
    if (!isCurrent(token, request) || manualBrowse || !stage) return
    applyLayout(mode === 'snap', mode === 'snap')
  }

  function recenter(mode: 'resize' | 'snap' = 'resize'): Promise<void> {
    // A `-1` active index means "no line is presented yet": paused before
    // playback starts, or the position watcher has not fired. This is exactly
    // the case entering the lyrics page hits. Skipping the layout here leaves
    // every row's `--lyric-line-top` at its CSS default of 0 and all rows
    // render stacked on the same pixel. Anchor to the first row instead so
    // the lines spread — a real follow() call from `activeLyricIndex` will
    // re-anchor to the live line as soon as one is presented.
    const index = options.getActiveIndex?.() ?? -1
    // Plain/untimed lyrics intentionally have no active row. They still need a
    // committed layout, otherwise newly registered absolute rows would remain at
    // their default y=0 (and, during replacement, stay hidden forever).
    return follow(index >= 0 ? index : 0, { mode })
  }

  /**
   * Manual browsing. Takes a wheel or touch delta rather than reading native
   * scroll, which is what lets the stage stay `overflow: hidden` and the wheel
   * listener stay passive.
   */
  function browseBy(deltaY: number): void {
    if (!activeTrackId || !stage) return
    cancelFollow()
    setManualBrowse(true)
    scrollOffset = Math.min(scrollBoundary[1], Math.max(scrollBoundary[0], scrollOffset + deltaY))
    applyLayout(false)
    armManualBrowseRelease()
  }

  function armManualBrowseRelease(): void {
    clearManualBrowseTimer()
    const release = (): void => {
      manualBrowseTimer = null
      releaseManualBrowse()
    }
    manualBrowseTimer = scheduler
      ? scheduler.scheduleTimeout(release, LYRIC_MANUAL_BROWSE_RESET_MS)
      : typeof window !== 'undefined'
        ? window.setTimeout(release, LYRIC_MANUAL_BROWSE_RESET_MS)
        : null
  }

  function beginManualBrowse(): void {
    if (!activeTrackId || !stage) return
    cancelFollow()
    setManualBrowse(true)
    armManualBrowseRelease()
  }

  function releaseManualBrowse(): void {
    if (!manualBrowse) return
    clearManualBrowseTimer()
    setManualBrowse(false)
    scrollOffset = 0
    void recenter()
  }

  function onResize(mode: 'spring' | 'snap' = 'spring'): void {
    if (manualBrowse || cancelResize) return
    cancelFollow()
    cancelResize = requestAnimationFrameWithFallback(
      () => {
        cancelResize = null
        if (!manualBrowse && activeTrackId && stage) {
          applyLayout(mode === 'snap', true)
        }
      },
      FRAME_FALLBACK_MS,
      scheduler
    )
  }

  function dispose(): void {
    activation += 1
    cancelFollow()
    cancelResize?.()
    cancelResize = null
    clearManualBrowseTimer()
    rows.clear()
    stage = null
    scrollOffset = 0
    activeTrackId = ''
    setManualBrowse(false)
  }

  return {
    activate,
    attach,
    browseBy,
    beginManualBrowse,
    detach,
    dispose,
    follow,
    isManualBrowsing: () => manualBrowse,
    onResize,
    recenter,
    registerRow,
    releaseManualBrowse,
    trackId: () => activeTrackId,
    /** Test and diagnostic seams. */
    getRowTop: (index: number) => rows.get(index)?.posY.getCurrentPosition() ?? null,
    getRowScale: (index: number) => rows.get(index)?.scale.getCurrentPosition() ?? null,
    getRowTargetTop: (index: number) => rows.get(index)?.posY.getTargetPosition() ?? null,
    getScrollOffset: () => scrollOffset,
    getInterludeDotsTop: () => interludeDotsTop
  }
}
