<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance
} from 'vue'
import { storeToRefs } from 'pinia'
import { usePlayerStore } from '../stores/usePlayerStore'
import { useVisualizationStore } from '../stores/useVisualizationStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useLyricsManagement } from '../stores/lyricsManagement'
import CoverImg from './CoverImg.vue'
import { buildLyricLines, findActiveLyricIndex } from '../utils/lyrics'
import type { LyricLine } from '../utils/lyrics'
import { resolveLyricVoiceLayout } from '../utils/lyricVoiceLayout.ts'
import { projectLyricDisplay, projectManagedLyrics } from '../../../shared/lyricsManagement.ts'
import AudioVisualizerPanel from './AudioVisualizerPanel.vue'
import PlayingLyricLine from './PlayingLyricLine.vue'
import PlayingMusicTimeChip from './PlayingMusicTimeChip.vue'
import LyricsAppearanceCustomizer from './LyricsAppearanceCustomizer.vue'
import {
  DEFAULT_LYRICS_APPEARANCE,
  resolveCascadeSpeedFactor,
  resolveLyricsFontFamily,
  type LyricsStyleTarget
} from '../../../shared/lyricsAppearance.ts'
import { lyricsStyleVars } from '../utils/lyricsStyleVars'
import { getLyricFocusLineIndices } from '../utils/lyricFocusWindow'
import { waitForAnimationFrameWithFallback } from '../utils/animationFrameFallback'
import { createLyricViewportController } from '../utils/lyricViewportController'
import { LYRIC_ALIGN_POSITION } from '../utils/lyricLineLayout'
import {
  advanceLyricPlayhead,
  buildLyricTimeline,
  createLyricPlayheadState,
  findLyricInterlude,
  isDisplayableInterlude,
  isNonDynamicTimeline,
  type LyricPlayheadState
} from '../utils/lyricTimeline'

const playbackStore = usePlayerStore()
const visualizationStore = useVisualizationStore()
const {
  currentTrack,
  dominantColor,
  lyricsLoadState,
  isPlaying,
  playbackClockSnapshot,
  estimatePlaybackClockPosition
} = playbackStore
const lyricWordClock = {
  snapshot: playbackClockSnapshot,
  isPlaying,
  positionAt: estimatePlaybackClockPosition
}
const { visualizerActive } = storeToRefs(visualizationStore)
const { seek } = playbackStore
const { settings } = useSettingsStore()
const lyricsManagement = useLyricsManagement()
const emit = defineEmits<{ customizeAppearance: [] }>()
const appearanceMenuOpen = ref(false)
const appearanceMenuPosition = ref({ x: 0, y: 0 })

function openAppearanceMenu(event: MouseEvent): void {
  appearanceMenuPosition.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 52))
  }
  appearanceMenuOpen.value = true
}

function closeAppearanceMenu(): void {
  appearanceMenuOpen.value = false
}

function customizePlayerAppearance(): void {
  closeAppearanceMenu()
  emit('customizeAppearance')
}

function customizeLyricsAppearance(): void {
  closeAppearanceMenu()
  lyricsCustomizerOpen.value = true
}

const nowPlayingBackground = computed(() => settings.value.nowPlayingBackground)
const lyricsAppearance = computed(() => settings.value.lyricsAppearance)
const lyricAlign = computed(() => lyricsAppearance.value.align)
const lyricsCustomizerOpen = ref(false)

const lyricTextStyle = computed(() => lyricsAppearance.value.styles)

function lyricStyleVars(target: LyricsStyleTarget): Record<string, string> {
  return lyricsStyleVars(lyricTextStyle.value[target], target)
}

const isBlurBackground = computed(() => nowPlayingBackground.value === 'blur')
const isFluidBackground = computed(() => nowPlayingBackground.value === 'fluid')
const isSolidBackground = computed(() => nowPlayingBackground.value === 'solid')

const lyricAlignClass = computed(() => `lyric-align-${lyricAlign.value}`)
const lyricStyle = computed<Record<string, string>>(() => {
  const appearance = lyricsAppearance.value
  const styles: Record<string, string> = {
    '--te-lyric-font-size': `${appearance.fontSize}px`,
    '--te-lyric-font-weight': String(appearance.fontWeight),
    '--te-lyric-line-height': String(appearance.lineHeight),
    '--te-lyric-translation-spacing': `${appearance.translationSpacing}px`,
    '--te-lyric-font-family': resolveLyricsFontFamily(appearance.styles.active)
  }

  if (appearance.colorMode === 'custom') {
    styles['--te-playback-lyric-text'] = appearance.textColor
    styles['--te-playback-lyric-active-text'] = appearance.activeColor
    styles['--te-playback-lyric-karaoke'] = appearance.karaokeColor
    styles['--te-playback-lyric-translation'] =
      `color-mix(in srgb, ${appearance.textColor} 72%, transparent)`
    styles['--te-playback-lyric-translation-active'] =
      `color-mix(in srgb, ${appearance.activeColor} 82%, transparent)`
    styles['--te-playback-lyric-romanization'] =
      `color-mix(in srgb, ${appearance.textColor} 58%, transparent)`
    styles['--te-playback-lyric-romanization-active'] =
      `color-mix(in srgb, ${appearance.activeColor} 72%, transparent)`
  }

  return styles
})

const layoutStyle = computed<Record<string, string>>(() => {
  const appearance = lyricsAppearance.value
  return {
    '--te-lyric-cover-gap': `${appearance.coverGap}px`,
    '--te-lyric-max-width': `${appearance.lyricsMaxWidth}px`,
    '--te-lyric-offset-x': `${appearance.lyricsOffsetX}px`
  }
})

/**
 * The cover geometry belongs to the active theme, so only write these when the
 * user has actually moved them off the defaults — an unconditional inline value
 * would silently outrank whatever the theme set.
 */
const coverStyle = computed<Record<string, string>>(() => {
  const appearance = lyricsAppearance.value
  const styles: Record<string, string> = {}
  if (appearance.coverSize !== DEFAULT_LYRICS_APPEARANCE.coverSize) {
    styles['--te-playback-cover-size'] = `${appearance.coverSize}%`
  }
  if (appearance.coverRadius !== DEFAULT_LYRICS_APPEARANCE.coverRadius) {
    styles['--te-playback-cover-radius'] = `${appearance.coverRadius}px`
  }
  return styles
})

// Visualizer toggle: replaces the cover+lyrics layout with the native-engine
// spectrum visualizer surface.
const viewMode = ref<'cover' | 'visualizer'>('cover')
function toggleVisualizer(): void {
  viewMode.value = viewMode.value === 'cover' ? 'visualizer' : 'cover'
}
// Mirror viewMode into the player store so App.vue can hide the PlayerBar while
// the visualizer surface is active.
watch(
  viewMode,
  (mode) => {
    visualizerActive.value = mode === 'visualizer'
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  visualizerActive.value = false
})

const coverIdentity = computed(
  () =>
    `${currentTrack.value?.id ?? 'none'}:${currentTrack.value?.cover ?? ''}:${currentTrack.value?.coverSource ?? ''}`
)
const lyricsEl = ref<HTMLElement | null>(null)
const lyricRowElements = new Map<number, HTMLElement>()
let lyricResizeObserver: ResizeObserver | null = null
let lyricMotionObserver: MutationObserver | null = null
const LYRIC_SCROLL_FRAME_FALLBACK_MS = 120
const LYRIC_ACTIVE_ANCHOR_RATIO = LYRIC_ALIGN_POSITION
const INTERLUDE_DOTS_HEIGHT_PX = 24
const LYRIC_ROW_GAP_PX = 10

