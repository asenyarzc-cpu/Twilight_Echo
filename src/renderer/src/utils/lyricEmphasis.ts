import { chunkSpan, isCJK, type LyricWordChunk, type ResolvedLyricWord } from './lyricWordChunks.ts'

/**
 * Apple Music's "lively" quality comes from two effects that the previous
 * implementation had no equivalent for:
 *
 * 1. **Emphasis.** A word held for a while does not just fill in. Each of its
 *    characters scales up, drifts outward from the word's centre, lifts, and
 *    glows, staggered so the emphasis travels through the word.
 * 2. **A non-monotonic envelope.** The emphasis rises and then *falls back* over
 *    the word's own duration. A normal easing curve cannot express that, so the
 *    envelope is built from two beziers meeting at the midpoint.
 *
 * Everything here is pure: keyframes and timings only, no DOM. The component
 * feeds them to `Element.animate` so the compositor runs them and a busy main
 * thread cannot make the lyrics stutter.
 *
 * Times are milliseconds, matching the Web Animations API.
 */

/** Frames per emphasis animation. Enough to read as continuous. */
export const EMPHASIS_FRAME_COUNT = 32

/** Below this, a word just fills; at or above it, the word is emphasised. */
export const EMPHASIS_MIN_DURATION_MS = 1200

/** Latin words longer than this read as a phrase, not a held note. */
export const EMPHASIS_MAX_LATIN_LENGTH = 7

export const EMPHASIS_EASING_MID = 0.5
export const EMPHASIS_AMOUNT_CAP = 1
export const EMPHASIS_BLUR_CAP = 0.18
export const EMPHASIS_SCALE_GAIN = 0.025
export const EMPHASIS_LIFT_EM = 0.004
export const EMPHASIS_GLOW_ALPHA_CAP = 0.18

/** The last word of a line carries the phrase, so it is pushed harder. */
export const EMPHASIS_LAST_WORD_AMOUNT_GAIN = 1.6
export const EMPHASIS_LAST_WORD_BLUR_GAIN = 1.5
export const EMPHASIS_LAST_WORD_DURATION_GAIN = 1.2

/** Every word lifts slightly while it is sung, emphasised or not. */
export const FLOAT_RISE_EM = 0.012
export const FLOAT_SECONDARY_RISE_EM = 0.008
export const FLOAT_MIN_DURATION_MS = 1000

/** The emphasis float runs longer than the word and starts slightly early. */
export const EMPHASIS_FLOAT_DURATION_GAIN = 1.4
export const EMPHASIS_FLOAT_LEAD_MS = 400

/** Karaoke sweep width, in multiples of the font size. 0.5 matches iPad. */
export const DEFAULT_WORD_FADE_WIDTH = 0.5

export const MAX_EMPHASIS_GRAPHEMES = 24

export type LyricAnimationVoiceRole = 'lead' | 'background' | 'harmony'
export type LyricDirection = 'ltr' | 'rtl'

interface GraphemeSegmenter {
  segment: (text: string) => Iterable<{ segment: string }>
}

let cachedGraphemeSegmenter: GraphemeSegmenter | null | undefined

function graphemeSegmenter(): GraphemeSegmenter | null {
  if (cachedGraphemeSegmenter !== undefined) return cachedGraphemeSegmenter
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: 'grapheme' }
      ) => GraphemeSegmenter
    }
  ).Segmenter
  if (!Segmenter) {
    cachedGraphemeSegmenter = null
    return null
  }
  try {
    cachedGraphemeSegmenter = new Segmenter(undefined, { granularity: 'grapheme' })
  } catch {
    cachedGraphemeSegmenter = null
  }
  return cachedGraphemeSegmenter
}

const MARK_RE = /^\p{Mark}$/u

function codePoint(character: string): number {
  return character.codePointAt(0) ?? 0
}

function isRegionalIndicator(character: string): boolean {
  const value = codePoint(character)
  return value >= 0x1f1e6 && value <= 0x1f1ff
}

