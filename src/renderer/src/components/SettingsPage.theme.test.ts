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
    /\[data-te-settings-navigation-liquid-glass='on'\][\s\S]{0,240}\.settings-preview-nav::after\s*\{[\s\S]*?backdrop-filter:\s*blur\(var\(--te-lg-blur, 16px\)\)[\s\S]*?filter:\s*url\(#te-lg-card\)/
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

test('settings uses an opaque independent backdrop without covering title controls', () => {
  assert.match(
    styles,
    /\.settings-preview-page\s*\{[\s\S]*?inset:\s*32px 0 0;[\s\S]*?z-index:\s*2000;[\s\S]*?height:\s*auto/
  )
  assert.match(
    styles,
    /\.settings-preview-page\s*\{[\s\S]*?background-color:\s*#17181a;[\s\S]*?background-image:\s*var\(--te-settings-bg-image, none\),[\s\S]*?linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\),[\s\S]*?linear-gradient\(#17181a, #17181a\)[\s\S]*?background-attachment:\s*fixed, fixed, fixed/
  )
  assert.match(
    baseStyles,
    /--te-settings-backplate:\s*#f5f6f8;[\s\S]*?:root\[data-theme='dark'\] \{[\s\S]*?--te-settings-backplate:\s*#17181a;/
  )
  assert.match(
    baseStyles,
    /body\.te-settings-surface,[\s\S]*?background-color:\s*var\(--te-settings-backplate, #f5f6f8\) !important;[\s\S]*?background-image:[\s\S]*?linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\) !important/
  )
  assert.match(
    baseStyles,
    /html\[data-window-transparent='on'\] \.settings-preview-page\.settings-preview-page\s*\{[\s\S]*?background-color:\s*var\(--te-settings-backplate, #17181a\) !important;[\s\S]*?linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\) !important/
  )
  assert.match(
    baseStyles,
    /html\[data-window-transparent='on'\] \.title-bar\.title-bar-settings,[\s\S]*?background-color:\s*var\(--te-settings-backplate, #17181a\) !important;[\s\S]*?linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\) !important/
  )
  const darkSettingsPageRule =
    pageSource.match(/html\[data-theme='dark'\] \.settings-preview-page\s*\{([\s\S]*?)\n\}/)?.[1] ??
    ''
  assert.match(
    darkSettingsPageRule,
    /background-color:\s*var\(--te-settings-backplate, #17181a\) !important;/
  )
  assert.match(
    darkSettingsPageRule,
    /linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\) !important;/
  )
  assert.match(
    appSource,
    /class="settings-overlay-root"[\s\S]*?settings-overlay-root--active[\s\S]*?<Transition name="settings-page">[\s\S]*?<SettingsPage/
  )
  assert.match(
    appSource,
    /\.settings-overlay-root--active\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*32px 0 0;[\s\S]*?z-index:\s*2000;[\s\S]*?isolation:\s*isolate;[\s\S]*?background:\s*#17181a !important;/
  )
  assert.match(
    appSource,
    /\.settings-overlay-root--active::before\s*\{[\s\S]*?background-color:\s*#17181a;[\s\S]*?var\(--te-settings-bg-image, none\),[\s\S]*?linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\),[\s\S]*?linear-gradient\(#17181a, #17181a\)/
  )
  assert.match(appSource, /\.app-shell-title\s*\{[\s\S]*?z-index:\s*2100/)
  assert.match(appSource, /\.settings-page-enter-active\s*\{[\s\S]*?z-index:\s*2000/)
  assert.match(
    titleBarSource,
    /\.title-bar\.title-bar-settings,[\s\S]*?background-color:\s*var\(--te-settings-backplate, #17181a\) !important;[\s\S]*?linear-gradient\(var\(--te-settings-bg\), var\(--te-settings-bg\)\) !important/
  )
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