/**
 * Motion preference gates the physics. `full` runs springs, blur and glow;
 * `reduced` and `off` snap lines into place and drop the depth effects.
 */
const lyricMotionLevel = ref<'full' | 'reduced' | 'off'>('full')

function readLyricMotionLevel(): void {
  const level = document.documentElement.dataset.teMotion
  lyricMotionLevel.value = level === 'reduced' || level === 'off' ? level : 'full'
}

const lyricMotionFull = computed(() => lyricMotionLevel.value === 'full')

/** Presented lines, carrying Apple's hysteresis so brief gaps do not flicker. */
let lyricPlayheadState: LyricPlayheadState = createLyricPlayheadState()
const lyricBufferedIndices = ref<ReadonlySet<number>>(new Set<number>())
const lyricHotIndices = ref<ReadonlySet<number>>(new Set<number>())
const lyricInterludeAfterIndex = ref<number | null>(null)
const lyricInterludeDotsTop = ref<number | null>(null)

/**
 * The player bar floats over the bottom of the now-playing page, so the
 * visible lyric area ends above it. Anchor the active line to the center of
 * that visible area (viewport height minus the bar) instead of the raw
 * viewport center, otherwise the highlighted line sits too low behind the bar.
 */
function measurePlaybarReservedPx(): number {
  const bar = document.querySelector<HTMLElement>('.player-bar-shell')
  if (!bar) return 0
  // A tucked-away auto-hide bar keeps its layout box, so measuring it would keep
  // the lyric centre line offset around empty space.
  if (bar.dataset.tePlaybarHidden === 'true') return 0
  const height = bar.getBoundingClientRect().height
  return Number.isFinite(height) && height > 0 ? height : 0
}

function currentTrackId(): string {
  return currentTrack.value?.id ?? ''
}

const lyricVisibility = computed(() => lyricsManagement.document.value)
const managedLyricOverride = computed(() => lyricsManagement.entryFor(currentTrack.value?.id ?? ''))
const managedLyrics = computed(() =>
  projectManagedLyrics(
    {
      original: currentTrack.value?.lyrics,
      translation: currentTrack.value?.translatedLyrics,
      romanization: currentTrack.value?.romanizedLyrics,
      originalSource: currentTrack.value?.lyricsSource,
      translationSource: currentTrack.value?.translatedLyricsSource,
      romanizationSource: currentTrack.value?.romanizedLyricsSource
    },
    managedLyricOverride.value
  )
)
const lyricLines = computed<LyricLine[]>(() => {
  return buildLyricLines(
    managedLyrics.value.original,
    managedLyrics.value.translation,
    managedLyrics.value.romanization
  )
})
const displayLyricLines = computed<LyricLine[]>(() =>
  lyricLines.value.map((line) => ({ ...line, ...projectLyricDisplay(line, lyricVisibility.value) }))
)
const currentLyricOffsetSeconds = computed(() =>
  lyricsManagement.effectiveOffsetSeconds(currentTrack.value?.id ?? '')
)

const hasLyrics = computed(() => lyricLines.value.length > 0)
const lyricsStillLoading = computed(
  () =>
    !hasLyrics.value &&
    lyricsLoadState.value.trackId === currentTrack.value?.id &&
    lyricsLoadState.value.status === 'loading'
)
const lyricsLoadFailed = computed(
  () =>
    !hasLyrics.value &&
    lyricsLoadState.value.trackId === currentTrack.value?.id &&
    lyricsLoadState.value.status === 'failed'
)
const lyricsPendingLabel = computed(() =>
  lyricsStillLoading.value ? '加载歌词…' : lyricsLoadFailed.value ? '歌词加载失败' : '暂无歌词'
)
const reserveLyricsColumn = computed(
  () => hasLyrics.value || lyricsStillLoading.value || lyricsLoadFailed.value
)
const activeLyricIndex = ref(-1)
const highlightedLyricIndex = ref(-1)

/**
 * Focus mode keeps a handful of lines around the active one. The rows all stay
 * mounted — the layout collapses the rest — so springs and measured heights
 * survive a line entering or leaving the window.
 */
const lyricFocusWindow = computed<ReadonlySet<number> | null>(() => {
  const focusLineCount = lyricsAppearance.value.focusLineCount
  if (focusLineCount === 'all') return null
  const total = displayLyricLines.value.length
  if (total <= focusLineCount) return null
  return new Set(getLyricFocusLineIndices(total, highlightedLyricIndex.value, focusLineCount))
})

/**
 * One controller now owns lyric motion. Previously a second controller derived
 * scale and blur from scroll position, which made those values slaves to the
 * scroll and left no room for per-line physics. Depth is part of the layout.
 */
const lyricViewport = createLyricViewportController({
  afterLayout: async () => {
    await nextTick()
    await waitForAnimationFrameWithFallback(LYRIC_SCROLL_FRAME_FALLBACK_MS)
  },
  onManualBrowseChange: () => {},
  getActiveIndex: () => activeLyricIndex.value,
  getHotIndices: () => lyricHotIndices.value,
  getBufferedIndices: () => lyricBufferedIndices.value,
  alignPosition: LYRIC_ACTIVE_ANCHOR_RATIO,
  getAlignPosition: () => lyricsAppearance.value.anchorPosition,
  getBottomReservedPx: measurePlaybarReservedPx,
  getRowGapPx: () => LYRIC_ROW_GAP_PX,
  isSpringEnabled: () => lyricMotionFull.value && viewMode.value === 'cover',
  isBlurEnabled: () => lyricMotionFull.value,
  isScaleEnabled: () => lyricMotionFull.value,
  isPlaying: () => isPlaying.value,
  isNonDynamic: () => isNonDynamicTimeline(lyricLines.value),
  getFocusWindow: () => lyricFocusWindow.value,
  getInactiveDim: () => lyricsAppearance.value.inactiveOpacity / 100,
  getScaleIntensity: () => lyricsAppearance.value.scaleIntensity / 100,
  getBlurIntensity: () => lyricsAppearance.value.blurIntensity / 100,
  getCascadeSpeedFactor: () => resolveCascadeSpeedFactor(lyricsAppearance.value.cascadeSpeed),
  shouldHidePassedLines: () => lyricsAppearance.value.hidePassedLines,
  getInterludeAfterIndex: () => lyricInterludeAfterIndex.value,
  getInterludeDotsHeight: () => INTERLUDE_DOTS_HEIGHT_PX,
  onInterludeDotsTop: (top) => {
    lyricInterludeDotsTop.value = top
  }
})

lyricViewport.activate(currentTrackId())

const lyricTimeline = computed(() => buildLyricTimeline(lyricLines.value))

/**
 * Type and spacing changes alter measured row heights, and geometry changes move
 * the anchor, so the layout has to be recomputed rather than left to the next
 * line change — otherwise a size tweak only takes effect on the following lyric.
 */
watch(
  () => lyricsAppearance.value,
  async () => {
    await lyricViewport.recenter('resize')
  },
  { deep: true }
)

watch(
  () => [currentTrack.value?.id, lyricLines.value] as const,
  async ([trackId], previous) => {
    const [previousTrackId, previousLines] = previous ?? []
    if (trackId !== previousTrackId) {
      lyricViewport.activate(trackId ?? '')
      await lyricViewport.recenter('snap')
      return
    }

    if (currentTrack.value && lyricLines.value !== previousLines) {
      await lyricViewport.recenter('snap')
    }
  }
)

watch(
  displayLyricLines,
  async () => {
    await lyricViewport.recenter('snap')
  },
  { flush: 'post' }
)

function lyricTime(position = playbackClockSnapshot.value.position): number {
  return position + currentLyricOffsetSeconds.value
}

