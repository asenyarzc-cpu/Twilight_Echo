import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { compileStyle } from '@vue/compiler-sfc'

import { DEFAULT_PLAYER_BAR_LAYOUT } from '../../../../shared/playerBarLayout.ts'

const playerBar = readFileSync(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
const playerBarCss = readFileSync(new URL('./PlayerBar.css', import.meta.url), 'utf8')
/**
 * Same source with comments removed. An assertion that a rule does *not* set
 * some property has to read this one: a rule that explains in prose why it
 * leaves the property alone would otherwise satisfy a raw match on it.
 */
const playerBarCssDeclarations = playerBarCss.replace(/\/\*[\s\S]*?\*\//g, '')
const app = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')

type Specificity = [ids: number, classes: number, types: number]

interface ParsedRule {
  selector: string
  properties: string[]
  specificity: Specificity
}

/** Cascade specificity for the plain selectors these stylesheets use. */
function specificityOf(selector: string): Specificity {
  const flat = selector.replace(/::[a-zA-Z-]+/g, '').replace(/\s+/g, ' ')
  return [
    (flat.match(/#[\w-]+/g) ?? []).length,
    (flat.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).length +
      (flat.match(/\[[^\]]*\]/g) ?? []).length +
      (flat.match(/(?<!:):(?!:)[a-zA-Z-]+/g) ?? []).length,
    (flat.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length
  ]
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** Classes on the rightmost compound — the element the rule actually styles. */
function subjectClasses(selector: string): Set<string> {
  const subject =
    selector
      .split(/[\s>+~]+/)
      .filter(Boolean)
      .pop() ?? ''
  return new Set((subject.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).map((name) => name.slice(1)))
}

/**
 * Brace-aware rule walk. A regex over `{…}` desyncs on `@media` preludes and on
 * nested blocks, which would silently drop the rules this test needs to see.
 */
function parseRules(rawSource: string): ParsedRule[] {
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: ParsedRule[] = []
  let prelude = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '}') {
      prelude = ''
      index += 1
      continue
    }
    if (char !== '{') {
      prelude += char
      index += 1
      continue
    }
    const selectorList = prelude.trim()
    prelude = ''
    index += 1
    // At-rule: descend into the body so its nested rules are visited normally.
    if (selectorList.startsWith('@')) continue
    let depth = 1
    let body = ''
    while (index < source.length && depth > 0) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
      body += source[index]
      index += 1
    }
    index += 1
    // Keyframe steps ("0%, 100%") are not element selectors.
    if (selectorList.includes('%')) continue
    const properties = [...body.matchAll(/(?:^|;)\s*([-a-zA-Z]+)\s*:/g)].map((match) => match[1])
    for (const selector of selectorList
      .split(',')
      .map((part) => part.trim().replace(/\s+/g, ' '))) {
      if (selector) rules.push({ selector, properties, specificity: specificityOf(selector) })
    }
  }
  return rules
}

test('the shell forwards the resolved shape and hidden state as data attributes', () => {
  assert.match(playerBar, /'data-te-playbar-mode':\s*props\.mode/)
  assert.match(
    playerBar,
    /'data-te-playbar-hidden':\s*playbarHidden\.value\s*\?\s*'true'\s*:\s*'false'/
  )
  assert.match(playerBar, /class="player-bar-shell"[\s\S]{0,200}v-bind="shellDataAttrs"/)
  // The tucked-away half stays derived from the reveal state, never a raw prop.
  assert.match(playerBar, /autoHideActive\.value\s*&&\s*!playbarRevealed\.value/)
})

test('fully hidden is a separate step that outranks auto-hide', () => {
  // Distinct attribute, so CSS can treat "tucked away" and "gone" differently.
  assert.match(playerBar, /'data-te-playbar-visibility':\s*fullyHidden\.value/)
  // Either way of being hidden sets the flag the geometry consumers read.
  assert.match(playerBar, /fullyHidden\.value\s*\|\|\s*\(autoHideActive\.value/)
  // Fully hidden disarms auto-hide, so the pointer listeners never attach.
  assert.match(playerBar, /props\.autoHide\s*&&\s*!fullyHidden\.value/)
  // The settings preview must keep showing a bar whatever the live state is.
  assert.match(
    playerBar,
    /fullyHidden\s*=\s*computed\(\(\)\s*=>\s*props\.hiddenBar\s*&&\s*!props\.preview\)/
  )
  // `hiddenBar`, not `hidden`: the global attribute would fall through onto the
  // shell and display:none the element both geometry consumers query.
  assert.match(playerBar, /hiddenBar\?:\s*boolean/)
  assert.doesNotMatch(playerBar, /\n\s{4}hidden\?:\s*boolean/)
})

test('App.vue resolves the shape through the shared policy rather than inline logic', () => {
  assert.match(app, /resolvePlayerBarPresentation/)
  assert.match(app, /onPlayingPage:\s*showPlayingPage\.value/)
  assert.match(app, /:mode="playerBarPresentation\.mode"/)
  assert.match(app, /:auto-hide="playerBarPresentation\.autoHide"/)
  assert.match(app, /:hidden-bar="playerBarPresentation\.hidden"/)
})

test('the mini shape drops cover and the standard inline progress row', () => {
  // Which controls a shape shows is the layout's business now, and mini's
  // default arrangement places neither the cover nor the track metadata.
  const miniDefaults = [
    ...DEFAULT_PLAYER_BAR_LAYOUT.mini.left,
    ...DEFAULT_PLAYER_BAR_LAYOUT.mini.center,
    ...DEFAULT_PLAYER_BAR_LAYOUT.mini.right
  ]
  for (const id of ['cover', 'trackInfo'] as const) {
    assert.equal(miniDefaults.includes(id), false, `mini must not default to ${id}`)
  }
  // Each control renders from its own branch, so an id the layout leaves out
  // produces no DOM at all rather than being hidden with CSS.
  assert.match(
    playerBar,
    /v-if="control === 'cover'"[\s\S]{0,200}class="player-cover-slot player-artwork-slot"/
  )
  assert.match(playerBar, /v-else-if="control === 'trackInfo'" class="player-track-info"/)
  // The inline progress row belongs to the standard shape alone: mini has its
  // long middle rail and compact its top-edge line.
  assert.match(
    playerBar,
    /v-if="region\.name === 'center' && isStandard"[\s\S]{0,200}class="progress-area"/
  )
  // Standard time labels live inside .progress-area, so gating that block removes them too.
  const progressBlock = playerBar.slice(playerBar.indexOf('class="progress-area"'))
  assert.match(progressBlock.slice(0, 600), /class="time-label"/)
  // A third metadata line has no room on a 40px strip, whoever places trackInfo.
  assert.match(
    playerBar,
    /v-if="streamNowPlaying && isLiveStream && !isMini"[\s\S]{0,80}class="player-stream-now-playing"/
  )
})

test('the mini shape keeps compact play/pause, utility controls and an exit', () => {
  assert.deepEqual(DEFAULT_PLAYER_BAR_LAYOUT.mini.left, ['playPause'])
  assert.deepEqual(DEFAULT_PLAYER_BAR_LAYOUT.mini.right, [
    'playMode',
    'volume',
    'queue',
    'hifi',
    'exitPlayingPage'
  ])
  assert.match(
    playerBar,
    /v-else-if="control === 'playPause'"[\s\S]{0,200}class="mini-play-button"/
  )
  assert.match(playerBar, /@click="togglePlay"/)
  assert.match(
    playerBar,
    /v-else-if="control === 'playMode'"[\s\S]{0,120}class="ctrl-btn mode-btn-right player-misc-icon"/
  )
  assert.match(
    playerBar,
    /v-else-if="control === 'queue'"[\s\S]{0,120}class="icon-btn track-menu-button"/
  )
  assert.match(
    playerBar,
    /v-else-if="control === 'volume'"[\s\S]{0,120}class="volume-anchor player-misc-icon"/
  )
  assert.match(
    playerBar,
    /v-else-if="control === 'hifi'"[\s\S]{0,120}class="icon-btn player-misc-icon hifi-toggle-button"/
  )
  // The exit only means anything while the now-playing page is open, so it stays
  // a runtime gate rather than something the layout can grant.
  assert.match(
    playerBar,
    /v-else-if="control === 'exitPlayingPage' && glass"[\s\S]{0,200}class="icon-btn playing-page-exit-button"/
  )
  assert.match(playerBar, /@click="emit\('exitPlayingPage'\)"/)
  assert.match(app, /@exit-playing-page="handleExitPlayingPage"/)
  assert.match(app, /function handleExitPlayingPage\(\): void \{[\s\S]{0,80}closePlayingPage\(\)/)
  // These stay in the standard bar's defaults and out of mini's.
  assert.deepEqual(DEFAULT_PLAYER_BAR_LAYOUT.standard.right, [
    'favorite',
    'playMode',
    'volume',
    'queue',
    'miniPlayer',
    'desktopLyrics',
    'hifi'
  ])
  assert.doesNotMatch(playerBar, /mini-lyrics-btn/)
})

test('the mini progress rail is always present and disables seeking for live streams', () => {
  assert.match(playerBar, /v-if="region\.name === 'center' && isMini" class="mini-progress-rail"/)
  assert.match(playerBar, /class="mini-progress-slider"[\s\S]{0,320}@input="onFlatRailInput"/)
  // The rail speaks in 0..1, so its pixel width never has to match the timeline.
  assert.match(playerBar, /min="0"[\s\S]{0,60}max="1"/)
  assert.match(
    playerBar,
    /resolveSeekTargetSeconds\(Number\(target\.value\), effectiveDuration\.value\)/
  )
  assert.match(playerBar, /:disabled="isLiveStream \|\| effectiveDuration <= 0"/)
  assert.match(playerBar, /aria-label="播放进度"/)
  assert.match(playerBar, /class="mini-progress-time"/)
})

test('mini geometry out-specifies the preset theme layouts without !important', () => {
  const geometry = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-mode='mini'\]\s*\.player-bar\.player-bar-mini\.player-bar-mini\.player-bar-mini\s*\{[^}]*\}/
  )
  assert.ok(geometry, 'mini geometry rule must repeat the class to beat the preset layouts')
  const [rule] = geometry
  assert.doesNotMatch(rule, /!important/)
  // Every preset layout rewrites at least these four; mini has to win them.
  for (const property of ['height', 'max-width', 'padding', 'grid-template-columns']) {
    assert.match(rule, new RegExp(`\\b${property}\\s*:`), `mini geometry must set ${property}`)
  }
  // The mini pill is intentionally long enough for an edge-to-edge progress rail.
  assert.match(rule, /max-width:\s*min\(1120px, 100%\)/)
  assert.match(rule, /height:\s*40px/)
  // No hairline on any side: on a 40px strip it reads as an outline drawn around
  // the bar rather than as its edge. The rounding carries the shape instead.
  assert.match(rule, /border:\s*0/)
  assert.match(rule, /border-radius:\s*16px/)
  // Play/pause stays left, the rail stretches in the middle, tools stay right.
  assert.match(rule, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/)
  // The strip must not clip: `.volume-drawer` is `bottom: 100%` *inside* the bar,
  // so a clipping strip cut the whole drawer away and the volume slider could
  // never be reached from the mini bar. Nothing here needs the clip — the
  // progress track clips its own fill, and no child reaches the rounded corners.
  // Read from the comment-stripped source: the rule explains in prose why it does
  // not clip, and that prose would satisfy a raw match on the declaration.
  const declarationsOnly = playerBarCssDeclarations.match(
    /\.player-bar-shell\[data-te-playbar-mode='mini'\]\s*\.player-bar\.player-bar-mini\.player-bar-mini\.player-bar-mini\s*\{[^}]*\}/
  )
  assert.ok(declarationsOnly)
  assert.doesNotMatch(declarationsOnly[0], /overflow:\s*hidden/)
})

