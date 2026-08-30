import { ref, type Ref } from 'vue'

export interface SideMenuClearanceOptions {
  showLocalSidebar: Ref<boolean>
  hasPlayerBar: Ref<boolean>
  menuOpen: Ref<boolean>
}

const SIDE_MENU_OVERLAP_GAP = 10

export function useSideMenuClearance(options: SideMenuClearanceOptions) {
  const sideMenuBottomOffset = ref(0)
  /**
   * Where the open side menu's right edge actually sits, so a bar that spans the
   * window can start after it. Not derivable in CSS: `--te-menu-width` is only
   * the menu's width, and a preset layout is free to inset the menu from the
   * window edge, which leaves a width-based `left` short by exactly that inset
   * and the bar overlapping the menu.
   */
  const sideMenuInlineEnd = ref(0)
  let sideMenuMonitorFrame: number | null = null
  let resizeObserver: ResizeObserver | null = null
  let playbarMutationObserver: MutationObserver | null = null
  let observedSideMenu: HTMLElement | null = null
  let observedPlayerBar: HTMLElement | null = null

  function setSideMenuBottomOffset(offset: number): void {
    const nextOffset = Math.max(0, Math.round(offset))
    if (sideMenuBottomOffset.value !== nextOffset) {
      sideMenuBottomOffset.value = nextOffset
    }
  }

  function setSideMenuInlineEnd(edge: number): void {
    // A detached or not-yet-laid-out menu reports nothing useful; publishing NaN
    // from here would reach a CSS custom property and invalidate the whole
    // declaration that reads it, dropping the bar back onto the menu.
    if (!Number.isFinite(edge)) return
    const nextEdge = Math.max(0, Math.round(edge))
    if (sideMenuInlineEnd.value !== nextEdge) {
      sideMenuInlineEnd.value = nextEdge
    }
  }

  function measureSideMenuClearance(): void {
    if (!options.showLocalSidebar.value || !options.hasPlayerBar.value) {
      setSideMenuBottomOffset(0)
      return
    }

    const sideMenu = document.querySelector<HTMLElement>('.side-menu')
    const playerBar = document.querySelector<HTMLElement>('.player-bar-shell')

    if (!sideMenu || !playerBar) {
      setSideMenuBottomOffset(0)
      return
    }

    /**
     * Publish where the menu's right edge lands when it is open, for the
     * edge-to-edge shapes to start after. Read from the *untransformed* box:
     * `.side-menu` is always laid out in place and merely translated off-screen
     * when closed, so `offsetLeft + offsetWidth` is the open edge whether or not
     * it is open right now, and it does not sweep through intermediate values
     * during the 0.32s slide. A rect would, and the bar would chase it.
     *
     * `--te-menu-width` cannot answer this: it is only the menu's own width, and
     * a preset may inset the menu from the window edge, which puts its edge that
     * much further right than the token implies. Measuring covers every preset,
     * plugin ones too.
     */
    setSideMenuInlineEnd(sideMenu.offsetLeft + sideMenu.offsetWidth)

    // An auto-hidden mini bar is translated out of view but keeps its layout box,
    // so its rect would still push the sidebar up. The shell flags the state.
    if (playerBar.dataset.tePlaybarHidden === 'true') {
      setSideMenuBottomOffset(0)
      return
    }

    // An open local menu already gives the bar horizontal clearance through
    // `.player-bar-shell.menu-open`. Reading the bar's rect while that `left`
    // transition is in flight briefly reports an overlap, which lifts the menu
    // and then drops it again once the transition completes. The class is the
    // stable geometry contract, so it must win over that transient rect.
    if (playerBar.classList.contains('menu-open')) {
      setSideMenuBottomOffset(0)
      return
    }

    const sideMenuRect = sideMenu.getBoundingClientRect()
    const playerBarRect = playerBar.getBoundingClientRect()
    const overlapsHorizontally =
      playerBarRect.left < sideMenuRect.right && playerBarRect.right > sideMenuRect.left
    /**
     * Test the overlap against the bottom the menu would have with no clearance
     * applied, not its current one. Once the offset lifts the menu, its measured
     * bottom clears the bar, so measuring that directly would report "no overlap",
     * reset the offset to 0, drop the menu back under the bar and overlap again —
     * and the ResizeObserver watching the menu's own height would drive that
     * oscillation forever. Adding the offset back makes the measurement a fixed
     * point: the second pass computes the same number and the ref stops changing.
     */
    const sideMenuNaturalBottom = sideMenuRect.bottom + sideMenuBottomOffset.value
    const overlapsVertically =
      playerBarRect.top < sideMenuNaturalBottom && playerBarRect.bottom > sideMenuRect.top

    if (!overlapsHorizontally || !overlapsVertically) {
      setSideMenuBottomOffset(0)
      return
    }

    setSideMenuBottomOffset(window.innerHeight - playerBarRect.top + SIDE_MENU_OVERLAP_GAP)
  }

  function stopSideMenuMonitor(): void {
    if (sideMenuMonitorFrame !== null) {
      cancelAnimationFrame(sideMenuMonitorFrame)
      sideMenuMonitorFrame = null
    }
  }

  function observeGeometry(): void {
    const sideMenu = document.querySelector<HTMLElement>('.side-menu')
    const playerBar = document.querySelector<HTMLElement>('.player-bar-shell')
    if (sideMenu === observedSideMenu && playerBar === observedPlayerBar) return

    observedSideMenu = sideMenu
    observedPlayerBar = playerBar
    resizeObserver?.disconnect()
    playbarMutationObserver?.disconnect()

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleMeasure())
      if (sideMenu) resizeObserver.observe(sideMenu)
      if (playerBar) resizeObserver.observe(playerBar)
    }
    if (typeof MutationObserver !== 'undefined' && playerBar) {
      playbarMutationObserver = new MutationObserver(() => scheduleMeasure())
      playbarMutationObserver.observe(playerBar, {
        attributes: true,
        // The shape attribute matters as much as the hidden one: standard floats
        // 18px clear of the menu while compact spans the window, so switching
        // shape changes whether the bar overlaps at all. Without it here, a shape
        // switch left the previous shape's offset in place until some other
        // mutation happened to trigger a re-measure.
        attributeFilter: [
          'class',
          'data-te-playbar-hidden',
          'data-te-playbar-visibility',
          'data-te-playbar-mode'
        ]
      })
    }
  }

  function scheduleMeasure(): void {
    if (document.hidden || sideMenuMonitorFrame !== null) return
    sideMenuMonitorFrame = requestAnimationFrame(() => {
      sideMenuMonitorFrame = null
      measureSideMenuClearance()
      observeGeometry()
    })
  }

  function startSideMenuMonitor(): void {
    if (document.hidden) return
    observeGeometry()
    scheduleMeasure()
  }

  function resetSideMenuClearance(): void {
    stopSideMenuMonitor()
    setSideMenuBottomOffset(0)
    setSideMenuInlineEnd(0)
  }

  function onDocumentVisibilityChange(): void {
    if (document.hidden) {
      stopSideMenuMonitor()
      return
    }
    startSideMenuMonitor()
  }

  const onWindowResize = (): void => scheduleMeasure()
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onWindowResize)
  }
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)

  return {
    sideMenuBottomOffset,
    sideMenuInlineEnd,
    startSideMenuMonitor,
    stopSideMenuMonitor,
    resetSideMenuClearance,
    measureSideMenuClearance,
    dispose: () => {
      stopSideMenuMonitor()
      resizeObserver?.disconnect()
      playbarMutationObserver?.disconnect()
      resizeObserver = null
      playbarMutationObserver = null
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', onWindowResize)
      }
      document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
    }
  }
}
