<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  DEFAULT_DESKTOP_LYRICS_SETTINGS,
  findDesktopLyricsActiveIndex,
  resolveDesktopLyricsPaletteColors,
  resolveDesktopLyricsSlots,
  type DesktopLyricsClockSnapshot,
  type DesktopLyricsSession,
  type DesktopLyricsSettingsV3,
  type DesktopLyricsTransportAction
} from '../../../shared/desktopLyrics.ts'
import DesktopLyricSlot from './components/DesktopLyricSlot.vue'
import DesktopLyricsToolbar from './components/DesktopLyricsToolbar.vue'
import { createDesktopLyricsClock } from './desktopLyricsClock.ts'
import './desktopLyrics.css'

type SlotInstance = InstanceType<typeof DesktopLyricSlot>

const DESKTOP_LYRICS_TOOLBAR_HOVER_DELAY_MS = 500
const DESKTOP_LYRICS_LOCKED_HOVER_DELAY_MS = 2000
const api = window.api.desktopLyrics
const settings = shallowRef<DesktopLyricsSettingsV3>({ ...DEFAULT_DESKTOP_LYRICS_SETTINGS })
const session = shallowRef<DesktopLyricsSession | null>(null)
const currentClock = shallowRef<DesktopLyricsClockSnapshot | null>(null)
const activeIndex = ref(-1)
const hovering = ref(false)
const toolbarVisible = ref(false)
const lockedHovering = ref(false)
const unlockAffordanceVisible = ref(false)
const dragging = ref(false)
const pausedHidden = ref(false)
const systemReduced = ref(false)
const slotZero = ref<SlotInstance | null>(null)
const slotOne = ref<SlotInstance | null>(null)
const rootElement = ref<HTMLElement | null>(null)
const clock = createDesktopLyricsClock()
const disposers: Array<() => void> = []
let pauseTimer: ReturnType<typeof setTimeout> | null = null
let toolbarTimer: ReturnType<typeof setTimeout> | null = null
let unlockAffordanceTimer: ReturnType<typeof setTimeout> | null = null
let activeLineTimer: ReturnType<typeof setTimeout> | null = null
let lockedInteractionActive = false
let dragFrame = 0
let pendingMove: { x: number; y: number } | null = null
let dragOrigin: { pointerX: number; pointerY: number; windowX: number; windowY: number } | null =
  null

const slots = computed(() =>
  resolveDesktopLyricsSlots(session.value?.lines ?? [], activeIndex.value)
)
const primarySlot = computed(() => {
  const currentSlots = slots.value
  if (settings.value.displayMode === 'double') return currentSlots[0]
  return (
    currentSlots.find((slot) => slot.active) ??
    currentSlots.find((slot) => slot.line !== null) ??
    currentSlots[0]
  )
})
const playing = computed(() => currentClock.value?.state === 'playing')
const songLabel = computed(() => {
  const track = session.value?.track
  if (!track) return ''
  return track.artist ? `${track.title} · ${track.artist}` : track.title
})
const placeholder = computed(() => {
  if (!session.value?.track || session.value.status === 'idle') return '等待播放'
  if (session.value.status === 'loading') return '正在获取歌词…'
  if (session.value.status === 'error') return '歌词加载失败'
  if (session.value.status === 'empty') return '纯音乐，请欣赏'
  return ''
})
const motionMode = computed(() => {
  if (settings.value.motionIntensity <= 0 || settings.value.motionPreference === 'off') return 'off'
  if (settings.value.motionPreference === 'reduced' || systemReduced.value) return 'reduced'
  return 'full'
})
const paletteColors = computed(() => resolveDesktopLyricsPaletteColors(settings.value))
const rootStyle = computed<Record<string, string>>(() => ({
  '--dl-font': settings.value.resolvedFontFamily || 'system-ui, sans-serif',
  '--dl-size': `${settings.value.fontSize}px`,
  '--dl-weight': String(settings.value.fontWeight),
  '--dl-line-gap': `${settings.value.lineGap}px`,
  '--dl-active': paletteColors.value.active,
  '--dl-active-end': `color-mix(in srgb, ${paletteColors.value.active} 52%, white)`,
  '--dl-inactive': `color-mix(in srgb, ${paletteColors.value.inactive} ${settings.value.inactiveOpacity}%, transparent)`,
  '--dl-outline-width': settings.value.textOutline ? '1px' : '0px',
  '--dl-board-alpha': String(settings.value.backgroundOpacity / 100),
  '--dl-shadow-alpha': String((settings.value.shadowStrength / 100) * 0.72),
  '--dl-motion': String(settings.value.motionIntensity / 100),
  '--dl-accent': settings.value.accentColor || '#7aa2ff',
  '--dl-custom': settings.value.customActiveColor
}))