/**
 * Advance the presented set rather than just picking "the line whose time has
 * come". The held set is what stops the view flickering between two overlapping
 * lines and what holds the anchor still through a short instrumental gap.
 */
function syncActiveLyricIndex(time = playbackClockSnapshot.value.position, isSeek = false): void {
  const timeline = lyricTimeline.value
  const adjusted = lyricTime(time)
  const next = advanceLyricPlayhead(timeline, lyricPlayheadState, adjusted, isSeek)
  lyricPlayheadState = { hot: next.hot, buffered: next.buffered, scrollToIndex: next.scrollToIndex }
  lyricHotIndices.value = next.hot
  lyricBufferedIndices.value = next.buffered

  const interlude = findLyricInterlude(timeline, lyricPlayheadState, adjusted)
  lyricInterludeAfterIndex.value = isDisplayableInterlude(interlude)
    ? (interlude?.afterIndex ?? null)
    : null

  // Fall back to a direct lookup when nothing is presented, so an untimed or
  // line-only source still highlights something.
  const nextIndex =
    next.buffered.size > 0 ? next.scrollToIndex : findActiveLyricIndex(lyricLines.value, adjusted)
  if (nextIndex !== activeLyricIndex.value) activeLyricIndex.value = nextIndex
  if (next.added.size > 0 || next.removed.size > 0) {
    void lyricViewport.recenter(isSeek ? 'snap' : 'resize')
  }
}

watch(
  [lyricLines, playbackClockSnapshot, currentLyricOffsetSeconds],
  ([lines, snapshot], previous) => {
    const linesChanged = previous != null && previous[0] !== lines
    const previousSnapshot = previous?.[1]
    const epochChanged = previousSnapshot != null && previousSnapshot.epoch !== snapshot.epoch
    if (linesChanged) lyricPlayheadState = createLyricPlayheadState()
    syncActiveLyricIndex(snapshot.position, linesChanged || epochChanged)
    if (epochChanged && !linesChanged) void lyricViewport.recenter('snap')
  },
  { immediate: true }
)

watch(
  activeLyricIndex,
  (index) => {
    highlightedLyricIndex.value = index
  },
  { immediate: true }
)

watch(
  () => currentTrack.value?.id,
  () => {
    highlightedLyricIndex.value = activeLyricIndex.value
  }
)

const renderedLyricLines = computed(() =>
  displayLyricLines.value.map((line, index) => ({
    index,
    line,
    singing: lyricHotIndices.value.has(index),
    presented: lyricBufferedIndices.value.has(index),
    ariaLabel: resolveLyricVoiceLayout(line).ariaText || line.text
  }))
)

function setLyricLineRef(index: number, el: Element | ComponentPublicInstance | null): void {
  const element = el instanceof HTMLElement ? el : null
  const previous = lyricRowElements.get(index)
  if (!element && previous?.isConnected) {
    lyricViewport.registerRow(index, null)
    return
  }
  if (previous && previous !== element) lyricResizeObserver?.unobserve(previous)
  if (element) {
    lyricRowElements.set(index, element)
    lyricResizeObserver?.observe(element)
  } else {
    lyricRowElements.delete(index)
  }
  lyricViewport.registerRow(index, element)
}

function jumpToLyric(time: number | null): void {
  if (time == null) return
  lyricViewport.releaseManualBrowse()
  seek(Math.max(0, time - currentLyricOffsetSeconds.value))
}

/**
 * The stage is `overflow: hidden` and positions rows itself, so there is no
 * native scroll to intercept. That is what lets these stay passive listeners:
 * the wheel delta is read and fed to the controller, never prevented.
 */
let lyricTouchY: number | null = null

function onLyricsTouchStart(event: TouchEvent): void {
  lyricTouchY = event.touches[0]?.clientY ?? null
  lyricViewport.beginManualBrowse()
}

function onLyricsTouchMove(event: TouchEvent): void {
  const nextY = event.touches[0]?.clientY
  if (nextY == null || lyricTouchY == null) {
    lyricViewport.beginManualBrowse()
    lyricTouchY = nextY ?? null
    return
  }
  lyricViewport.browseBy(lyricTouchY - nextY)
  lyricTouchY = nextY
}

function onLyricsTouchEnd(): void {
  lyricTouchY = null
}

function onLyricsManualScroll(event: WheelEvent): void {
  if (Number.isFinite(event.deltaY)) {
    const delta = event.deltaMode === 0 ? event.deltaY : event.deltaY * 50
    lyricViewport.browseBy(delta)
  }
}

function onLyricContentResize(): void {
  lyricViewport.onResize('spring')
}

function onLyricViewportResize(): void {
  lyricViewport.onResize('snap')
}

function onLyricVisibilityChange(): void {
  void lyricViewport.recenter('snap')
}

watch(activeLyricIndex, (index) => {
  if (index < 0) return
  if (lyricViewport.isManualBrowsing()) return
  void lyricViewport.follow(index)
})

watch(lyricsEl, (el, previousEl) => {
  if (previousEl) {
    lyricResizeObserver?.unobserve(previousEl)
    lyricViewport.detach(previousEl)
  }
  if (el) {
    lyricViewport.attach(el)
    lyricResizeObserver?.observe(el)
    void lyricViewport.recenter('snap')
  }
})

watch(
  [hasLyrics, viewMode, lyricMotionLevel, isPlaying],
  () => {
    void lyricViewport.recenter(lyricMotionFull.value ? 'resize' : 'snap')
  },
  { flush: 'post' }
)

onMounted(() => {
  void lyricsManagement.ensureLoaded()
  lyricResizeObserver = new ResizeObserver(() => {
    onLyricContentResize()
  })
  for (const row of lyricRowElements.values()) lyricResizeObserver.observe(row)
  if (lyricsEl.value) {
    lyricViewport.attach(lyricsEl.value)
    lyricResizeObserver.observe(lyricsEl.value)
  }
  readLyricMotionLevel()
  void lyricViewport.recenter('snap')
  lyricMotionObserver = new MutationObserver(readLyricMotionLevel)
  lyricMotionObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-te-motion']
  })
  window.addEventListener('resize', onLyricViewportResize)
  window.addEventListener('pointerdown', closeAppearanceMenu)
  document.addEventListener('visibilitychange', onLyricVisibilityChange)
})

onBeforeUnmount(() => {
  lyricViewport.dispose()
  lyricResizeObserver?.disconnect()
  lyricResizeObserver = null
  lyricRowElements.clear()
  lyricMotionObserver?.disconnect()
  lyricMotionObserver = null
  window.removeEventListener('resize', onLyricViewportResize)
  window.removeEventListener('pointerdown', closeAppearanceMenu)
  document.removeEventListener('visibilitychange', onLyricVisibilityChange)
})
</script>

