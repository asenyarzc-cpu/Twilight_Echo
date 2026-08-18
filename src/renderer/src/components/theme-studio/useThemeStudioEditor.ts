import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  BUILT_IN_THEME_PRESETS,
  BUILT_IN_THEME_FONTS,
  DEFAULT_THEME_TONE_SCHEDULE,
  THEME_ACCENT_PALETTES,
  THEME_BACKGROUND_PALETTES,
  THEME_MODE_DEFINITIONS,
  THEME_TOKEN_DEFINITIONS,
  TWILIGHT_DEFAULT_THEME,
  TWILIGHT_DEFAULT_THEME_ID,
  createThemeAccentTokenOverrides,
  getBuiltInThemePreset,
  normalizeThemeModes,
  normalizeThemeTokenOverrides,
  normalizeThemeTokenValue,
  resolveThemeProfileModes,
  resolveThemeProfileTokens,
  resolveThemeProfileWindowDefaults,
  themeContrastRatio,
  type BuiltInThemePresetId,
  type ThemeAssetBindings,
  type ThemeAssetType,
  type ThemeModes,
  type ThemePlayerLayout,
  type ThemeProfileHistoryEntry,
  type ThemeProfileV2,
  type ThemeSelection,
  type ThemeTokenDefinition,
  type ThemeTone,
  type ThemeVisibilitySlotId,
  type ThemeWindowDefaults
} from '../../../../shared/theme.ts'
import { useExtensionRegistry, type ThemeContribution } from '../../extensions/registry'
import { getPluginThemeKey } from '../../extensions/themeSelection'
import { useThemeStore } from '../../stores/useThemeStore'
import { createThemePreviewScheduler } from '../../utils/themePreviewScheduler'

export type { BuiltInThemePresetId } from '../../../../shared/theme.ts'
export type ThemePreviewSurface = 'dashboard' | 'player' | 'equalizer'
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

type ThemeStudioEditorOptions = {
  initialDomain?: ThemeStudioDomain
  onBack: () => void
}

