import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeLyricLayout,
  isLyricLineInSight,
  LYRIC_BLUR_MAX,
  LYRIC_CASCADE_BASE_DELAY,
  LYRIC_CASCADE_MAX_DELAY,
  LYRIC_OPACITY_FUTURE,
  LYRIC_OPACITY_HIDDEN,
  LYRIC_OPACITY_NON_DYNAMIC,
  LYRIC_OPACITY_PAST,
  LYRIC_OPACITY_PRESENTED,
  LYRIC_OPACITY_SINGING,
  LYRIC_SCALE_ACTIVE,
  LYRIC_SCALE_BACKGROUND,
  LYRIC_SCALE_INACTIVE,
  LYRIC_SCALE_PRESENTED,
  type LyricLayoutLine
} from './lyricLineLayout.ts'

const ROW_HEIGHT = 60

function rows(count: number, overrides: Record<number, Partial<LyricLayoutLine>> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    height: ROW_HEIGHT,
    ...overrides[index]
  }))
}

function layout(count: number, scrollToIndex: number, buffered: number[], extra = {}) {
  return computeLyricLayout({
    lines: rows(count),
    scrollToIndex,
    buffered: new Set(buffered),
    viewportHeight: 600,
    ...extra
  })
}

test('the cascade tightens downward and caps its total delay', () => {
  const result = layout(6, 0, [0])
  const delays = result.lines.map((line) => line.delay)

  assert.equal(delays[0], 0, 'the anchor itself must not wait')
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(delays[index] >= delays[index - 1], `line ${index} must not leave earlier`)
  }

  const steps = delays.slice(1).map((delay, index) => delay - delays[index])
  assert.ok(Math.abs(steps[0] - LYRIC_CASCADE_BASE_DELAY) < 1e-9)
  assert.ok(
    delays.every((delay) => delay <= LYRIC_CASCADE_MAX_DELAY),
    'long lyric lists must not accumulate an unbounded departure delay'
  )
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(steps[index] <= steps[index - 1], `step ${index} should be no wider`)
  }
})

test('a long backlog above the viewport does not spend the delay budget', () => {
  const result = computeLyricLayout({
    lines: rows(40),
    scrollToIndex: 30,
    buffered: new Set([30]),
    viewportHeight: 600
  })

  assert.equal(result.lines[0].delay, 0)
  assert.equal(result.lines[20].delay, 0, 'far off-screen lines must contribute nothing')
  assert.ok(result.lines[30].delay > 0, 'the visible approach still receives a cascade')
  assert.ok(
    result.lines[31].delay >= result.lines[30].delay,
    'the wave cannot reverse after reaching its cap'
  )
})

test('seeking suppresses the cascade so a scrub lands at once', () => {
  const result = layout(6, 0, [0], { isSeeking: true })
  assert.deepEqual(
    result.lines.map((line) => line.delay),
    [0, 0, 0, 0, 0, 0]
  )
})

test('the anchor sits above centre and honours the align mode', () => {
  // alignPosition 0.35 of 600 = 210, minus half a row = 180.
  const centered = layout(6, 2, [2])
  assert.equal(centered.lines[2].top, 180)

  const top = layout(6, 2, [2], { alignAnchor: 'top' })
  assert.equal(top.lines[2].top, 210)

  const bottom = layout(6, 2, [2], { alignAnchor: 'bottom' })
  assert.equal(bottom.lines[2].top, 150)
})

test('reserved bottom space shrinks the area the anchor is measured against', () => {
  // Visible height becomes 600 - 200 = 400; 0.35 of that is 140, minus 30.
  const result = layout(6, 2, [2], { bottomReservedPx: 200 })
  assert.equal(result.lines[2].top, 110)
})