<template>
  <div
    class="playing-music"
    :class="`bg-${nowPlayingBackground}`"
    :style="{ '--accent-color': dominantColor }"
    @contextmenu.prevent="openAppearanceMenu"
  >
    <button
      type="button"
      class="visualizer-toggle-button"
      :class="{ 'visualizer-toggle-button--close': viewMode === 'visualizer' }"
      :title="viewMode === 'cover' ? '音频可视化' : '返回封面'"
      @click="toggleVisualizer"
    >
      <i :class="viewMode === 'cover' ? 'pi pi-chart-bar' : 'pi pi-times'"></i>
    </button>

    <div v-if="viewMode !== 'visualizer'" class="backdrop" aria-hidden="true">
      <Transition name="backdrop-cover-fade" appear>
        <div
          v-if="isBlurBackground && currentTrack"
          :key="`bg:${coverIdentity}`"
          class="backdrop-cover-wrap"
        >
          <CoverImg
            :cover="currentTrack.cover"
            :cover-source="currentTrack.coverSource"
            :identity="currentTrack.id"
            class="backdrop-cover"
            alt=""
          />
        </div>
      </Transition>
      <div v-if="isFluidBackground" class="backdrop-fluid" />
      <div v-if="isSolidBackground" class="backdrop-solid" />
      <div class="backdrop-scrim" />
      <div class="backdrop-accent" />
    </div>

    <div
      v-if="currentTrack"
      :key="`stage:${coverIdentity}`"
      :class="['stage', { 'stage--visualizer': viewMode === 'visualizer' }]"
    >
      <AudioVisualizerPanel
        v-if="viewMode === 'visualizer'"
        class="visualizer-surface"
        :active="viewMode === 'visualizer'"
      />
      <main
        v-else
        class="layout"
        :class="{ 'layout--single': !reserveLyricsColumn }"
        :style="layoutStyle"
      >
        <section class="cover-column">
          <div class="cover-frame" :style="coverStyle">
            <CoverImg
              v-if="currentTrack.cover || currentTrack.coverSource"
              :cover="currentTrack.cover"
              :cover-source="currentTrack.coverSource"
              :identity="currentTrack.id"
              class="cover-image"
              alt="cover"
            />
            <div v-else class="cover-placeholder">
              <i class="pi pi-wave-pulse"></i>
            </div>
          </div>

          <div class="cover-meta">
            <h1 class="track-title">{{ currentTrack.title }}</h1>
            <p class="track-artist">{{ currentTrack.artist }}</p>
            <p v-if="currentTrack.album" class="track-album">{{ currentTrack.album }}</p>
          </div>
        </section>

        <section
          v-if="reserveLyricsColumn"
          class="lyrics-column lyrics-column--depth"
          :class="{
            'lyrics-column--pending': !hasLyrics,
            'lyrics-column--karaoke-disabled': !lyricsAppearance.karaokeEnabled
          }"
          :style="lyricStyle"
        >
          <div class="lyrics-head">
            <PlayingMusicTimeChip />
          </div>

          <div
            ref="lyricsEl"
            class="lyrics-scroll"
            :class="lyricAlignClass"
            @wheel.passive="onLyricsManualScroll"
            @touchstart.passive="onLyricsTouchStart"
            @touchmove.passive="onLyricsTouchMove"
            @touchend.passive="onLyricsTouchEnd"
            @touchcancel.passive="onLyricsTouchEnd"
          >
            <div v-if="!hasLyrics" class="lyrics-pending" aria-live="polite">
              {{ lyricsPendingLabel }}
            </div>
            <div
              v-if="hasLyrics && lyricInterludeDotsTop != null"
              class="lyric-interlude-dots"
              :style="{ '--lyric-interlude-top': `${lyricInterludeDotsTop}px` }"
              aria-hidden="true"
            >
              <span></span><span></span><span></span>
            </div>
            <div v-if="hasLyrics" class="lyrics-list">
              <button
                v-for="item in renderedLyricLines"
                :key="item.line.rowKey ?? `${item.line.time}-${item.index}`"
                :ref="(el) => setLyricLineRef(item.index, el)"
                type="button"
                class="lyric-row"
                :class="[
                  {
                    active: item.singing,
                    'is-singing': item.singing,
                    'is-presented': item.presented,
                    'is-anchor': item.index === highlightedLyricIndex,
                    'is-plain': !item.line.timed,
                    'lyric-row--custom-background':
                      lyricTextStyle[item.singing ? 'active' : 'normal'].backgroundStyle !== 'none'
                  }
                ]"
                :aria-current="item.index === highlightedLyricIndex ? 'true' : undefined"
                :aria-label="item.ariaLabel"
                :style="lyricStyleVars(item.singing ? 'active' : 'normal')"
                :disabled="!item.line.timed"
                @pointerdown.stop
                @click="jumpToLyric(item.line.time)"
              >
                <PlayingLyricLine
                  :line="item.line"
                  :singing="item.singing"
                  :offset-seconds="currentLyricOffsetSeconds"
                  :clock="lyricWordClock"
                  :karaoke-enabled="lyricsAppearance.karaokeEnabled"
                  :motion-mode="lyricMotionLevel"
                  :align="lyricAlign"
                  :translation-style="lyricStyleVars('translation')"
                  :romanization-style="lyricStyleVars('romanization')"
                />
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>

    <div v-else class="empty-shell">
      <div class="empty-state">
        <i class="pi pi-wave-pulse"></i>
        <p>暂无正在播放的歌曲</p>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="appearanceMenuOpen"
        class="player-appearance-menu"
        :style="{
          left: `${appearanceMenuPosition.x}px`,
          top: `${appearanceMenuPosition.y}px`
        }"
        @pointerdown.stop
      >
        <button type="button" @click="customizeLyricsAppearance">
          <i class="ph ph-text-aa"></i><span>个性化歌词</span>
        </button>
        <button type="button" @click="customizePlayerAppearance">
          <i class="ph ph-palette"></i><span>定制此区域外观</span>
        </button>
      </div>
    </Teleport>
    <Teleport to="body">
      <LyricsAppearanceCustomizer
        :open="lyricsCustomizerOpen"
        @close="lyricsCustomizerOpen = false"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.playing-music {
  position: fixed;
  inset: 0;
  z-index: 1100;
  overflow: hidden;
  color: var(--te-playback-page-text, #f4f7fb);
  background-color: var(--te-player-bg);
  background-image: var(--te-player-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  --accent-color: var(--te-playback-accent, #7c4dff);
}

.player-appearance-menu {
  position: fixed;
  z-index: 10000;
  width: 218px;
  padding: 5px;
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  box-shadow: var(--te-glass-shadow);
  background: var(--te-card-bg);
}

.player-appearance-menu button {
  display: flex;
  width: 100%;
  min-height: 36px;
  align-items: center;
  gap: 9px;
  padding: 0 9px;
  border: 0;
  border-radius: 4px;
  color: var(--te-neutral-900);
  text-align: left;
  background: transparent;
  cursor: pointer;
}

.player-appearance-menu button:hover {
  color: var(--te-primary-500);
  background: var(--te-hover-bg);
}

.backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  background-color: var(--te-player-bg);
  background-image: var(--te-player-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}

.backdrop-cover-wrap {
  position: absolute;
  inset: 0;
}
.backdrop-cover-wrap :deep(img),
.backdrop-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  transform: scale(1.06);
  transform-origin: center;
  filter: blur(58px) saturate(1.28) brightness(0.42);
  will-change: opacity, transform;
}

/* Light theme: slightly brighter backdrop art so the stage does not crush blacks */
:global(html[data-theme='light'] .playing-music .backdrop-cover-wrap img),
:global(html[data-theme='pureWhite'] .playing-music .backdrop-cover-wrap img) {
  filter: var(--te-playback-backdrop-filter, blur(58px) saturate(1.22) brightness(0.52));
}

:global(html[data-theme='dark'] .playing-music .backdrop-cover-wrap img) {
  filter: var(--te-playback-backdrop-filter, blur(58px) saturate(1.32) brightness(0.36));
}

.backdrop-cover-fade-enter-active,
.backdrop-cover-fade-leave-active {
  transition:
    opacity 0.7s ease,
    transform 0.7s ease;
}

.backdrop-cover-fade-enter-from {
  opacity: 0;
  transform: translateY(-18px) scale(1.09);
}

.backdrop-cover-fade-enter-to {
  opacity: 1;
  transform: translateY(0) scale(1.06);
}

.backdrop-cover-fade-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1.06);
}

