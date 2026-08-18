import { onBeforeUnmount, onMounted, watch, type ComputedRef, type Ref } from 'vue'
import { LIQUID_GLASS_TUNING_CHANGED_EVENT } from '../../../shared/liquidGlass.ts'
import { refreshLiquidGlassRuntimeVariables } from '../stores/useThemeStore'
import type { AppBackgroundPage } from '../types/settings'
import {
  analyzeLiquidGlassColor,
  analyzeLiquidGlassPixels,
  extractCssImageUrl,
  fallbackLiquidGlassEnvironment,
  isTrustedLiquidGlassImageUrl,
  resolveAdaptiveGlassTone,
  type LiquidGlassEnvironment,
  type LiquidGlassTone
} from '../utils/liquidGlassEnvironment'

const RUNTIME_VARIABLES = [
  '--te-lg-context-rgb',
  '--te-lg-context-surface-alpha',
  '--te-lg-context-shadow-alpha',
  '--te-lg-context-rim-alpha',
  '--te-lg-context-label-rgb',
  '--te-lg-context-surface',
  '--te-lg-context-surface-solid',
  '--te-lg-context-material',
  '--te-lg-context-label',
  '--te-lg-context-shadow',
  '--te-lg-context-rim'
]
const HERO_COVER_SELECTOR = '.home .feature-backdrop img[src]'

type EnvironmentRef<T> = Ref<T> | ComputedRef<T>

function rootToneIsDark(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

function sourceForPage(page: AppBackgroundPage): string | null {
  const styles = getComputedStyle(document.documentElement)
  const pageSource = extractCssImageUrl(styles.getPropertyValue(`--te-${page}-bg-image`))
  const themeSource = extractCssImageUrl(styles.getPropertyValue('--te-theme-background-image'))
  const appSource = extractCssImageUrl(styles.getPropertyValue('--te-app-bg-image'))
  if (pageSource ?? themeSource ?? appSource) return pageSource ?? themeSource ?? appSource

  const heroCover =
    page === 'local' ? document.querySelector<HTMLImageElement>(HERO_COVER_SELECTOR) : null
  const heroSource = heroCover?.currentSrc || heroCover?.getAttribute('src') || null
  return heroSource && isTrustedLiquidGlassImageUrl(heroSource) ? heroSource : null
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('liquid glass context image could not load'))
    image.src = source
  })
}

function sampleImage(image: HTMLImageElement, isDark: boolean): LiquidGlassEnvironment {
  const canvas = document.createElement('canvas')
  canvas.width = 48
  canvas.height = 48
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return fallbackLiquidGlassEnvironment(isDark)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return analyzeLiquidGlassPixels(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    isDark
  )
}

function applyEnvironment(environment: LiquidGlassEnvironment, tone: LiquidGlassTone): void {
  const root = document.documentElement
  root.dataset.teLiquidGlassContext = environment.context
  for (const [name, value] of Object.entries(environment.variables)) {
    root.style.setProperty(name, value)
  }
  root.style.setProperty('--te-lg-context-luminance', environment.luminance.toFixed(3))

  // Adaptive tone: publish the sampled decision, then re-resolve the glass
  // profiles so the material flips without waiting on the manual switch. The
  // hero sample doubles as the home decision — the hero art is the backdrop the
  // feature cards actually sit over on the local page.
  const adaptive = resolveAdaptiveGlassTone(environment.luminance, tone)
  const nextValue = adaptive === 'dark' ? 'dark' : 'light'
  if (
    root.dataset.teLiquidGlassAdaptiveTone !== nextValue ||
    root.dataset.teHomeLiquidGlassAdaptiveTone !== nextValue
  ) {
    root.dataset.teLiquidGlassAdaptiveTone = nextValue
    root.dataset.teHomeLiquidGlassAdaptiveTone = nextValue
    refreshLiquidGlassRuntimeVariables()
  }
}

function resolveCssVariable(styles: CSSStyleDeclaration, name: string): string {
  let value = styles.getPropertyValue(name).trim()
  for (let depth = 0; depth < 4; depth += 1) {
    const match = value.match(/^var\((--[\w-]+)\)$/)
    if (!match) break
    const next = styles.getPropertyValue(match[1]).trim()
    if (!next || next === value) break
    value = next
  }
  return value
}

function solidColorForPage(page: AppBackgroundPage): string | null {
  const styles = getComputedStyle(document.documentElement)
  const pageColor = resolveCssVariable(styles, `--te-${page}-bg`)
  if (pageColor && !pageColor.includes('gradient')) return pageColor
  const appColor = resolveCssVariable(styles, '--te-app-bg')
  return appColor && !appColor.includes('gradient') ? appColor : null
}

