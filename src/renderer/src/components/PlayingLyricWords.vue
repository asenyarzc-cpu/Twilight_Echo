<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { requestAnimationFrameWithFallback } from '../utils/animationFrameFallback'
import {
  buildEmphasisAnimation,
  buildKaraokeMaskPlan,
  buildWordFloatAnimation,
  computeEmphasisStrength,
  emphasisGraphemes,
  MAX_EMPHASIS_GRAPHEMES,
  shouldEmphasizeChunk,
  splitGraphemes,
  type LyricAnimationVoiceRole,
  type LyricDirection,
  type WordMeasurement
} from '../utils/lyricEmphasis'
import {
  chunkAndSplitLyricWords,
  chunkSpan,
  resolveLyricWordTimings,
  type ResolvedLyricWord
} from '../utils/lyricWordChunks'
import type { LyricWord } from '../utils/lyrics'

/**
 * Karaoke fill and emphasis run on the Web Animations API rather than a
 * per-frame JavaScript loop.
 *
 * The previous version recomputed a CSS variable every frame on the main thread,
 * so any main-thread work showed up as a stutter in the fill, and a seek had to
 * be chased frame by frame. Precomputing keyframes hands the whole timeline to
 * the compositor: the fill cannot stutter, and a seek is one `currentTime`
 * assignment.
 *
 * Every animation shares one time origin (the line's start), so a single
 * `currentTime` value keeps the fill, the lift and the glow coherent.
 */

interface LyricClockSnapshot {
  epoch: number
  revision: number
  position: number
}

type LyricMotionMode = 'full' | 'reduced' | 'off'

const props = withDefaults(
  defineProps<{
    words: LyricWord[]
    active: boolean
    karaokeEnabled: boolean
    offsetSeconds: number
    motionMode?: LyricMotionMode
    voiceRole?: LyricAnimationVoiceRole
    direction?: LyricDirection
    clock: {
      snapshot: Ref<LyricClockSnapshot>
      isPlaying: Ref<boolean>
      positionAt: (at?: number) => number
    }
  }>(),
  {
    motionMode: 'full',
    voiceRole: 'lead',
    direction: 'ltr'
  }
)

interface RenderSyllable {
  key: number
  word: ResolvedLyricWord
  /** Split per grapheme only when the word is emphasised. */
  chars: string[] | null
}

type RenderChunk =
  | { kind: 'space'; key: string; text: string }
  | { kind: 'word'; key: string; syllables: RenderSyllable[]; emphasized: boolean }

/** Drift beyond this is corrected; below it, leave the compositor alone. */
const DRIFT_TOLERANCE_MS = 80
const BUILD_FRAME_FALLBACK_MS = 120

const wordElements = ref<Array<HTMLElement | null>>([])
const charElements = ref<Map<string, HTMLElement>>(new Map())

let activeAnimations: Animation[] = []
let cancelScheduledBuild: (() => void) | null = null
let buildGeneration = 0

const resolvedWords = computed<ResolvedLyricWord[]>(() => resolveLyricWordTimings(props.words))

const lineStartSeconds = computed(() => {
  let start = Number.POSITIVE_INFINITY
  for (const word of resolvedWords.value) start = Math.min(start, word.time)
  return Number.isFinite(start) ? start : 0
})

const lineEndSeconds = computed(() => {
  let end = Number.NEGATIVE_INFINITY
  for (const word of resolvedWords.value) end = Math.max(end, word.endTime)
  return Number.isFinite(end) ? end : lineStartSeconds.value
})

const emphasisPlan = new Map<string, { span: ResolvedLyricWord; isLast: boolean }>()

const renderChunks = computed<RenderChunk[]>(() => {
  emphasisPlan.clear()
  const chunks = chunkAndSplitLyricWords(resolvedWords.value)
  const result: RenderChunk[] = []
  let syllableKey = 0

  chunks.forEach((chunk, index) => {
    if (chunk.kind === 'space') {
      result.push({ kind: 'space', key: `s${index}`, text: chunk.text })
      return
    }

    const span = chunkSpan(chunk)
    const isLast = chunks.slice(index + 1).every((rest) => rest.kind === 'space')
    const emphasized =
      props.motionMode === 'full' && props.karaokeEnabled && shouldEmphasizeChunk(chunk)
    const words = chunk.kind === 'word' ? [chunk.word] : chunk.words
    const splitForEmphasis =
      emphasized &&
      props.voiceRole === 'lead' &&
      splitGraphemes(span?.text ?? '').length <= MAX_EMPHASIS_GRAPHEMES

    result.push({
      kind: 'word',
      key: `w${index}-${span?.time ?? 0}`,
      emphasized,
      syllables: words.map((word) => ({
        key: syllableKey++,
        word,
        chars: splitForEmphasis ? emphasisGraphemes(word.text) : null
      }))
    })

    // Recorded for strength; the last word of a line carries the phrase.
    if (emphasized && span) emphasisPlan.set(`w${index}`, { span, isLast })
  })

  return result
})

