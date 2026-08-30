import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_PLAYER_BAR_LAYOUT,
  PLAYER_BAR_REGION_NAMES
} from '../../../../shared/playerBarLayout.ts'

const playerBar = readFileSync(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
/**
 * Comments stripped: every match below reads a rule body as `{[^}]*}`, and a
 * comment that mentions a property it deliberately does *not* set would satisfy
 * — or wrongly fail — those assertions.
 */
const playerBarCss = readFileSync(new URL('./PlayerBar.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)
const compactVisualizer = readFileSync(
  new URL('./CompactPlayerBarVisualizer.vue', import.meta.url),
  'utf8'
)
const app = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')
const streamingSidebar = readFileSync(
  new URL('../streaming-page/ProviderSidebar.vue', import.meta.url),
  'utf8'
)

/**
 * Class-level specificity components of a selector: classes, attribute selectors
 * and pseudo-classes all count once each. Enough to compare a compact rule
 * against a preset theme layout rule for the same subject, which is the only
 * comparison this file needs.
 */
function classCount(selector: string): number {
  const flat = selector.replace(/::[a-zA-Z-]+/g, '').replace(/\s+/g, ' ')
  return (
    (flat.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).length +
    (flat.match(/\[[^\]]*\]/g) ?? []).length +
    (flat.match(/(?<!:):(?!:)[a-zA-Z-]+/g) ?? []).length
  )
}

test('the compact shape is wired through the same shape prop and class as the others', () => {
  assert.match(playerBar, /const isCompact = computed\(\(\) => props\.mode === 'compact'\)/)
  assert.match(playerBar, /'player-bar-compact': isCompact/)
  // The shell attribute is what the geometry keys off, and it comes from the
  // resolved shape rather than from anything compact-specific.
  assert.match(playerBar, /'data-te-playbar-mode':\s*props\.mode/)
})

test('the expanded visualizer is mounted only for compact on the lyrics page', () => {
  assert.match(app, /:visualizer-visible="showPlayingPage"/)
  assert.match(playerBar, /visualizerVisible\?: boolean/)
  assert.match(playerBar, /visualizerVisible: false/)
  assert.match(
    playerBar,
    /const showCompactVisualizer = computed\(\(\) => isCompact\.value && props\.visualizerVisible\)/
  )
  assert.match(playerBar, /'player-bar-compact-visualizer': showCompactVisualizer/)
  assert.match(playerBar, /<CompactPlayerBarVisualizer\s+v-if="showCompactVisualizer"/)

  const plainCompact = playerBarCss.match(
    /\.player-bar\.player-bar-compact\.player-bar-compact\.player-bar-compact:not\(\s*\.player-bar-compact-visualizer\s*\)\s*\{[^}]*\}/
  )
  assert.ok(plainCompact, 'compact without a lyrics visualizer needs its own geometry')
  assert.match(plainCompact[0], /height:\s*72px/)
  assert.match(
    playerBarCss,
    /\.player-bar\.player-bar-compact:not\(\.player-bar-compact-visualizer\)\s*>\s*\.compact-progress-rail\s*\{[^}]*top:\s*0/
  )
})

test('the lyrics-page visualizer stage has no painted base colour', () => {
  const stage = playerBarCss.match(
    /\.player-bar\.player-bar-compact\.player-bar-compact\.player-bar-compact\.player-bar-compact-visualizer\.player-bar-compact-visualizer\s*\{[^}]*\}/
  )
  assert.ok(stage, 'lyrics-page compact needs an explicit visualizer state')
  assert.match(stage[0], /background:\s*transparent/)
  assert.match(stage[0], /padding-top:\s*var\(--te-compact-visualizer-height/)
  assert.doesNotMatch(stage[0], /grid-template-columns|justify-content|column-gap/)

  // The whole compact bar is transparent in the lyrics presentation. A
  // pseudo-element here would repaint the old dark lower control deck over the
  // page, even though the bar's own background is transparent.
  assert.doesNotMatch(
    playerBarCss,
    /\.player-bar-compact-visualizer::after\s*\{/,
    'lyrics-page compact must not add an opaque control-deck pseudo-element'
  )

  const visualizerSurface = compactVisualizer.match(/\.compact-visualizer\s*\{[^}]*\}/)
  assert.ok(visualizerSurface, 'the visualizer component needs a stage surface')
  assert.match(visualizerSurface[0], /background:\s*transparent/)
  assert.doesNotMatch(compactVisualizer, /compact-visualizer__tint/)
  assert.doesNotMatch(compactVisualizer, /compact-visualizer__art|<CoverImg\b/)
  assert.match(compactVisualizer, /v-for="\(level, index\) in skylineBands"/)
  assert.match(compactVisualizer, /class="compact-visualizer__band"/)
  assert.match(compactVisualizer, /--te-compact-band-count': COMPACT_VISUALIZER_BAND_COUNT/)
  assert.match(compactVisualizer, /grid-template-columns:\s*repeat\(var\(--te-compact-band-count\)/)
  assert.match(compactVisualizer, /box-shadow:[\s\S]{0,220}var\(--accent-color/)
  assert.match(compactVisualizer, /transition:\s*transform 55ms linear/)
  assert.doesNotMatch(compactVisualizer, /will-change:\s*transform/)
  assert.doesNotMatch(compactVisualizer, /compact-visualizer__mountains|clipPath/)
  assert.doesNotMatch(compactVisualizer, /(?:backdrop-)?filter\s*:/)
  assert.doesNotMatch(
    playerBar,
    /<CompactPlayerBarVisualizer[\s\S]{0,500}:(?:cover|cover-source|track-identity)=/
  )
})

test('compact auto-hide keeps the lyrics visualizer while hiding its controls', () => {
  const retainedStage = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-hidden='true'\]\[data-te-playbar-visibility='auto'\][\s\S]{0,360}\.player-bar\.player-bar-compact\.player-bar-compact\.player-bar-compact-visualizer\s*\{[^}]*\}/
  )
  assert.ok(retainedStage, 'auto-hide needs a retained compact visualizer stage')
  assert.match(retainedStage[0], /transform:\s*none/)
  assert.match(retainedStage[0], /opacity:\s*1/)
  assert.match(retainedStage[0], /pointer-events:\s*none/)

  const bottomStage = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-hidden='true'\]\[data-te-playbar-visibility='auto'\][\s\S]{0,700}\.player-bar\.player-bar-compact\.player-bar-compact\.player-bar-compact\.player-bar-compact-visualizer\.player-bar-compact-visualizer\s*\{[^}]*\}/
  )
  assert.ok(bottomStage, 'auto-hide visualizer needs a bottom-anchored stage')
  assert.match(bottomStage[0], /height:\s*var\(--te-compact-visualizer-height, 138px\)/)
  assert.match(bottomStage[0], /padding-top:\s*0/)

  const hiddenControls = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-hidden='true'\]\[data-te-playbar-visibility='auto'\][\s\S]{0,500}>\s*:not\(\.compact-visualizer\)\s*\{[^}]*\}/
  )
  assert.ok(hiddenControls, 'auto-hide must remove compact controls without removing the stage')
  assert.match(hiddenControls[0], /opacity:\s*0/)
  assert.match(hiddenControls[0], /visibility:\s*hidden/)
  assert.match(hiddenControls[0], /pointer-events:\s*none/)
  assert.match(playerBarCss, /data-te-playbar-visibility='hidden'[\s\S]{0,220}visibility:\s*hidden/)
})

