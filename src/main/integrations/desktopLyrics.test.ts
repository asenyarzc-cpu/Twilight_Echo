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