function setCharElement(key: string, element: Element | null): void {
  if (element instanceof HTMLElement) charElements.value.set(key, element)
  else charElements.value.delete(key)
}

function supportsWebAnimations(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}

function lyricTime(position = props.clock.positionAt()): number {
  return position + props.offsetSeconds
}

function timelineMs(time = lyricTime()): number {
  const lineDurationMs = Math.max(0, (lineEndSeconds.value - lineStartSeconds.value) * 1000)
  return Math.min(lineDurationMs, Math.max(0, (time - lineStartSeconds.value) * 1000))
}

function animationEndTime(animation: Animation): number | null {
  const endTime = animation.effect?.getComputedTiming().endTime
  return typeof endTime === 'number' && Number.isFinite(endTime) ? endTime : null
}

function releaseAnimations(): void {
  for (const animation of activeAnimations) animation.cancel()
  activeAnimations = []
  for (const element of wordElements.value) {
    if (!element) continue
    element.style.removeProperty('mask-image')
    element.style.removeProperty('-webkit-mask-image')
    element.style.removeProperty('mask-size')
    element.style.removeProperty('-webkit-mask-size')
    element.style.removeProperty('mask-repeat')
    element.style.removeProperty('mask-origin')
    element.classList.remove('lyric-word--karaoke')
  }
}

function measureWords(): WordMeasurement[] {
  return wordElements.value.map((element) => {
    if (!element) return { width: 0, height: 0, padding: 0 }
    const padding = Number.parseFloat(getComputedStyle(element).paddingLeft) || 0
    return {
      width: element.clientWidth - padding * 2,
      height: element.clientHeight - padding * 2,
      padding
    }
  })
}

/**
 * Measure, then hand the whole line to the compositor. Measuring needs a
 * committed layout, which is why this waits for a frame.
 */
function buildAnimations(): void {
  releaseAnimations()
  if (
    props.motionMode !== 'full' ||
    !supportsWebAnimations() ||
    !props.active ||
    resolvedWords.value.length === 0
  )
    return

  const words = resolvedWords.value
  const measurements = measureWords()
  const lineStart = lineStartSeconds.value
  const lineEnd = lineEndSeconds.value
  let syllableIndex = 0

  for (const chunk of renderChunks.value) {
    if (chunk.kind === 'space') continue

    const plan = emphasisPlan.get(chunk.key.split('-')[0])
    const strength =
      chunk.emphasized && plan
        ? computeEmphasisStrength((plan.span.endTime - plan.span.time) * 1000, plan.isLast)
        : null

    for (const syllable of chunk.syllables) {
      const element = wordElements.value[syllableIndex]
      const index = syllableIndex
      syllableIndex += 1
      if (!element) continue

      if (props.karaokeEnabled) {
        const mask = buildKaraokeMaskPlan(
          words,
          measurements,
          index,
          lineStart,
          lineEnd,
          props.direction
        )
        if (mask) {
          element.style.setProperty('mask-image', mask.maskImage)
          element.style.setProperty('-webkit-mask-image', mask.maskImage)
          element.style.setProperty('mask-size', mask.maskSize)
          element.style.setProperty('-webkit-mask-size', mask.maskSize)
          element.style.setProperty('mask-repeat', 'no-repeat')
          element.style.setProperty('mask-origin', mask.maskOrigin)
          element.classList.add('lyric-word--karaoke')
          try {
            activeAnimations.push(element.animate(mask.keyframes, mask.timing))
          } catch {
            // A malformed keyframe set must not take the line down with it.
            element.style.removeProperty('mask-image')
            element.style.removeProperty('-webkit-mask-image')
            element.classList.remove('lyric-word--karaoke')
          }
        }
      }

      // Every word lifts slightly while sung, emphasised or not.
      const float = buildWordFloatAnimation(syllable.word, lineStart, props.voiceRole)
      activeAnimations.push(element.animate(float.keyframes, float.timing))

      if (!strength || !syllable.chars) continue

      const startDelayMs = (syllable.word.time - lineStart) * 1000
      syllable.chars.forEach((_char, charIndex) => {
        const charElement = charElements.value.get(`${syllable.key}:${charIndex}`)
        if (!charElement) return
        const emphasis = buildEmphasisAnimation(
          charIndex,
          syllable.chars?.length ?? 1,
          strength,
          startDelayMs,
          props.voiceRole
        )
        if (emphasis.glow.length > 0)
          activeAnimations.push(charElement.animate(emphasis.glow, emphasis.glowTiming))
        if (emphasis.float.length > 0)
          activeAnimations.push(charElement.animate(emphasis.float, emphasis.floatTiming))
      })
    }
  }

  syncAnimations(true)
}

