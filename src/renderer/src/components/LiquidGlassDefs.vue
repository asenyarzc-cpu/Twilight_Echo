<script setup lang="ts">
/**
 * Shared SVG filter definitions for the liquid glass material, mounted once by the
 * app shell.
 *
 * One `<defs>` serves every glass surface: cards reference `te-lg-card`, homepage
 * cards reference `te-lg-home-card`, and the playbar references `te-lg-playbar`.
 * Sharing definitions keeps the DOM flat — it does not make the filter itself
 * cheaper, since Chromium still runs one filter pass per referencing element.
 *
 * `feDisplacementMap scale` and `feImage href` are SVG attributes and cannot read
 * CSS variables, so the tuning values are read back out of computed style (the theme
 * runtime writes `--te-lg-*` into a stylesheet) and bound as attributes here.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  DEFAULT_LIQUID_GLASS_HOME_CARDS,
  DEFAULT_LIQUID_GLASS_LIGHT,
  LIQUID_GLASS_CARD_FILTER_ID,
  LIQUID_GLASS_CARD_SELECTOR,
  LIQUID_GLASS_BUDGET_CLASS,
  LIQUID_GLASS_EXPANDED_CARD_FILTER_ID,
  LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR,
  LIQUID_GLASS_HOME_CARD_FILTER_ID,
  LIQUID_GLASS_MAX_VISIBLE_EXPANDED_SURFACES,
  LIQUID_GLASS_OFFSCREEN_CLASS,
  LIQUID_GLASS_PLAYBAR_FILTER_ID,
  LIQUID_GLASS_TUNING_CHANGED_EVENT,
  resolveAberrationBlur,
  resolveChannelScales
} from '../../../shared/liquidGlass.ts'
import {
  CARD_DISPLACEMENT_BUCKET,
  getDisplacementMapUrl,
  PLAYBAR_DISPLACEMENT_BUCKET
} from '../utils/liquidGlassDisplacement.ts'
import {
  createFrameCoalescer,
  LIQUID_GLASS_POINTER_FRAME_INTERVAL_MS,
  pointerCssVariables,
  resolvePointerOffset,
  staticPointerCssVariables,
  type LiquidGlassPointerVariables
} from '../utils/liquidGlassPointer.ts'
import {
  LIQUID_GLASS_PRESS_TARGET_SCALE,
  LiquidGlassPressController,
  liquidGlassPressCssVariables
} from '../utils/liquidGlassPress.ts'

const props = defineProps<{
  /** Whether liquid glass is the active material. */
  active: boolean
  /** Whether the specular highlight tracks the pointer. */
  followPointer: boolean
  /** Whether the local dashboard uses its independently tuned liquid-glass filter. */
  homeCardsActive: boolean
  /** Whether the opt-in expanded card/panel filter is active. */
  expandedActive: boolean
}>()

const cardMapUrl = ref('')
const playbarMapUrl = ref('')
const displacementScale = ref(DEFAULT_LIQUID_GLASS_LIGHT.displacementScale)
const aberrationIntensity = ref(DEFAULT_LIQUID_GLASS_LIGHT.aberrationIntensity)
const homeDisplacementScale = ref(DEFAULT_LIQUID_GLASS_HOME_CARDS.light.displacementScale)
const homeAberrationIntensity = ref(DEFAULT_LIQUID_GLASS_HOME_CARDS.light.aberrationIntensity)
const expandedDisplacementScale = ref(24)
const expandedAberrationIntensity = ref(0.8)

const channelScales = computed(() =>
  resolveChannelScales(displacementScale.value, aberrationIntensity.value)
)
const aberrationBlur = computed(() => resolveAberrationBlur(aberrationIntensity.value))
const homeChannelScales = computed(() =>
  resolveChannelScales(homeDisplacementScale.value, homeAberrationIntensity.value)
)
const homeAberrationBlur = computed(() => resolveAberrationBlur(homeAberrationIntensity.value))
const expandedChannelScales = computed(() =>
  resolveChannelScales(expandedDisplacementScale.value, expandedAberrationIntensity.value)
)
const expandedAberrationBlur = computed(() =>
  resolveAberrationBlur(expandedAberrationIntensity.value)
)
/**
 * Alpha ramp for the edge mask, reshaping the map's continuous rim magnitude
 * (carried in its alpha channel) into the aberration band. The middle stop scales
 * with aberration so a higher setting lets more of the refracted band through at
 * partial strength instead of a hard cutoff.
 */
