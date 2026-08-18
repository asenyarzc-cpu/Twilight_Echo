import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const runtime = readFileSync(new URL('./autoHideScrollbars.ts', import.meta.url), 'utf8')
const baseStyles = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')

test('auto-hide scrollbar runtime discovers nested scroll containers through event delegation', () => {
  assert.match(runtime, /findScrollableAncestor/)
  assert.match(runtime, /document\.addEventListener\('pointermove'/)
  assert.match(runtime, /document\.addEventListener\('scroll',[\s\S]*capture: true/)
  assert.match(runtime, /SCROLLBAR_PROXIMITY_PX = 28/)
  assert.match(runtime, /is-scrollbar-near/)
  assert.match(runtime, /is-scrollbar-active/)
})

test('global scrollbar styling is hidden by default and uses neutral reveal tokens', () => {
  assert.match(baseStyles, /--te-scrollbar-thumb:/)
  assert.match(baseStyles, /--te-scrollbar-thumb-hover:/)
  assert.match(baseStyles, /scrollbar-color: transparent transparent !important/)
  assert.match(baseStyles, /\.te-auto-scrollbar\.is-scrollbar-near/)
  assert.match(baseStyles, /background: var\(--te-scrollbar-thumb\) !important/)
  assert.doesNotMatch(baseStyles, /--te-scrollbar-thumb:\s*rgba\(var\(--te-primary-rgb\)/)

  assert.match(baseStyles, /-webkit-user-drag: none/)
  assert.match(baseStyles, /user-drag: none/)

  const scrollbarSources = [
    baseStyles,
    '../components/RadioPodcastPage.vue',
    '../components/player-bar/PlayerBar.css',
    '../components/song-list/SongList.css',
    '../components/streaming-page/StreamingPage.css'
  ].map((source) =>
    source === baseStyles ? source : readFileSync(new URL(source, import.meta.url), 'utf8')
  )

  for (const source of scrollbarSources) {
    assert.doesNotMatch(
      source,
      /scrollbar-(?:color|thumb)[^\n]*(?:te-primary|hifi-accent|124,\s*77,\s*255|purple)/i
    )
    assert.doesNotMatch(
      source,
      /::-webkit-scrollbar-thumb[\s\S]{0,180}background[^;]*(?:te-primary|hifi-accent|124,\s*77,\s*255|purple)/i
    )
  }
})

test('back button tokens use a blue icon with neutral surfaces instead of the theme accent', () => {
  assert.match(baseStyles, /--te-back-button-bg:/)
  assert.match(baseStyles, /--te-back-button-border:/)
  assert.match(baseStyles, /--te-back-button-color:\s*#2563eb/)
  assert.match(baseStyles, /--te-back-button-color:\s*#60a5fa/)
  assert.match(baseStyles, /\[data-te-back-button\]/)
})

test('all renderer back controls opt in to the shared minimal style', () => {
  const componentSources = [
    '../components/DspRackPage.vue',
    '../components/EqualizerPage.vue',
    '../components/LoginPage.vue',
    '../components/PluginExtensionPage.vue',
    '../components/RadioPodcastPage.vue',
    '../components/SongList.vue',
    '../components/streaming-page/StreamingContentHeader.vue',
    '../components/ThemeStudioPage.vue',
    '../components/onboarding/OnboardingWizard.vue',
    '../mini-player/MiniPlayerApp.vue'
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

  for (const source of componentSources) assert.match(source, /data-te-back-button=/)
})