test('every shape renders the same three regions, in a fixed order, with fixed class names', () => {
  assert.deepEqual([...PLAYER_BAR_REGION_NAMES], ['left', 'center', 'right'])
  assert.match(playerBar, /v-for="region in barRegions"/)
  assert.match(playerBar, /:class="region\.className"/)
  assert.match(playerBar, /:data-te-playbar-region="region\.name"/)
  // The class names the six preset theme layouts address the bar through must be
  // derived, not hand-written per shape, or one shape drifts off them.
  assert.match(playerBar, /className:\s*`player-\$\{name\}`/)
  assert.match(
    playerBar,
    /resolvePlayerBarRegions\(settings\.value\.playerBar\.layout, props\.mode\)/
  )
  // The left rail keeps remounting on track change; that remount is what fixed
  // stale covers, and a plain region name as the key would have dropped it.
  assert.match(playerBar, /key: name === 'left' \? `left:\$\{playerLeftKey\.value\}` : name/)
})

test('shape chrome renders after whatever the layout placed, never instead of it', () => {
  const loopEnd = playerBar.indexOf(
    '</template>',
    playerBar.indexOf('v-for="control in region.items"')
  )
  assert.ok(loopEnd > 0, 'the control loop must close')
  for (const marker of [
    'class="resume-offer"',
    'class="progress-area"',
    'class="mini-progress-rail"'
  ]) {
    assert.ok(
      playerBar.indexOf(marker) > loopEnd,
      `${marker} must render after the control loop, not inside it`
    )
  }
})