const edgeMaskTable = computed(() => `0 ${(0.15 + aberrationIntensity.value * 0.05).toFixed(3)} 1`)
const homeEdgeMaskTable = computed(
  () => `0 ${(0.15 + homeAberrationIntensity.value * 0.05).toFixed(3)} 1`
)
const expandedEdgeMaskTable = computed(
  () => `0 ${(0.15 + expandedAberrationIntensity.value * 0.05).toFixed(3)} 1`
)

function readNumericVariable(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw) return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Re-reads the theme-written tuning variables into bound attribute values. */
function syncFilterInputs(): void {
  if (!props.active) return
  displacementScale.value = readNumericVariable(
    '--te-lg-displacement',
    DEFAULT_LIQUID_GLASS_LIGHT.displacementScale
  )
  aberrationIntensity.value = readNumericVariable(
    '--te-lg-aberration',
    DEFAULT_LIQUID_GLASS_LIGHT.aberrationIntensity
  )
  if (props.homeCardsActive) {
    homeDisplacementScale.value = readNumericVariable(
      '--te-home-lg-displacement',
      DEFAULT_LIQUID_GLASS_HOME_CARDS.light.displacementScale
    )
    homeAberrationIntensity.value = readNumericVariable(
      '--te-home-lg-aberration',
      DEFAULT_LIQUID_GLASS_HOME_CARDS.light.aberrationIntensity
    )
  }
  if (props.expandedActive) {
    expandedDisplacementScale.value = readNumericVariable('--te-lg-expanded-displacement', 24)
    expandedAberrationIntensity.value = readNumericVariable('--te-lg-expanded-aberration', 0.8)
  }
  pointerElasticity = readNumericVariable('--te-lg-elasticity', 0)
}

function onTuningChanged(): void {
  syncFilterInputs()
}

function ensureMaps(): void {
  if (!props.active) return
  if (!cardMapUrl.value) cardMapUrl.value = getDisplacementMapUrl(CARD_DISPLACEMENT_BUCKET)
  if (!playbarMapUrl.value) {
    playbarMapUrl.value = getDisplacementMapUrl(PLAYBAR_DISPLACEMENT_BUCKET)
  }
}

function writePointerVariables(variables: LiquidGlassPointerVariables, target: HTMLElement): void {
  for (const [name, value] of Object.entries(variables)) {
    // Avoid invalidating the filtered layer when the coalesced position rounds to
    // the same values as the previous frame.
    if (target.style.getPropertyValue(name) !== value) target.style.setProperty(name, value)
  }
}

function resolvePointerCard(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(LIQUID_GLASS_CARD_SELECTOR) : null
}

function resolvePointerElasticity(target: HTMLElement | null): number {
  if (props.homeCardsActive && target?.closest('.home')) {
    return readNumericVariable('--te-home-lg-elasticity', 0)
  }
  return readNumericVariable('--te-lg-elasticity', 0)
}

/**
 * The card currently under the pointer. Variables are scoped to this element, so
 * only the hovered card rotates its highlight; the rest keep the static base
 * angle. Reset to null when the pointer leaves the surface list.
 */
let hoveredCard: HTMLElement | null = null
let hoveredCardRect: DOMRect | null = null
let pointerElasticity = 0

function clearHoveredCard(): void {
  if (!hoveredCard) return
  writePointerVariables(staticPointerCssVariables(), hoveredCard)
  hoveredCard = null
  hoveredCardRect = null
}

