<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  EMPTY_MINI_PLAYER_STATE,
  type MiniPlayerCommand,
  type MiniPlayerStateSnapshot
} from '../../../shared/miniPlayer.ts'
import type { TrayNavigationTarget } from '../../../shared/trayPlayer.ts'

const state = ref<MiniPlayerStateSnapshot>({ ...EMPTY_MINI_PLAYER_STATE })
const ready = ref(false)
const seeking = ref(false)
const seekDraft = ref(0)
let removeStateListener: (() => void) | null = null

const displayedTime = computed(() => (seeking.value ? seekDraft.value : state.value.currentTime))
const duration = computed(() => Math.max(0, state.value.duration))
const canSeek = computed(() => Boolean(state.value.track) && duration.value > 0)
const trackTitle = computed(() => state.value.track?.title || '暂无播放')
const trackArtist = computed(() => state.value.track?.artist || '打开 Twilight Echo 选择音乐')
const playbackLabel = computed(() => (state.value.isPlaying ? '暂停' : '播放'))

function sendCommand(command: MiniPlayerCommand): void {
  window.api.trayPlayer.command(command)
}

function beginSeek(): void {
  if (!canSeek.value) return
  seeking.value = true
  seekDraft.value = state.value.currentTime
}

function updateSeek(event: Event): void {
  seekDraft.value = Number((event.target as HTMLInputElement).value)
}

function commitSeek(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  seekDraft.value = value
  seeking.value = false
  sendCommand({ type: 'seek', value })
}

function navigate(target: TrayNavigationTarget): void {
  window.api.trayPlayer.navigate(target)
}

function hideTrayPlayer(): void {
  window.api.trayPlayer.hide()
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') window.api.trayPlayer.hide()
  if (event.code === 'Space' && (event.target as HTMLElement | null)?.tagName !== 'INPUT') {
    event.preventDefault()
    sendCommand({ type: 'toggle-play' })
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  removeStateListener = window.api.trayPlayer.onState((next) => {
    state.value = next
    if (!seeking.value) seekDraft.value = next.currentTime
  })
  try {
    const bootstrap = await window.api.trayPlayer.getBootstrap()
    state.value = bootstrap.state
    seekDraft.value = bootstrap.state.currentTime
  } finally {
    ready.value = true
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  removeStateListener?.()
})
</script>

<template>
  <main class="tray-player" :class="{ ready }">
    <header class="track-heading">
      <div class="track-copy">
        <strong :title="trackTitle">{{ trackTitle }}</strong>
        <span :title="trackArtist">{{ trackArtist }}</span>
      </div>
      <button
        class="icon-button close-button"
        type="button"
        aria-label="关闭播放控制"
        @click="hideTrayPlayer"
      >
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
    </header>

    <section class="progress-section" aria-label="播放进度">
      <input
        class="progress-slider"
        type="range"
        min="0"
        :max="Math.max(1, duration)"
        step="0.1"
        :value="displayedTime"
        :disabled="!canSeek"
        aria-label="拖动播放进度"
        @pointerdown="beginSeek"
        @input="updateSeek"
        @change="commitSeek"
      />
      <div class="time-row">
        <span>{{ formatTime(displayedTime) }}</span>
        <span>{{ formatTime(duration) }}</span>
      </div>
    </section>

    <section class="action-row">
      <nav class="page-actions" aria-label="打开页面">
        <button type="button" @click="navigate('local')">
          <i class="ph ph-house" aria-hidden="true"></i>
          本地
        </button>
        <button type="button" @click="navigate('streaming')">
          <i class="ph ph-globe" aria-hidden="true"></i>
          流媒体
        </button>
      </nav>

      <div class="transport-actions" aria-label="播放控制">
        <button
          class="icon-button"
          type="button"
          aria-label="上一首"
          @click="sendCommand({ type: 'previous' })"
        >
          <i class="ph ph-skip-back" aria-hidden="true"></i>
        </button>
        <button
          class="icon-button play-button"
          type="button"
          :aria-label="playbackLabel"
          :disabled="!state.track || state.isLoading"
          @click="sendCommand({ type: 'toggle-play' })"
        >
          <i :class="state.isPlaying ? 'ph ph-pause' : 'ph ph-play'" aria-hidden="true"></i>
        </button>
        <button
          class="icon-button"
          type="button"
          aria-label="下一首"
          @click="sendCommand({ type: 'next' })"
        >
          <i class="ph ph-skip-forward" aria-hidden="true"></i>
        </button>
      </div>
    </section>
  </main>
</template>

<style scoped>
:global(html.tray-player-document),
:global(body.tray-player-document) {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent !important;
}

.tray-player {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 16px 17px 14px;
  color: var(--te-neutral-50);
  background: linear-gradient(155deg, var(--te-neutral-700), var(--te-neutral-900));
  border: 1px solid var(--te-glass-border);
  border-radius: 18px;
  box-shadow: var(--te-glass-shadow);
  opacity: 0;
  transform: translateY(5px) scale(0.985);
  transition:
    opacity 130ms ease,
    transform 130ms ease;
  user-select: none;
}

.tray-player.ready {
  opacity: 1;
  transform: none;
}

.track-heading,
.action-row,
.page-actions,
.transport-actions,
.time-row {
  display: flex;
  align-items: center;
}

.track-heading {
  justify-content: space-between;
  gap: 12px;
}

.track-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.track-copy strong,
.track-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-copy strong {
  font-size: 14px;
  font-weight: 650;
}

.track-copy span,
.time-row {
  color: var(--te-neutral-300);
  font-size: 11px;
}

.progress-section {
  margin-top: 12px;
}

.progress-slider {
  display: block;
  width: 100%;
  height: 4px;
  margin: 0;
  accent-color: var(--te-primary-400);
  cursor: pointer;
}

.progress-slider:disabled {
  cursor: default;
  opacity: 0.35;
}

.time-row {
  justify-content: space-between;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}

.action-row {
  justify-content: space-between;
  margin-top: 10px;
}

.page-actions,
.transport-actions {
  gap: 6px;
}

button {
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.page-actions button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  color: var(--te-neutral-100);
  background: var(--te-navigation-hover);
  border: 1px solid var(--te-glass-border);
  border-radius: 9px;
  font-size: 12px;
}

.icon-button {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: transparent;
  border-radius: 50%;
  font-size: 17px;
}

.close-button {
  flex: 0 0 auto;
  color: var(--te-neutral-300);
}

.play-button {
  width: 36px;
  height: 36px;
  color: var(--te-neutral-900);
  background: var(--te-primary-400);
  font-size: 18px;
}

button:hover:not(:disabled),
button:focus-visible {
  background-color: var(--te-navigation-hover);
  outline: none;
}

.play-button:hover:not(:disabled),
.play-button:focus-visible {
  background: var(--te-primary-300);
}

button:disabled {
  cursor: default;
  opacity: 0.42;
}

@media (prefers-reduced-motion: reduce) {
  .tray-player {
    transition: none;
  }
}
</style>
