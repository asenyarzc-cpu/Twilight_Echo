<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  desktopLyricsFitScale,
  desktopLyricsWordProgress,
  type DesktopLyricsLine,
  type DesktopLyricsTextAlign,
  type DesktopLyricsWritingMode
} from '../../../../shared/desktopLyrics.ts'
import { buildDesktopLyricsKaraokePlan, desktopLyricsKaraokeTime } from '../desktopLyricsKaraoke.ts'

const props = defineProps<{
  line: DesktopLyricsLine | null
  active: boolean
  align: DesktopLyricsTextAlign
  writingMode: DesktopLyricsWritingMode
  translationVisible: boolean
  romanizationVisible: boolean
}>()

const shell = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const scale = ref(1)
const clipped = ref(false)
const fillElements: Array<HTMLElement | null> = []
let karaokeAnimations: Animation[] = []
let karaokeLineId = ''
let karaokeReady = false
let karaokeBuildQueued = false
let latestPositionMs = 0
let latestPlaying = false

function setFill(index: number, element: unknown): void {
  fillElements[index] = element instanceof HTMLElement ? element : null
}

function supportsWebAnimations(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}

function lineStartMs(): number {
  return props.line?.startMs ?? props.line?.words?.[0]?.startMs ?? 0
}

function clearKaraoke(): void {
  for (const animation of karaokeAnimations) animation.cancel()
  karaokeAnimations = []
  karaokeLineId = ''
  karaokeReady = false
  for (const element of fillElements) {
    if (!element) continue
    element.classList.remove('is-karaoke', 'is-fallback')
    element.style.removeProperty('mask-image')
    element.style.removeProperty('-webkit-mask-image')
    element.style.removeProperty('mask-size')
    element.style.removeProperty('-webkit-mask-size')
    element.style.removeProperty('mask-repeat')
    element.style.removeProperty('--dl-word-remaining')
  }
}

async function fit(): Promise<void> {
  await nextTick()
  const host = shell.value
  const line = content.value
  if (!host || !line) return
  scale.value = 1
  await nextTick()
  const vertical = props.writingMode === 'vertical'
  const contentSize = vertical ? line.scrollHeight : line.scrollWidth
  const availableSize = vertical ? host.clientHeight : host.clientWidth
  const next = desktopLyricsFitScale(contentSize, availableSize)
  scale.value = next
  clipped.value = contentSize * next > availableSize + 1
}

function syncFallback(positionMs: number): void {
  if (!props.active || !props.line?.words?.length) return
  for (let index = 0; index < props.line.words.length; index += 1) {
    const element = fillElements[index]
    if (!element?.classList.contains('is-fallback')) continue
    element.style.setProperty(
      '--dl-word-remaining',
      `${((1 - desktopLyricsWordProgress(props.line.words[index], positionMs)) * 100).toFixed(2)}%`
    )
  }
}

function buildKaraoke(): void {
  karaokeBuildQueued = false
  clearKaraoke()
  const line = props.line
  if (!props.active || !line?.words?.length) return
  const startMs = lineStartMs()
  const canAnimate = supportsWebAnimations()
  karaokeLineId = line.id
  karaokeReady = true

  for (let index = 0; index < line.words.length; index += 1) {
    const element = fillElements[index]
    if (!element) continue
    const plan = buildDesktopLyricsKaraokePlan(line.words[index], startMs, props.writingMode)
    element.style.setProperty('mask-image', plan.maskImage)
    element.style.setProperty('-webkit-mask-image', plan.maskImage)
    element.style.setProperty('mask-size', plan.maskSize)
    element.style.setProperty('-webkit-mask-size', plan.maskSize)
    element.style.setProperty('mask-repeat', 'no-repeat')
    element.classList.add('is-karaoke')
    if (canAnimate) {
      try {
        karaokeAnimations.push(element.animate(plan.keyframes, plan.timing))
        continue
      } catch {
        element.classList.add('is-fallback')
        continue
      }
    }
    element.classList.add('is-fallback')
  }

  syncKaraoke(latestPositionMs, latestPlaying, true)
}

function scheduleKaraokeBuild(): void {
  if (karaokeBuildQueued || !props.active || !props.line?.words?.length) return
  karaokeBuildQueued = true
  void nextTick(buildKaraoke)
}

function animationEndTime(animation: Animation): number | null {
  const endTime = animation.effect?.getComputedTiming().endTime
  return typeof endTime === 'number' && Number.isFinite(endTime) ? endTime : null
}

function syncKaraoke(positionMs: number, playing: boolean, hard = false): void {
  latestPositionMs = positionMs
  latestPlaying = playing
  const line = props.line
  if (!props.active || !line?.words?.length) return
  if (!karaokeReady || karaokeLineId !== line.id) {
    scheduleKaraokeBuild()
    return
  }

  const target = desktopLyricsKaraokeTime(positionMs, lineStartMs())
  for (const animation of karaokeAnimations) {
    const endTime = animationEndTime(animation)
    const boundedTarget = endTime == null ? target : Math.min(target, endTime)
    const current = Number(animation.currentTime ?? 0)
    if (hard || Math.abs(boundedTarget - current) > 48) animation.currentTime = boundedTarget
    if (playing) {
      if (endTime != null && target >= endTime) {
        if (animation.playState !== 'finished') {
          animation.currentTime = endTime
          animation.finish()
        }
      } else if (animation.playState !== 'finished') animation.play()
    } else animation.pause()
  }
  syncFallback(positionMs)
}

watch(
  () => [props.line?.id, props.active, props.writingMode],
  () => {
    fillElements.length = props.line?.words?.length ?? 0
    clearKaraoke()
    void fit()
    scheduleKaraokeBuild()
  },
  { immediate: true, flush: 'post' }
)
watch(
  () => [props.translationVisible, props.romanizationVisible],
  () => void fit()
)
onMounted(() => {
  void fit()
  scheduleKaraokeBuild()
})
onBeforeUnmount(clearKaraoke)
defineExpose({ syncKaraoke, fit })
</script>

<template>
  <div
    ref="shell"
    class="dl-slot-shell"
    :class="[`is-${align}`, `is-${writingMode}`, { 'is-active': active }]"
  >
    <div
      v-if="line"
      ref="content"
      class="dl-line-content"
      :class="{ 'is-clipped': clipped }"
      :style="{ transform: `scale(${scale})` }"
    >
      <div class="dl-primary-line">
        <template v-if="active && line.words?.length">
          <span
            v-for="(word, index) in line.words"
            :key="`${word.startMs}-${index}`"
            class="dl-word"
          >
            <span>{{ word.text }}</span>
            <span :ref="(element) => setFill(index, element)" class="dl-word-fill">{{
              word.text
            }}</span>
          </span>
        </template>
        <span v-else>{{ line.text }}</span>
      </div>
      <div v-if="translationVisible && line.translation" class="dl-translation">
        {{ line.translation }}
      </div>
      <div v-if="romanizationVisible && line.romanization" class="dl-romanization">
        {{ line.romanization }}
      </div>
    </div>
  </div>
</template>
