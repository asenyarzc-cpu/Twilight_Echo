<script setup lang="ts">
import {
  ref,
  computed,
  onMounted,
  onBeforeUnmount,
  nextTick,
  watch,
  defineAsyncComponent
} from 'vue'
import TitleBar from './components/TitleBar.vue'
import SideMenu from './components/SideMenu.vue'
const PlayerBar = defineAsyncComponent(() => import('./components/PlayerBar.vue'))
const LocalDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/LocalHome.vue')
)
const SongList = defineAsyncComponent(() => import('./components/SongList.vue'))
const AggregatePlaylistPage = defineAsyncComponent(
  () => import('./components/aggregate-playlist/AggregatePlaylistPage.vue')
)
const PlayingMusic = defineAsyncComponent(() => import('./components/PlayingMusic.vue'))
const StreamingPage = defineAsyncComponent(() => import('./components/StreamingPage.vue'))
const RadioPodcastPage = defineAsyncComponent(() => import('./components/RadioPodcastPage.vue'))
const NetworkSourcesPage = defineAsyncComponent(() => import('./components/NetworkSourcesPage.vue'))
const LoginPage = defineAsyncComponent(() => import('./components/LoginPage.vue'))
const SettingsPage = defineAsyncComponent(() => import('./components/SettingsPage.vue'))
const ThemeStudioPage = defineAsyncComponent(() => import('./components/ThemeStudioPage.vue'))
const PluginPage = defineAsyncComponent(() => import('./components/PluginPage.vue'))
const EqualizerPage = defineAsyncComponent(() => import('./components/EqualizerPage.vue'))
const DspRackPage = defineAsyncComponent(() => import('./components/DspRackPage.vue'))
const PluginExtensionPage = defineAsyncComponent(
  () => import('./components/PluginExtensionPage.vue')
)
const OnboardingWizard = defineAsyncComponent(
  () => import('./components/onboarding/OnboardingWizard.vue')
)
import type { OnboardingFinishResult } from './components/onboarding/OnboardingWizard.vue'
import { useMusicStore } from './stores/useMusicStore'
import { useNcmStore } from './stores/useNcmStore'
import { setupListeningStatsTracking } from './stores/useListeningStatsStore'
import { usePlayerStore } from './stores/usePlayerStore'
import { useSettingsStore } from './stores/useSettingsStore'
import { useThemeStore, applyActiveTheme, bootstrapThemeRuntime } from './stores/useThemeStore'
import { getStartupSnapshot } from './app/startupSnapshot'
import { useExtensionRegistry } from './extensions/registry'
import { syncPluginProviders, useMediaProviders } from './providers'
import { useAppNavigation } from './app/useAppNavigation'
import { useBackStack } from './app/useBackStack'
import { hasDismissLayer } from '@renderer/app/useDismissLayer'
import { createPlaybackSessionPersistence } from './app/usePlaybackSessionPersistence'
import { useSideMenuClearance } from './app/useSideMenuClearance'
import { useMiniPlayerSync } from './app/useMiniPlayerSync'
import { useDesktopLyricsPublisher } from './app/useDesktopLyricsPublisher.ts'
import { useFavoriteButton } from './components/player-bar/useFavoriteButton'
import { useMotionPreference } from './app/useMotionPreference'
import { useLanguagePreference } from './app/useLocale'
import { useLiquidGlassEnvironment } from './composables/useLiquidGlassEnvironment'
import { useAppNoticeStore } from './stores/useAppNoticeStore'
import { getTrackSource } from './utils/logicalTrackModel'
import { scheduleIdleTask, type IdleTaskHandle } from './app/scheduleIdleTask'
import {
  getPrimaryStreamingArtistId,
  getPrimaryStreamingArtistName,
  type StreamingArtistNavigationRequest
} from './utils/streamingArtistResolution'
import AppNoticeHost from './components/AppNoticeHost.vue'
import LiquidGlassDefs from './components/LiquidGlassDefs.vue'
import { resolvePlayerBarPresentation } from '../../shared/playerBar.ts'
import type { AppBackgroundPage } from './types/settings'

type TitleSurface = 'default' | 'settings' | 'streaming'
type StreamingInitialTab = 'home' | 'library' | 'recent'
let idleLoginCheck: IdleTaskHandle | null = null

const navigation = useAppNavigation()
const {
  menuOpen,
  showPlayingPage,
  showStreamingPage,
  showRadioPodcastPage,
  showNetworkSourcesPage,
  showLoginPage,
  loginPageMode,
  loginInitialProviderId,
  showSettingsPage,
  showThemeStudioPage,
  themeStudioInitialDomain,
  showPluginPage,
  showEqualizerPage,
  showDspRackPage,
  activePluginPage,
  settingsInitialSection,
  activeCategory,
  activeFilter,
  songlistTransitionName,
  streamingMenuOpen,
  showStreamingSurface,
  localViewVisible,
  toggleStreamingMenu,
  collapseMenu,
  onSelectView,
  closePluginPage,
  onSelectPluginPage,
  openPlayingPage: showPlaying,
  closePlayingPage,
  enterStreamingMode,
  enterRadioPodcastMode,
  closeRadioPodcastPage,
  enterNetworkSourcesMode,
  closeNetworkSourcesPage,
  returnToLocalMode,
  openLoginPage,
  closeLoginPage,
  closeSettingsPage,
  openThemeStudioPage,
  closeThemeStudioPage,
  openPlaybackSettings,
  openDspSettings,
  hidePluginPage,
  openPluginPage,
  openEqualizerPage,
  closeEqualizerPage,
  openDspRackPage,
  closeDspRackPage,
  closeMissingPluginPage,
  openSettingsPage
} = navigation
const { pushNotice } = useAppNoticeStore()