function clearPauseTimer(): void {
  if (pauseTimer == null) return
  clearTimeout(pauseTimer)
  pauseTimer = null
}

function clearToolbarTimer(): void {
  if (toolbarTimer == null) return
  clearTimeout(toolbarTimer)
  toolbarTimer = null
}

function clearUnlockAffordanceTimer(): void {
  if (unlockAffordanceTimer == null) return
  clearTimeout(unlockAffordanceTimer)
  unlockAffordanceTimer = null
}

function clearActiveLineTimer(): void {
  if (activeLineTimer == null) return
  clearTimeout(activeLineTimer)
  activeLineTimer = null
}

function scheduleToolbarShow(): void {
  clearToolbarTimer()
  if (!hovering.value) return
  toolbarTimer = setTimeout(() => {
    toolbarTimer = null
    if (hovering.value) toolbarVisible.value = true
  }, DESKTOP_LYRICS_TOOLBAR_HOVER_DELAY_MS)
}

function hideToolbar(): void {
  clearToolbarTimer()
  toolbarVisible.value = false
}

function clearHoverUi(): void {
  hovering.value = false
  hideToolbar()
}

function setLockedInteractionActive(active: boolean): void {
  if (lockedInteractionActive === active) return
  lockedInteractionActive = active
  void api.setInteractionActive(active).catch(() => {
    if (lockedInteractionActive === active) lockedInteractionActive = !active
  })
}

function revealUnlockAffordance(): void {
  clearUnlockAffordanceTimer()
  if (settings.value.locked && lockedHovering.value) unlockAffordanceVisible.value = true
}

function scheduleUnlockAffordance(): void {
  clearUnlockAffordanceTimer()
  if (!settings.value.locked || !lockedHovering.value) return
  unlockAffordanceTimer = setTimeout(() => {
    unlockAffordanceTimer = null
    revealUnlockAffordance()
  }, DESKTOP_LYRICS_LOCKED_HOVER_DELAY_MS)
}

function clearLockedHover(): void {
  clearUnlockAffordanceTimer()
  lockedHovering.value = false
  unlockAffordanceVisible.value = false
  setLockedInteractionActive(false)
}

function restoreHoverAfterUnlock(): void {
  if (!rootElement.value?.matches(':hover')) return
  hovering.value = true
  scheduleToolbarShow()
}

function schedulePauseHide(): void {
  clearPauseTimer()
  pausedHidden.value = false
  if (!settings.value.hideWhenPaused || playing.value || hovering.value) return
  pauseTimer = setTimeout(() => {
    pauseTimer = null
    pausedHidden.value = true
    clearActiveLineTimer()
  }, settings.value.pauseHideDelaySeconds * 1000)
}

function positionNow(): number {
  return clock.positionAt() + (session.value?.lyricOffsetMs ?? 0)
}

function scheduleActiveLineUpdate(): void {
  clearActiveLineTimer()
  const currentSession = session.value
  if (
    !currentSession ||
    currentSession.status !== 'ready' ||
    currentClock.value?.state !== 'playing' ||
    document.hidden ||
    pausedHidden.value
  )
    return
  const position = positionNow()
  const nextLine = currentSession.lines.find(
    (line) => line.startMs != null && line.startMs > position
  )
  if (nextLine?.startMs == null) return
  activeLineTimer = setTimeout(
    () => {
      activeLineTimer = null
      syncPosition()
    },
    Math.max(16, Math.ceil(nextLine.startMs - position) + 1)
  )
}