test('mini keeps a visible outline only where the system palette takes over', () => {
  // Forced colors replaces the fill, so the strip would otherwise dissolve.
  assert.match(
    playerBarCss,
    /@media \(forced-colors: active\) \{\s*\.player-bar-shell\[data-te-playbar-mode='mini'\][\s\S]{0,180}border:\s*1px solid CanvasText/
  )
})

test('the mini shape opts out of the liquid glass material at the source', () => {
  // `.player-bar-liquid` claims background, border-color and the rim box-shadow
  // with `!important`, so a mini bar that kept the class could not win its own
  // surface back: it rendered as a transparent pane ringed by the rim highlight.
  // Compact is a flat strip for the same reason, so only standard wears it.
  assert.match(
    playerBar,
    /liquidGlassActive = computed\(\s*\(\)\s*=>\s*isStandard\.value\s*&&[\s\S]{0,160}liquidGlass\.playbarEnabled/
  )
  // Which also means neither strip mounts a refracting layer or runs pointer writes.
  assert.match(playerBar, /v-if="liquidGlassActive" class="player-bar-warp"/)
  assert.match(playerBar, /shouldTrack =\s*\n?\s*liquidGlassActive\.value/)
})

test('no preset theme layout can out-specify a shape rule on a property that shape sets', () => {
  const layoutDir = new URL('../../assets/theme-layouts/', import.meta.url)
  const themeRules = readdirSync(layoutDir)
    .filter((name) => name.endsWith('.css') && name !== 'index.css')
    .flatMap((name) =>
      parseRules(readFileSync(new URL(name, layoutDir), 'utf8')).map((rule) => ({ ...rule, name }))
    )
  assert.ok(themeRules.length > 100, 'theme layout parsing produced suspiciously few rules')

  const shapeMarkers =
    /player-bar-mini|mini-progress|player-bar-compact|compact-progress|player-time-readout/
  const shapeRules = parseRules(playerBarCss).filter(
    (rule) => shapeMarkers.test(rule.selector) && !rule.selector.includes('::')
  )
  assert.ok(shapeRules.length > 10, 'shape rule parsing produced suspiciously few rules')
  // Both shapes have to be in the sample, or one of them slips past this guard.
  for (const marker of ['player-bar-mini', 'player-bar-compact']) {
    assert.ok(
      shapeRules.some((rule) => rule.selector.includes(marker)),
      `no ${marker} rules were collected`
    )
  }

  // The shape's own marker class is what makes its rule win, so a theme rule
  // ending on it is not a competitor — every other shared subject class is.
  const ownMarkers = new Set(['player-bar-mini', 'player-bar-compact'])
  const collisions: string[] = []
  for (const shape of shapeRules) {
    const shapeSubject = subjectClasses(shape.selector)
    if (shapeSubject.size === 0) continue
    for (const theme of themeRules) {
      if (theme.selector.includes('::')) continue
      // Same subject element: the theme rule ends on a class the shape also ends on.
      const shared = [...shapeSubject].filter(
        (name) => subjectClasses(theme.selector).has(name) && !ownMarkers.has(name)
      )
      if (shared.length === 0) continue
      const contested = shape.properties.filter((property) => theme.properties.includes(property))
      if (contested.length === 0) continue
      if (compareSpecificity(theme.specificity, shape.specificity) < 0) continue
      collisions.push(
        `${contested.join(', ')}: shape (${shape.specificity}) "${shape.selector}" vs ` +
          `${theme.name} (${theme.specificity}) "${theme.selector}"`
      )
    }
  }
  assert.deepEqual(
    collisions,
    [],
    `preset layouts tie or beat a shape rule on properties it sets:\n${collisions.join('\n')}`
  )
})

test('the hidden state translates the bar away and stops swallowing pointer input', () => {
  const hidden = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-hidden='true'\][^{]*\{[^}]*\}/
  )
  assert.ok(hidden, 'a hidden-state rule must exist')
  assert.match(hidden[0], /transform:\s*translateY\(/)
  assert.match(hidden[0], /pointer-events:\s*none/)
  assert.match(hidden[0], /opacity:\s*0/)
  // Shape-agnostic: auto-hide resolves for every shape with its own progress
  // readout, and naming one shape here left the compact strip with the flag set
  // and nothing moving. The repeated class still beats the preset layouts.
  assert.doesNotMatch(hidden[0].split('{')[0], /player-bar-mini|player-bar-compact/)
  assert.match(hidden[0], /\.player-bar\.player-bar\.player-bar/)
  assert.doesNotMatch(hidden[0], /!important/)
})

test('fully hidden works on either shape and leaves the tab order', () => {
  const rule = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-visibility='hidden'\]\s+\.player-bar[^{]*\{[^}]*\}/
  )
  assert.ok(rule, 'a fully-hidden rule must exist')
  // Shape-agnostic: unlike auto-hide it must not require .player-bar-mini.
  assert.doesNotMatch(rule[0].split('{')[0], /player-bar-mini/)
  // Repeated class beats the preset theme layouts, same trick as mini geometry.
  assert.match(rule[0], /\.player-bar\.player-bar\.player-bar/)
  assert.doesNotMatch(rule[0], /!important/)
  // opacity alone still lets Tab reach invisible transport buttons.
  assert.match(rule[0], /visibility:\s*hidden/)
  assert.match(rule[0], /pointer-events:\s*none/)

  // The shell keeps its box for measurement but must not intercept clicks, in
  // the default layout and in the custom shell layout that re-asserts `auto`.
  assert.match(
    playerBarCss,
    /\.player-bar-shell\[data-te-playbar-visibility='hidden'\]\s*\{[^}]*pointer-events:\s*none/
  )
  assert.match(
    app,
    /data-te-shell-layout='custom'\][\s\S]{0,160}\[data-te-playbar-visibility='hidden'\]\s*\{[^}]*pointer-events:\s*none/
  )
})

