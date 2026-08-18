import assert from 'node:assert/strict'
import test from 'node:test'
import type { LyricLine, LyricVoiceLayer } from './lyrics.ts'
import { physicalLyricLane, resolveLyricVoiceLayout } from './lyricVoiceLayout.ts'

function voice(partial: Partial<LyricVoiceLayer> & Pick<LyricVoiceLayer, 'voiceKey' | 'text'>) {
  return {
    role: 'lead' as const,
    lane: 'center' as const,
    time: 1,
    ...partial
  }
}

function line(voices?: LyricVoiceLayer[]): LyricLine {
  return {
    time: 1,
    text: 'fallback',
    translation: '翻译',
    romanization: null,
    timed: true,
    voices
  }
}

test('unmarked lyrics fall back to one centered lead voice', () => {
  const layout = resolveLyricVoiceLayout(line())
  assert.equal(layout.center.length, 1)
  assert.equal(layout.center[0].text, 'fallback')
  assert.equal(layout.hasDuet, false)
})

test('explicit start and end leads form a duet without inferring other lines', () => {
  const layout = resolveLyricVoiceLayout(
    line([
      voice({ voiceKey: 'a', text: 'left', lane: 'start' }),
      voice({ voiceKey: 'b', text: 'right', lane: 'end' }),
      voice({ voiceKey: 'c', text: 'harmony', lane: 'end', role: 'harmony', time: 1.5 })
    ])
  )
  assert.equal(layout.start[0].text, 'left')
  assert.deepEqual(
    layout.end.map((entry) => entry.text),
    ['right', 'harmony']
  )
  assert.equal(layout.hasDuet, true)
  assert.match(layout.ariaText, /left；right；harmony。翻译/)
})

test('RTL mirrors physical start and end without reversing logical reading order', () => {
  assert.equal(physicalLyricLane('start', 'rtl'), 'end')
  assert.equal(physicalLyricLane('end', 'rtl'), 'start')
  assert.equal(physicalLyricLane('center', 'rtl'), 'center')

  const layout = resolveLyricVoiceLayout(
    line([
      voice({ voiceKey: 'first', text: 'first', lane: 'start', time: 1 }),
      voice({ voiceKey: 'second', text: 'second', lane: 'end', time: 2 })
    ]),
    'rtl'
  )
  assert.equal(layout.end[0].text, 'first')
  assert.equal(layout.start[0].text, 'second')
  assert.deepEqual(
    layout.ordered.map((entry) => entry.text),
    ['first', 'second']
  )
})
