<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import {
  DEFAULT_MINI_PLAYER_SETTINGS,
  EMPTY_MINI_PLAYER_STATE,
  cloneMiniPlayerSettings,
  type MiniPlayerCommand,
  type MiniPlayerSettingsPatch,
  type MiniPlayerStateSnapshot
} from '../../../shared/miniPlayer.ts'
import MiniPlayerCustomizer from './MiniPlayerCustomizer.vue'
import ScrollingText from './ScrollingText.vue'
import {
  buildMiniPlayerCssVariables,
  resolveMiniPlayerLayout,
  resolveMiniPlayerVisibility
} from './presentation'
import { resolveMiniPlayerStyle } from './styles'
import { useMiniPlayerCustomizationDraft } from './useMiniPlayerCustomizationDraft'
import { useMotionPreference } from '../app/useMotionPreference'
import { useCover } from '../utils/coverLoader'
import { useSmoothedValue } from '../utils/useSmoothedValue'
import { findActiveMiniPlayerLyricIndex } from '../app/useMiniPlayerSync'
import type { MiniPlayerLyricLineSnapshot } from '../../../shared/miniPlayer'
import type { MotionPreference } from '../../../shared/motion.ts'

const state = ref<MiniPlayerStateSnapshot>({ ...EMPTY_MINI_PLAYER_STATE })
const ready = ref(false)
const bootstrapError = ref('')
const coverFailed = ref(false)
const customizerOpen = ref(false)
// Idle (cursor outside the window) shows the current lyric line; hovering the
// UI switches back to track title / artist so controls stay usable.
const hovered = ref(false)
const viewportWidth = ref(Math.max(1, window.innerWidth))
const viewportHeight = ref(Math.max(1, window.innerHeight))
const motionPreference = ref<MotionPreference>('system')
useMotionPreference(motionPreference)

const customization = useMiniPlayerCustomizationDraft({
  initial: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
  persist: async (settings) => await window.api.miniPlayer.updateSettings(settings)
})
const { settings } = customization

