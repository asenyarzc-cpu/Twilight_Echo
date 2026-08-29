import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('desktop lyrics resolve linked fonts at every window settings send point', async () => {
  const source = await readFile(new URL('./desktopLyrics.ts', import.meta.url), 'utf8')
  const state = await readFile(new URL('../audio/state.ts', import.meta.url), 'utf8')

  assert.match(source, /resolveDesktopLyricsFontFamily/)
  assert.match(source, /runtime\.appSettings\.lyricsAppearance\.styles\.active/)
  assert.match(source, /getEffectiveDesktopLyricsSettings\(\)/)
  assert.match(source, /syncDesktopLyricsSettings\(\)/)
  assert.match(state, /hasOwnProperty\.call\(patch, 'lyricsAppearance'\)/)
  assert.match(state, /syncDesktopLyricsSettings\(\)/)
})

test('desktop lyrics settings expose an explicit follow-font control', async () => {
  const source = await readFile(
    new URL(
      '../../renderer/src/components/settings-page/DesktopLyricsSettingsSection.vue',
      import.meta.url
    ),
    'utf8'
  )
  const settings = await readFile(new URL('../core/settings.ts', import.meta.url), 'utf8')
  const settingsCss = await readFile(
    new URL('../../renderer/src/components/settings-page/SettingsPage.css', import.meta.url),
    'utf8'
  )

  assert.match(source, /useLyricsFontPicker/)
  assert.match(source, /跟随 PlayingMusic/)
  assert.match(source, /fontPicker\.installedMatches/)
  assert.match(source, /'font-menu-open': fontMenuOpen/)
  assert.match(settingsCss, /\.desktop-font-setting\.font-menu-open\s*\{[\s\S]*z-index: 30/)
  assert.match(
    settingsCss,
    /\.setting-item\.desktop-font-setting\.font-menu-open:hover\s*\{[\s\S]*translate: 0 0/
  )
  assert.match(settings, /fontFamily: DESKTOP_LYRICS_FOLLOW_FONT/)
})

test('netEase desktop lyrics select two rows and calculate weighted karaoke progress', async () => {
  const presentation = (await import('../../../resources/desktop-lyrics-presentation.js')).default
  const lines = [
    { time: 0, text: 'ab', translation: '甲乙', words: null },
    { time: 10, text: 'cdef', translation: null, words: null }
  ]
  assert.deepEqual(presentation.resolveNetEaseRows(lines, 0, { showTranslation: true }), [
    { lineIndex: 0, text: 'ab', isTranslation: false, isActive: true },
    { lineIndex: 0, text: '甲乙', isTranslation: true, isActive: true }
  ])
  assert.deepEqual(presentation.resolveNetEaseRows(lines, 0, { showTranslation: false }), [
    { lineIndex: 0, text: 'ab', isTranslation: false, isActive: true },
    { lineIndex: 1, text: 'cdef', isTranslation: false, isActive: false }
  ])
  assert.equal(presentation.hasWordTiming(lines[0]), false)
  assert.equal(presentation.calculateLineProgress(lines, 0, 4), 0)
  const timedLines = [
    {
      time: 0,
      text: 'abcde',
      words: [
        { time: 0, text: 'ab' },
        { time: 2, text: 'cde' }
      ]
    }
  ]
  assert.equal(presentation.hasWordTiming(timedLines[0]), true)
  assert.equal(presentation.calculateLineProgress(timedLines, 0, 3), 0.55)
})

test('netEase desktop lyrics only enable karaoke sweep for word-timed lines', async () => {
  const renderer = await readFile(
    new URL('../../../resources/desktop-lyrics.html', import.meta.url),
    'utf8'
  )
  const source = await readFile(new URL('./desktopLyrics.ts', import.meta.url), 'utf8')

  assert.match(renderer, /TwilightDesktopLyricsPresentation\.hasWordTiming/)
  assert.match(
    renderer,
    /div\.style\.color = canKaraoke[\s\S]*\? settings\.color[\s\S]*\? settings\.highlightColor/
  )
  assert.match(renderer, /listInstalledFonts/)
  assert.match(renderer, /id="color-panel"/)
  assert.match(renderer, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(renderer, /updateSettingsPatch\(\{ fontFamily: fontSelect\.value \}\)/)
  assert.match(source, /settings: Partial<DesktopLyricsSettings>/)
  assert.match(source, /'settings:changed'/)
})

test('desktop lyrics retain legacy click-through state as hover-unlock locking', async () => {
  const source = await readFile(new URL('./desktopLyrics.ts', import.meta.url), 'utf8')
  const settings = await readFile(new URL('../core/settings.ts', import.meta.url), 'utf8')
  const renderer = await readFile(
    new URL('../../../resources/desktop-lyrics.html', import.meta.url),
    'utf8'
  )

  assert.match(settings, /locked:\s*\n?\s*typeof d\.locked === 'boolean'/)
  assert.match(settings, /showAcrylic: d\.showAcrylic !== false/)
  assert.match(source, /applyDesktopLyricsMouseMode/)
  assert.match(source, /setIgnoreMouseEvents\(shouldIgnoreMouseEvents,\s*\{\s*forward:\s*true\s*\}/)
  assert.match(source, /desktopLyrics:hoverIntent/)
  assert.match(source, /getCursorScreenPoint/)
  assert.match(renderer, /TwilightDesktopLyricsPresentation\.resolveNetEaseRows/)
  assert.match(renderer, /desktopLyrics:setInteractive|api\.setInteractive/)
  assert.match(renderer, /id="btn-acrylic"/)
  assert.match(renderer, /classList\.toggle\('show-acrylic'/)
  assert.match(renderer, /#lyrics-container\.locked #toolbar \.toolbar-surface > :not\(#btn-lock\)/)
  assert.match(renderer, /#lyrics-container\.locked #toolbar \{[\s\S]*left:\s*50%/)
  assert.match(renderer, /transform:\s*translate\(-50%,\s*-50%\)/)
  assert.match(renderer, /HOVER_REVEAL_DELAY_MS = 2000/)
  assert.match(renderer, /addEventListener\('dblclick'/)
})

test('desktop lyrics presentation survives settings normalization after restart', async () => {
  const settings = await readFile(new URL('../core/settings.ts', import.meta.url), 'utf8')

  assert.match(settings, /presentation: 'netease'/)
  assert.match(
    settings,
    /presentation:\s*\n\s*d\.presentation === 'classic' \|\| d\.presentation === 'netease'\s*\n\s*\? d\.presentation\s*\n\s*:\s*DEFAULT_DESKTOP_LYRICS\.presentation/
  )
})
