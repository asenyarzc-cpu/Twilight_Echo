import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  LIQUID_GLASS_CARD_FILTER_ID,
  LIQUID_GLASS_CARD_SELECTOR,
  LIQUID_GLASS_EXPANDED_CARD_FILTER_ID,
  LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR,
  LIQUID_GLASS_HOME_CARD_FILTER_ID,
  LIQUID_GLASS_PLAYBAR_FILTER_ID
} from '../../../shared/liquidGlass.ts'

const baseStyle = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')
const defs = readFileSync(new URL('./LiquidGlassDefs.vue', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const dashboardStyle = readFileSync(new URL('./LocalDashboard.css', import.meta.url), 'utf8')
const themeStore = readFileSync(new URL('../stores/useThemeStore.ts', import.meta.url), 'utf8')
const playerBarStyle = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')
const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
const settingsStyle = readFileSync(
  new URL('./settings-page/SettingsPage.css', import.meta.url),
  'utf8'
)
const liquidGlassSettings = readFileSync(
  new URL('./settings-page/LiquidGlassSettings.vue', import.meta.url),
  'utf8'
)
const settingsPage = readFileSync(new URL('./SettingsPage.vue', import.meta.url), 'utf8')
const sideMenu = readFileSync(new URL('./SideMenu.vue', import.meta.url), 'utf8')
const titleBar = readFileSync(new URL('./TitleBar.vue', import.meta.url), 'utf8')

test('shared glass is scoped to chrome and dashboard clear glass is hero-only', () => {
  assert.equal(LIQUID_GLASS_CARD_SELECTOR, '.home .feature-card')
  assert.doesNotMatch(
    baseStyle,
    /html\[data-te-surface-material='liquidGlass'\]\s*\n\s*:is\(\s*\n\s*\.artist-card/
  )
  assert.match(
    dashboardStyle,
    /html\[data-te-home-liquid-glass='on'\]\s+\.home\s+\.feature-card\s*\{/
  )
  assert.doesNotMatch(dashboardStyle, /:is\(\s*\.feature-card,\s*\.signal-card/)
})

test('expensive hero observers and pointer tracking stay inactive outside the clear scope', () => {
  assert.match(defs, /props\.active &&\s*props\.homeCardsActive &&/)
  assert.match(defs, /!props\.homeCardsActive && !props\.expandedActive/)
  assert.match(defs, /new IntersectionObserver/)
  assert.match(defs, /rootMargin: '128px 0px'/)
  assert.match(
    defs,
    /props\.expandedActive && surface\.matches\(LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR\)/
  )
})

test('expanded coverage is opt-in and excludes dense rows and nested surfaces', () => {
  assert.equal(
    LIQUID_GLASS_EXPANDED_SURFACE_SELECTOR,
    '.artist-card,.album-card,.playlist-card,.glass-card,.signal-card,.chart-card,.profile-card,.recent-card,.ranking-card'
  )
  assert.match(app, /settings\.value\.liquidGlass\.coverage === 'expanded'/)
  assert.match(app, /:expanded-active="settings\.liquidGlass\.coverage === 'expanded'"/)
  assert.match(baseStyle, /data-te-liquid-glass-coverage='expanded'/)
  assert.match(baseStyle, /filter: url\(#te-lg-expanded-card\)/)
  assert.match(baseStyle, /prefers-reduced-transparency: reduce/)
  assert.match(baseStyle, /prefers-contrast: more/)
  assert.match(baseStyle, /forced-colors: active/)
  assert.match(baseStyle, /te-liquid-glass-budget/)
  assert.match(baseStyle, /data-window-transparent='on'\]\[data-platform='win32'/)
  assert.doesNotMatch(baseStyle, /data-te-legacy-content-glass/)
  assert.doesNotMatch(baseStyle, /data-te-liquid-glass-coverage='expanded'[^\n]*.*track-row/)
  assert.doesNotMatch(baseStyle, /data-te-liquid-glass-coverage='expanded'[\s\S]*?\.feature-card/)
  assert.match(liquidGlassSettings, /setLiquidGlassCoverage/)
  assert.match(liquidGlassSettings, /coverage === 'functional'/)
  assert.match(liquidGlassSettings, /coverage === 'expanded'/)
})

test('every theme runtime return path emits all chrome material targets', () => {
  for (const attribute of [
    'data-te-navigation-liquid-glass',
    'data-te-playbar-liquid-glass',
    'data-te-settings-navigation-liquid-glass',
    'data-te-home-liquid-glass',
    'data-te-liquid-glass-coverage'
  ]) {
    assert.equal(
      (themeStore.match(new RegExp(`'${attribute}':`, 'g')) ?? []).length,
      2,
      `${attribute} must be emitted on both return paths`
    )
  }
  assert.match(themeStore, /liquidGlass\.navigationEnabled/)
})

test('app shell uses regular material for navigation and samples only its active page', () => {
  assert.match(app, /useLiquidGlassEnvironment/)
  assert.match(app, /liquidGlassBackgroundPage = computed<AppBackgroundPage>/)
  assert.match(app, /:liquid-material="liquidGlassChromeActive"/)
  assert.match(app, /:liquid-material="liquidGlassChromeActive"/)
})

test('chrome surfaces retain isolated blur layers and press-origin feedback', () => {
  assert.match(titleBar, /title-bar-liquid/)
  assert.match(titleBar, /function setPressOrigin\(event: PointerEvent\)/)
  assert.match(titleBar, /circle at var\(--te-lg-press-x, 50%\) var\(--te-lg-press-y, 50%\)/)
  assert.match(sideMenu, /side-menu-liquid/)
  assert.match(sideMenu, /function setPressOrigin\(event: PointerEvent\)/)
  assert.match(sideMenu, /backdrop-filter: blur\(20px\) saturate\(128%\)/)
  assert.match(settingsPage, /function setNavigationPressOrigin\(event: PointerEvent\)/)
  assert.match(settingsStyle, /circle at var\(--te-lg-press-x, 50%\) var\(--te-lg-press-y, 50%\)/)
  assert.match(playerBar, /function setGlassPressOrigin\(event: PointerEvent\)/)
  assert.match(playerBarStyle, /--te-lg-press-color/)
  assert.match(titleBar, /aria-label="关闭窗口"/)
})

test('all chrome recipes consume bounded context variables and preserve reduced-effect fallbacks', () => {
  for (const source of [titleBar, sideMenu, settingsStyle, playerBarStyle]) {
    assert.match(source, /--te-lg-context-(?:rgb|surface|label|rim|shadow)/)
    assert.match(source, /prefers-reduced-transparency/)
    assert.match(source, /forced-colors: active/)
  }
  assert.match(settingsStyle, /data-te-liquid-glass-scrolled='on'/)
  assert.match(playerBarStyle, /body\.te-no-blur .player-bar-liquid .player-bar-warp/)
  assert.match(baseStyle, /data-te-liquid-glass-source='solid'/)
  assert.match(baseStyle, /--te-lg-context-material/)
  assert.match(playerBarStyle, /data-te-liquid-glass-source='solid'/)
  assert.match(sideMenu, /data-te-liquid-glass-source='solid'/)
})

test('all SVG filters remain defined once and referenced from their intended surfaces', () => {
  for (const id of [
    LIQUID_GLASS_CARD_FILTER_ID,
    LIQUID_GLASS_EXPANDED_CARD_FILTER_ID,
    LIQUID_GLASS_HOME_CARD_FILTER_ID,
    LIQUID_GLASS_PLAYBAR_FILTER_ID
  ]) {
    const constant =
      id === LIQUID_GLASS_CARD_FILTER_ID
        ? 'LIQUID_GLASS_CARD_FILTER_ID'
        : id === LIQUID_GLASS_EXPANDED_CARD_FILTER_ID
          ? 'LIQUID_GLASS_EXPANDED_CARD_FILTER_ID'
          : id === LIQUID_GLASS_HOME_CARD_FILTER_ID
            ? 'LIQUID_GLASS_HOME_CARD_FILTER_ID'
            : 'LIQUID_GLASS_PLAYBAR_FILTER_ID'
    assert.match(defs, new RegExp(`:id="${constant}"`))
  }
  assert.match(defs, /:id="LIQUID_GLASS_EXPANDED_CARD_FILTER_ID"[\s\S]*expandedChannelScales/)
  assert.match(settingsStyle, /filter: url\(#te-lg-card\)/)
  assert.match(dashboardStyle, /filter: var\(--home-lg-filter\)/)
  assert.match(playerBarStyle, /filter: url\(#te-lg-playbar\)/)
})

test('playbar pointer tracking remains element-local', () => {
  assert.match(playerBar, /@pointermove="onGlassPointerMove"/)
  assert.match(playerBar, /playerBarRef\.value/)
  assert.doesNotMatch(playerBar, /document\.elementFromPoint/)
})
