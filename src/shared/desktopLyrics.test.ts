import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DESKTOP_LYRICS_SETTINGS,
  DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE,
  acceptsDesktopLyricsClock,
  desktopLyricsFitScale,
  desktopLyricsLineEnd,
  desktopLyricsWordProgress,
  findDesktopLyricsActiveIndex,
  normalizeDesktopLyricsSettings,
  resolveDesktopLyricsPaletteColors,
  resolveDesktopLyricsSlots,
  type DesktopLyricsClockSnapshot,
  type DesktopLyricsLine
} from './desktopLyrics.ts'

const lines: DesktopLyricsLine[] = [
  { id: 'a', startMs: 1000, endMs: null, text: 'A' },
  { id: 'b', startMs: 2000, endMs: null, text: 'B', translation: '乙' },
  { id: 'c', startMs: 3000, endMs: 3600, text: 'C' }
]

test('v3 migration resets appearance while retaining enable and signed position', () => {
  const settings = normalizeDesktopLyricsSettings({
    version: 2,
    enabled: true,
    windowX: -1200,
    windowY: 80,
    fontSize: 60,
    locked: true
  })
  assert.equal(settings.enabled, true)
  assert.equal(settings.windowX, -1200)
  assert.equal(settings.windowY, 80)
  assert.equal(settings.fontSize, DEFAULT_DESKTOP_LYRICS_SETTINGS.fontSize)
  assert.equal(settings.locked, false)
})

test('v3 settings normalize orientation-specific window ranges', () => {
  const settings = normalizeDesktopLyricsSettings(
    {
      version: 3,
      fontSize: 99,
      windowWidth: 10,
      windowHeight: 1200,
      inactiveOpacity: 5,
      palette: 'warm',
      romanizationVisible: true,
      displayMode: 'single',
      writingMode: 'vertical',
      textAlign: 'right',
      textOutline: false,
      customInactiveColor: '#234567'
    },
    { resetLegacy: false }
  )
  assert.equal(settings.fontSize, 64)
  assert.equal(settings.windowWidth, 160)
  assert.equal(settings.windowHeight, 960)
  assert.equal(settings.inactiveOpacity, 20)
  assert.equal(settings.palette, 'warm')
  assert.equal(settings.romanizationVisible, true)
  assert.equal(settings.displayMode, 'single')
  assert.equal(settings.writingMode, 'vertical')
  assert.equal(settings.textAlign, 'right')
  assert.equal(settings.textOutline, false)
  assert.equal(settings.customInactiveColor, '#234567')
  assert.equal(settings.translationVisible, false)
})

test('vertical desktop lyrics migrate the previous horizontal window geometry', () => {
  const settings = normalizeDesktopLyricsSettings(
    { version: 3, writingMode: 'vertical', windowWidth: 960, windowHeight: 196 },
    { resetLegacy: false }
  )
  assert.equal(settings.windowWidth, DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE.width)
  assert.equal(settings.windowHeight, DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE.height)
})

test('desktop lyric palette presets and custom colors resolve independently', () => {
  assert.deepEqual(resolveDesktopLyricsPaletteColors(DEFAULT_DESKTOP_LYRICS_SETTINGS), {
    active: '#f3a6a6',
    inactive: '#f4e4df'
  })
  assert.deepEqual(
    resolveDesktopLyricsPaletteColors({
      ...DEFAULT_DESKTOP_LYRICS_SETTINGS,
      palette: 'custom',
      customActiveColor: '#123456',
      customInactiveColor: '#654321'
    }),
    { active: '#123456', inactive: '#654321' }
  )
})

test('active lookup and alternating slots never retain a previous line', () => {
  assert.equal(findDesktopLyricsActiveIndex(lines, 500), -1)
  assert.equal(findDesktopLyricsActiveIndex(lines, 2500), 1)
  const first = resolveDesktopLyricsSlots(lines, 0)
  assert.equal(first[0].line?.id, 'a')
  assert.equal(first[1].line?.id, 'b')
  assert.equal(first[0].active, true)
  const second = resolveDesktopLyricsSlots(lines, 1)
  assert.equal(second[0].line?.id, 'c')
  assert.equal(second[1].line?.id, 'b')
  assert.equal(second[1].active, true)
})

test('line and word timing use explicit boundaries before fallbacks', () => {
  assert.equal(desktopLyricsLineEnd(lines, 0), 2000)
  assert.equal(desktopLyricsLineEnd(lines, 2), 3600)
  assert.equal(desktopLyricsWordProgress({ text: 'a', startMs: 100, endMs: 300 }, 200), 0.5)
})

test('same timestamps choose the later row while untimed and trailing rows remain stable', () => {
  const edgeLines: DesktopLyricsLine[] = [
    { id: 'plain', startMs: null, endMs: null, text: 'credit' },
    { id: 'first', startMs: 1000, endMs: null, text: 'first' },
    { id: 'second', startMs: 1000, endMs: null, text: 'second' },
    { id: 'last', startMs: 2500, endMs: null, text: 'last' }
  ]
  assert.equal(findDesktopLyricsActiveIndex(edgeLines, 1000), 2)
  assert.equal(desktopLyricsLineEnd(edgeLines, 0), null)
  assert.equal(desktopLyricsLineEnd(edgeLines, 3), 6500)
})

test('long-line fitting bottoms out at seventy-two percent', () => {
  assert.equal(desktopLyricsFitScale(800, 400), 0.72)
  assert.equal(desktopLyricsFitScale(800, 720), 0.9)
  assert.equal(desktopLyricsFitScale(400, 800), 1)
})

test('clock gate rejects old sessions, epochs, and sequences', () => {
  const base: DesktopLyricsClockSnapshot = {
    schemaVersion: 1,
    sessionId: 'session-a',
    sequence: 4,
    epoch: 2,
    positionMs: 1000,
    durationMs: 4000,
    rate: 1,
    state: 'playing'
  }
  assert.equal(acceptsDesktopLyricsClock(null, base, 'session-a'), true)
  assert.equal(acceptsDesktopLyricsClock(base, { ...base, sessionId: 'old' }, 'session-a'), false)
  assert.equal(
    acceptsDesktopLyricsClock(base, { ...base, epoch: 1, sequence: 99 }, 'session-a'),
    false
  )
  assert.equal(acceptsDesktopLyricsClock(base, { ...base, sequence: 5 }, 'session-a'), true)
})
