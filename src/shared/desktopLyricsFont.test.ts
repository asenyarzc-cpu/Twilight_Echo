import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_LYRICS_TEXT_STYLES } from './lyricsAppearance.ts'
import { DESKTOP_LYRICS_FOLLOW_FONT, resolveDesktopLyricsFontFamily } from './desktopLyricsFont.ts'

test('desktop lyrics follow the active PlayingMusic custom font', () => {
  const style = {
    ...DEFAULT_LYRICS_TEXT_STYLES.active,
    fontFamily: 'custom' as const,
    customFontFamily: 'Noto Sans CJK SC'
  }

  assert.equal(
    resolveDesktopLyricsFontFamily(DESKTOP_LYRICS_FOLLOW_FONT, style),
    '"Noto Sans CJK SC", \'Microsoft YaHei\', sans-serif'
  )
})

test('desktop lyrics resolve built-in presets and empty values', () => {
  const style = DEFAULT_LYRICS_TEXT_STYLES.active
  assert.match(resolveDesktopLyricsFontFamily('system', style), /system-ui/)
  assert.match(resolveDesktopLyricsFontFamily('inter', style), /Inter/)
  assert.match(resolveDesktopLyricsFontFamily('lxgw', style), /LXGW WenKai.*KaiTi/)
  assert.match(resolveDesktopLyricsFontFamily('', style), /system-ui/)
})

test('desktop lyrics quote installed family names before adding a fallback', () => {
  const style = DEFAULT_LYRICS_TEXT_STYLES.active
  assert.equal(
    resolveDesktopLyricsFontFamily('Segoe UI Variable', style),
    '"Segoe UI Variable", sans-serif'
  )
})

test('desktop lyrics fall back for empty or CSS-like font values', () => {
  const style = DEFAULT_LYRICS_TEXT_STYLES.active
  const systemStack = resolveDesktopLyricsFontFamily('system', style)

  assert.equal(resolveDesktopLyricsFontFamily('   ', style), systemStack)
  assert.equal(resolveDesktopLyricsFontFamily('Inter, sans-serif', style), systemStack)
  assert.equal(
    resolveDesktopLyricsFontFamily('url(https://example.test/font.woff2)', style),
    systemStack
  )
  assert.equal(resolveDesktopLyricsFontFamily('Injected\nFont', style), systemStack)
})