test('compact keeps its progress readout out of the layout, on its own top edge', () => {
  // Not a placeable control: the three shapes render three different progress
  // readouts, so a movable one would only buy unrenderable arrangements.
  const placed = Object.values(DEFAULT_PLAYER_BAR_LAYOUT).flatMap((regions) => [
    ...regions.left,
    ...regions.center,
    ...regions.right
  ])
  for (const id of ['progress', 'progressRail', 'compactProgress']) {
    assert.equal(placed.includes(id as never), false, `${id} must not be a layout control`)
  }
  assert.match(playerBar, /v-if="isCompact" class="compact-progress-rail"/)
  assert.match(playerBar, /class="compact-progress-fill" :style="progressFillStyle"/)
  // Same 0..1 seek handler as mini's long rail, so neither has to know pixels.
  assert.match(playerBar, /class="compact-progress-slider"[\s\S]{0,320}@input="onFlatRailInput"/)
  assert.match(playerBar, /function onFlatRailInput/)
  assert.doesNotMatch(playerBar, /onMiniRailInput/)
})

test('compact defaults to the arrangement the shape was designed around', () => {
  assert.deepEqual(DEFAULT_PLAYER_BAR_LAYOUT.compact, {
    left: ['cover', 'trackInfo', 'favorite', 'miniPlayer'],
    center: ['playMode', 'transport', 'equalizer'],
    right: ['time', 'hifi', 'volume', 'desktopLyrics', 'queue', 'exitPlayingPage']
  })
  // The exit control renders only under `glass`, so it costs the main window
  // nothing — but without it the only way off the now-playing page was clicking
  // the same entry that opened it, which reads as "open", not "close".
  assert.equal(DEFAULT_PLAYER_BAR_LAYOUT.compact.right.includes('exitPlayingPage'), true)
  // The time readout and the equalizer entry are new controls the shape needs.
  assert.match(playerBar, /v-else-if="control === 'time'"[\s\S]{0,200}class="player-time-readout"/)
  assert.match(
    playerBar,
    /v-else-if="control === 'equalizer'"[\s\S]{0,160}class="icon-btn equalizer-btn player-misc-icon"/
  )
  assert.match(playerBar, /@click="openEqualizerPage"/)
  // The transport group keeps its `.player-controls` wrapper and `.btn-play`, the
  // two hooks all six preset theme layouts restyle the play cluster through.
  assert.match(
    playerBar,
    /v-else-if="control === 'transport'" class="player-controls"[\s\S]{0,600}class="ctrl-btn btn-play"/
  )
})