const pointerFrames = createFrameCoalescer<{ x: number; y: number; target: EventTarget | null }>(
  (point) => {
    // The pointer event already carries the hit target. Reusing it avoids a fresh
    // document-wide hit test (elementFromPoint) during every rendering frame.
    const next = resolvePointerCard(point.target)

    if (next !== hoveredCard) {
      clearHoveredCard()
      hoveredCard = next
      hoveredCardRect = null
      pointerElasticity = resolvePointerElasticity(next)
    }

    if (!next) {
      // Once the cursor leaves every liquid surface, stop observing high-rate
      // pointer movement until the lightweight delegated boundary listener sees a
      // card again.
      detachPointerMove()
      return
    }
    attachPointerMove()
    // Card geometry only changes on a scroll, resize, or card transition. Cache it
    // between those events so pointer tracking does not force layout every frame.
    const rect = hoveredCardRect ?? next.getBoundingClientRect()
    hoveredCardRect = rect
    writePointerVariables(
      pointerCssVariables(resolvePointerOffset(point.x, point.y, rect), pointerElasticity),
      next
    )
  },
  { minIntervalMs: LIQUID_GLASS_POINTER_FRAME_INTERVAL_MS }
)

function isMousePointer(event: PointerEvent): boolean {
  return event.pointerType === 'mouse'
}

function resetHoveredPointer(): void {
  pointerFrames.cancel()
  clearHoveredCard()
  detachPointerMove()
}

function onPointerMove(event: PointerEvent): void {
  if (!isMousePointer(event)) return
  pointerFrames.schedule({ x: event.clientX, y: event.clientY, target: event.target })
}

/**
 * This listener stays active while glass pointer tracking is enabled, but only
 * handles element-boundary changes. The high-frequency window pointermove listener
 * is attached after a glass card is entered and released again on leave, preventing
 * app-wide mouse movement from scheduling glass work while browsing non-card UI.
 */
function onPointerOver(event: PointerEvent): void {
  if (!isMousePointer(event)) return
  const card = resolvePointerCard(event.target)
  // Arm the movement listener synchronously on entry. If the pointer crosses a
  // card between two coalesced frames, its next boundary event can then schedule
  // the reset instead of leaving an orphaned global listener behind.
  if (card) attachPointerMove()
  else if (!pointerMoveAttached) return
  pointerFrames.schedule({ x: event.clientX, y: event.clientY, target: event.target })
}

function onPointerOut(event: PointerEvent): void {
  if (!isMousePointer(event)) return
  const previousCard = resolvePointerCard(event.target)
  const nextCard = resolvePointerCard(event.relatedTarget)
  // Moving between children of one card is not a card leave. Ignore those bubbling
  // boundary events so its cached geometry and highlight remain stable.
  if (previousCard === nextCard) return

  if (!nextCard) {
    // Clear synchronously instead of waiting for the 32 ms coalescer: otherwise a
    // quick pass over a card can leave a stale highlight and a global move listener
    // alive until the next unrelated pointer event.
    resetHoveredPointer()
    return
  }

  // Crossing directly from one card to another should keep tracking, but use the
  // destination from relatedTarget so the old card can never receive a late frame.
  attachPointerMove()
  pointerFrames.schedule({
    x: event.clientX,
    y: event.clientY,
    target: event.relatedTarget
  })
}

function invalidateHoveredCardGeometry(): void {
  hoveredCardRect = null
}

/* A pointerout is not guaranteed when the application loses focus or the page
   becomes hidden. Reset here too, otherwise an old card can retain its sheen and
   the high-rate window listener remains armed until the next mouse movement. */
function onWindowBlur(): void {
  resetHoveredPointer()
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') resetHoveredPointer()
}

/**
 * One delegated boundary listener covers the whole virtualised card grid; the
 * high-frequency movement listener is active only during a card hover. This avoids
 * per-card handlers while keeping idle pointer traffic out of the glass pipeline.
 */
function resolveMotionMode(): string {
  return document.documentElement.dataset.teMotion ?? 'full'
}

