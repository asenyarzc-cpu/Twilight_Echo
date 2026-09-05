import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  THEME_MODE_DEFINITIONS,
  THEME_TOKEN_DEFINITIONS,
  THEME_VISIBILITY_SLOT_IDS
} from '../../../shared/theme.ts'

const playingMusic = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
// Lyric layer colours are resolved in a shared helper so the page and the
// customizer preview cannot drift; it is as much a playback surface as the page.
const lyricStyleVars = readFileSync(new URL('../utils/lyricsStyleVars.ts', import.meta.url), 'utf8')
const playerBarComponent = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
const playerBar = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')
const equalizer = readFileSync(new URL('./EqualizerPage.vue', import.meta.url), 'utf8')
const equalizerOpra = readFileSync(new URL('./equalizer/OpraEqPanel.vue', import.meta.url), 'utf8')
const equalizerChart = readFileSync(
  new URL('./equalizer/FrequencyResponseChart.vue', import.meta.url),
  'utf8'
)
const equalizerGraphic = readFileSync(
  new URL('./equalizer/GraphicEqPanel.vue', import.meta.url),
  'utf8'
)
const equalizerToolbar = readFileSync(
  new URL('./equalizer/FrequencyResponseToolbar.vue', import.meta.url),
  'utf8'
)
const equalizerSurfaces = [
  equalizer,
  equalizerOpra,
  equalizerChart,
  equalizerGraphic,
  equalizerToolbar
].join('\n')
const dspRack = readFileSync(new URL('./DspRackPage.vue', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const baseStyle = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')
const settingsPage = readFileSync(new URL('./SettingsPage.vue', import.meta.url), 'utf8')
const settingsAppearance = readFileSync(
  new URL('./settings-page/AppearanceSettingsSection.vue', import.meta.url),
  'utf8'
)
const settingsThemeControls = readFileSync(
  new URL('./settings-page/ThemeControlsSettings.vue', import.meta.url),
  'utf8'
)
const settingsSurfaces = [settingsPage, settingsAppearance, settingsThemeControls].join('\n')
const studio = readFileSync(new URL('./ThemeStudioPage.vue', import.meta.url), 'utf8')
const studioEditor = readFileSync(
  new URL('./theme-studio/useThemeStudioEditor.ts', import.meta.url),
  'utf8'
)
const studioSurfaces = [studio, studioEditor].join('\n')
const studioStyle = readFileSync(
  new URL('./theme-studio/ThemeStudioPage.css', import.meta.url),
  'utf8'
)
const sideMenu = readFileSync(new URL('./SideMenu.vue', import.meta.url), 'utf8')
const themeIcon = readFileSync(new URL('./ThemeIcon.vue', import.meta.url), 'utf8')
const titleBar = readFileSync(new URL('./TitleBar.vue', import.meta.url), 'utf8')
const songList = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')
const songListView = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
const virtualScroll = readFileSync(
  new URL('./song-list/useSongListVirtualScroll.ts', import.meta.url),
  'utf8'
)
const localDashboard = readFileSync(new URL('./LocalDashboard.css', import.meta.url), 'utf8')
const rendererMain = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')
const settingsStyle = readFileSync(
  new URL('./settings-page/SettingsPage.css', import.meta.url),
  'utf8'
)
const onboardingStyle = readFileSync(
  new URL('./onboarding/OnboardingWizard.css', import.meta.url),
  'utf8'
)
const themeStore = readFileSync(new URL('../stores/useThemeStore.ts', import.meta.url), 'utf8')
const previewScheduler = readFileSync(
  new URL('../utils/themePreviewScheduler.ts', import.meta.url),
  'utf8'
)
const themePerformance = readFileSync(
  new URL('../utils/themePerformance.ts', import.meta.url),
  'utf8'
)
const visualRegression = readFileSync(
  new URL('../../../../scripts/theme-visual-regression.cjs', import.meta.url),
  'utf8'
)
const pluginThemeRuntime = readFileSync(
  new URL('../extensions/pluginThemeRuntime.ts', import.meta.url),
  'utf8'
)
const playerStore = readFileSync(new URL('../stores/usePlayerStore.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../../preload/index.ts', import.meta.url), 'utf8')
const themesApi = readFileSync(
  new URL('../../../preload/domains/themesApi.ts', import.meta.url),
  'utf8'
)
const preloadSurfaces = [preload, themesApi].join('\n')
const themeIpc = readFileSync(new URL('../../../main/ipc/themes.ts', import.meta.url), 'utf8')
const themeArchive = readFileSync(
  new URL('../../../main/themes/themeArchive.ts', import.meta.url),
  'utf8'
)
const windowInheritance = readFileSync(
  new URL('../../../main/themes/windowInheritance.ts', import.meta.url),
  'utf8'
)
const settingsBackup = readFileSync(
  new URL('../../../main/core/settingsBackup.ts', import.meta.url),
  'utf8'
)
const pluginIpc = readFileSync(new URL('../../../main/ipc/plugins.ts', import.meta.url), 'utf8')
const pluginThemeContribution = readFileSync(
  new URL('../../../main/plugins/themeContribution.ts', import.meta.url),
  'utf8'
)
const pluginApi = readFileSync(
  new URL('../../../../packages/plugin-api/src/index.ts', import.meta.url),
  'utf8'
)
const pluginThemeTemplate = readFileSync(
  new URL(
    '../../../../packages/create-twilight-plugin/templates/theme/plugin.json.tmpl',
    import.meta.url
  ),
  'utf8'
)
const pluginThemeContract = JSON.parse(
  readFileSync(
    new URL('../../../../packages/plugin-api/theme-contract.json', import.meta.url),
    'utf8'
  )
) as {
  pluginApiVersion: number
  structuredThemeSchemaVersion: number
  tokens: Array<{ id: string }>
  modes: Array<{ id: string }>
  visibility: string[]
  layout: {
    slots: string[]
    tracks: string[]
    navigation: string[]
    requiredSlots: string[]
    compactBreakpointPx: number
  }
}

test('every registered playback token is wired into a real playback or DSP surface', () => {
  const playbackVariables = THEME_TOKEN_DEFINITIONS.filter(
    (definition) => definition.group === 'playback'
  ).map((definition) => definition.cssVariable)
  const playbackSurfaces = [
    playingMusic,
    lyricStyleVars,
    playerBar,
    equalizerSurfaces,
    dspRack
  ].join('\n')
  assert.ok(playbackVariables.length >= 20)
  for (const variable of playbackVariables) assert.match(playbackSurfaces, new RegExp(variable))
})

test('theme studio is a dedicated navigable settings surface', () => {
  assert.match(app, /ThemeStudioPage/)
  assert.match(app, /@open-theme-studio="openThemeStudioPage"/)
  assert.match(settingsSurfaces, /打开主题工作室/)
  assert.doesNotMatch(studioSurfaces, /structuredClone\(profile\)/)
  assert.match(studioSurfaces, /个性化与材质/)
  assert.match(studio, /theme-domain-list/)
  assert.match(studio, /sourceFor\(definition\)/)
  assert.match(studio, /assetSource\(binding\.key\)/)
  assert.match(studio, /draft\.name \}\} · 未保存/)
})