.backdrop-cover-fade-leave-to {
  opacity: 0;
  transform: translateY(18px) scale(1.09);
}

.backdrop-scrim {
  position: absolute;
  inset: 0;
  background:
    var(
      --te-playback-backdrop-scrim,
      linear-gradient(
        180deg,
        rgba(5, 7, 11, 0.72) 0%,
        rgba(5, 7, 11, 0.74) 52%,
        rgba(5, 7, 11, 0.78) 100%
      )
    ),
    color-mix(in srgb, var(--accent-color) 8%, transparent);
  backdrop-filter: blur(10px);
}

.backdrop-accent {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(
      circle at 18% 26%,
      color-mix(in srgb, var(--accent-color) 22%, transparent),
      transparent 42%
    ),
    radial-gradient(
      circle at 88% 20%,
      var(--te-playback-backdrop-highlight, rgba(255, 255, 255, 0.12)),
      transparent 26%
    );
  opacity: 0.8;
}

.backdrop-fluid {
  position: absolute;
  inset: 0;
  background: var(
    --te-playback-fluid-bg,
    linear-gradient(135deg, #0f172a, #1e3a5f, #312e81, #1e3a5f, #0f172a)
  );
  background-size: 400% 400%;
  animation: fluid-drift 18s ease-in-out infinite;
}

.backdrop-solid {
  position: absolute;
  inset: 0;
  background-color: var(--te-player-bg);
  background-image: var(--te-player-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}

@keyframes fluid-drift {
  0%,
  100% {
    background-position: 0% 50%;
  }
  25% {
    background-position: 100% 50%;
  }
  50% {
    background-position: 100% 100%;
  }
  75% {
    background-position: 0% 100%;
  }
}

.stage {
  position: relative;
  z-index: 1;
  width: min(100%, 1560px);
  height: 100%;
  margin: 0 auto;
  padding: 72px 36px 28px;
}

.stage--visualizer {
  width: 100vw;
  height: 100vh;
  max-width: none;
  margin: 0;
  padding: 0;
}

.layout {
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: var(--te-lyric-cover-gap, 40px);
  align-items: stretch;
  height: 100%;
  min-height: 0;
}

.layout--single {
  grid-template-columns: minmax(300px, 440px);
  align-content: center;
  justify-content: center;
}

.layout--single .cover-column {
  width: min(100%, 440px);
  justify-self: center;
  transform: none;
}

.layout--single .cover-meta {
  text-align: center;
}

.cover-column {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  align-self: center;
}

@media (min-width: 1121px) {
  :global(html[data-te-player-layout='standard'] .playing-music .cover-column) {
    transform: translateX(clamp(42px, 5vw, 80px));
  }
}

.cover-frame {
  width: var(--te-playback-cover-size, 100%);
  max-width: 100%;
  margin-inline: auto;
  aspect-ratio: 1;
  border-radius: var(--te-playback-cover-radius, 26px);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: 0 26px 70px rgba(0, 0, 0, 0.38);
}

:global(html[data-te-motion='full'] .cover-frame) {
  animation: te-playing-artwork-arrive var(--te-motion-page) var(--te-ease-spring) both;
}

@keyframes te-playing-artwork-arrive {
  from {
    opacity: 0;
    scale: 0.9;
  }
}

:global(html[data-theme='dark'] .playing-music .cover-frame) {
  background: var(--te-playback-cover-surface, rgba(15, 23, 42, 0.45));
  box-shadow: var(
    --te-playback-cover-shadow,
    0 26px 70px rgba(0, 0, 0, 0.55),
    inset 0 0 0 1px rgba(255, 255, 255, 0.06)
  );
}

:global(html[data-theme='light'] .playing-music .cover-frame),
:global(html[data-theme='pureWhite'] .playing-music .cover-frame) {
  background: var(--te-playback-cover-surface, rgba(15, 23, 42, 0.08));
  box-shadow: var(--te-playback-cover-shadow, 0 26px 70px rgba(15, 23, 42, 0.28));
}

:global(html[data-te-artwork-shadow='off'] .playing-music .cover-frame) {
  box-shadow: none;
}

.cover-frame :deep(img.cover-image),
.cover-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 68px;
  color: var(--te-playback-cover-placeholder-text, rgba(255, 255, 255, 0.34));
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02)),
    color-mix(in srgb, var(--accent-color) 18%, transparent);
}

:global(html[data-theme='dark'] .playing-music .cover-placeholder) {
  color: var(--te-playback-cover-placeholder-text, rgba(148, 163, 184, 0.55));
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.01)),
    color-mix(in srgb, var(--accent-color) 22%, rgba(15, 23, 42, 0.65));
}

.cover-meta {
  min-width: 0;
}

:global(html[data-te-motion='full'] .cover-meta) {
  animation: te-playing-meta-arrive var(--te-motion-panel) var(--te-ease-spring) 36ms both;
}

@keyframes te-playing-meta-arrive {
  from {
    opacity: 0;
    translate: 0 12px;
  }
}

