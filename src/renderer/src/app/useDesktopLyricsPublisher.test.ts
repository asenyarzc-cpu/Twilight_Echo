import assert from 'node:assert/strict'
import test from 'node:test'
import { projectDesktopLyricsLines } from '../utils/desktopLyricsProjection.ts'

test('publisher converts the canonical timeline without carrying raw lyric formats', () => {
  const lines = projectDesktopLyricsLines([
    {
      time: 1,
      text: 'Hello',
      translation: '你好',
      romanization: null,
      timed: true,
      words: [
        { text: 'Hel', time: 1, endTime: 1.4 },
        { text: 'lo', time: 1.4, endTime: null }
      ]
    },
    { time: 2, text: 'World', translation: null, romanization: null, timed: true }
  ])
  assert.deepEqual(lines[0], {
    id: '0:1000',
    startMs: 1000,
    endMs: 2000,
    text: 'Hello',
    translation: '你好',
    words: [
      { text: 'Hel', startMs: 1000, endMs: 1400 },
      { text: 'lo', startMs: 1400, endMs: 2000 }
    ]
  })
})
