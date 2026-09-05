import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue'
import {
  DEFAULT_THEME_TONE_SCHEDULE,
  THEME_MANAGED_DATA_ATTRIBUTES,
  THEME_TOKEN_DEFINITIONS,
  TWILIGHT_DEFAULT_THEME,
  TWILIGHT_DEFAULT_THEME_ID,
  createThemeAccentTokenOverrides,
  ensureThemeTextContrast,
  getBuiltInThemePreset,
  isBuiltInThemePresetId,
  resolveScheduledThemeTone,
  resolveThemeProfileModes,
  resolveThemeProfileTokens,
  themeShellLayoutToCssVariables,
  themeShellLayoutToDataAttributes,
  themeModesToDataAttributes,
  themeTokensToCssVariables,
  type ThemeAssetReference,
  type ThemeAssetType,
  type ThemeBootstrap,
  type ThemeLibrarySnapshot,
  type ThemeShellLayout,
  type ThemeProfileV2,
  type ThemeSelection,
  type ThemeTone,
  type ThemeModes,
  type ThemeWindowInheritance
} from '../../../shared/theme.ts'
import { useExtensionRegistry, type ThemeContribution } from '../extensions/registry'
import { getStartupSnapshot } from '../app/startupSnapshot'
import type { AppStartupSnapshot } from '../../../shared/appStartup.ts'
import { markThemeRuntimeFresh, persistThemeRuntimeCache } from '../app/themeRuntimeCache'
import { resolvePluginThemeRuntimeContract } from '../extensions/pluginThemeRuntime'
import { getPluginThemeKey } from '../extensions/themeSelection'
import {
  createThemePerformanceRecorder,
  type ThemePerformanceOperation,
  type ThemePerformanceSnapshot
} from '../utils/themePerformance'
import type { AppBackgroundColorPair, AppBackgroundPage, AppSettings } from '../types/settings'
import {
  APP_FONT_SYSTEM,
  appFontCssVariables,
  normalizeAppFontFamily,
  type AppFontFamily
} from '../../../shared/appFont.ts'
import {
  DEFAULT_LIQUID_GLASS,
  LIQUID_GLASS_TUNING_CHANGED_EVENT,
  liquidGlassCssVariables,
  liquidGlassExpandedCssVariables,
  liquidGlassHomeCardCssVariables,
  normalizeSurfaceMaterial,
  type LiquidGlassSettings,
  type SurfaceMaterial
} from '../../../shared/liquidGlass.ts'

const STYLE_ID = 'twilight-theme-runtime'
const EPOCH_ISO = new Date(0).toISOString()
const SETTINGS_ACCENT_COLORS: Readonly<Record<string, string>> = Object.freeze({
  violet: '#8b5cf6',
  blue: '#2563eb',
  emerald: '#10b981',
  rose: '#e11d48',
  amber: '#f59e0b',
  slate: '#334155'
})
const APP_BACKGROUND_PAGES: readonly AppBackgroundPage[] = [
  'local',
  'settings',
  'streaming',
  'player'
]
const themePerformanceRecorder = createThemePerformanceRecorder()
const themePerformance = ref<ThemePerformanceSnapshot>(themePerformanceRecorder.snapshot())

const snapshot = ref<ThemeLibrarySnapshot | null>(null)
const previewProfile = ref<ThemeProfileV2 | null>(null)
const previewSelection = ref<ThemeSelection | null>(null)
const loaded = ref(false)
const saving = ref(false)
const error = ref('')
let bootstrapPromise: Promise<void> | null = null
let listenersSetup = false
let applySequence = 0
const assetValidationCache = new Map<string, Promise<boolean>>()
const assetDecodeCache = new Map<string, Promise<void>>()
const systemTone = ref<ThemeTone>('pureWhite')
const adaptiveAccentColor = ref('#1a73e8')
const adaptiveCoverUrl = ref('')
const previewTone = ref<ThemeTone | null>(null)
let adaptiveMediaIdentity = ''
let adaptiveCoverSource = ''
let adaptiveCoverObjectUrl = ''
let adaptiveMediaSequence = 0
let toneRefreshTimer: number | null = null
let lastAppliedTone: ThemeTone | null = null
let lightAccentColor = 'blue'
let darkAccentColor = 'blue'
let uiFontFamily: AppFontFamily = APP_FONT_SYSTEM
let themePreference: AppSettings['theme'] = 'system'
let appBackground: AppSettings['appBackground'] | null = null
let surfaceMaterial: SurfaceMaterial = 'standard'
let liquidGlass: LiquidGlassSettings = DEFAULT_LIQUID_GLASS
const LIQUID_GLASS_RUNTIME_VARIABLES = Object.keys(
  liquidGlassCssVariables(DEFAULT_LIQUID_GLASS.light)
)
const HOME_LIQUID_GLASS_RUNTIME_VARIABLES = Object.keys(
  liquidGlassHomeCardCssVariables(DEFAULT_LIQUID_GLASS.homeCards.light)
)
const EXPANDED_LIQUID_GLASS_RUNTIME_VARIABLES = Object.keys(
  liquidGlassExpandedCssVariables(DEFAULT_LIQUID_GLASS.light)
)

function resolveTone(): ThemeTone {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'pureWhite'
}

function resolveThemeMode(theme: AppSettings['theme']): ThemeTone {
  if (theme === 'dark') return 'dark'
  if (theme === 'pureWhite') return 'pureWhite'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'pureWhite'
}