test('theme studio live preview mounts real application surfaces instead of a mock shell', () => {
  for (const component of [
    'LocalHome',
    'PlayingMusic',
    'EqualizerPage',
    'PlayerBar',
    'SideMenu',
    'TitleBar'
  ]) {
    assert.match(studio, new RegExp(`import ${component} from`))
    assert.match(studio, new RegExp(`<${component}`))
  }
  assert.match(studio, /class="live-preview-canvas"/)
  assert.match(studio, /previewCanvasStyle/)
  assert.match(studio, /inert/)
  assert.match(studio, /<PlayerBar[\s\S]*preview/)
  assert.match(playerBarComponent, /if \(!props\.preview\) void syncExtensions\(\)/)
  assert.doesNotMatch(studio, /class="preview-(?:app-shell|cards|playerbar|player-surface)"/)
  assert.match(studioStyle, /\.live-preview-canvas/)
  assert.match(
    themeStore,
    /else if \(previewTone\.value\)[\s\S]*TWILIGHT_DEFAULT_THEME\.variants\[tone\]\.tokens/
  )
})

test('theme assets use typed local bindings instead of arbitrary stylesheet urls', () => {
  assert.match(studio, /importAsset\('image'\)/)
  assert.match(studio, /importAsset\('font'\)/)
  assert.match(themeStore, /theme-asset:\/\/asset\//)
  assert.match(themeStore, /@font-face/)
  assert.match(themeStore, /window\.api\.themes\.validateAssets/)
  assert.match(themeIpc, /themes:validateAssets/)
})

test('phase one semantic tokens are wired into shell, settings, navigation, and library surfaces', () => {
  assert.match(titleBar, /--te-shell-control-hover/)
  assert.match(sideMenu, /--te-navigation-active/)
  assert.match(settingsStyle, /--te-settings-control-border/)
  assert.match(songList, /--te-library-selection-bg/)
  assert.match(songList, /--te-library-table-shadow/)
})

test('phase two runtime reuses cached cover media and supports native and timed tone scheduling', () => {
  assert.match(playerStore, /extractDominantColor\(displayCover\)/)
  assert.match(playerStore, /themeCoverIdentity/)
  assert.match(app, /setAdaptiveMedia\(\{ identity, accentColor, coverUrl \}\)/)
  assert.match(themeStore, /createThemeAccentTokenOverrides/)
  assert.match(themeStore, /resolveScheduledThemeTone/)
  assert.match(themeStore, /scheduleTimedToneRefresh/)
  assert.match(themeIpc, /nativeTheme\.on\('updated'/)
  assert.match(preloadSurfaces, /themes:systemToneChanged/)
})

test('settings appearance choices override the active theme and provide usable density rules', () => {
  assert.match(themeStore, /const SETTINGS_ACCENT_COLORS/)
  assert.match(themeStore, /cacheSettingsAppearance\(bootstrap\.settings\)/)
  assert.match(
    themeStore,
    /window\.api\.settings\.onChanged\(\(next\) => \{[\s\S]*syncThemeSettingsAppearance\(next\.settings\)/
  )
  assert.match(themeStore, /applySettingsThemeMode\(next\.settings\.theme\)/)
  assert.match(themeStore, /applySettingsAccentColor\(tone, variables\)/)
  assert.match(themeStore, /createThemeAccentTokenOverrides\(color, tone, background\)/)
  assert.match(settingsStyle, /html\[data-density='compact'\] \.settings-preview-stack/)
  assert.match(settingsStyle, /html\[data-density='comfortable'\] \.setting-item/)
  assert.match(onboardingStyle, /html\[data-density='compact'\] \.onb-stage/)
  assert.match(onboardingStyle, /html\[data-density='comfortable'\] \.onb-stage/)
})

test('phase two studio exposes palettes, nine typography settings, and contrast protection', () => {
  assert.match(studioEditor, /THEME_ACCENT_PALETTES/)
  assert.match(studioEditor, /THEME_BACKGROUND_PALETTES/)
  assert.match(studio, /accentPalette\.length/)
  assert.match(studio, /backgroundPalette\.length/)
  assert.match(studioSurfaces, /typography\.bodySize/)
  assert.match(studioSurfaces, /typography\.titleWeight/)
  assert.match(studioSurfaces, /typography\.chromeText/)
  assert.match(studio, /updateTypographyMode\('titleCase'/)
  assert.match(studio, /updateTypographyMode\('lyricAccent'/)
  assert.match(studio, /updateTypographyMode\('titleColor'/)
  assert.match(studioEditor, /key: 'sansFont', tokenId: 'typography\.sans'/)
  assert.match(studioEditor, /key: 'displayFont', tokenId: 'typography\.display'/)
  assert.match(studioEditor, /key: 'roundedFont', tokenId: 'typography\.rounded'/)
  assert.match(studioEditor, /themeContrastRatio/)
  assert.match(themeStore, /ensureThemeTextContrast/)
})

test('phase two unified surface and background tokens are wired into host CSS', () => {
  assert.match(baseStyle, /data-te-background-treatment='cover-blur'/)
  assert.match(baseStyle, /--te-background-cover-blur/)
  assert.match(baseStyle, /--te-dialog-radius/)
  assert.match(baseStyle, /--te-search-radius/)
  assert.match(baseStyle, /--te-toast-radius/)
  assert.match(baseStyle, /--te-track-title-radius/)
  assert.match(baseStyle, /data-te-title-case='uppercase'/)
  assert.match(baseStyle, /data-te-lyric-accent='accent'/)
})

test('phase three icon, navigation, and library modes use static host-owned presentation', () => {
  assert.match(rendererMain, /@phosphor-icons\/web\/regular/)
  assert.doesNotMatch(rendererMain, /@phosphor-icons\/web\/(?:bold|fill)/)
  assert.match(themeIcon, /THEME_ICON_SLOT_REGISTRY/)
  assert.match(themeIcon, /data-theme-icon-slot/)
  assert.match(sideMenu, /icon-slot="navigation\.streaming"/)
  assert.match(sideMenu, /data-te-navigation-style='rail'/)
  assert.match(sideMenu, /data-te-navigation-icon-scale='lg'/)
  assert.match(studioSurfaces, /updateIconFamily/)
  assert.match(studio, /updateNavigationMode\('style'/)
  assert.match(studio, /updateLibraryMode\('density'/)
  assert.match(songListView, /icon-slot="library\.search"/)
  assert.match(songList, /data-te-library-selection='stroke'/)
  assert.match(songList, /--te-library-action-bg/)
  assert.match(localDashboard, /data-te-library-density='compact'/)
  assert.match(localDashboard, /--te-library-cover-radius/)
  assert.match(studioStyle, /--te-navigation-opacity/)
  assert.match(studioStyle, /--te-library-cover-radius/)
  assert.doesNotMatch(studioStyle, /:global\(/)
  for (const scopedStyle of [themeIcon, sideMenu, songList, localDashboard]) {
    assert.doesNotMatch(scopedStyle, /:global\(html\[data-te-[^)]+\]\)\s+[.#:]/)
  }
  assert.match(virtualScroll, /const ROW_HEIGHT = 68/)
  assert.doesNotMatch(virtualScroll, /data-te-library-density/)
})

test('phase four player layouts, controls, equalizer modes, and visibility stay host-owned', () => {
  for (const layout of ['standard', 'full-cover', 'lyrics-focus', 'split', 'minimal']) {
    assert.match(studioEditor, new RegExp(`id: '${layout}'`))
  }
  assert.match(studio, /class="layout-gallery"/)
  assert.match(studioEditor, /minimalHiddenSlots/)
  assert.match(studioEditor, /typeof explicit === 'boolean'/)
  assert.match(playingMusic, /data-te-player-layout='full-cover'/)
  assert.match(playingMusic, /data-te-player-layout='lyrics-focus'/)
  assert.match(playingMusic, /data-te-player-layout='split'/)
  assert.match(playingMusic, /data-te-player-layout='minimal'/)
  assert.match(playingMusic, /data-te-visible-player-artwork='false'/)
  assert.match(playerBar, /data-te-player-controls='pro'/)
  assert.match(playerBar, /data-te-player-progress='spectrum'/)
  assert.match(playerBar, /data-te-visible-player-track-menu='false'/)
  assert.match(equalizerSurfaces, /data-te-equalizer-panel='glass'/)
  assert.match(equalizerSurfaces, /data-te-equalizer-spectrum='bars'/)
  assert.match(equalizerSurfaces, /data-te-visible-equalizer-spectrum='false'/)
  assert.match(dspRack, /data-te-equalizer-button='solid'/)
  assert.doesNotMatch(playingMusic, /usePlaybackQueueStore/)
})

test('phase five presets, recovery, window inheritance, and contextual entries stay declarative', () => {
  assert.match(studioEditor, /BUILT_IN_THEME_PRESETS/)
  assert.match(studio, /class="preset-gallery"/)
  assert.match(studioSurfaces, /derivePreset/)
  assert.match(studioEditor, /persistedHistory/)
  assert.match(studioEditor, /restoreVersion/)
  assert.match(studioEditor, /resetAll/)
  assert.match(studioSurfaces, /独立窗口/)
  assert.match(studioEditor, /updateWindowDefault/)
  assert.match(songListView, /定制此区域外观/)
  assert.match(playingMusic, /定制此区域外观/)
  assert.match(windowInheritance, /surfaceColor/)
  assert.match(windowInheritance, /fontFamily/)
  assert.match(windowInheritance, /shadowColor/)
  assert.match(settingsBackup, /themeLibrary/)
  assert.match(themeIpc, /restoreThemeLibraryFromBackup/)
  assert.match(themeIpc, /reconcileThemeAfterPluginChange\(\)/)
})

test('phase six plugin shell layouts are API v3, host-owned, and compatibility-reporting', () => {
  assert.match(pluginApi, /TWILIGHT_PLUGIN_API_VERSION = 3/)
  assert.match(pluginApi, /interface TwilightStructuredThemeV2/)
  assert.match(pluginApi, /interface TwilightStructuredThemeV3/)
  assert.match(pluginThemeTemplate, /"apiVersion": 3/)
  assert.match(pluginThemeTemplate, /"schemaVersion": 3/)
  assert.match(pluginThemeTemplate, /"layout"/)
  assert.match(
    pluginThemeContribution,
    /options\.pluginApiVersion < STRUCTURED_PLUGIN_THEME_SCHEMA_VERSION/
  )
  assert.match(pluginThemeContribution, /findUnsupportedThemeModeIds/)
  assert.match(pluginThemeRuntime, /structured\?\.schemaVersion === 3/)
  assert.match(pluginThemeRuntime, /resolveThemeModes/)
  assert.match(themeStore, /resolvePluginThemeRuntimeContract/)
  assert.match(themeStore, /themeShellLayoutToCssVariables/)
  assert.match(app, /class="app-shell"/)
  assert.match(app, /grid-template-areas: var\(--te-shell-template-areas\)/)
  assert.match(studioEditor, /profile\.modes = normalizeThemeModes/)
  assert.match(studioSurfaces, /selectedPluginTheme\?\.compatibilityNotes/)
  assert.equal(pluginThemeContract.pluginApiVersion, 3)
  assert.equal(pluginThemeContract.structuredThemeSchemaVersion, 3)
  assert.deepEqual(
    pluginThemeContract.tokens.map(({ id }) => id),
    THEME_TOKEN_DEFINITIONS.map(({ id }) => id)
  )
  assert.deepEqual(
    pluginThemeContract.modes.map(({ id }) => id),
    THEME_MODE_DEFINITIONS.map(({ id }) => id)
  )
  assert.deepEqual(pluginThemeContract.visibility, THEME_VISIBILITY_SLOT_IDS)
  assert.deepEqual(pluginThemeContract.layout.slots, [
    'titleBar',
    'navigation',
    'content',
    'playerBar'
  ])
  assert.deepEqual(pluginThemeContract.layout.tracks, [
    'auto',
    'content',
    'narrow',
    'standard',
    'wide',
    'fill',
    'double'
  ])
  assert.deepEqual(pluginThemeContract.layout.requiredSlots, ['titleBar', 'content'])
  assert.equal(pluginThemeContract.layout.compactBreakpointPx, 760)
})

test('preview and failed writes restore the persisted runtime without partially committing assets', () => {
  assert.ok(
    themeStore.indexOf('await assertProfileAssetsAvailable') <
      themeStore.indexOf('style.textContent')
  )
  assert.match(themeStore, /previewProfile\.value = null[\s\S]*previewSelection\.value = null/)
  assert.match(studioEditor, /onBeforeUnmount\([\s\S]*clearStudioPreview\(\)/)
})

test('applying and closing the studio cannot restore stale preview state over the active theme', () => {
  assert.match(
    themeStore,
    /const next = await window\.api\.themes\.setActive[\s\S]*snapshot\.value = next[\s\S]*previewProfile\.value = null[\s\S]*previewSelection\.value = null[\s\S]*await nextTick\(\)[\s\S]*await applyActiveTheme\(true\)/
  )
  assert.match(studioEditor, /if \(previewCleanup\) return previewCleanup/)
  assert.match(studioEditor, /function closeStudio\(\)[\s\S]*void clearStudioPreview\(\)/)
  assert.match(studioEditor, /onBeforeUnmount\([\s\S]*void clearStudioPreview\(\)/)
  assert.doesNotMatch(studioEditor, /document\.documentElement\.dataset\.theme = originalTone/)
})

test('theme archives export v2, accept v1 migration input, and reject unknown versions', () => {
  assert.match(themeArchive, /schemaVersion: THEME_ARCHIVE_SCHEMA_VERSION/)
  assert.match(themeArchive, /document\.schemaVersion !== 1/)
  assert.match(themeArchive, /不支持的主题包版本/)
})

test('disabled or uninstalled plugin themes fall back to the built-in selection', () => {
  assert.match(themeIpc, /export async function reconcileThemeAfterPluginChange/)
  assert.match(themeIpc, /setActiveTheme\(\{ kind: 'builtin', id: TWILIGHT_DEFAULT_THEME_ID \}/)
  assert.match(themeIpc, /let activeThemeChanged = false/)
  assert.match(themeIpc, /if \(activeThemeChanged\) await synchronizeThemeSettings\(snapshot\)/)
  assert.match(pluginIpc, /reconcileThemeAfterPluginChange\(\)/)
})

test('phase seven coalesces previews, records p95, and owns the full Electron matrix', () => {
  const updateDraft = studioEditor.match(/^  function updateDraft[\s\S]*?\n  \}/m)?.[0] ?? ''
  assert.match(updateDraft, /previewScheduler\.schedule\(next\)/)
  assert.doesNotMatch(updateDraft, /themeStore\.preview|saveProfile|window\.api/)
  assert.match(studioEditor, /await previewScheduler\.flush\(\)[\s\S]*themeStore\.saveProfile/)
  assert.match(studioEditor, /const toSave = cloneProfile\(draft\.value\)/)
  assert.match(themeStore, /JSON\.parse\(JSON\.stringify\(profile\)\) as ThemeProfileV2/)
  assert.match(studioSurfaces, /请先应用主题后再导出/)
  assert.match(studio, /:disabled="!draft \|\| isUnsavedDraft"/)
  assert.match(studioEditor, /function clearStudioPreview\(\)[\s\S]*previewScheduler\.cancel\(\)/)
  assert.match(previewScheduler, /window\.requestAnimationFrame/)
  assert.match(themePerformance, /preview: 32/)
  assert.match(themePerformance, /apply: 100/)
  assert.match(themeStore, /recordThemePerformance\(operation, startedAt\)/)
  assert.match(themeStore, /recordThemePerformance\('resource-decode', startedAt\)/)
  assert.match(visualRegression, /matrixCases: 90/)
  assert.match(visualRegression, /presetCases: 7/)
  assert.match(visualRegression, /maxMountedRows > 20/)
  assert.match(studioEditor, /studioSearchQuery/)
  assert.match(studioEditor, /filteredStudioHits/)
  assert.match(studioEditor, /visibleDefinitions/)
  assert.match(studio, /updateAppearanceMode\('effectsMode'/)
  assert.match(baseStyle, /data-te-effects-mode='reduced'/)
})
