import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnimationFrameFallbackScheduler } from './animationFrameFallback.ts'
import {
  createLyricViewportController,
  type LyricRowElement,
  type LyricStageElement
} from './lyricViewportController.ts'

const ROW_HEIGHT = 72
const STAGE_HEIGHT = 180

interface FakeRow extends LyricRowElement {
  properties: Map<string, string>
}

function createStage(height = STAGE_HEIGHT): LyricStageElement {
  return { clientHeight: height, clientWidth: 1440 }
}

function createRow(height = ROW_HEIGHT, scrollHeight = height): FakeRow {
  const properties = new Map<string, string>()
  return {
    offsetHeight: height,
    scrollHeight,
    isConnected: true,
    properties,
    style: {
      setProperty: (property, value) => properties.set(property, value),
      removeProperty: (property) => properties.delete(property)
    }
  }
}

function createManualScheduler(): {
  scheduler: AnimationFrameFallbackScheduler
  runFrame: () => void
  runFrames: (count: number) => void
  pendingFrames: () => number
  runTimeouts: () => void
} {
  const frames = new Map<number, FrameRequestCallback>()
  const timeouts = new Map<number, () => void>()
  let handle = 0
  let now = 1000

  return {
    scheduler: {
      request: (callback) => {
        handle += 1
        frames.set(handle, callback)
        return handle
      },
      cancel: (target) => frames.delete(target),
      scheduleTimeout: (callback) => {
        handle += 1
        timeouts.set(handle, callback)
        return handle
      },
      clearTimeout: (target) => timeouts.delete(target),
      now: () => now
    },
    runFrame: () => {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined
      if (!next) return
      frames.delete(next[0])
      now += 1000 / 60
      next[1](now)
    },
    runFrames: (count) => {
      for (let index = 0; index < count; index += 1) {
        const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined
        if (!next) return
        frames.delete(next[0])
        now += 1000 / 60
        next[1](now)
      }
    },
    pendingFrames: () => frames.size,
    runTimeouts: () => {
      const pending = [...timeouts.values()]
      timeouts.clear()
      for (const callback of pending) callback()
    }
  }
}

interface Harness {
  controller: ReturnType<typeof createLyricViewportController>
  rows: FakeRow[]
  manual: ReturnType<typeof createManualScheduler>
  manualBrowseStates: boolean[]
  activeIndex: { value: number }
}

function harness(rowCount = 8, overrides: Record<string, unknown> = {}): Harness {
  const manual = createManualScheduler()
  const manualBrowseStates: boolean[] = []
  const activeIndex = { value: 0 }
  const rows = Array.from({ length: rowCount }, () => createRow())

  const controller = createLyricViewportController({
    afterLayout: async () => {},
    onManualBrowseChange: (active) => manualBrowseStates.push(active),
    getActiveIndex: () => activeIndex.value,
    alignPosition: 0.5,
    frameScheduler: manual.scheduler,
    ...overrides
  })

  controller.attach(createStage())
  controller.activate('track-a')
  rows.forEach((row, index) => controller.registerRow(index, row))

  return { controller, rows, manual, manualBrowseStates, activeIndex }
}

test('each line gets its own target, so lines are no longer one rigid block', async () => {
  const { controller, activeIndex } = harness()
  activeIndex.value = 3
  await controller.follow(3, { mode: 'snap' })

  const tops = [0, 1, 2, 3, 4].map((index) => controller.getRowTop(index) as number)
  for (let index = 1; index < tops.length; index += 1) {
    assert.ok(tops[index] > tops[index - 1], `line ${index} should sit below line ${index - 1}`)
    assert.ok(
      Math.abs(tops[index] - tops[index - 1] - ROW_HEIGHT) < 1e-6,
      'consecutive lines are one row apart'
    )
  }
})

test('rows use their full scroll height when layered vocals exceed the button box', async () => {
  const { controller, activeIndex } = harness(0)
  controller.registerRow(0, createRow(72, 154))
  controller.registerRow(1, createRow(72, 72))
  activeIndex.value = 0

  await controller.follow(0, { mode: 'snap' })

  const firstTop = controller.getRowTop(0) as number
  const secondTop = controller.getRowTop(1) as number
  assert.equal(secondTop - firstTop, 154)
})