function extendsPreviousGrapheme(character: string): boolean {
  const value = codePoint(character)
  return (
    MARK_RE.test(character) ||
    (value >= 0xfe00 && value <= 0xfe0f) ||
    (value >= 0xe0100 && value <= 0xe01ef) ||
    (value >= 0x1f3fb && value <= 0x1f3ff) ||
    (value >= 0xe0020 && value <= 0xe007f)
  )
}

export function splitGraphemesFallback(text: string): string[] {
  const result: string[] = []
  for (const character of text) {
    const previous = result[result.length - 1]
    if (!previous) {
      result.push(character)
      continue
    }

    const previousCharacters = Array.from(previous)
    const previousCharacter = previousCharacters[previousCharacters.length - 1]
    const regionalCount = previousCharacters.filter(isRegionalIndicator).length
    if (
      character === '\u200d' ||
      previousCharacter === '\u200d' ||
      extendsPreviousGrapheme(character) ||
      (isRegionalIndicator(character) && regionalCount % 2 === 1)
    ) {
      result[result.length - 1] += character
    } else {
      result.push(character)
    }
  }
  return result
}

export function splitGraphemes(text: string): string[] {
  const segmenter = graphemeSegmenter()
  return segmenter
    ? Array.from(segmenter.segment(text), (entry) => entry.segment)
    : splitGraphemesFallback(text)
}

export function emphasisGraphemes(text: string): string[] | null {
  const graphemes = splitGraphemes(text)
  return graphemes.length <= MAX_EMPHASIS_GRAPHEMES ? graphemes : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Cubic bezier easing. Inlined rather than taking a dependency: this is the only
 * place the project needs it, and `pnpm` policy makes a new package costly.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const curve = (a: number, b: number, t: number): number => {
    const inverse = 1 - t
    return 3 * inverse * inverse * t * a + 3 * inverse * t * t * b + t * t * t
  }
  const slope = (a: number, b: number, t: number): number => {
    const inverse = 1 - t
    return 3 * inverse * inverse * a + 6 * inverse * t * (b - a) + 3 * t * t * (1 - b)
  }

  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1

    let t = x
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const error = curve(x1, x2, t) - x
      if (Math.abs(error) < 1e-6) return curve(y1, y2, t)
      const derivative = slope(x1, x2, t)
      if (Math.abs(derivative) < 1e-6) break
      t -= error / derivative
    }

    let low = 0
    let high = 1
    t = x
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const value = curve(x1, x2, t)
      if (Math.abs(value - x) < 1e-6) break
      if (value > x) high = t
      else low = t
      t = (low + high) / 2
    }
    return curve(y1, y2, t)
  }
}

const bezIn = cubicBezier(0.2, 0.4, 0.58, 1)
const bezOut = cubicBezier(0.3, 0, 0.58, 1)

/**
 * Rise then fall. Below the midpoint the first bezier ramps up; above it the
 * second ramps the value back down, so the character returns to rest.
 */
export function makeEmphasisEasing(mid = EMPHASIS_EASING_MID): (x: number) => number {
  const rise = (x: number): number => clamp((x - 0) / (mid - 0), 0, 1)
  const fall = (x: number): number => clamp((x - mid) / (1 - mid), 0, 1)
  return (x: number): number => (x < mid ? bezIn(rise(x)) : 1 - bezOut(fall(x)))
}

const emphasisEasing = makeEmphasisEasing()

/**
 * A single CJK glyph is a whole syllable, so duration alone decides. Latin needs
 * a length guard, otherwise a slow line of prose would emphasise wholesale.
 */
export function shouldEmphasize(
  word: Pick<ResolvedLyricWord, 'text' | 'time' | 'endTime'>
): boolean {
  const durationMs = (word.endTime - word.time) * 1000
  if (durationMs < EMPHASIS_MIN_DURATION_MS) return false
  if (isCJK(word.text)) return true

  const length = splitGraphemes(word.text.trim()).length
  return length > 1 && length <= EMPHASIS_MAX_LATIN_LENGTH
}