const activeProfile = computed(
  () => settings.value.profiles[settings.value.activeStyleId] ?? customization.activeProfile.value
)
const activeStyle = computed(() => resolveMiniPlayerStyle(settings.value.activeStyleId))
const rawProgressPercent = computed(() =>
  state.value.duration > 0
    ? Math.min(100, Math.max(0, (state.value.currentTime / state.value.duration) * 100))
    : 0
)
// Snapshot pushes are stepped; glide between them like the main PlayerBar.
const progressPercent = useSmoothedValue(rawProgressPercent, { tau: 160, snapThreshold: 2.5 })
const progressFillStyle = computed<CSSProperties>(() => ({
  transform: `scaleX(${Math.min(100, Math.max(0, progressPercent.value)) / 100})`
}))
const resolvedLayout = computed(() =>
  resolveMiniPlayerLayout(
    viewportWidth.value,
    viewportHeight.value,
    activeProfile.value.layout.preference
  )
)
const resolvedVisibility = computed(() =>
  resolveMiniPlayerVisibility(activeProfile.value.visibility, resolvedLayout.value)
)
const styleVariables = computed(
  () =>
    ({
      ...activeStyle.value.tokens,
      ...buildMiniPlayerCssVariables(
        activeProfile.value,
        state.value.dominantColor,
        state.value.volume * 100
      )
    }) as CSSProperties
)
const styleClasses = computed(() => [
  activeStyle.value.className,
  `mini-layout-${activeStyle.value.layout}`,
  {
    'is-ready': ready.value,
    'is-playing': state.value.isPlaying,
    'is-position-locked': settings.value.positionLocked,
    'is-artwork-hidden': !resolvedVisibility.value.artwork,
    'is-customizing': customizerOpen.value
  }
])
// cover:// / background:// handles and expired twilight-media grants cannot be
// painted directly in this window — materialize / re-grant through the same
// loader the main window uses (IPC getCover + coverSource re-grant).
const coverSrc = useCover(
  computed(() => state.value.track?.cover),
  computed(() => state.value.track?.coverSource)
)
const hasCover = computed(() => Boolean(coverSrc.value) && !coverFailed.value)
const backgroundSourceStyle = computed<CSSProperties>(() => {
  const background = activeProfile.value.background
  const fallback = { backgroundColor: background.fallbackColor }

  if (background.kind === 'solid') return { backgroundColor: background.solidColor }
  if (background.kind === 'gradient') {
    return {
      ...fallback,
      backgroundImage: `linear-gradient(${background.gradientAngle}deg, ${background.gradientStart}, ${background.gradientEnd})`
    }
  }
  if (background.kind === 'cover' && hasCover.value && coverSrc.value) {
    return { ...fallback, backgroundImage: cssBackgroundUrl(coverSrc.value) }
  }
  if (background.kind === 'image' && background.imageUrl) {
    return { ...fallback, backgroundImage: cssBackgroundUrl(background.imageUrl) }
  }
  return fallback
})
const trackTitle = computed(() => state.value.track?.title || '暂无播放')
const trackArtist = computed(() => state.value.track?.artist || '从主窗口选择一首音乐')
const trackAlbum = computed(() => state.value.track?.album || 'TWILIGHT ECHO')
// Older main-process snapshots omit the field entirely (undefined); treat that
// as "no lyric" so the idle view never dereferences a missing line.
const lyricLines = computed<MiniPlayerLyricLineSnapshot[]>(() => state.value.lyrics ?? [])
const activeLyricIndex = computed(() =>
  findActiveMiniPlayerLyricIndex(lyricLines.value, state.value.currentTime)
)
const currentLyricLine = computed(() =>
  activeLyricIndex.value >= 0 ? (lyricLines.value[activeLyricIndex.value] ?? null) : null
)
const hasActiveLyric = computed(
  () => currentLyricLine.value !== null && lyricLines.value.length > 0 && Boolean(state.value.track)
)
const trackQuality = computed(() => {
  const track = state.value.track
  if (!track) return { label: '', spec: '', isHiRes: false }
  const format = (track.format ?? '').trim().toUpperCase()
  const sampleRate =
    typeof track.sampleRate === 'number' && track.sampleRate > 0
      ? track.sampleRate >= 1000
        ? `${(track.sampleRate / 1000).toFixed(track.sampleRate % 1000 === 0 ? 0 : 1)}kHz`
        : `${track.sampleRate}Hz`
      : ''
  const bitDepth =
    typeof track.bitDepth === 'number' && track.bitDepth > 0 ? `${track.bitDepth}bit` : ''
  const spec = [format, bitDepth, sampleRate].filter(Boolean).join(' · ')
  const lossless = /^(flac|alac|wav|aiff|aif|ape|dsf|dff|tta|wv|m4a)$/i.test(format)
  const isHiRes = (track.bitDepth ?? 0) >= 24 || (track.sampleRate ?? 0) >= 96000
  return {
    label: isHiRes ? 'Hi-Res Lossless' : lossless ? 'Lossless' : '',
    spec,
    isHiRes
  }
})
const queuePositionText = computed(() =>
  state.value.queueLength > 0 && state.value.queueIndex >= 0
    ? `${state.value.queueIndex + 1} / ${state.value.queueLength}`
    : `0 / ${state.value.queueLength}`
)
const playModeTitle = computed(() => {
  if (state.value.playMode === 'heart') return '心动模式'
  if (state.value.playMode === 'listLoop') return '列表循环'
  if (state.value.playMode === 'repeat') return '单曲循环'
  if (state.value.playMode === 'shuffle') return '随机播放'
  return '顺序播放'
})
const playModeIcon = computed(() => {
  if (state.value.playMode === 'heart') return 'ph ph-heart'
  if (state.value.playMode === 'listLoop') return 'ph ph-repeat'
  if (state.value.playMode === 'repeat') return 'ph ph-repeat-once'
  if (state.value.playMode === 'shuffle') return 'ph ph-shuffle'
  return 'ph ph-arrow-right'
})

function cssBackgroundUrl(value: string): string {
  return `url(${JSON.stringify(value)})`
}

function sendCommand(command: MiniPlayerCommand): void {
  window.api.miniPlayer.command(command)
}

function togglePlay(): void {
  if (!state.value.track || state.value.isLoading) return
  sendCommand({ type: 'toggle-play' })
}

function seekTo(value: number): void {
  const time = Math.min(state.value.duration || value, Math.max(0, value))
  state.value = { ...state.value, currentTime: time }
  sendCommand({ type: 'seek', value: time })
}

