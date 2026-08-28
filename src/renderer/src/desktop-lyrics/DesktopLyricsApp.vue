<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  DEFAULT_DESKTOP_LYRICS_SETTINGS,
  findDesktopLyricsActiveIndex,
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

const api = window.api.desktopLyrics
const settings = shallowRef<DesktopLyricsSettingsV3>({ ...DEFAULT_DESKTOP_LYRICS_SETTINGS })
const session = shallowRef<DesktopLyricsSession | null>(null)
const currentClock = shallowRef<DesktopLyricsClockSnapshot | null>(null)
const activeIndex = ref(-1)
const hovering = ref(false)
const dragging = ref(false)
const pausedHidden = ref(false)
const systemReduced = ref(false)
const slotZero = ref<SlotInstance | null>(null)
const slotOne = ref<SlotInstance | null>(null)
const clock = createDesktopLyricsClock()
const disposers: Array<() => void> = []
let frame = 0
let pauseTimer: ReturnType<typeof setTimeout> | null = null
let dragFrame = 0
let pendingMove: { x: number; y: number } | null = null
let dragOrigin: { pointerX: number; pointerY: number; windowX: number; windowY: number } | null =
  null

const slots = computed(() =>
  resolveDesktopLyricsSlots(session.value?.lines ?? [], activeIndex.value)
)
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
const activeColor = computed(() => {
  if (settings.value.palette === 'twilight') return '#7aa2ff'
  if (settings.value.palette === 'warm') return '#ffd27a'
  if (settings.value.palette === 'custom') return settings.value.customActiveColor
  return settings.value.accentColor || '#7aa2ff'
})
const rootStyle = computed<Record<string, string>>(() => ({
  '--dl-font': settings.value.resolvedFontFamily || 'system-ui, sans-serif',
  '--dl-size': `${settings.value.fontSize}px`,
  '--dl-weight': String(settings.value.fontWeight),
  '--dl-line-gap': `${settings.value.lineGap}px`,
  '--dl-active': activeColor.value,
  '--dl-active-end': `color-mix(in srgb, ${activeColor.value} 52%, white)`,
  '--dl-inactive': `rgba(255, 255, 255, ${settings.value.inactiveOpacity / 100})`,
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

function schedulePauseHide(): void {
  clearPauseTimer()
  pausedHidden.value = false
  if (!settings.value.hideWhenPaused || playing.value || hovering.value) return
  pauseTimer = setTimeout(() => {
    pauseTimer = null
    pausedHidden.value = true
    stopFrame()
  }, settings.value.pauseHideDelaySeconds * 1000)
}

function positionNow(): number {
  return clock.positionAt() + (session.value?.lyricOffsetMs ?? 0)
}

function writeFrame(): void {
  frame = 0
  const lines = session.value?.lines ?? []
  const position = positionNow()
  const nextIndex = findDesktopLyricsActiveIndex(lines, position)
  if (nextIndex !== activeIndex.value) activeIndex.value = nextIndex
  slotZero.value?.writeProgress(position)
  slotOne.value?.writeProgress(position)
  if (
    currentClock.value?.state === 'playing' &&
    session.value?.status === 'ready' &&
    !document.hidden &&
    !pausedHidden.value
  ) {
    frame = requestAnimationFrame(writeFrame)
  }
}

function stopFrame(): void {
  if (frame === 0) return
  cancelAnimationFrame(frame)
  frame = 0
}

function applySession(next: DesktopLyricsSession): void {
  const changed = session.value?.sessionId !== next.sessionId
  session.value = next
  if (changed) {
    clock.reset()
    currentClock.value = null
    activeIndex.value = -1
  }
  void nextTick(writeFrame)
}

function applyClock(next: DesktopLyricsClockSnapshot): void {
  const sessionId = session.value?.sessionId
  if (!sessionId || !clock.ingest(next, sessionId)) return
  currentClock.value = next
  schedulePauseHide()
  writeFrame()
}

async function patchSettings(patch: Partial<DesktopLyricsSettingsV3>): Promise<void> {
  settings.value = await api.updateQuickSettings(patch)
  schedulePauseHide()
}

async function lock(): Promise<void> {
  settings.value = await api.setLocked(true)
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
    stopFrame()
  }
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
      settings.value = next
      schedulePauseHide()
    }),
    api.onFreezeClock(() => {
      clock.freeze()
      stopFrame()
    })
  )
  const bootstrap = await api.bootstrap()
  settings.value = bootstrap.settings
  if (bootstrap.session) applySession(bootstrap.session)
  if (bootstrap.clock) applyClock(bootstrap.clock)
  schedulePauseHide()
  await nextTick()
  api.ready()
})

watch(hovering, () => schedulePauseHide())
watch(
  () => [
    settings.value.fontFamily,
    settings.value.fontSize,
    settings.value.fontWeight,
    settings.value.windowWidth,
    settings.value.translationVisible
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
  stopFrame()
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
    class="dl-root"
    :class="{ 'is-hovering': hovering, 'is-dragging': dragging, 'is-hidden': pausedHidden }"
    :data-motion="motionMode"
    :style="rootStyle"
    @pointerenter="hovering = true"
    @pointerleave="hovering = false"
    @pointerdown="onPointerDown"
  >
    <div class="dl-board">
      <div v-if="placeholder" class="dl-placeholder">{{ placeholder }}</div>
      <div v-else class="dl-slots">
        <DesktopLyricSlot
          ref="slotZero"
          :line="slots[0].line"
          :active="slots[0].active"
          :align="slots[0].align"
          :translation-visible="settings.translationVisible"
        />
        <DesktopLyricSlot
          ref="slotOne"
          :line="slots[1].line"
          :active="slots[1].active"
          :align="slots[1].align"
          :translation-visible="settings.translationVisible"
        />
      </div>
    </div>

    <Transition name="dl-toolbar-transition">
      <div v-if="hovering" class="dl-overlay">
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