function clearEnvironment(): void {
  const root = document.documentElement
  delete root.dataset.teLiquidGlassContext
  delete root.dataset.teLiquidGlassSource
  delete root.dataset.teLiquidGlassScrolled
  delete root.dataset.teLiquidGlassAdaptiveTone
  delete root.dataset.teHomeLiquidGlassAdaptiveTone
  for (const name of RUNTIME_VARIABLES) root.style.removeProperty(name)
  root.style.removeProperty('--te-lg-context-luminance')
}

export function useLiquidGlassEnvironment(options: {
  active: EnvironmentRef<boolean>
  page: EnvironmentRef<AppBackgroundPage>
}): void {
  let sequence = 0
  let observer: MutationObserver | null = null
  let coverObserver: MutationObserver | null = null
  let environmentKey: string | null = null

  async function refresh(): Promise<void> {
    const currentSequence = ++sequence
    if (!options.active.value) {
      environmentKey = null
      clearEnvironment()
      return
    }

    const isDark = rootToneIsDark()
    const tone: LiquidGlassTone = isDark ? 'dark' : 'light'
    const source = sourceForPage(options.page.value)
    const solidColor = source ? null : solidColorForPage(options.page.value)
    const nextKey = `${isDark}:${source ?? `solid:${solidColor ?? 'fallback'}`}`
    if (environmentKey === nextKey) return
    environmentKey = nextKey
    if (!source || !isTrustedLiquidGlassImageUrl(source)) {
      if (solidColor) {
        applyEnvironment(analyzeLiquidGlassColor(solidColor, isDark), tone)
        document.documentElement.dataset.teLiquidGlassSource = 'solid'
        return
      }
      applyEnvironment(fallbackLiquidGlassEnvironment(isDark), tone)
      document.documentElement.dataset.teLiquidGlassSource = 'fallback'
      return
    }

    try {
      const environment = sampleImage(await loadImage(source), isDark)
      if (currentSequence === sequence && options.active.value) {
        applyEnvironment(environment, tone)
        document.documentElement.dataset.teLiquidGlassSource = 'image'
      }
    } catch {
      if (currentSequence === sequence && options.active.value) {
        applyEnvironment(fallbackLiquidGlassEnvironment(isDark), tone)
        document.documentElement.dataset.teLiquidGlassSource = 'fallback'
      }
    }
  }

  function queueRefresh(): void {
    queueMicrotask(() => void refresh())
  }

  function refreshForHeroCoverMutation(mutations: MutationRecord[]): void {
    if (options.page.value !== 'local') return
    for (const mutation of mutations) {
      if (
        mutation.type === 'attributes' &&
        mutation.target instanceof HTMLImageElement &&
        mutation.target.matches(HERO_COVER_SELECTOR)
      ) {
        queueRefresh()
        return
      }
      if (
        mutation.type === 'childList' &&
        Array.from(mutation.addedNodes).some(
          (node) =>
            node instanceof Element &&
            (node.matches(HERO_COVER_SELECTOR) || Boolean(node.querySelector(HERO_COVER_SELECTOR)))
        )
      ) {
        queueRefresh()
        return
      }
    }
  }

  function syncScrollEdge(event: Event): void {
    if (!options.active.value) return
    const target = event.target
    const scrollTop =
      target instanceof Element
        ? target.scrollTop
        : (document.scrollingElement?.scrollTop ?? document.documentElement.scrollTop)
    const next = scrollTop > 4 ? 'on' : 'off'
    if (document.documentElement.dataset.teLiquidGlassScrolled !== next) {
      document.documentElement.dataset.teLiquidGlassScrolled = next
    }
  }

  onMounted(() => {
    queueRefresh()
    window.addEventListener(LIQUID_GLASS_TUNING_CHANGED_EVENT, queueRefresh)
    document.addEventListener('scroll', syncScrollEdge, { capture: true, passive: true })
    observer = new MutationObserver(queueRefresh)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-active-theme', 'data-te-surface-material', 'style']
    })
    coverObserver = new MutationObserver(refreshForHeroCoverMutation)
    coverObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['src'],
      childList: true,
      subtree: true
    })
  })

  onBeforeUnmount(() => {
    sequence++
    clearEnvironment()
    window.removeEventListener(LIQUID_GLASS_TUNING_CHANGED_EVENT, queueRefresh)
    document.removeEventListener('scroll', syncScrollEdge, true)
    observer?.disconnect()
    coverObserver?.disconnect()
  })

  watch([options.active, options.page], queueRefresh)
}