export function shouldEmphasizeChunk(chunk: LyricWordChunk): boolean {
  const span = chunkSpan(chunk)
  if (!span) return false
  if (shouldEmphasize(span)) return true
  if (chunk.kind === 'group') return chunk.words.some((word) => shouldEmphasize(word))
  return false
}

export interface EmphasisStrength {
  /** Drives scale and drift. */
  amount: number
  /** Drives the glow. */
  blur: number
  /** Possibly extended past the word's own duration. */
  durationMs: number
}

/**
 * Strength grows with how long the word is held, but sub-linearly past two
 * seconds so a very long note does not blow out.
 */
export function computeEmphasisStrength(durationMs: number, isLastWord = false): EmphasisStrength {
  let duration = Math.max(EMPHASIS_MIN_DURATION_MS, durationMs)

  const shape = (value: number): number => (value > 1 ? Math.sqrt(value) : value ** 3)
  let amount = shape(duration / 2000) * 0.6
  let blur = shape(duration / 3000) * 0.5

  if (isLastWord) {
    amount *= EMPHASIS_LAST_WORD_AMOUNT_GAIN
    blur *= EMPHASIS_LAST_WORD_BLUR_GAIN
    duration *= EMPHASIS_LAST_WORD_DURATION_GAIN
  }

  return {
    amount: Math.min(EMPHASIS_AMOUNT_CAP, amount),
    blur: Math.min(EMPHASIS_BLUR_CAP, blur),
    durationMs: duration
  }
}

export interface EmphasisAnimationPlan {
  glow: Keyframe[]
  float: Keyframe[]
  glowTiming: KeyframeAnimationOptions
  floatTiming: KeyframeAnimationOptions
}

/**
 * Per-character emphasis. `matrix3d` is used for the scale rather than `scale()`
 * because it keeps the glyph on the compositor and avoids the shimmer that
 * re-rasterising at fractional scales produces.
 */
export function buildEmphasisAnimation(
  characterIndex: number,
  characterCount: number,
  strength: EmphasisStrength,
  startDelayMs: number,
  voiceRole: LyricAnimationVoiceRole = 'lead'
): EmphasisAnimationPlan {
  const { amount, blur, durationMs } = strength
  const count = Math.max(1, characterCount)
  // Stagger so the emphasis travels through the word instead of pulsing at once.
  const delay = Math.max(0, startDelayMs) + (durationMs / 2.5 / count) * characterIndex

  const glow: Keyframe[] = []
  const float: Keyframe[] = []

  if (voiceRole === 'lead') {
    for (let frame = 0; frame < EMPHASIS_FRAME_COUNT; frame += 1) {
      const offset = (frame + 1) / EMPHASIS_FRAME_COUNT
      const envelope = emphasisEasing(offset)
      const scale = 1 + envelope * EMPHASIS_SCALE_GAIN * amount
      const offsetX = -envelope * 0.012 * amount * (count / 2 - characterIndex)
      const offsetY = -envelope * EMPHASIS_LIFT_EM * amount
      const glowAlpha = Math.min(EMPHASIS_GLOW_ALPHA_CAP, envelope * blur)

      glow.push({
        offset,
        transform:
          `matrix3d(${scale}, 0, 0, 0, 0, ${scale}, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)` +
          ` translate(${offsetX.toFixed(5)}em, ${offsetY.toFixed(5)}em)`,
        textShadow: `0 0 ${Math.min(0.3, blur * 0.3).toFixed(4)}em rgba(255, 255, 255, ${glowAlpha.toFixed(4)})`
      })

      const lift = Math.sin(offset * Math.PI)
      float.push({ offset, transform: `translateY(${(-lift * EMPHASIS_LIFT_EM).toFixed(5)}em)` })
    }
  }

  return {
    glow,
    float,
    glowTiming: {
      duration: Number.isFinite(durationMs) ? durationMs : 0,
      delay: Number.isFinite(delay) ? delay : 0,
      iterations: 1,
      composite: 'replace',
      fill: 'both'
    },
    floatTiming: {
      duration: Number.isFinite(durationMs) ? durationMs * EMPHASIS_FLOAT_DURATION_GAIN : 0,
      delay: Number.isFinite(delay) ? delay - EMPHASIS_FLOAT_LEAD_MS : 0,
      iterations: 1,
      // Added to the glow transform rather than replacing it.
      composite: 'add',
      fill: 'both'
    }
  }
}

