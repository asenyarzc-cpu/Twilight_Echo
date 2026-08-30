import { computed, ref, type Ref } from 'vue'
import type { UiContribution } from '../extensions/registry'

export type SettingsSection =
  | 'general'
  | 'playback'
  | 'dsp'
  | 'cache'
  | 'performance'
  | 'appearance'
  | 'shortcuts'
  | 'about'

export type ThemeStudioDomain =
  | 'presets'
  | 'personalization'
  | 'shell'
  | 'navigation'
  | 'library'
  | 'typography'
  | 'player'
  | 'windows'
  | 'motion'
  | 'advanced'

const songlistOrder = [
  'dashboard',
  'allSongs',
  'artists',
  'albums',
  'genres',
  'playlists',
  'aggregate',
  'folders',
  'recent'
] as const

export function useAppNavigation() {
  const menuOpen = ref(false)
  const showPlayingPage = ref(false)
  const showStreamingPage = ref(false)
  const showRadioPodcastPage = ref(false)
  const showNetworkSourcesPage = ref(false)
  const showLoginPage = ref(false)
  const loginPageMode = ref<'login' | 'profile'>('login')
  const loginInitialProviderId = ref<string | null>(null)
  const showSettingsPage = ref(false)
  const showThemeStudioPage = ref(false)
  const themeStudioInitialDomain = ref<ThemeStudioDomain>('presets')
  const themeStudioReturnTarget = ref<'local' | 'playing' | 'settings'>('settings')
  const showPluginPage = ref(false)
  const showEqualizerPage = ref(false)
  const showDspRackPage = ref(false)
  const activePluginPage = ref<UiContribution | null>(null)
  const settingsInitialSection = ref<SettingsSection>('general')
  const activeCategory = ref('dashboard')
  const activeFilter = ref<string | null>(null)
  const songlistTransitionName = ref<'page-down' | 'page-up'>('page-down')
  const streamingMenuOpen = ref(false)
  const localMenuOpenBeforeStreaming = ref(false)

  const showStreamingSurface = computed(
    () =>
      showStreamingPage.value &&
      !showNetworkSourcesPage.value &&
      !showPlayingPage.value &&
      !showLoginPage.value &&
      !showSettingsPage.value &&
      !showThemeStudioPage.value &&
      !showEqualizerPage.value &&
      !showDspRackPage.value &&
      !showPluginPage.value &&
      !activePluginPage.value &&
      !showRadioPodcastPage.value
  )

  const localViewVisible = computed(
    () =>
      !showPlayingPage.value &&
      !showStreamingPage.value &&
      !showRadioPodcastPage.value &&
      !showNetworkSourcesPage.value &&
      !showLoginPage.value &&
      !showSettingsPage.value &&
      !showThemeStudioPage.value &&
      !showEqualizerPage.value &&
      !showDspRackPage.value &&
      !showPluginPage.value &&
      !activePluginPage.value
  )

  function toggleStreamingMenu(): void {
    streamingMenuOpen.value = !streamingMenuOpen.value
  }

  function collapseMenu(): void {
    if (showStreamingPage.value) {
      streamingMenuOpen.value = false
      return
    }
    menuOpen.value = false
  }

  function onSelectView(category: string, filter: string | null): void {
    const currentIndex = songlistOrder.indexOf(
      activeCategory.value as (typeof songlistOrder)[number]
    )
    const nextIndex = songlistOrder.indexOf(category as (typeof songlistOrder)[number])
    if (currentIndex !== -1 && nextIndex !== -1) {
      songlistTransitionName.value = nextIndex > currentIndex ? 'page-down' : 'page-up'
    }
    activeCategory.value = category
    activeFilter.value = filter
    showPluginPage.value = false
    activePluginPage.value = null
    showRadioPodcastPage.value = false
    showNetworkSourcesPage.value = false
  }

  function closePluginPage(): void {
    activePluginPage.value = null
  }

  function onSelectPluginPage(page: UiContribution): void {
    menuOpen.value = false
    showPlayingPage.value = false
    showStreamingPage.value = false
    showRadioPodcastPage.value = false
    showLoginPage.value = false
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showEqualizerPage.value = false
    showPluginPage.value = false
    activePluginPage.value = page
    showNetworkSourcesPage.value = false
  }

  function openPlayingPage(): void {
    showPlayingPage.value = true
  }

  function closePlayingPage(): void {
    showPlayingPage.value = false
  }

  function enterStreamingMode(): void {
    localMenuOpenBeforeStreaming.value = menuOpen.value
    menuOpen.value = false
    showPlayingPage.value = false
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showEqualizerPage.value = false
    showPluginPage.value = false
    activePluginPage.value = null
    showRadioPodcastPage.value = false
    showNetworkSourcesPage.value = false
    showStreamingPage.value = true
  }

  function returnToLocalMode(): void {
    showStreamingPage.value = false
    showRadioPodcastPage.value = false
    streamingMenuOpen.value = false
    menuOpen.value = localMenuOpenBeforeStreaming.value
  }

  function enterRadioPodcastMode(): void {
    menuOpen.value = false
    showPlayingPage.value = false
    showStreamingPage.value = false
    showNetworkSourcesPage.value = false
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showEqualizerPage.value = false
    showDspRackPage.value = false
    showPluginPage.value = false
    activePluginPage.value = null
    showLoginPage.value = false
    showRadioPodcastPage.value = true
  }

  function closeRadioPodcastPage(): void {
    showRadioPodcastPage.value = false
  }

  function enterNetworkSourcesMode(): void {
    menuOpen.value = false
    showPlayingPage.value = false
    showStreamingPage.value = false
    showRadioPodcastPage.value = false
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showEqualizerPage.value = false
    showDspRackPage.value = false
    showPluginPage.value = false
    activePluginPage.value = null
    showLoginPage.value = false
    showNetworkSourcesPage.value = true
  }

  function closeNetworkSourcesPage(): void {
    showNetworkSourcesPage.value = false
  }

  function openLoginPage(
    initialProviderId: string | null = null,
    options?: { profile?: boolean }
  ): void {
    menuOpen.value = false
    showPlayingPage.value = false
    showStreamingPage.value = false
    showRadioPodcastPage.value = false
    showNetworkSourcesPage.value = false
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showEqualizerPage.value = false
    activePluginPage.value = null
    loginPageMode.value = options?.profile ? 'profile' : 'login'
    loginInitialProviderId.value = initialProviderId
    showLoginPage.value = true
  }

  function closeLoginPage(): void {
    showLoginPage.value = false
    loginPageMode.value = 'login'
    loginInitialProviderId.value = null
    showStreamingPage.value = true
  }

  function openSettingsPage(section: SettingsSection = 'general'): void {
    settingsInitialSection.value = section
    showPlayingPage.value = false
    showThemeStudioPage.value = false
    showPluginPage.value = false
    showEqualizerPage.value = false
    showDspRackPage.value = false
    activePluginPage.value = null
    showNetworkSourcesPage.value = false
    showSettingsPage.value = true
  }

  function closeSettingsPage(): void {
    showSettingsPage.value = false
  }

  function openThemeStudioPage(initialDomain: ThemeStudioDomain = 'presets'): void {
    themeStudioInitialDomain.value = initialDomain
    themeStudioReturnTarget.value =
      initialDomain === 'presets' || showSettingsPage.value
        ? 'settings'
        : showPlayingPage.value
          ? 'playing'
          : 'local'
    menuOpen.value = false
    showPlayingPage.value = false
    showSettingsPage.value = false
    showPluginPage.value = false
    showEqualizerPage.value = false
    showDspRackPage.value = false
    activePluginPage.value = null
    showNetworkSourcesPage.value = false
    showThemeStudioPage.value = true
  }

  function closeThemeStudioPage(): void {
    showThemeStudioPage.value = false
    if (themeStudioReturnTarget.value === 'playing') {
      showPlayingPage.value = true
    } else if (themeStudioReturnTarget.value === 'settings') {
      openSettingsPage('appearance')
    }
  }

  function openPlaybackSettings(): void {
    openSettingsPage('playback')
  }

  function openDspSettings(): void {
    openSettingsPage('dsp')
  }

  function openPluginPage(): void {
    menuOpen.value = false
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showEqualizerPage.value = false
    showDspRackPage.value = false
    activePluginPage.value = null
    showNetworkSourcesPage.value = false
    showPluginPage.value = true
  }

  function hidePluginPage(): void {
    showPluginPage.value = false
  }

  function openEqualizerPage(): void {
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showPluginPage.value = false
    showDspRackPage.value = false
    activePluginPage.value = null
    showNetworkSourcesPage.value = false
    showEqualizerPage.value = true
  }

  function closeEqualizerPage(): void {
    showEqualizerPage.value = false
  }

  function openDspRackPage(): void {
    showSettingsPage.value = false
    showThemeStudioPage.value = false
    showPluginPage.value = false
    showEqualizerPage.value = false
    activePluginPage.value = null
    showNetworkSourcesPage.value = false
    showDspRackPage.value = true
  }

  function closeDspRackPage(): void {
    showDspRackPage.value = false
  }

  function closeMissingPluginPage(pages: UiContribution[]): void {
    const active = activePluginPage.value
    if (!active) return
    const stillRegistered = pages.some(
      (page) => page.pluginId === active.pluginId && page.id === active.id
    )
    if (!stillRegistered) {
      activePluginPage.value = null
    }
  }

  function createToggleMenuHandler(): () => void {
    return () => {
      // I4: 菜单键全局语义统一为“打开/收起侧边菜单”。
      // 全屏页（设置/插件）先退出全屏页再打开菜单，保证按键始终有可见反馈。
      if (showLoginPage.value) return
      if (showSettingsPage.value) {
        closeSettingsPage()
        menuOpen.value = true
        return
      }
      if (showPluginPage.value) {
        hidePluginPage()
        menuOpen.value = true
        return
      }
      if (showStreamingPage.value) {
        toggleStreamingMenu()
        return
      }
      menuOpen.value = !menuOpen.value
    }
  }

  function createToggleSettingsHandler(): () => void {
    return () => {
      if (showSettingsPage.value) {
        closeSettingsPage()
        return
      }
      openSettingsPage()
    }
  }

  function createTogglePluginHandler(): () => void {
    return () => {
      if (showPluginPage.value) {
        hidePluginPage()
        return
      }
      openPluginPage()
    }
  }

  return {
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
    activePluginPage: activePluginPage as Ref<UiContribution | null>,
    settingsInitialSection,
    activeCategory,
    activeFilter,
    songlistTransitionName,
    streamingMenuOpen,
    localMenuOpenBeforeStreaming,
    showStreamingSurface,
    localViewVisible,
    toggleStreamingMenu,
    collapseMenu,
    onSelectView,
    closePluginPage,
    onSelectPluginPage,
    openPlayingPage,
    closePlayingPage,
    enterStreamingMode,
    enterRadioPodcastMode,
    closeRadioPodcastPage,
    enterNetworkSourcesMode,
    closeNetworkSourcesPage,
    returnToLocalMode,
    openLoginPage,
    closeLoginPage,
    openSettingsPage,
    closeSettingsPage,
    openThemeStudioPage,
    closeThemeStudioPage,
    openPlaybackSettings,
    openDspSettings,
    openPluginPage,
    hidePluginPage,
    openEqualizerPage,
    closeEqualizerPage,
    openDspRackPage,
    closeDspRackPage,
    closeMissingPluginPage,
    createToggleMenuHandler,
    createToggleSettingsHandler,
    createTogglePluginHandler
  }
}