test('the mini rail stays visible as a flat, long seeking target', () => {
  // The rail sits inside the centre region — every shape renders the three
  // region wrappers — so the region class stands where a direct child of
  // `.player-bar` used to, and still has to beat `.player-center`'s column flow.
  assert.match(
    playerBarCss,
    /\.player-bar\.player-bar-mini\s+\.player-center\s*>\s*\.mini-progress-rail\s*\{/
  )
  const rail = playerBarCss.match(
    /\.player-bar\.player-bar-mini\s+\.player-center\s*>\s*\.mini-progress-rail\s*\{[^}]*\}/
  )
  assert.ok(rail)
  assert.match(rail[0], /display:\s*flex/)
  assert.match(rail[0], /position:\s*relative/)
  assert.match(rail[0], /pointer-events:\s*auto/)
  assert.match(rail[0], /height:\s*100%/)
  assert.match(rail[0], /width:\s*100%/)
  assert.match(playerBarCss, /\.mini-progress-track\s*\{[^}]*height:\s*2px/)
  assert.match(playerBarCss, /\.mini-progress-fill\s*\{[^}]*background:\s*var\(--accent-color/)
  assert.match(playerBarCss, />\s*\.mini-play-button\s*\{[^}]*width:\s*26px/)
  // And the region has to be a row with full height, or the rail cannot stretch.
  const center = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-mode='mini'\]\s*\.player-bar-mini\.player-bar-mini\.player-bar-mini\s*\.player-center\s*\{[^}]*\}/
  )
  assert.ok(center, 'mini must turn the centre region into a full-height row')
  assert.match(center[0], /flex-direction:\s*row/)
  assert.match(center[0], /height:\s*100%/)
})