function syncPosition(hard = false): void {
  const currentSession = session.value
  if (!currentSession) return
  const position = positionNow()
  const nextIndex = findDesktopLyricsActiveIndex(currentSession.lines, position)
  const changed = nextIndex !== activeIndex.value
  if (changed) activeIndex.value = nextIndex
  const isPlaying = currentClock.value?.state === 'playing'
  slotZero.value?.syncKaraoke(position, isPlaying, hard || changed)
  slotOne.value?.syncKaraoke(position, isPlaying, hard || changed)
  scheduleActiveLineUpdate()
}

function applySession(next: DesktopLyricsSession): void {
  const changed = session.value?.sessionId !== next.sessionId
  session.value = next
  if (changed) {
    clock.reset()
    currentClock.value = null
    activeIndex.value = -1
  }
  void nextTick(() => syncPosition(true))
}

function applyClock(next: DesktopLyricsClockSnapshot): void {
  const sessionId = session.value?.sessionId
  if (!sessionId || !clock.ingest(next, sessionId)) return
  const hard = currentClock.value?.epoch !== next.epoch || currentClock.value?.state !== next.state
  currentClock.value = next
  schedulePauseHide()
  syncPosition(hard)
}

async function patchSettings(patch: Partial<DesktopLyricsSettingsV3>): Promise<void> {
  settings.value = await api.updateQuickSettings(patch)
  schedulePauseHide()
  syncPosition(true)
}

async function lock(): Promise<void> {
  clearHoverUi()
  clearLockedHover()
  settings.value = await api.setLocked(true)
}

async function unlock(): Promise<void> {
  clearLockedHover()
  settings.value = await api.setLocked(false)
  hideToolbar()
  await nextTick()
  restoreHoverAfterUnlock()
}

function onHoverIntent(pointerInside: boolean): void {
  if (!settings.value.locked) return
  if (!pointerInside) {
    clearLockedHover()
    return
  }
  lockedHovering.value = true
  setLockedInteractionActive(true)
  scheduleUnlockAffordance()
}

function onPointerEnter(): void {
  if (settings.value.locked) {
    lockedHovering.value = true
    scheduleUnlockAffordance()
    return
  }
  hovering.value = true
  scheduleToolbarShow()
}

function onPointerLeave(): void {
  if (settings.value.locked) {
    clearLockedHover()
    return
  }
  clearHoverUi()
}

function onDoubleClick(event: MouseEvent): void {
  if (!settings.value.locked || !lockedHovering.value) return
  event.preventDefault()
  revealUnlockAffordance()
}

function transport(action: DesktopLyricsTransportAction): void {
  api.transport(action)
}

function flushMove(): void {
  dragFrame = 0
  if (!pendingMove) return
  api.moveTo(pendingMove.x, pendingMove.y)
  pendingMove = null
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || settings.value.locked) return
  const target = event.target
  if (target instanceof Element && target.closest('[data-dl-interactive]')) return
  dragOrigin = {
    pointerX: event.screenX,
    pointerY: event.screenY,
    windowX: window.screenX,
    windowY: window.screenY
  }
  dragging.value = true
  const root = event.currentTarget
  if (root instanceof Element) {
    try {
      root.setPointerCapture(event.pointerId)
    } catch {
      dragging.value = false
      dragOrigin = null
      return
    }
  }
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value || !dragOrigin) return
  pendingMove = {
    x: dragOrigin.windowX + event.screenX - dragOrigin.pointerX,
    y: dragOrigin.windowY + event.screenY - dragOrigin.pointerY
  }
  if (dragFrame === 0) dragFrame = requestAnimationFrame(flushMove)
}

function endDrag(): void {
  if (!dragging.value) return
  dragging.value = false
  dragOrigin = null
  if (dragFrame !== 0) cancelAnimationFrame(dragFrame)
  flushMove()
  api.moveEnd()
}

function onVisibilityChange(): void {
  if (document.hidden) {
    clock.freeze()
    clearActiveLineTimer()
    return
  }
  syncPosition(true)
}

