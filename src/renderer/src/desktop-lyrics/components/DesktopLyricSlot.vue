<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import {
  desktopLyricsFitScale,
  desktopLyricsWordProgress,
  type DesktopLyricsLine
} from '../../../../shared/desktopLyrics.ts'

const props = defineProps<{
  line: DesktopLyricsLine | null
  active: boolean
  align: 'left' | 'right'
  translationVisible: boolean
}>()

const shell = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const scale = ref(1)
const clipped = ref(false)
const wordElements: Array<HTMLElement | null> = []

function setWord(index: number, element: unknown): void {
  wordElements[index] = element instanceof HTMLElement ? element : null
}

async function fit(): Promise<void> {
  await nextTick()
  const host = shell.value
  const line = content.value
  if (!host || !line) return
  scale.value = 1
  await nextTick()
  const next = desktopLyricsFitScale(line.scrollWidth, host.clientWidth)
  scale.value = next
  clipped.value = line.scrollWidth * next > host.clientWidth + 1
}

function writeProgress(positionMs: number): void {
  if (!props.active || !props.line?.words?.length) return
  for (let index = 0; index < props.line.words.length; index += 1) {
    const element = wordElements[index]
    if (!element) continue
    element.style.setProperty(
      '--dl-word-remaining',
      `${((1 - desktopLyricsWordProgress(props.line.words[index], positionMs)) * 100).toFixed(2)}%`
    )
  }
}

watch(
  () => props.line?.id,
  () => {
    wordElements.length = props.line?.words?.length ?? 0
    void fit()
  }
)
watch(
  () => props.translationVisible,
  () => void fit()
)
onMounted(() => void fit())
defineExpose({ writeProgress, fit })
</script>

<template>
  <div ref="shell" class="dl-slot-shell" :class="[`is-${align}`, { 'is-active': active }]">
    <Transition name="dl-line" mode="out-in">
      <div
        v-if="line"
        :key="line.id"
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
              :ref="(element) => setWord(index, element)"
              class="dl-word"
              :data-text="word.text"
              >{{ word.text }}</span
            >
          </template>
          <span v-else>{{ line.text }}</span>
        </div>
        <div v-if="translationVisible && line.translation" class="dl-translation">
          {{ line.translation }}
        </div>
      </div>
    </Transition>
  </div>
</template>
