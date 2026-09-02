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

test('desktop lyrics renders configurable line counts, translations, and romanization', () => {
  assert.match(app, /settings\.displayMode === 'double'/)
  assert.match(app, /:line="slots\[1\]\.line"/)
  assert.match(slot, /v-if="translationVisible && line\.translation"/)
  assert.match(slot, /v-if="romanizationVisible && line\.romanization"/)
  assert.match(app, /:writing-mode="settings\.writingMode"/)
  assert.match(app, /:align="settings\.textAlign"/)
  assert.match(css, /\.dl-slots\.is-single/)
  assert.match(css, /\.dl-slots\.is-vertical/)
  assert.match(css, /--dl-outline-width/)
})

test('active and inactive desktop lyric lines use the configured font size', () => {
  assert.match(
    css,
    /\.dl-slot-shell \{[\s\S]*font-size: var\(--dl-size\);[\s\S]*\}[\s\S]*\.dl-slot-shell\.is-active \{[\s\S]*font-size: var\(--dl-size\);/
  )
})

test('vertical desktop lyrics place the active line on the right and controls on the left', () => {
  assert.match(app, /'is-vertical': settings\.writingMode === 'vertical'/)
  assert.match(app, /\{ 'has-active-line': activeIndex >= 0 \}/)
  assert.match(
    css,
    /\.dl-slots\.is-vertical\.has-active-line \.dl-slot-shell\.is-active \{\s*grid-column: 2;/
  )
  assert.match(
    css,
    /\.dl-slots\.is-vertical\.has-active-line \.dl-slot-shell:not\(\.is-active\) \{\s*grid-column: 1;/
  )
  assert.match(css, /\.dl-slots\.is-vertical \.dl-slot-shell \{\s*grid-row: 1;/)
  assert.match(css, /\.dl-root\.is-vertical \.dl-overlay \{[\s\S]*left: 8px/)
  assert.match(css, /\.dl-root\.is-vertical \.dl-toolbar \{[\s\S]*flex-direction: column/)
  assert.match(css, /\.dl-slots\.is-vertical \{[\s\S]*width: max-content/)
  assert.match(
    css,
    /\.dl-slots\.is-vertical\.is-double \{\s*grid-template-columns: repeat\(2, max-content\);/
  )
  assert.match(
    css,
    /\.dl-root\.is-vertical \.dl-board \{\s*--dl-board-hover-alpha: var\(--dl-board-alpha\);/
  )
})

test('desktop lyrics has stable empty, loading, instrumental, and error states', () => {
  assert.match(app, /return '等待播放'/)
  assert.match(app, /return '正在获取歌词…'/)
  assert.match(app, /return '纯音乐，请欣赏'/)
  assert.match(app, /return '歌词加载失败'/)
  assert.match(app, /const changed = session\.value\?\.sessionId !== next\.sessionId/)
})

test('desktop lyrics schedules line changes locally while karaoke fills run through WAAPI', () => {
  assert.match(slot, /element\.animate\(plan\.keyframes, plan\.timing\)/)
  assert.match(slot, /function syncKaraoke\(positionMs: number, playing: boolean, hard = false\)/)
  assert.match(slot, /const endTime = animationEndTime\(animation\)/)
  assert.match(slot, /animation\.playState !== 'finished'/)
  assert.match(slot, /animation\.finish\(\)/)
  assert.doesNotMatch(slot, /function writeProgress/)
  assert.doesNotMatch(slot, /mode="out-in"/)
  assert.match(app, /if \(changed\) activeIndex\.value = nextIndex/)
  assert.match(app, /function scheduleActiveLineUpdate\(\): void/)
  assert.doesNotMatch(app, /requestAnimationFrame\(writeFrame\)/)
  assert.doesNotMatch(css, /\.dl-line-enter-active/)
})

test('toolbar and palette motion use the specified interruptible timings', () => {
  assert.match(css, /\.dl-toolbar-transition-enter-active[\s\S]*opacity 140ms/)
  assert.match(css, /\.dl-popover-enter-active[\s\S]*opacity 180ms/)
  assert.match(css, /data-motion='reduced'/)
  assert.match(css, /data-motion='off'/)
})

test('desktop lyrics waits for a settled hover before showing the toolbar', () => {
  assert.match(app, /const DESKTOP_LYRICS_TOOLBAR_HOVER_DELAY_MS = 500/)
  assert.match(app, /toolbarTimer = setTimeout\(/)
  assert.match(app, /if \(hovering\.value\) toolbarVisible\.value = true/)
  assert.match(app, /@pointerenter="onPointerEnter"/)
  assert.match(app, /@pointerleave="onPointerLeave"/)
  assert.match(app, /<div v-if="toolbarVisible" class="dl-overlay">/)
  assert.match(app, /function hideToolbar\(\): void/)
})

test('pause auto-hide synchronizes native window click-through state', () => {
  assert.match(app, /function setPausedHidden\(hidden: boolean\): void/)
  assert.match(app, /api\.setPausedHidden\(hidden\)/)
  assert.match(app, /pauseTimer = setTimeout\([\s\S]*setPausedHidden\(true\)/)
  assert.match(app, /function schedulePauseHide\(\): void \{[\s\S]*setPausedHidden\(false\)/)
})

test('locking clears hover UI and does not schedule the toolbar again', () => {
  assert.match(
    app,
    /function clearHoverUi\(\): void[\s\S]*hovering\.value = false[\s\S]*hideToolbar\(\)/
  )
  assert.match(
    app,
    /async function lock\(\): Promise<void> \{\s*clearHoverUi\(\)\s*clearLockedHover\(\)\s*settings\.value = await api\.setLocked\(true\)/
  )
  assert.match(app, /if \(next\.locked\) \{\s*clearHoverUi\(\)\s*clearLockedHover\(\)/)
})

test('locked desktop lyrics show a central unlock affordance after hover or immediately on double click', () => {
  assert.match(app, /const DESKTOP_LYRICS_LOCKED_HOVER_DELAY_MS = 3000/)
  assert.match(app, /api\.onHoverIntent\(onHoverIntent\)/)
  assert.match(app, /setLockedInteractionActive\(true\)/)
  assert.match(app, /function onDoubleClick\(event: MouseEvent\): void/)
  assert.match(app, /revealUnlockAffordance\(\)/)
  assert.match(app, /v-if="unlockAffordanceVisible"/)
  assert.match(app, /@click="unlock"/)
  assert.match(css, /\.dl-unlock-affordance \{[\s\S]*top: 50%;[\s\S]*left: 50%;/)

  const hoverIntent = app.slice(
    app.indexOf('function onHoverIntent'),
    app.indexOf('function onPointerEnter')
  )
  const reveal = app.slice(
    app.indexOf('function revealUnlockAffordance'),
    app.indexOf('function scheduleUnlockAffordance')
  )
  assert.doesNotMatch(hoverIntent, /setLockedInteractionActive\(true\)/)
  assert.match(reveal, /setLockedInteractionActive\(true\)/)
  assert.match(
    app,
    /function onPointerLeave\(\): void \{[\s\S]*if \(settings\.value\.locked\) \{[\s\S]*clearLockedHover\(\)/
  )
})

test('unlocking under the pointer restores the desktop lyrics toolbar hover state', () => {
  assert.match(
    app,
    /function restoreHoverAfterUnlock\(\): void \{\s*if \(!rootElement\.value\?\.matches\(':hover'\)\) return/
  )
  assert.match(
    app,
    /else if \(lockChanged\) \{\s*clearLockedHover\(\)\s*hideToolbar\(\)\s*void nextTick\(restoreHoverAfterUnlock\)/
  )
  assert.match(app, /<main\s*ref="rootElement"/)
})

test('toolbar exposes transport, font, palettes, translation, lock, and close controls', () => {
  for (const action of ['previous', 'playPause', 'next']) {
    assert.match(toolbar, new RegExp(`emit\\('transport', '${action}'\\)`))
  }
  for (const palette of ['accent', 'sunset', 'twilight', 'warm', 'custom']) {
    assert.match(toolbar, new RegExp(`id: '${palette}'`))
  }
  assert.match(toolbar, /settings\.fontSize - 2/)
  assert.match(toolbar, /settings\.fontSize \+ 2/)
  assert.match(toolbar, /translationVisible: !settings\.translationVisible/)
  assert.match(toolbar, /emit\('lock'\)/)
  assert.match(toolbar, /emit\('close'\)/)
})