let pointerAttached = false
let pointerMoveAttached = false

function attachPointerMove(): void {
  if (pointerMoveAttached) return
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  pointerMoveAttached = true
}

function detachPointerMove(): void {
  if (!pointerMoveAttached) return
  window.removeEventListener('pointermove', onPointerMove)
  pointerMoveAttached = false
}

function detachPointer(): void {
  if (!pointerAttached) return
  document.removeEventListener('pointerover', onPointerOver)
  document.removeEventListener('pointerout', onPointerOut)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('resize', invalidateHoveredCardGeometry)
  document.removeEventListener('scroll', invalidateHoveredCardGeometry, true)
  resetHoveredPointer()
  hoveredCardRect = null
  pointerAttached = false
}

function syncPointerTracking(): void {
  // Motion-reduced users get a fixed light source rather than a moving one.
  const shouldTrack =
    props.active &&
    props.homeCardsActive &&
    props.followPointer &&
    resolveMotionMode() !== 'off' &&
    !isReducedMotion()

  if (shouldTrack === pointerAttached) return
  if (shouldTrack) {
    // pointerover only fires at element boundaries, so idle movement through the
    // rest of the app does not enter the pointer-frame coalescer at all.
    document.addEventListener('pointerover', onPointerOver, { passive: true })
    document.addEventListener('pointerout', onPointerOut, { passive: true })
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('resize', invalidateHoveredCardGeometry, { passive: true })
    // Scroll events do not bubble, so capture catches every scrollable card grid
    // and invalidates geometry lazily before the next pointer repaint.
    document.addEventListener('scroll', invalidateHoveredCardGeometry, {
      capture: true,
      passive: true
    })
    pointerAttached = true
    return
  }
  detachPointer()
  writePointerVariables(staticPointerCssVariables(), document.documentElement)
}

function isReducedMotion(): boolean {
  return resolveMotionMode() === 'reduced'
}

/* Press "squish": the surface flexes toward the press point on a spring and
   relaxes on release. Delegated like the hover tracking, so per-card handlers are
   never needed; the high-rate work is one rAF loop while a press is in flight. */

const pressController = new LiquidGlassPressController()
let pressedSurface: HTMLElement | null = null
let pressFrame: number | null = null
let pressLastTime = 0

function resolvePressTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const card = target.closest<HTMLElement>(LIQUID_GLASS_CARD_SELECTOR)
  if (card) return card
  if (props.expandedActive) {
    return target.closest<HTMLElement>(LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR)
  }
  return null
}

function writePressVariables(scale: number, element: HTMLElement): void {
  for (const [name, value] of Object.entries(liquidGlassPressCssVariables(scale))) {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value)
  }
}

function clearPressVariables(element: HTMLElement): void {
  element.style.removeProperty('--te-lg-press-scale')
  element.style.removeProperty('--te-lg-press-glow')
}

function stopPressFrame(): void {
  if (pressFrame !== null) {
    cancelAnimationFrame(pressFrame)
    pressFrame = null
  }
}

/** Anchors the squish at the press point so the flex reads as directional. */
function writePressOrigin(event: PointerEvent, element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  const originX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100
  const originY = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100
  element.style.setProperty('--te-lg-press-x', `${originX.toFixed(1)}%`)
  element.style.setProperty('--te-lg-press-y', `${originY.toFixed(1)}%`)
}

function tickPress(now: number): void {
  pressFrame = null
  const element = pressedSurface
  if (!element) return
  const step = pressLastTime > 0 ? Math.min(0.05, (now - pressLastTime) / 1000) : 1 / 60
  pressLastTime = now
  const state = pressController.update(step)
  writePressVariables(state.scale, element)
  if (state.settled && !pressController.isPressed()) {
    stopPressFrame()
    clearPressVariables(element)
    pressedSurface = null
    pressLastTime = 0
    return
  }
  if (!state.settled) pressFrame = requestAnimationFrame(tickPress)
}