/**
 * The baseline lift every word gets while sung. Additive, so it layers under
 * emphasis without fighting it.
 */
export function buildWordFloatAnimation(
  word: ResolvedLyricWord,
  lineStartTime: number,
  voiceRole: LyricAnimationVoiceRole = 'lead'
): { keyframes: Keyframe[]; timing: KeyframeAnimationOptions } {
  const delay = (word.time - lineStartTime) * 1000
  const duration = Math.max(FLOAT_MIN_DURATION_MS, (word.endTime - word.time) * 1000)
  const rise = voiceRole === 'lead' ? FLOAT_RISE_EM : FLOAT_SECONDARY_RISE_EM

  return {
    keyframes: [{ transform: 'translateY(0px)' }, { transform: `translateY(${-rise}em)` }],
    timing: {
      duration: Number.isFinite(duration) ? duration : 0,
      delay: Number.isFinite(delay) ? delay : 0,
      composite: 'add',
      fill: 'both',
      easing: 'ease-out'
    }
  }
}

export interface WordMeasurement {
  width: number
  height: number
  padding: number
}

export interface KaraokeMaskPlan {
  maskImage: string
  /** `mask-size`, as a percentage pair. */
  maskSize: string
  maskOrigin: 'left' | 'right'
  keyframes: Keyframe[]
  timing: KeyframeAnimationOptions
}

/**
 * The karaoke sweep is a gradient whose *position* is animated, not its size.
 * The gradient is wider than the word, so sliding it left to right uncovers the
 * text progressively.
 */
export function buildFadeGradient(
  widthRatio: number,
  direction: LyricDirection = 'ltr',
  bright = 'rgba(0,0,0,var(--lyric-bright-mask-alpha, 1))',
  dark = 'rgba(0,0,0,var(--lyric-dark-mask-alpha, 1))'
): { gradient: string; totalAspect: number } {
  const totalAspect = 2 + widthRatio
  const widthInTotal = widthRatio / totalAspect
  const leftPos = (1 - widthInTotal) / 2
  return {
    gradient:
      `linear-gradient(to ${direction === 'rtl' ? 'left' : 'right'},${bright} ${leftPos * 100}%,` +
      `${dark} ${(leftPos + widthInTotal) * 100}%)`,
    totalAspect
  }
}

/** WAAPI rejects offsets outside [0,1] or going backwards; float drift can do both. */
function normalizeKeyframes(frames: Keyframe[]): Keyframe[] {
  let previous = 0
  return frames.map((frame) => {
    const raw = typeof frame.offset === 'number' ? frame.offset : previous
    const offset = clamp(Math.max(raw, previous), 0, 1)
    previous = offset
    return { ...frame, offset }
  })
}

/**
 * Build the sweep for one word in the context of its whole line.
 *
 * Line context is what makes this non-trivial. The gradient advances across the
 * *line*, so during a gap between words the fade edge keeps travelling instead of
 * freezing mid-glyph, and consecutive words hand the edge over seamlessly. Doing
 * this per word in isolation produces a visible stutter at every boundary.
 */