function applySettingsThemeMode(theme: AppSettings['theme']): void {
  const tone = resolveThemeMode(theme)
  document.documentElement.dataset.theme = tone
  document.documentElement.dataset.themePreference = theme
  document.documentElement.style.colorScheme = tone === 'dark' ? 'dark' : 'light'
  themePreference = theme
}

type SettingsAppearanceInput = Pick<
  AppSettings,
  | 'accentColor'
  | 'lightAccentColor'
  | 'darkAccentColor'
  | 'fontFamily'
  | 'uiDensity'
  | 'appBackground'
  | 'surfaceMaterial'
  | 'liquidGlass'
>

function cacheSettingsAppearance(settings: SettingsAppearanceInput): void {
  lightAccentColor = settings.lightAccentColor || settings.accentColor || 'blue'
  darkAccentColor = settings.darkAccentColor || settings.accentColor || 'blue'
  uiFontFamily = normalizeAppFontFamily(settings.fontFamily)
  appBackground = settings.appBackground
  surfaceMaterial = normalizeSurfaceMaterial(settings.surfaceMaterial)
  liquidGlass = settings.liquidGlass ?? DEFAULT_LIQUID_GLASS
  document.documentElement.dataset.density = settings.uiDensity
}

export function syncThemeSettingsAppearance(settings: SettingsAppearanceInput): void {
  cacheSettingsAppearance(settings)
  applyLiquidGlassRuntimeVariables(resolveTone())
  if (loaded.value) queueMicrotask(() => void applyActiveTheme(false))
}

/**
 * Adaptive tone: the environment analysis samples the page backdrop and flips a
 * light-tone glass to its dark profile when the backdrop is bright. Published as
 * `data-te-lg-adaptive-tone` on the root; `overLight` remains the manual force.
 */
function resolveSharedGlassProfileIsDark(tone: ThemeTone): boolean {
  if (tone === 'dark' || liquidGlass.overLight) return true
  return (
    liquidGlass.adaptiveTone &&
    document.documentElement.dataset.teLiquidGlassAdaptiveTone === 'dark'
  )
}

function resolveHomeGlassProfileIsDark(tone: ThemeTone): boolean {
  if (tone === 'dark' || liquidGlass.homeCards.overLight) return true
  return (
    liquidGlass.adaptiveTone &&
    document.documentElement.dataset.teHomeLiquidGlassAdaptiveTone === 'dark'
  )
}

function applyLiquidGlassRuntimeVariables(tone: ThemeTone): void {
  const root = document.documentElement
  for (const name of LIQUID_GLASS_RUNTIME_VARIABLES) root.style.removeProperty(name)
  for (const name of HOME_LIQUID_GLASS_RUNTIME_VARIABLES) root.style.removeProperty(name)
  for (const name of EXPANDED_LIQUID_GLASS_RUNTIME_VARIABLES) root.style.removeProperty(name)
  if (usesSharedLiquidGlassProfile()) {
    const theme = resolveSharedGlassProfileIsDark(tone) ? liquidGlass.dark : liquidGlass.light
    for (const [name, value] of Object.entries(liquidGlassCssVariables(theme))) {
      root.style.setProperty(name, value, 'important')
    }
  }
  if (liquidGlass.homeCards.enabled) {
    const theme = resolveHomeGlassProfileIsDark(tone)
      ? liquidGlass.homeCards.dark
      : liquidGlass.homeCards.light
    for (const [name, value] of Object.entries(liquidGlassHomeCardCssVariables(theme))) {
      root.style.setProperty(name, value, 'important')
    }
  }
  if (liquidGlass.coverage === 'expanded') {
    const theme = resolveSharedGlassProfileIsDark(tone) ? liquidGlass.dark : liquidGlass.light
    for (const [name, value] of Object.entries(liquidGlassExpandedCssVariables(theme))) {
      root.style.setProperty(name, value, 'important')
    }
  }
  window.dispatchEvent(new Event(LIQUID_GLASS_TUNING_CHANGED_EVENT))
}

/**
 * Re-applies the liquid glass runtime variables after the environment analysis
 * changed the adaptive-tone attributes. Re-dispatches the tuning event so the
 * SVG filter re-reads its attribute inputs.
 */
export function refreshLiquidGlassRuntimeVariables(): void {
  applyLiquidGlassRuntimeVariables(resolveTone())
}

function usesSharedLiquidGlassProfile(): boolean {
  return (
    surfaceMaterial === 'liquidGlass' ||
    liquidGlass.navigationEnabled ||
    liquidGlass.playbarEnabled ||
    liquidGlass.settingsNavigationEnabled ||
    liquidGlass.coverage === 'expanded'
  )
}

function resolveSettingsAccentColor(color: string): string {
  return SETTINGS_ACCENT_COLORS[color] ?? color.trim()
}

function applySettingsAccentColor(tone: ThemeTone, variables: Record<string, string>): void {
  const color = resolveSettingsAccentColor(tone === 'dark' ? darkAccentColor : lightAccentColor)
  const background =
    variables['--te-app-bg'] ?? TWILIGHT_DEFAULT_THEME.variants[tone].tokens['surface.app']
  Object.assign(
    variables,
    themeTokensToCssVariables(createThemeAccentTokenOverrides(color, tone, background))
  )
}

function applyBootstrapThemeMode(
  bootstrap: Awaited<ReturnType<typeof window.api.settings.get>>
): void {
  applySettingsThemeMode(bootstrap.settings.theme)
  cacheSettingsAppearance(bootstrap.settings)
}