function onSurfacePointerDown(event: PointerEvent): void {
  const target = resolvePressTarget(event.target)
  if (!target || event.button !== 0) return
  stopPressFrame()
  if (pressedSurface && pressedSurface !== target) clearPressVariables(pressedSurface)
  pressedSurface = target
  writePressOrigin(event, target)
  pressController.press()
  if (isMotionGated()) {
    writePressVariables(LIQUID_GLASS_PRESS_TARGET_SCALE, target)
    return
  }
  pressLastTime = 0
  pressFrame = requestAnimationFrame(tickPress)
}

function onSurfacePointerUp(): void {
  if (!pressedSurface) return
  pressController.release()
  if (isMotionGated()) {
    clearPressVariables(pressedSurface)
    pressedSurface = null
    return
  }
  if (pressFrame === null) {
    pressLastTime = 0
    pressFrame = requestAnimationFrame(tickPress)
  }
}

function resetPress(): void {
  stopPressFrame()
  pressController.reset()
  if (pressedSurface) clearPressVariables(pressedSurface)
  pressedSurface = null
  pressLastTime = 0
}

function isMotionGated(): boolean {
  const mode = resolveMotionMode()
  return mode === 'off' || mode === 'reduced'
}

let pressAttached = false

function syncPressTracking(): void {
  const shouldAttach = props.active && (props.homeCardsActive || props.expandedActive)
  if (shouldAttach === pressAttached) return
  if (shouldAttach) {
    document.addEventListener('pointerdown', onSurfacePointerDown, { passive: true })
    window.addEventListener('pointerup', onSurfacePointerUp, { passive: true })
    window.addEventListener('pointercancel', onSurfacePointerUp, { passive: true })
    pressAttached = true
    return
  }
  document.removeEventListener('pointerdown', onSurfacePointerDown)
  window.removeEventListener('pointerup', onSurfacePointerUp)
  window.removeEventListener('pointercancel', onSurfacePointerUp)
  resetPress()
  pressAttached = false
}

let motionObserver: MutationObserver | null = null
let surfaceVisibilityObserver: IntersectionObserver | null = null
let surfaceMutationObserver: MutationObserver | null = null
const observedSurfaces = new Set<Element>()

function clearSurfaceVisibility(): void {
  surfaceVisibilityObserver?.disconnect()
  surfaceVisibilityObserver = null
  surfaceMutationObserver?.disconnect()
  surfaceMutationObserver = null
  for (const surface of observedSurfaces) {
    surface.classList.remove(LIQUID_GLASS_OFFSCREEN_CLASS, LIQUID_GLASS_BUDGET_CLASS)
  }
  observedSurfaces.clear()
}

function observeSurface(surface: Element): void {
  if (!surfaceVisibilityObserver || observedSurfaces.has(surface)) return
  if (
    !surface.matches(LIQUID_GLASS_CARD_SELECTOR) &&
    !(props.expandedActive && surface.matches(LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR))
  ) {
    return
  }
  observedSurfaces.add(surface)
  surfaceVisibilityObserver.observe(surface)
}

function observeSurfacesIn(root: Element | Document): void {
  if (!surfaceVisibilityObserver) return
  if (root instanceof Element) observeSurface(root)
  for (const surface of root.querySelectorAll(LIQUID_GLASS_CARD_SELECTOR)) {
    observeSurface(surface)
  }
  if (props.expandedActive) {
    for (const surface of root.querySelectorAll(LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR)) {
      observeSurface(surface)
    }
  }
}

function syncExpandedSurfaceBudget(): void {
  if (!props.expandedActive) return
  const visible = Array.from(
    document.querySelectorAll<HTMLElement>(LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR)
  ).filter((surface) => !surface.classList.contains(LIQUID_GLASS_OFFSCREEN_CLASS))
  for (const [index, surface] of visible.entries()) {
    surface.classList.toggle(
      LIQUID_GLASS_BUDGET_CLASS,
      index >= LIQUID_GLASS_MAX_VISIBLE_EXPANDED_SURFACES
    )
  }
}