test('the flat strips share one surface language, declared in exactly one place', () => {
  // Mini and compact are both flat strips and deliberately look the same. The
  // shared block is what keeps them from drifting, and what keeps the colours no
  // theme token covers from being duplicated per shape.
  assert.match(
    playerBarCss,
    /\.player-bar\.player-bar-mini,\s*\.player-bar\.player-bar-compact\s*\{/
  )
  assert.match(
    playerBarCss,
    /--te-flat-bar-dark-lift:\s*color-mix\(in srgb, var\(--te-card-bg\) 95%, #fff 5%\)/
  )
  assert.match(playerBarCss, /--te-flat-bar-glass-bg:\s*#141722/)
  assert.match(playerBarCss, /--te-flat-bar-control:\s*rgba\(255, 255, 255, 0\.78\)/)
})

test('the dark main-window flat strips carry a fill they can be seen by', () => {
  // Without the hairline, a card colour that sits a step from the page
  // background (#181818 on #17181a) would leave the strip with no visible edge,
  // so the lifted fill is the whole separation — for both flat shapes.
  for (const shape of ['mini', 'compact']) {
    const rule = playerBarCss.match(
      new RegExp(
        `html\\[data-theme='dark'\\][^{]*\\.player-bar-${shape}\\.player-bar-${shape}\\.player-bar-${shape}:not\\(\\.player-bar-glass\\)\\s*\\{[^}]*\\}`
      )
    )
    assert.ok(rule, `${shape} needs a dark-theme fill`)
    assert.match(rule[0], /background:\s*var\(--te-flat-bar-dark-lift\)/)
  }
})

test('the playing-page flat strips stay dark even under the light app theme', () => {
  // PlayingMusic supplies `glass=true` even when the app theme is light, so each
  // strip needs the playing-page dark surface; otherwise the flat rule's card
  // token wins and turns the bar white. No border on either: the fill is what
  // separates the strip from the page.
  for (const shape of ['mini', 'compact']) {
    const rule = playerBarCss.match(
      new RegExp(
        `\\.player-bar-shell\\[data-te-playbar-mode='${shape}'\\][^{]*\\.player-bar\\.player-bar-glass\\.player-bar-${shape}\\.player-bar-${shape}\\.player-bar-${shape}\\s*\\{[^}]*\\}`
      )
    )
    assert.ok(rule, `playing-page ${shape} override must exist`)
    assert.match(rule[0], /background:\s*var\(--te-flat-bar-glass-bg\)/)
    assert.match(rule[0], /background-image:\s*none/)
    assert.doesNotMatch(rule[0], /border/)
  }
  // Controls on the dark strip read the shared control colour rather than their
  // own copy of it.
  assert.match(
    playerBarCss,
    /\.player-bar\.player-bar-glass\.player-bar-mini\.player-bar-mini\.player-bar-mini\s*\.player-right\s*\.icon-btn[^{]*\{[^}]*color:\s*var\(--te-flat-bar-control\)/
  )
})

/**
 * A conflict marker committed into a stylesheet is invisible to every other
 * guard here. postcss's selector parsing is permissive, so once comments are
 * stripped a stray `<<<<<<< HEAD` simply glues itself onto the next selector
 * and `compileStyle` still reports zero errors — while a real browser rejects
 * the selector and drops the whole rule. That is how the mini geometry block
 * (height, padding, and the transform transition the reveal animates on) went
 * missing after a merge while every test stayed green.
 */
test('stylesheets carry no merge conflict markers and no rule with a garbled selector', () => {
  const styleRoots = [
    new URL('./', import.meta.url),
    new URL('../', import.meta.url),
    new URL('../../assets/', import.meta.url),
    new URL('../../assets/theme-layouts/', import.meta.url)
  ]

  const sheets: { name: string; source: string }[] = []
  for (const root of styleRoots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.css')) continue
      sheets.push({
        name: entry.name,
        source: readFileSync(new URL(entry.name, root), 'utf8')
      })
    }
  }
  // A silent zero-file glob would make this test vacuously pass.
  assert.ok(sheets.length >= 2, `expected to find stylesheets, found ${sheets.length}`)

  for (const sheet of sheets) {
    for (const marker of ['<<<<<<<', '=======', '>>>>>>>']) {
      const lines = sheet.source
        .split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.startsWith(marker))
      assert.equal(
        lines.length,
        0,
        `${sheet.name} has a merge conflict marker at line ${lines[0]?.number}: ${lines[0]?.line}`
      )
    }

    // Catch the same damage from any other cause: a selector may only hold the
    // characters these stylesheets legitimately use.
    for (const rule of parseRules(sheet.source)) {
      assert.ok(
        /^[\w\s.#:[\]='"()>+~*,^$|/-]+$/.test(rule.selector),
        `${sheet.name} has an unparseable selector: ${rule.selector.slice(0, 120)}`
      )
    }
  }
})

test('mini CSS compiles under scoped mode without leaking rules onto ancestors', () => {
  const result = compileStyle({
    source: playerBarCss,
    filename: 'PlayerBar.css',
    id: 'data-v-mini-playbar',
    scoped: true
  })
  assert.deepEqual(result.errors, [])
  // Every mini rule must survive scoping with its descendants intact.
  assert.match(result.code, /\.mini-progress-rail\[data-v-mini-playbar\]/)
  assert.match(result.code, /\.mini-progress-slider\[data-v-mini-playbar\]/)
  assert.match(
    result.code,
    /html\[data-theme=['"]dark['"]\][^{]*\.mini-progress-track\[data-v-mini-playbar\]/
  )
})