// One global back affordance on the title bar. Every full-screen page
// registers a single base layer here; deeper in-page states (streaming
// details, login QR flow, EQ advanced settings, …) push themselves on top of
// it, so the button always resolves the innermost layer first.
const backStack = useBackStack()
backStack.useBackHandler(showPlayingPage, closePlayingPage)
backStack.useBackHandler(showSettingsPage, closeSettingsPage)
// ThemeStudio 不在此注册：未应用的修改需要确认，由 ThemeStudioPage 自己挂载
// 期间注册 closeStudio。
backStack.useBackHandler(showPluginPage, hidePluginPage)
backStack.useBackHandler(showEqualizerPage, closeEqualizerPage)
backStack.useBackHandler(showDspRackPage, closeDspRackPage)
backStack.useBackHandler(showRadioPodcastPage, closeRadioPodcastPage)
backStack.useBackHandler(showNetworkSourcesPage, closeNetworkSourcesPage)
backStack.useBackHandler(showLoginPage, closeLoginPage)
backStack.useBackHandler(
  computed(() => activePluginPage.value !== null),
  closePluginPage
)
const toggleMenu = navigation.createToggleMenuHandler()
const toggleSettingsPage = navigation.createToggleSettingsHandler()
const togglePluginPage = navigation.createTogglePluginHandler()

const coverOrigin = ref({ x: 48, y: window.innerHeight - 36, w: 48, h: 48 })
const streamingInitialTab = ref<StreamingInitialTab | null>(null)
const streamingArtistRequest = ref<StreamingArtistNavigationRequest | null>(null)
let streamingArtistRequestKey = 0
// Keep StreamingPage mounted for the rest of the session so leaving/re-entering
// restores the last tab and detail. App restart remounts and returns to home.
const streamingPageMounted = ref(false)
watch(
  showStreamingPage,
  (visible) => {
    if (visible) streamingPageMounted.value = true
  },
  { immediate: true }
)
const showOnboarding = ref(false)

function applyExternalNavigation(target: 'local' | 'streaming' | 'settings'): void {
  showOnboarding.value = false
  if (target === 'settings') {
    openSettingsPage('general')
    return
  }
  streamingInitialTab.value = target === 'streaming' ? 'home' : null
  if (target === 'streaming') {
    enterStreamingMode()
  } else {
    returnToLocalMode()
    onSelectView('dashboard', null)
  }
}
const titleMenuOpen = computed(() =>
  showPluginPage.value ? false : showStreamingPage.value ? streamingMenuOpen.value : menuOpen.value
)

function handleTitleBack(): void {
  backStack.goBack()
}

function onGlobalBackKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat || event.isComposing) return
  if (event.key === 'Escape') {
    if (hasDismissLayer()) return
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]'
      )
    )
      return
    if (backStack.goBack()) event.preventDefault()
    return
  }
  if (
    event.key === 'ArrowLeft' &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    backStack.goBack()
  ) {
    event.preventDefault()
  }
}

function openPlayingPage(rect: { x: number; y: number; w: number; h: number }): void {
  coverOrigin.value = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: rect.w, h: rect.h }
  showPlaying()
}

function handleCoverClick(rect: { x: number; y: number; w: number; h: number }): void {
  if (showPlayingPage.value) {
    closePlayingPage()
  } else {
    openPlayingPage(rect)
  }
}

function handleExitPlayingPage(): void {
  closePlayingPage()
}

function enterStreamingLogin(): void {
  // First entry starts on home; later re-entries keep the mounted page state.
  if (!streamingPageMounted.value) {
    streamingInitialTab.value = 'home'
  }
  enterStreamingMode()
  if (!ncmLoggedIn.value) {
    openLoginPage('ncm')
  }
}

function handleStreamingLogin(providerId?: string | null): void {
  openLoginPage(providerId ?? null)
}

function handleTitleLogin(providerId?: string | null): void {
  openLoginPage(providerId ?? 'ncm')
}

function handleReopenOnboarding(): void {
  closeSettingsPage()
  showOnboarding.value = true
}

async function handleOnboardingFinish(result: OnboardingFinishResult): Promise<void> {
  try {
    await updateSettings(result.patch)
  } catch (error) {
    pushNotice({
      kind: 'warning',
      message: `保存引导设置失败：${error instanceof Error ? error.message : String(error)}`
    })
  }
  showOnboarding.value = false
  if (result.action === 'streaming' || result.action === 'streaming-login') {
    enterStreamingMode()
  } else {
    // No-op on first run; returns home when the wizard was reopened from
    // settings while the streaming page was active.
    returnToLocalMode()
  }
  if (result.openMiniPlayer) {
    try {
      await window.api.miniPlayer.open()
    } catch (error) {
      pushNotice({
        kind: 'warning',
        message: `打开迷你播放器失败：${error instanceof Error ? error.message : String(error)}`
      })
    }
  }
  if (result.action === 'streaming-login') {
    openLoginPage('ncm')
  } else if (result.openPluginMarket) {
    // Login takes precedence — the market stays one click away from the
    // title bar, while a missed login blocks the whole streaming flow.
    openPluginPage()
  }
}

function handleLoginSuccess(): void {
  if (loginInitialProviderId.value === 'ncm') {
    streamingInitialTab.value = 'home'
  }
  closeLoginPage()
}

function handleLoginConfigure(): void {
  closeLoginPage()
  openSettingsPage()
}

const musicStore = useMusicStore()
const {
  loadLibrary,
  loadPlaylists,
  flushSaveLibrary,
  flushPlaylists,
  handleLibraryChange,
  startStartupLibraryScan,
  applyLibraryScanProgress,
  applyLibraryScanStatus
} = musicStore
const { checkLogin, isLoggedIn: ncmLoggedIn } = useNcmStore()
const {
  currentTrack,
  currentTime,
  duration,
  isPlaying,
  isLoading,
  volume,
  playMode,
  dominantColor,
  coverThemeColor,
  themeCoverUrl,
  themeCoverIdentity,
  queue,
  queueIndex,
  togglePlay,
  next,
  prev,
  seek,
  setVolume,
  flushSoftwareVolumePersist,
  cyclePlayMode,
  setPlayMode,
  restorePlaybackSession,
  createPlaybackSession,
  rehydrateCurrentTrackFromLibrary,
  visualizerActive
} = usePlayerStore()
useDesktopLyricsPublisher()
const { setAdaptiveMedia } = useThemeStore()
const mediaProviders = useMediaProviders()

