import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  DEFAULT_MINI_PLAYER_SETTINGS,
  cloneMiniPlayerSettings
} from '../../../shared/miniPlayer.ts'
import { createLegacyDspGraph } from '../../../shared/dspGraph.ts'
import { DEFAULT_SLEEP_TIMER_SETTINGS } from '../../../shared/sleepTimer.ts'
import {
  DEFAULT_DESKTOP_LYRICS_SETTINGS,
  normalizeDesktopLyricsSettings
} from '../../../shared/desktopLyrics.ts'
import {
  DEFAULT_LYRICS_APPEARANCE,
  cloneLyricsAppearance,
  normalizeLyricsAppearance
} from '../../../shared/lyricsAppearance.ts'
import {
  DEFAULT_LYRICS_PRESET_CONFIG,
  cloneLyricsPresetConfig,
  normalizeLyricsPresetConfig
} from '../../../shared/lyricsPresets.ts'
import { DEFAULT_GENRE_SEPARATORS } from '../../../shared/genreSeparators.ts'
import { DEFAULT_LIQUID_GLASS, normalizeLiquidGlass } from '../../../shared/liquidGlass.ts'
import {
  DEFAULT_PLAYER_BAR_SETTINGS,
  clonePlayerBarSettings,
  normalizePlayerBarSettings
} from '../../../shared/playerBar.ts'
import type { AppStartupSnapshot } from '../../../shared/appStartup.ts'
import type {
  AppSettings,
  AudioOutputId,
  AudioProcessingSettings,
  PlayerShortcutStatus,
  SettingsSnapshot,
  WindowTransparencyEffectSettings
} from '../types/settings'

function getFallbackAudioOutput(): AudioOutputId {
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac')) return 'coreaudio'
  if (platform.includes('linux')) return 'alsa'
  return 'wasapi'
}

const fallbackAudioProcessing: AudioProcessingSettings = {
  dspEnabled: false,
  directMode: false,
  clipGuard: true,
  fftEnabled: true,
  fftResolution: 8192,
  highResolution: true,
  dsdToPcm: false,
  dsdOutputMode: 'auto',
  dsdRoute: {
    enabled: false,
    backend: '',
    device: '',
    applyToPcmToDsd: true,
    strictPassthrough: false
  },
  sacdProgramMode: 'auto',
  eqEnabled: false,
  eqMode: 'graphic',
  eqPreamp: 0,
  eqBands: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequency) => ({
    frequency,
    gain: 0,
    q: 1,
    filterType: 'peak'
  })),
  volumeNormalization: 'off',
  replayGainPreamp: 0,
  replayGainFallback: 0,
  replayGainClip: true,
  convolverEnabled: false,
  convolverIrPath: '',
  crossfeedEnabled: false,
  crossfeedStrength: 0,
  crossfeedDelayMs: 0.35,
  crossfeedCutoffHz: 700,
  gapless: true,
  crossfadeSeconds: 0
}

const fallbackHeadphoneCompensation = {
  enabled: false,
  productId: '',
  productName: '',
  vendorName: '',
  eqId: '',
  author: '',
  details: '',
  link: '',
  preampDb: 0,
  bands: []
}