function onProgressInput(event: Event): void {
  seekTo(Number((event.target as HTMLInputElement).value))
}

function setVolume(value: number): void {
  const volume = Math.min(1, Math.max(0, value))
  state.value = { ...state.value, volume }
  sendCommand({ type: 'set-volume', value: volume })
}

function onVolumeInput(event: Event): void {
  setVolume(Number((event.target as HTMLInputElement).value))
}

async function updateWindowSettings(patch: MiniPlayerSettingsPatch): Promise<void> {
  customization.replaceSettings({ ...settings.value, ...patch })
  try {
    await customization.flush()
  } catch (error) {
    console.error('[mini-player] Failed to update window settings:', error)
  }
}

function togglePositionLock(): void {
  void updateWindowSettings({ positionLocked: !settings.value.positionLocked })
}

function toggleAlwaysOnTop(): void {
  void updateWindowSettings({ alwaysOnTop: !settings.value.alwaysOnTop })
}

function openCustomizer(): void {
  customization.beginSession()
  customizerOpen.value = true
}

async function closeCustomizer(): Promise<void> {
  try {
    await customization.flush()
    customizerOpen.value = false
  } catch {
    // The editor stays open so its inline persistence error remains actionable.
  }
}

async function pickBackgroundImage(): Promise<string | null> {
  return await window.api.miniPlayer.chooseBackgroundImage()
}

async function minimizeWindow(): Promise<void> {
  try {
    await customization.flush()
    window.api.miniPlayer.minimize()
  } catch {
    // Keep the window visible when the latest customization could not be saved.
  }
}

async function returnToMainWindow(): Promise<void> {
  try {
    await customization.flush()
    window.api.miniPlayer.returnToMain()
  } catch {
    // Keep the window visible when the latest customization could not be saved.
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

function updateViewportSize(): void {
  viewportWidth.value = Math.max(1, window.innerWidth)
  viewportHeight.value = Math.max(1, window.innerHeight)
}

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (customizerOpen.value) await closeCustomizer()
    else await returnToMainWindow()
    return
  }

  const target = event.target as HTMLElement | null
  if (target?.tagName === 'INPUT') return

  switch (event.key) {
    case ' ':
      event.preventDefault()
      togglePlay()
      break
    case 'ArrowLeft':
      event.preventDefault()
      seekTo(state.value.currentTime - 5)
      break
    case 'ArrowRight':
      event.preventDefault()
      seekTo(state.value.currentTime + 5)
      break
    case 'ArrowUp':
      event.preventDefault()
      setVolume(state.value.volume + 0.05)
      break
    case 'ArrowDown':
      event.preventDefault()
      setVolume(state.value.volume - 0.05)
      break
  }
}

let removeStateListener: (() => void) | null = null
let removeSettingsListener: (() => void) | null = null
let removeMotionPreferenceListener: (() => void) | null = null

onMounted(async () => {
  removeStateListener = window.api.miniPlayer.onState((nextState) => {
    state.value = nextState
  })
  removeSettingsListener = window.api.miniPlayer.onSettings((nextSettings) => {
    customization.acceptConfirmed(nextSettings)
  })
  removeMotionPreferenceListener = window.api.miniPlayer.onMotionPreference((nextPreference) => {
    motionPreference.value = nextPreference
  })
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', updateViewportSize)
  updateViewportSize()

  await loadBootstrap()
})

async function loadBootstrap(): Promise<void> {
  bootstrapError.value = ''
  try {
    const bootstrap = await window.api.miniPlayer.getBootstrap()
    state.value = bootstrap.state
    customization.acceptConfirmed(bootstrap.settings)
    motionPreference.value = bootstrap.motionPreference
  } catch (error) {
    console.error('[mini-player] Failed to load initial state:', error)
    bootstrapError.value = error instanceof Error ? error.message : String(error)
  } finally {
    requestAnimationFrame(() => {
      ready.value = true
    })
  }
}

watch(coverSrc, () => {
  coverFailed.value = false
})

onBeforeUnmount(() => {
  const pendingFlush = customization.flush()
  customization.dispose()
  void pendingFlush.catch(() => undefined)
  removeStateListener?.()
  removeSettingsListener?.()
  removeMotionPreferenceListener?.()
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', updateViewportSize)
})
</script>

