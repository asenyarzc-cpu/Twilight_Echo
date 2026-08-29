import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const styles = readFileSync(new URL('./settings-page/SettingsPage.css', import.meta.url), 'utf8')
const baseStyles = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')
const pageSource = readFileSync(new URL('./SettingsPage.vue', import.meta.url), 'utf8')
const playbackPageSource = readFileSync(
  new URL('./settings-page/PlaybackSettingsSection.vue', import.meta.url),
  'utf8'
)
const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const titleBarSource = readFileSync(new URL('./TitleBar.vue', import.meta.url), 'utf8')
const liquidGlassSettingsSource = readFileSync(
  new URL('./settings-page/LiquidGlassSettings.vue', import.meta.url),
  'utf8'
)
const desktopLyricsSettingsSource = readFileSync(
  new URL('./settings-page/DesktopLyricsSettingsSection.vue', import.meta.url),
  'utf8'
)

test('desktop lyrics is a navigable settings card', () => {
  assert.match(
    desktopLyricsSettingsSource,
    /<section\s+id="desktopLyrics"\s+class="glass-card preview-section settings-section">/
  )
  for (const label of [
    '启用桌面歌词',
    '启用歌词总在最前',
    '外文歌词显示翻译',
    '外文歌词显示音译',
    '描边',
    '双行显示',
    '横排显示',
    '居中',
    '落日晖',
    '已播放',
    '未播放'
  ]) {
    assert.match(desktopLyricsSettingsSource, new RegExp(label))
  }
  assert.match(
    desktopLyricsSettingsSource,
    /let pendingPatch: Partial<DesktopLyricsSettings> = \{\}/
  )
  assert.match(desktopLyricsSettingsSource, /Object\.assign\(pendingPatch, patch\)/)
  assert.match(desktopLyricsSettingsSource, /function flushPendingPatch\(\): void/)
})