export function useThemeStudioEditor(options: ThemeStudioEditorOptions) {
  const themeStore = useThemeStore()
  const { themeContributions, syncExtensions } = useExtensionRegistry()
  const selectedKey = ref(`preset:${TWILIGHT_DEFAULT_THEME_ID}`)
  const tone = ref<ThemeTone>('pureWhite')
  const domain = ref<ThemeStudioDomain>(options.initialDomain ?? 'presets')
  const studioSearchQuery = ref('')
  const previewSurface = ref<ThemePreviewSurface>('dashboard')
  const previewViewportRef = ref<HTMLElement | null>(null)
  const previewViewportStyle = ref<Record<string, string>>({})
  const previewCanvasStyle = ref<Record<string, string>>({})
  let previewResizeObserver: ResizeObserver | null = null
  const draft = ref<ThemeProfileV2 | null>(null)
  const savedDraft = ref('')
  const history = ref<ThemeProfileV2[]>([])
  const historyIndex = ref(-1)
  const localError = ref('')
  const notice = ref('')
  let originalTone: ThemeTone = 'pureWhite'
  const previewScheduler = createThemePreviewScheduler((profile: ThemeProfileV2) =>
    themeStore.preview(profile)
  )

  const domains: Array<{ id: ThemeStudioDomain; label: string; icon: string }> = [
    { id: 'presets', label: '预设画廊', icon: 'ph ph-grid-four' },
    { id: 'personalization', label: '个性化与材质', icon: 'ph ph-palette' },
    { id: 'shell', label: '界面与设置', icon: 'ph ph-squares-four' },
    { id: 'navigation', label: '图标与导航', icon: 'ph ph-sidebar' },
    { id: 'library', label: '媒体库', icon: 'ph ph-music-notes-simple' },
    { id: 'typography', label: '字体与歌词', icon: 'ph ph-text-aa' },
    { id: 'player', label: '播放器与封面', icon: 'ph ph-play-circle' },
    { id: 'windows', label: '独立窗口', icon: 'ph ph-app-window' },
    { id: 'motion', label: '动效', icon: 'ph ph-wind' },
    { id: 'advanced', label: '高级令牌', icon: 'ph ph-sliders-horizontal' }
  ]

  const playerLayouts: Array<{ id: ThemePlayerLayout; label: string }> = [
    { id: 'standard', label: '标准' },
    { id: 'full-cover', label: '全封面' },
    { id: 'lyrics-focus', label: '歌词聚焦' },
    { id: 'split', label: '桌面双栏' },
    { id: 'minimal', label: '极简' }
  ]

  const previewSurfaces: Array<{ id: ThemePreviewSurface; label: string; icon: string }> = [
    { id: 'dashboard', label: '主页', icon: 'ph ph-house' },
    { id: 'player', label: '播放页', icon: 'ph ph-disc' },
    { id: 'equalizer', label: '均衡器', icon: 'ph ph-sliders-horizontal' }
  ]

  const visibilityOptions: Array<{ id: ThemeVisibilitySlotId; label: string }> = [
    { id: 'playerAlbumArtist', label: '专辑与艺术家' },
    { id: 'playerArtwork', label: '播放器封面' },
    { id: 'playerTrackMenu', label: '曲目菜单' },
    { id: 'playerMiscIcons', label: '杂项图标' },
    { id: 'playerDuration', label: '时长显示' },
    { id: 'playerWaveform', label: '进度轨道' },
    { id: 'playerTrackInfo', label: '曲目信息' },
    { id: 'equalizerGrid', label: '均衡器辅助线' },
    { id: 'equalizerFrequencyGuides', label: '频率准线' },
    { id: 'equalizerSpectrum', label: '频谱曲线' },
    { id: 'previousButton', label: '上一首按钮' },
    { id: 'nextButton', label: '下一首按钮' },
    { id: 'miniPlayerArtwork', label: '小窗封面' }
  ]

  const minimalHiddenSlots = new Set<ThemeVisibilitySlotId>([
    'playerAlbumArtist',
    'playerTrackMenu',
    'playerMiscIcons',
    'playerDuration',
    'playerWaveform'
  ])

  const personalizationTokenIds = new Set([
    'color.primary.500',
    'surface.app',
    'surface.card',
    'surface.cardBorder',
    'material.glassShadow',
    'shape.globalRadius',
    'material.surfaceOpacity',
    'layout.uiScale',
    'background.gradientStart',
    'background.gradientEnd',
    'background.gradientAngle',
    'background.coverBlur',
    'background.overlayOpacity'
  ])

  const typographyTokenIds = new Set([
    'typography.bodySize',
    'typography.titleWeight',
    'typography.chromeText'
  ])

  const unifiedSurfaceTokenIds = new Set([
    'shape.dialogRadius',
    'shape.searchRadius',
    'shape.toastRadius',
    'shape.trackTitleRadius',
    'material.trackTitleOpacity'
  ])
  const tokenDefinitionById = new Map(
    THEME_TOKEN_DEFINITIONS.map((definition) => [definition.id, definition])
  )

  function domainForToken(definition: ThemeTokenDefinition): ThemeStudioDomain {
    if (personalizationTokenIds.has(definition.id)) return 'personalization'
    if (
      definition.id.startsWith('shell.') ||
      definition.id.startsWith('settings.') ||
      ['surface.settings', 'surface.local', 'surface.streaming'].includes(definition.id) ||
      unifiedSurfaceTokenIds.has(definition.id)
    ) {
      return 'shell'
    }
    if (definition.id.startsWith('navigation.')) return 'navigation'
    if (definition.id.startsWith('library.')) return 'library'
    if (typographyTokenIds.has(definition.id) || definition.id.startsWith('typography.')) {
      return 'typography'
    }
    if (definition.group === 'playback') return 'player'
    if (definition.group === 'motion') return 'motion'
    return 'advanced'
  }

  function domainForModeId(modeId: string): ThemeStudioDomain {
    const root = modeId.split('.')[0]
    if (root === 'appearance') return 'personalization'
    if (root === 'navigation' || root === 'icons') return 'navigation'
    if (root === 'library') return 'library'
    if (root === 'typography') return 'typography'
    if (root === 'player' || root === 'artwork' || root === 'equalizer') return 'player'
    return 'advanced'
  }

  type StudioSearchHit = {
    domain: ThemeStudioDomain
    kind: 'token' | 'mode' | 'section'
    id: string
    title: string
    terms: string
  }

  const STUDIO_SEARCH_INDEX: readonly StudioSearchHit[] = Object.freeze([
    ...domains.map((item) => ({
      domain: item.id,
      kind: 'section' as const,
      id: item.id,
      title: item.label,
      terms: `${item.id} ${item.label}`
    })),
    ...THEME_TOKEN_DEFINITIONS.map((definition) => ({
      domain: domainForToken(definition),
      kind: 'token' as const,
      id: definition.id,
      title: definition.label,
      terms: `${definition.id} ${definition.surface} ${definition.group} ${definition.cssVariable}`
    })),
    ...THEME_MODE_DEFINITIONS.map((definition) => ({
      domain: domainForModeId(definition.id),
      kind: 'mode' as const,
      id: definition.id,
      title: definition.label,
      terms: `${definition.id} ${definition.options.join(' ')}`
    })),
    {
      domain: 'player',
      kind: 'section',
      id: 'visibility',
      title: '可见性',
      terms: 'visibility 可见性 隐藏 显示'
    },
    {
      domain: 'personalization',
      kind: 'section',
      id: 'palettes',
      title: '精选色板',
      terms: 'palette 色板 强调色 背景色'
    }
  ])

  const definitions = computed(() => {
    if (domain.value === 'presets' || domain.value === 'windows') return []
    if (domain.value === 'personalization') {
      return THEME_TOKEN_DEFINITIONS.filter((definition) =>
        personalizationTokenIds.has(definition.id)
      )
    }
    if (domain.value === 'shell') {
      return THEME_TOKEN_DEFINITIONS.filter(
        (definition) =>
          definition.id.startsWith('shell.') ||
          definition.id.startsWith('settings.') ||
          ['surface.settings', 'surface.local', 'surface.streaming'].includes(definition.id) ||
          unifiedSurfaceTokenIds.has(definition.id)
      )
    }
    if (domain.value === 'navigation') {
      return THEME_TOKEN_DEFINITIONS.filter((definition) => definition.id.startsWith('navigation.'))
    }
    if (domain.value === 'library') {
      return THEME_TOKEN_DEFINITIONS.filter((definition) => definition.id.startsWith('library.'))
    }
    if (domain.value === 'typography') {
      return THEME_TOKEN_DEFINITIONS.filter((definition) => typographyTokenIds.has(definition.id))
    }
    if (domain.value === 'player') {
      return THEME_TOKEN_DEFINITIONS.filter((definition) => definition.group === 'playback')
    }
    if (domain.value === 'motion') {
      return THEME_TOKEN_DEFINITIONS.filter((definition) => definition.group === 'motion')
    }
    return [...THEME_TOKEN_DEFINITIONS]
  })

  const visibleDefinitions = computed(() => {
    const query = studioSearchQuery.value.trim().toLowerCase()
    if (!query) return definitions.value
    return definitions.value.filter((definition) =>
      `${definition.label} ${definition.id} ${definition.surface} ${definition.group}`
        .toLowerCase()
        .includes(query)
    )
  })

  const filteredStudioHits = computed(() => {
    const query = studioSearchQuery.value.trim().toLowerCase()
    if (!query) return [] as StudioSearchHit[]
    return STUDIO_SEARCH_INDEX.filter((hit) =>
      `${hit.title} ${hit.terms}`.toLowerCase().includes(query)
    ).slice(0, 40)
  })

  function jumpToSearchHit(hit: StudioSearchHit): void {
    domain.value = hit.domain
    if (hit.kind === 'section' && hit.id !== 'visibility' && hit.id !== 'palettes') {
      studioSearchQuery.value = ''
    }
  }

  const activeDomain = computed(
    () => domains.find((item) => item.id === domain.value) ?? domains[0]
  )
  const previewNavigationOpen = computed(
    () => previewSurface.value === 'dashboard' && domain.value === 'navigation'
  )
  const profiles = computed(() => themeStore.profiles.value)
  const activeKey = computed(() => selectionKey(themeStore.activeTheme.value))
  const selectedBuiltInPreset = computed(() => {
    if (!selectedKey.value.startsWith('preset:')) return null
    return getBuiltInThemePreset(selectedKey.value.slice('preset:'.length))
  })
  const persistedHistory = computed(() =>
    draft.value ? (themeStore.snapshot.value?.data.profileHistory[draft.value.id] ?? []) : []
  )
  const isUnsavedDraft = computed(
    () => draft.value != null && !profiles.value.some((profile) => profile.id === draft.value?.id)
  )
  const isDirty = computed(() =>
    draft.value ? JSON.stringify(draft.value) !== savedDraft.value : false
  )
  const canUndo = computed(() => historyIndex.value > 0)
  const canRedo = computed(
    () => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1
  )
  const selectedPluginTheme = computed(() =>
    themeContributions.value.find(
      (theme) => `plugin:${getPluginThemeKey(theme)}` === selectedKey.value
    )
  )
  const imageAssets = computed(
    () => draft.value?.assets?.filter((asset) => asset.type === 'image') ?? []
  )
  const fontAssets = computed(
    () => draft.value?.assets?.filter((asset) => asset.type === 'font') ?? []
  )
  const activeModes = computed(() =>
    resolveThemeProfileModes(draft.value ?? selectedBuiltInPreset.value)
  )
  const resolvedWindowDefaults = computed<Required<ThemeWindowDefaults>>(() => {
    const resolved = resolveThemeProfileWindowDefaults(draft.value ?? selectedBuiltInPreset.value)
    return {
      miniPlayer: {
        ...(TWILIGHT_DEFAULT_THEME.windowDefaults?.miniPlayer ?? {}),
        ...(resolved.miniPlayer ?? {})
      },
      desktopLyrics: {
        ...(TWILIGHT_DEFAULT_THEME.windowDefaults?.desktopLyrics ?? {}),
        ...(resolved.desktopLyrics ?? {})
      }
    }
  })
  const accentPalette = computed(() => THEME_ACCENT_PALETTES[tone.value])
  const backgroundPalette = computed(() => THEME_BACKGROUND_PALETTES[tone.value])
  const contrastWarnings = computed(() => {
    if (activeModes.value.appearance?.contrastGuard === 'off') return []
    const appBackground = valueForId('surface.app')
    const pairs = [
      {
        label: '主要文字 / 应用背景',
        foreground: valueForId('color.neutral.900'),
        background: appBackground,
        minimum: 4.5
      },
      {
        label: '设置文字 / 设置表面',
        foreground: valueForId('settings.text.primary'),
        background: valueForId('surface.settings'),
        minimum: 4.5
      },
      {
        label: '导航文字 / 导航表面',
        foreground: valueForId('navigation.text'),
        background: valueForId('navigation.surface'),
        minimum: 4.5
      },
      {
        label: '大标题 / 应用背景',
        foreground: valueForId('typography.chromeText'),
        background: appBackground,
        minimum: 3
      }
    ]
    return pairs.flatMap((pair) => {
      const ratio = themeContrastRatio(pair.foreground, pair.background, appBackground)
      return ratio != null && ratio < pair.minimum ? [{ ...pair, ratio }] : []
    })
  })

  const backgroundBindings: Array<{ key: keyof ThemeAssetBindings; label: string }> = [
    { key: 'appBackground', label: '全局背景' },
    { key: 'localBackground', label: '本地音乐背景' },
    { key: 'settingsBackground', label: '设置背景' },
    { key: 'streamingBackground', label: '流媒体背景' },
    { key: 'playerBackground', label: '播放页背景' }
  ]

  const fontBindings: Array<{
    key: keyof ThemeAssetBindings
    tokenId: 'typography.sans' | 'typography.display' | 'typography.rounded'
    label: string
  }> = [
    { key: 'sansFont', tokenId: 'typography.sans', label: '正文字体' },
    { key: 'displayFont', tokenId: 'typography.display', label: '标题字体' },
    { key: 'roundedFont', tokenId: 'typography.rounded', label: '歌词字体' }
  ]
  const personalizationBackgroundBindings = backgroundBindings.slice(0, 1)

  function cloneProfile(profile: ThemeProfileV2): ThemeProfileV2 {
    return JSON.parse(JSON.stringify(profile)) as ThemeProfileV2
  }

  function selectionKey(selection: ThemeSelection): string {
    if (selection.kind === 'builtin') return `preset:${selection.id}`
    if (selection.kind === 'user') return `profile:${selection.id}`
    return `plugin:${selection.pluginId}:${selection.themeId}`
  }

  function resetHistory(profile: ThemeProfileV2): void {
    const clone = cloneProfile(profile)
    history.value = [clone]
    historyIndex.value = 0
    savedDraft.value = JSON.stringify(clone)
  }

  function pushHistory(profile: ThemeProfileV2): void {
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(cloneProfile(profile))
    if (history.value.length > 50) history.value.shift()
    historyIndex.value = history.value.length - 1
  }

  async function selectBuiltIn(
    presetId: BuiltInThemePresetId = TWILIGHT_DEFAULT_THEME_ID
  ): Promise<void> {
    previewScheduler.cancel()
    selectedKey.value = `preset:${presetId}`
    draft.value = null
    history.value = []
    historyIndex.value = -1
    await themeStore.previewTheme({ kind: 'builtin', id: presetId })
  }

  async function selectProfile(profile: ThemeProfileV2): Promise<void> {
    previewScheduler.cancel()
    selectedKey.value = `profile:${profile.id}`
    draft.value = cloneProfile(profile)
    resetHistory(draft.value)
    await themeStore.preview(draft.value)
  }

  async function selectPlugin(theme: ThemeContribution): Promise<void> {
    previewScheduler.cancel()
    selectedKey.value = `plugin:${getPluginThemeKey(theme)}`
    draft.value = null
    history.value = []
    historyIndex.value = -1
    await themeStore.previewTheme({ kind: 'plugin', pluginId: theme.pluginId, themeId: theme.id })
  }

  async function selectThemeKey(event: Event): Promise<void> {
    const key = (event.target as HTMLSelectElement).value
    if (key.startsWith('preset:')) {
      const presetId = key.slice('preset:'.length)
      if (getBuiltInThemePreset(presetId)) await selectBuiltIn(presetId as BuiltInThemePresetId)
      return
    }
    if (key.startsWith('profile:')) {
      const profile = profiles.value.find((entry) => `profile:${entry.id}` === key)
      if (profile) await selectProfile(profile)
      return
    }
    if (key.startsWith('plugin:')) {
      const theme = themeContributions.value.find(
        (entry) => `plugin:${getPluginThemeKey(entry)}` === key
      )
      if (theme) await selectPlugin(theme)
    }
  }

  function createProfileFromPlugin(theme: ThemeContribution): ThemeProfileV2 {
    const profile = themeStore.createProfile(`${theme.name} 副本`)
    for (const currentTone of ['pureWhite', 'dark'] as const) {
      const structured = theme.structured?.variants[currentTone]?.tokens
      if (structured) profile.overrides[currentTone] = normalizeThemeTokenOverrides(structured)
    }
    const byVariable = new Map(
      THEME_TOKEN_DEFINITIONS.map((definition) => [definition.cssVariable, definition.id])
    )
    for (const [variable, value] of Object.entries(theme.variables ?? {})) {
      const id = byVariable.get(variable as `--te-${string}`)
      if (!id) continue
      const normalized = normalizeThemeTokenValue(id, value)
      if (!normalized) continue
      profile.overrides.pureWhite[id] = normalized
      profile.overrides.dark[id] = normalized
    }
    if (theme.structured?.schemaVersion === 2) {
      profile.modes = normalizeThemeModes(theme.structured.modes)
    }
    return profile
  }

  async function duplicateSelected(): Promise<void> {
    previewScheduler.cancel()
    const sourceProfileId = draft.value?.id
    const source = draft.value
      ? cloneProfile(draft.value)
      : selectedBuiltInPreset.value
        ? selectedBuiltInPreset.value
        : selectedPluginTheme.value
          ? createProfileFromPlugin(selectedPluginTheme.value)
          : null
    const profile = themeStore.createProfile(
      source ? `${source.name} 自定义` : '自定义主题',
      source
    )
    selectedKey.value = `profile:${profile.id}`
    draft.value = profile
    resetHistory(profile)
    savedDraft.value = ''
    if (sourceProfileId && source?.assets?.length) {
      try {
        await themeStore.copyAssets(sourceProfileId, profile.id)
      } catch (cause) {
        localError.value = cause instanceof Error ? cause.message : '主题资源复制失败'
        return
      }
    }
    await themeStore.preview(profile)
  }

  async function derivePreset(preset: ThemeProfileV2): Promise<void> {
    await selectBuiltIn(preset.id as BuiltInThemePresetId)
    await duplicateSelected()
  }

  async function importAsset(type: ThemeAssetType): Promise<void> {
    if (!draft.value) return
    try {
      const asset = await themeStore.importAsset(draft.value.id, type)
      if (!asset) return
      updateDraft((profile) => {
        const assets = profile.assets ?? []
        profile.assets = [...assets.filter((entry) => entry.id !== asset.id), asset]
      })
    } catch (cause) {
      localError.value = cause instanceof Error ? cause.message : '主题资源导入失败'
    }
  }

  function updateAssetBinding(key: keyof ThemeAssetBindings, event: Event): void {
    const assetId = (event.target as HTMLSelectElement).value
    updateDraft((profile) => {
      const bindings = { ...(profile.assetBindings ?? {}) }
      if (assetId) bindings[key] = assetId
      else delete bindings[key]
      profile.assetBindings = Object.keys(bindings).length > 0 ? bindings : undefined
      if (key === 'appBackground' && assetId) {
        profile.modes.appearance = {
          ...(profile.modes.appearance ?? {}),
          backgroundTreatment: 'image'
        }
      }
    })
  }

  type ThemeMiniPlayerDefaultKey = keyof NonNullable<ThemeWindowDefaults['miniPlayer']>
  type ThemeDesktopLyricsDefaultKey = keyof NonNullable<ThemeWindowDefaults['desktopLyrics']>

  function windowDefaultValue(
    section: 'miniPlayer' | 'desktopLyrics',
    key: ThemeMiniPlayerDefaultKey | ThemeDesktopLyricsDefaultKey
  ): string | number | boolean | undefined {
    return (resolvedWindowDefaults.value[section] as Record<string, string | number | boolean>)[key]
  }

  function updateWindowDefault(
    section: 'miniPlayer' | 'desktopLyrics',
    key: ThemeMiniPlayerDefaultKey | ThemeDesktopLyricsDefaultKey,
    value: string | number | boolean
  ): void {
    updateDraft((profile) => {
      const windowDefaults = { ...(profile.windowDefaults ?? {}) }
      const sectionDefaults = {
        ...(windowDefaults[section] ?? {}),
        [key]: value
      }
      profile.windowDefaults = {
        ...windowDefaults,
        [section]: sectionDefaults
      } as ThemeWindowDefaults
    })
  }

  function updateWindowText(
    section: 'miniPlayer' | 'desktopLyrics',
    key: ThemeMiniPlayerDefaultKey | ThemeDesktopLyricsDefaultKey,
    event: Event
  ): void {
    updateWindowDefault(section, key, (event.target as HTMLInputElement).value)
  }

  function updateWindowNumber(
    section: 'miniPlayer' | 'desktopLyrics',
    key: ThemeMiniPlayerDefaultKey | ThemeDesktopLyricsDefaultKey,
    event: Event
  ): void {
    updateWindowDefault(section, key, Number((event.target as HTMLInputElement).value))
  }

  function updateWindowBoolean(
    section: 'miniPlayer' | 'desktopLyrics',
    key: ThemeDesktopLyricsDefaultKey,
    event: Event
  ): void {
    updateWindowDefault(section, key, (event.target as HTMLInputElement).checked)
  }

  function valueFor(definition: ThemeTokenDefinition): string {
    if (draft.value) {
      return (
        resolveThemeProfileTokens(draft.value, tone.value)[definition.id] ??
        definition.defaults[tone.value]
      )
    }
    if (selectedBuiltInPreset.value) {
      return (
        resolveThemeProfileTokens(selectedBuiltInPreset.value, tone.value)[definition.id] ??
        definition.defaults[tone.value]
      )
    }
    return (
      TWILIGHT_DEFAULT_THEME.variants[tone.value].tokens[definition.id] ??
      definition.defaults[tone.value]
    )
  }

  function valueForId(id: string): string {
    const definition = tokenDefinitionById.get(id)
    return definition ? valueFor(definition) : ''
  }

  function sourceFor(definition: ThemeTokenDefinition): string {
    if (draft.value?.overrides[tone.value][definition.id] != null) return '当前配置档'
    const sourcePreset = getBuiltInThemePreset(draft.value?.baseThemeId)
    if (sourcePreset?.overrides[tone.value][definition.id] != null) return '来源预设'
    const plugin = selectedPluginTheme.value
    if (
      plugin?.structured?.variants[tone.value]?.tokens?.[definition.id] != null ||
      plugin?.variables?.[definition.cssVariable] != null
    ) {
      return '主题包'
    }
    return '内置默认'
  }

  function assetSource(key: keyof ThemeAssetBindings): string {
    return draft.value?.assetBindings?.[key] ? '当前配置档' : '内置默认'
  }

  function updateDraft(mutator: (profile: ThemeProfileV2) => void): void {
    if (!draft.value) return
    const next = cloneProfile(draft.value)
    mutator(next)
    next.updatedAt = new Date().toISOString()
    draft.value = next
    pushHistory(next)
    previewScheduler.schedule(next)
  }

  function updateToken(definition: ThemeTokenDefinition, raw: string): void {
    const normalized = normalizeThemeTokenValue(definition.id, raw)
    if (!normalized) {
      localError.value = `${definition.label}的值无效`
      return
    }
    localError.value = ''
    updateDraft((profile) => {
      if (definition.id === 'color.primary.500') {
        Object.assign(
          profile.overrides[tone.value],
          createThemeAccentTokenOverrides(normalized, tone.value, valueForId('surface.app'))
        )
      } else {
        profile.overrides[tone.value][definition.id] = normalized
      }
    })
  }

  function applyAccentPalette(value: string): void {
    updateDraft((profile) => {
      Object.assign(
        profile.overrides[tone.value],
        createThemeAccentTokenOverrides(value, tone.value, valueForId('surface.app'))
      )
    })
  }

  function applyBackgroundPalette(value: string): void {
    updateDraft((profile) => {
      for (const id of [
        'surface.app',
        'surface.local',
        'surface.settings',
        'surface.streaming',
        'surface.player'
      ]) {
        profile.overrides[tone.value][id] = value
      }
    })
  }

  function updateAppearanceMode(
    key:
      | 'accentSource'
      | 'backgroundTreatment'
      | 'toneScheduling'
      | 'contrastGuard'
      | 'effectsMode',
    event: Event
  ): void {
    const value = (event.target as HTMLSelectElement).value
    updateDraft((profile) => {
      const appearance = { ...(profile.modes.appearance ?? {}) }
      if (key === 'accentSource' && (value === 'fixed' || value === 'cover')) {
        appearance.accentSource = value
      } else if (
        key === 'backgroundTreatment' &&
        ['solid', 'gradient', 'cover-blur', 'image'].includes(value)
      ) {
        appearance.backgroundTreatment = value as NonNullable<
          ThemeModes['appearance']
        >['backgroundTreatment']
      } else if (key === 'toneScheduling' && ['manual', 'system', 'timed'].includes(value)) {
        appearance.toneScheduling = value as NonNullable<ThemeModes['appearance']>['toneScheduling']
        if (value === 'timed' && !profile.toneSchedule) {
          profile.toneSchedule = { ...DEFAULT_THEME_TONE_SCHEDULE }
        }
      } else if (key === 'contrastGuard' && ['off', 'warn', 'enforce'].includes(value)) {
        appearance.contrastGuard = value as NonNullable<ThemeModes['appearance']>['contrastGuard']
      } else if (key === 'effectsMode' && (value === 'full' || value === 'reduced')) {
        appearance.effectsMode = value
      }
      profile.modes.appearance = appearance
    })
  }

  function updateTypographyMode(
    key: 'titleCase' | 'lyricAccent' | 'titleColor',
    event: Event
  ): void {
    const value = (event.target as HTMLSelectElement).value
    updateDraft((profile) => {
      const typography = { ...(profile.modes.typography ?? {}) }
      if (key === 'titleCase' && (value === 'preserve' || value === 'uppercase')) {
        typography.titleCase = value
      } else if (key === 'lyricAccent' && (value === 'off' || value === 'accent')) {
        typography.lyricAccent = value
      } else if (key === 'titleColor' && ['off', 'track', 'artist-album'].includes(value)) {
        typography.titleColor = value as NonNullable<ThemeModes['typography']>['titleColor']
      }
      profile.modes.typography = typography
    })
  }

  function updateNavigationMode(key: 'style' | 'iconScale' | 'logo', event: Event): void {
    const value = (event.target as HTMLSelectElement).value
    updateDraft((profile) => {
      const navigation = { ...(profile.modes.navigation ?? {}) }
      if (key === 'style' && ['expanded', 'compact', 'rail'].includes(value)) {
        navigation.style = value as NonNullable<ThemeModes['navigation']>['style']
      } else if (key === 'iconScale' && ['sm', 'md', 'lg'].includes(value)) {
        navigation.iconScale = value as NonNullable<ThemeModes['navigation']>['iconScale']
      } else if (key === 'logo' && (value === 'show' || value === 'hide')) {
        navigation.logo = value
      }
      profile.modes.navigation = navigation
    })
  }

  function updateLibraryMode(key: 'density' | 'selection' | 'titleOverlay', event: Event): void {
    const value = (event.target as HTMLSelectElement).value
    updateDraft((profile) => {
      const library = { ...(profile.modes.library ?? {}) }
      if (key === 'density' && (value === 'comfortable' || value === 'compact')) {
        library.density = value
      } else if (key === 'selection' && (value === 'fill' || value === 'stroke')) {
        library.selection = value
      } else if (key === 'titleOverlay' && (value === 'off' || value === 'on')) {
        library.titleOverlay = value
      }
      profile.modes.library = library
    })
  }

  function updatePlayerMode(key: 'controls' | 'titleAlign' | 'progress', event: Event): void {
    const value = (event.target as HTMLSelectElement).value
    updateDraft((profile) => {
      const player = { ...(profile.modes.player ?? {}) }
      if (key === 'controls' && (value === 'standard' || value === 'pro')) {
        player.controls = value
      } else if (key === 'titleAlign' && (value === 'left' || value === 'center')) {
        player.titleAlign = value
      } else if (key === 'progress' && ['line', 'ring', 'solid', 'spectrum'].includes(value)) {
        player.progress = value as NonNullable<ThemeModes['player']>['progress']
      }
      profile.modes.player = player
    })
  }

  function setPlayerLayout(layout: ThemePlayerLayout): void {
    updateDraft((profile) => {
      profile.modes.player = { ...(profile.modes.player ?? {}), layout }
    })
  }

  function updateArtworkMode(key: 'transition' | 'shadow', event: Event): void {
    const value = (event.target as HTMLSelectElement).value
    updateDraft((profile) => {
      const artwork = { ...(profile.modes.artwork ?? {}) }
      if (key === 'transition' && ['fade', 'slide', 'none'].includes(value)) {
        artwork.transition = value as NonNullable<ThemeModes['artwork']>['transition']
      } else if (key === 'shadow' && (value === 'on' || value === 'off')) {
        artwork.shadow = value
      }
      profile.modes.artwork = artwork
    })
  }

  function updateEqualizerMode(
    key: 'panel' | 'slider' | 'knob' | 'spectrum' | 'button',
    event: Event
  ): void {
    const value = (event.target as HTMLSelectElement).value
    updateDraft((profile) => {
      const equalizer = { ...(profile.modes.equalizer ?? {}) }
      if (key === 'panel' && ['neutral', 'tinted', 'glass'].includes(value)) {
        equalizer.panel = value as NonNullable<ThemeModes['equalizer']>['panel']
      } else if (key === 'slider' && (value === 'ring' || value === 'solid')) {
        equalizer.slider = value
      } else if (key === 'knob' && (value === 'line' || value === 'dot')) {
        equalizer.knob = value
      } else if (key === 'spectrum' && ['bars', 'line', 'area'].includes(value)) {
        equalizer.spectrum = value as NonNullable<ThemeModes['equalizer']>['spectrum']
      } else if (key === 'button' && ['soft', 'outline', 'solid'].includes(value)) {
        equalizer.button = value as NonNullable<ThemeModes['equalizer']>['button']
      }
      profile.modes.equalizer = equalizer
    })
  }

  function visibilityValue(id: ThemeVisibilitySlotId): boolean {
    const explicit = activeModes.value.visibility?.[id]
    if (typeof explicit === 'boolean') return explicit
    return activeModes.value.player?.layout !== 'minimal' || !minimalHiddenSlots.has(id)
  }

  function updateVisibility(id: ThemeVisibilitySlotId, event: Event): void {
    const visible = (event.target as HTMLInputElement).checked
    updateDraft((profile) => {
      profile.modes.visibility = { ...(profile.modes.visibility ?? {}), [id]: visible }
    })
  }

  function updateIconFamily(event: Event): void {
    const value = (event.target as HTMLSelectElement).value
    if (!['outline', 'rounded', 'filled'].includes(value)) return
    updateDraft((profile) => {
      profile.modes.icons = {
        ...(profile.modes.icons ?? {}),
        family: value as NonNullable<ThemeModes['icons']>['family']
      }
    })
  }

  function scheduleTime(key: 'lightStartMinutes' | 'darkStartMinutes'): string {
    const minutes = draft.value?.toneSchedule?.[key] ?? DEFAULT_THEME_TONE_SCHEDULE[key]
    return `${Math.floor(minutes / 60)
      .toString()
      .padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`
  }

  function updateScheduleTime(key: 'lightStartMinutes' | 'darkStartMinutes', event: Event): void {
    const match = (event.target as HTMLInputElement).value.match(/^(\d{2}):(\d{2})$/)
    if (!match) return
    const minutes = Number(match[1]) * 60 + Number(match[2])
    updateDraft((profile) => {
      const next = { ...(profile.toneSchedule ?? DEFAULT_THEME_TONE_SCHEDULE), [key]: minutes }
      if (next.lightStartMinutes !== next.darkStartMinutes) profile.toneSchedule = next
    })
  }

  function fontSelection(binding: (typeof fontBindings)[number]): string {
    const assetId = draft.value?.assetBindings?.[binding.key]
    if (assetId) return `asset:${assetId}`
    const value = valueForId(binding.tokenId)
    const builtIn = BUILT_IN_THEME_FONTS.find((font) => font.value === value)
    return builtIn ? `builtin:${builtIn.id}` : 'custom'
  }

  function fontSource(binding: (typeof fontBindings)[number]): string {
    if (draft.value?.assetBindings?.[binding.key]) return '当前配置档 · 本地资源'
    if (draft.value?.overrides[tone.value][binding.tokenId]) return '当前配置档 · 内置字体'
    return '内置默认'
  }

  function updateFontSlot(binding: (typeof fontBindings)[number], event: Event): void {
    const selection = (event.target as HTMLSelectElement).value
    if (selection === 'custom') return
    updateDraft((profile) => {
      const bindings = { ...(profile.assetBindings ?? {}) }
      if (selection.startsWith('asset:')) {
        bindings[binding.key] = selection.slice('asset:'.length)
      } else {
        delete bindings[binding.key]
        const font = BUILT_IN_THEME_FONTS.find((entry) => `builtin:${entry.id}` === selection)
        if (font) profile.overrides[tone.value][binding.tokenId] = font.value
      }
      profile.assetBindings = Object.keys(bindings).length > 0 ? bindings : undefined
    })
  }

  function updateRange(definition: ThemeTokenDefinition, event: Event): void {
    const value = (event.target as HTMLInputElement).value
    updateToken(definition, `${value}${definition.unit ?? ''}`)
  }

  function removeOverride(definition: ThemeTokenDefinition): void {
    updateDraft((profile) => {
      if (definition.id === 'color.primary.500') {
        for (const id of [
          'color.primary.500',
          'color.primary.400',
          'color.primary.300',
          'color.primary.rgb',
          'material.glowMain',
          'surface.active',
          'navigation.activeText',
          'navigation.indicator',
          'playback.accent'
        ]) {
          delete profile.overrides[tone.value][id]
        }
      } else {
        delete profile.overrides[tone.value][definition.id]
      }
    })
  }

  function resetGroup(): void {
    updateDraft((profile) => {
      for (const definition of definitions.value)
        delete profile.overrides[tone.value][definition.id]
      if (domain.value === 'personalization') {
        profile.modes.appearance = undefined
        profile.toneSchedule = undefined
        for (const id of [
          'color.primary.400',
          'color.primary.300',
          'color.primary.rgb',
          'material.glowMain',
          'surface.active',
          'navigation.activeText',
          'navigation.indicator',
          'playback.accent'
        ]) {
          delete profile.overrides[tone.value][id]
        }
      }
      if (domain.value === 'typography') profile.modes.typography = undefined
      if (domain.value === 'navigation') {
        profile.modes.navigation = undefined
        profile.modes.icons = undefined
      }
      if (domain.value === 'library') profile.modes.library = undefined
      if (domain.value === 'player') {
        profile.modes.player = undefined
        profile.modes.artwork = undefined
        profile.modes.equalizer = undefined
        profile.modes.visibility = undefined
      }
      if (domain.value === 'windows') profile.windowDefaults = undefined
      if (
        profile.assetBindings &&
        (domain.value === 'personalization' || domain.value === 'typography')
      ) {
        if (domain.value === 'personalization') delete profile.assetBindings.appBackground
        if (domain.value === 'typography') {
          delete profile.assetBindings.sansFont
          delete profile.assetBindings.displayFont
          delete profile.assetBindings.roundedFont
        }
        if (Object.keys(profile.assetBindings).length === 0) profile.assetBindings = undefined
      }
    })
  }

  function resetAll(): void {
    updateDraft((profile) => {
      profile.overrides = { pureWhite: {}, dark: {} }
      profile.modes = {}
      profile.toneSchedule = undefined
      profile.windowDefaults = undefined
      profile.assetBindings = undefined
    })
  }

  function restoreVersion(entry: ThemeProfileHistoryEntry): void {
    if (!draft.value || entry.profile.id !== draft.value.id) return
    const restored = cloneProfile(entry.profile)
    restored.updatedAt = new Date().toISOString()
    draft.value = restored
    pushHistory(restored)
    previewScheduler.schedule(restored)
  }

  function historyLabel(entry: ThemeProfileHistoryEntry): string {
    const timestamp = Date.parse(entry.savedAt)
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : entry.savedAt
  }

  function presetPreviewStyle(profile: ThemeProfileV2): Record<string, string> {
    const tokens = resolveThemeProfileTokens(profile, tone.value)
    return {
      '--preset-accent': tokens['color.primary.500'],
      '--preset-surface': tokens['surface.app'],
      '--preset-card': tokens['surface.card'],
      '--preset-border': tokens['surface.cardBorder']
    }
  }

  function undo(): void {
    if (!canUndo.value) return
    historyIndex.value -= 1
    draft.value = cloneProfile(history.value[historyIndex.value])
    previewScheduler.schedule(draft.value)
  }

  function redo(): void {
    if (!canRedo.value) return
    historyIndex.value += 1
    draft.value = cloneProfile(history.value[historyIndex.value])
    previewScheduler.schedule(draft.value)
  }

  async function applySelected(): Promise<void> {
    localError.value = ''
    notice.value = ''
    try {
      await previewScheduler.flush()
      if (draft.value) {
        const toSave = cloneProfile(draft.value)
        const saved = await themeStore.saveProfile(toSave)
        const persisted = saved.data.profiles.find((profile) => profile.id === toSave.id)
        if (!persisted) throw new Error('保存后的主题档案不可用')
        draft.value = cloneProfile(persisted)
        resetHistory(draft.value)
        await themeStore.setActive({ kind: 'user', id: draft.value.id })
        selectedKey.value = `profile:${draft.value.id}`
      } else if (selectedPluginTheme.value) {
        await themeStore.setActive({
          kind: 'plugin',
          pluginId: selectedPluginTheme.value.pluginId,
          themeId: selectedPluginTheme.value.id
        })
      } else if (selectedBuiltInPreset.value) {
        await themeStore.setActive({
          kind: 'builtin',
          id: selectedBuiltInPreset.value.id as BuiltInThemePresetId
        })
      }
      notice.value = '主题已应用'
    } catch (cause) {
      localError.value = cause instanceof Error ? cause.message : '主题保存失败'
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!draft.value || !profiles.value.some((profile) => profile.id === draft.value?.id)) {
      localError.value = '请先应用主题后再删除'
      return
    }
    if (!window.confirm(`删除主题“${draft.value.name}”？`)) return
    try {
      await themeStore.deleteProfile(draft.value.id)
      await selectBuiltIn()
    } catch (cause) {
      localError.value = cause instanceof Error ? cause.message : '主题删除失败'
    }
  }

  async function importTheme(): Promise<void> {
    try {
      const next = await themeStore.importTheme()
      const imported = next?.data.profiles.at(-1)
      if (imported) await selectProfile(imported)
    } catch (cause) {
      localError.value = cause instanceof Error ? cause.message : '主题导入失败'
    }
  }

  async function exportTheme(): Promise<void> {
    if (!draft.value || !profiles.value.some((profile) => profile.id === draft.value?.id)) {
      localError.value = '请先应用主题后再导出'
      return
    }
    try {
      const output = await themeStore.exportTheme(draft.value.id)
      if (output) notice.value = '主题已导出'
    } catch (cause) {
      localError.value = cause instanceof Error ? cause.message : '主题导出失败'
    }
  }

  async function toggleWindowInheritance(key: 'miniPlayer' | 'desktopLyrics'): Promise<void> {
    const current = themeStore.snapshot.value?.data.windowInheritance
    if (!current) return
    try {
      await themeStore.setWindowInheritance({ ...current, [key]: !current[key] })
    } catch (cause) {
      localError.value = cause instanceof Error ? cause.message : '窗口主题继承设置失败'
    }
  }

  function changeName(event: Event): void {
    const name = (event.target as HTMLInputElement).value.trim().slice(0, 80)
    if (!name) return
    updateDraft((profile) => {
      profile.name = name
    })
  }

  function rangeNumber(definition: ThemeTokenDefinition): number {
    return Number.parseFloat(valueFor(definition))
  }

  function supportsColorPicker(value: string): boolean {
    return /^#[0-9a-f]{6}$/i.test(value)
  }

  async function setTone(nextTone: ThemeTone): Promise<void> {
    await previewScheduler.flush()
    tone.value = nextTone
    await themeStore.setPreviewTone(nextTone)
  }

  function closeStudio(): void {
    if (isDirty.value && !window.confirm('放弃尚未应用的主题修改？')) return
    previewScheduler.cancel()
    document.documentElement.dataset.theme = originalTone
    void themeStore.setPreviewTone(null).then(() => themeStore.previewTheme(null))
    options.onBack()
  }

  function updateLivePreviewScale(): void {
    const viewport = previewViewportRef.value
    if (!viewport) return
    const sourceWidth = Math.max(1, document.documentElement.clientWidth)
    const sourceHeight = Math.max(1, document.documentElement.clientHeight)
    previewViewportStyle.value = { aspectRatio: `${sourceWidth} / ${sourceHeight}` }
    const scale = Math.min(
      viewport.clientWidth / sourceWidth,
      viewport.clientHeight / sourceHeight,
      1
    )
    const left = Math.max(0, (viewport.clientWidth - sourceWidth * scale) / 2)
    const top = Math.max(0, (viewport.clientHeight - sourceHeight * scale) / 2)
    previewCanvasStyle.value = {
      width: `${sourceWidth}px`,
      height: `${sourceHeight}px`,
      transform: `translate3d(${left}px, ${top}px, 0) scale(${scale})`
    }
  }

  onMounted(async () => {
    previewResizeObserver = new ResizeObserver(updateLivePreviewScale)
    if (previewViewportRef.value) previewResizeObserver.observe(previewViewportRef.value)
    window.addEventListener('resize', updateLivePreviewScale)
    window.requestAnimationFrame(updateLivePreviewScale)
    await Promise.all([themeStore.load(), syncExtensions()])
    originalTone = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'pureWhite'
    tone.value = originalTone
    await themeStore.setPreviewTone(originalTone)
    if (domain.value === 'player' || domain.value === 'typography') previewSurface.value = 'player'
    const active = themeStore.activeTheme.value
    if (active.kind === 'user') {
      const profile = profiles.value.find((entry) => entry.id === active.id)
      if (profile) await selectProfile(profile)
    } else if (active.kind === 'plugin') {
      const theme = themeContributions.value.find(
        (entry) => entry.pluginId === active.pluginId && entry.id === active.themeId
      )
      if (theme) await selectPlugin(theme)
    } else {
      await selectBuiltIn(active.id)
    }
  })

  onBeforeUnmount(() => {
    previewScheduler.cancel()
    window.removeEventListener('resize', updateLivePreviewScale)
    previewResizeObserver?.disconnect()
    previewResizeObserver = null
    document.documentElement.dataset.theme = originalTone
    void themeStore.setPreviewTone(null).then(() => themeStore.previewTheme(null))
  })

  return {
    BUILT_IN_THEME_FONTS,
    BUILT_IN_THEME_PRESETS,
    accentPalette,
    activeDomain,
    activeKey,
    activeModes,
    applyAccentPalette,
    applyBackgroundPalette,
    applySelected,
    assetSource,
    backgroundBindings,
    backgroundPalette,
    canRedo,
    canUndo,
    changeName,
    closeStudio,
    contrastWarnings,
    deleteSelected,
    derivePreset,
    domain,
    domains,
    draft,
    duplicateSelected,
    exportTheme,
    filteredStudioHits,
    fontAssets,
    fontBindings,
    fontSelection,
    fontSource,
    getBuiltInThemePreset,
    getPluginThemeKey,
    historyLabel,
    imageAssets,
    importAsset,
    importTheme,
    isDirty,
    isUnsavedDraft,
    jumpToSearchHit,
    localError,
    notice,
    persistedHistory,
    personalizationBackgroundBindings,
    playerLayouts,
    presetPreviewStyle,
    previewCanvasStyle,
    previewNavigationOpen,
    previewSurface,
    previewSurfaces,
    previewViewportRef,
    previewViewportStyle,
    profiles,
    rangeNumber,
    redo,
    removeOverride,
    resetAll,
    resetGroup,
    resolveThemeProfileModes,
    restoreVersion,
    scheduleTime,
    selectedKey,
    selectedPluginTheme,
    selectBuiltIn,
    selectProfile,
    selectThemeKey,
    setPlayerLayout,
    setTone,
    sourceFor,
    studioSearchQuery,
    supportsColorPicker,
    themeContributions,
    themeStore,
    toggleWindowInheritance,
    tone,
    undo,
    updateAppearanceMode,
    updateArtworkMode,
    updateAssetBinding,
    updateEqualizerMode,
    updateFontSlot,
    updateIconFamily,
    updateLibraryMode,
    updateNavigationMode,
    updatePlayerMode,
    updateRange,
    updateScheduleTime,
    updateToken,
    updateTypographyMode,
    updateVisibility,
    updateWindowBoolean,
    updateWindowNumber,
    updateWindowText,
    valueFor,
    valueForId,
    visibleDefinitions,
    visibilityOptions,
    visibilityValue,
    windowDefaultValue
  }
}
