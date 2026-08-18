<script setup lang="ts">
import { computed, type Ref } from 'vue'
import type { LyricLine, LyricVoiceLayer } from '../utils/lyrics.ts'
import {
  resolveLyricVoiceLayout,
  type LyricTextDirection
} from '../utils/lyricVoiceLayout.ts'
import PlayingLyricWords from './PlayingLyricWords.vue'

interface LyricClockSnapshot {
  epoch: number
  revision: number
  position: number
}

const props = defineProps<{
  line: LyricLine
  singing: boolean
  karaokeEnabled: boolean
  offsetSeconds: number
  motionMode: 'full' | 'reduced' | 'off'
  clock: {
    snapshot: Ref<LyricClockSnapshot>
    isPlaying: Ref<boolean>
    positionAt: (at?: number) => number
  }
  translationStyle: Record<string, string>
  romanizationStyle: Record<string, string>
  align: 'left' | 'center' | 'right'
}>()

const lineDirection = computed<LyricTextDirection>(() => {
  const text = props.line.voices?.map((voice) => voice.text).join(' ') || props.line.text
  return /[\u0590-\u08ff]/.test(text) ? 'rtl' : 'ltr'
})
const voiceLayout = computed(() => resolveLyricVoiceLayout(props.line, lineDirection.value))
const dynamicVoiceKeys = computed(
  () =>
    new Set(
      voiceLayout.value.ordered
        .filter((voice) => (voice.words?.length ?? 0) > 0)
        .slice(0, 4)
        .map((voice) => voice.voiceKey)
    )
)

function voiceClass(voice: LyricVoiceLayer): Record<string, boolean> {
  return {
    'lyric-voice--lead': voice.role === 'lead',
    'lyric-voice--background': voice.role === 'background',
    'lyric-voice--harmony': voice.role === 'harmony'
  }
}

function voiceMotionRole(voice: LyricVoiceLayer): 'lead' | 'background' | 'harmony' {
  return voice.role
}
</script>

<template>
  <span
    class="lyric-row-content"
    :class="[
      { 'lyric-row-content--duet': voiceLayout.hasDuet },
      `lyric-row-content--align-${align}`
    ]"
    :dir="lineDirection"
    aria-hidden="true"
  >
    <span v-if="voiceLayout.center.length" class="lyric-lane lyric-lane--center">
      <span
        v-for="voice in voiceLayout.center"
        :key="voice.voiceKey"
        class="lyric-voice"
        :class="voiceClass(voice)"
        dir="auto"
      >
        <PlayingLyricWords
          v-if="voice.words?.length"
          :words="voice.words"
          :active="singing && dynamicVoiceKeys.has(voice.voiceKey)"
          :offset-seconds="offsetSeconds"
          :clock="clock"
          :karaoke-enabled="karaokeEnabled"
          :motion-mode="motionMode"
          :voice-role="voiceMotionRole(voice)"
          :direction="lineDirection"
        />
        <span v-else class="lyric-text">{{ voice.text }}</span>
      </span>
    </span>

    <span v-if="voiceLayout.start.length || voiceLayout.end.length" class="lyric-duet-grid">
      <span class="lyric-lane lyric-lane--start">
        <span
          v-for="voice in voiceLayout.start"
          :key="voice.voiceKey"
          class="lyric-voice"
          :class="voiceClass(voice)"
          dir="auto"
        >
          <PlayingLyricWords
            v-if="voice.words?.length"
            :words="voice.words"
            :active="singing && dynamicVoiceKeys.has(voice.voiceKey)"
            :offset-seconds="offsetSeconds"
            :clock="clock"
            :karaoke-enabled="karaokeEnabled"
            :motion-mode="motionMode"
            :voice-role="voiceMotionRole(voice)"
            :direction="lineDirection"
          />
          <span v-else class="lyric-text">{{ voice.text }}</span>
        </span>
      </span>
      <span class="lyric-lane lyric-lane--end">
        <span
          v-for="voice in voiceLayout.end"
          :key="voice.voiceKey"
          class="lyric-voice"
          :class="voiceClass(voice)"
          dir="auto"
        >
          <PlayingLyricWords
            v-if="voice.words?.length"
            :words="voice.words"
            :active="singing && dynamicVoiceKeys.has(voice.voiceKey)"
            :offset-seconds="offsetSeconds"
            :clock="clock"
            :karaoke-enabled="karaokeEnabled"
            :motion-mode="motionMode"
            :voice-role="voiceMotionRole(voice)"
            :direction="lineDirection"
          />
          <span v-else class="lyric-text">{{ voice.text }}</span>
        </span>
      </span>
    </span>

    <span
      v-if="line.translation"
      class="lyric-translation"
      :style="translationStyle"
      dir="auto"
    >
      {{ line.translation }}
    </span>
    <span
      v-if="line.romanization"
      class="lyric-romanization"
      :style="romanizationStyle"
      dir="auto"
    >
      {{ line.romanization }}
    </span>
  </span>