export function buildKaraokeMaskPlan(
  words: readonly ResolvedLyricWord[],
  measurements: readonly WordMeasurement[],
  wordIndex: number,
  lineStartTime: number,
  lineEndTime: number,
  direction: LyricDirection = 'ltr',
  fadeWidthRatio = DEFAULT_WORD_FADE_WIDTH
): KaraokeMaskPlan | null {
  const word = words[wordIndex]
  const measurement = measurements[wordIndex]
  if (!word || !measurement || measurement.width <= 0) return null

  const lastWordEnd = words.reduce((max, entry) => Math.max(max, entry.endTime), 0)
  const totalFadeDuration = (Math.max(lastWordEnd, lineEndTime) - lineStartTime) * 1000
  if (!(totalFadeDuration > 0)) return null

  const fadeWidth = measurement.height * fadeWidthRatio
  const fullWidth = measurement.width + measurement.padding * 2
  const { gradient, totalAspect } = buildFadeGradient(fadeWidth / fullWidth, direction)

  const widthBeforeSelf =
    measurements.slice(0, wordIndex).reduce((sum, entry) => sum + entry.width, 0) + fadeWidth
  const minOffset = -(fullWidth + fadeWidth)
  const clampOffset = (value: number): number => Math.max(minOffset, Math.min(0, value))

  let curPos = -widthBeforeSelf - measurement.width - measurement.padding - fadeWidth
  let lastPos = curPos
  let timeOffset = 0
  let lastTime = 0
  const frames: Keyframe[] = []
  const maskPosition = (value: number): string =>
    `${direction === 'rtl' ? -clampOffset(value) : clampOffset(value)}px 0`

  const pushFrame = (): void => {
    const moveOffset = curPos - lastPos
    const time = clamp(timeOffset, 0, 1)
    const duration = time - lastTime
    const rate = moveOffset === 0 ? 0 : Math.abs(duration / moveOffset)

    // Insert the exact instants the edge enters and leaves this word, so the
    // reveal starts and finishes on the word's own timing rather than being
    // interpolated across a neighbour's.
    if (curPos > minOffset && lastPos < minOffset) {
      frames.push({
        offset: lastTime + Math.abs(lastPos - minOffset) * rate,
        maskPosition: maskPosition(lastPos)
      })
    }
    if (curPos > 0 && lastPos < 0) {
      frames.push({
        offset: lastTime + Math.abs(lastPos) * rate,
        maskPosition: maskPosition(curPos)
      })
    }
    frames.push({ offset: time, maskPosition: maskPosition(curPos) })
    lastPos = curPos
    lastTime = time
  }

  pushFrame()

  let lastTimeStamp = 0
  words.forEach((other, index) => {
    const otherMeasurement = measurements[index]
    if (!otherMeasurement) return

    // Hold while nothing is being sung.
    const startStamp = (other.time - lineStartTime) * 1000
    const staticDuration = startStamp - lastTimeStamp
    if (staticDuration > 0) {
      timeOffset += staticDuration / totalFadeDuration
      pushFrame()
      lastTimeStamp = startStamp
    }

    // Advance across this word.
    const fadeDuration = (other.endTime - other.time) * 1000
    if (fadeDuration > 0) {
      timeOffset += fadeDuration / totalFadeDuration
      curPos += otherMeasurement.width
      if (index === 0) curPos += fadeWidth * 1.5
      if (index === words.length - 1) curPos += fadeWidth * 0.5
      pushFrame()
      lastTimeStamp += fadeDuration
    }
  })

  const keyframes = normalizeKeyframes(frames)
  const finalFrame = keyframes[keyframes.length - 1]
  if (finalFrame?.offset === 1) {
    keyframes[keyframes.length - 1] = { ...finalFrame, maskPosition: '0px 0' }
  } else {
    keyframes.push({ offset: 1, maskPosition: '0px 0' })
  }

  return {
    maskImage: gradient,
    maskSize: `${totalAspect * 100}% 100%`,
    maskOrigin: direction === 'rtl' ? 'right' : 'left',
    keyframes,
    timing: { duration: totalFadeDuration, fill: 'both' }
  }
}

/**
 * Apple dims the unsung part of a line relative to how focused the line is, so a
 * receding line loses its karaoke contrast as it shrinks.
 */
export function maskAlphaForScale(scalePercent: number): { bright: number; dark: number } {
  const focus = clamp((scalePercent / 100 - 0.97) / 0.03, 0, 1)
  return { bright: focus * 0.8 + 0.2, dark: focus * 0.2 + 0.2 }
}