const fallbackSettings: AppSettings = {
  autoCheckLogin: true,
  autoLaunch: false,
  minimizeToTray: false,
  launchAtLogin: false,
  hardwareAcceleration: true,
  globalShortcuts: false,
  globalShortcutBindings: {
    previous: 'CommandOrControl+Alt+Left',
    next: 'CommandOrControl+Alt+Right',
    playPause: 'CommandOrControl+Alt+Space',
    toggleDesktopLyrics: 'CommandOrControl+Alt+D',
    toggleDesktopLyricsLock: 'CommandOrControl+Alt+L'
  },
  musicCachePath: '',
  cachePath: '',
  cachePolicy: {
    cover: true,
    lyrics: true,
    metadata: true,
    streamingAudio: 'provider'
  },
  autoAnalyzeBpm: true,
  closeWindowBehavior: 'quit',
  closeToTray: false,
  taskbarThumbarButtonsEnabled: true,
  onboardingCompleted: false,
  developerMode: false,
  startupHomePage: 'local',
  trackActivationMode: 'singleClick',
  language: 'system',
  theme: 'system',
  pluginThemeId: null,
  activeTheme: { kind: 'builtin', id: 'builtin:twilight-echo-default' },
  themeWindowInheritance: { miniPlayer: true, desktopLyrics: true },
  motionPreference: 'system',
  blurEffect: true,
  windowTransparency: false,
  windowTransparencyEffect: {
    surfaceOpacity: 55,
    surfaceBlur: 0,
    cardOpacity: 60,
    cardBlur: 24
  },
  useCoverTheme: true,
  lyricsAppearance: cloneLyricsAppearance(DEFAULT_LYRICS_APPEARANCE),
  lyricsPresets: cloneLyricsPresetConfig(DEFAULT_LYRICS_PRESET_CONFIG),
  libraryFolders: [],
  downloadFolder: '',
  genreSeparators: DEFAULT_GENRE_SEPARATORS,
  watchLibrary: true,
  onlineLyricsFallback: false,
  smtcEnabled: true,
  discordRpcEnabled: false,
  accentColor: 'blue',
  lightAccentColor: 'blue',
  darkAccentColor: 'blue',
  fontFamily: 'system',
  uiDensity: 'standard',
  appBackground: {
    global: {
      light: '#f4f4f7',
      dark: '#17181a',
      kind: 'color',
      image: ''
    },
    pages: {
      local: { inherit: true, light: '#ffffff', dark: '#17181a', kind: 'color', image: '' },
      settings: { inherit: true, light: '#f4f4f7', dark: '#17181a', kind: 'color', image: '' },
      streaming: { inherit: true, light: '#fafbfe', dark: '#17181a', kind: 'color', image: '' },
      player: { inherit: true, light: '#080e17', dark: '#17181a', kind: 'color', image: '' }
    }
  },
  cardAppearance: {
    enabled: false,
    light: {
      blurRadius: 20,
      blurSaturation: 150,
      backgroundColor: '#ffffff',
      backgroundOpacity: 100,
      borderColor: '#0f172a',
      borderOpacity: 8,
      borderWidth: 1,
      borderRadius: 16,
      shadowStrength: 'medium',
      hoverEffect: 'lift',
      glassHighlight: true
    },
    dark: {
      blurRadius: 20,
      blurSaturation: 150,
      backgroundColor: '#181818',
      backgroundOpacity: 100,
      borderColor: '#ffffff',
      borderOpacity: 10,
      borderWidth: 1,
      borderRadius: 16,
      shadowStrength: 'medium',
      hoverEffect: 'lift',
      glassHighlight: true
    },
    background: {
      enabled: false,
      light: { blur: 0, brightness: 100, dim: 0 },
      dark: { blur: 0, brightness: 100, dim: 0 }
    }
  },
  surfaceMaterial: 'standard',
  liquidGlass: DEFAULT_LIQUID_GLASS,
  playerBar: clonePlayerBarSettings(DEFAULT_PLAYER_BAR_SETTINGS),
  nowPlayingBackground: 'blur',
  playbackResumeMode: 'off',
  previousButtonAction: 'restart',
  sleepTimer: DEFAULT_SLEEP_TIMER_SETTINGS,
  ncmPlaybackQuality: 'auto',
  playMode: 'sequential',
  softwareVolume: 0.7,
  audioOutput: getFallbackAudioOutput(),
  audioDevice: 'auto',
  audioExclusiveMode: false,
  audioOutputConfig: {
    preferredBufferSize: 0,
    routingMode: 'auto',
    wasapiExclusivePushMode: false,
    pcmToDsdMode: 'off'
  },
  audioProcessing: fallbackAudioProcessing,
  dspScenes: [
    {
      id: 'default',
      name: 'Default',
      enabled: true,
      priority: 0,
      rules: {},
      graph: createLegacyDspGraph(fallbackAudioProcessing)
    }
  ],
  dspPinnedSceneId: null,
  headphoneCompensation: fallbackHeadphoneCompensation,
  audioEqPresets: [],
  desktopLyrics: { ...DEFAULT_DESKTOP_LYRICS_SETTINGS },
  miniPlayer: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
  proxyMode: 'auto',
  proxyHost: '',
  proxyPort: 0,
  proxyAllowDirectFallback: false,
  streamingActiveProvider: 'ncm',
  remoteControlEnabled: false,
  remoteControlPort: 0
}