test('every arrangement keeps exactly one way into the now-playing page', () => {
  // The cover slot is the usual entry, but any shape can have it removed — which
  // used to leave the page unreachable from the bar. The title takes the role
  // over precisely when no region placed a cover, so the count is always one:
  // never zero, never two competing entries.
  assert.match(
    playerBar,
    /const trackTitleOpensPlayingPage = computed\(\s*\(\) =>\s*!props\.preview &&\s*!barRegions\.value\.some\(\(region\) => region\.items\.includes\('cover'\)\)\s*\)/
  )
  // Both entries funnel into the same emit, so the page still zooms out of the
  // rect that was clicked rather than a hardcoded corner.
  assert.match(playerBar, /function emitOpenPlayingPage\(origin: HTMLElement \| null\)/)
  assert.match(
    playerBar,
    /function onCoverClick\(\): void \{\s*emitOpenPlayingPage\(coverRef\.value\)/
  )
  assert.match(playerBar, /function onTrackTitleClick\(event: Event\)/)
  assert.match(playerBar, /if \(!trackTitleOpensPlayingPage\.value\) return/)
  // A real <button>, not a div with a click handler, so it is keyboard reachable.
  assert.match(
    playerBar,
    /v-if="!trackTitleOpensPlayingPage" class="player-title"[\s\S]{0,240}<button[\s\S]{0,200}class="player-title player-title-button"[\s\S]{0,200}@click="onTrackTitleClick"/
  )
  // The button carries `.player-title` too, so this class only has to strip the
  // native button chrome — the same trick `.player-artist` already ships.
  const titleButton = playerBarCss.match(/\.player-title-button\s*\{[^}]*\}/)
  assert.ok(titleButton, 'the title entry point needs the text-button reset')
  for (const property of [
    'background:\\s*transparent',
    'border:\\s*0',
    'padding:\\s*0',
    'text-align:\\s*inherit',
    'cursor:\\s*pointer'
  ]) {
    assert.match(titleButton[0], new RegExp(property))
  }
  /**
   * And it must re-declare neither the typography nor the colour. Both live on
   * `.player-title`, which four preset theme layouts restyle; a second
   * same-specificity declaration here would shadow the base one and quietly
   * make a standard bar's heading render differently than it does today.
   */
  assert.doesNotMatch(titleButton[0], /(?:^|[;{]\s*)color\s*:/)
  assert.doesNotMatch(titleButton[0], /font-(?:family|size|weight)\s*:/)
  // Keyboard users need to see where they are, since there is no button chrome.
  assert.match(playerBarCss, /\.player-title-button:focus-visible\s*\{/)
})

test('the shell clears the bar beside either open sidebar', () => {
  const sideMenu = readFileSync(new URL('../SideMenu.vue', import.meta.url), 'utf8')
  const clearance = readFileSync(
    new URL('../../app/useSideMenuClearance.ts', import.meta.url),
    'utf8'
  )

  // The streaming sidebar follows the local behaviour: it stays full height and
  // gives the bar the same `menu-open` state, so the bar begins to its right.
  assert.match(
    app,
    /const sidebarMenuOpen = computed\(\(\) => \{[\s\S]*?if \(showPlayingPage\.value\) return false[\s\S]*?return showStreamingPage\.value \? streamingMenuOpen\.value : menuOpen\.value\s*\}\)/
  )
  assert.match(app, /:menu-open="sidebarMenuOpen"/)
  assert.match(playerBar, /'menu-open': menuOpen/)
  assert.match(
    playerBarCss,
    /\.player-bar-shell\.menu-open\s*\{[^}]*left:\s*calc\(var\(--te-menu-width\)/
  )

  // The measured clearance was computed and then dropped on the floor. It now
  // travels as a custom property — not an inline `bottom` — so the custom shell
  // layout's `inset: auto !important` on the menu still wins.
  assert.match(app, /'--te-side-menu-bottom': `\$\{sideMenuBottomOffset\}px`/)
  assert.match(sideMenu, /bottom: var\(--te-side-menu-bottom, 0px\)/)
  assert.match(streamingSidebar, /\.streaming-sidebar\s*\{[^}]*bottom:\s*0;/)
  assert.doesNotMatch(streamingSidebar, /--te-side-menu-bottom/)
  assert.doesNotMatch(clearance, /streamingSidebarVisible/)

  // Lifting the menu shrinks its own rect, so measuring the lifted bottom would
  // report "no overlap", reset to 0, drop it back under the bar and oscillate
  // forever under the ResizeObserver. Measuring the unlifted bottom is a fixed
  // point.
  assert.match(clearance, /sideMenuRect\.bottom \+ sideMenuBottomOffset\.value/)
  assert.match(clearance, /playerBarRect\.top < sideMenuNaturalBottom/)
})

test('compact geometry out-specifies the preset theme layouts without !important', () => {
  const geometry = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-mode='compact'\]\s*\.player-bar\.player-bar-compact\.player-bar-compact\.player-bar-compact\s*\{[^}]*\}/
  )
  assert.ok(geometry, 'compact geometry rule must repeat the class to beat the preset layouts')
  const [rule] = geometry
  assert.doesNotMatch(rule, /!important/)
  // Every preset layout rewrites at least these four; compact has to win them.
  for (const property of ['height', 'max-width', 'padding', 'grid-template-columns']) {
    assert.match(rule, new RegExp(`\\b${property}\\s*:`), `compact geometry must set ${property}`)
  }
  // Edge to edge, square, and no hairline: the progress line is the top edge.
  assert.match(rule, /max-width:\s*none/)
  assert.match(rule, /width:\s*100%/)
  assert.match(rule, /border-radius:\s*0/)
  assert.match(rule, /border:\s*0/)
  // Side columns of 1fr are what actually centres the transport cluster.
  assert.match(rule, /grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/)
  // The reveal animation rides this transition, same as mini's.
  assert.match(rule, /transform var\(--te-motion-panel\)/)
  // Neither strip may clip: the volume drawer opens upward out of the bar and a
  // clipping strip cuts it away. Mini used to, which is what hid its drawer.
  assert.doesNotMatch(rule, /overflow:\s*hidden/)
})

