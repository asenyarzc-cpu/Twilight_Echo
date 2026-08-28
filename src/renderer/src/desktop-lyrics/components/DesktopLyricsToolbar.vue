<script setup lang="ts">
import { ref } from 'vue'
import type {
  DesktopLyricsPalette,
  DesktopLyricsSettingsV3,
  DesktopLyricsTransportAction
} from '../../../../shared/desktopLyrics.ts'

defineProps<{ settings: DesktopLyricsSettingsV3; playing: boolean }>()
const emit = defineEmits<{
  transport: [action: DesktopLyricsTransportAction]
  patch: [patch: Partial<DesktopLyricsSettingsV3>]
  lock: []
  close: []
}>()
const paletteOpen = ref(false)
const palettes: Array<{ id: DesktopLyricsPalette; label: string; color: string }> = [
  { id: 'accent', label: '封面强调色', color: 'var(--dl-accent)' },
  { id: 'twilight', label: 'Twilight', color: '#7aa2ff' },
  { id: 'warm', label: '暖白', color: '#ffd27a' },
  { id: 'custom', label: '自定义', color: 'var(--dl-custom)' }
]

function resize(fontSize: number): void {
  emit('patch', { fontSize: Math.min(64, Math.max(20, fontSize)) })
}

function selectPalette(palette: DesktopLyricsPalette): void {
  emit('patch', { palette })
  paletteOpen.value = false
}
</script>

<template>
  <div class="dl-toolbar" data-dl-interactive>
    <button type="button" title="上一首" aria-label="上一首" @click="emit('transport', 'previous')">
      <i class="ph ph-skip-back"></i>
    </button>
    <button
      type="button"
      :title="playing ? '暂停' : '播放'"
      :aria-label="playing ? '暂停' : '播放'"
      @click="emit('transport', 'playPause')"
    >
      <i :class="playing ? 'ph ph-pause' : 'ph ph-play'"></i>
    </button>
    <button type="button" title="下一首" aria-label="下一首" @click="emit('transport', 'next')">
      <i class="ph ph-skip-forward"></i>
    </button>
    <span class="dl-toolbar-divider"></span>
    <button
      type="button"
      title="减小字号"
      aria-label="减小字号"
      @click="resize(settings.fontSize - 2)"
    >
      A−
    </button>
    <button
      type="button"
      title="增大字号"
      aria-label="增大字号"
      @click="resize(settings.fontSize + 2)"
    >
      A+
    </button>
    <div class="dl-palette-anchor">
      <button
        type="button"
        title="歌词配色"
        aria-label="歌词配色"
        :aria-expanded="paletteOpen"
        @click="paletteOpen = !paletteOpen"
      >
        <i class="ph ph-palette"></i>
      </button>
      <Transition name="dl-popover">
        <div v-if="paletteOpen" class="dl-palette-menu">
          <button
            v-for="palette in palettes"
            :key="palette.id"
            type="button"
            :class="{ 'is-selected': settings.palette === palette.id }"
            :title="palette.label"
            @click="selectPalette(palette.id)"
          >
            <span class="dl-swatch" :style="{ background: palette.color }"></span>
            {{ palette.label }}
          </button>
        </div>
      </Transition>
    </div>
    <button
      type="button"
      title="显示翻译"
      aria-label="显示翻译"
      :aria-pressed="settings.translationVisible"
      :class="{ 'is-selected': settings.translationVisible }"
      @click="emit('patch', { translationVisible: !settings.translationVisible })"
    >
      译
    </button>
    <button type="button" title="锁定桌面歌词" aria-label="锁定桌面歌词" @click="emit('lock')">
      <i class="ph ph-lock"></i>
    </button>
    <button
      class="is-close"
      type="button"
      title="关闭桌面歌词"
      aria-label="关闭桌面歌词"
      @click="emit('close')"
    >
      <i class="ph ph-x"></i>
    </button>
  </div>
</template>