test('a configured row gap preserves breathing room between scaled lyric groups', async () => {
  const { controller, activeIndex } = harness(0, { getRowGapPx: () => 10 })
  controller.registerRow(0, createRow(72, 154))
  controller.registerRow(1, createRow(72, 72))
  activeIndex.value = 0

  await controller.follow(0, { mode: 'snap' })

  const firstTop = controller.getRowTop(0) as number
  const secondTop = controller.getRowTop(1) as number
  assert.equal(secondTop - firstTop, 164)
})

test('resize remeasures responsive row content before stacking following rows', async () => {
  const { controller, manual, activeIndex } = harness(0, { getRowGapPx: () => 10 })
  const responsiveRow = createRow(72, 154)
  controller.registerRow(0, responsiveRow)
  controller.registerRow(1, createRow(72, 72))
  activeIndex.value = 0
  await controller.follow(0, { mode: 'snap' })

  responsiveRow.scrollHeight = 200
  controller.onResize('snap')
  manual.runFrame()
  await Promise.resolve()

  const firstTop = controller.getRowTop(0) as number
  const secondTop = controller.getRowTop(1) as number
  assert.equal(secondTop - firstTop, 210)
  assert.equal(manual.pendingFrames(), 0, 'responsive geometry should not animate through overlap')
})

test('the anchored line lands at the align position', async () => {
  const { controller, activeIndex } = harness()
  activeIndex.value = 3
  await controller.follow(3, { mode: 'snap' })

  // 0.5 of 180 = 90, minus half a row = 54.
  assert.ok(Math.abs((controller.getRowTop(3) as number) - 54) < 1e-6)
})

test('reserved bottom space lifts the anchor above the overlay', async () => {
  const { controller, activeIndex } = harness(8, { getBottomReservedPx: () => 48 })
  activeIndex.value = 3
  await controller.follow(3, { mode: 'snap' })

  // Visible height 180 - 48 = 132; 0.5 of that is 66, minus half a row = 30.
  assert.ok(Math.abs((controller.getRowTop(3) as number) - 30) < 1e-6)
})

test('lines depart in sequence rather than as one block, which is the cascade', async () => {
  const { controller, manual, activeIndex } = harness(10)
  activeIndex.value = 0
  await controller.follow(0, { mode: 'snap' })

  // Anchor 0 stacks rows at 54 + 72i.
  const restingSeven = controller.getRowTop(7) as number
  assert.ok(Math.abs(restingSeven - (54 + 72 * 7)) < 1e-6)

  activeIndex.value = 5
  await controller.follow(5)
  manual.runFrames(3)

  // A spring whose delay has not elapsed still reports its *previous* target, so
  // comparing targets shows exactly which lines have been released so far. A
  // rigid block would release every line on the same frame.
  const releasedTarget = controller.getRowTargetTop(4) as number
  const pendingTarget = controller.getRowTargetTop(7) as number

  assert.ok(Math.abs(releasedTarget - -18) < 1e-6, 'the first visible line has already departed')
  assert.ok(
    Math.abs(pendingTarget - restingSeven) < 1e-6,
    'a line further down is still waiting its turn'
  )

  manual.runFrames(400)
  assert.ok(
    Math.abs((controller.getRowTop(7) as number) - (-306 + 72 * 7)) < 1,
    'every line still arrives at its place'
  )
})

test('line movement reaches its target without bouncing back', async () => {
  const { controller, manual, activeIndex } = harness(10)
  activeIndex.value = 8
  await controller.follow(8, { mode: 'snap' })

  activeIndex.value = 0
  await controller.follow(0)

  const target = controller.getRowTargetTop(0) as number
  let bouncedBack = false
  for (let frame = 0; frame < 200; frame += 1) {
    manual.runFrame()
    const top = controller.getRowTop(0) as number
    if (top > target + 0.01) bouncedBack = true
  }

  assert.ok(!bouncedBack, 'a lyric line must not reverse past its target')
  assert.ok(Math.abs((controller.getRowTop(0) as number) - target) < 1, 'it still settles')
})

test('the first lyric layout snaps into place instead of falling from the top', async () => {
  const { controller, manual, activeIndex } = harness(8)
  activeIndex.value = 4

  await controller.follow(4)

  assert.equal(manual.pendingFrames(), 0, 'the first layout must not animate from the row default')
  assert.equal(controller.getRowTop(4), controller.getRowTargetTop(4))
})

test('scale trails position, so the motion is not perfectly rigid', async () => {
  const { controller, manual, activeIndex } = harness(10)
  activeIndex.value = 0
  await controller.follow(0, { mode: 'snap' })
  const restingScale = controller.getRowScale(1) as number

  activeIndex.value = 1
  await controller.follow(1)
  manual.runFrames(2)

  const scale = controller.getRowScale(1) as number
  assert.notEqual(scale, restingScale, 'the scale spring is moving')
  assert.ok(scale > 100 && scale < 104, 'and has not snapped straight to the active size')
})