test('singing, held, past and future lines have distinct visual weight', () => {
  const result = layout(6, 2, [1, 2], { hot: new Set([2]) })

  assert.equal(result.lines[2].scale, LYRIC_SCALE_ACTIVE)
  assert.equal(result.lines[2].opacity, LYRIC_OPACITY_SINGING)
  assert.equal(result.lines[1].scale, LYRIC_SCALE_PRESENTED)
  assert.equal(result.lines[1].opacity, LYRIC_OPACITY_PRESENTED)
  assert.equal(result.lines[0].scale, LYRIC_SCALE_INACTIVE)
  assert.equal(result.lines[0].opacity, LYRIC_OPACITY_PAST)
  assert.equal(result.lines[3].scale, LYRIC_SCALE_INACTIVE)
  assert.equal(result.lines[3].opacity, LYRIC_OPACITY_FUTURE)

  const flat = layout(6, 2, [2], { enableScale: false })
  assert.equal(flat.lines[2].scale, LYRIC_SCALE_INACTIVE, 'scaling off keeps every line at 100')

  const paused = layout(6, 2, [2], { isPlaying: false })
  assert.equal(paused.lines[3].scale, LYRIC_SCALE_INACTIVE, 'paused lyrics stay at natural size')
})

test('blur grows with index distance and caps', () => {
  const result = layout(6, 2, [2])
  assert.equal(result.lines[2].blur, 0, 'the presented line is never blurred')
  assert.ok(result.lines[3].blur > 0)
  assert.ok(result.lines[4].blur > result.lines[3].blur, 'further lines blur more')
  // Asymmetric on purpose: a line already sung recedes faster than an equally
  // distant line still to come.
  assert.ok(
    result.lines[1].blur > result.lines[3].blur,
    'history should blur harder than the approach'
  )

  const far = computeLyricLayout({
    lines: rows(80),
    scrollToIndex: 0,
    buffered: new Set([0]),
    viewportHeight: 600
  })
  assert.equal(far.lines[79].blur, LYRIC_BLUR_MAX, 'blur must not run away')

  const off = layout(6, 2, [2], { enableBlur: false })
  assert.equal(off.lines[5].blur, 0)
})

test('a narrow viewport softens the blur', () => {
  const wide = layout(6, 0, [0], { viewportWidth: 1440 })
  const narrow = layout(6, 0, [0], { viewportWidth: 900 })
  assert.ok(narrow.lines[3].blur < wide.lines[3].blur)
})

test('the singing line is the unique brightness focus', () => {
  const result = layout(6, 2, [2])
  assert.equal(result.lines[2].opacity, LYRIC_OPACITY_SINGING)
  assert.equal(result.lines[1].opacity, LYRIC_OPACITY_PAST)
  assert.equal(result.lines[4].opacity, LYRIC_OPACITY_FUTURE)
  assert.ok(result.lines[2].opacity > result.lines[1].opacity)
  assert.ok(result.lines[1].opacity > result.lines[4].opacity)
})

test('line-only lyrics dim the inactive lines instead', () => {
  const result = layout(6, 2, [2], { isNonDynamic: true })
  assert.equal(result.lines[4].opacity, LYRIC_OPACITY_NON_DYNAMIC)
})

test('hiding passed lines keeps them barely non-transparent', () => {
  const result = layout(6, 3, [3], { hidePassedLines: true })
  assert.equal(result.lines[0].opacity, LYRIC_OPACITY_HIDDEN)
  assert.notEqual(result.lines[0].opacity, 0, 'zero opacity gets optimised out and pops back')
  assert.equal(result.lines[4].opacity, LYRIC_OPACITY_FUTURE)

  const playing = layout(6, 3, [3], { hidePassedLines: true, isPlaying: false })
  assert.notEqual(playing.lines[0].opacity, LYRIC_OPACITY_HIDDEN, 'paused keeps history visible')
})

