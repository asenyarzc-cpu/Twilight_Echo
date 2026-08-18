import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { compileStyle } from '@vue/compiler-sfc'

// Normalize line endings: these structural assertions use fixed-width windows
// (e.g. {0,320}) so a CRLF checkout would silently widen every gap and break
// them even though the attribute order is unchanged.
const playerBar = readFileSync(new URL('../PlayerBar.vue', import.meta.url), 'utf8').replaceAll(
  '\r\n',
  '\n'
)
const playerBarCss = readFileSync(new URL('./PlayerBar.css', import.meta.url), 'utf8').replaceAll(
  '\r\n',
  '\n'
)
const app = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8').replaceAll('\r\n', '\n')

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

test('the mini shape drops the cover, the inline progress row and the time labels', () => {
  for (const marker of [
    /v-if="!isMini"[\s\S]{0,120}class="player-cover-slot player-artwork-slot"/,
    /v-if="!isMini"[\s\S]{0,200}class="progress-area"/,
    /v-if="streamNowPlaying && isLiveStream && !isMini"[\s\S]{0,80}class="player-stream-now-playing"/
  ]) {
    assert.match(playerBar, marker)
  }
  // Time labels live inside .progress-area, so gating that block removes them too.
  const progressBlock = playerBar.slice(playerBar.indexOf('class="progress-area"'))
  assert.match(progressBlock.slice(0, 600), /class="time-label"/)
})

test('the mini shape keeps transport, favourite, mode, volume, queue and the HiFi console', () => {
  for (const marker of ['btn-play', 'player-controls', 'player-right', 'hifi']) {
    assert.ok(
      playerBar.toLowerCase().includes(marker.toLowerCase()),
      `${marker} must survive in the mini shape`
    )
  }
  // The mini-player window button only makes sense on a wide bar and stays
  // reachable from the HiFi panel; desktop lyrics stays on the bar in both shapes.
  assert.match(playerBar, /v-if="!isMini"[\s\S]{0,200}class="icon-btn mini-player-btn/)
  assert.match(playerBar, /class="icon-btn desktop-lyrics-btn player-misc-icon"/)
})

test('the mini shape gets a dedicated lyrics-page toggle wired to App', () => {
  // The button is mini-only and reflects the open lyrics page.
  assert.match(
    playerBar,
    /v-if="isMini"[\s\S]{0,160}class="icon-btn mini-lyrics-btn player-misc-icon"/
  )
  assert.match(playerBar, /:class="{ active: playingPageOpen }"/)
  assert.match(playerBar, /:title="playingPageOpen \? '退出歌词页' : '进入歌词页'"/)
  assert.match(playerBar, /@click="onToggleLyricsPage"/)
  // Distinct from the desktop-lyrics 词 glyph: the page toggle uses ph-text-aa.
  assert.match(
    playerBar,
    /class="icon-btn mini-lyrics-btn player-misc-icon"[\s\S]{0,400}ph ph-text-aa/
  )
  assert.match(
    playerBar,
    /emit\('toggleLyricsPage', \{ x: r\.left, y: r\.top, w: r\.width, h: r\.height \}\)/
  )
  // App owns the open/close decision and tells the bar which state to show.
  assert.match(app, /:playing-page-open="showPlayingPage"/)
  assert.match(app, /@toggle-lyrics-page="handleToggleLyricsPage"/)
})

test('the border rail carries seeking and is skipped for unseekable streams', () => {
  assert.match(playerBar, /v-if="isMini && !isLiveStream"[\s\S]{0,40}class="mini-progress-rail"/)
  assert.match(playerBar, /class="mini-progress-slider"[\s\S]{0,320}@input="onMiniRailInput"/)
  // The rail speaks in 0..1, so its pixel width never has to match the timeline.
  assert.match(playerBar, /min="0"[\s\S]{0,60}max="1"/)
  assert.match(
    playerBar,
    /resolveSeekTargetSeconds\(Number\(target\.value\), effectiveDuration\.value\)/
  )
  assert.match(playerBar, /:disabled="effectiveDuration <= 0"/)
  assert.match(playerBar, /aria-label="播放进度"/)
})

test('mini geometry out-specifies the preset theme layouts without !important', () => {
  const geometry = playerBarCss.match(
    /\.player-bar-shell\[data-te-playbar-mode='mini'\]\s*\.player-bar\.player-bar-mini\.player-bar-mini\.player-bar-mini\s*\{[^}]*\}/
  )
  assert.ok(geometry, 'mini geometry rule must repeat the class to beat the preset layouts')
  const [rule] = geometry
  assert.doesNotMatch(rule, /!important/)
  // aurora-reference rewrites exactly these four; mini has to win all of them.
  for (const property of ['height', 'max-width', 'padding', 'grid-template-columns']) {
    assert.match(rule, new RegExp(`\\b${property}\\s*:`), `mini geometry must set ${property}`)
  }
  // The mini pill is intentionally longer than the old compact 560px width.
  assert.match(rule, /max-width:\s*min\(960px, 100%\)/)
  // Equal side columns put the transport dead-centre in the mini pill.
  assert.match(rule, /grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/)
})