test('snap mode places lines without consuming a frame', async () => {
  const { controller, manual, activeIndex } = harness()
  activeIndex.value = 4
  await controller.follow(4, { mode: 'snap' })

  assert.equal(manual.pendingFrames(), 0, 'a snap must not schedule animation')
  assert.equal(controller.getRowTop(4), controller.getRowTargetTop(4))
})

test('reduced motion snaps and drops blur entirely', async () => {
  const { controller, rows, manual, activeIndex } = harness(8, {
    isSpringEnabled: () => false,
    isBlurEnabled: () => false
  })
  activeIndex.value = 3
  await controller.follow(3)

  assert.equal(manual.pendingFrames(), 0, 'no animation frames when springs are off')
  assert.equal(controller.getRowTop(3), controller.getRowTargetTop(3))
  assert.equal(rows[0].properties.get('--lyric-line-blur'), '0.000px')
})

test('a track switch drops stale rows and resets browsing', async () => {
  const { controller, activeIndex } = harness()
  activeIndex.value = 5
  await controller.follow(5, { mode: 'snap' })
  assert.ok((controller.getRowTop(5) as number) !== 0)

  controller.activate('track-b')
  assert.equal(controller.getRowTop(5), null, 'rows from the previous track are gone')
  assert.equal(controller.trackId(), 'track-b')
  assert.equal(controller.getScrollOffset(), 0)
})

test('a layout pass belonging to a previous track cannot move the new one', async () => {
  const manual = createManualScheduler()
  const activeIndex = { value: 5 }
  let releaseLayout: (() => void) | null = null
  const firstLayout = new Promise<void>((resolve) => {
    releaseLayout = resolve
  })
  let layoutCalls = 0

  const controller = createLyricViewportController({
    afterLayout: async () => {
      layoutCalls += 1
      if (layoutCalls === 1) await firstLayout
    },
    onManualBrowseChange: () => {},
    getActiveIndex: () => activeIndex.value,
    alignPosition: 0.5,
    frameScheduler: manual.scheduler
  })
  controller.attach(createStage())
  controller.activate('track-a')
  controller.registerRow(5, createRow())
  const stale = controller.follow(5, { mode: 'snap' })

  controller.activate('track-b')
  const rowB = createRow()
  controller.registerRow(3, rowB)
  activeIndex.value = 3
  const current = controller.follow(3, { mode: 'snap' })
  ;(releaseLayout as (() => void) | null)?.()
  await Promise.all([stale, current])

  assert.equal(controller.trackId(), 'track-b')
  assert.ok(Math.abs((controller.getRowTop(3) as number) - 54) < 1e-6)
})

test('a newer follow cancels an older one still awaiting layout', async () => {
  const manual = createManualScheduler()
  const activeIndex = { value: 0 }
  let releaseFirst: (() => void) | null = null
  const firstLayout = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let layoutCalls = 0

  const controller = createLyricViewportController({
    afterLayout: async () => {
      layoutCalls += 1
      if (layoutCalls === 1) await firstLayout
    },
    onManualBrowseChange: () => {},
    getActiveIndex: () => activeIndex.value,
    alignPosition: 0.5,
    frameScheduler: manual.scheduler
  })
  controller.attach(createStage())
  controller.activate('track-a')
  controller.registerRow(0, createRow())
  controller.registerRow(5, createRow())

  const stale = controller.follow(0, { mode: 'snap' })
  activeIndex.value = 5
  await controller.follow(5, { mode: 'snap' })
  ;(releaseFirst as (() => void) | null)?.()
  await stale

  // Line 5 is the anchor, so it sits at the align position and line 0 above it.
  assert.ok(Math.abs((controller.getRowTop(5) as number) - 54) < 1e-6)
  assert.ok((controller.getRowTop(0) as number) < 0, 'the stale follow did not win')
})

test('a reused Vue ref clearing an older row keeps the live one', async () => {
  const { controller, activeIndex } = harness()
  const replacement = createRow()
  controller.registerRow(5, replacement)
  // Vue may invoke the previous ref callback with null afterwards.
  controller.registerRow(5, null)

  activeIndex.value = 5
  await controller.follow(5, { mode: 'snap' })
  assert.ok(Math.abs((controller.getRowTop(5) as number) - 54) < 1e-6)
})