test('background voices collapse while playing and expand when paused', () => {
  const withBg = computeLyricLayout({
    lines: rows(4, { 1: { isBackground: true } }),
    scrollToIndex: 2,
    buffered: new Set([2]),
    viewportHeight: 600
  })
  // Collapsing removes the row from both the backlog above and the running
  // position, so the anchor itself does not move. What changes is that the
  // background line stops occupying a row and folds onto its main line.
  assert.equal(withBg.lines[1].scale, LYRIC_SCALE_BACKGROUND)
  assert.equal(withBg.lines[1].top, withBg.lines[2].top, 'a collapsed voice folds onto its line')

  const paused = computeLyricLayout({
    lines: rows(4, { 1: { isBackground: true } }),
    scrollToIndex: 2,
    buffered: new Set([2]),
    viewportHeight: 600,
    isPlaying: false
  })
  assert.equal(paused.lines[2].top, withBg.lines[2].top, 'the anchor holds either way')
  assert.equal(
    paused.lines[2].top - paused.lines[1].top,
    ROW_HEIGHT,
    'a paused background line occupies its own row'
  )
})

test('interlude dots take their own space after the anchor', () => {
  const result = layout(6, 2, [], { interludeAfterIndex: 2, interludeDotsHeight: 20 })
  assert.equal(result.interludeDotsTop, 250, 'dots sit just below the anchor row')
  assert.equal(result.lines[3].top, 300, 'the following line is pushed down past the dots')

  const none = layout(6, 2, [])
  assert.equal(none.interludeDotsTop, null)
})

test('a lead-in interlude places its dots before the first line', () => {
  const result = computeLyricLayout({
    lines: rows(3),
    scrollToIndex: 0,
    buffered: new Set(),
    viewportHeight: 600,
    interludeAfterIndex: -2,
    interludeDotsHeight: 20
  })
  assert.equal(result.interludeDotsTop, 190)
  assert.equal(result.lines[0].top, 240)
})

test('an overlapping pair keeps both lines unblurred and full size', () => {
  const result = layout(6, 1, [1, 2])
  assert.equal(result.lines[1].blur, 0)
  assert.equal(result.lines[2].blur, 0)
  assert.equal(result.lines[1].scale, LYRIC_SCALE_ACTIVE)
  assert.equal(result.lines[2].scale, LYRIC_SCALE_ACTIVE)
  assert.ok(result.lines[1].presented && result.lines[2].presented)
})

test('the scroll boundary spans the backlog above and the content below', () => {
  const result = layout(6, 2, [2])
  assert.equal(result.scrollBoundary[0], -120, 'you may browse back up over two rows')
  assert.ok(result.scrollBoundary[1] > result.scrollBoundary[0])
  assert.equal(result.contentBottom, result.lines[5].top + ROW_HEIGHT)
})

test('an out-of-range anchor is clamped for geometry and classification alike', () => {
  const high = layout(6, 99, [5])
  assert.equal(high.lines[5].top, 180, 'the last line becomes the anchor')
  assert.equal(high.lines[5].blur, 0, 'and is classified as the anchor, not blurred')

  const low = layout(6, -5, [0])
  assert.equal(low.lines[0].top, 180)
  assert.equal(low.lines[0].blur, 0)
})

test('with nothing presented every line softens, which is what an interlude looks like', () => {
  const result = layout(6, 2, [])
  assert.ok(
    result.lines.every((line) => line.blur > 0),
    'no presented line means no line is in focus'
  )
})

test('an empty list produces no targets and does not throw', () => {
  const result = computeLyricLayout({
    lines: [],
    scrollToIndex: 0,
    buffered: new Set(),
    viewportHeight: 600
  })
  assert.deepEqual(result.lines, [])
  assert.equal(result.interludeDotsTop, null)
})

test('the appearance multipliers at their defaults reproduce the built-in look exactly', () => {
  const plain = layout(6, 2, [2])
  const explicit = layout(6, 2, [2], {
    inactiveDim: 1,
    scaleIntensity: 1,
    blurIntensity: 1,
    cascadeSpeedFactor: 1,
    focusWindow: null
  })
  assert.deepEqual(explicit.lines, plain.lines, 'neutral multipliers must not shift a single value')
  assert.equal(plain.lines[0].scale, LYRIC_SCALE_INACTIVE)
})