test('vertical desktop lyric previews use a compact content-sized board', () => {
  assert.match(
    desktopLyricsSettingsSource,
    /\.lyrics-preview\.is-vertical \{[\s\S]*?width: fit-content;[\s\S]*?min-height: 0;[\s\S]*?grid-template-columns: repeat\(2, max-content\);[\s\S]*?gap: min\(var\(--preview-gap\), 10px\);/
  )
  assert.match(
    desktopLyricsSettingsSource,
    /\.lyrics-preview\.is-single\.is-vertical \{\s*grid-template-columns: max-content;/
  )
  assert.match(
    desktopLyricsSettingsSource,
    /\.lyrics-preview\.is-vertical \.preview-line span \{\s*max-inline-size: 360px;/
  )
})

test('settings option bars define dark-mode container and active option surfaces', () => {
  assert.match(
    styles,
    /html\[data-theme='dark'\] \.segmented-control,[\s\S]*?background:\s*var\(--te-subtle-bg\)/
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\] \.segmented-control button\.active,[\s\S]*?background:\s*var\(--te-card-bg\)/
  )
})

test('liquid glass settings navigation has its own readable surface layer', () => {
  assert.match(
    styles,
    /\[data-te-settings-navigation-liquid-glass='on'\][\s\S]{0,160}\.settings-preview-nav\s*\{[\s\S]*?isolation:\s*isolate[\s\S]*?background:\s*transparent/
  )
  assert.match(
    styles,
    /\[data-te-settings-navigation-liquid-glass='on'\][\s\S]{0,240}\.settings-preview-nav::after\s*\{[\s\S]*?backdrop-filter:\s*blur\(var\(--te-lg-blur, 16px\)\)\s*saturate\(var\(--te-lg-saturate, 140%\)\)/
  )
  assert.match(
    styles,
    /\[data-te-settings-navigation-liquid-glass='on'\][\s\S]{0,280}\.settings-preview-nav\s+\.preview-nav-item\s*\{[\s\S]*?color:\s*var\(--te-lg-context-label\)/
  )
})

test('liquid glass settings expose unified and independent targets', () => {
  assert.match(liquidGlassSettingsSource, /全局液态玻璃/)
  assert.match(liquidGlassSettingsSource, /主导航液态玻璃/)
  assert.match(liquidGlassSettingsSource, /播放栏液态玻璃/)
  assert.match(liquidGlassSettingsSource, /设置导航液态玻璃/)
  assert.match(liquidGlassSettingsSource, /首页媒体焦点液态玻璃/)
  assert.match(liquidGlassSettingsSource, /navigationEnabled/)
  assert.match(liquidGlassSettingsSource, /playbarEnabled/)
  assert.match(liquidGlassSettingsSource, /settingsNavigationEnabled/)
  assert.match(liquidGlassSettingsSource, /activeLiquidGlassTheme/)
  assert.match(liquidGlassSettingsSource, /恢复默认参数/)
  assert.match(liquidGlassSettingsSource, /function resetLiquidGlassParameters\(\)/)
  assert.match(liquidGlassSettingsSource, /DEFAULT_LIQUID_GLASS\.light/)
  assert.match(liquidGlassSettingsSource, /navigationEnabled: current\.navigationEnabled/)
})

test('dark settings folder controls and switches avoid light fixed-color surfaces', () => {
  assert.match(
    pageSource,
    /html\[data-theme='dark'\] \.settings-preview-page \.dashed-button,[\s\S]*?html\[data-theme='dark'\] \.settings-preview-page \.folder-empty-hint\s*\{[\s\S]*?background:\s*var\(--te-card-bg\)/
  )
  assert.match(
    baseStyles,
    /html\[data-theme='dark'\] \.settings-preview-layout \.toggle-switch\.inactive\s*\{[\s\S]*?background:\s*var\(--te-subtle-bg\)/
  )
})

test('native checkboxes inherit the active dark color scheme and theme accent', () => {
  assert.match(
    baseStyles,
    /input\[type='checkbox'\][\s\S]*?accent-color:\s*var\(--te-primary-500\)/
  )
  assert.match(
    baseStyles,
    /html\[data-theme='dark'\] input\[type='checkbox'\][\s\S]*?color-scheme:\s*dark/
  )
  assert.match(
    baseStyles,
    /html\[data-theme='dark'\] input\[type='checkbox'\][\s\S]*?appearance:\s*none/
  )
  assert.match(
    baseStyles,
    /html\[data-theme='dark'\] input\[type='checkbox'\]:checked\s*\{[\s\S]*?background-color:\s*var\(--te-primary-500\)/
  )
  assert.match(
    baseStyles,
    /html\[data-theme='dark'\] input\[type='checkbox'\]:checked::after\s*\{[\s\S]*?content:\s*''/
  )
})

test('settings wallpaper is painted once by the overlay root, never per element', () => {
  assert.match(
    styles,
    /\.settings-preview-page\s*\{[\s\S]*?inset:\s*32px 0 0;[\s\S]*?z-index:\s*2000;[\s\S]*?height:\s*auto/
  )
  // The page stays transparent: per-element wallpaper copies relied on
  // `background-attachment: fixed`, which composited layers silently unpin —
  // splitting the image into mismatched title/body bands.
  assert.match(styles, /\.settings-preview-page\s*\{[^}]*?background:\s*transparent;/)
  assert.doesNotMatch(styles, /background-attachment:\s*fixed/)
  assert.match(
    baseStyles,
    /--te-settings-backplate:\s*#f5f6f8;[\s\S]*?:root\[data-theme='dark'\] \{[\s\S]*?--te-settings-backplate:\s*#17181a;/
  )
  assert.match(
    baseStyles,
    /body\.te-settings-surface,[\s\S]*?background-color:\s*var\(--te-settings-backplate, #f5f6f8\) !important;[\s\S]*?background-image:[\s\S]*?linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\) !important/
  )
  // No theme or window-mode branch may repaint the page background anymore.
  const darkBasePageRule =
    baseStyles.match(/html\[data-theme='dark'\] \.settings-preview-page\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.doesNotMatch(darkBasePageRule, /background-image|background-color/)
  assert.doesNotMatch(baseStyles, /\.settings-preview-page\.settings-preview-page/)
  assert.doesNotMatch(
    baseStyles,
    /html\[data-window-transparent='on'\] \.title-bar\.title-bar-settings/
  )
  assert.doesNotMatch(
    baseStyles,
    /\[data-te-background-treatment='cover-blur'\] \.settings-preview-page \{/
  )
  const darkSettingsPageRule =
    pageSource.match(/html\[data-theme='dark'\] \.settings-preview-page\s*\{([\s\S]*?)\n\}/)?.[1] ??
    ''
  assert.match(darkSettingsPageRule, /background:\s*transparent;/)
  assert.doesNotMatch(darkSettingsPageRule, /--te-settings-bg-image/)
  assert.match(
    appSource,
    /class="settings-overlay-root"[\s\S]*?settings-overlay-root--active[\s\S]*?<Transition name="settings-page">[\s\S]*?<SettingsPage/
  )
  assert.match(
    appSource,
    /\.settings-overlay-root--active\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?z-index:\s*2000;[\s\S]*?isolation:\s*isolate;[\s\S]*?background:\s*#17181a !important;/
  )
  const overlayPainterRule =
    appSource.match(/\.settings-overlay-root--active::before\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.match(overlayPainterRule, /background-color:\s*#17181a;/)
  assert.match(overlayPainterRule, /var\(--te-settings-bg-image, none\),/)
  assert.match(
    overlayPainterRule,
    /linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\),/
  )
  assert.match(overlayPainterRule, /linear-gradient\(#17181a, #17181a\)/)
  assert.doesNotMatch(overlayPainterRule, /background-attachment/)
  // Liquid-glass ambients live on the single painter too (moved off the page).
  assert.match(
    baseStyles,
    /html\[data-theme='pureWhite'\]\[data-te-surface-material='liquidGlass'\]\s+\.settings-overlay-root--active::before\s*\{[^}]*?radial-gradient/
  )
  assert.match(
    baseStyles,
    /html\[data-theme='dark'\]\[data-te-surface-material='liquidGlass'\]\s+\.settings-overlay-root--active::before\s*\{[^}]*?radial-gradient/
  )
  assert.match(appSource, /\.app-shell-title\s*\{[\s\S]*?z-index:\s*2100/)
  assert.match(appSource, /\.settings-page-enter-active\s*\{[\s\S]*?z-index:\s*2000/)
  const titleBarSettingsRule =
    titleBarSource.match(/\.title-bar\.title-bar-settings,([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.match(titleBarSettingsRule, /background:\s*transparent !important;/)
  assert.doesNotMatch(titleBarSettingsRule, /--te-settings-bg-image|background-attachment/)
  assert.doesNotMatch(baseStyles, /html\[data-theme='dark'\] \.title-bar\.title-bar-settings,/)
})

test('audio output device cards are opt-in through a closed native checkbox', () => {
  assert.match(playbackPageSource, /const audioOutputPanelExpanded = ref\(false\)/)
  assert.match(
    playbackPageSource,
    /<input[\s\S]{0,260}?v-model="audioOutputPanelExpanded"[\s\S]{0,160}?type="checkbox"[\s\S]{0,200}?aria-controls="audio-output-device-panel"[\s\S]{0,160}?:aria-expanded="audioOutputPanelExpanded"/
  )
  assert.match(
    playbackPageSource,
    /<div\s+v-if="audioOutputPanelExpanded"\s+id="audio-output-device-panel"\s+class="device-panel-content"[\s\S]{0,240}?<div class="device-grid">/
  )
  assert.match(styles, /\.device-panel-disclosure\s*\{[\s\S]*?cursor:\s*pointer/)
  assert.match(
    styles,
    /@media \(max-width: 520px\)\s*\{[\s\S]*?\.device-panel-head\s*\{[\s\S]*?flex-direction:\s*column/
  )
})