/**
 * Strip Vue's reactive proxies off a settings patch before it crosses the IPC
 * bridge.
 *
 * `settings` is a deep `ref`, so any nested object read off `settings.value`
 * comes back as a reactive Proxy. The usual patch idiom spreads one level
 * (`{ ...settings.value.playerBar, mode }`), which copies that level's own
 * values but hands every *nested* object over by reference — as a Proxy. The
 * window runs `sandbox: true` + `contextIsolation: true`, so `window.api` is a
 * contextBridge surface and arguments are structurally cloned at the boundary
 * itself; a Proxy fails that clone with "An object could not be cloned" before
 * any preload code runs. (The `JSON` round trip inside `settingsApi.update` sits
 * on the far side of that boundary and can never help.)
 *
 * Patches that only carry primitives were fine by accident, which is why this
 * only surfaced once `playerBar` grew a nested `layout`. Normalizing here rather
 * than at each call site means a new nested setting cannot reintroduce the crash.
 */
function toWirePatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  return JSON.parse(JSON.stringify(patch)) as Partial<AppSettings>
}

const settings = ref<AppSettings>({ ...fallbackSettings })
const defaults = ref<SettingsSnapshot['defaults']>({ cachePath: '' })
const paths = ref<SettingsSnapshot['paths'] | null>(null)
const appVersion = ref('')
const platform = ref('')
const windowTransparencySupported = ref(false)
const restartReasons = ref<string[]>([])
const loaded = ref(false)
const loading = ref(false)
const saving = ref(false)
const lastSettingsError = ref<string | null>(null)
const clearingCache = ref(false)
const cacheSize = ref<number | null>(null)
const clearingBpmAnalysisCache = ref(false)
const bpmAnalysisCacheSize = ref<number | null>(null)
const clearingLoudnessAnalysisCache = ref(false)
const loudnessAnalysisCacheSize = ref<number | null>(null)
let listenerSetup = false
let settingsUpdateQueue: Promise<void> = Promise.resolve()
let pendingSettingsUpdates = 0
let settingsUpdateSequence = 0

function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'Calculating...'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

const THEME_OWNED_INLINE_STYLE_VARS = Object.freeze([
  '--te-accent',
  '--te-accent-soft',
  '--te-primary-500',
  '--te-primary-400',
  '--te-primary-300',
  '--te-primary-rgb',
  '--te-glow-main',
  '--te-active-bg',
  '--te-font-sans',
  '--te-app-bg',
  '--te-app-bg-image',
  '--te-local-bg',
  '--te-local-bg-image',
  '--te-settings-bg',
  '--te-settings-bg-image',
  '--te-streaming-bg',
  '--te-streaming-bg-image',
  '--te-player-bg',
  '--te-player-bg-image',
  '--te-streaming-surface',
  '--te-card-blur',
  '--te-card-saturate',
  '--te-card-bg',
  '--te-card-bg-solid',
  '--te-card-border',
  '--te-card-border-width',
  '--te-card-radius',
  '--te-card-shadow',
  '--te-card-hover-transform',
  '--te-card-hover-shadow',
  '--te-card-glass-highlight',
  '--te-bg-blur',
  '--te-bg-brightness',
  '--te-bg-dim',
  '--brand-50',
  '--brand-100',
  '--brand-200',
  '--brand-300',
  '--brand-400',
  '--brand-500',
  '--brand-600',
  '--brand-700'
])

function clearLegacyThemeOwnedInlineStyles(): void {
  const root = document.documentElement
  for (const name of THEME_OWNED_INLINE_STYLE_VARS) root.style.removeProperty(name)
  delete root.dataset.cardCustom
  delete root.dataset.cardBgEffect
  delete root.dataset.accent
}

