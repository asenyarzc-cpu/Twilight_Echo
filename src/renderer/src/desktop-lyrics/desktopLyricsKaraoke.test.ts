import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDesktopLyricsKaraokePlan, desktopLyricsKaraokeTime } from './desktopLyricsKaraoke.ts'

test('desktop lyric karaoke plans fill each word with a linear compositor timeline', () => {
  const plan = buildDesktopLyricsKaraokePlan(
    { text: 'Echo', startMs: 1280, endMs: 1760 },
    1000,
    'horizontal'
  )

  assert.equal(plan.maskSize, '200% 100%')
  assert.deepEqual(plan.keyframes, [{ maskPosition: '100% 0' }, { maskPosition: '0 0' }])
  assert.equal(plan.timing.delay, 280)
  assert.equal(plan.timing.duration, 480)
  assert.equal(plan.timing.easing, 'linear')
})

test('vertical desktop lyric karaoke fills from top to bottom', () => {
  const plan = buildDesktopLyricsKaraokePlan(
    { text: '朝', startMs: 300, endMs: 500 },
    0,
    'vertical'
  )

  assert.equal(plan.maskSize, '100% 200%')
  assert.deepEqual(plan.keyframes, [{ maskPosition: '0 100%' }, { maskPosition: '0 0' }])
  assert.equal(desktopLyricsKaraokeTime(850, 1000), 0)
  assert.equal(desktopLyricsKaraokeTime(1350, 1000), 350)
})
