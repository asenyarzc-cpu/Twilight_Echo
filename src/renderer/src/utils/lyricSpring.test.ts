import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LYRIC_BG_SCALE_SPRING,
  LYRIC_POS_Y_SPRING,
  LYRIC_SCALE_SPRING,
  LyricSpring,
  solveLyricSpring
} from './lyricSpring.ts'

const FRAME = 1 / 60

function advance(spring: LyricSpring, frames: number): number[] {
  const positions: number[] = []
  for (let index = 0; index < frames; index += 1) {
    spring.update(FRAME)
    positions.push(spring.getCurrentPosition())
  }
  return positions
}

test('the vertical spring reaches its destination without bouncing back', () => {
  const spring = new LyricSpring(0, LYRIC_POS_Y_SPRING)
  spring.setTargetPosition(100)
  const positions = advance(spring, 240)

  assert.ok(Math.max(...positions) <= 100 + 1e-9, 'a lyric line must not pass its target')
  assert.ok(
    Math.abs(spring.getCurrentPosition() - 100) < 0.01,
    'the line must still settle exactly on target'
  )
})

test('the scale spring trails the vertical spring instead of moving in lockstep', () => {
  const posY = new LyricSpring(0, LYRIC_POS_Y_SPRING)
  const scale = new LyricSpring(0, LYRIC_SCALE_SPRING)
  posY.setTargetPosition(100)
  scale.setTargetPosition(100)

  advance(posY, 20)
  advance(scale, 20)

  // Same target, same elapsed time: scale must still be behind. That phase
  // offset is what keeps the motion from reading as a rigid block.
  assert.ok(
    posY.getCurrentPosition() > scale.getCurrentPosition(),
    'scale should lag vertical travel'
  )
})

test('background voices settle without overshooting', () => {
  const spring = new LyricSpring(0, LYRIC_BG_SCALE_SPRING)
  spring.setTargetPosition(75)
  const positions = advance(spring, 300)

  assert.ok(Math.max(...positions) <= 75 + 1e-9, 'an overdamped spring must not overshoot')
  assert.ok(Math.abs(spring.getCurrentPosition() - 75) < 0.01)
})

test('retargeting mid-flight carries the in-flight velocity', () => {
  const spring = new LyricSpring(0, LYRIC_POS_Y_SPRING)
  spring.setTargetPosition(100)
  advance(spring, 6)

  const beforeReverse = spring.getCurrentPosition()
  assert.ok(beforeReverse > 0 && beforeReverse < 100)
  assert.ok(spring.getCurrentVelocity() > 0)

  spring.setTargetPosition(0)
  spring.update(FRAME)

  assert.ok(
    spring.getCurrentPosition() > beforeReverse,
    'momentum should carry the line forward for a frame before it reverses'
  )
})

test('a delayed retarget holds position until the delay elapses', () => {
  const spring = new LyricSpring(0, LYRIC_POS_Y_SPRING)
  spring.setTargetPosition(100, 0.2)

  assert.ok(spring.hasQueuedWork())
  advance(spring, 6)
  assert.equal(spring.getCurrentPosition(), 0, 'the line must not move during its delay')

  advance(spring, 60)
  assert.ok(spring.getCurrentPosition() > 50, 'the line must move once the delay expires')
  assert.ok(!spring.hasQueuedWork())
})

test('staggered delays make later lines trail earlier ones', () => {
  // This is the cascade in miniature: identical springs, delays only.
  const lines = [0, 0.05, 0.1].map((delay) => {
    const spring = new LyricSpring(0, LYRIC_POS_Y_SPRING)
    spring.setTargetPosition(100, delay)
    return spring
  })
  for (const spring of lines) advance(spring, 9)

  const [first, second, third] = lines.map((spring) => spring.getCurrentPosition())
  assert.ok(first > second, 'the second line should trail the first')
  assert.ok(second > third, 'the third line should trail the second')
})

test('setPosition jumps without animating and clears momentum', () => {
  const spring = new LyricSpring(0, LYRIC_POS_Y_SPRING)
  spring.setTargetPosition(100)
  advance(spring, 6)
  assert.notEqual(spring.getCurrentVelocity(), 0)

  spring.setPosition(42)
  assert.equal(spring.getCurrentPosition(), 42)
  assert.equal(spring.getTargetPosition(), 42)
  assert.equal(spring.getCurrentVelocity(), 0)
  assert.ok(spring.arrived())

  spring.update(FRAME)
  assert.equal(spring.getCurrentPosition(), 42, 'a settled spring must stay put')
})

test('a negligible retarget is ignored so settled lines do not re-solve', () => {
  const spring = new LyricSpring(10, LYRIC_POS_Y_SPRING)
  spring.setTargetPosition(10.0001)
  assert.ok(!spring.hasQueuedWork())
  assert.equal(spring.getCurrentPosition(), 10)
})

test('a queued delay can be superseded by an immediate retarget', () => {
  const spring = new LyricSpring(0, LYRIC_POS_Y_SPRING)
  spring.setTargetPosition(100, 0.5)
  spring.setTargetPosition(-50)

  assert.ok(!spring.hasQueuedWork(), 'an immediate retarget must drop the queued one')
  assert.equal(spring.getTargetPosition(), -50)
})

test('the solver holds the start value for negative time', () => {
  const solver = solveLyricSpring(5, 0, 100, LYRIC_POS_Y_SPRING)
  assert.equal(solver(-1), 5)

  const overdamped = solveLyricSpring(5, 0, 100, LYRIC_BG_SCALE_SPRING)
  assert.equal(overdamped(-1), 5)
})

test('soft mode forces the non-oscillating branch', () => {
  const spring = new LyricSpring(0, { ...LYRIC_POS_Y_SPRING, soft: true })
  spring.setTargetPosition(100)
  const positions = advance(spring, 300)

  assert.ok(Math.max(...positions) <= 100 + 1e-9, 'soft mode must not oscillate')
})