.track-title {
  margin: 0;
  font-family: var(--te-font-display);
  font-size: 32px;
  font-weight: 400;
  line-height: 1.22;
  color: var(--te-playback-track-title, #fff);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.track-artist {
  margin: 10px 0 0;
  font-family: var(--te-font-rounded);
  font-size: 18px;
  font-weight: 700;
  color: var(--te-playback-track-artist, rgba(255, 255, 255, 0.78));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-album {
  margin: 4px 0 0;
  font-family: var(--te-font-rounded);
  font-size: 14px;
  font-weight: 500;
  color: var(--te-playback-track-album, rgba(255, 255, 255, 0.48));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lyrics-column {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-left: 6px;
  align-self: stretch;
  transform: translateX(var(--te-lyric-offset-x, 0px));
}

.lyrics-column--pending {
  pointer-events: none;
}

.lyrics-pending {
  flex: 1;
  display: grid;
  place-items: center;
  min-height: 120px;
  font-family: var(--te-lyric-font-family, inherit);
  color: var(--te-playback-lyric-text, rgba(255, 255, 255, 0.42));
  font-size: 14px;
  letter-spacing: 0.08em;
}

.lyrics-head {
  display: flex;
  align-items: end;
  justify-content: flex-end;
  gap: 16px;
  padding-bottom: 18px;
  min-width: 0;
}

.time-chip {
  flex-shrink: 0;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--te-playback-control-border, rgba(255, 255, 255, 0.1));
  background: var(--te-playback-control-surface, rgba(255, 255, 255, 0.08));
  color: var(--te-playback-control-text, rgba(255, 255, 255, 0.7));
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/*
 * The stage no longer scrolls. Rows are absolutely positioned and moved by their
 * own springs, which is what allows lines to arrive at different times;
 * `scrollTop` clamps and quantises and could not do that. Keeping it
 * `hidden` also means the wheel listener never has to call preventDefault.
 */
.lyrics-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding-right: 8px;
  -ms-overflow-style: none;
  scrollbar-width: none !important;
  scroll-behavior: auto;
  overscroll-behavior: contain;
  mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(0, 0, 0, 0.26) 6%,
    rgba(0, 0, 0, 1) 18%,
    rgba(0, 0, 0, 1) 82%,
    rgba(0, 0, 0, 0.26) 94%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(0, 0, 0, 0.26) 6%,
    rgba(0, 0, 0, 1) 18%,
    rgba(0, 0, 0, 1) 82%,
    rgba(0, 0, 0, 0.26) 94%,
    transparent 100%
  );
}

.lyrics-scroll::-webkit-scrollbar {
  display: none !important;
  width: 0;
  height: 0;
}

.lyrics-scroll::-webkit-scrollbar-thumb {
  border: 0 !important;
  background: transparent !important;
}

.lyrics-list {
  position: absolute;
  inset: 0;
  max-width: var(--te-lyric-max-width, 820px);
  margin: 0 auto;
}

.lyric-interlude-dots {
  position: absolute;
  left: 50%;
  top: var(--lyric-interlude-top, 0);
  display: flex;
  gap: 0.35em;
  transform: translateX(-50%);
  pointer-events: none;
}

.lyric-interlude-dots span {
  width: clamp(6px, 0.8vh, 12px);
  height: clamp(6px, 0.8vh, 12px);
  border-radius: 50%;
  background: var(--te-playback-lyric-active-text, #fff);
  opacity: 0.5;
  animation: lyric-interlude-pulse 1.8s ease-in-out infinite;
}

.lyric-interlude-dots span:nth-child(2) {
  animation-delay: 0.22s;
}

.lyric-interlude-dots span:nth-child(3) {
  animation-delay: 0.44s;
}

@keyframes lyric-interlude-pulse {
  0%,
  100% {
    opacity: 0.32;
    transform: scale(0.86);
  }
  50% {
    opacity: 0.9;
    transform: scale(1.08);
  }
}

:global(html[data-te-motion='reduced'] .lyric-interlude-dots span),
:global(html[data-te-motion='off'] .lyric-interlude-dots span) {
  animation: none;
}

.lyric-row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid transparent;
  border-radius: 18px;
  background: var(--lyric-style-background, transparent);
  background-image: var(--lyric-style-background-image, none);
  backdrop-filter: var(--lyric-style-backdrop-filter, none);
  -webkit-backdrop-filter: var(--lyric-style-backdrop-filter, none);
  padding: 12px 20px;
  font-family: var(--lyric-style-font-family, var(--te-lyric-font-family, inherit));
  font-weight: var(--lyric-style-font-weight, var(--te-lyric-font-weight, 600));
  font-style: var(--lyric-style-font-style, normal);
  text-align: var(--lyric-style-align, center);
  cursor: pointer;
  color: var(--lyric-style-color, var(--te-playback-lyric-text, rgba(255, 255, 255, 0.42)));
  opacity: calc(
    var(--lyric-line-ready, 0) * var(--lyric-line-opacity, 1) * var(--lyric-style-opacity, 1)
  );
  /*
   * Driven entirely by the controller's springs. No transition on transform or
   * filter: the spring already carries the timing, and a transition on top would
   * fight it and smear the cascade.
   */
  transform: translate3d(0, var(--lyric-line-top, 0px), 0);
  filter: blur(var(--lyric-line-blur, 0px));
  backface-visibility: hidden;
  contain: layout style;
  contain-intrinsic-size: auto 4em;
  transition:
    color var(--te-motion-hover) ease,
    background var(--te-motion-hover) ease;
}

/* Culled rows keep their box for measurement but stop painting. */
.lyric-row[style*='--lyric-line-in-sight: 0'] {
  content-visibility: hidden;
}

.lyric-row-content {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  overflow: visible;
  transform: scale(var(--lyric-line-scale, 1));
  transform-origin: center;
  will-change: transform;
}

.lyric-row:hover {
  color: var(--te-playback-lyric-hover-text, rgba(255, 255, 255, 0.74));
}

.lyric-row.active {
  color: var(--lyric-style-color, var(--te-playback-lyric-active-text, #fff));
  background: var(--lyric-style-background, transparent);
  border-color: var(--te-playback-lyric-active-border, transparent);
  box-shadow: var(--te-playback-lyric-active-shadow, none);
}

/*
 * A row that carries its own surface needs a visible edge and a little breathing
 * room, otherwise the background reads as a rectangle glued to the text.
 */
.lyric-row--custom-background {
  border-color: color-mix(in srgb, var(--lyric-style-background, transparent) 70%, transparent);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
}

.lyric-text {
  min-width: 0;
  width: 100%;
  font-size: clamp(12px, var(--lyric-style-font-size, var(--te-lyric-font-size, 18px)), 48px);
  line-height: var(--lyric-style-line-height, var(--te-lyric-line-height, 1.85));
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  text-align: var(--lyric-style-align, center);
  word-break: break-word;
}

.lyrics-scroll.lyric-align-left .lyric-text,
.lyrics-scroll.lyric-align-left .lyric-translation,
.lyrics-scroll.lyric-align-left .lyric-romanization {
  text-align: left;
}

.lyric-row.active .lyric-text {
  font-weight: var(--lyric-style-font-weight, var(--te-lyric-font-weight, 600));
  /* The active line adds a hair of tracking on top of whatever the style asks for. */
  letter-spacing: calc(var(--lyric-style-letter-spacing, 0em) + 0.012em);
  text-shadow: var(--lyric-style-highlight, none);
  -webkit-text-stroke: var(--lyric-style-stroke, 0 transparent);
}

:global(html[data-te-motion='full'] .lyric-row--exiting) {
  pointer-events: none;
}

:global(html[data-te-motion='full'] .lyric-row--exiting .lyric-row-content),
:global(html[data-te-motion='full'] .lyric-row--entering .lyric-row-content) {
  /* The row itself already transitions its active/near scale. Avoid a second
     content transform here, which causes a visible shrink-and-snap-back on
     the previous line and a grow-and-snap-back on the new active line. */
  animation: none;
}

.lyric-text--words {
  display: inline;
}

/*
 * The karaoke sweep is now a mask on the word itself, animated by the Web
 * Animations API. The old approach duplicated every word into an `::after`
 * overlay and cross-faded it, which paid for a second text layer per word and
 * still had to be driven from JavaScript each frame. One masked layer is cheaper
 * and cannot tear away from the text it is revealing.
 *
 * `mask-image`, `mask-size` and friends are set inline by the component, because
 * the gradient geometry depends on the measured width of each word.
 */
.lyric-space {
  white-space: pre;
}

.lyric-word-group {
  display: inline-block;
  white-space: pre-wrap;
}

:deep(.lyric-word) {
  display: inline-block;
  white-space: pre;
  /* Padding plus a matching negative margin gives the glow room to spill without
     changing where the glyphs sit. */
  padding: 0.35em;
  margin: -0.35em;
  backface-visibility: hidden;
}

:deep(.lyric-char) {
  display: inline-block;
  padding: 0.35em;
  margin: -0.35em;
  will-change: transform;
  backface-visibility: hidden;
}

/*
 * Contrast between sung and unsung text is driven by how focused the line is, so
 * a receding line loses its karaoke definition instead of shouting from the back.
 */
.lyric-row {
  --lyric-bright-mask-alpha: 1;
  --lyric-dark-mask-alpha: 0.4;
}

.lyric-row.active {
  --lyric-bright-mask-alpha: 1;
  --lyric-dark-mask-alpha: 0.32;
}

:global(html[data-te-motion='reduced'] .lyric-row),
:global(html[data-te-motion='off'] .lyric-row) {
  filter: none !important;
}

:global(html[data-te-motion='reduced'] .lyric-row-content),
:global(html[data-te-motion='off'] .lyric-row-content) {
  transform: none !important;
}

:global(html[data-te-motion='reduced'] .lyric-word),
:global(html[data-te-motion='off'] .lyric-word),
:global(html[data-te-motion='reduced'] .lyric-char),
:global(html[data-te-motion='off'] .lyric-char) {
  transform: none !important;
  text-shadow: none !important;
}

/* Reduced motion keeps the fill legible but stops it sweeping. */
:global(html[data-te-motion='reduced'] .lyric-word),
:global(html[data-te-motion='off'] .lyric-word) {
  mask-image: none !important;
  -webkit-mask-image: none !important;
}

.lyrics-column--karaoke-disabled :deep(.lyric-word) {
  color: inherit;
  mask-image: none;
  -webkit-mask-image: none;
}

.lyric-translation {
  min-width: 0;
  width: 100%;
  margin-top: var(--te-lyric-translation-spacing, 0);
  padding: 3px 7px;
  border-radius: 9px;
  font-family: var(--lyric-style-font-family, var(--te-lyric-font-family, inherit));
  font-size: clamp(12px, var(--lyric-style-font-size, var(--te-lyric-font-size, 18px)), 48px);
  font-weight: var(--lyric-style-font-weight, 500);
  font-style: var(--lyric-style-font-style, normal);
  line-height: var(--lyric-style-line-height, 1.45);
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  text-align: var(--lyric-style-align, center);
  color: var(--lyric-style-color, var(--te-playback-lyric-translation, rgba(255, 255, 255, 0.58)));
  opacity: var(--lyric-style-opacity, 1);
  background: var(--lyric-style-background, transparent);
  background-image: var(--lyric-style-background-image, none);
  backdrop-filter: var(--lyric-style-backdrop-filter, none);
  -webkit-backdrop-filter: var(--lyric-style-backdrop-filter, none);
  text-shadow: var(--lyric-style-highlight, none);
  -webkit-text-stroke: var(--lyric-style-stroke, 0 transparent);
  word-break: break-word;
  transition:
    opacity var(--te-motion-hover) ease,
    color var(--te-motion-hover) ease,
    background var(--te-motion-hover) ease,
    text-shadow var(--te-motion-hover) ease;
}

.lyric-row.active .lyric-translation {
  color: var(
    --lyric-style-color,
    var(--te-playback-lyric-translation-active, rgba(255, 255, 255, 0.82))
  );
}

.lyric-romanization {
  min-width: 0;
  width: 100%;
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
  text-align: var(--lyric-style-align, center);
  color: var(--lyric-style-color, var(--te-playback-lyric-romanization, rgba(255, 255, 255, 0.46)));
  opacity: var(--lyric-style-opacity, 1);
  background: var(--lyric-style-background, transparent);
  background-image: var(--lyric-style-background-image, none);
  backdrop-filter: var(--lyric-style-backdrop-filter, none);
  -webkit-backdrop-filter: var(--lyric-style-backdrop-filter, none);
  text-shadow: var(--lyric-style-highlight, none);
  -webkit-text-stroke: var(--lyric-style-stroke, 0 transparent);
  word-break: break-word;
}

.lyric-row.active .lyric-romanization {
  color: var(
    --lyric-style-color,
    var(--te-playback-lyric-romanization-active, rgba(255, 255, 255, 0.72))
  );
}

.empty-shell {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: min(100%, 1560px);
  height: 100%;
  margin: 0 auto;
  padding: 40px 36px 28px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: var(--te-playback-lyric-text, rgba(255, 255, 255, 0.42));
  font-size: 14px;
}

.empty-state i {
  font-size: 42px;
  color: rgba(255, 255, 255, 0.16);
}

.empty-state p {
  margin: 0;
}

@media (prefers-contrast: more) {
  .lyric-row {
    --lyric-bright-mask-alpha: 1;
    --lyric-dark-mask-alpha: 0.72;
    filter: none !important;
    text-shadow: none !important;
  }

  .lyric-row:not(.is-singing) {
    opacity: calc(
      var(--lyric-line-ready, 0) * max(0.78, var(--lyric-line-opacity, 1)) *
        var(--lyric-style-opacity, 1)
    );
  }
}

@media (prefers-reduced-transparency: reduce) {
  .lyrics-column,
  .lyric-row,
  .lyric-translation,
  .lyric-romanization {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}

@media (max-width: 1120px) {
  .stage,
  .empty-shell {
    padding: 38px 22px 20px;
  }

  .layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    /* A single column stacks, so the configured side-by-side gap would be far too
       generous here; cap it rather than ignore it outright. */
    gap: min(var(--te-lyric-cover-gap, 40px), 28px);
  }

  .lyrics-column {
    padding-left: 0;
    border-left: none;
    transform: none;
  }

  .cover-column {
    display: grid;
    grid-template-columns: minmax(132px, 180px) minmax(0, 1fr);
    align-items: center;
    gap: 22px;
    width: min(100%, 720px);
    justify-self: center;
    align-self: stretch;
    transform: none;
  }

  .cover-frame {
    width: min(100%, 180px);
    margin-inline: 0;
  }

  .cover-meta {
    align-self: center;
  }

  .lyrics-list {
    padding-top: 4vh;
  }
}

@media (max-width: 760px) {
  .stage,
  .empty-shell {
    padding: 34px 16px 16px;
  }

  .track-title {
    font-size: 28px;
  }

  .track-artist {
    font-size: 16px;
  }

  .lyrics-list {
    padding: 2vh 0 18vh;
  }

  .lyric-row {
    padding-inline: 12px;
  }
}

/* Visualizer toggle — same frosted chip style as the time chip */
.visualizer-toggle-button {
  position: fixed;
  top: 42px;
  left: 42px;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  background: var(--te-playback-control-surface, rgba(255, 255, 255, 0.08));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--te-playback-control-border, rgba(255, 255, 255, 0.1));
  box-shadow: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--te-playback-control-text, rgba(255, 255, 255, 0.7));
  font-size: 16px;
  transition:
    background var(--te-motion-hover) ease,
    border-color var(--te-motion-hover) ease,
    color var(--te-motion-hover) ease,
    transform var(--te-motion-hover) var(--te-ease-spring),
    box-shadow var(--te-motion-hover) ease;
  z-index: 1200;
}

.visualizer-toggle-button:hover {
  background: var(--te-playback-control-hover-surface, rgba(255, 255, 255, 0.14));
  border-color: var(--te-playback-control-hover-border, rgba(255, 255, 255, 0.16));
  color: var(--te-playback-control-hover-text, rgba(255, 255, 255, 0.92));
  transform: scale(1.06);
  box-shadow: var(--te-playback-control-hover-shadow, 0 4px 12px rgba(0, 0, 0, 0.18));
}

.visualizer-toggle-button--close {
  z-index: 10000;
}

.visualizer-toggle-button--close:hover {
  background: var(--te-playback-control-hover-surface, rgba(255, 255, 255, 0.14));
  border-color: var(--te-playback-control-hover-border, rgba(255, 255, 255, 0.16));
  transform: scale(1.06);
  box-shadow: var(--te-playback-control-hover-shadow, 0 4px 12px rgba(0, 0, 0, 0.18));
}

/* Visualizer surface fills the stage area */
.visualizer-surface {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

:global(html[data-theme='dark'] .playing-music .visualizer-toggle-button) {
  background: var(--te-playback-control-surface, rgba(255, 255, 255, 0.08));
  border-color: var(--te-playback-control-border, rgba(255, 255, 255, 0.1));
  color: var(--te-playback-control-text, rgba(255, 255, 255, 0.7));
}

:global(html[data-theme='dark'] .playing-music .visualizer-toggle-button:hover) {
  background: var(--te-playback-control-hover-surface, rgba(255, 255, 255, 0.14));
  border-color: var(--te-playback-control-hover-border, rgba(255, 255, 255, 0.16));
  color: var(--te-playback-control-hover-text, rgba(255, 255, 255, 0.92));
}

:global(html[data-theme='dark'] .playing-music .visualizer-toggle-button--close) {
  background: var(--te-playback-control-surface, rgba(255, 255, 255, 0.08));
  border-color: var(--te-playback-control-border, rgba(255, 255, 255, 0.1));
  box-shadow: none;
}

:global(html[data-theme='dark'] .playing-music .visualizer-toggle-button--close:hover) {
  background: var(--te-playback-control-hover-surface, rgba(255, 255, 255, 0.14));
  border-color: var(--te-playback-control-hover-border, rgba(255, 255, 255, 0.16));
  box-shadow: var(--te-playback-control-hover-shadow, 0 4px 12px rgba(0, 0, 0, 0.18));
}

@keyframes te-artwork-fade {
  from {
    opacity: 0;
  }
}

@keyframes te-artwork-slide {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
}

:global(html[data-te-artwork-transition='fade'] .playing-music .cover-frame) {
  animation: te-artwork-fade 0.42s var(--te-ease-enter, ease-out) both;
}

:global(html[data-te-artwork-transition='slide'] .playing-music .cover-frame) {
  animation: te-artwork-slide 0.46s var(--te-ease-soft, ease-out) both;
}

:global(html[data-te-artwork-transition='none'] .playing-music .cover-frame) {
  animation: none;
}

:global(html[data-te-player-title-align='center'] .playing-music .cover-meta) {
  text-align: center;
}

:global(html[data-te-player-layout='full-cover'] .playing-music .stage) {
  width: 100%;
  max-width: none;
  padding: 0;
}

:global(html[data-te-player-layout='full-cover'] .playing-music .layout) {
  display: block;
  position: absolute;
  inset: 0;
  height: 100%;
  min-height: 0;
}

:global(html[data-te-player-layout='full-cover'] .playing-music .cover-column) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: block;
  transform: none;
}

:global(html[data-te-player-layout='full-cover'] .playing-music .cover-frame) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0;
  aspect-ratio: auto;
}

