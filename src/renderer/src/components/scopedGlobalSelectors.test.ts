import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { compileStyle } from '@vue/compiler-sfc'

const scopedStyleFiles = [
  './DspRackPage.vue',
  './EqualizerPage.vue',
  './equalizer/OpraEqPanel.vue',
  './equalizer/FrequencyResponseChart.vue',
  './equalizer/FrequencyResponseToolbar.vue',
  './equalizer/GraphicEqPanel.vue',
  './LocalDashboard.css',
  './player-bar/PlayerBar.css',
  './PlayingMusic.vue',
  './SideMenu.vue',
  './StreamingHome.vue',
  './StreamingLibrary.vue',
  './StreamingSearch.vue',
  './TitleBar.vue',
  './streaming-page/ProviderDownloadsPanel.vue',
  './streaming-page/ProviderSidebar.vue',
  './streaming-page/StreamingContentHeader.css',
  './streaming-page/StreamingContextMenu.vue',
  './streaming-page/StreamingPage.css',
  './streaming-page/StreamingPlaceholder.css',
  './streaming-page/StreamingSearchControls.css',
  './streaming-page/NcmPlaylistDialogs.vue'
]

test('scoped component styles keep descendants inside global theme selectors', () => {
  for (const relativePath of scopedStyleFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    assert.doesNotMatch(
      source,
      /:global\([^\r\n)]+\)\s+[^,{\r\n]+[,{]/,
      `${relativePath} contains a global ancestor whose scoped descendant will be dropped by Vue`
    )
  }
})

test('compiled dashboard dark styles never dim or filter the document root', () => {
  const source = readFileSync(new URL('./LocalDashboard.css', import.meta.url), 'utf8')
  const result = compileStyle({
    source,
    filename: 'LocalDashboard.css',
    id: 'data-v-mini-player-dark-mode-regression',
    scoped: true
  })

  assert.deepEqual(result.errors, [])
  assert.doesNotMatch(
    result.code,
    /html\[data-theme=['"]dark['"]\]\s*\{[^}]*(?:filter|opacity)\s*:/
  )
  assert.match(
    result.code,
    /html\[data-theme=['"]dark['"]\]\s+\.home\s+\.feature-backdrop\s+img\s*\{/
  )
})

test('compiled playbar glass degradation still reaches the warp layer', () => {
  // Regression: these four rules used to wrap the ancestor in `:global()`, which
  // compiles to the bare ancestor — `filter: none` landed on <body>/<html> and the
  // warp layer kept its displacement filter with no blurred backdrop under it.
  const source = readFileSync(new URL('./player-bar/PlayerBar.css', import.meta.url), 'utf8')
  const result = compileStyle({
    source,
    filename: 'PlayerBar.css',
    id: 'data-v-playbar-glass',
    scoped: true
  })

  assert.deepEqual(result.errors, [])
  for (const ancestor of [
    'body\\.te-no-blur',
    "html\\[data-te-effects-mode='reduced'\\]",
    "html\\[data-window-transparent='on'\\]\\[data-platform='linux'\\]"
  ]) {
    assert.match(
      result.code,
      new RegExp(
        `${ancestor}\\s+\\.player-bar-liquid\\s+\\.player-bar-warp\\[data-v-playbar-glass\\]`
      )
    )
  }
  assert.match(
    result.code,
    /html\[data-theme='dark'\]\s+\.player-bar-liquid\[data-v-playbar-glass\]/
  )
  // No degradation rule may collapse onto the document root or <body> itself.
  assert.doesNotMatch(result.code, /^\s*body\.te-no-blur\s*\{/m)
  assert.doesNotMatch(result.code, /^\s*html\[data-te-effects-mode='reduced'\]\s*\{/m)
})