test('a disconnected row is dropped when its ref clears', () => {
  const { controller } = harness()
  const stale = createRow()
  stale.isConnected = false
  controller.registerRow(5, stale)
  controller.registerRow(5, null)

  assert.equal(controller.getRowTop(5), null)
})

test('browsing moves the view without native scroll and reports manual mode', async () => {
  const { controller, manualBrowseStates, activeIndex } = harness()
  activeIndex.value = 4
  await controller.follow(4, { mode: 'snap' })
  const before = controller.getRowTop(4) as number

  controller.browseBy(60)
  assert.ok(controller.isManualBrowsing())
  assert.deepEqual(manualBrowseStates, [true])
  assert.equal(controller.getScrollOffset(), 60)
  assert.ok((controller.getRowTargetTop(4) as number) < before, 'the lines moved up')
})

test('browsing is bounded by the content extent', async () => {
  const { controller, activeIndex } = harness()
  activeIndex.value = 4
  await controller.follow(4, { mode: 'snap' })

  controller.browseBy(-100_000)
  const min = controller.getScrollOffset()
  controller.browseBy(-100_000)
  assert.equal(controller.getScrollOffset(), min, 'cannot browse past the top')

  controller.browseBy(100_000)
  const max = controller.getScrollOffset()
  controller.browseBy(100_000)
  assert.equal(controller.getScrollOffset(), max, 'cannot browse past the bottom')
})

test('following is suppressed while browsing and resumes on release', async () => {
  const { controller, manual, manualBrowseStates, activeIndex } = harness()
  activeIndex.value = 2
  await controller.follow(2, { mode: 'snap' })

  controller.beginManualBrowse()
  activeIndex.value = 6
  await controller.follow(6)
  assert.notEqual(controller.getRowTargetTop(6), 54, 'automatic follow must not fight the user')

  controller.releaseManualBrowse()
  await Promise.resolve()
  manual.runFrames(400)

  assert.ok(!controller.isManualBrowsing())
  assert.deepEqual(manualBrowseStates, [true, false])
  assert.equal(controller.getScrollOffset(), 0, 'releasing returns to the followed position')
})

test('browsing releases itself after the idle timeout', async () => {
  const { controller, manual, activeIndex } = harness()
  activeIndex.value = 2
  await controller.follow(2, { mode: 'snap' })

  controller.browseBy(80)
  assert.ok(controller.isManualBrowsing())

  manual.runTimeouts()
  assert.ok(!controller.isManualBrowsing(), 'the view should return to the song on its own')
})

test('automatic following never reports manual browsing', async () => {
  const { controller, manualBrowseStates, activeIndex } = harness()
  for (const index of [0, 2, 5, 7]) {
    activeIndex.value = index
    await controller.follow(index, { mode: 'snap' })
  }
  assert.deepEqual(manualBrowseStates, [])
})

test('content resize recentres once per frame without snapping away lyric motion', async () => {
  const { controller, manual, activeIndex } = harness()
  activeIndex.value = 5
  await controller.follow(5, { mode: 'snap' })
  const before = controller.getRowTop(5) as number

  controller.attach(createStage(400))
  controller.onResize('spring')
  controller.onResize('spring')
  manual.runFrames(1)
  await Promise.resolve()
  manual.runFrames(3)

  const moving = controller.getRowTop(5) as number
  assert.notEqual(moving, before, 'content remeasurement should start the lyric spring')
  assert.ok(Math.abs(moving - 164) > 1.5, 'content remeasurement must not snap to its target')

  manual.runFrames(400)
  // 0.5 of 400 = 200, minus half a row = 164.
  assert.ok(Math.abs((controller.getRowTop(5) as number) - 164) < 1.5)
})

test('resize is ignored while the user is browsing', async () => {
  const { controller, activeIndex } = harness()
  activeIndex.value = 5
  await controller.follow(5, { mode: 'snap' })
  controller.beginManualBrowse()
  const offset = controller.getScrollOffset()

  controller.onResize()
  assert.equal(controller.getScrollOffset(), offset)
  assert.ok(controller.isManualBrowsing())
})

test('presented lines stay unblurred while distant ones recede', async () => {
  const { controller, rows, activeIndex } = harness(8, {
    getBufferedIndices: () => new Set([3])
  })
  activeIndex.value = 3
  await controller.follow(3, { mode: 'snap' })

  assert.equal(rows[3].properties.get('--lyric-line-blur'), '0.000px')
  const near = Number.parseFloat(rows[4].properties.get('--lyric-line-blur') as string)
  const far = Number.parseFloat(rows[7].properties.get('--lyric-line-blur') as string)
  assert.ok(near > 0)
  assert.ok(far > near, 'depth grows with distance')
})