test('the inactive dim only touches lines that have not been presented', () => {
  const result = layout(6, 2, [0, 1, 2], { inactiveDim: 0.4, isPlaying: true })

  assert.equal(result.lines[0].opacity, LYRIC_OPACITY_SINGING, 'hot lines keep full weight')
  assert.equal(result.lines[2].opacity, LYRIC_OPACITY_SINGING)
  assert.ok(
    Math.abs(result.lines[4].opacity - LYRIC_OPACITY_FUTURE * 0.4) < 1e-9,
    'upcoming lines carry the dim'
  )
})

test('a zero intensity flattens scale and blur without disturbing position', () => {
  const flat = layout(6, 2, [2], { scaleIntensity: 0, blurIntensity: 0, isPlaying: true })
  const plain = layout(6, 2, [2], { isPlaying: true })

  assert.ok(
    flat.lines.every(
      (line) => line.scale === LYRIC_SCALE_INACTIVE || line.scale === LYRIC_SCALE_BACKGROUND
    ),
    'no line should shrink'
  )
  assert.ok(flat.lines.every((line) => line.blur === 0))
  assert.deepEqual(
    flat.lines.map((line) => line.top),
    plain.lines.map((line) => line.top),
    'visual intensity must not move the rows'
  )
})

test('the cascade factor scales the wave without reordering it', () => {
  const fast = layout(6, 0, [0], { cascadeSpeedFactor: 0.5 })
  const base = layout(6, 0, [0])

  assert.equal(fast.lines[0].delay, 0)
  assert.ok(Math.abs(fast.lines[1].delay - base.lines[1].delay / 2) < 1e-9)
  for (let index = 1; index < fast.lines.length; index += 1) {
    assert.ok(fast.lines[index].delay >= fast.lines[index - 1].delay)
  }
})

test('the focus window collapses outsiders instead of leaving holes behind them', () => {
  const focusWindow = new Set([1, 2, 3])
  const result = layout(6, 2, [2], { focusWindow, isPlaying: true })

  assert.equal(result.lines[0].opacity, LYRIC_OPACITY_HIDDEN)
  assert.equal(result.lines[5].opacity, LYRIC_OPACITY_HIDDEN)

  // The three survivors must stay adjacent — a collapsed line contributes no height.
  assert.equal(result.lines[2].top - result.lines[1].top, ROW_HEIGHT)
  assert.equal(result.lines[3].top - result.lines[2].top, ROW_HEIGHT)
  assert.equal(result.lines[1].top, result.lines[0].top, 'the hidden line above takes no space')

  // Collapsing lines above the anchor drops them from `stackedAbove` and from the
  // running position by the same amount, so the focused line must not budge.
  const anchored = layout(6, 2, [2], { isPlaying: true })
  assert.equal(result.lines[2].top, anchored.lines[2].top, 'the anchor holds its mark')
})

test('the focus window yields while paused so the full lyric stays browsable', () => {
  const focusWindow = new Set([2])
  const paused = layout(6, 2, [2], { focusWindow, isPlaying: false })
  const open = layout(6, 2, [2], { isPlaying: false })

  assert.deepEqual(paused.lines, open.lines)
})

test('in-sight culling keeps a line of slack on both edges', () => {
  assert.ok(isLyricLineInSight(0, 60, 600))
  assert.ok(isLyricLineInSight(-60, 60, 600), 'just above the top edge still renders')
  assert.ok(isLyricLineInSight(650, 60, 600), 'just below the bottom edge still renders')
  assert.ok(!isLyricLineInSight(-200, 60, 600))
  assert.ok(!isLyricLineInSight(900, 60, 600))
})
