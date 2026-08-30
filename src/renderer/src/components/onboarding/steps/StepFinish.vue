<script setup lang="ts">
import { computed } from 'vue'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'

const { tracks, libraryScanProgress } = useMusicStore()
const { settings, updateSettings } = useSettingsStore()

// Live first-scan feedback: folders picked on the local step start scanning in
// the background, so by the finish scene the library is often already filling.
const scanText = computed(() => {
  const progress = libraryScanProgress.value
  if (progress) {
    if (progress.phase === 'enumerating') return `正在整理曲库…发现 ${progress.total} 个文件`
    return `正在整理曲库…${progress.current} / ${progress.total}`
  }
  if (tracks.value.length > 0) return `曲库已就绪，共 ${tracks.value.length} 首`
  return ''
})

const desktopLyricsOn = computed(() => settings.value.desktopLyrics.enabled)

async function toggleDesktopLyrics(): Promise<void> {
  const enabled = await window.api.desktopLyrics.setEnabled(!settings.value.desktopLyrics.enabled)
  await updateSettings({ desktopLyrics: { ...settings.value.desktopLyrics, enabled } })
}

const features: { icon: string; label: string }[] = [
  { icon: 'ph ph-picture-in-picture', label: '迷你播放器' },
  { icon: 'ph ph-faders', label: '均衡器与 DSP 机架' },
  { icon: 'ph ph-moon', label: '睡眠定时器' },
  { icon: 'ph ph-keyboard', label: '全局快捷键' },
  { icon: 'ph ph-puzzle-piece', label: '插件市场' }
]
</script>

<template>
  <section class="onb-stage" data-scene="08">
    <div class="onb-notes" aria-hidden="true">
      <i class="ph ph-music-note"></i>
      <i class="ph ph-music-notes"></i>
      <i class="ph ph-music-note-simple"></i>
      <i class="ph ph-music-notes-simple"></i>
      <i class="ph ph-music-note"></i>
      <i class="ph ph-music-notes"></i>
    </div>
    <div class="onb-eq" aria-hidden="true">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
    <h1 class="onb-title"><em>一切就绪</em></h1>
    <p class="onb-subtitle">这些功能已经在设置中等你探索——现在，让音乐开始吧。</p>
    <p v-if="scanText" class="onb-scan-status">
      <i class="ph ph-vinyl-record"></i>
      {{ scanText }}
    </p>
    <div class="onb-feature-grid">
      <button
        type="button"
        class="onb-feature is-action"
        :class="{ 'is-on': desktopLyricsOn }"
        role="switch"
        :aria-checked="desktopLyricsOn"
        @click="() => void toggleDesktopLyrics()"
      >
        <i class="ph ph-microphone-stage"></i>
        桌面歌词
        <span class="onb-feature-state">{{ desktopLyricsOn ? '已开启' : '点击开启' }}</span>
      </button>
      <span v-for="feature in features" :key="feature.label" class="onb-feature">
        <i :class="feature.icon"></i>
        {{ feature.label }}
      </span>
    </div>
  </section>
</template>
