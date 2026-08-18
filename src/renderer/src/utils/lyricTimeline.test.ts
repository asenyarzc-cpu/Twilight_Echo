import assert from 'node:assert/strict'
import test from 'node:test'
import type { LyricLine } from './lyrics.ts'
import {
  advanceLyricPlayhead,
  buildLyricTimeline,
  createLyricPlayheadState,
  findLyricInterlude,
  isDisplayableInterlude,
  isNonDynamicTimeline,
  LYRIC_INTERLUDE_BEFORE_FIRST,
  LYRIC_TRAILING_LINE_SECONDS,
  type LyricPlayheadState
} from './lyricTimeline.ts'

function line(partial: Partial<LyricLine> & { time: number | null }): LyricLine {
  return {
    text: partial.text ?? 'line',
    translation: null,
    romanization: null,
    timed: partial.timed ?? partial.time != null,
    words: partial.words,
    voices: partial.voices,
    rowKey: partial.rowKey,
    time: partial.time
  }
}

/** 0-2s, 5-7s, 20-22s: a short gap then a long one. */
const LINES: LyricLine[] = [
  line({
    time: 0,
    words: [
      { text: 'a', time: 0, endTime: 1 },
      { text: 'b', time: 1, endTime: 2 }
    ]
  }),
  line({ time: 5, words: [{ text: 'c', time: 5, endTime: 7 }] }),
  line({ time: 20, words: [{ text: 'd', time: 20, endTime: 22 }] })
]

function stateAt(hot: number[], buffered: number[], scrollToIndex: number): LyricPlayheadState {
  return { hot: new Set(hot), buffered: new Set(buffered), scrollToIndex }
}

test('line ends come from word timing, the next line, then a trailing fallback', () => {
  const timeline = buildLyricTimeline(LINES)
  assert.equal(timeline[0].endTime, 2, 'word end wins over the next line start')
  assert.equal(timeline[1].endTime, 7)
  assert.equal(timeline[2].endTime, 22)

  const wordless = buildLyricTimeline([line({ time: 3 }), line({ time: 9 })])
  assert.equal(wordless[0].endTime, 9, 'without words, the next line start is the end')
  assert.equal(
    wordless[1].endTime,
    9 + LYRIC_TRAILING_LINE_SECONDS,
    'a trailing line gets the fallback span'
  )
})

test('a held tail keeps its line hot into the next one, producing the hand-off', () => {
  const timeline = buildLyricTimeline([
    line({ time: 0, words: [{ text: 'held', time: 0, endTime: 8 }] }),
    line({ time: 5, words: [{ text: 'next', time: 5, endTime: 9 }] })
  ])
  assert.equal(timeline[0].endTime, 8, 'the tail is not truncated at its successor')

  const overlap = advanceLyricPlayhead(timeline, createLyricPlayheadState(), 6)
  assert.deepEqual([...overlap.hot].sort(), [0, 1], 'both lines sing during the overlap')
  assert.equal(overlap.scrollToIndex, 0, 'the anchor waits for the finishing line')
})

test('untimed lines are marked and never become hot', () => {
  const timeline = buildLyricTimeline([
    line({ time: 0, words: [{ text: 'a', time: 0, endTime: 2 }] }),
    line({ time: null, timed: false, text: 'plain' }),
    line({ time: 5 })
  ])
  assert.equal(timeline[1].timed, false)
  assert.equal(timeline[1].endTime, null)

  for (const time of [0, 1, 3, 5, 9]) {
    const next = advanceLyricPlayhead(timeline, createLyricPlayheadState(), time)
    assert.ok(!next.hot.has(1), `untimed line went hot at ${time}s`)
  }
})

test('a new hot line enters the presented set and moves the anchor', () => {
  const timeline = buildLyricTimeline(LINES)
  const next = advanceLyricPlayhead(timeline, createLyricPlayheadState(), 1)

  assert.deepEqual([...next.hot], [0])
  assert.deepEqual([...next.buffered], [0])
  assert.deepEqual([...next.added], [0])
  assert.equal(next.scrollToIndex, 0)

  const second = advanceLyricPlayhead(timeline, next, 6)
  assert.deepEqual([...second.buffered], [1])
  assert.equal(second.scrollToIndex, 1)
  assert.ok(second.anchorChanged)
})

test('the presented set releases only when the whole set goes cold at once', () => {
  const timeline = buildLyricTimeline(LINES)
  const presented = advanceLyricPlayhead(timeline, createLyricPlayheadState(), 1)

  // 3s sits in the gap: line 0 is cold and nothing replaced it.
  const released = advanceLyricPlayhead(timeline, presented, 3)
  assert.equal(released.hot.size, 0)
  assert.equal(released.buffered.size, 0, 'a fully cold set is released')
  assert.equal(released.scrollToIndex, 0, 'the anchor holds through the gap')
})

