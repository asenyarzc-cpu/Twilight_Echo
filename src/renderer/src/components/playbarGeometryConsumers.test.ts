import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ref } from 'vue'

/**
 * Both bottom-edge geometry consumers measure `.player-bar-shell`. An auto-hidden
 * mini bar is only translated away, so its layout box is unchanged and measuring
 * it would reserve space around nothing — the sidebar would stay pushed up and the
 * lyric centre line would stay offset. Both must read the shell's hidden flag.
 */

interface FakeRect {
  top: number
  bottom: number
  left: number
  right: number
  height: number
}

function installDom(options: {
  playerBarHidden?: 'true' | 'false'
  playerBarMenuOpen?: boolean
  playerBarRect?: FakeRect
  sideMenuRect?: FakeRect
  playerBarMissing?: boolean
  /** Untransformed left edge, i.e. how far a preset floats the menu inward. */
  sideMenuInset?: number
}): void {
  const playerBarRect = options.playerBarRect ?? {
    top: 700,
    bottom: 780,
    left: 0,
    right: 1200,
    height: 80
  }
  const sideMenuRect = options.sideMenuRect ?? {
    top: 100,
    bottom: 760,
    left: 0,
    right: 240,
    height: 660
  }
  const playerBar = {
    dataset: { tePlaybarHidden: options.playerBarHidden ?? 'false' },
    classList: {
      contains: (name: string) => name === 'menu-open' && options.playerBarMenuOpen === true
    },
    getBoundingClientRect: () => playerBarRect
  }
  /**
   * `offsetLeft`/`offsetWidth` are the untransformed box, which is what the
   * inline-end measurement reads: the menu is laid out in place and merely
   * translated off-screen when closed, so these hold the open edge either way.
   */
  const sideMenu = {
    offsetLeft: options.sideMenuInset ?? 0,
    offsetWidth: 216,
    getBoundingClientRect: () => sideMenuRect
  }
  const g = globalThis as Record<string, unknown>
  g.window = { innerHeight: 800 }
  g.document = {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (selector: string) => {
      if (selector === '.side-menu') return sideMenu
      if (selector === '.player-bar-shell') return options.playerBarMissing ? null : playerBar
      return null
    }
  }
  g.requestAnimationFrame = (): number => 1
  g.cancelAnimationFrame = (): void => {}
}

const { useSideMenuClearance } = (await import(
  new URL('../app/useSideMenuClearance.ts', import.meta.url).href
)) as typeof import('../app/useSideMenuClearance')

function measure(options: Parameters<typeof installDom>[0]): number {
  installDom(options)
  const clearance = useSideMenuClearance({
    showLocalSidebar: ref(true),
    hasPlayerBar: ref(true),
    menuOpen: ref(true)
  })
  clearance.measureSideMenuClearance()
  const offset = clearance.sideMenuBottomOffset.value
  clearance.dispose()
  return offset
}

test('sidebar clearance reserves room for a visible overlapping playbar', () => {
  // 800 viewport - 700 top + 10 gap.
  assert.equal(measure({ playerBarHidden: 'false' }), 110)
})

test('sidebar clearance drops to zero once the mini bar is tucked away', () => {
  assert.equal(measure({ playerBarHidden: 'true' }), 0)
})

test('the open local menu keeps its full height while the bar moves beside it', () => {
  assert.equal(measure({ playerBarMenuOpen: true }), 0)
})

/**
 * An edge-to-edge bar has to start after the menu's *right edge*, and CSS cannot
 * name that: `--te-menu-width` is the menu's width alone, so a preset that insets
 * the menu from the window edge puts its edge that much further right, and a
 * width-based `left` leaves the bar covering the gap. Measured from the
 * untransformed box so the value does not sweep while the menu slides in.
 */
test('the measured menu edge follows a preset that insets the menu', () => {
  function inlineEnd(options: Parameters<typeof installDom>[0]): number {
    installDom(options)
    const clearance = useSideMenuClearance({
      showLocalSidebar: ref(true),
      hasPlayerBar: ref(true),
      menuOpen: ref(true)
    })
    clearance.measureSideMenuClearance()
    const edge = clearance.sideMenuInlineEnd.value
    clearance.dispose()
    return edge
  }

  // Flush against the window edge: the edge is just the width.
  assert.equal(inlineEnd({}), 216)
  // Inset menu: 21px further right than the token says.
  assert.equal(inlineEnd({ sideMenuInset: 21 }), 237)
  // A tucked-away bar must not suppress the edge — the menu is still there, and
  // the shape that reads this can be revealed again at any moment.
  assert.equal(inlineEnd({ sideMenuInset: 21, playerBarHidden: 'true' }), 237)
})