test('the artwork is resized to the strip and still clears the rail band', () => {
  const barHeight = playerBarCss
    .match(
      /\.player-bar-shell\[data-te-playbar-mode='compact'\]\s*\.player-bar\.player-bar-compact\.player-bar-compact\.player-bar-compact\s*\{[^}]*\}/
    )?.[0]
    .match(/height:\s*(\d+)px/)
  const railHeight = playerBarCss
    .match(/\.player-bar\.player-bar-compact > \.compact-progress-rail\s*\{[^}]*\}/)?.[0]
    .match(/height:\s*(\d+)px/)
  const coverRule = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-mode='compact'\][^{]*\.player-cover-placeholder\s*\{[^}]*\}/
  )
  assert.ok(barHeight, 'the compact strip must declare its height')
  assert.ok(railHeight, 'the compact rail must declare its hit band')
  assert.ok(coverRule, 'compact must resize the artwork away from the standard 48px box')

  // All three boxes have to move together: the slot clips, the loaded image sets
  // its own size, and the placeholder is a third element on the same footprint —
  // resizing only one of them leaves the artwork cropped or overflowing.
  const subjects = coverRule[0]
    .slice(0, coverRule[0].indexOf('{'))
    .split(',')
    .map((selector) => selector.trim().split(/\s+/).at(-1))
  assert.deepEqual(subjects.sort(), [
    '.player-cover',
    '.player-cover-placeholder',
    '.player-cover-slot'
  ])

  const cover = Number(coverRule[0].match(/height:\s*(\d+)px/)?.[1])
  assert.ok(cover > 0, 'the compact artwork needs a real box')
  // Below the base bar's 48px, and small enough that the 4px region nudge still
  // leaves it clear of the rail's pointer strip along the top edge.
  assert.ok(cover < 48, `compact artwork ${cover}px must be smaller than the standard 48px`)
  assert.ok(
    (Number(barHeight[1]) - cover) / 2 + 4 > Number(railHeight[1]),
    `a ${cover}px cover in a ${barHeight[1]}px strip would sit inside the ${railHeight[1]}px rail band`
  )
  // The corners come down with the box; the base 12px radius on a 44px tile reads
  // as a squircle rather than as artwork.
  assert.match(coverRule[0], /border-radius:\s*\d+px/)
})

test('the top-edge rail never wins the layer fight against the volume drawer', () => {
  // The drawer is the only floating panel *inside* the bar, and like on every
  // shape its bottom edge tucks a few px in. On compact those px land in the
  // rail's hit band, so whichever layer is higher decides two visible things:
  // whether the 2px line draws across the drawer, and whether a click near the
  // drawer's bottom scrubs the track instead. The anchor has to out-rank it.
  const railZ = playerBarCss.match(
    /\.player-bar\.player-bar-compact > \.compact-progress-rail\s*\{[^}]*z-index:\s*(\d+)/
  )
  const anchorZ = playerBarCss.match(
    /\.player-bar\.player-bar-compact \.volume-anchor\s*\{[^}]*z-index:\s*(\d+)/
  )
  assert.ok(railZ, 'the compact rail must declare its layer')
  assert.ok(anchorZ, 'compact must lift the volume anchor above its rail')
  assert.ok(
    Number(anchorZ[1]) > Number(railZ[1]),
    `volume anchor z-index ${anchorZ[1]} must exceed the rail's ${railZ[1]}`
  )
  // Lifting the anchor rather than the drawer is what carries the whole panel,
  // and it only works because nothing between them opens a stacking context.
  assert.match(playerBarCss, /\.volume-anchor\s*\{[^}]*position:\s*relative/)
  const playerRight = playerBarCss.match(/\n\.player-right\s*\{[^}]*\}/)
  assert.ok(playerRight)
  assert.doesNotMatch(playerRight[0], /z-index|transform|filter|opacity:\s*0?\.\d/)
})