test('a partial drop holds both the presented set and the anchor', () => {
  // Overlapping spans, as held tails and duet voices produce.
  const timeline = buildLyricTimeline([
    line({ time: 0, words: [{ text: 'a', time: 0, endTime: 5 }] }),
    line({ time: 3, words: [{ text: 'b', time: 3, endTime: 8 }] })
  ])
  assert.equal(timeline[0].endTime, 5, 'the overlap must survive timeline construction')

  const both = advanceLyricPlayhead(timeline, createLyricPlayheadState(), 4)
  assert.deepEqual([...both.buffered].sort(), [0, 1])

  const partial = advanceLyricPlayhead(timeline, both, 6)
  assert.deepEqual([...partial.hot], [1])
  assert.deepEqual(
    [...partial.buffered].sort(),
    [0, 1],
    'the cold half stays presented while its neighbour sings'
  )
  assert.equal(partial.scrollToIndex, 0, 'hysteresis keeps the anchor from jumping mid-phrase')
})

test('seeking collapses the hysteresis and anchors immediately', () => {
  const timeline = buildLyricTimeline(LINES)
  const stale = stateAt([0], [0], 0)

  const seeked = advanceLyricPlayhead(timeline, stale, 6, true)
  assert.deepEqual([...seeked.buffered], [1])
  assert.equal(seeked.scrollToIndex, 1)
  assert.ok(seeked.anchorChanged)
})

test('seeking into a gap anchors forward to the upcoming line', () => {
  const timeline = buildLyricTimeline(LINES)
  const seeked = advanceLyricPlayhead(timeline, stateAt([0], [0], 0), 10, true)

  assert.equal(seeked.hot.size, 0)
  assert.equal(seeked.buffered.size, 0)
  assert.equal(seeked.scrollToIndex, 2, 'the view should wait on the next line, not a stale one')
})

test('seeking past the last line clamps to it', () => {
  const timeline = buildLyricTimeline(LINES)
  const seeked = advanceLyricPlayhead(timeline, createLyricPlayheadState(), 999, true)
  assert.equal(seeked.scrollToIndex, 2)
})

test('a long gap is a displayable interlude, a short one is not', () => {
  const timeline = buildLyricTimeline(LINES)

  // 2s -> 5s is only a 3s gap.
  const shortGap = findLyricInterlude(timeline, stateAt([], [], 0), 3)
  assert.ok(shortGap)
  assert.equal(shortGap.afterIndex, 0)
  assert.ok(!isDisplayableInterlude(shortGap), '3s should not show interlude dots')

  // 7s -> 20s is a 13s gap.
  const longGap = findLyricInterlude(timeline, stateAt([], [], 1), 10)
  assert.ok(longGap)
  assert.equal(longGap.afterIndex, 1)
  assert.equal(longGap.end, 20)
  assert.ok(isDisplayableInterlude(longGap))
})

test('the lead-in before the first line is its own interlude', () => {
  const timeline = buildLyricTimeline([line({ time: 10, words: [] })])
  const interlude = findLyricInterlude(timeline, createLyricPlayheadState(), 2)

  assert.ok(interlude)
  assert.equal(interlude.afterIndex, LYRIC_INTERLUDE_BEFORE_FIRST)
  assert.equal(interlude.end, 9.75, 'the dots clear before the line arrives')
  assert.ok(isDisplayableInterlude(interlude))
})

test('nothing is an interlude while a line is still presented', () => {
  const timeline = buildLyricTimeline(LINES)
  assert.equal(findLyricInterlude(timeline, stateAt([], [0], 0), 3), null)
  assert.equal(isDisplayableInterlude(null), false)
})

test('voice word timings extend a grouped duet and make it dynamic', () => {
  const grouped = line({
    time: 10,
    text: 'lead',
    voices: [
      {
        voiceKey: 'lead',
        role: 'lead',
        lane: 'start',
        time: 10,
        text: 'lead',
        words: [
          { text: 'le', time: 10, endTime: 10.5 },
          { text: 'ad', time: 10.5, endTime: 11 }
        ]
      },
      {
        voiceKey: 'harmony',
        role: 'harmony',
        lane: 'end',
        time: 10.5,
        text: 'held harmony',
        words: [{ text: 'held harmony', time: 10.5, endTime: 13 }]
      }
    ]
  })
  const timeline = buildLyricTimeline([grouped, line({ time: 12 })])
  assert.equal(timeline[0].endTime, 13, 'the harmony tail must not be cut at the next row')
  assert.ok(!isNonDynamicTimeline([grouped]))
  const hot = advanceLyricPlayhead(timeline, createLyricPlayheadState(), 12.5).hot
  assert.ok(hot.has(0), 'the grouped harmony must still be singing at 12.5s')
  assert.ok(hot.has(1), 'the following line may sing at the same time')
})

test('line-only lyrics are reported as non-dynamic', () => {
  assert.ok(isNonDynamicTimeline([line({ time: 0 }), line({ time: 5 })]))
  assert.ok(isNonDynamicTimeline([line({ time: 0, words: [{ text: 'a', time: 0, endTime: 1 }] })]))
  assert.ok(!isNonDynamicTimeline(LINES), 'word-level timing makes a timeline dynamic')
})

test('an empty timeline is inert', () => {
  assert.deepEqual(buildLyricTimeline([]), [])
  const next = advanceLyricPlayhead([], createLyricPlayheadState(), 5)
  assert.equal(next.hot.size, 0)
  assert.equal(findLyricInterlude([], createLyricPlayheadState(), 5), null)
})