function syncSurfaceVisibility(): void {
  clearSurfaceVisibility()
  if (
    !props.active ||
    (!props.homeCardsActive && !props.expandedActive) ||
    typeof IntersectionObserver === 'undefined' ||
    !document.body
  ) {
    return
  }

  surfaceVisibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle(LIQUID_GLASS_OFFSCREEN_CLASS, !entry.isIntersecting)
      }
      syncExpandedSurfaceBudget()
    },
    { rootMargin: '128px 0px' }
  )
  observeSurfacesIn(document)
  surfaceMutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) observeSurfacesIn(node)
      }
    }
  })
  surfaceMutationObserver.observe(document.body, { childList: true, subtree: true })
  syncExpandedSurfaceBudget()
}

onMounted(() => {
  ensureMaps()
  syncFilterInputs()
  writePointerVariables(staticPointerCssVariables(), document.documentElement)
  syncPointerTracking()
  syncPressTracking()
  syncSurfaceVisibility()
  window.addEventListener(LIQUID_GLASS_TUNING_CHANGED_EVENT, onTuningChanged)

  // The theme runtime rewrites its stylesheet and `data-te-*` attributes on tone or
  // profile change; both can move the tuning values and the motion mode.
  motionObserver = new MutationObserver(() => {
    syncFilterInputs()
    syncPointerTracking()
  })
  motionObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      'data-te-motion',
      'data-theme',
      'data-te-surface-material',
      'data-te-home-liquid-glass',
      'data-te-liquid-glass-coverage'
    ]
  })
})

onBeforeUnmount(() => {
  window.removeEventListener(LIQUID_GLASS_TUNING_CHANGED_EVENT, onTuningChanged)
  detachPointer()
  resetPress()
  pressAttached = false
  clearSurfaceVisibility()
  motionObserver?.disconnect()
  motionObserver = null
})

watch(
  () => [props.active, props.followPointer, props.homeCardsActive, props.expandedActive],
  () => {
    ensureMaps()
    syncFilterInputs()
    syncPointerTracking()
    syncPressTracking()
    syncSurfaceVisibility()
  }
)
</script>

