import type { LyricLine } from './lyrics.ts'
import { resolveLyricWordTimings } from './lyricWordChunks.ts'

/**
 * Apple Music does not simply highlight "the line whose time has come". It keeps
 * two sets:
 *
 * - **hot**: lines whose span strictly contains the playhead.
 * - **buffered**: lines that stay presented after going cold, released only when
 *   *all* of them would drop at once and nothing new arrived.
 *
 * That hysteresis is why the view does not flicker between two overlapping lines
 * and why the anchor holds still during a short gap. Reproducing the feel
 * requires reproducing the set transitions, so they live here as a pure
 * reduction over the previous state.
 *
 * All times are seconds, matching the parsers in `lyrics.ts`.
 */

/** Gaps shorter than this are not treated as an interlude. */
export const LYRIC_INTERLUDE_MIN_SECONDS = 4

/** Lead-out so the dots clear before the next line starts. */
export const LYRIC_INTERLUDE_LEAD_OUT_SECONDS = 0.25

/** Bias the playhead slightly forward, as Apple does, to hide boundary jitter. */
export const LYRIC_PLAYHEAD_BIAS_SECONDS = 0.02

/** Fallback span for a trailing line with no words and no successor. */
export const LYRIC_TRAILING_LINE_SECONDS = 4

/** Sentinel index meaning "the playhead sits before the first line". */
export const LYRIC_INTERLUDE_BEFORE_FIRST = -2

export interface LyricTimelineEntry {
  index: number
  /** Start time. `null` for untimed lines, which never become hot. */
  time: number | null
  /** Derived end: last word end, else the next line start, else a fallback. */
  endTime: number | null
  timed: boolean
}

export interface LyricPlayheadState {
  hot: Set<number>
  buffered: Set<number>
  scrollToIndex: number
}

export interface LyricPlayheadTransition extends LyricPlayheadState {
  added: Set<number>
  removed: Set<number>
  /** True when the anchor moved and the cascade should be re-issued. */
  anchorChanged: boolean
}

export interface LyricInterlude {
  start: number
  end: number
  /** Line the gap follows, or `LYRIC_INTERLUDE_BEFORE_FIRST`. */
  afterIndex: number
}

export function createLyricPlayheadState(): LyricPlayheadState {
  return { hot: new Set(), buffered: new Set(), scrollToIndex: 0 }
}

/**
 * Derive a concrete span for every line. Word end times win because they are the
 * only source that knows when singing actually stops.
 */
export function buildLyricTimeline(lines: readonly LyricLine[]): LyricTimelineEntry[] {
  const entries: LyricTimelineEntry[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const time = line.time != null && Number.isFinite(line.time) ? line.time : null
    const timed = line.timed && time != null

    let nextTime: number | null = null
    for (let ahead = index + 1; ahead < lines.length; ahead += 1) {
      const candidate = lines[ahead].time
      if (candidate == null || !Number.isFinite(candidate)) continue
      if (time != null && candidate <= time) continue
      nextTime = candidate
      break
    }

    let endTime: number | null = null
    if (time != null) {
      const voiceStarts = line.voices
        ?.map((voice) => voice.time)
        .filter((value): value is number => value != null && Number.isFinite(value))
      const latestVoiceStart = Math.max(time, ...(voiceStarts ?? []))
      const wordLayers = [line.words, ...(line.voices?.map((voice) => voice.words) ?? [])]
      let wordEnd = Number.NEGATIVE_INFINITY
      for (const layer of wordLayers) {
        const words = layer?.length ? resolveLyricWordTimings(layer, nextTime) : []
        for (const word of words) wordEnd = Math.max(wordEnd, word.endTime)
      }

      // Deliberately not clamped to the next line's start. A held tail that runs
      // past its successor is what produces Apple's hand-off, where the finishing
      // line stays lit while the next one begins. Clamping here would collapse
      // that into a snap.
      if (wordEnd > time) endTime = wordEnd
      else if (nextTime != null && nextTime > latestVoiceStart) endTime = nextTime
      else endTime = latestVoiceStart + LYRIC_TRAILING_LINE_SECONDS
    }

    entries.push({ index, time, endTime, timed })
  }

  return entries
}

/** True when no line carries word-level timing, i.e. plain or line-only lyrics. */
export function isNonDynamicTimeline(lines: readonly LyricLine[]): boolean {
  return !lines.some((line) => {
    if ((line.words?.length ?? 0) > 1) return true
    return line.voices?.some((voice) => (voice.words?.length ?? 0) > 1) ?? false
  })
}