function handlePlayerBarArtistClick(): void {
  const track = currentTrack.value
  const trackArtist = track?.artist.trim() ?? ''
  if (!track || !trackArtist) return

  const source = getTrackSource(track)
  if (source === 'local') {
    streamingArtistRequest.value = null
    returnToLocalMode()
    onSelectView('artists', `artist:${trackArtist}`)
    return
  }

  const artistName = getPrimaryStreamingArtistName(trackArtist)
  if (!artistName) return
  // 同名歌手只能靠 provider 歌手 id 区分；曲目没带 id 时才让流媒体页按名字搜。
  const artistId = getPrimaryStreamingArtistId(trackArtist, track.artists)
  streamingInitialTab.value = 'home'
  streamingArtistRequest.value = {
    key: ++streamingArtistRequestKey,
    providerId: source,
    artistName,
    ...(artistId !== undefined ? { artistId } : {})
  }
  enterStreamingMode()
}

const { favoriteButtonVisible, favoriteButtonLiked, favoriteButtonLoading, toggleFavorite } =
  useFavoriteButton({
    currentTrack,
    playlists: musicStore.localPlaylists,
    mediaProviders,
    addToPlaylist: musicStore.addToPlaylist,
    removeFromPlaylist: musicStore.removeFromPlaylist,
    createPlaylist: musicStore.createPlaylist,
    isFavoriteTrack: musicStore.isFavoriteTrack,
    addFavoriteTrack: musicStore.addFavoriteTrack,
    removeFavoriteTrack: musicStore.removeFavoriteTrack
  })

watch(
  [themeCoverIdentity, coverThemeColor, themeCoverUrl],
  ([identity, accentColor, coverUrl]) => {
    void setAdaptiveMedia({ identity, accentColor, coverUrl })
  },
  { immediate: true }
)

useMiniPlayerSync({
  currentTrack,
  isPlaying,
  isLoading,
  currentTime,
  duration,
  volume,
  playMode,
  favoriteAvailable: favoriteButtonVisible,
  favoriteLiked: favoriteButtonLiked,
  favoriteLoading: favoriteButtonLoading,
  dominantColor,
  queue,
  queueIndex,
  togglePlay,
  next,
  prev,
  seek,
  setVolume,
  cyclePlayMode,
  setPlayMode,
  toggleFavorite
})
const { loadSettings, hydrateStartupSnapshot, settings, updateSettings } = useSettingsStore()
useMotionPreference(computed(() => settings.value.motionPreference))
useLanguagePreference(computed(() => settings.value.language))
const { uiContributions, syncExtensions } = useExtensionRegistry()
const STREAMING_ACCOUNT_PAGE_KEYS = new Set(['com.twilightecho.provider.ytmusic:ytmusic-account'])
const sidebarPages = computed(() =>
  uiContributions.value.filter(
    (contribution) =>
      contribution.kind === 'sidebarPage' &&
      !STREAMING_ACCOUNT_PAGE_KEYS.has(`${contribution.pluginId}:${contribution.id}`)
  )
)
const localSidebarItems = computed(() =>
  uiContributions.value.filter((contribution) => contribution.kind === 'localSidebarItem')
)
const hasPlayerBar = computed(
  () =>
    !showOnboarding.value &&
    !showLoginPage.value &&
    !showSettingsPage.value &&
    !showThemeStudioPage.value &&
    !showEqualizerPage.value &&
    !showDspRackPage.value &&
    !showPluginPage.value &&
    !activePluginPage.value &&
    !visualizerActive.value &&
    !!currentTrack.value
)
/* Shape and visibility resolution live in shared/playerBar.ts so main and renderer
   agree and the truth table stays unit-testable; App.vue only forwards the result.
   A fully hidden bar stays mounted — playback controls, the HiFi panel and the
   geometry flag both consumers read all live on it — so CSS does the hiding. */
const playerBarPresentation = computed(() =>
  resolvePlayerBarPresentation(settings.value.playerBar, {
    onPlayingPage: showPlayingPage.value
  })
)
const showLocalSidebar = computed(
  () =>
    !showPlayingPage.value &&
    !showStreamingPage.value &&
    !showLoginPage.value &&
    !showSettingsPage.value &&
    !showThemeStudioPage.value &&
    !showEqualizerPage.value &&
    !showDspRackPage.value &&
    !showPluginPage.value
)

const sideMenuActiveKey = computed(() =>
  activePluginPage.value
    ? `plugin:${activePluginPage.value.pluginId}:${activePluginPage.value.id}`
    : activeCategory.value
)
const mainContentMinHeight = computed(() => '100vh')

const sidebarMenuOpen = computed(() => {
  // PlayingMusic hides the local sidebar, so its preserved open state must not
  // shift the full-width compact bar and leave a blank gutter on the left.
  if (showPlayingPage.value) return false
  return showStreamingPage.value ? streamingMenuOpen.value : menuOpen.value
})

const playbackSessionPersistence = createPlaybackSessionPersistence({
  settings,
  currentTrack,
  currentTime,
  isPlaying,
  restorePlaybackSession,
  createPlaybackSession,
  syncPluginProviders,
  dataApi: window.api.data,
  onAutosaveError: (error) => {
    pushNotice({
      kind: 'warning',
      message: `自动保存播放会话失败：${error instanceof Error ? error.message : String(error)}`
    })
  }
})
const {
  sideMenuBottomOffset,
  sideMenuInlineEnd,
  startSideMenuMonitor,
  stopSideMenuMonitor,
  resetSideMenuClearance,
  dispose: disposeSideMenuClearance
} = useSideMenuClearance({
  showLocalSidebar,
  hasPlayerBar,
  menuOpen
})