onMounted(async () => {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const updateMotion = (): void => {
    systemReduced.value = media.matches
  }
  updateMotion()
  media.addEventListener('change', updateMotion)
  disposers.push(() => media.removeEventListener('change', updateMotion))
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', endDrag)
  document.addEventListener('pointercancel', endDrag)
  document.addEventListener('visibilitychange', onVisibilityChange)
  disposers.push(
    api.onSessionChanged(applySession),
    api.onClockChanged(applyClock),
    api.onSettingsChanged((next) => {
      const lockChanged = settings.value.locked !== next.locked
      settings.value = next
      if (next.locked) {
        clearHoverUi()
        clearLockedHover()
      } else if (lockChanged) {
        clearLockedHover()
        hideToolbar()
        void nextTick(restoreHoverAfterUnlock)
      }
      schedulePauseHide()
      syncPosition(true)
    }),
    api.onFreezeClock(() => {
      clock.freeze()
      clearActiveLineTimer()
    }),
    api.onHoverIntent(onHoverIntent)
  )
  const bootstrap = await api.bootstrap()
  settings.value = bootstrap.settings
  if (bootstrap.session) applySession(bootstrap.session)
  if (bootstrap.clock) applyClock(bootstrap.clock)
  schedulePauseHide()
  await nextTick()
  api.ready()
})

watch(hovering, () => {
  schedulePauseHide()
  syncPosition(true)
})
watch(
  () => [
    settings.value.fontFamily,
    settings.value.fontSize,
    settings.value.fontWeight,
    settings.value.windowWidth,
    settings.value.translationVisible,
    settings.value.romanizationVisible,
    settings.value.displayMode,
    settings.value.writingMode,
    settings.value.textAlign
  ],
  () => {
    void nextTick(() => {
      void slotZero.value?.fit()
      void slotOne.value?.fit()
    })
  }
)

onBeforeUnmount(() => {
  clearPauseTimer()
  clearToolbarTimer()
  clearUnlockAffordanceTimer()
  if (lockedInteractionActive) setLockedInteractionActive(false)
  clearActiveLineTimer()
  if (dragFrame !== 0) cancelAnimationFrame(dragFrame)
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', endDrag)
  document.removeEventListener('pointercancel', endDrag)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  for (const dispose of disposers) dispose()
})
</script>

<template>
  <main
    ref="rootElement"
    class="dl-root"
    :class="{
      'is-hovering': hovering,
      'is-dragging': dragging,
      'is-hidden': pausedHidden,
      'is-vertical': settings.writingMode === 'vertical'
    }"
    :data-motion="motionMode"
    :style="rootStyle"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
    @pointerdown="onPointerDown"
    @dblclick="onDoubleClick"
  >
    <div class="dl-board">
      <div v-if="placeholder" class="dl-placeholder">{{ placeholder }}</div>
      <div
        v-else
        class="dl-slots"
        :class="[
          `is-${settings.displayMode}`,
          `is-${settings.writingMode}`,
          { 'has-active-line': activeIndex >= 0 }
        ]"
      >
        <DesktopLyricSlot
          ref="slotZero"
          :line="primarySlot.line"
          :active="primarySlot.active"
          :align="settings.textAlign"
          :writing-mode="settings.writingMode"
          :translation-visible="settings.translationVisible"
          :romanization-visible="settings.romanizationVisible"
        />
        <DesktopLyricSlot
          v-if="settings.displayMode === 'double'"
          ref="slotOne"
          :line="slots[1].line"
          :active="slots[1].active"
          :align="settings.textAlign"
          :writing-mode="settings.writingMode"
          :translation-visible="settings.translationVisible"
          :romanization-visible="settings.romanizationVisible"
        />
      </div>
    </div>

    <Transition name="dl-unlock-transition">
      <button
        v-if="unlockAffordanceVisible"
        class="dl-unlock-affordance"
        type="button"
        title="解锁桌面歌词"
        aria-label="解锁桌面歌词"
        data-dl-interactive
        @click="unlock"
      >
        <i class="ph ph-lock-key-open"></i>
      </button>
    </Transition>

    <Transition name="dl-toolbar-transition">
      <div v-if="toolbarVisible" class="dl-overlay">
        <DesktopLyricsToolbar
          :settings="settings"
          :playing="playing"
          @transport="transport"
          @patch="patchSettings"
          @lock="lock"
          @close="api.close()"
        />
        <p v-if="songLabel" class="dl-song-label" :title="songLabel">{{ songLabel }}</p>
      </div>
    </Transition>
  </main>
</template>