test('lines outside the viewport are marked so they can stop painting', async () => {
  const { controller, rows, activeIndex } = harness(30)
  activeIndex.value = 0
  await controller.follow(0, { mode: 'snap' })

  assert.equal(rows[0].properties.get('--lyric-line-in-sight'), undefined, 'visible by default')
  assert.equal(rows[29].properties.get('--lyric-line-in-sight'), '0', 'far lines are culled')
  assert.ok(
    rows[29].properties.get('--lyric-line-top'),
    'culled lines still keep a layout top so a later browse cannot stack them at y=0'
  )
})

test('browsing does not wait on the cascade, so lines below move with the wheel', async () => {
  const { controller, activeIndex } = harness(10)
  activeIndex.value = 0
  await controller.follow(0, { mode: 'snap' })
  const restingSeven = controller.getRowTargetTop(7) as number

  controller.browseBy(80)
  assert.ok(
    Math.abs((controller.getRowTargetTop(7) as number) - (restingSeven - 80)) < 1e-6,
    'a line further down must retarget immediately rather than waiting its cascade turn'
  )
})

test('culled rows keep their last measured height so browsing cannot collapse them', async () => {
  const { controller, rows, activeIndex } = harness(30)
  activeIndex.value = 0
  await controller.follow(0, { mode: 'snap' })

  for (let index = 8; index < 30; index += 1) {
    rows[index].offsetHeight = 24
  }

  controller.browseBy(400)
  const tops = [18, 19, 20, 21].map((index) => controller.getRowTargetTop(index) as number)
  for (let index = 1; index < tops.length; index += 1) {
    assert.ok(
      Math.abs(tops[index] - tops[index - 1] - ROW_HEIGHT) < 1,
      `browsed lines must stay one row apart; gap=${tops[index] - tops[index - 1]}`
    )
  }
})

test('browsing expands the focus window so distant lines do not share a row', async () => {
  const { controller, activeIndex } = harness(8, {
    getFocusWindow: () => new Set([2, 3, 4]),
    isPlaying: () => true
  })
  activeIndex.value = 3
  await controller.follow(3, { mode: 'snap' })
  assert.equal(
    controller.getRowTargetTop(5),
    controller.getRowTargetTop(7),
    'focus mode collapses outsiders onto the same y'
  )

  controller.browseBy(40)
  assert.ok(
    (controller.getRowTargetTop(7) as number) - (controller.getRowTargetTop(5) as number) >
      ROW_HEIGHT,
    'browsing must give hidden lines their own rows'
  )
})

test('the interlude dots position is published for the view', async () => {
  const { controller, activeIndex } = harness(8, {
    getInterludeAfterIndex: () => 2,
    getInterludeDotsHeight: () => 20,
    getBufferedIndices: () => new Set<number>()
  })
  activeIndex.value = 2
  await controller.follow(2, { mode: 'snap' })

  assert.ok(typeof controller.getInterludeDotsTop() === 'number')
})

test('disposing releases rows, browsing and pending work', async () => {
  const { controller, manual, activeIndex } = harness()
  activeIndex.value = 3
  await controller.follow(3)
  controller.beginManualBrowse()

  controller.dispose()
  assert.equal(controller.trackId(), '')
  assert.equal(controller.getRowTop(3), null)
  assert.ok(!controller.isManualBrowsing())

  manual.runFrames(5)
  assert.equal(controller.getRowTop(3), null)
})

test('following a negative index is a no-op', async () => {
  const { controller, manual } = harness()
  await controller.follow(-1)

  // Rows exist but were never laid out, so they sit at their initial position
  // and nothing was scheduled.
  assert.equal(controller.getRowTop(0), 0)
  assert.equal(manual.pendingFrames(), 0)
})

test('untimed lyrics still receive a snap layout when no row is active', async () => {
  const { controller, activeIndex, rows } = harness()
  activeIndex.value = -1

  await controller.recenter('snap')

  assert.ok((controller.getRowTop(1) as number) > (controller.getRowTop(0) as number))
  assert.equal(rows[0].properties.get('--lyric-line-ready'), '1')
  assert.equal(rows[1].properties.get('--lyric-line-ready'), '1')
})
