import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LIQUID_GLASS_PRESS_TARGET_SCALE,
  LiquidGlassPressController,
  liquidGlassPressCssVariables,
  resolvePressGlow
} from './liquidGlassPress.ts'

function advance(controller: LiquidGlassPressController, seconds: number, step = 1 / 120) {
  let state = controller.update(0)
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    state = controller.update(step)
  }
  return state
}

test('press compresses the surface toward the target scale', () => {
  const controller = new LiquidGlassPressController()
  controller.press()
  const early = advance(controller, 0.06)
  assert.ok(early.scale < 0.985, `scale should be dropping, was ${early.scale}`)
  assert.ok(early.scale >= LIQUID_GLASS_PRESS_TARGET_SCALE - 0.01, 'overshoot stays subtle')

  const settled = advance(controller, 0.5)
  assert.ok(
    Math.abs(settled.scale - LIQUID_GLASS_PRESS_TARGET_SCALE) < 0.01,
    `scale should settle at ${LIQUID_GLASS_PRESS_TARGET_SCALE}, was ${settled.scale}`
  )
  assert.ok(settled.settled, 'press spring settles')
})

test('release returns to rest without crossing far past 1', () => {
  const controller = new LiquidGlassPressController()
  controller.press()
  advance(controller, 0.2)
  controller.release()
  const state = advance(controller, 0.6)
  assert.ok(Math.abs(state.scale - 1) < 0.01, `scale should be back at 1, was ${state.scale}`)
  assert.ok(state.settled, 'release spring settles')
})

test('releasing mid-flight keeps the current value instead of jumping', () => {
  const controller = new LiquidGlassPressController()
  controller.press()
  const midPress = advance(controller, 0.08)
  controller.release()
  const justAfter = controller.update(1 / 120)
  assert.ok(
    Math.abs(justAfter.scale - midPress.scale) < 0.01,
    `retarget should be continuous: ${midPress.scale} -> ${justAfter.scale}`
  )
})

test('re-pressing mid-release carries momentum', () => {
  const controller = new LiquidGlassPressController()
  controller.press()
  advance(controller, 0.3)
  controller.release()
  const releasing = advance(controller, 0.05)
  controller.press()
  const rePressed = advance(controller, 0.03)
  assert.ok(
    rePressed.scale <= releasing.scale + 0.01,
    're-press keeps travelling toward the pressed scale'
  )
})

test('glow tracks press progress and clamps to [0, 1]', () => {
  assert.equal(resolvePressGlow(1), 0, 'rest has no glow')
  assert.ok(resolvePressGlow(LIQUID_GLASS_PRESS_TARGET_SCALE) > 0.99, 'full press glows')
  assert.equal(resolvePressGlow(0.5), 1, 'overshoot clamps at 1')
  assert.equal(resolvePressGlow(1.2), 0, 'release overshoot clamps at 0')
})

test('reset jumps to rest without animating', () => {
  const controller = new LiquidGlassPressController()
  controller.press()
  advance(controller, 0.1)
  controller.reset()
  const state = controller.update(1 / 120)
  assert.equal(state.scale, 1)
  assert.ok(state.settled, 'reset state is settled')
  assert.ok(!controller.isPressed(), 'reset clears the pressed target')
})

test('isPressed reflects the spring target', () => {
  const controller = new LiquidGlassPressController()
  assert.ok(!controller.isPressed())
  controller.press()
  assert.ok(controller.isPressed())
  controller.release()
  assert.ok(!controller.isPressed())
})

test('css variables carry numeric scale and three-decimal glow', () => {
  const variables = liquidGlassPressCssVariables(0.9781)
  assert.equal(Object.keys(variables).length, 2)
  assert.ok(!Number.isNaN(Number.parseFloat(variables['--te-lg-press-scale'])))
  assert.equal(variables['--te-lg-press-scale'], '0.9781')
  assert.equal(variables['--te-lg-press-glow'], '0.548')
})
