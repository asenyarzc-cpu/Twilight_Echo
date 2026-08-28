import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./DesktopLyricsApp.vue', import.meta.url), 'utf8')
const slot = readFileSync(new URL('./components/DesktopLyricSlot.vue', import.meta.url), 'utf8')
const toolbar = readFileSync(
  new URL('./components/DesktopLyricsToolbar.vue', import.meta.url),
  'utf8'
)
const css = readFileSync(new URL('./desktopLyrics.css', import.meta.url), 'utf8')

test('desktop lyrics renders two fixed alternating slots and collapsible translations', () => {
  assert.match(app, /:line="slots\[0\]\.line"/)
  assert.match(app, /:line="slots\[1\]\.line"/)
  assert.match(slot, /v-if="translationVisible && line\.translation"/)
  assert.doesNotMatch(app, /romanization|罗马音/)
})

test('desktop lyrics has stable empty, loading, instrumental, and error states', () => {
  assert.match(app, /return '等待播放'/)
  assert.match(app, /return '正在获取歌词…'/)
  assert.match(app, /return '纯音乐，请欣赏'/)
  assert.match(app, /return '歌词加载失败'/)
  assert.match(app, /const changed = session\.value\?\.sessionId !== next\.sessionId/)
})

test('per-frame progress writes CSS only and Vue changes only when the active line changes', () => {
  assert.match(slot, /element\.style\.setProperty\(\s*'--dl-word-remaining'/)
  assert.match(app, /if \(nextIndex !== activeIndex\.value\) activeIndex\.value = nextIndex/)
  assert.match(app, /slotZero\.value\?\.writeProgress\(position\)/)
  assert.doesNotMatch(slot, /ref\([^)]*progress/)
})

test('toolbar, line, and palette motion use the specified interruptible timings', () => {
  assert.match(css, /\.dl-line-enter-active[\s\S]*opacity 160ms[\s\S]*transform 160ms/)
  assert.match(css, /\.dl-toolbar-transition-enter-active[\s\S]*opacity 140ms/)
  assert.match(css, /\.dl-popover-enter-active[\s\S]*opacity 180ms/)
  assert.match(css, /data-motion='reduced'/)
  assert.match(css, /data-motion='off'/)
})

test('toolbar exposes transport, font, four palettes, translation, lock, and close controls', () => {
  for (const action of ['previous', 'playPause', 'next']) {
    assert.match(toolbar, new RegExp(`emit\\('transport', '${action}'\\)`))
  }
  for (const palette of ['accent', 'twilight', 'warm', 'custom']) {
    assert.match(toolbar, new RegExp(`id: '${palette}'`))
  }
  assert.match(toolbar, /settings\.fontSize - 2/)
  assert.match(toolbar, /settings\.fontSize \+ 2/)
  assert.match(toolbar, /translationVisible: !settings\.translationVisible/)
  assert.match(toolbar, /emit\('lock'\)/)
  assert.match(toolbar, /emit\('close'\)/)
})