let removePlaybackSessionSaveListener: (() => void) | null = null
let removeAppNavigationListener: (() => void) | null = null
let removeLibraryChangedListener: (() => void) | null = null
let removeCoversMissingListener: (() => void) | null = null
let removeLibraryScanProgressListener: (() => void) | null = null
let removeLibraryScanStatusListener: (() => void) | null = null
let quitFlushHandler: (() => void) | null = null
let pageHideFlushHandler: (() => void) | null = null
const startupDataErrorScopes = new Set<string>()

function reportStartupDataError(scope: string, error: unknown): void {
  console.error(`[persistence] Failed to load ${scope}:`, error)
  startupDataErrorScopes.add(scope)
  const detail = error instanceof Error ? error.message : String(error)
  const scopes = Array.from(startupDataErrorScopes).join('、')
  pushNotice({
    kind: 'error',
    sticky: true,
    message: `启动时无法加载 ${scopes}${detail ? `：${detail}` : ''}。部分功能可能不可用。`,
    action: {
      label: '打开设置',
      run: () => openSettingsPage('general')
    }
  })
}

async function flushPlaylistsForExit(): Promise<void> {
  try {
    const persisted = await flushPlaylists()
    if (!persisted) {
      throw new Error('Playlist persistence did not finish before exit')
    }
  } catch (error) {
    console.error('[persistence] Failed to flush playlists before exit:', error)
    throw error
  }
}

function flushPendingPersistenceForExit(): void {
  flushSaveLibrary()
  // Browser lifecycle events cannot wait for a Promise. The app-close IPC
  // callback below awaits this same flush before the main process closes.
  void flushPlaylistsForExit().catch(() => {
    // The failure was logged by flushPlaylistsForExit. pagehide is only a
    // best-effort path; it cannot certify a successful application close.
  })
}

onMounted(async () => {
  setupListeningStatsTracking({ currentTrack, isPlaying, currentTime, duration })
  const startupSnapshot = await getStartupSnapshot()
  await bootstrapThemeRuntime(startupSnapshot ?? undefined)
  const loadedSettings = startupSnapshot
    ? hydrateStartupSnapshot(startupSnapshot)
    : await loadSettings()
  removeAppNavigationListener = window.api.app.onNavigate((target) => {
    applyExternalNavigation(target)
    void window.api.app.consumePendingNavigation()
  })
  const pendingNavigation =
    startupSnapshot?.pendingNavigation ?? (await window.api.app.consumePendingNavigation())
  if (pendingNavigation) applyExternalNavigation(pendingNavigation)

  // First-run welcome wizard. The empty-library guard keeps existing users
  // who upgraded from a build without the flag from ever seeing it.
  const needsOnboarding =
    !pendingNavigation &&
    !loadedSettings.onboardingCompleted &&
    loadedSettings.libraryFolders.length === 0
  if (needsOnboarding) {
    showOnboarding.value = true
  } else if (!pendingNavigation) {
    if (loadedSettings.startupHomePage === 'streaming') {
      // Enter streaming mode immediately if configured — must not block on
      // library/login/extensions which can take 30s+ (provider timeouts).
      enterStreamingMode()
    }
  }

  // Restore the session before loading the potentially large music library.
  // The main-process data handlers use synchronous file reads, so issuing the
  // library request first can delay the home page's current-track state.
  const playbackSessionSetupPromise = playbackSessionPersistence
    .restoreSavedPlaybackSession(loadedSettings.playbackResumeMode)
    .catch((error) => {
      reportStartupDataError('playback session', error)
    })
    .finally(() => {
      removePlaybackSessionSaveListener = window.api.app.onSavePlaybackSession(async () => {
        // This callback is awaited by the main-process close coordinator. It
        // closes the 250ms playlist debounce window before renderer teardown.
        await flushPlaylistsForExit()
        await flushSoftwareVolumePersist()
        await playbackSessionPersistence.savePlaybackSessionForQuit()
      })
      playbackSessionPersistence.startAutosaveWatchers()
    })
  // Run independent startup operations in parallel so none blocks the others.
  const libraryPromise = loadLibrary().catch((error) =>
    reportStartupDataError('music library', error)
  )
  const playlistsPromise = loadPlaylists().catch((error) =>
    reportStartupDataError('playlists', error)
  )
  const extensionsPromise = syncExtensions()
  if (loadedSettings.autoCheckLogin) {
    idleLoginCheck = scheduleIdleTask(() => {
      idleLoginCheck = null
      void checkLogin()
    })
  }

  // The session restore starts alongside the library load so the home surface
  // can receive the actual current track without waiting for a full scan.
  await libraryPromise
  await playbackSessionSetupPromise
  // Session restore often finishes before library rows are available; re-apply
  // embedded covers/lyrics so playbar/home art and now-playing lyrics hydrate.
  rehydrateCurrentTrackFromLibrary()
  removeLibraryChangedListener = window.api.library.onChanged((change) => {
    handleLibraryChange(change).catch((error) => {
      console.error('[library] Failed to apply an incremental scan update:', error)
    })
  })
  removeLibraryScanProgressListener = window.api.library.onScanProgress(applyLibraryScanProgress)
  removeLibraryScanStatusListener = window.api.library.onScanStatus(applyLibraryScanStatus)
  void window.api.library
    .getScanStatus()
    .then(applyLibraryScanStatus)
    .catch((error) => {
      console.error('[library] Failed to read background scan status:', error)
    })
  void startStartupLibraryScan().catch((error) => {
    console.error('[library] Startup reconciliation failed:', error)
    pushNotice({
      kind: 'warning',
      message: `启动音乐库核对失败：${error instanceof Error ? error.message : String(error)}`,
      action: {
        label: '打开音乐库设置',
        run: () => openSettingsPage('general')
      }
    })
  })

  // Ensure extensions are loaded before wiring listeners that depend on them.
  await extensionsPromise
  await applyActiveTheme(false)
  await playlistsPromise

  removeCoversMissingListener = window.api.library.onCoversMissing((info) => {
    const dirtyCount = Math.max(0, Number(info?.dirtyCount) || 0)
    if (dirtyCount <= 0) return
    console.warn(`[library] ${dirtyCount} tracks are missing cover art`)
    pushNotice({
      kind: 'warning',
      message: `检测到 ${dirtyCount} 首缺少封面，可在设置中完整重扫以补全封面。`,
      action: {
        label: '打开音乐库设置',
        run: () => openSettingsPage('general')
      }
    })
  })
  // Lifecycle events are best-effort; the close IPC callback above provides
  // the awaitable completion barrier for application shutdown.
  quitFlushHandler = flushPendingPersistenceForExit
  pageHideFlushHandler = flushPendingPersistenceForExit
  window.addEventListener('beforeunload', quitFlushHandler)
  window.addEventListener('pagehide', pageHideFlushHandler)
  window.addEventListener('keydown', onGlobalBackKeydown)
})