function syncThemeAppearance(): void {
  void import('./useThemeStore.ts').then(({ syncThemeSettingsAppearance }) => {
    syncThemeSettingsAppearance(settings.value)
  })
}

function applyDomSettings(): void {
  clearLegacyThemeOwnedInlineStyles()
  syncThemeAppearance()
  document.documentElement.dataset.themePreference = settings.value.theme
  document.body.classList.toggle('te-no-blur', !settings.value.blurEffect)
  document.documentElement.dataset.platform = platform.value || 'unknown'
  const transparencyActive =
    settings.value.windowTransparency === true && windowTransparencySupported.value === true
  document.documentElement.dataset.windowTransparent = transparencyActive ? 'on' : 'off'
  applyWindowTransparencyEffect()
  document.documentElement.style.removeProperty('--te-lyric-font-size')
  document.documentElement.dataset.density = settings.value.uiDensity
  document.documentElement.dataset.nowPlayingBg = settings.value.nowPlayingBackground
  delete document.documentElement.dataset.lyricAlign
  document.documentElement.style.removeProperty('--te-lyric-dim-opacity')
}

function applyWindowTransparencyEffect(): void {
  const root = document.documentElement
  const tpVars = [
    '--te-tp-surface-alpha',
    '--te-tp-surface-blur',
    '--te-tp-card-alpha',
    '--te-tp-card-blur',
    '--te-tp-base-alpha'
  ]
  const active =
    settings.value.windowTransparency === true && windowTransparencySupported.value === true
  if (!active) {
    for (const v of tpVars) root.style.removeProperty(v)
    return
  }
  const effect: WindowTransparencyEffectSettings =
    settings.value.windowTransparencyEffect ?? fallbackSettings.windowTransparencyEffect
  const surfaceAlpha = effect.surfaceOpacity / 100
  // 底层基底保留一个不透明度下限，避免用户把表面不透明度调得过低时整窗内容消失。
  const baseAlpha = Math.min(0.85, Math.max(0.55, surfaceAlpha))
  root.style.setProperty('--te-tp-surface-alpha', surfaceAlpha.toFixed(2))
  root.style.setProperty('--te-tp-surface-blur', `${effect.surfaceBlur}px`)
  root.style.setProperty('--te-tp-card-alpha', `${(effect.cardOpacity / 100).toFixed(2)}`)
  root.style.setProperty('--te-tp-card-blur', `${effect.cardBlur}px`)
  root.style.setProperty('--te-tp-base-alpha', baseAlpha.toFixed(2))
}

function applySnapshot(snapshot: SettingsSnapshot): void {
  const incoming = snapshot.settings ?? {}
  settings.value = {
    ...fallbackSettings,
    ...incoming,
    cachePolicy: {
      ...fallbackSettings.cachePolicy,
      ...(incoming.cachePolicy ?? {})
    },
    lyricsAppearance: normalizeLyricsAppearance(incoming.lyricsAppearance),
    lyricsPresets: normalizeLyricsPresetConfig(incoming.lyricsPresets),
    desktopLyrics: normalizeDesktopLyricsSettings(incoming.desktopLyrics, { resetLegacy: false }),
    cardAppearance: {
      ...fallbackSettings.cardAppearance,
      ...(incoming.cardAppearance ?? {}),
      light: {
        ...fallbackSettings.cardAppearance.light,
        ...(incoming.cardAppearance?.light ?? {})
      },
      dark: { ...fallbackSettings.cardAppearance.dark, ...(incoming.cardAppearance?.dark ?? {}) },
      background: {
        ...fallbackSettings.cardAppearance.background,
        ...(incoming.cardAppearance?.background ?? {}),
        light: {
          ...fallbackSettings.cardAppearance.background.light,
          ...(incoming.cardAppearance?.background?.light ?? {})
        },
        dark: {
          ...fallbackSettings.cardAppearance.background.dark,
          ...(incoming.cardAppearance?.background?.dark ?? {})
        }
      }
    },
    liquidGlass: normalizeLiquidGlass(incoming.liquidGlass)
  }
  defaults.value = { ...snapshot.defaults }
  paths.value = { ...snapshot.paths }
  appVersion.value = snapshot.appVersion
  platform.value = snapshot.platform
  windowTransparencySupported.value = snapshot.windowTransparencySupported === true
  restartReasons.value = [...snapshot.restartReasons]
  loaded.value = true
  applyDomSettings()
}

