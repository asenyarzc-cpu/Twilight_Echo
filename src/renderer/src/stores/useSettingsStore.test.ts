import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('background settings updates are applied optimistically and protected from stale snapshots', () => {
  const source = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')

  assert.match(source, /let settingsUpdateQueue: Promise<void> = Promise\.resolve\(\)/)
  assert.match(source, /let pendingSettingsUpdates = 0/)
  assert.match(source, /let settingsUpdateSequence = 0/)
  assert.match(source, /if \(pendingSettingsUpdates > 0\) return/)
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(patch, 'appBackground'\)/)
  assert.match(source, /applyDomSettings\(\)/)
  assert.match(
    source,
    /if \(sequence === settingsUpdateSequence\) \{\s*applySnapshot\(snapshot\)\s*\}/
  )
})

test('first-use appearance defaults to blue accents and desktop lyrics v3', () => {
  const rendererSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const mainSource = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const themeSource = readFileSync(new URL('./useThemeStore.ts', import.meta.url), 'utf8')
  const desktopLyricsSource = readFileSync(
    new URL('../../../shared/desktopLyrics.ts', import.meta.url),
    'utf8'
  )

  for (const source of [rendererSource, mainSource]) {
    assert.match(source, /lightAccentColor: 'blue'/)
    assert.match(source, /darkAccentColor: 'blue'/)
  }
  assert.match(themeSource, /let lightAccentColor = 'blue'/)
  assert.match(themeSource, /let darkAccentColor = 'blue'/)
  // Both layers read the one shared desktop lyrics default rather than carrying a copy.
  assert.match(rendererSource, /DEFAULT_DESKTOP_LYRICS_SETTINGS/)
  assert.match(
    mainSource,
    /DEFAULT_DESKTOP_LYRICS: DesktopLyricsSettings = DEFAULT_DESKTOP_LYRICS_SETTINGS/
  )
  assert.match(desktopLyricsSource, /windowWidth: 960/)
  assert.match(desktopLyricsSource, /windowHeight: 196/)
  assert.match(desktopLyricsSource, /translationVisible: false/)
})