watch(
  [showLocalSidebar, hasPlayerBar, menuOpen],
  () => {
    if (
      showLocalSidebar.value &&
      hasPlayerBar.value &&
      (menuOpen.value || sideMenuBottomOffset.value > 0)
    ) {
      nextTick(startSideMenuMonitor)
      return
    }

    resetSideMenuClearance()
  },
  { immediate: true, flush: 'post' }
)

watch(
  showSettingsPage,
  (visible) => {
    document.body.classList.toggle(
      'te-settings-surface',
      visible || showPluginPage.value || showThemeStudioPage.value
    )
  },
  { immediate: true }
)

watch(
  showPluginPage,
  (visible) => {
    document.body.classList.toggle(
      'te-settings-surface',
      visible || showSettingsPage.value || showThemeStudioPage.value
    )
  },
  { immediate: true }
)

watch(
  showThemeStudioPage,
  (visible) => {
    document.body.classList.toggle(
      'te-settings-surface',
      visible || showSettingsPage.value || showPluginPage.value
    )
  },
  { immediate: true }
)

watch(
  showStreamingSurface,
  (visible) => {
    document.body.classList.toggle('te-streaming-surface', visible)
    // One continuous wallpaper for the whole local shell: the body paints the
    // local background once, window-wide, and the sidebar plus every page sit
    // transparent on top. Pages that each carried their own cover-scaled copy
    // opened a seam at the sidebar edge — two scales of the same image reading
    // as a split surface. Mutually exclusive with the streaming surface, which
    // owns the body in its mode.
    document.body.classList.toggle('te-local-surface', !visible)
  },
  { immediate: true }
)

watch(sidebarPages, (pages) => closeMissingPluginPage(pages))

onBeforeUnmount(() => {
  idleLoginCheck?.cancel()
  idleLoginCheck = null
  playbackSessionPersistence.stop()
  removePlaybackSessionSaveListener?.()
  removePlaybackSessionSaveListener = null
  removeAppNavigationListener?.()
  removeAppNavigationListener = null
  removeLibraryChangedListener?.()
  removeLibraryChangedListener = null
  removeLibraryScanProgressListener?.()
  removeLibraryScanProgressListener = null
  removeLibraryScanStatusListener?.()
  removeLibraryScanStatusListener = null
  removeCoversMissingListener?.()
  removeCoversMissingListener = null
  if (quitFlushHandler) window.removeEventListener('beforeunload', quitFlushHandler)
  if (pageHideFlushHandler) window.removeEventListener('pagehide', pageHideFlushHandler)
  window.removeEventListener('keydown', onGlobalBackKeydown)
  quitFlushHandler = null
  pageHideFlushHandler = null
  stopSideMenuMonitor()
  disposeSideMenuClearance()
  document.body.classList.remove('te-settings-surface')
  document.body.classList.remove('te-streaming-surface')
  document.body.classList.remove('te-local-surface')
})

const coverTransformOrigin = computed(() => `${coverOrigin.value.x}px ${coverOrigin.value.y}px`)
const titleSurface = computed<TitleSurface>(() => {
  if (showPlayingPage.value) return 'default'
  if (showSettingsPage.value) return 'settings'
  if (showThemeStudioPage.value) return 'settings'
  if (showPluginPage.value) return 'settings'
  if (showStreamingPage.value) return 'streaming'
  if (showNetworkSourcesPage.value) return 'streaming'
  if (activePluginPage.value) return 'settings'
  return 'default'
})
const liquidGlassChromeActive = computed(
  () =>
    settings.value.surfaceMaterial === 'liquidGlass' || settings.value.liquidGlass.navigationEnabled
)
const liquidGlassActive = computed(
  () =>
    liquidGlassChromeActive.value ||
    settings.value.liquidGlass.homeCards.enabled ||
    settings.value.liquidGlass.playbarEnabled ||
    settings.value.liquidGlass.settingsNavigationEnabled ||
    settings.value.liquidGlass.coverage === 'expanded'
)
const liquidGlassBackgroundPage = computed<AppBackgroundPage>(() => {
  if (showPlayingPage.value) return 'player'
  if (titleSurface.value === 'settings') return 'settings'
  if (titleSurface.value === 'streaming') return 'streaming'
  return 'local'
})

useLiquidGlassEnvironment({
  active: liquidGlassActive,
  page: liquidGlassBackgroundPage
})
</script>