/**
 * Align the compositor timeline with playback. `hard` seeks unconditionally;
 * otherwise only correct once drift is audible, so a healthy line is left to run.
 */
function syncAnimations(hard = false): void {
  if (activeAnimations.length === 0) return

  const target = timelineMs()
  const playing = props.active && props.clock.isPlaying.value

  for (const animation of activeAnimations) {
    const endTime = animationEndTime(animation)
    const boundedTarget = endTime == null ? target : Math.min(target, endTime)
    const current = Number(animation.currentTime ?? 0)
    const forwardDrift = boundedTarget - current
    const shouldCorrect =
      hard ||
      (!playing ? Math.abs(forwardDrift) > DRIFT_TOLERANCE_MS : forwardDrift > DRIFT_TOLERANCE_MS)
    if (shouldCorrect) {
      animation.currentTime = boundedTarget
    }
    if (playing) {
      const pastEnd = endTime != null && target >= endTime
      if (pastEnd) {
        if (animation.playState !== 'finished') {
          animation.currentTime = endTime
          animation.finish()
        }
      } else if (animation.playState !== 'finished') animation.play()
    } else animation.pause()
  }
}

function scheduleBuild(): void {
  if (props.motionMode !== 'full') return
  const generation = ++buildGeneration
  cancelScheduledBuild?.()
  cancelScheduledBuild = requestAnimationFrameWithFallback(() => {
    cancelScheduledBuild = null
    if (generation !== buildGeneration) return
    buildAnimations()
  }, BUILD_FRAME_FALLBACK_MS)
}

watch(
  [
    () => props.active,
    () => props.karaokeEnabled,
    () => props.motionMode,
    () => props.voiceRole,
    () => props.direction,
    () => props.words,
    () => props.offsetSeconds,
    () => props.clock.snapshot.value.epoch
  ],
  async () => {
    const generation = ++buildGeneration
    cancelScheduledBuild?.()
    cancelScheduledBuild = null
    releaseAnimations()
    if (props.motionMode !== 'full') return
    await nextTick()
    if (generation !== buildGeneration) return
    scheduleBuild()
  },
  { immediate: true, flush: 'post' }
)

// The clock ticks far slower than a frame; this only corrects drift and seeks.
watch(
  () => (props.active ? props.clock.snapshot.value.revision : null),
  () => {
    if (!props.active || props.motionMode !== 'full') return
    syncAnimations()
  }
)

watch(props.clock.isPlaying, () => {
  if (props.motionMode !== 'full') return
  syncAnimations(true)
})

onBeforeUnmount(() => {
  buildGeneration += 1
  cancelScheduledBuild?.()
  cancelScheduledBuild = null
  releaseAnimations()
})
</script>

<template>
  <span
    class="lyric-text lyric-text--words"
    :class="{ 'lyric-text--static': motionMode !== 'full' }"
    :dir="direction"
    :data-motion-mode="motionMode"
    :data-voice-role="voiceRole"
  >
    <template v-for="chunk in renderChunks" :key="chunk.key">
      <span v-if="chunk.kind === 'space'" class="lyric-space">{{ chunk.text }}</span>
      <span
        v-else
        class="lyric-word-group"
        :class="{ 'lyric-word-group--emphasized': chunk.emphasized }"
      >
        <span
          v-for="syllable in chunk.syllables"
          :key="syllable.key"
          :ref="(element) => (wordElements[syllable.key] = (element as HTMLElement | null) ?? null)"
          class="lyric-word"
          :data-word-text="syllable.word.text"
        >
          <template v-if="syllable.chars">
            <span
              v-for="(char, charIndex) in syllable.chars"
              :key="charIndex"
              :ref="(element) => setCharElement(`${syllable.key}:${charIndex}`, element as Element)"
              class="lyric-char"
              >{{ char }}</span
            >
          </template>
          <template v-else>{{ syllable.word.text }}</template>
        </span>
      </span>
    </template>
  </span>
</template>

<style scoped>
.lyric-word--karaoke {
  color: var(--te-playback-lyric-karaoke, currentColor);
}

.lyric-text--static .lyric-word {
  mask-image: none !important;
  -webkit-mask-image: none !important;
  transform: none !important;
  text-shadow: none !important;
}
</style>