test('settings chrome no longer dual-writes theme-owned CSS variables', () => {
  const source = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const themeSource = readFileSync(new URL('./useThemeStore.ts', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const songListSource = readFileSync(
    new URL('../components/song-list/SongList.css', import.meta.url),
    'utf8'
  )
  const localDashboardSource = readFileSync(
    new URL('../components/LocalDashboard.css', import.meta.url),
    'utf8'
  )
  const baseSource = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')

  assert.match(source, /THEME_OWNED_INLINE_STYLE_VARS/)
  assert.match(source, /clearLegacyThemeOwnedInlineStyles/)
  assert.match(source, /dataset\.themePreference/)
  assert.doesNotMatch(source, /setProperty\('--te-primary-500'/)
  assert.doesNotMatch(source, /setProperty\('--brand-500'/)
  assert.doesNotMatch(source, /setProperty\('--te-app-bg'/)
  assert.doesNotMatch(source, /function applyCardAppearance/)
  assert.doesNotMatch(source, /dataset\.theme = resolvedTheme/)
  assert.match(themeSource, /function applyAppBackgroundVariables/)
  assert.match(themeSource, /function syncThemeSettingsAppearance/)
  assert.match(
    themeSource,
    /variables\['--te-app-bg-image'\] = toBackgroundImageValue\(globalBackground\)/
  )
  assert.match(themeSource, /applyAppBackgroundVariables\(tone, variables\)/)
  assert.doesNotMatch(appSource, /body\s*\{\s*background:\s*transparent/)
  // The local background choice lands on the one window-wide body surface
  // (te-local-surface), never on the page boxes: a second cover-scaled copy on
  // a page would meet the sidebar edge as a visible seam.
  assert.match(
    baseSource,
    /body\.te-local-surface[\s\S]*?background-image:\s*var\(--te-local-bg-image\) !important/
  )
  assert.match(appSource, /classList\.toggle\('te-local-surface', !visible\)/)
  assert.doesNotMatch(songListSource, /var\(--te-local-bg-image\)/)
  assert.doesNotMatch(localDashboardSource, /var\(--te-local-bg-image\)/)
})

test('the global font setting reaches the theme runtime instead of dying in the store', () => {
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const themeSource = readFileSync(new URL('./useThemeStore.ts', import.meta.url), 'utf8')
  const mainSource = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const sharedSource = readFileSync(new URL('../../../shared/appFont.ts', import.meta.url), 'utf8')
  const appearanceSource = readFileSync(
    new URL('../components/settings-page/AppearanceSettingsSection.vue', import.meta.url),
    'utf8'
  )
  const optionsSource = readFileSync(
    new URL('../components/settings-page/types.ts', import.meta.url),
    'utf8'
  )

  // The setting is settings-owned but theme-applied: the theme runtime is the
  // sole writer of --te-font-*, and it emits the block with `!important`, so an
  // inline style in the settings store could never win. Writing it into the
  // runtime variables also lands the choice in the startup theme cache.
  assert.match(themeSource, /uiFontFamily = normalizeAppFontFamily\(settings\.fontFamily\)/)
  assert.match(themeSource, /Object\.assign\(variables, appFontCssVariables\(uiFontFamily\)\)/)
  assert.match(themeSource, /\| 'fontFamily'/)
  assert.match(storeSource, /syncThemeSettingsAppearance\(settings\.value\)/)
  assert.doesNotMatch(storeSource, /setProperty\('--te-font/)
  assert.match(storeSource, /'--te-font-sans',/)

  // Every layer normalizes through one contract, so a stored value that is not
  // a known family degrades to the theme font rather than reaching CSS raw.
  assert.match(sharedSource, /export function normalizeAppFontFamily/)
  assert.match(sharedSource, /export function appFontCssVariables/)
  assert.match(mainSource, /fontFamily: normalizeAppFontFamily\(settings\.fontFamily\)/)
  assert.match(appearanceSource, /normalizeAppFontFamily\(\(event\.target as HTMLSelectElement\)/)
  assert.match(optionsSource, /fontFamilyOptions: \{ value: AppFontFamily; label: string \}\[\]/)
  // "系统默认" promised a system stack while the value really means "leave the
  // theme alone"; the label has to say so or the option reads as broken.
  assert.match(optionsSource, /value: 'system', label: '默认（跟随主题）'/)
})

test('manual tone scheduling follows the app preference, not a stale DOM attribute', () => {
  const source = readFileSync(new URL('./useThemeStore.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function resolveRuntimeTone(')
  assert.ok(start >= 0, 'resolveRuntimeTone must exist in the theme store')
  const functionBody = source.slice(start, source.indexOf('\n}', start))

  assert.match(functionBody, /const scheduling = modes\.appearance\?\.toneScheduling \?\? 'manual'/)
  assert.match(functionBody, /if \(scheduling === 'system'\) return systemTone\.value/)
  assert.match(functionBody, /if \(scheduling === 'timed'\)/)
  // Manual presets must resolve from the stored preference. Reading the DOM
  // attribute lets a previous timed/system preset leak its tone into the next
  // manual preset (switching presets in dark mode would flip back to light).
  assert.match(functionBody, /return resolveThemeMode\(themePreference\)/)
  assert.doesNotMatch(functionBody, /return resolveTone\(\)/)
})

test('background image import accepts ArrayBuffer views from Electron IPC', () => {
  const source = readFileSync(
    new URL('../../../main/library/coverCache.ts', import.meta.url),
    'utf8'
  )
  const ipcSource = readFileSync(
    new URL('../../../main/ipc/settingsIpc.ts', import.meta.url),
    'utf8'
  )

  assert.match(
    source,
    /function normalizeBackgroundImageImportData\(data: unknown\): Buffer \| null/
  )
  assert.match(source, /if \(Buffer\.isBuffer\(data\)\) return data/)
  assert.match(source, /if \(data instanceof ArrayBuffer\) return Buffer\.from\(data\)/)
  assert.match(source, /if \(ArrayBuffer\.isView\(data\)\) \{/)
  assert.match(source, /Buffer\.from\(data\.buffer, data\.byteOffset, data\.byteLength\)/)
  assert.match(ipcSource, /const buffer = normalizeBackgroundImageImportData\(data\)/)
})

test('background protocol accepts chromium-normalized trailing slash urls', () => {
  const cacheSource = readFileSync(
    new URL('../../../main/library/coverCache.ts', import.meta.url),
    'utf8'
  )
  const lifecycleSource = readFileSync(
    new URL('../../../main/app/lifecycle.ts', import.meta.url),
    'utf8'
  )

  assert.ok(cacheSource.includes("const normalizedName = fileName.replace(/^\\/+|\\/+$/g, '')"))
  assert.ok(cacheSource.includes("const safeName = normalizedName.replace(/[^a-zA-Z0-9._-]/g, '')"))
  assert.ok(cacheSource.includes('safeName !== normalizedName'))
  assert.match(lifecycleSource, /protocol\.handle\('background'/)
  assert.match(lifecycleSource, /resolveBackgroundImageFile\(fileName\)/)
})

function readSettingsPageSources(): string {
  const root = new URL('../components/', import.meta.url)
  return [
    'SettingsPage.vue',
    'settings-page/types.ts',
    'settings-page/AboutSettingsSection.vue',
    'settings-page/ShortcutsSettingsSection.vue',
    'settings-page/MiniPlayerSettingsSection.vue',
    'settings-page/GeneralSettingsSection.vue',
    'settings-page/PlaybackSettingsSection.vue',
    'settings-page/DspSettingsSection.vue',
    'settings-page/PerformanceSettingsSection.vue',
    'settings-page/AppearanceSettingsSection.vue',
    'settings-page/ThemeControlsSettings.vue',
    'settings-page/BackgroundEditorSettings.vue',
    'settings-page/PlayerBarSettings.vue',
    'settings-page/PlayerBarLayoutSettings.vue',
    'settings-page/LiquidGlassSettings.vue',
    'settings-page/CardAppearanceSettings.vue'
  ]
    .map((relative) => readFileSync(new URL(relative, root), 'utf8'))
    .join('\n')
}

test('about settings expose local-only sponsor payment options and sponsor list', () => {
  const source = readSettingsPageSources()
  const gitignore = readFileSync(new URL('../../../../.gitignore', import.meta.url), 'utf8')

  assert.match(source, /const AFDIAN_URL = 'https:\/\/ifdian\.net\/a\/pxasen'/)
  assert.match(source, />\s*赞助作者\s*</)
  assert.match(source, />\s*赞助名单\s*</)
  assert.match(source, /请务必添加我的联系方式，我会将你加入软件的赞助者名单中，感谢你的支持！/)
  assert.match(source, /const ALIPAY_QR_URL = '\.\/sponsor\/alipay\.jpg'/)
  assert.match(source, /const WECHAT_QR_URL = '\.\/sponsor\/wechat\.png'/)
  assert.match(source, /name: '江枫Jiang1021'/)
  assert.match(source, /useEscapeToClose\(sponsorDialogOpen, closeSponsorDialog\)/)
  assert.match(source, /useFocusTrap\(sponsorDialogRef, sponsorDialogOpen\)/)
  assert.match(source, /const QQ_GROUP_QR_URL = '\.\/qq-group-qrcode\.jpg'/)
  assert.match(source, />\s*Q群\s*</)
  assert.match(source, /TwilightEcho 交流群/)
  assert.match(source, /群号：1093775290/)
  assert.match(source, /useEscapeToClose\(qqGroupDialogOpen, closeQqGroupDialog\)/)
  assert.match(source, /useFocusTrap\(qqGroupDialogRef, qqGroupDialogOpen\)/)
  assert.match(gitignore, /^resources\/sponsor\/alipay\.jpg$/m)
  assert.match(gitignore, /^resources\/sponsor\/wechat\.png$/m)
})

test('settings page quotes background image handles when building css url values', () => {
  const source = readSettingsPageSources()

  assert.match(source, /function toBackgroundImageStyle\(image: string\): string/)
  assert.ok(source.includes('return image ? `url("${image.replace(/"/g, \'\\\\"\')}")` : \'none\''))
  assert.match(source, /backgroundImage: toBackgroundImageStyle\(/)
})

test('settings page sends plain app background objects through Electron IPC', () => {
  const source = readSettingsPageSources()

  assert.match(source, /function cloneAppBackground\(\): AppBackgroundSettings/)
  assert.match(source, /global: \{ \.\.\.background\.global \}/)
  assert.match(source, /local: \{ \.\.\.background\.pages\.local \}/)
  assert.match(source, /settings: \{ \.\.\.background\.pages\.settings \}/)
  assert.match(source, /streaming: \{ \.\.\.background\.pages\.streaming \}/)
  assert.match(source, /player: \{ \.\.\.background\.pages\.player \}/)
  assert.doesNotMatch(source, /\.\.\.settings\.value\.appBackground/)
  assert.doesNotMatch(source, /\.\.\.settings\.value\.appBackground\.pages/)
})

test('startup home page setting is persisted and selectable from general settings', () => {
  const mainSettings = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const settingsTypes = readFileSync(
    new URL('../../../shared/appSettings.ts', import.meta.url),
    'utf8'
  )
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const settingsPageSource = readSettingsPageSources()

  assert.match(settingsTypes, /export type StartupHomePage = 'local' \| 'streaming'/)
  assert.match(settingsTypes, /startupHomePage: StartupHomePage/)
  assert.match(mainSettings, /startupHomePage: 'local'/)
  assert.match(mainSettings, /function normalizeStartupHomePage\(value: unknown\): StartupHomePage/)
  assert.match(
    mainSettings,
    /startupHomePage: normalizeStartupHomePage\(settings\.startupHomePage\)/
  )
  assert.match(storeSource, /startupHomePage: 'local'/)
  assert.match(appSource, /if \(loadedSettings\.startupHomePage === 'streaming'\) \{/)
  assert.match(settingsPageSource, /const startupHomePageOptions/)
  assert.match(
    settingsPageSource,
    /function setStartupHomePage\(startupHomePage: StartupHomePage\)/
  )
  assert.match(settingsPageSource, /启动后进入/)
  assert.match(settingsPageSource, /本地音乐主页/)
  assert.match(settingsPageSource, /流媒体主页/)
})

test('track activation mode is persisted across layers and applied to all track lists', () => {
  const mainSettings = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const preloadTypes = readFileSync(new URL('../../../preload/types.ts', import.meta.url), 'utf8')
  const sharedAppSettings = readFileSync(
    new URL('../../../shared/appSettings.ts', import.meta.url),
    'utf8'
  )
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const settingsPageSource = readSettingsPageSources()
  const songListSource = readFileSync(
    new URL('../components/SongList.vue', import.meta.url),
    'utf8'
  )
  const streamingPageSource = readFileSync(
    new URL('../components/StreamingPage.vue', import.meta.url),
    'utf8'
  )
  const streamingSearchSource = readFileSync(
    new URL('../components/StreamingSearch.vue', import.meta.url),
    'utf8'
  )
  const streamingDetailSource = readFileSync(
    new URL('../components/streaming-page/StreamingDetailStage.vue', import.meta.url),
    'utf8'
  )
  const streamingSocialSource = readFileSync(
    new URL('../components/streaming-page/StreamingSocialStage.vue', import.meta.url),
    'utf8'
  )
  const multiSelectSource = readFileSync(
    new URL('../components/song-list/useTrackMultiSelect.ts', import.meta.url),
    'utf8'
  )

  assert.match(
    sharedAppSettings,
    /export type TrackActivationMode = 'singleClick' \| 'doubleClick'/
  )
  assert.match(sharedAppSettings, /trackActivationMode: TrackActivationMode/)
  assert.match(preloadTypes, /TrackActivationMode/)
  assert.match(mainSettings, /trackActivationMode: 'singleClick'/)
  assert.match(
    mainSettings,
    /export function normalizeTrackActivationMode\(value: unknown\): TrackActivationMode \{\s*return value === 'doubleClick' \? 'doubleClick' : 'singleClick'\s*\}/
  )
  assert.match(
    mainSettings,
    /trackActivationMode: normalizeTrackActivationMode\(settings\.trackActivationMode\)/
  )
  assert.match(storeSource, /trackActivationMode: 'singleClick'/)
  assert.match(settingsPageSource, /trackActivationModeOptions/)
  assert.match(settingsPageSource, /单击播放/)
  assert.match(settingsPageSource, /双击播放/)
  assert.match(settingsPageSource, /歌曲列表播放方式/)
  assert.match(songListSource, /trackActivationMode === 'doubleClick'/)
  assert.match(songListSource, /@dblclick="onRowDblClick\(track, \$event\)"/)
  assert.match(streamingPageSource, /trackActivationMode === 'doubleClick'/)
  assert.ok(
    (streamingPageSource.match(/:track-activation-mode=/g) ?? []).length >= 3,
    'search, detail, and social streaming track lists must receive the setting'
  )
  for (const source of [streamingSearchSource, streamingDetailSource, streamingSocialSource]) {
    assert.match(source, /trackActivationMode/)
    assert.match(source, /@dblclick/)
  }
  assert.doesNotMatch(multiSelectSource, /ensureContextSelection/)
  assert.doesNotMatch(songListSource, /ensureContextSelection/)
  assert.doesNotMatch(streamingPageSource, /ensureContextSelection/)
  assert.match(songListSource, /function onTrackContextMenu\([\s\S]*?onContextMenu\(event, track\)/)
  assert.match(
    streamingPageSource,
    /function onStreamingTrackContextMenu\([\s\S]*?streamingContextMenuTrack\.value = track/
  )
})

test('genre separators persist across settings layers and refresh derived library groups', () => {
  const mainSettings = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const sharedAppSettings = readFileSync(
    new URL('../../../shared/appSettings.ts', import.meta.url),
    'utf8'
  )
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const settingsPageSource = readSettingsPageSources()
  const songListSource = readFileSync(
    new URL('../components/SongList.vue', import.meta.url),
    'utf8'
  )

  assert.match(sharedAppSettings, /genreSeparators: string/)
  assert.match(mainSettings, /genreSeparators: DEFAULT_GENRE_SEPARATORS/)
  assert.match(
    mainSettings,
    /genreSeparators: normalizeGenreSeparators\(settings\.genreSeparators\)/
  )
  assert.match(storeSource, /genreSeparators: DEFAULT_GENRE_SEPARATORS/)
  assert.match(
    settingsPageSource,
    /async function setGenreSeparators\(event: Event\): Promise<void>/
  )
  assert.match(settingsPageSource, /updateSettings\(\{ genreSeparators: value \}\)/)
  assert.match(settingsPageSource, /aria-label="流派分隔符"/)
  assert.match(settingsPageSource, /@change="setGenreSeparators"/)
  assert.match(songListSource, /settingsStore\.settings\.value\.genreSeparators/)
  assert.match(songListSource, /\(\) => refreshLibraryIndex\(\)/)
})

test('audio settings expose advanced replaygain, fft, crossfeed, and real loudnorm option', () => {
  const settingsTypes =
    readFileSync(new URL('../../../shared/audioEngineTypes.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('../../../shared/audioProcessingOptions.ts', import.meta.url), 'utf8')
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const settingsPageSource = readSettingsPageSources()
  const hifiSidebarSource = readFileSync(
    new URL('../components/player-bar/HiFiSidebar.vue', import.meta.url),
    'utf8'
  )

  assert.match(settingsTypes, /crossfeedDelayMs: number/)
  assert.match(settingsTypes, /crossfeedCutoffHz: number/)
  assert.match(settingsTypes, /'loudnorm'/)
  assert.match(storeSource, /crossfeedDelayMs: 0\.35/)
  assert.match(storeSource, /crossfeedCutoffHz: 700/)
  assert.match(settingsPageSource, /function setReplayGainFallback\(event: Event\): void/)
  assert.match(settingsPageSource, /function toggleReplayGainClip\(\): void/)
  assert.match(settingsPageSource, /function toggleFftEnabled\(\): void/)
  assert.match(settingsPageSource, /function setCrossfeedDelay\(event: Event\): void/)
  assert.match(settingsPageSource, /function setCrossfeedCutoff\(event: Event\): void/)
  assert.match(settingsPageSource, /Fallback Gain/)
  assert.match(settingsPageSource, /ReplayGain Clip/)
  assert.match(settingsPageSource, /FFT Capture/)
  assert.match(settingsPageSource, /Crossfeed Delay/)
  assert.match(settingsPageSource, /Crossfeed Cutoff/)
  assert.match(
    settingsPageSource,
    /VOLUME_NORMALIZATION_OPTIONS|replayGainOptions = VOLUME_NORMALIZATION_OPTIONS/
  )
  assert.match(settingsPageSource, /replayGainOptions/)
  assert.match(hifiSidebarSource, /VOLUME_NORMALIZATION_OPTIONS|value: 'loudnorm'/)
  assert.match(settingsPageSource, /High-Res 当前为自动链路能力/)
  assert.match(settingsPageSource, /function capabilityStateLabel/)
  assert.ok(
    settingsPageSource.includes(
      `v-if="normalizeCapabilityState(device.dopSupportState) !== 'unsupported'"`
    )
  )
  assert.ok(
    /v-if="\s*normalizeCapabilityState\(device\.nativeDsdSupportState\) !== 'unsupported'\s*"/.test(
      settingsPageSource
    )
  )
  assert.match(settingsPageSource, /DoP \{\{ capabilityStateLabel\(device\.dopSupportState\) \}\}/)
  assert.match(
    settingsPageSource,
    /Native DSD \{\{ capabilityStateLabel\(device\.nativeDsdSupportState\) \}\}/
  )
})

test('audio settings do not expose DSP bypass as strict bit-perfect mode', () => {
  const settingsTypes = readFileSync(new URL('../types/settings.ts', import.meta.url), 'utf8')
  const preloadTypes = readFileSync(new URL('../../../preload/types.ts', import.meta.url), 'utf8')
  const mainTypes = readFileSync(new URL('../../../main/core/types.ts', import.meta.url), 'utf8')
  const mainSettings = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const settingsStoreSource = readFileSync(
    new URL('./useSettingsStore.ts', import.meta.url),
    'utf8'
  )
  const settingsPageSource = readSettingsPageSources()

  for (const source of [
    settingsTypes,
    preloadTypes,
    mainTypes,
    mainSettings,
    settingsStoreSource
  ]) {
    assert.doesNotMatch(source, /strictBitPerfectMode/)
  }
  assert.doesNotMatch(settingsPageSource, /function toggleStrictBitPerfectMode\(\): void/)
  assert.doesNotMatch(settingsPageSource, /updateSettings\(\{ strictBitPerfectMode: next \}\)/)
  assert.doesNotMatch(settingsPageSource, /严格 Bit-Perfect/)
  assert.match(settingsPageSource, /DSP 旁路 \(DSP Bypass\)/)
})

test('cache strategy settings expose separate artifact and provider-controlled audio policies', () => {
  const mainSettings = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const preloadTypes = readFileSync(new URL('../../../preload/types.ts', import.meta.url), 'utf8')
  const pluginIpcSource = readFileSync(
    new URL('../../../main/ipc/plugins.ts', import.meta.url),
    'utf8'
  )
  const settingsPageSource = readSettingsPageSources()

  const sharedAppSettings = readFileSync(
    new URL('../../../shared/appSettings.ts', import.meta.url),
    'utf8'
  )

  assert.match(sharedAppSettings, /export type StreamingAudioCachePolicy = 'off' \| 'provider'/)
  assert.match(sharedAppSettings, /export interface MusicCachePolicySettings \{/)
  assert.match(sharedAppSettings, /cover: boolean/)
  assert.match(sharedAppSettings, /lyrics: boolean/)
  assert.match(sharedAppSettings, /metadata: boolean/)
  assert.match(sharedAppSettings, /streamingAudio: StreamingAudioCachePolicy/)
  assert.match(sharedAppSettings, /cachePolicy: MusicCachePolicySettings/)
  assert.match(sharedAppSettings, /autoAnalyzeBpm: boolean/)
  assert.match(preloadTypes, /StreamingAudioCachePolicy/)
  assert.match(preloadTypes, /MusicCachePolicySettings/)

  assert.match(
    mainSettings,
    /export const DEFAULT_MUSIC_CACHE_POLICY: MusicCachePolicySettings = \{/
  )
  assert.match(mainSettings, /cover: true/)
  assert.match(mainSettings, /lyrics: true/)
  assert.match(mainSettings, /metadata: true/)
  assert.match(mainSettings, /streamingAudio: 'provider'/)
  assert.match(mainSettings, /autoAnalyzeBpm: true/)
  assert.match(
    mainSettings,
    /function normalizeMusicCachePolicy\(raw: unknown\): MusicCachePolicySettings/
  )
  assert.match(mainSettings, /cover: value\.cover !== false/)
  assert.match(mainSettings, /lyrics: value\.lyrics !== false/)
  assert.match(mainSettings, /metadata: value\.metadata !== false/)
  assert.match(mainSettings, /return value === 'off' \? 'off' : 'provider'/)
  assert.match(mainSettings, /cachePolicy: normalizeMusicCachePolicy\(settings\.cachePolicy\)/)
  assert.match(mainSettings, /autoAnalyzeBpm: settings\.autoAnalyzeBpm !== false/)
  assert.match(storeSource, /cachePolicy: \{/)
  assert.match(storeSource, /autoAnalyzeBpm: true/)
  assert.match(storeSource, /formattedBpmAnalysisCacheSize/)
  assert.match(storeSource, /window\.api\.bpmAnalysis\.getCacheSize\(\)/)
  assert.match(storeSource, /window\.api\.bpmAnalysis\.clearCache\(\)/)
  assert.match(storeSource, /window\.api\.loudnessAnalysis\.getCacheSize\(\)/)
  assert.match(storeSource, /window\.api\.loudnessAnalysis\.clearCache\(\)/)
  assert.match(storeSource, /formattedLoudnessAnalysisCacheSize/)
  assert.match(
    readFileSync(new URL('./useMusicStore.ts', import.meta.url), 'utf8'),
    /function clearBpmAnalysis\(\): boolean/
  )
  assert.match(
    settingsPageSource,
    /function toggleCacheArtifact\(key: keyof MusicCachePolicySettings\): void/
  )
  assert.match(settingsPageSource, /function setStreamingAudioCachePolicy\(event: Event\): void/)
  assert.match(settingsPageSource, /function toggleAutoAnalyzeBpm\(\): void/)
  assert.match(settingsPageSource, /function confirmClearBpmAnalysisCache\(\): Promise<void>/)
  assert.match(settingsPageSource, /function confirmClearLoudnessAnalysisCache\(\): Promise<void>/)
  assert.match(settingsPageSource, /clearBpmAnalysisFromPlaybackState\(\)/)
  assert.match(settingsPageSource, /封面缓存/)
  assert.match(settingsPageSource, /歌词缓存/)
  assert.match(settingsPageSource, /元数据缓存/)
  assert.match(settingsPageSource, /流媒体音频缓存/)
  assert.match(settingsPageSource, /BPM 自动分析/)
  assert.match(settingsPageSource, /BPM 分析缓存/)
  assert.match(settingsPageSource, /Loudnorm \/ 响度分析缓存/)
  assert.match(settingsPageSource, /由 Provider 规则控制/)
  assert.match(pluginIpcSource, /runtime\.appSettings\.cachePolicy\.streamingAudio !== 'provider'/)
  assert.match(pluginIpcSource, /return null/)
})

test('settings page exposes search, backup, cache confirmation, and isolated plugin panel state', () => {
  const settingsPageSource = readSettingsPageSources()

  assert.match(settingsPageSource, /const settingsSearchQuery = ref\(''\)/)
  assert.match(settingsPageSource, /const filteredSearchResults = computed/)
  assert.match(settingsPageSource, /function scrollToSearchResult/)
  assert.match(settingsPageSource, /function confirmClearCache/)
  assert.match(settingsPageSource, /确认清理缓存/)
  assert.match(settingsPageSource, /function exportSettingsBackup/)
  assert.match(settingsPageSource, /function importSettingsBackup/)
  assert.match(settingsPageSource, /function resetSettingsGroup/)
  assert.match(settingsPageSource, /function pluginPanelStateKey/)
  assert.match(settingsPageSource, /pluginSettingsResult\[pluginPanelStateKey\(panel\)\]/)
  assert.match(settingsPageSource, /High-Res 当前为自动链路能力/)
  assert.doesNotMatch(
    settingsPageSource,
    /aria-checked="false"[\s\S]{0,160}当前版本暂未接入原生处理链/
  )
})

test('settings backup and shortcut status APIs are exposed to the renderer', () => {
  const preloadSource = readFileSync(new URL('../../../preload/index.ts', import.meta.url), 'utf8')
  const settingsApiSource = readFileSync(
    new URL('../../../preload/domains/settingsApi.ts', import.meta.url),
    'utf8'
  )
  const preloadTypes = readFileSync(new URL('../../../preload/types.ts', import.meta.url), 'utf8')
  const preloadDts = readFileSync(new URL('../../../preload/index.d.ts', import.meta.url), 'utf8')
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')

  for (const source of [preloadTypes, preloadDts]) {
    assert.match(source, /interface PlayerShortcutStatus \{/)
    assert.match(source, /registered: boolean/)
    assert.match(source, /error: string \| null/)
  }

  assert.match(settingsApiSource, /exportBackup: \(\): Promise<string>/)
  assert.match(settingsApiSource, /importBackup: \(json: string\): Promise<SettingsSnapshot>/)
  assert.match(settingsApiSource, /getShortcutStatuses: \(\): Promise<PlayerShortcutStatus\[]>/)
  assert.match(settingsApiSource, /JSON\.parse\(JSON\.stringify\(patch\)\)/)
  assert.match(preloadSource, /import \{ bindSettingsIpcEvents, settingsApi \}/)
  assert.match(preloadSource, /data: dataApi/)
  assert.match(preloadSource, /settings: settingsApi/)
  assert.match(preloadSource, /themes: themesApi/)
  assert.doesNotMatch(preloadSource, /\.\.\.dataApi/)
  assert.doesNotMatch(preloadSource, /\.\.\.settingsApi/)
  assert.doesNotMatch(preloadSource, /\.\.\.themesApi/)
  assert.match(storeSource, /exportSettingsBackup: \(\) => Promise<string>/)
  assert.match(storeSource, /importSettingsBackup: \(json: string\) => Promise<AppSettings>/)
  assert.match(storeSource, /getShortcutStatuses: \(\) => Promise<PlayerShortcutStatus\[]>/)
})

test('window transparency is gated on native support (Wayland fallback to opaque)', () => {
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const mainSettings = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const mainTypes = readFileSync(new URL('../../../main/core/types.ts', import.meta.url), 'utf8')
  const rendererTypes = readFileSync(new URL('../types/settings.ts', import.meta.url), 'utf8')
  const baseCss = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')

  // Main process must expose a Wayland-aware support check and snapshot field.
  assert.match(mainSettings, /export function supportsNativeWindowTransparency\(\)/)
  assert.match(mainSettings, /WAYLAND_DISPLAY/)
  assert.match(mainSettings, /XDG_SESSION_TYPE'\] === 'wayland'/)
  assert.match(mainSettings, /windowTransparencySupported: supportsNativeWindowTransparency\(\)/)
  for (const types of [mainTypes, rendererTypes]) {
    assert.match(types, /windowTransparencySupported: boolean/)
  }

  // Renderer must not enable translucent styling when the platform cannot
  // present transparent pixels (otherwise the whole app disappears).
  assert.match(storeSource, /dataset\.windowTransparent = transparencyActive \? 'on' : 'off'/)
  assert.match(
    storeSource,
    /settings\.value\.windowTransparency === true && windowTransparencySupported\.value === true/
  )
  assert.match(storeSource, /dataset\.platform = platform\.value \|\| 'unknown'/)

  // Linux must skip in-app backdrop-filter blur: transparent Linux windows
  // cannot sample the desktop, and per-frame backdrop blur is the lag source.
  assert.match(baseCss, /data-window-transparent='on']:not\(\[data-platform='linux'\]\)/)
  assert.match(baseCss, /--te-tp-base-alpha/)
})

test('settings page warns and disables transparency controls on unsupported platforms', () => {
  const source = readSettingsPageSources()

  assert.match(source, /const transparencyUnsupported = computed/)
  assert.match(source, /windowTransparencySupported\.value === false/)
  // Prettier wraps this string in the template, so the assertion has to tolerate
  // a line break where the source happens to fold it.
  assert.match(source, /当前系统不支持透明窗口（Linux Wayland，或 Windows\s+未开启系统透明效果）/)
  assert.match(source, /toggleSetting\('windowTransparency'\)/)
  assert.match(source, /aria-disabled="!transparencySupported"/)
})

test('playbar shape persists across settings layers and flips without an IPC round trip', () => {
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const mainSource = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )

  // Main and renderer must start from the same normalized shape, or the first
  // frame after launch renders a different bar than the one that gets persisted.
  for (const source of [storeSource, mainSource]) {
    assert.match(source, /playerBar: clonePlayerBarSettings\(DEFAULT_PLAYER_BAR_SETTINGS\)/)
    assert.match(source, /from '(?:\.\.\/)+shared\/playerBar\.ts'/)
  }
  assert.match(mainSource, /playerBar: normalizePlayerBarSettings\(settings\.playerBar\)/)

  // The optimistic branch: the shape has to change on the click frame, and the
  // patch still goes through normalization so a bad value cannot reach the DOM.
  assert.match(storeSource, /Object\.prototype\.hasOwnProperty\.call\(patch, 'playerBar'\)/)
  assert.match(storeSource, /playerBar: normalizePlayerBarSettings\(patch\.playerBar\)/)

  assert.match(
    readFileSync(new URL('../../../shared/appSettings.ts', import.meta.url), 'utf8'),
    /playerBar: PlayerBarSettings/
  )
})

/**
 * `settings` is a deep `ref`, so anything nested read off `settings.value` comes
 * back as a reactive Proxy, and the standard patch idiom
 * `{ ...settings.value.playerBar, mode }` hands the nested `layout` over by
 * reference — still a Proxy. `window.api` is a contextBridge surface
 * (`sandbox: true` + `contextIsolation: true`), so arguments are structurally
 * cloned at the boundary itself and a Proxy fails with "An object could not be
 * cloned" before any preload code runs — the JSON round trip inside
 * `settingsApi.update` sits on the far side and cannot help. Patches carrying
 * only primitives were safe by accident; `playerBar.layout` was the first
 * nested one, and saving any playbar setting threw. Detaching at the store's
 * single exit means the next nested setting cannot reintroduce it.
 */
test('settings patches are detached from Vue reactivity before crossing the IPC bridge', () => {
  const storeSource = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')

  assert.match(
    storeSource,
    /function toWirePatch\(patch: Partial<AppSettings>\): Partial<AppSettings>/
  )
  assert.match(storeSource, /window\.api\.settings\.update\(toWirePatch\(patch\)\)/)
  // Every path out of the store must go through it — a raw patch must not remain.
  assert.doesNotMatch(storeSource, /window\.api\.settings\.update\(patch\)/)
})

test('playbar settings UI exposes shape and visibility as independent dimensions', () => {
  const source = readSettingsPageSources()

  assert.match(source, /playerBarModeOptions/)
  assert.match(source, /playerBarPageModeOptions/)
  assert.match(source, /setPlayerBarMode\(option\.value\)/)
  assert.match(source, /setPlayerBarPlayingPageMode\(/)

  // Visibility is its own three-step control, with a playing-page override that
  // mirrors the shape override rather than being folded into it.
  assert.match(source, /playerBarVisibilityOptions/)
  assert.match(source, /playerBarPageVisibilityOptions/)
  assert.match(source, /setPlayerBarVisibility\(option\.value\)/)
  assert.match(source, /setPlayerBarPlayingPageVisibility\(/)
  // The page override must round-trip through the shared normalizer, so a stale
  // stored value cannot reach the settings patch. The same goes for the shape.
  assert.match(source, /normalizePlayerBarPageVisibility\(value\)/)
  assert.match(source, /normalizePlayerBarPageMode\(value\)/)

  // Auto-hide needs a shape with its own progress readout (mini's rail, compact's
  // top edge), so that one step is marked unavailable per scope instead of being
  // silently ineffective — and the precondition comes from the shared policy.
  assert.match(source, /playerBarShapeCanAutoHide\(settings\.value\.playerBar\.mode\)/)
  assert.match(
    source,
    /playerBarShapeCanAutoHide\(\s*bar\.playingPageMode === 'inherit' \? bar\.mode : bar\.playingPageMode\s*\)/
  )
  assert.match(source, /function visibilityOptionDisabled/)
  assert.match(source, /function pageVisibilityOptionDisabled/)
  assert.match(source, /:disabled="visibilityOptionDisabled\(option\.value\)"/)
  assert.match(source, /:disabled="pageVisibilityOptionDisabled\(option\.value\)"/)

  // The reveal sliders are gated on auto-hide being reachable in either scope,
  // and the gate asks the shared policy rather than re-deriving the rules.
  assert.match(source, /playerBarAutoHideApplies\(bar, \{ onPlayingPage: false \}\)/)
  assert.match(source, /playerBarAutoHideApplies\(bar, \{ onPlayingPage: true \}\)/)
  assert.match(source, /v-if="autoHideAppliesAnywhere"/)
  // Sliders must be bounded by the shared contract, not by hand-typed numbers.
  assert.match(source, /:min="PLAYER_BAR_BOUNDS\.revealThresholdPx\.min"/)
  assert.match(source, /:max="PLAYER_BAR_BOUNDS\.revealThresholdPx\.max"/)
  assert.match(source, /setPlayerBarNumber\('revealThresholdPx',/)
  assert.match(source, /setPlayerBarNumber\('hideDelayMs',/)
  // Appearance reset has to drop the playbar back to the shared default too.
  assert.match(source, /playerBar: clonePlayerBarSettings\(DEFAULT_PLAYER_BAR_SETTINGS\)/)
  // The removed legacy toggle must not linger anywhere in the settings sources.
  assert.doesNotMatch(source, /togglePlayerBarAutoHide/)
  assert.doesNotMatch(source, /autoHideOnPlayingPage/)
})

test('playbar control placement is editable per shape and written through the normalizer', () => {
  const source = readSettingsPageSources()

  // Which shape's arrangement is being edited is a local choice in the editor —
  // it must never write `mode`, or opening the panel would switch the live shape.
  assert.match(
    source,
    /const editingShape = ref<PlayerBarMode>\(settings\.value\.playerBar\.mode\)/
  )
  assert.match(source, /@click="editingShape = option\.value"/)
  // Three regions, from the shared region list rather than hand-written names.
  assert.match(source, /v-for="region in playerBarRegionOptions"/)
  assert.match(source, /playerBarControlOptions/)
  // Reorder, remove and place, all keyboard-reachable buttons plus one select.
  assert.match(source, /moveControl\(region\.value, index, -1\)/)
  assert.match(source, /moveControl\(region\.value, index, 1\)/)
  assert.match(source, /removeControl\(region\.value, index\)/)
  assert.match(
    source,
    /placeControl\(region\.value, \(\$event\.target as HTMLSelectElement\)\.value\)/
  )
  // Placing a control lifts it out of every other region, so the same button can
  // never end up in two places and the dedupe order never has to be relied on.
  assert.match(
    source,
    /next\[name\.value\] = next\[name\.value\]\.filter\(\(item\) => item !== id\)/
  )
  // Every write goes through the shared normalizer and the deep clone, so a
  // layout missing its play control is repaired before it reaches the bar, and
  // the region arrays are never shared with the previous settings object.
  assert.match(source, /layout: normalizePlayerBarLayout\(layout\)/)
  assert.match(source, /clonePlayerBarLayout\(settings\.value\.playerBar\.layout\)/)
  // Reset is per shape, and disabled once this shape already matches the default.
  assert.match(source, /DEFAULT_PLAYER_BAR_LAYOUT\[editingShape\.value\]/)
  assert.match(source, /:disabled="shapeIsDefault"/)
})

test('the download directory setting stays authorized from the picker to the download manager', () => {
  const sharedSettings = readFileSync(
    new URL('../../../shared/appSettings.ts', import.meta.url),
    'utf8'
  )
  const mainSettings = readFileSync(
    new URL('../../../main/core/settings.ts', import.meta.url),
    'utf8'
  )
  const localPaths = readFileSync(
    new URL('../../../main/security/localPaths.ts', import.meta.url),
    'utf8'
  )
  const settingsIpc = readFileSync(
    new URL('../../../main/ipc/settingsIpc.ts', import.meta.url),
    'utf8'
  )
  const pluginIpc = readFileSync(new URL('../../../main/ipc/plugins.ts', import.meta.url), 'utf8')
  const downloadManager = readFileSync(
    new URL('../../../main/plugins/providerDownloadManager.ts', import.meta.url),
    'utf8'
  )
  const preload = readFileSync(
    new URL('../../../preload/domains/settingsApi.ts', import.meta.url),
    'utf8'
  )
  const store = readFileSync(new URL('./useSettingsStore.ts', import.meta.url), 'utf8')
  const generalSection = readFileSync(
    new URL('../components/settings-page/GeneralSettingsSection.vue', import.meta.url),
    'utf8'
  )

  // An empty value keeps the historical behaviour: downloads land in the library.
  assert.match(sharedSettings, /downloadFolder: string/)
  assert.match(mainSettings, /downloadFolder: '',/)
  assert.match(
    mainSettings,
    /downloadFolder:\s*\r?\n\s*typeof settings\.downloadFolder === 'string'/
  )

  // Only a directory the user picked through the dialog may be persisted, and the
  // renderer's persisted copy is re-checked instead of trusted.
  assert.match(localPaths, /export async function grantUserSelectedDownloadRoot/)
  assert.match(localPaths, /downloadRootGrants\.grantRoot\(folder\)/)
  assert.match(localPaths, /throw new Error\('下载目录未经用户授权'\)/)
  assert.match(localPaths, /downloadRootGrants\.isCanonicalWithinRoots\(canonicalPath\)/)
  assert.match(settingsIpc, /hasOwnProperty\.call\(patch, 'downloadFolder'\)/)
  assert.match(settingsIpc, /resolveAuthorizedDownloadRootSetting\(/)
  assert.match(settingsIpc, /ipcMain\.handle\('settings:chooseDownloadFolder'/)
  assert.match(settingsIpc, /grantUserSelectedDownloadRoot\(result\.filePaths\[0\]\)/)

  // The download manager takes the configured directory first, then the library.
  assert.match(
    pluginIpc,
    /resolveDownloadRoot: \(\) =>\s*\r?\n?\s*resolveConfiguredDownloadRoot\(runtime\.appSettings\.downloadFolder\)/
  )
  assert.match(downloadManager, /selectDownloadTargetRoot\(requested, orderDownloadRoots\(/)
  // Files that land outside the library must not be pushed into the library index.
  assert.match(downloadManager, /if \(await this\.isInsideAuthorizedLibrary\(targetPath\)\)/)

  // Persisting tolerates a directory that is momentarily offline so a settings
  // restore cannot fail on it, while writing files demands a live grant.
  assert.match(
    localPaths,
    /resolveAuthorizedDownloadRootSetting[\s\S]*?resolveDeclaredExactPath\(declaredDownloadRoots, folder\)/
  )
  assert.match(
    localPaths,
    /export async function resolveConfiguredDownloadRoot[\s\S]*?return await resolveGrantedDownloadRoot\(folder\)/
  )

  assert.match(preload, /chooseDownloadFolder: \(\): Promise<string \| null> =>/)
  assert.match(store, /async function chooseDownloadFolder\(\)/)
  assert.match(store, /async function resetDownloadFolder\(\)/)
  assert.match(store, /updateSettings\(\{ downloadFolder: '' \}\)/)
  assert.match(generalSection, /chooseDownloadFolder: \(\) => void/)
  assert.match(generalSection, /settings\.downloadFolder \|\| '跟随扫描文件夹'/)
})