:global(html[data-te-player-layout='full-cover'] .playing-music .cover-meta) {
  position: absolute;
  left: clamp(28px, 6vw, 92px);
  bottom: 118px;
  z-index: 1;
  width: min(520px, calc(100vw - 56px));
  padding: 18px 20px;
  border-radius: var(--te-player-time-radius, 8px);
  background: color-mix(in srgb, var(--te-playback-control-surface) 86%, transparent);
  backdrop-filter: blur(18px) saturate(130%);
}

:global(html[data-te-player-layout='full-cover'] .playing-music .lyrics-column) {
  position: absolute;
  top: 76px;
  right: clamp(24px, 5vw, 78px);
  bottom: 118px;
  z-index: 1;
  width: min(44vw, 680px);
  padding: 16px 18px;
  border: 0;
  border-radius: 0;
  background: transparent;
  backdrop-filter: none;
}

:global(html[data-te-player-layout='lyrics-focus'] .playing-music .layout) {
  grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
  gap: clamp(24px, 4vw, 64px);
}

:global(html[data-te-player-layout='lyrics-focus'] .playing-music .cover-column) {
  align-self: start;
  margin-top: 10vh;
  transform: none;
}

:global(html[data-te-player-layout='lyrics-focus'] .playing-music .cover-meta) {
  text-align: center;
}