<template>
  <div class="app-shell" :style="{ '--te-side-menu-bottom': `${sideMenuBottomOffset}px` }">
    <LiquidGlassDefs
      :active="liquidGlassActive"
      :follow-pointer="settings.liquidGlass.followPointer"
      :home-cards-active="settings.liquidGlass.homeCards.enabled"
      :expanded-active="settings.liquidGlass.coverage === 'expanded'"
    />
    <div class="app-shell-title">
      <TitleBar
        :glass="showPlayingPage"
        :liquid-material="liquidGlassChromeActive"
        :streaming="showStreamingPage && !showPlayingPage"
        :hide-start="showThemeStudioPage || showLoginPage"
        :title-surface="titleSurface"
        :menu-open="titleMenuOpen"
        @toggle-menu="toggleMenu"
        @collapse-menu="collapseMenu"
        @back="handleTitleBack"
        @login="handleTitleLogin"
        @settings="toggleSettingsPage"
        @plugins="togglePluginPage"
      />
    </div>
    <div v-if="showLocalSidebar" class="app-shell-navigation">
      <SideMenu
        :open="menuOpen"
        :liquid-material="liquidGlassChromeActive"
        :active-key="sideMenuActiveKey"
        :plugin-pages="sidebarPages"
        :local-items="localSidebarItems"
        @select-view="onSelectView"
        @select-plugin-page="onSelectPluginPage"
        @enter-streaming="enterStreamingLogin"
        @enter-radio-podcast="enterRadioPodcastMode"
        @enter-network-sources="enterNetworkSourcesMode"
      />
    </div>
    <div class="app-shell-content">
      <div
        class="main-content"
        :class="{
          'menu-open': menuOpen && showLocalSidebar,
          'playing-open': showPlayingPage,
          'plugin-open': showPluginPage,
          'dsp-rack-open': showDspRackPage,
          'radio-podcast-open': showRadioPodcastPage
        }"
        :style="{ minHeight: mainContentMinHeight }"
      >
        <Transition :name="songlistTransitionName" mode="out-in">
          <LocalDashboard
            v-if="localViewVisible && activeCategory === 'dashboard'"
            key="local-dashboard"
            @select-view="onSelectView"
            @open-library-settings="openSettingsPage('general')"
          />
          <AggregatePlaylistPage
            v-else-if="localViewVisible && activeCategory === 'aggregate'"
            key="local-aggregate"
            :has-player="hasPlayerBar"
            surface="local"
          />
          <SongList
            v-else-if="localViewVisible"
            key="local-songlist"
            :category="activeCategory"
            :filter="activeFilter"
            :has-player="hasPlayerBar"
            :transition-name="songlistTransitionName"
            @select-view="onSelectView"
            @customize-appearance="openThemeStudioPage('library')"
          />
        </Transition>
        <Transition name="playing-page">
          <PlayingMusic
            v-if="showPlayingPage"
            :style="{ transformOrigin: coverTransformOrigin }"
            @customize-appearance="openThemeStudioPage('player')"
          />
        </Transition>
        <StreamingPage
          v-if="streamingPageMounted"
          v-show="showStreamingPage"
          :active="showStreamingPage"
          :menu-open="streamingMenuOpen"
          :has-player="hasPlayerBar"
          :initial-tab="streamingInitialTab ?? undefined"
          :artist-navigation-request="streamingArtistRequest"
          @toggle-menu="toggleStreamingMenu"
          @back-to-local="returnToLocalMode"
          @login="handleStreamingLogin"
        />
        <RadioPodcastPage v-if="showRadioPodcastPage" />
        <NetworkSourcesPage v-if="showNetworkSourcesPage" />
        <Transition name="login-page">
          <LoginPage
            v-if="showLoginPage"
            :force-profile="loginPageMode === 'profile'"
            :initial-provider-id="loginInitialProviderId"
            @login-success="handleLoginSuccess"
            @configure="handleLoginConfigure"
          />
        </Transition>
        <Transition name="settings-page">
          <PluginPage v-if="showPluginPage" />
        </Transition>
        <Transition name="settings-page">
          <ThemeStudioPage
            v-if="showThemeStudioPage"
            :initial-domain="themeStudioInitialDomain"
            @back="closeThemeStudioPage"
          />
        </Transition>
        <Transition name="settings-page">
          <DspRackPage v-if="showDspRackPage" />
        </Transition>
        <Transition name="login-page">
          <EqualizerPage v-if="showEqualizerPage" />
        </Transition>
        <Transition name="login-page">
          <PluginExtensionPage v-if="activePluginPage" :page="activePluginPage" />
        </Transition>
      </div>
    </div>
    <!-- Where the open side menu's right edge actually lands, measured rather than
         derived: `--te-menu-width` is only the menu's width, and a preset layout
         may inset the menu from the window edge, which leaves a width-based
         `left` short by that inset. The edge-to-edge shapes start after this so
         they never cover the menu. -->
    <div
      class="app-shell-player"
      :style="{ '--te-side-menu-inline-end': `${sideMenuInlineEnd}px` }"
    >
      <PlayerBar
        v-if="hasPlayerBar"
        :glass="showPlayingPage"
        :visualizer-visible="showPlayingPage"
        :menu-open="sidebarMenuOpen"
        :mode="playerBarPresentation.mode"
        :auto-hide="playerBarPresentation.autoHide"
        :hidden-bar="playerBarPresentation.hidden"
        @exit-playing-page="handleExitPlayingPage"
        @click-cover="handleCoverClick"
        @open-settings="openPlaybackSettings"
        @open-dsp="openDspSettings"
        @open-equalizer="openEqualizerPage"
        @open-artist="handlePlayerBarArtistClick"
      />
    </div>
  </div>
  <div class="settings-overlay-root" :class="{ 'settings-overlay-root--active': showSettingsPage }">
    <Transition name="settings-page">
      <SettingsPage
        v-if="showSettingsPage"
        :initial-section="settingsInitialSection"
        @open-equalizer="openEqualizerPage"
        @open-dsp-rack="openDspRackPage"
        @open-theme-studio="openThemeStudioPage"
        @reopen-onboarding="handleReopenOnboarding"
      />
    </Transition>
  </div>
  <Transition name="onboarding-page">
    <OnboardingWizard v-if="showOnboarding" @finish="handleOnboardingFinish" />
  </Transition>
  <AppNoticeHost />
</template>

<style>
html[data-te-shell-layout='custom'],
html[data-te-shell-layout='custom'] body,
html[data-te-shell-layout='custom'] #app {
  min-height: 100%;
  height: 100%;
}

.app-shell-title {
  position: relative;
  z-index: 2100;
}

