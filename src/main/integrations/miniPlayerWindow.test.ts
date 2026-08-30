import assert from 'node:assert/strict'
import test from 'node:test'
import type { Rectangle } from 'electron'

import {
  MINI_PLAYER_MAX_HEIGHT,
  MINI_PLAYER_MAX_WIDTH,
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH,
  clampMiniPlayerBoundsToWorkArea,
  miniPlayerBoundsPatch
} from './miniPlayerWindow.ts'

test('mini player window shape removes the transparent corner regions', async () => {
  const module = (await import('./miniPlayerWindow.ts')) as unknown as {
    createMiniPlayerWindowShape?: (
      width: number,
      height: number,
      cornerRadius: number
    ) => Rectangle[]
  }

  assert.equal(typeof module.createMiniPlayerWindowShape, 'function')
  const shape = module.createMiniPlayerWindowShape!(200, 100, 20)
  assert.ok(
    shape.some((rectangle) => rectangle.x === 0 && rectangle.y === 20 && rectangle.height === 60)
  )
  assert.equal(
    shape.some((rectangle) => rectangle.x === 0 && rectangle.y === 0),
    false
  )
  const topRow = shape.find((rectangle) => rectangle.y === 0)
  assert.ok(topRow)
  assert.ok(topRow!.x >= 1)
  assert.ok(topRow!.width <= 200 - topRow!.x * 2)
})

test('mini player window shape stays outside the CSS rounded surface', async () => {
  const module = (await import('./miniPlayerWindow.ts')) as unknown as {
    createMiniPlayerWindowShape?: (
      width: number,
      height: number,
      cornerRadius: number
    ) => Rectangle[]
  }

  // The OS region cannot anti-alias, so it must be strictly less round than the
  // CSS border-radius: the stair-step cut then hides in the transparent rim
  // instead of becoming the visible (jagged) window edge.
  const cssRadius = 25
  const safetyShape = module.createMiniPlayerWindowShape!(200, 100, cssRadius - 2)
  const cssShape = module.createMiniPlayerWindowShape!(200, 100, cssRadius)
  const safetyTopRow = safetyShape.find((rectangle) => rectangle.y === 0)
  const cssTopRow = cssShape.find((rectangle) => rectangle.y === 0)
  assert.ok(safetyTopRow)
  assert.ok(cssTopRow)
  assert.ok(safetyTopRow!.x < cssTopRow!.x)
  assert.ok(safetyTopRow!.width > cssTopRow!.width)
})

test('mini player bounds clamp size before position inside a display work area', () => {
  const bounds = clampMiniPlayerBoundsToWorkArea(
    { x: -500, y: -200, width: 1400, height: 50 },
    { x: 0, y: 0, width: 800, height: 600 }
  )
  assert.deepEqual(bounds, {
    x: 0,
    y: 0,
    width: Math.min(MINI_PLAYER_MAX_WIDTH, 800),
    height: MINI_PLAYER_MIN_HEIGHT
  })
})

test('mini player bounds enforce the minimum supported window size', () => {
  const bounds = clampMiniPlayerBoundsToWorkArea(
    { x: 120, y: 80, width: 1, height: 1 },
    { x: 0, y: 0, width: 1920, height: 1040 }
  )
  assert.deepEqual(bounds, {
    x: 120,
    y: 80,
    width: MINI_PLAYER_MIN_WIDTH,
    height: MINI_PLAYER_MIN_HEIGHT
  })
})

test('mini player bounds support negative monitor coordinates', () => {
  const bounds = clampMiniPlayerBoundsToWorkArea(
    { x: -3000, y: 90, width: 520, height: 220 },
    { x: -1920, y: 0, width: 1920, height: 1040 }
  )
  assert.deepEqual(bounds, { x: -1920, y: 90, width: 520, height: 220 })
})

test('mini player bounds patch persists position and size together', () => {
  assert.deepEqual(miniPlayerBoundsPatch({ x: 20, y: 30, width: 700, height: 260 }), {
    windowX: 20,
    windowY: 30,
    windowWidth: 700,
    windowHeight: 260
  })
  assert.equal(MINI_PLAYER_MIN_WIDTH, 420)
  assert.equal(MINI_PLAYER_MIN_HEIGHT, 220)
  assert.equal(MINI_PLAYER_MAX_WIDTH, 900)
  assert.equal(MINI_PLAYER_MAX_HEIGHT, 520)
})