test('sidebar clearance still handles a missing playbar and a non-overlapping one', () => {
  assert.equal(measure({ playerBarMissing: true }), 0)
  assert.equal(
    measure({
      // Bar sits to the right of the sidebar: no horizontal overlap.
      playerBarRect: { top: 700, bottom: 780, left: 400, right: 1200, height: 80 }
    }),
    0
  )
})

/**
 * The browser feeds the applied clearance straight back into the next
 * measurement: lifting the menu shortens it, so its measured bottom now clears
 * the bar. Modelled with a live rect, because a static one cannot express that
 * loop — and it is the loop a ResizeObserver on the menu would drive forever,
 * flickering the menu between lifted and full height.
 */
test('sidebar clearance settles instead of oscillating once the menu is lifted', () => {
  const NATURAL_BOTTOM = 760
  const playerBarRect = { top: 700, bottom: 780, left: 0, right: 1200, height: 80 }
  let appliedOffset = 0
  const playerBar = {
    dataset: { tePlaybarHidden: 'false' },
    classList: { contains: () => false },
    getBoundingClientRect: () => playerBarRect
  }
  const sideMenu = {
    offsetLeft: 0,
    offsetWidth: 216,
    getBoundingClientRect: () => ({
      top: 100,
      bottom: NATURAL_BOTTOM - appliedOffset,
      left: 0,
      right: 240,
      height: NATURAL_BOTTOM - appliedOffset - 100
    })
  }
  const g = globalThis as Record<string, unknown>
  g.window = { innerHeight: 800 }
  g.document = {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (selector: string) => {
      if (selector === '.side-menu') return sideMenu
      if (selector === '.player-bar-shell') return playerBar
      return null
    }
  }
  g.requestAnimationFrame = (): number => 1
  g.cancelAnimationFrame = (): void => {}

  const clearance = useSideMenuClearance({
    showLocalSidebar: ref(true),
    hasPlayerBar: ref(true),
    menuOpen: ref(true)
  })
  const passes: number[] = []
  for (let pass = 0; pass < 4; pass += 1) {
    clearance.measureSideMenuClearance()
    // What the DOM would look like on the next observer callback.
    appliedOffset = clearance.sideMenuBottomOffset.value
    passes.push(appliedOffset)
  }
  clearance.dispose()
  // 800 viewport - 700 top + 10 gap, then held: no pass may drop back to 0.
  assert.deepEqual(passes, [110, 110, 110, 110])
})

test('the now-playing lyric centring reads the same hidden flag', () => {
  const playingMusic = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const helper = playingMusic.match(/function measurePlaybarReservedPx\(\)[\s\S]*?\n\}/)
  assert.ok(helper, 'PlayingMusic must resolve the reserved bottom space in one helper')
  assert.match(helper[0], /querySelector<HTMLElement>\('\.player-bar-shell'\)/)
  assert.match(helper[0], /dataset\.tePlaybarHidden === 'true'\) return 0/)
  // The flag check must precede measurement, or the hidden bar's box still counts.
  assert.ok(
    helper[0].indexOf('tePlaybarHidden') < helper[0].indexOf('getBoundingClientRect'),
    'the hidden check must short-circuit before measuring'
  )
  assert.match(playingMusic, /getBottomReservedPx:\s*measurePlaybarReservedPx/)
})

test('the shell is what publishes the flag both consumers query', () => {
  const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
  // dataset.tePlaybarHidden is the camelCase view of data-te-playbar-hidden.
  assert.match(playerBar, /'data-te-playbar-hidden':/)
  assert.match(playerBar, /class="player-bar-shell"[\s\S]{0,200}v-bind="shellDataAttrs"/)
})

test('sidebar clearance is event-driven instead of a perpetual rAF loop', () => {
  const source = readFileSync(new URL('../app/useSideMenuClearance.ts', import.meta.url), 'utf8')
  assert.match(source, /new ResizeObserver\(/)
  assert.match(source, /new MutationObserver\(/)
  assert.doesNotMatch(source, /requestAnimationFrame\(tick\)/)
})