/* The overlay owns the whole settings surface, wallpaper included. It spans the
   full window (title strip included) and is the SINGLE painter of the settings
   image: earlier per-element copies (title bar, page, body) each relied on
   `background-attachment: fixed`, which Chromium silently re-anchors to the
   element box on composited layers — splitting the wallpaper into mismatched
   title/body bands. One static painter cannot drift. The title bar sits in a
   higher stacking context (z-index 2100), so its controls still receive every
   click while it stays transparent and lets this painter show through. */
.settings-overlay-root--active {
  position: fixed;
  inset: 0;
  z-index: 2000;
  overflow: hidden;
  isolation: isolate;
  background: #17181a !important;
}

/* The single settings wallpaper painter. The overlay never scrolls, so the
   layers stay viewport-pinned without `background-attachment: fixed`. The
   final image layer is deliberately opaque, so even a transparent PNG or
   transparent theme color can only reveal this settings backplate — never the
   homepage. */
.settings-overlay-root--active::before {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  content: '';
  pointer-events: none;
  background-color: #17181a;
  background-image:
    var(--te-settings-bg-image, none),
    linear-gradient(var(--te-settings-bg), var(--te-settings-bg)), linear-gradient(#17181a, #17181a);
  background-position: center, center, center;
  background-size: cover, cover, cover;
  background-repeat: no-repeat, no-repeat, no-repeat;
}

.settings-overlay-root--active .settings-preview-page {
  z-index: 1;
  pointer-events: auto;
}

html[data-te-shell-layout='custom'] .app-shell {
  display: grid;
  grid-template-columns: var(--te-shell-template-columns);
  grid-template-rows: var(--te-shell-template-rows);
  grid-template-areas: var(--te-shell-template-areas);
  min-height: 100vh;
  height: 100vh;
  overflow: hidden;
}

html[data-te-shell-layout='custom'] .app-shell-title {
  grid-area: titleBar;
  min-width: 0;
  min-height: 0;
}

html[data-te-shell-layout='custom'] .app-shell-navigation {
  grid-area: navigation;
  display: var(--te-shell-navigation-display);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

html[data-te-shell-layout='custom'] .app-shell-content {
  grid-area: content;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

html[data-te-shell-layout='custom'] .app-shell-player {
  grid-area: playerBar;
  display: var(--te-shell-player-bar-display);
  min-width: 0;
  min-height: 0;
}

html[data-te-shell-layout='custom'] .app-shell-title .title-bar {
  position: relative !important;
  inset: auto !important;
  width: 100% !important;
  min-height: 32px;
  height: 100%;
}

html[data-te-shell-layout='custom'] .app-shell-navigation .side-menu {
  position: relative !important;
  inset: auto !important;
  width: 100% !important;
  min-width: 0;
  height: 100% !important;
  border-radius: 0;
}

html[data-te-shell-layout='custom'][data-te-shell-navigation='persistent']
  .app-shell-navigation
  .side-menu {
  transform: none !important;
}

html[data-te-shell-layout='custom'][data-te-shell-navigation='hidden'] .app-shell-navigation {
  display: none;
}

html[data-te-shell-layout='custom'] .app-shell-content .main-content,
html[data-te-shell-layout='custom'] .app-shell-content .main-content.menu-open {
  min-height: 0 !important;
  height: 100%;
  padding-left: 0;
}

html[data-te-shell-layout='custom'] .app-shell-player .player-bar-shell,
html[data-te-shell-layout='custom'] .app-shell-player .player-bar-shell.menu-open {
  position: relative !important;
  inset: auto !important;
  width: 100% !important;
  height: 100%;
  pointer-events: auto;
}

/* A fully hidden bar still occupies its grid area here, so the shell above would
   keep eating clicks across that row. Re-assert none, out-specifying that rule. */
html[data-te-shell-layout='custom']
  .app-shell-player
  .player-bar-shell[data-te-playbar-visibility='hidden'] {
  pointer-events: none;
}

@media (max-width: 760px) {
  html[data-te-shell-layout='custom'] .app-shell {
    grid-template-columns: var(--te-shell-compact-template-columns);
    grid-template-rows: var(--te-shell-compact-template-rows);
    grid-template-areas: var(--te-shell-compact-template-areas);
  }

  html[data-te-shell-layout='custom'] .app-shell-navigation {
    display: var(--te-shell-compact-navigation-display);
  }

  html[data-te-shell-layout='custom'] .app-shell-player {
    display: var(--te-shell-compact-player-bar-display);
  }
}

/* The clearance is animated on `padding-left` itself, deliberately, even though
   that reflows this subtree every frame of the 0.32s slide.

   The alternative — land the padding instantly and give the distance back with a
   composited `translate` — is cheaper but geometrically wrong here. This box is
   `width: 100%` and `border-box`, so its right edge is pinned to the window and
   only its width changes; a translate moves *both* edges, so the right edge
   snapped inward by the clearance on the first frame and slid back over the
   remaining ones. That read as the content flashing on the right, and on the
   collapsing direction it overhung the window and flickered a scrollbar in.

   Pinning the right edge while the left one moves *is* a width change, and a
   width change is a layout. There is no compositor-only spelling of it: only
   `scaleX` alters visual width, and that stretches the glyphs. So the cost is
   the intended trade, not an oversight — keep the layout property here. */
.main-content {
  display: grid;
  box-sizing: border-box;
  margin-left: 0;
  width: 100%;
  min-height: 100vh;
  padding-left: 0;
  transform: translateZ(0);
  transition: padding-left 0.32s var(--te-ease-soft);
  overflow: hidden;
  position: relative;
  z-index: 1;
}

.main-content > * {
  grid-area: 1 / 1;
}

body.te-no-blur .main-content::before,
body.te-no-blur .main-content::after,
body.te-no-blur .page-down-leave-to,
body.te-no-blur .page-down-enter-from,
body.te-no-blur .page-up-leave-to,
body.te-no-blur .page-up-enter-from,
body.te-no-blur .playing-page-enter-from,
body.te-no-blur .playing-page-leave-to,
body.te-no-blur .settings-page-enter-from,
body.te-no-blur .settings-page-leave-to,
body.te-no-blur .login-page-enter-from,
body.te-no-blur .login-page-leave-to {
  filter: none !important;
}

.main-content.menu-open {
  padding-left: var(--te-menu-width);
}

.main-content.playing-open {
  overflow: visible;
}

.main-content.plugin-open {
  min-height: 100vh !important;
  height: 100vh;
}

.main-content.dsp-rack-open {
  height: 100vh;
  min-height: 0 !important;
}

.main-content.dsp-rack-open > .dsp-rack-page {
  height: 100%;
  min-height: 0;
}

.main-content.radio-podcast-open {
  height: 100vh;
  min-height: 0 !important;
}

.main-content.radio-podcast-open > .radio-podcast-page {
  height: 100%;
  min-height: 0;
}

/* Local left-menu view transitions mirror the streaming sidebar. */
.main-content > .page-down-enter-active,
.main-content > .page-down-leave-active,
.main-content > .page-up-enter-active,
.main-content > .page-up-leave-active,
.page-down-enter-active,
.page-down-leave-active,
.page-up-enter-active,
.page-up-leave-active {
  will-change: transform, opacity, filter;
}
.main-content > .page-down-enter-active,
.main-content > .page-up-enter-active,
.page-down-enter-active,
.page-up-enter-active {
  z-index: 1;
  transition:
    opacity 0.34s ease,
    transform 0.48s cubic-bezier(0.16, 1, 0.3, 1),
    filter 0.42s cubic-bezier(0.16, 1, 0.3, 1) !important;
}
.main-content > .page-down-leave-active,
.main-content > .page-up-leave-active,
.page-down-leave-active,
.page-up-leave-active {
  z-index: 0;
  pointer-events: none;
  transition:
    opacity 0.22s ease,
    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    filter 0.28s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

/* page-down: selected page is lower in the sidebar, new view rises from below */
.main-content > .page-down-enter-from,
.page-down-enter-from {
  opacity: 0;
  transform: translate3d(0, 40px, 0) scale(0.99);
  filter: blur(8px);
}
.main-content > .page-down-leave-to,
.page-down-leave-to {
  opacity: 0;
  transform: translate3d(0, -28px, 0) scale(0.992);
  filter: blur(8px);
}

/* page-up: selected page is higher in the sidebar, new view drops from above */
.main-content > .page-up-enter-from,
.page-up-enter-from {
  opacity: 0;
  transform: translate3d(0, -40px, 0) scale(0.99);
  filter: blur(8px);
}
.main-content > .page-up-leave-to,
.page-up-leave-to {
  opacity: 0;
  transform: translate3d(0, 28px, 0) scale(0.992);
  filter: blur(8px);
}

@media (prefers-reduced-motion: reduce) {
  .main-content > .page-down-enter-active,
  .main-content > .page-down-leave-active,
  .main-content > .page-up-enter-active,
  .main-content > .page-up-leave-active,
  .page-down-enter-active,
  .page-down-leave-active,
  .page-up-enter-active,
  .page-up-leave-active {
    transition:
      opacity 0.12s ease,
      transform 0.12s ease !important;
  }

  .main-content > .page-down-enter-from,
  .main-content > .page-down-leave-to,
  .main-content > .page-up-enter-from,
  .main-content > .page-up-leave-to,
  .page-down-enter-from,
  .page-down-leave-to,
  .page-up-enter-from,
  .page-up-leave-to {
    transform: none !important;
    filter: none !important;
  }
}

/* PlayingMusic open/close — expands from / shrinks to cover position */
.playing-page-enter-active {
  transition:
    transform var(--te-motion-page) var(--te-ease-out-expo),
    opacity var(--te-motion-panel) ease,
    border-radius var(--te-motion-page) var(--te-ease-out-expo);
}
.playing-page-leave-active {
  transition:
    transform var(--te-motion-panel) var(--te-ease-enter),
    opacity var(--te-motion-hover) ease,
    border-radius var(--te-motion-panel) var(--te-ease-enter);
}

.playing-page-enter-from {
  transform: scale(0.12) !important;
  border-radius: 28px;
  opacity: 0;
}

.playing-page-leave-to {
  transform: scale(0.12) !important;
  border-radius: 28px;
  opacity: 0;
}

/* Settings and plugin pages: shared overlay transition */
.settings-page-enter-active {
  z-index: 2000;
  transition:
    opacity var(--te-motion-panel) ease,
    transform var(--te-motion-page) var(--te-ease-out-expo);
  will-change: opacity, transform;
}

.settings-page-leave-active {
  z-index: 1999;
  pointer-events: none;
  transition:
    opacity var(--te-motion-hover) ease,
    transform var(--te-motion-panel) var(--te-ease-enter);
  will-change: opacity, transform;
}

.settings-page-enter-from {
  opacity: 0;
  transform: translate3d(28px, 0, 0) scale(0.988);
}

.settings-page-leave-to {
  opacity: 0;
  transform: translate3d(18px, 0, 0) scale(0.992);
}

/* Onboarding wizard: fade in on first paint, dissolve away over the app */
.onboarding-page-enter-active {
  transition: opacity var(--te-motion-panel) ease;
}
.onboarding-page-leave-active {
  pointer-events: none;
  transition:
    opacity var(--te-motion-settle) ease,
    transform var(--te-motion-settle) var(--te-ease-out-expo),
    filter var(--te-motion-settle) var(--te-ease-out-expo);
}
.onboarding-page-enter-from {
  opacity: 0;
}
.onboarding-page-leave-to {
  opacity: 0;
  transform: scale(1.02);
  filter: blur(10px);
}
body.te-no-blur .onboarding-page-leave-to {
  filter: none !important;
}

/* Login page transition */
.login-page-enter-active {
  transition:
    opacity var(--te-motion-panel) ease,
    transform var(--te-motion-page) var(--te-ease-out-quint);
}
.login-page-leave-active {
  transition:
    opacity var(--te-motion-hover) ease,
    transform var(--te-motion-hover) var(--te-ease-enter);
}
.login-page-enter-from {
  opacity: 0;
  transform: translateY(10px);
}
.login-page-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