test('compact pins the shell to the window edges harder than any preset layout does', () => {
  const shellRule =
    /\.player-bar-shell\[data-te-playbar-mode='compact'\]\.player-bar-shell\.player-bar-shell\s*\{[^}]*\}/
  const flush = playerBarCss.match(shellRule)
  assert.ok(flush, 'compact must claim the shell insets')
  for (const property of ['left:\\s*0', 'right:\\s*0', 'bottom:\\s*0']) {
    assert.match(flush[0], new RegExp(property))
  }
  assert.doesNotMatch(flush[0], /!important/)

  const menuOpen = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-mode='compact'\]\.player-bar-shell\.player-bar-shell\.menu-open\s*\{[^}]*\}/
  )
  assert.ok(menuOpen, 'compact must follow the side menu when it opens')
  /**
   * The edge comes from the measured right edge of the open menu, not from
   * `--te-menu-width`. The token is only the menu's own width, so a preset that
   * insets the menu from the window edge puts its edge that much further right,
   * and a width-based `left` left the bar covering the gap. The token stays as
   * the fallback for the frames before the
   * first measurement lands, and `max()` keeps whichever is further right.
   */
  assert.match(
    menuOpen[0],
    /left:\s*max\(var\(--te-side-menu-inline-end, 0px\), var\(--te-menu-width\)\)/
  )
  // App.vue has to publish that variable somewhere the shell can read it.
  assert.match(app, /'--te-side-menu-inline-end': `\$\{sideMenuInlineEnd\}px`/)
  assert.match(app, /sideMenuInlineEnd/)

  // The arithmetic the two rules above rely on: no preset layout targets the
  // shell with as many class-level components as compact does.
  const compactShellCount = classCount(
    ".player-bar-shell[data-te-playbar-mode='compact'].player-bar-shell.player-bar-shell"
  )
  const compactMenuCount = classCount(
    ".player-bar-shell[data-te-playbar-mode='compact'].player-bar-shell.player-bar-shell.menu-open"
  )
  const layoutDir = new URL('../../assets/theme-layouts/', import.meta.url)
  const offenders: string[] = []
  for (const name of readdirSync(layoutDir).filter(
    (file) => file.endsWith('.css') && file !== 'index.css'
  )) {
    const source = readFileSync(new URL(name, layoutDir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const [, selectorList] of source.matchAll(/([^{}]+)\{/g)) {
      for (const selector of selectorList.split(',').map((part) => part.trim())) {
        if (!selector.endsWith('.player-bar-shell') && !selector.endsWith('.menu-open')) continue
        if (!selector.includes('.player-bar-shell')) continue
        const budget = selector.endsWith('.menu-open') ? compactMenuCount : compactShellCount
        if (classCount(selector) >= budget) offenders.push(`${name}: ${selector}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these preset layout rules tie or beat compact on the shell insets:\n${offenders.join('\n')}`
  )
})

test('compact keeps a visible edge only where the system palette takes over', () => {
  // Forced colors replaces the fill, so the strip would otherwise dissolve into
  // the page — the one mode where an outline is wanted.
  assert.match(
    playerBarCss,
    /@media \(forced-colors: active\) \{\s*\.player-bar-shell\[data-te-playbar-mode='compact'\][\s\S]{0,220}border-top:\s*1px solid CanvasText/
  )
})

test('the compact boundary rail is a 2px line over a real hit target', () => {
  const rail = playerBarCss.match(
    /\.player-bar\.player-bar-compact\s*>\s*\.compact-progress-rail\s*\{[^}]*\}/
  )
  assert.ok(rail, 'the compact rail must be positioned against the bar')
  assert.match(rail[0], /position:\s*absolute/)
  assert.match(rail[0], /top:\s*var\(--te-compact-visualizer-height, 138px\)/)
  assert.match(rail[0], /pointer-events:\s*auto/)
  // Taller than the visible line so dragging it is possible at all.
  const railHeight = rail[0].match(/height:\s*(\d+)px/)
  assert.ok(railHeight && Number(railHeight[1]) >= 6, 'the rail needs a real hit target')

  assert.match(playerBarCss, /\.compact-progress-track\s*\{[^}]*height:\s*2px/)
  // Real DOM track and fill, not ::-webkit-slider-runnable-track: Chromium does
  // not reliably repaint the pseudo-element when only a custom property changes.
  assert.match(playerBarCss, /\.compact-progress-fill\s*\{[^}]*background:\s*var\(--accent-color/)
  assert.match(playerBarCss, /\.compact-progress-fill\s*\{[^}]*transform:\s*scaleX\(0\)/)
  assert.match(playerBarCss, /\.compact-progress-slider\s*\{[^}]*inset:\s*0/)
  assert.match(playerBarCss, /\.compact-progress-slider::-webkit-slider-thumb\s*\{[^}]*width:\s*0/)
})

test('compact regions stay vertically centred in both presentation states', () => {
  const regions = playerBarCss.match(
    /\.player-bar-compact\.player-bar-compact\.player-bar-compact\s+\.player-left,[\s\S]*?\.player-bar-compact\.player-bar-compact\.player-bar-compact\s+\.player-right\s*\{[^}]*\}/
  )
  assert.ok(regions, 'compact regions need one shared alignment rule')
  assert.match(regions[0], /align-self:\s*center/)
  assert.match(regions[0], /margin-block:\s*0/)
  assert.doesNotMatch(regions[0], /align-self:\s*end|margin-bottom/)
})

test('the compact strip uses a neutral surface instead of the track accent', () => {
  // Compact may use accent for the play button and progress rail, but never for
  // the full-width strip behind every control.
  const geometry = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-mode='compact'\]\s*\.player-bar\.player-bar-compact\.player-bar-compact\.player-bar-compact\s*\{[^}]*\}/
  )
  assert.ok(geometry, 'compact needs a base surface rule')
  assert.match(geometry[0], /background:\s*var\(--te-neutral-100\)/)
  assert.doesNotMatch(geometry[0], /background:[^;}]*(?:accent-color|te-primary)/)

  // The compact-only section stays tokenized. Fixed glass colours remain in the
  // shared mini/compact declaration above this point.
  const compactSection = playerBarCss.slice(
    playerBarCss.indexOf(".player-bar-shell[data-te-playbar-mode='compact']")
  )
  assert.ok(compactSection.length > 1000, 'failed to locate the compact section')
  const literals = compactSection.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) ?? []
  assert.deepEqual(literals, [], `compact rules must use tokens, found: ${literals.join(', ')}`)
  assert.match(playerBarCss, /--te-flat-bar-glass-bg/)

  // PlayingMusic passes glass=true even under the light app theme, so compact
  // needs the playing-page surface explicitly or the flat rule turns it white.
  const glassRule = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-mode='compact'\][^{]*\.player-bar\.player-bar-glass\.player-bar-compact\.player-bar-compact\.player-bar-compact\s*\{[^}]*\}/
  )
  assert.ok(glassRule, 'playing-page compact override must exist')
  assert.match(glassRule[0], /background:\s*var\(--te-flat-bar-glass-bg\)/)
  assert.match(glassRule[0], /background-image:\s*none/)
  assert.doesNotMatch(glassRule[0], /border/)

  // The playing-page rail inherits mini's brighter track/fill from a shared rule.
  assert.match(playerBarCss, /\.player-bar-glass \.compact-progress-track,/)
  assert.match(playerBarCss, /\.player-bar-glass \.compact-progress-fill,/)
  // And so does the dark-theme lift: 22% accent over transparent leaves the
  // unfilled part of the rail barely visible on a dark strip.
  assert.match(
    playerBarCss,
    /html\[data-theme='dark'\] \.player-bar-compact \.compact-progress-track,/
  )
})