:global(html[data-te-player-layout='lyrics-focus'] .playing-music .track-title) {
  font-size: 24px;
}

:global(html[data-te-player-layout='lyrics-focus'] .playing-music .lyrics-list) {
  max-width: 980px;
}

:global(html[data-te-player-layout='split'] .playing-music .layout) {
  grid-template-columns: minmax(280px, 0.82fr) minmax(420px, 1.38fr);
  gap: clamp(32px, 5vw, 84px);
}

:global(html[data-te-player-layout='split'] .playing-music .cover-column) {
  width: min(100%, 520px);
  justify-self: end;
  transform: none;
}

:global(html[data-te-player-layout='minimal'] .playing-music .layout) {
  display: grid;
  grid-template-columns: minmax(280px, 460px);
  place-content: center;
}

:global(html[data-te-player-layout='minimal'] .playing-music .cover-column) {
  width: min(100%, 460px);
  justify-self: center;
  transform: none;
}

:global(html[data-te-player-layout='minimal'] .playing-music .lyrics-column) {
  display: none;
}

:global(html[data-te-player-layout='minimal'] .playing-music .cover-meta) {
  text-align: center;
}

:global(html[data-te-visible-player-artwork='false'] .playing-music .cover-frame),
:global(html[data-te-visible-player-track-info='false'] .playing-music .cover-meta),
:global(html[data-te-visible-player-duration='false'] .playing-music .time-chip),
:global(html[data-te-visible-player-misc-icons='false'] .playing-music .visualizer-toggle-button) {
  display: none;
}

:global(html[data-te-visible-player-album-artist='false'] .playing-music .track-artist),
:global(html[data-te-visible-player-album-artist='false'] .playing-music .track-album),
:global(html[data-te-player-layout='minimal'] .playing-music .track-artist),
:global(html[data-te-player-layout='minimal'] .playing-music .track-album) {
  display: none;
}

:global(
  html[data-te-player-layout='minimal'][data-te-visible-player-album-artist='true']
    .playing-music
    .track-artist
),
:global(
  html[data-te-player-layout='minimal'][data-te-visible-player-album-artist='true']
    .playing-music
    .track-album
) {
  display: block;
}

@media (max-width: 1120px) {
  :global(html[data-te-player-layout='standard'] .playing-music .cover-column),
  :global(html[data-te-player-layout='split'] .playing-music .cover-column) {
    display: grid;
    grid-template-columns: minmax(132px, 180px) minmax(0, 1fr);
    align-items: center;
    gap: 22px;
    width: min(100%, 720px);
    justify-self: center;
  }

  :global(html[data-te-player-layout='standard'] .playing-music .cover-frame),
  :global(html[data-te-player-layout='split'] .playing-music .cover-frame) {
    width: min(100%, 180px);
  }

  :global(html[data-te-player-layout='full-cover'] .playing-music .stage) {
    padding: 0;
  }

  :global(html[data-te-player-layout='full-cover'] .playing-music .layout) {
    display: block;
  }

  :global(html[data-te-player-layout='full-cover'] .playing-music .lyrics-column) {
    top: 88px;
    right: 22px;
    bottom: 122px;
    width: min(44vw, 480px);
  }

  :global(html[data-te-player-layout='full-cover'] .playing-music .cover-meta) {
    left: 22px;
    width: min(42vw, 440px);
  }

  :global(html[data-te-player-layout='lyrics-focus'] .playing-music .layout) {
    grid-template-columns: minmax(126px, 176px) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  :global(html[data-te-player-layout='lyrics-focus'] .playing-music .cover-column) {
    align-self: start;
    margin-top: 8vh;
  }

  :global(html[data-te-player-layout='split'] .playing-music .layout) {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 28px;
  }

  :global(html[data-te-player-layout='split'] .playing-music .cover-column) {
    width: auto;
    justify-self: stretch;
  }
}

@media (max-width: 760px) {
  :global(html[data-te-player-layout='full-cover'] .playing-music .lyrics-column) {
    top: 70px;
    right: 16px;
    bottom: 290px;
    left: 16px;
    width: auto;
  }

  :global(html[data-te-player-layout='full-cover'] .playing-music .cover-meta) {
    left: 16px;
    bottom: 112px;
    width: calc(100vw - 32px);
  }

  :global(html[data-te-player-layout='lyrics-focus'] .playing-music .layout) {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }

  :global(html[data-te-player-layout='lyrics-focus'] .playing-music .cover-column) {
    margin-top: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  :global(html[data-te-artwork-transition] .playing-music .cover-frame) {
    animation: none;
  }
}
</style>