function setsEqual(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

function firstIndexAtOrAfter(timeline: readonly LyricTimelineEntry[], time: number): number {
  for (const entry of timeline) {
    if (entry.time != null && entry.time >= time) return entry.index
  }
  return -1
}

/**
 * Advance the hot/buffered sets. `isSeek` collapses the hysteresis and re-anchors
 * immediately, which is what a user scrub should feel like.
 */
export function advanceLyricPlayhead(
  timeline: readonly LyricTimelineEntry[],
  previous: LyricPlayheadState,
  time: number,
  isSeek = false
): LyricPlayheadTransition {
  const hot = new Set(previous.hot)
  const buffered = new Set(previous.buffered)
  const added = new Set<number>()
  const removed = new Set<number>()
  let scrollToIndex = previous.scrollToIndex
  let anchorChanged = false

  const contains = (entry: LyricTimelineEntry): boolean =>
    entry.timed &&
    entry.time != null &&
    entry.endTime != null &&
    entry.time <= time &&
    entry.endTime > time

  for (const index of previous.hot) {
    const entry = timeline[index]
    if (!entry || !contains(entry)) {
      hot.delete(index)
    }
  }
  for (const entry of timeline) {
    if (!contains(entry) || hot.has(entry.index)) continue
    hot.add(entry.index)
    added.add(entry.index)
  }
  for (const index of buffered) {
    if (!hot.has(index)) removed.add(index)
  }

  const setAnchor = (next: number): void => {
    if (next === scrollToIndex) return
    scrollToIndex = next
    anchorChanged = true
  }

  if (isSeek) {
    buffered.clear()
    for (const index of hot) buffered.add(index)
    if (buffered.size > 0) {
      setAnchor(Math.min(...buffered))
    } else {
      // Deliberate deviation from AMLL, which keeps the pre-seek anchor here and
      // so leaves the view on a stale line when you scrub into an instrumental
      // break. Anchoring forward to the upcoming line is what a scrub should do,
      // and it is what makes interlude detection meaningful afterwards.
      const upcoming = firstIndexAtOrAfter(timeline, time)
      setAnchor(upcoming >= 0 ? upcoming : Math.max(0, timeline.length - 1))
    }
    return { hot, buffered, scrollToIndex, added, removed, anchorChanged: true }
  }

  if (added.size === 0 && removed.size === 0) {
    return { hot, buffered, scrollToIndex, added, removed, anchorChanged }
  }

  if (removed.size === 0) {
    for (const index of added) buffered.add(index)
    setAnchor(Math.min(...buffered))
  } else if (added.size === 0) {
    // Only release the presented set when the whole set goes cold together;
    // otherwise hold the anchor so a brief gap does not jump the view.
    if (setsEqual(removed, buffered)) {
      for (const index of removed) buffered.delete(index)
    }
  } else {
    for (const index of added) buffered.add(index)
    for (const index of removed) buffered.delete(index)
    if (buffered.size > 0) setAnchor(Math.min(...buffered))
  }

  return { hot, buffered, scrollToIndex, added, removed, anchorChanged }
}

/**
 * Detect the gap the playhead is sitting in. Only meaningful while nothing is
 * presented, which is why a populated buffered set short-circuits it.
 */
export function findLyricInterlude(
  timeline: readonly LyricTimelineEntry[],
  state: LyricPlayheadState,
  time: number
): LyricInterlude | null {
  if (state.buffered.size > 0) return null

  const playhead = time + LYRIC_PLAYHEAD_BIAS_SECONDS
  const anchor = state.scrollToIndex
  const first = timeline[0]

  if (anchor <= 0) {
    if (first?.time == null) return null
    if (first.time > playhead) {
      return {
        start: playhead,
        end: Math.max(playhead, first.time - LYRIC_INTERLUDE_LEAD_OUT_SECONDS),
        afterIndex: LYRIC_INTERLUDE_BEFORE_FIRST
      }
    }
  }

  const gapAfter = (index: number): LyricInterlude | null => {
    const current = timeline[index]
    const next = timeline[index + 1]
    if (current?.endTime == null || next?.time == null) return null
    if (next.time > playhead && current.endTime < playhead) {
      return {
        start: Math.max(current.endTime, playhead),
        end: next.time,
        afterIndex: index
      }
    }
    return null
  }

  return gapAfter(Math.max(0, anchor)) ?? gapAfter(Math.max(0, anchor) + 1)
}

export function isDisplayableInterlude(interlude: LyricInterlude | null): boolean {
  return interlude != null && interlude.end - interlude.start >= LYRIC_INTERLUDE_MIN_SECONDS
}