test('no preset theme layout can out-specify a mini rule on a property mini sets', () => {
  const layoutDir = new URL('../../assets/theme-layouts/', import.meta.url)
  const themeRules = readdirSync(layoutDir)
    .filter((name) => name.endsWith('.css') && name !== 'index.css')
    .flatMap((name) =>
      parseRules(readFileSync(new URL(name, layoutDir), 'utf8')).map((rule) => ({ ...rule, name }))
    )
  assert.ok(themeRules.length > 100, 'theme layout parsing produced suspiciously few rules')

  const miniRules = parseRules(playerBarCss).filter(
    (rule) => /player-bar-mini|mini-progress/.test(rule.selector) && !rule.selector.includes('::')
  )
  assert.ok(miniRules.length > 10, 'mini rule parsing produced suspiciously few rules')

  const collisions: string[] = []
  for (const mini of miniRules) {
    const miniSubject = subjectClasses(mini.selector)
    if (miniSubject.size === 0) continue
    for (const theme of themeRules) {
      if (theme.selector.includes('::')) continue
      // Same subject element: the theme rule ends on a class mini also ends on.
      const shared = [...miniSubject].filter(
        (name) => subjectClasses(theme.selector).has(name) && name !== 'player-bar-mini'
      )
      if (shared.length === 0) continue
      const contested = mini.properties.filter((property) => theme.properties.includes(property))
      if (contested.length === 0) continue
      if (compareSpecificity(theme.specificity, mini.specificity) < 0) continue
      collisions.push(
        `${contested.join(', ')}: mini (${mini.specificity}) "${mini.selector}" vs ` +
          `${theme.name} (${theme.specificity}) "${theme.selector}"`
      )
    }
  }
  assert.deepEqual(
    collisions,
    [],
    `preset layouts tie or beat mini on properties mini sets:\n${collisions.join('\n')}`
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

test('the mini rail is hidden by default but keeps its liquid-glass override', () => {
  // `.player-bar-liquid > *:not(.player-bar-warp)` forces position: relative, which
  // would knock an absolutely positioned rail off the bottom border if a future
  // option re-enables it.
  assert.match(playerBarCss, /\.player-bar\.player-bar-mini\s*>\s*\.mini-progress-rail\s*\{/)
  const rail = playerBarCss.match(
    /\.player-bar\.player-bar-mini\s*>\s*\.mini-progress-rail\s*\{[^}]*\}/
  )
  assert.ok(rail)
  // The mini style is progress-free: the rail is hidden entirely.
  assert.match(rail[0], /display:\s*none/)
  // The geometry stays behind, so re-enabling is a one-line CSS flip.
  assert.match(rail[0], /position:\s*absolute/)
  assert.match(rail[0], /pointer-events:\s*auto/)
  assert.match(rail[0], /height:\s*14px/)
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