<template>
  <main
    v-if="settings.profiles[settings.activeStyleId]"
    class="mini-player-root"
    :class="styleClasses"
    :style="styleVariables"
    :data-layout="resolvedLayout"
    :data-theme-profile="settings.activeStyleId"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <div
      class="mini-window-fill"
      :style="{ backgroundColor: activeProfile.background.fallbackColor }"
      aria-hidden="true"
    ></div>
    <section class="mini-player-surface">
      <div class="mini-background-source" :style="backgroundSourceStyle" aria-hidden="true"></div>
      <div class="mini-background-overlay" aria-hidden="true"></div>

      <div v-if="bootstrapError" class="mini-bootstrap-error" role="alert">
        <p>迷你播放器加载失败：{{ bootstrapError }}</p>
        <div class="mini-bootstrap-actions">
          <button type="button" @click="loadBootstrap">重试</button>
          <button type="button" @click="returnToMainWindow">回主窗口</button>
        </div>
      </div>

      <span class="mini-drag-hint" aria-hidden="true"></span>

      <div class="mini-window-actions mini-no-drag">
        <button
          type="button"
          class="mini-tool-button"
          :class="{ active: customizerOpen }"
          title="自定义迷你播放器"
          aria-label="打开迷你播放器自定义面板"
          @click="openCustomizer"
        >
          <i class="ph ph-sliders-horizontal"></i>
        </button>
        <button
          type="button"
          class="mini-tool-button"
          :class="{ active: settings.positionLocked }"
          :title="settings.positionLocked ? '解锁窗口位置' : '锁定窗口位置'"
          :aria-pressed="settings.positionLocked"
          @click="togglePositionLock"
        >
          <i :class="settings.positionLocked ? 'ph ph-lock' : 'ph ph-lock-open'"></i>
        </button>
        <button
          type="button"
          class="mini-tool-button"
          :class="{ active: settings.alwaysOnTop }"
          :title="settings.alwaysOnTop ? '取消保持置顶' : '保持窗口置顶'"
          :aria-pressed="settings.alwaysOnTop"
          @click="toggleAlwaysOnTop"
        >
          <i class="ph ph-push-pin"></i>
        </button>
        <button
          type="button"
          class="mini-tool-button"
          title="最小化"
          aria-label="最小化"
          @click="minimizeWindow"
        >
          <i class="ph ph-minus"></i>
        </button>
        <button
          type="button"
          class="mini-tool-button return-button"
          data-te-back-button="icon"
          title="返回完整播放器"
          aria-label="返回完整播放器"
          @click="returnToMainWindow"
        >
          <i class="ph ph-arrows-out-simple"></i>
        </button>
      </div>

      <div
        v-if="resolvedVisibility.artwork"
        :key="`artwork:${state.track?.id ?? 'empty'}`"
        class="mini-artwork-wrap"
      >
        <img
          v-if="hasCover"
          :src="coverSrc || ''"
          class="mini-artwork"
          alt="专辑封面"
          @error="coverFailed = true"
        />
        <div v-else class="mini-artwork mini-artwork-placeholder" aria-label="暂无封面">
          <i class="ph ph-music-notes"></i>
        </div>
        <div
          v-if="resolvedVisibility.equalizer"
          class="mini-equalizer"
          :class="{ active: state.isPlaying }"
          aria-hidden="true"
        >
          <span></span><span></span><span></span><span></span>
        </div>
      </div>

      <div class="mini-player-content">
        <div class="mini-player-main">
          <div class="mini-track-info">
            <div :key="`meta:${state.track?.id ?? 'empty'}`" class="mini-track-meta">
              <div v-if="resolvedVisibility.album" class="mini-track-kicker">{{ trackAlbum }}</div>
              <h1 :title="trackTitle"><ScrollingText :text="trackTitle" /></h1>
              <p :title="trackArtist"><ScrollingText :text="trackArtist" /></p>
            </div>
            <div
              v-if="trackQuality.spec || trackQuality.label"
              class="mini-quality"
              aria-label="音质信息"
            >
              <span
                v-if="trackQuality.label"
                class="mini-quality-badge"
                :class="{ 'is-hires': trackQuality.isHiRes }"
              >
                {{ trackQuality.label }}
              </span>
              <span v-if="trackQuality.spec" class="mini-quality-spec">{{
                trackQuality.spec
              }}</span>
            </div>
          </div>

          <div v-if="hasActiveLyric" class="mini-lyric-stage" aria-live="polite" aria-atomic="true">
            <Transition name="mini-lyric-switch" mode="out-in">
              <div :key="`lyric:${state.track?.id}:${activeLyricIndex}`" class="mini-lyric-current">
                <p class="mini-lyric-original" :title="currentLyricLine!.original">
                  {{ currentLyricLine!.original }}
                </p>
                <p
                  v-if="currentLyricLine!.translation"
                  class="mini-lyric-translation"
                  :title="currentLyricLine!.translation"
                >
                  {{ currentLyricLine!.translation }}
                </p>
              </div>
            </Transition>
          </div>
          <div v-else class="mini-lyric-empty" aria-hidden="true">
            <span>♪ 暂无歌词</span>
          </div>
        </div>

        <div class="mini-player-dock">
          <div
            class="mini-progress-block mini-no-drag"
            :class="{ 'without-time': !resolvedVisibility.time }"
          >
            <div class="mini-progress-track" aria-hidden="true">
              <div class="mini-progress-fill" :style="progressFillStyle"></div>
            </div>
            <input
              type="range"
              class="mini-range mini-progress-range"
              min="0"
              :max="state.duration || 1"
              step="0.1"
              :value="state.currentTime"
              aria-label="播放进度"
              :disabled="!state.track"
              @input="onProgressInput"
            />
            <div v-if="resolvedVisibility.time" class="mini-time-row">
              <span>{{ formatTime(state.currentTime) }}</span>
              <span>{{ formatTime(state.duration) }}</span>
            </div>
          </div>

          <footer class="mini-player-controls mini-no-drag">
            <div class="mini-controls-side left">
              <button
                v-if="resolvedVisibility.playMode"
                type="button"
                class="mini-control-button mode-button"
                :title="playModeTitle"
                :aria-label="playModeTitle"
                :disabled="!state.track"
                @click="sendCommand({ type: 'cycle-play-mode' })"
              >
                <i :class="playModeIcon"></i>
              </button>
            </div>

            <div class="mini-transport">
              <button
                type="button"
                class="mini-control-button transport-button"
                title="上一首"
                aria-label="上一首"
                :disabled="!state.track"
                @click="sendCommand({ type: 'previous' })"
              >
                <i class="ph ph-skip-back"></i>
              </button>
              <button
                type="button"
                class="mini-play-button"
                :class="{ 'is-playing': state.isPlaying }"
                :title="state.isPlaying ? '暂停' : '播放'"
                :aria-label="state.isPlaying ? '暂停' : '播放'"
                :disabled="!state.track || state.isLoading"
                @click="togglePlay"
              >
                <i
                  :class="
                    state.isLoading
                      ? 'pi pi-spin pi-spinner'
                      : state.isPlaying
                        ? 'ph ph-pause'
                        : 'ph ph-play'
                  "
                ></i>
              </button>
              <button
                type="button"
                class="mini-control-button transport-button"
                title="下一首"
                aria-label="下一首"
                :disabled="!state.track"
                @click="sendCommand({ type: 'next' })"
              >
                <i class="ph ph-skip-forward"></i>
              </button>
            </div>

            <div class="mini-controls-side right">
              <span
                v-if="resolvedVisibility.queuePosition"
                class="mini-queue-position"
                title="当前队列位置"
              >
                {{ queuePositionText }}
              </span>

              <label v-if="resolvedVisibility.volume" class="mini-volume" title="音量">
                <i class="ph ph-speaker-high"></i>
                <input
                  type="range"
                  class="mini-range mini-volume-range"
                  min="0"
                  max="1"
                  step="0.01"
                  :value="state.volume"
                  aria-label="音量"
                  @input="onVolumeInput"
                />
              </label>
            </div>
          </footer>
        </div>
      </div>

      <MiniPlayerCustomizer
        v-if="customizerOpen"
        :settings="settings"
        mode="overlay"
        :saving="customization.saving.value"
        :error="customization.error.value"
        :pick-background-image="pickBackgroundImage"
        @update:settings="customization.replaceSettings"
        @undo="customization.undoSession"
        @reset="customization.resetActiveTheme"
        @flush="customization.flush"
        @close="closeCustomizer"
      />
    </section>
  </main>
</template>

<style src="./MiniPlayer.css"></style>