function setupListener(): void {
  if (listenerSetup) return
  listenerSetup = true
  window.api.settings.onChanged((snapshot) => {
    if (pendingSettingsUpdates > 0) return
    applySnapshot(snapshot)
  })
}

if (typeof document !== 'undefined') {
  const applyInitialDomSettings = (): void => {
    applyDomSettings()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyInitialDomSettings, { once: true })
  } else {
    applyInitialDomSettings()
  }
}

export function useSettingsStore(): {
  settings: Ref<AppSettings>
  defaults: Ref<SettingsSnapshot['defaults']>
  paths: Ref<SettingsSnapshot['paths'] | null>
  appVersion: Ref<string>
  platform: Ref<string>
  windowTransparencySupported: Ref<boolean>
  loaded: Ref<boolean>
  loading: Ref<boolean>
  saving: Ref<boolean>
  lastSettingsError: Ref<string | null>
  clearingCache: Ref<boolean>
  cacheSize: Ref<number | null>
  formattedCacheSize: ComputedRef<string>
  clearingBpmAnalysisCache: Ref<boolean>
  bpmAnalysisCacheSize: Ref<number | null>
  formattedBpmAnalysisCacheSize: ComputedRef<string>
  clearingLoudnessAnalysisCache: Ref<boolean>
  loudnessAnalysisCacheSize: Ref<number | null>
  formattedLoudnessAnalysisCacheSize: ComputedRef<string>
  restartRequired: ComputedRef<boolean>
  restartReasons: Ref<string[]>
  loadSettings: () => Promise<AppSettings>
  hydrateStartupSnapshot: (snapshot: AppStartupSnapshot) => AppSettings
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  chooseCacheFolder: () => Promise<void>
  chooseDownloadFolder: () => Promise<void>
  resetDownloadFolder: () => Promise<void>
  chooseBackgroundImage: () => Promise<string | null>
  importBackgroundImage: (file: File) => Promise<string | null>
  exportSettingsBackup: () => Promise<string>
  importSettingsBackup: (json: string) => Promise<AppSettings>
  resetCacheFolder: () => Promise<void>
  refreshCacheSize: () => Promise<void>
  clearCache: () => Promise<void>
  refreshBpmAnalysisCacheSize: () => Promise<void>
  clearBpmAnalysisCache: () => Promise<void>
  refreshLoudnessAnalysisCacheSize: () => Promise<void>
  clearLoudnessAnalysisCache: () => Promise<void>
  openCacheFolder: () => Promise<void>
  relaunch: () => Promise<void>
  addLibraryFolder: () => Promise<void>
  removeLibraryFolder: (folder: string) => Promise<void>
  openExternalUrl: (url: string) => Promise<void>
  getShortcutStatuses: () => Promise<PlayerShortcutStatus[]>
} {
  const formattedCacheSize = computed(() => formatBytes(cacheSize.value))
  const formattedBpmAnalysisCacheSize = computed(() => formatBytes(bpmAnalysisCacheSize.value))
  const formattedLoudnessAnalysisCacheSize = computed(() =>
    formatBytes(loudnessAnalysisCacheSize.value)
  )
  const restartRequired = computed(() => restartReasons.value.length > 0)

  function hydrateStartupSnapshot(startup: AppStartupSnapshot): AppSettings {
    setupListener()
    applySnapshot(startup.settings)
    return settings.value
  }

  async function loadSettings(): Promise<AppSettings> {
    setupListener()
    loading.value = true
    try {
      const snapshot = await window.api.settings.get()
      applySnapshot(snapshot)
      return settings.value
    } finally {
      loading.value = false
    }
  }

  async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const sequence = ++settingsUpdateSequence
    pendingSettingsUpdates += 1
    saving.value = true
    if (Object.prototype.hasOwnProperty.call(patch, 'appBackground') && patch.appBackground) {
      settings.value = {
        ...settings.value,
        appBackground: patch.appBackground
      }
      applyDomSettings()
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'cardAppearance') && patch.cardAppearance) {
      settings.value = {
        ...settings.value,
        cardAppearance: patch.cardAppearance
      }
      applyDomSettings()
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'surfaceMaterial') && patch.surfaceMaterial) {
      settings.value = {
        ...settings.value,
        surfaceMaterial: patch.surfaceMaterial
      }
      applyDomSettings()
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'liquidGlass') && patch.liquidGlass) {
      settings.value = {
        ...settings.value,
        liquidGlass: normalizeLiquidGlass(patch.liquidGlass)
      }
      applyDomSettings()
    }
    // Playbar shape must flip on the same frame as the click; waiting for the
    // IPC round trip shows one frame of the old shape.
    if (Object.prototype.hasOwnProperty.call(patch, 'playerBar') && patch.playerBar) {
      settings.value = {
        ...settings.value,
        playerBar: normalizePlayerBarSettings(patch.playerBar)
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lyricsAppearance') && patch.lyricsAppearance) {
      settings.value = {
        ...settings.value,
        lyricsAppearance: cloneLyricsAppearance(patch.lyricsAppearance)
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lyricsPresets') && patch.lyricsPresets) {
      settings.value = {
        ...settings.value,
        lyricsPresets: cloneLyricsPresetConfig(patch.lyricsPresets)
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'miniPlayer') && patch.miniPlayer) {
      settings.value = {
        ...settings.value,
        miniPlayer: cloneMiniPlayerSettings(patch.miniPlayer)
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, 'windowTransparencyEffect') &&
      patch.windowTransparencyEffect
    ) {
      settings.value = {
        ...settings.value,
        windowTransparencyEffect: patch.windowTransparencyEffect
      }
      applyDomSettings()
    }
    const runUpdate = settingsUpdateQueue.then(async () => {
      const snapshot = await window.api.settings.update(toWirePatch(patch))
      if (sequence === settingsUpdateSequence) {
        applySnapshot(snapshot)
      }
      lastSettingsError.value = null
      return settings.value
    })
    settingsUpdateQueue = runUpdate.then(
      () => undefined,
      () => undefined
    )
    try {
      return await runUpdate
    } catch (error) {
      lastSettingsError.value = error instanceof Error ? error.message : String(error)
      try {
        const snapshot = await window.api.settings.get()
        if (sequence === settingsUpdateSequence) {
          applySnapshot(snapshot)
        }
      } catch {
        // Keep optimistic state if reload also fails; caller still sees the error.
      }
      throw error
    } finally {
      pendingSettingsUpdates = Math.max(0, pendingSettingsUpdates - 1)
      saving.value = pendingSettingsUpdates > 0
    }
  }

  async function chooseCacheFolder(): Promise<void> {
    const folder = await window.api.settings.chooseCacheFolder()
    if (folder) {
      await updateSettings({ cachePath: folder })
    }
  }

  async function chooseDownloadFolder(): Promise<void> {
    const folder = await window.api.settings.chooseDownloadFolder()
    if (folder) {
      await updateSettings({ downloadFolder: folder })
    }
  }

  /** Clearing the download directory hands downloads back to the first music library folder. */
  async function resetDownloadFolder(): Promise<void> {
    if (!settings.value.downloadFolder) return
    await updateSettings({ downloadFolder: '' })
  }

  async function chooseBackgroundImage(): Promise<string | null> {
    return await window.api.settings.chooseBackgroundImage()
  }

  async function importBackgroundImage(file: File): Promise<string | null> {
    const data = await file.arrayBuffer()
    return await window.api.settings.importBackgroundImage(file.name, data)
  }

  async function exportSettingsBackup(): Promise<string> {
    return await window.api.settings.exportBackup()
  }

  async function importSettingsBackup(json: string): Promise<AppSettings> {
    const snapshot = await window.api.settings.importBackup(json)
    applySnapshot(snapshot)
    return settings.value
  }

  async function resetCacheFolder(): Promise<void> {
    if (!defaults.value.cachePath) return
    await updateSettings({ cachePath: defaults.value.cachePath })
  }

  async function refreshCacheSize(): Promise<void> {
    cacheSize.value = await window.api.settings.getCacheSize()
  }

  async function clearCache(): Promise<void> {
    clearingCache.value = true
    try {
      cacheSize.value = await window.api.settings.clearCache()
    } finally {
      clearingCache.value = false
    }
  }

  async function refreshBpmAnalysisCacheSize(): Promise<void> {
    bpmAnalysisCacheSize.value = await window.api.bpmAnalysis.getCacheSize()
  }

  async function clearBpmAnalysisCache(): Promise<void> {
    clearingBpmAnalysisCache.value = true
    try {
      bpmAnalysisCacheSize.value = await window.api.bpmAnalysis.clearCache()
    } finally {
      clearingBpmAnalysisCache.value = false
    }
  }

  async function refreshLoudnessAnalysisCacheSize(): Promise<void> {
    loudnessAnalysisCacheSize.value = await window.api.loudnessAnalysis.getCacheSize()
  }

  async function clearLoudnessAnalysisCache(): Promise<void> {
    clearingLoudnessAnalysisCache.value = true
    try {
      loudnessAnalysisCacheSize.value = await window.api.loudnessAnalysis.clearCache()
    } finally {
      clearingLoudnessAnalysisCache.value = false
    }
  }

  async function openCacheFolder(): Promise<void> {
    const targetPath = settings.value.cachePath || paths.value?.activeCachePath
    if (targetPath) {
      await window.api.shell.openPath(targetPath)
    }
  }

  async function relaunch(): Promise<void> {
    await window.api.app.relaunch()
  }

  async function addLibraryFolder(): Promise<void> {
    const folder = await window.api.dialog.openFolder()
    if (!folder) return
    if (settings.value.libraryFolders.includes(folder)) return
    await updateSettings({ libraryFolders: [...settings.value.libraryFolders, folder] })
  }

  async function removeLibraryFolder(folder: string): Promise<void> {
    const next = settings.value.libraryFolders.filter((item) => item !== folder)
    if (next.length === settings.value.libraryFolders.length) return
    await updateSettings({ libraryFolders: next })
  }

  async function openExternalUrl(url: string): Promise<void> {
    await window.api.shell.openExternal(url)
  }

  async function getShortcutStatuses(): Promise<PlayerShortcutStatus[]> {
    return await window.api.settings.getShortcutStatuses()
  }

  return {
    settings,
    defaults,
    paths,
    appVersion,
    platform,
    windowTransparencySupported,
    loaded,
    loading,
    saving,
    lastSettingsError,
    clearingCache,
    cacheSize,
    formattedCacheSize,
    clearingBpmAnalysisCache,
    bpmAnalysisCacheSize,
    formattedBpmAnalysisCacheSize,
    clearingLoudnessAnalysisCache,
    loudnessAnalysisCacheSize,
    formattedLoudnessAnalysisCacheSize,
    restartRequired,
    restartReasons,
    loadSettings,
    hydrateStartupSnapshot,
    updateSettings,
    chooseCacheFolder,
    chooseDownloadFolder,
    resetDownloadFolder,
    chooseBackgroundImage,
    importBackgroundImage,
    exportSettingsBackup,
    importSettingsBackup,
    resetCacheFolder,
    refreshCacheSize,
    clearCache,
    refreshBpmAnalysisCacheSize,
    clearBpmAnalysisCache,
    refreshLoudnessAnalysisCacheSize,
    clearLoudnessAnalysisCache,
    openCacheFolder,
    relaunch,
    addLibraryFolder,
    removeLibraryFolder,
    openExternalUrl,
    getShortcutStatuses
  }
}