export async function bootstrapThemeRuntime(startupSnapshot?: AppStartupSnapshot): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = (async () => {
    if (!window.api?.themes || !window.api?.settings) return
    const startup = startupSnapshot ?? (await getStartupSnapshot())
    if (startup) {
      systemTone.value = startup.systemTone
      applyBootstrapThemeMode(startup.settings)
      acceptBootstrap(startup.themeBootstrap)
    } else {
      const [settingsBootstrap, themeBootstrap, nativeTone] = await Promise.all([
        window.api.settings.get(),
        window.api.themes.getBootstrap(),
        window.api.themes.getSystemTone()
      ])
      systemTone.value = nativeTone
      applyBootstrapThemeMode(settingsBootstrap)
      acceptBootstrap(themeBootstrap)
    }
    setupThemeListeners()
    await applyActiveTheme(false)
  })()
  try {
    await bootstrapPromise
  } finally {
    bootstrapPromise = null
  }
}

function acceptBootstrap(bootstrap: ThemeBootstrap): void {
  snapshot.value = bootstrap.library
  loaded.value = true
}

function setupThemeListeners(): void {
  if (listenersSetup || !window.api?.themes) return
  listenersSetup = true
  window.api.themes.onChanged((next) => {
    snapshot.value = next
    queueMicrotask(() => void applyActiveTheme(true))
  })
  window.api.themes.onSystemToneChanged((tone) => {
    systemTone.value = tone
    queueMicrotask(() => void applyActiveTheme(false))
  })
  window.api.settings.onChanged((next) => {
    if (next.settings.theme !== themePreference) {
      applySettingsThemeMode(next.settings.theme)
    }
    syncThemeSettingsAppearance(next.settings)
  })
  window.api.plugins.onChanged(() => {
    queueMicrotask(() => void applyActiveTheme(true))
  })
  const observer = new MutationObserver((mutations) => {
    if (
      mutations.some((mutation) => mutation.attributeName === 'data-theme') &&
      resolveTone() !== lastAppliedTone
    ) {
      queueMicrotask(() => void applyActiveTheme(false))
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

function getSelectedProfile(selection: ThemeSelection | undefined): ThemeProfileV2 | null {
  if (previewProfile.value) return previewProfile.value
  if (!selection) return null
  if (selection.kind === 'builtin') return getBuiltInThemePreset(selection.id)
  if (selection.kind !== 'user') return null
  const library = snapshot.value?.data
  if (!library) return null
  const profileId = selection.id
  return library.profiles.find((profile) => profile.id === profileId) ?? null
}

function resolvePluginTheme(
  contributions: ThemeContribution[],
  selection: Extract<ThemeSelection, { kind: 'plugin' }>
): ThemeContribution | null {
  const key = `${selection.pluginId}:${selection.themeId}`
  return contributions.find((theme) => getPluginThemeKey(theme) === key) ?? null
}

interface ThemeRuntimeState {
  css: string
  dataAttributes: Record<`data-te-${string}`, string>
  activeTheme: string
  presetLayout: string
  shellLayout: ThemeShellLayout | undefined
  tone: ThemeTone
  resourceUrls: string[]
}

/**
 * Built-in presets ship a layout identity, not just a palette. Derived user profiles keep the
 * layout of the preset they were forked from so customizing colors never collapses the geometry.
 */
function resolvePresetLayout(
  selection: ThemeSelection | undefined,
  profile: ThemeProfileV2 | null
): string {
  if (profile?.source?.kind === 'builtin-preset') return presetLayoutKey(profile.source.presetId)
  if (selection?.kind === 'builtin') return presetLayoutKey(selection.id)
  if (profile && isBuiltInThemePresetId(profile.id)) return presetLayoutKey(profile.id)
  return presetLayoutKey(TWILIGHT_DEFAULT_THEME_ID)
}

function presetLayoutKey(presetId: string): string {
  return presetId.startsWith('builtin:') ? presetId.slice('builtin:'.length) : presetId
}

async function buildThemeRuntimeState(syncPluginExtensions: boolean): Promise<ThemeRuntimeState> {
  const variables: Record<string, string> = {}
  let stylesheet = ''
  let assetStylesheet = ''
  let resourceUrls: string[] = []
  const selection = previewSelection.value ?? snapshot.value?.data.activeTheme
  const selectedProfile = getSelectedProfile(selection)
  let selectedPluginTheme: ThemeContribution | null = null
  let shellLayout: ThemeShellLayout | undefined
  let modes = resolveThemeProfileModes(selectedProfile)
  if (!selectedProfile && selection?.kind === 'plugin') {
    const registry = useExtensionRegistry()
    if (syncPluginExtensions) await registry.syncExtensions()
    selectedPluginTheme = resolvePluginTheme(registry.themeContributions.value, selection)
    if (selectedPluginTheme) {
      const contract = resolvePluginThemeRuntimeContract(selectedPluginTheme, resolveTone())
      modes = contract.modes
      shellLayout = contract.layout
    }
  }
  const tone = resolveRuntimeTone(selectedProfile, modes)
  if (selectedProfile) {
    await assertProfileAssetsAvailable(selectedProfile)
    const resolvedTokens = resolveThemeProfileTokens(selectedProfile, tone)
    Object.assign(variables, themeTokensToCssVariables(resolvedTokens))
    Object.assign(variables, {
      '--te-app-bg-image': 'none',
      '--te-local-bg-image': 'none',
      '--te-settings-bg-image': 'none',
      '--te-streaming-bg-image': 'none',
      '--te-player-bg-image': 'none'
    })
    const assetBindings = applyProfileAssetBindings(selectedProfile, variables)
    assetStylesheet = assetBindings.stylesheet
    resourceUrls = assetBindings.imageUrls
    applyProfileModeVariables(modes, tone, resolvedTokens, variables)
  } else {
    if (selection?.kind === 'plugin') {
      const contribution = selectedPluginTheme
      if (!contribution) {
        if (previewSelection.value) throw new Error('当前插件主题不可用')
        return {
          css: '',
          dataAttributes: {
            ...themeModesToDataAttributes(resolveThemeProfileModes(null)),
            'data-te-surface-material': surfaceMaterial,
            'data-te-liquid-glass-coverage': liquidGlass.coverage,
            'data-te-home-liquid-glass': liquidGlass.homeCards.enabled ? 'on' : 'off',
            'data-te-navigation-liquid-glass': liquidGlass.navigationEnabled ? 'on' : 'off',
            'data-te-playbar-liquid-glass': liquidGlass.playbarEnabled ? 'on' : 'off',
            'data-te-settings-navigation-liquid-glass': liquidGlass.settingsNavigationEnabled
              ? 'on'
              : 'off'
          },
          activeTheme: TWILIGHT_DEFAULT_THEME_ID,
          presetLayout: presetLayoutKey(TWILIGHT_DEFAULT_THEME_ID),
          shellLayout: undefined,
          tone,
          resourceUrls: []
        }
      }
      const contract = resolvePluginThemeRuntimeContract(contribution, tone)
      shellLayout = contract.layout
      Object.assign(variables, contract.variables)
      if (contract.usesStructuredModes) {
        applyProfileModeVariables(modes, tone, contract.resolvedTokens, variables)
      }
      if (contribution.stylesheet) {
        stylesheet = await window.api.extensions.readThemeStylesheet(contribution.stylesheet)
      }
    } else if (previewTone.value) {
      const resolvedTokens = TWILIGHT_DEFAULT_THEME.variants[tone].tokens
      Object.assign(variables, themeTokensToCssVariables(resolvedTokens))
      Object.assign(variables, {
        '--te-app-bg-image': 'none',
        '--te-local-bg-image': 'none',
        '--te-settings-bg-image': 'none',
        '--te-streaming-bg-image': 'none',
        '--te-player-bg-image': 'none'
      })
      applyProfileModeVariables(modes, tone, resolvedTokens, variables)
    }
  }
  applyAppBackgroundVariables(tone, variables)
  applySettingsAccentColor(tone, variables)
  // Settings-owned, like the accent color: an explicit global font outranks the
  // theme's own faces (including a profile's uploaded font asset). `system`
  // contributes nothing, so themed typography survives the default.
  Object.assign(variables, appFontCssVariables(uiFontFamily))
  applyLiquidGlassVariables(tone, variables)
  const root = Object.entries({ ...themeShellLayoutToCssVariables(shellLayout), ...variables })
    .map(([name, value]) => `  ${name}: ${value} !important;`)
    .join('\n')
  return {
    css: [assetStylesheet, root ? `:root {\n${root}\n}` : '', stylesheet]
      .filter(Boolean)
      .join('\n\n'),
    dataAttributes: {
      ...themeModesToDataAttributes(modes),
      ...themeShellLayoutToDataAttributes(shellLayout),
      // Settings-owned, so it wins over anything a theme profile declares.
      'data-te-surface-material': surfaceMaterial,
      'data-te-liquid-glass-coverage': liquidGlass.coverage,
      'data-te-home-liquid-glass': liquidGlass.homeCards.enabled ? 'on' : 'off',
      'data-te-navigation-liquid-glass': liquidGlass.navigationEnabled ? 'on' : 'off',
      'data-te-playbar-liquid-glass': liquidGlass.playbarEnabled ? 'on' : 'off',
      'data-te-settings-navigation-liquid-glass': liquidGlass.settingsNavigationEnabled
        ? 'on'
        : 'off'
    },
    activeTheme: activeThemeKey(selection),
    presetLayout: resolvePresetLayout(selection, selectedProfile),
    shellLayout,
    tone,
    resourceUrls
  }
}

/**
 * Emits shared and homepage-card glass variables only for their active scopes.
 */
function applyLiquidGlassVariables(tone: ThemeTone, variables: Record<string, string>): void {
  if (usesSharedLiquidGlassProfile()) {
    const theme = tone === 'dark' || liquidGlass.overLight ? liquidGlass.dark : liquidGlass.light
    Object.assign(variables, liquidGlassCssVariables(theme))
  }
  if (liquidGlass.homeCards.enabled) {
    const theme =
      tone === 'dark' || liquidGlass.homeCards.overLight
        ? liquidGlass.homeCards.dark
        : liquidGlass.homeCards.light
    Object.assign(variables, liquidGlassHomeCardCssVariables(theme))
  }
  if (liquidGlass.coverage === 'expanded') {
    const theme = tone === 'dark' || liquidGlass.overLight ? liquidGlass.dark : liquidGlass.light
    Object.assign(variables, liquidGlassExpandedCssVariables(theme))
  }
}

function applyAppBackgroundVariables(tone: ThemeTone, variables: Record<string, string>): void {
  if (!appBackground) return

  const colorMode = tone === 'dark' ? 'dark' : 'light'
  const globalBackground = appBackground.global
  variables['--te-app-bg'] = globalBackground[colorMode]
  variables['--te-app-bg-image'] = toBackgroundImageValue(globalBackground)

  for (const page of APP_BACKGROUND_PAGES) {
    const pageBackground = appBackground.pages[page]
    const resolvedBackground = pageBackground.inherit ? globalBackground : pageBackground
    variables[`--te-${page}-bg`] = resolvedBackground[colorMode]
    variables[`--te-${page}-bg-image`] = toBackgroundImageValue(resolvedBackground)
  }
  variables['--te-streaming-surface'] = 'var(--te-streaming-bg)'
}

function toBackgroundImageValue(background: AppBackgroundColorPair): string {
  if (background.kind !== 'image' || !background.image) return 'none'
  return `url("${escapeCssUrl(background.image)}")`
}

function resolveRuntimeTone(profile: ThemeProfileV2 | null, modes: ThemeModes): ThemeTone {
  if (previewTone.value) {
    clearTimedToneRefresh()
    return previewTone.value
  }
  const scheduling = modes.appearance?.toneScheduling ?? 'manual'
  if (scheduling === 'system') return systemTone.value
  if (scheduling === 'timed') {
    scheduleTimedToneRefresh(profile)
    return resolveScheduledThemeTone(
      new Date(),
      profile?.toneSchedule ?? DEFAULT_THEME_TONE_SCHEDULE
    )
  }
  clearTimedToneRefresh()
  // Manual presets must follow the app's stored preference (dark / pureWhite /
  // system). Reading the DOM attribute here lets a previous timed or system
  // preset leak its resolved tone into the next manual preset, so switching
  // presets while in dark mode could flip the whole app back to light.
  return resolveThemeMode(themePreference)
}

function scheduleTimedToneRefresh(profile: ThemeProfileV2 | null): void {
  clearTimedToneRefresh()
  const schedule = profile?.toneSchedule ?? DEFAULT_THEME_TONE_SCHEDULE
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const boundaries = [schedule.lightStartMinutes, schedule.darkStartMinutes]
    .map((minutes) => {
      const delta = minutes - currentMinutes
      return delta > 0 ? delta : delta + 24 * 60
    })
    .sort((a, b) => a - b)
  const delay = Math.max(
    1_000,
    boundaries[0] * 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds()
  )
  toneRefreshTimer = window.setTimeout(() => void applyActiveTheme(false), delay)
}

function clearTimedToneRefresh(): void {
  if (toneRefreshTimer === null) return
  window.clearTimeout(toneRefreshTimer)
  toneRefreshTimer = null
}

function applyProfileModeVariables(
  modes: ThemeModes,
  tone: ThemeTone,
  tokens: Record<string, string>,
  variables: Record<string, string>
): void {
  const background =
    tokens['surface.app'] ?? TWILIGHT_DEFAULT_THEME.variants[tone].tokens['surface.app']
  if (modes.appearance?.accentSource === 'cover' && adaptiveAccentColor.value) {
    Object.assign(
      variables,
      themeTokensToCssVariables(
        createThemeAccentTokenOverrides(adaptiveAccentColor.value, tone, background, true)
      )
    )
  }
  if (modes.appearance?.contrastGuard === 'enforce') {
    variables['--te-neutral-900'] = ensureThemeTextContrast(tokens['color.neutral.900'], background)
    variables['--te-settings-text'] = ensureThemeTextContrast(
      tokens['settings.text.primary'],
      tokens['surface.settings'] ?? background
    )
    variables['--te-navigation-text'] = ensureThemeTextContrast(
      tokens['navigation.text'],
      tokens['navigation.surface'] ?? background
    )
    variables['--te-chrome-text'] = ensureThemeTextContrast(
      tokens['typography.chromeText'],
      background
    )
  }
  const treatment = modes.appearance?.backgroundTreatment ?? 'solid'
  variables['--te-theme-background-image'] = 'none'
  if (treatment === 'gradient') {
    variables['--te-theme-background-image'] =
      `linear-gradient(${tokens['background.gradientAngle']}, ${tokens['background.gradientStart']}, ${tokens['background.gradientEnd']})`
  } else if (treatment === 'cover-blur' && adaptiveCoverUrl.value) {
    variables['--te-theme-background-image'] = `url("${escapeCssUrl(adaptiveCoverUrl.value)}")`
  } else if (treatment === 'image') {
    variables['--te-theme-background-image'] = variables['--te-app-bg-image'] ?? 'none'
  }
  if (treatment !== 'image') {
    for (const variable of [
      '--te-app-bg-image',
      '--te-local-bg-image',
      '--te-settings-bg-image',
      '--te-streaming-bg-image'
    ]) {
      variables[variable] = variables['--te-theme-background-image']
    }
  }
}

function escapeCssUrl(value: string): string {
  return value.replace(/["\\\n\r\f]/g, (character) => `\\${character}`)
}

export async function setThemeAdaptiveMedia(input: {
  identity: string
  accentColor: string
  coverUrl: string
}): Promise<void> {
  const identity = input.identity.trim().slice(0, 512)
  const accentColor = input.accentColor.trim()
  const coverUrl = input.coverUrl.trim()
  if (
    identity === adaptiveMediaIdentity &&
    accentColor === adaptiveAccentColor.value &&
    coverUrl === adaptiveCoverSource
  ) {
    return
  }
  const sequence = ++adaptiveMediaSequence
  let nextCoverUrl = ''
  let nextObjectUrl = ''
  try {
    if (/^data:image\//i.test(coverUrl)) {
      const blob = await (await fetch(coverUrl)).blob()
      nextObjectUrl = URL.createObjectURL(blob)
      nextCoverUrl = nextObjectUrl
    } else if (/^(?:blob:|twilight-media:|cover:|background:)/i.test(coverUrl)) {
      nextCoverUrl = coverUrl
    }
  } catch {
    nextCoverUrl = ''
  }
  if (sequence !== adaptiveMediaSequence) {
    if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl)
    return
  }
  if (adaptiveCoverObjectUrl) URL.revokeObjectURL(adaptiveCoverObjectUrl)
  adaptiveCoverObjectUrl = nextObjectUrl
  adaptiveCoverUrl.value = nextCoverUrl
  adaptiveCoverSource = coverUrl
  adaptiveAccentColor.value = accentColor || '#1a73e8'
  adaptiveMediaIdentity = identity
  if (loaded.value) await applyActiveTheme(false)
}

async function setThemePreviewTone(tone: ThemeTone | null): Promise<void> {
  previewTone.value = tone
  if (loaded.value) await applyActiveTheme(false)
}

function applyProfileAssetBindings(
  profile: ThemeProfileV2,
  variables: Record<string, string>
): { stylesheet: string; imageUrls: string[] } {
  const bindings = profile.assetBindings
  if (!bindings) return { stylesheet: '', imageUrls: [] }
  const assets = new Map((profile.assets ?? []).map((asset) => [asset.id, asset]))
  const imageUrls = new Set<string>()
  const backgroundBindings = [
    ['appBackground', '--te-app-bg-image'],
    ['localBackground', '--te-local-bg-image'],
    ['settingsBackground', '--te-settings-bg-image'],
    ['streamingBackground', '--te-streaming-bg-image'],
    ['playerBackground', '--te-player-bg-image']
  ] as const
  for (const [binding, variable] of backgroundBindings) {
    const asset = assets.get(bindings[binding] ?? '')
    if (asset?.type === 'image') {
      const url = themeAssetUrl(profile.id, asset)
      variables[variable] = `url("${url}")`
      imageUrls.add(url)
    }
  }
  const appBackground = variables['--te-app-bg-image']
  if (appBackground && appBackground !== 'none') {
    for (const [binding, variable] of backgroundBindings.slice(1)) {
      if (!bindings[binding]) variables[variable] = appBackground
    }
  }

  const fontBindings = [
    ['sansFont', '--te-font-sans'],
    ['displayFont', '--te-font-display'],
    ['roundedFont', '--te-font-rounded']
  ] as const
  const fontFaces: string[] = []
  for (const [binding, variable] of fontBindings) {
    const asset = assets.get(bindings[binding] ?? '')
    if (asset?.type !== 'font') continue
    const family = `TwilightTheme-${profile.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${asset.id}`
    variables[variable] =
      `'${family}', 'MiSans', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif`
    fontFaces.push(
      `@font-face { font-family: '${family}'; src: url("${themeAssetUrl(profile.id, asset)}") format('woff2'); font-display: swap; font-weight: 100 900; }`
    )
  }
  return { stylesheet: fontFaces.join('\n'), imageUrls: [...imageUrls] }
}

async function assertProfileAssetsAvailable(profile: ThemeProfileV2): Promise<void> {
  if (!profile.assetBindings) return
  const boundIds = new Set(
    Object.values(profile.assetBindings).filter((id): id is string => typeof id === 'string')
  )
  const assets = (profile.assets ?? []).filter((asset) => boundIds.has(asset.id))
  if (assets.length !== boundIds.size) throw new Error('主题绑定的本地资源不存在')
  const key = `${profile.id}:${assets
    .map((asset) => `${asset.id}:${asset.path}:${asset.type}`)
    .sort()
    .join('|')}`
  let validation = assetValidationCache.get(key)
  if (!validation) {
    validation = window.api.themes.validateAssets(profile.id, assets)
    assetValidationCache.set(key, validation)
    if (assetValidationCache.size > 64) {
      const oldest = assetValidationCache.keys().next().value
      if (oldest) assetValidationCache.delete(oldest)
    }
  }
  let valid = false
  try {
    valid = await validation
  } catch (cause) {
    assetValidationCache.delete(key)
    throw cause
  }
  if (!valid) {
    assetValidationCache.delete(key)
    throw new Error('主题绑定的本地资源不可用')
  }
}

function themeAssetUrl(profileId: string, asset: ThemeAssetReference): string {
  const path = asset.path.split('/').map(encodeURIComponent).join('/')
  return `theme-asset://asset/${encodeURIComponent(profileId)}/${path}`
}

function recordThemePerformance(operation: ThemePerformanceOperation, startedAt: number): void {
  const next = themePerformanceRecorder.record(operation, performance.now() - startedAt)
  themePerformance.value = next
  const performanceGlobal = globalThis as typeof globalThis & {
    __TWILIGHT_THEME_PERFORMANCE__?: ThemePerformanceSnapshot
  }
  performanceGlobal.__TWILIGHT_THEME_PERFORMANCE__ = next
}

function decodeThemeResources(urls: string[]): void {
  const uncached = urls.filter((url) => !assetDecodeCache.has(url))
  if (uncached.length === 0) return
  const startedAt = performance.now()
  const decode = Promise.allSettled(
    uncached.map(async (url) => {
      const image = new Image()
      image.src = url
      await image.decode()
    })
  ).then(() => {
    recordThemePerformance('resource-decode', startedAt)
  })
  for (const url of uncached) assetDecodeCache.set(url, decode)
  if (assetDecodeCache.size > 64) {
    const oldest = assetDecodeCache.keys().next().value
    if (oldest) assetDecodeCache.delete(oldest)
  }
}

export async function applyActiveTheme(
  syncPluginExtensions = true,
  operation: Extract<ThemePerformanceOperation, 'preview' | 'apply'> = 'apply'
): Promise<void> {
  const sequence = ++applySequence
  const startedAt = performance.now()
  try {
    const state = await buildThemeRuntimeState(syncPluginExtensions)
    if (sequence !== applySequence) return
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.appendChild(style)
    }
    style.textContent = state.css
    for (const attribute of THEME_MANAGED_DATA_ATTRIBUTES) {
      document.documentElement.removeAttribute(attribute)
    }
    for (const [attribute, value] of Object.entries(state.dataAttributes)) {
      document.documentElement.setAttribute(attribute, value)
    }
    const toneChanged = resolveTone() !== state.tone
    if (toneChanged && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      document.documentElement.classList.add('te-theme-tone-transition')
      window.setTimeout(
        () => document.documentElement.classList.remove('te-theme-tone-transition'),
        220
      )
    }
    lastAppliedTone = state.tone
    document.documentElement.dataset.theme = state.tone
    document.documentElement.style.colorScheme = state.tone === 'dark' ? 'dark' : 'light'
    applyLiquidGlassRuntimeVariables(state.tone)
    document.documentElement.dataset.activeTheme = state.activeTheme
    document.documentElement.dataset.tePresetLayout = state.presetLayout
    if (operation === 'apply') {
      persistThemeRuntimeCache({
        css: state.css,
        attributes: state.dataAttributes,
        activeTheme: state.activeTheme,
        tone: state.tone
      })
      markThemeRuntimeFresh()
    }
    error.value = ''
    recordThemePerformance(operation, startedAt)
    decodeThemeResources(state.resourceUrls)
  } catch (cause) {
    if (sequence !== applySequence) return
    error.value = cause instanceof Error ? cause.message : '主题应用失败'
  }
}

function activeThemeKey(selection: ThemeSelection | undefined): string {
  if (!selection) return TWILIGHT_DEFAULT_THEME_ID
  if (selection.kind === 'plugin') return `${selection.pluginId}:${selection.themeId}`
  return selection.id
}

export function useThemeStore(): {
  snapshot: Ref<ThemeLibrarySnapshot | null>
  profiles: ComputedRef<ThemeProfileV2[]>
  activeTheme: ComputedRef<ThemeSelection>
  presetLayout: ComputedRef<string>
  activeProfile: ComputedRef<ThemeProfileV2 | null>
  previewProfile: Ref<ThemeProfileV2 | null>
  previewSelection: Ref<ThemeSelection | null>
  loaded: Ref<boolean>
  saving: Ref<boolean>
  error: Ref<string>
  performance: Ref<ThemePerformanceSnapshot>
  load: () => Promise<void>
  preview: (profile: ThemeProfileV2 | null) => Promise<void>
  previewTheme: (selection: ThemeSelection | null) => Promise<void>
  createProfile: (name?: string, source?: ThemeProfileV2 | null) => ThemeProfileV2
  saveProfile: (profile: ThemeProfileV2) => Promise<ThemeLibrarySnapshot>
  deleteProfile: (profileId: string) => Promise<ThemeLibrarySnapshot>
  setActive: (selection: ThemeSelection) => Promise<ThemeLibrarySnapshot>
  setWindowInheritance: (inheritance: ThemeWindowInheritance) => Promise<ThemeLibrarySnapshot>
  importTheme: () => Promise<ThemeLibrarySnapshot | null>
  exportTheme: (profileId: string) => Promise<string | null>
  importAsset: (profileId: string, type: ThemeAssetType) => Promise<ThemeAssetReference | null>
  copyAssets: (sourceProfileId: string, targetProfileId: string) => Promise<void>
  setAdaptiveMedia: typeof setThemeAdaptiveMedia
  setPreviewTone: typeof setThemePreviewTone
} {
  const profiles = computed(() => snapshot.value?.data.profiles ?? [])
  const activeTheme = computed(
    () =>
      snapshot.value?.data.activeTheme ??
      ({ kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID } as const)
  )
  const activeProfile = computed(() => {
    const selection = activeTheme.value
    return selection.kind === 'user'
      ? (profiles.value.find((profile) => profile.id === selection.id) ?? null)
      : null
  })
  const presetLayout = computed(() => {
    const selection = previewSelection.value ?? activeTheme.value
    return resolvePresetLayout(selection, getSelectedProfile(selection))
  })

  async function load(): Promise<void> {
    await bootstrapThemeRuntime()
  }

  async function preview(profile: ThemeProfileV2 | null): Promise<void> {
    previewProfile.value = profile
    previewSelection.value = profile ? { kind: 'user', id: profile.id } : null
    await applyActiveTheme(false, 'preview')
  }

  async function previewTheme(selection: ThemeSelection | null): Promise<void> {
    previewProfile.value = null
    previewSelection.value = selection
    await applyActiveTheme(selection?.kind === 'plugin', 'preview')
  }

  function createProfile(
    name = '自定义主题',
    source: ThemeProfileV2 | null = null
  ): ThemeProfileV2 {
    const now = new Date().toISOString()
    const derivedPresetId = source && isBuiltInThemePresetId(source.id) ? source.id : null
    const derivedPreset = derivedPresetId ? source : null
    return {
      schemaVersion: 2,
      id: `user:${crypto.randomUUID()}`,
      name,
      description: source?.description ?? '',
      baseThemeId: derivedPresetId ?? source?.baseThemeId ?? TWILIGHT_DEFAULT_THEME_ID,
      createdAt: now,
      updatedAt: now,
      overrides: {
        pureWhite: { ...(derivedPreset ? {} : (source?.overrides.pureWhite ?? {})) },
        dark: { ...(derivedPreset ? {} : (source?.overrides.dark ?? {})) }
      },
      modes: source?.modes && !derivedPreset ? JSON.parse(JSON.stringify(source.modes)) : {},
      toneSchedule: source?.toneSchedule && !derivedPreset ? { ...source.toneSchedule } : undefined,
      source: derivedPreset
        ? { kind: 'builtin-preset' as const, presetId: derivedPresetId! }
        : source?.source
          ? { ...source.source }
          : undefined,
      windowDefaults:
        source?.windowDefaults && !derivedPreset
          ? JSON.parse(JSON.stringify(source.windowDefaults))
          : undefined,
      assets: derivedPreset ? undefined : source?.assets?.map((asset) => ({ ...asset })),
      assetBindings:
        source?.assetBindings && !derivedPreset ? { ...source.assetBindings } : undefined
    }
  }

  async function runSave(
    operation: (revision: number) => Promise<ThemeLibrarySnapshot>
  ): Promise<ThemeLibrarySnapshot> {
    saving.value = true
    error.value = ''
    try {
      const next = await operation(snapshot.value?.revision ?? 0)
      snapshot.value = next
      await applyActiveTheme(true)
      return next
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '主题保存失败'
      previewProfile.value = null
      previewSelection.value = null
      await applyActiveTheme(false)
      error.value = message
      throw cause
    } finally {
      saving.value = false
    }
  }

  async function saveProfile(profile: ThemeProfileV2): Promise<ThemeLibrarySnapshot> {
    // Vue ref/reactive drafts are Proxies; Electron IPC cannot structured-clone them.
    const plain = JSON.parse(JSON.stringify(profile)) as ThemeProfileV2
    return await runSave((revision) => window.api.themes.save(plain, revision))
  }

  async function deleteProfile(profileId: string): Promise<ThemeLibrarySnapshot> {
    return await runSave((revision) => window.api.themes.delete(profileId, revision))
  }

  async function setActive(selection: ThemeSelection): Promise<ThemeLibrarySnapshot> {
    saving.value = true
    error.value = ''
    try {
      const plain = JSON.parse(JSON.stringify(selection)) as ThemeSelection
      const next = await window.api.themes.setActive(plain, snapshot.value?.revision ?? 0)
      snapshot.value = next
      previewProfile.value = null
      previewSelection.value = null
      await nextTick()
      await applyActiveTheme(true)
      return next
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '主题应用失败'
      error.value = message
      throw cause
    } finally {
      saving.value = false
    }
  }

  async function setWindowInheritance(
    inheritance: ThemeWindowInheritance
  ): Promise<ThemeLibrarySnapshot> {
    return await runSave((revision) =>
      window.api.themes.setWindowInheritance(inheritance, revision)
    )
  }

  async function importTheme(): Promise<ThemeLibrarySnapshot | null> {
    try {
      const next = await window.api.themes.importTheme(snapshot.value?.revision ?? 0)
      if (next) snapshot.value = next
      return next
    } catch (cause) {
      await restorePersistedTheme()
      throw cause
    }
  }

  async function exportTheme(profileId: string): Promise<string | null> {
    try {
      return await window.api.themes.exportTheme(profileId)
    } catch (cause) {
      await restorePersistedTheme()
      throw cause
    }
  }

  async function importAsset(
    profileId: string,
    type: ThemeAssetType
  ): Promise<ThemeAssetReference | null> {
    try {
      return await window.api.themes.importAsset(profileId, type)
    } catch (cause) {
      await restorePersistedTheme()
      throw cause
    }
  }

  async function copyAssets(sourceProfileId: string, targetProfileId: string): Promise<void> {
    try {
      await window.api.themes.copyAssets(sourceProfileId, targetProfileId)
    } catch (cause) {
      await restorePersistedTheme()
      throw cause
    }
  }

  async function restorePersistedTheme(): Promise<void> {
    previewProfile.value = null
    previewSelection.value = null
    await applyActiveTheme(false)
  }

  return {
    snapshot,
    profiles,
    activeTheme,
    presetLayout,
    activeProfile,
    previewProfile,
    previewSelection,
    loaded,
    saving,
    error,
    performance: themePerformance,
    load,
    preview,
    previewTheme,
    createProfile,
    saveProfile,
    deleteProfile,
    setActive,
    setWindowInheritance,
    importTheme,
    exportTheme,
    importAsset,
    copyAssets,
    setAdaptiveMedia: setThemeAdaptiveMedia,
    setPreviewTone: setThemePreviewTone
  }
}

export const themeTokenDefinitions = THEME_TOKEN_DEFINITIONS
export const defaultThemeDocument = TWILIGHT_DEFAULT_THEME
export const themeEpochIso = EPOCH_ISO