<template>
  <svg v-if="props.active" class="liquid-glass-defs" aria-hidden="true" focusable="false">
    <defs>
      <filter
        :id="LIQUID_GLASS_CARD_FILTER_ID"
        x="-35%"
        y="-35%"
        width="170%"
        height="170%"
        color-interpolation-filters="sRGB"
      >
        <feImage
          x="0"
          y="0"
          width="100%"
          height="100%"
          result="MAP"
          preserveAspectRatio="xMidYMid slice"
          :href="cardMapUrl"
        />
        <!-- The map's alpha carries the continuous rim magnitude; the transfer
             reshapes it into the soft edge mask that gates where aberration shows. -->
        <feColorMatrix
          in="MAP"
          type="matrix"
          values="0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0 0 0 1 0"
          result="EDGE_INTENSITY"
        />
        <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
          <feFuncA type="table" :tableValues="edgeMaskTable" />
        </feComponentTransfer>

        <!-- Each channel is displaced by a slightly different amount; recombining
             them with a screen blend is what produces the chromatic fringe. -->
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.red"
          xChannelSelector="R"
          yChannelSelector="B"
          result="RED_DISPLACED"
        />
        <feColorMatrix
          in="RED_DISPLACED"
          type="matrix"
          values="1 0 0 0 0
                  0 0 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="RED_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.green"
          xChannelSelector="R"
          yChannelSelector="B"
          result="GREEN_DISPLACED"
        />
        <feColorMatrix
          in="GREEN_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 1 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="GREEN_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.blue"
          xChannelSelector="R"
          yChannelSelector="B"
          result="BLUE_DISPLACED"
        />
        <feColorMatrix
          in="BLUE_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 0 0 0 0
                  0 0 1 0 0
                  0 0 0 1 0"
          result="BLUE_CHANNEL"
        />
        <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
        <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
        <feGaussianBlur
          in="RGB_COMBINED"
          :stdDeviation="aberrationBlur"
          result="ABERRATED_BLURRED"
        />

        <!-- Keep aberration at the rim, keep the middle of the surface honest. -->
        <feComposite
          in="ABERRATED_BLURRED"
          in2="EDGE_MASK"
          operator="in"
          result="EDGE_ABERRATION"
        />
        <!-- Clip the refraction band back to the source's own rounded alpha. The
             displacement map is a full rectangle, so without this the corners of
             a rounded card get filled with refracted content and read as square. -->
        <feComposite
          in="EDGE_ABERRATION"
          in2="SourceGraphic"
          operator="in"
          result="EDGE_ABERRATION_CLIPPED"
        />
        <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feComposite in="SourceGraphic" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />
        <feComposite in="EDGE_ABERRATION_CLIPPED" in2="CENTER_CLEAN" operator="over" />
      </filter>

      <filter
        v-if="props.expandedActive"
        :id="LIQUID_GLASS_EXPANDED_CARD_FILTER_ID"
        x="-35%"
        y="-35%"
        width="170%"
        height="170%"
        color-interpolation-filters="sRGB"
      >
        <feImage
          x="0"
          y="0"
          width="100%"
          height="100%"
          result="MAP"
          preserveAspectRatio="xMidYMid slice"
          :href="cardMapUrl"
        />
        <feColorMatrix
          in="MAP"
          type="matrix"
          values="0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0 0 0 1 0"
          result="EDGE_INTENSITY"
        />
        <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
          <feFuncA type="table" :tableValues="expandedEdgeMaskTable" />
        </feComponentTransfer>
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="expandedChannelScales.red"
          xChannelSelector="R"
          yChannelSelector="B"
          result="RED_DISPLACED"
        />
        <feColorMatrix
          in="RED_DISPLACED"
          type="matrix"
          values="1 0 0 0 0
                  0 0 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="RED_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="expandedChannelScales.green"
          xChannelSelector="R"
          yChannelSelector="B"
          result="GREEN_DISPLACED"
        />
        <feColorMatrix
          in="GREEN_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 1 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="GREEN_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="expandedChannelScales.blue"
          xChannelSelector="R"
          yChannelSelector="B"
          result="BLUE_DISPLACED"
        />
        <feColorMatrix
          in="BLUE_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 0 0 0 0
                  0 0 1 0 0
                  0 0 0 1 0"
          result="BLUE_CHANNEL"
        />
        <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
        <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
        <feGaussianBlur
          in="RGB_COMBINED"
          :stdDeviation="expandedAberrationBlur"
          result="ABERRATED_BLURRED"
        />
        <feComposite
          in="ABERRATED_BLURRED"
          in2="EDGE_MASK"
          operator="in"
          result="EDGE_ABERRATION"
        />
        <feComposite
          in="EDGE_ABERRATION"
          in2="SourceGraphic"
          operator="in"
          result="EDGE_ABERRATION_CLIPPED"
        />
        <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feComposite in="SourceGraphic" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />
        <feComposite in="EDGE_ABERRATION_CLIPPED" in2="CENTER_CLEAN" operator="over" />
      </filter>

      <filter
        v-if="props.homeCardsActive"
        :id="LIQUID_GLASS_HOME_CARD_FILTER_ID"
        x="-35%"
        y="-35%"
        width="170%"
        height="170%"
        color-interpolation-filters="sRGB"
      >
        <feImage
          x="0"
          y="0"
          width="100%"
          height="100%"
          result="MAP"
          preserveAspectRatio="xMidYMid slice"
          :href="cardMapUrl"
        />
        <feColorMatrix
          in="MAP"
          type="matrix"
          values="0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0 0 0 1 0"
          result="EDGE_INTENSITY"
        />
        <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
          <feFuncA type="table" :tableValues="homeEdgeMaskTable" />
        </feComponentTransfer>
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="homeChannelScales.red"
          xChannelSelector="R"
          yChannelSelector="B"
          result="RED_DISPLACED"
        />
        <feColorMatrix
          in="RED_DISPLACED"
          type="matrix"
          values="1 0 0 0 0
                  0 0 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="RED_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="homeChannelScales.green"
          xChannelSelector="R"
          yChannelSelector="B"
          result="GREEN_DISPLACED"
        />
        <feColorMatrix
          in="GREEN_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 1 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="GREEN_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="homeChannelScales.blue"
          xChannelSelector="R"
          yChannelSelector="B"
          result="BLUE_DISPLACED"
        />
        <feColorMatrix
          in="BLUE_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 0 0 0 0
                  0 0 1 0 0
                  0 0 0 1 0"
          result="BLUE_CHANNEL"
        />
        <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
        <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
        <feGaussianBlur
          in="RGB_COMBINED"
          :stdDeviation="homeAberrationBlur"
          result="ABERRATED_BLURRED"
        />
        <feComposite
          in="ABERRATED_BLURRED"
          in2="EDGE_MASK"
          operator="in"
          result="EDGE_ABERRATION"
        />
        <feComposite
          in="EDGE_ABERRATION"
          in2="SourceGraphic"
          operator="in"
          result="EDGE_ABERRATION_CLIPPED"
        />
        <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feComposite in="SourceGraphic" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />
        <feComposite in="EDGE_ABERRATION_CLIPPED" in2="CENTER_CLEAN" operator="over" />
      </filter>

      <!-- Same chain against the wide-strip map, so the playbar's short axis keeps a
           proportionate rim instead of a stretched one. -->
      <filter
        :id="LIQUID_GLASS_PLAYBAR_FILTER_ID"
        x="-35%"
        y="-35%"
        width="170%"
        height="170%"
        color-interpolation-filters="sRGB"
      >
        <feImage
          x="0"
          y="0"
          width="100%"
          height="100%"
          result="MAP"
          preserveAspectRatio="xMidYMid slice"
          :href="playbarMapUrl"
        />
        <feColorMatrix
          in="MAP"
          type="matrix"
          values="0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0 0 0 1 0"
          result="EDGE_INTENSITY"
        />
        <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
          <feFuncA type="table" :tableValues="edgeMaskTable" />
        </feComponentTransfer>
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.red"
          xChannelSelector="R"
          yChannelSelector="B"
          result="RED_DISPLACED"
        />
        <feColorMatrix
          in="RED_DISPLACED"
          type="matrix"
          values="1 0 0 0 0
                  0 0 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="RED_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.green"
          xChannelSelector="R"
          yChannelSelector="B"
          result="GREEN_DISPLACED"
        />
        <feColorMatrix
          in="GREEN_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 1 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="GREEN_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.blue"
          xChannelSelector="R"
          yChannelSelector="B"
          result="BLUE_DISPLACED"
        />
        <feColorMatrix
          in="BLUE_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 0 0 0 0
                  0 0 1 0 0
                  0 0 0 1 0"
          result="BLUE_CHANNEL"
        />
        <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
        <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
        <feGaussianBlur
          in="RGB_COMBINED"
          :stdDeviation="aberrationBlur"
          result="ABERRATED_BLURRED"
        />
        <feComposite
          in="ABERRATED_BLURRED"
          in2="EDGE_MASK"
          operator="in"
          result="EDGE_ABERRATION"
        />
        <!-- Same corner fix as the card filter: never paint refraction outside
             the source's own rounded alpha. -->
        <feComposite
          in="EDGE_ABERRATION"
          in2="SourceGraphic"
          operator="in"
          result="EDGE_ABERRATION_CLIPPED"
        />
        <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feComposite in="SourceGraphic" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />
        <feComposite in="EDGE_ABERRATION_CLIPPED" in2="CENTER_CLEAN" operator="over" />
      </filter>
    </defs>
  </svg>
</template>

<style scoped>
/* Definitions only — must occupy no space and never intercept input. */
.liquid-glass-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}
</style>