</template>

<style scoped>
.lyric-row-content {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  overflow: visible;
  transform: scale(var(--lyric-line-scale, 1));
  transform-origin: center;
  will-change: transform;
}

.lyric-lane,
.lyric-voice {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.lyric-lane {
  gap: 4px;
}

.lyric-lane--center {
  align-items: center;
  text-align: center;
}

.lyric-row-content--align-left .lyric-lane--center {
  align-items: flex-start;
  text-align: start;
}

.lyric-row-content--align-right .lyric-lane--center {
  align-items: flex-end;
  text-align: end;
}

.lyric-row-content--align-left .lyric-translation,
.lyric-row-content--align-left .lyric-romanization {
  text-align: start;
}

.lyric-row-content--align-right .lyric-translation,
.lyric-row-content--align-right .lyric-romanization {
  text-align: end;
}

.lyric-row-content--duet .lyric-translation,
.lyric-row-content--duet .lyric-romanization {
  text-align: center;
}

.lyric-duet-grid {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 32px;
  align-items: start;
}

.lyric-lane--start {
  align-items: flex-start;
  text-align: start;
}

.lyric-lane--end {
  align-items: flex-end;
  text-align: end;
}

.lyric-voice {
  width: min(100%, 32rem);
  unicode-bidi: plaintext;
}

.lyric-lane--end .lyric-voice {
  align-items: flex-end;
}

.lyric-voice--background,
.lyric-voice--harmony {
  width: min(82%, 26rem);
  font-size: 0.78em;
  font-weight: 500;
  opacity: 0.64;
}

.lyric-voice--harmony {
  font-style: italic;
  opacity: 0.58;
}

.lyric-text,
.lyric-translation,
.lyric-romanization {
  min-width: 0;
  width: 100%;
  word-break: break-word;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}

.lyric-text {
  font-size: clamp(12px, var(--lyric-style-font-size, var(--te-lyric-font-size, 18px)), 48px);
  line-height: var(--lyric-style-line-height, var(--te-lyric-line-height, 1.85));
  letter-spacing: var(--lyric-style-letter-spacing, 0);
}

.lyric-translation {
  margin-top: var(--te-lyric-translation-spacing, 0);
  padding: 3px 7px;
  font-family: var(--lyric-style-font-family, var(--te-lyric-font-family, inherit));
  font-size: clamp(12px, var(--lyric-style-font-size, var(--te-lyric-font-size, 18px)), 48px);
  font-weight: var(--lyric-style-font-weight, 500);
  font-style: var(--lyric-style-font-style, normal);
  line-height: var(--lyric-style-line-height, 1.45);
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  color: var(--lyric-style-color, var(--te-playback-lyric-translation));
  opacity: var(--lyric-style-opacity, 1);
  text-align: center;
}

.lyric-romanization {
  font-family: var(--lyric-style-font-family, var(--te-lyric-font-family, inherit));
  font-size: clamp(
    12px,
    var(--lyric-style-font-size, calc(var(--te-lyric-font-size, 18px) - 3px)),
    48px
  );
  font-weight: var(--lyric-style-font-weight, 400);
  font-style: var(--lyric-style-font-style, normal);
  line-height: var(--lyric-style-line-height, 1.35);
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  color: var(--lyric-style-color, var(--te-playback-lyric-romanization));
  opacity: var(--lyric-style-opacity, 1);
  text-align: center;
}

:global(.lyric-row.is-singing) .lyric-voice--lead {
  color: var(--te-playback-lyric-active-text);
}

:global(.lyric-row.is-singing) .lyric-translation {
  color: var(--te-playback-lyric-translation-active);
}

:global(.lyric-row.is-singing) .lyric-romanization {
  color: var(--te-playback-lyric-romanization-active);
}

@media (max-width: 620px) {
  .lyric-duet-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    margin-bottom: 4px;
  }

  .lyric-lane--start,
  .lyric-lane--end {
    width: 100%;
  }
}

:global(html[data-te-motion='reduced']) .lyric-row-content,
:global(html[data-te-motion='off']) .lyric-row-content {
  transform: none !important;
}

@media (forced-colors: active) {
  :global(.lyric-row.is-singing) .lyric-voice--lead {
    color: CanvasText;
    text-decoration: underline;
    text-decoration-thickness: 0.08em;
  }
}
</style>
