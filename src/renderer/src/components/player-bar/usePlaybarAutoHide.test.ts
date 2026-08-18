import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { effectScope, nextTick, ref, type Ref } from 'vue'

import { shouldRevealForPointer, usePlaybarAutoHide } from './usePlaybarAutoHide.ts'

test('reveal test compares the pointer against the bottom band', () => {
  // 800px viewport, 120px band: the band starts at y = 680.
  assert.equal(shouldRevealForPointer(700, 800, 120), true)
  assert.equal(shouldRevealForPointer(680, 800, 120), true, 'boundary is inclusive')
  assert.equal(shouldRevealForPointer(679, 800, 120), false)
  assert.equal(shouldRevealForPointer(0, 800, 120), false)
  // Below the viewport edge (pointer capture during a drag) still counts as inside.
  assert.equal(shouldRevealForPointer(820, 800, 120), true)
})

test('reveal test refuses to fire on missing or nonsensical input', () => {
  assert.equal(shouldRevealForPointer(Number.NaN, 800, 120), false)
  assert.equal(shouldRevealForPointer(700, Number.NaN, 120), false)
  assert.equal(shouldRevealForPointer(700, 800, Number.NaN), false)
  assert.equal(shouldRevealForPointer(700, Number.POSITIVE_INFINITY, 120), false)
  assert.equal(shouldRevealForPointer(700, 800, -1), false)
  // A zero threshold is legal: only the very last row reveals.
  assert.equal(shouldRevealForPointer(800, 800, 0), true)
  assert.equal(shouldRevealForPointer(799, 800, 0), false)
})

class FakeNode {}

/** Minimal element stand-in: `contains` is all the hook asks of the bar. */
class FakeElement extends FakeNode {
  private readonly kids = new Set<FakeNode>()
  adopt(child: FakeNode): FakeNode {
    this.kids.add(child)
    return child
  }
  contains(node: FakeNode): boolean {
    return node === this || this.kids.has(node)
  }
}

interface Harness {
  revealed: () => boolean
  movePointer: (clientY: number) => void
  leaveDocument: () => void
  blurWindow: () => void
  setHidden: (hidden: boolean) => void
  listenerCount: () => number
  dispose: () => void
}

function createHarness(options: {
  autoHide: Ref<boolean>
  keepOpen?: Ref<boolean>
  revealThresholdPx?: number
  hideDelayMs?: number
  bar?: FakeElement
}): Harness & { hook: ReturnType<typeof usePlaybarAutoHide> } {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const add = (type: string, fn: (event: unknown) => void): void => {
    const set = listeners.get(type) ?? new Set()
    set.add(fn)
    listeners.set(type, set)
  }
  const remove = (type: string, fn: (event: unknown) => void): void => {
    listeners.get(type)?.delete(fn)
  }
  const emit = (type: string, event: unknown): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
  }

  const frames: Array<() => void> = []
  const g = globalThis as Record<string, unknown>
  g.Node = FakeNode
  g.window = { innerHeight: 800, addEventListener: add, removeEventListener: remove }
  g.document = { hidden: false, addEventListener: add, removeEventListener: remove }
  // Run the coalesced frame immediately so a pointer move settles within the test.
  g.requestAnimationFrame = (cb: () => void): number => {
    frames.push(cb)
    return frames.length
  }
  g.cancelAnimationFrame = (): void => {
    frames.length = 0
  }

  const flushFrames = (): void => {
    const pending = frames.splice(0, frames.length)
    for (const cb of pending) cb()
  }

  // The hook registers onBeforeUnmount, which Vue warns about outside a component
  // instance. Teardown is covered by the autoHide=false path instead, so the warning
  // is noise here — swallow just that one line rather than the whole channel.
  const scope = effectScope()
  const realWarn = console.warn
  console.warn = (...parts: unknown[]): void => {
    if (typeof parts[0] === 'string' && parts[0].includes('onBeforeUnmount')) return
    realWarn(...parts)
  }
  const hook = scope.run(() =>
    usePlaybarAutoHide({
      autoHide: options.autoHide as Ref<boolean>,
      keepOpen: options.keepOpen ?? ref(false),
      revealThresholdPx: ref(options.revealThresholdPx ?? 120),
      hideDelayMs: ref(options.hideDelayMs ?? 900),
      barRef: ref(options.bar ?? null) as never
    })
  )
  console.warn = realWarn
  if (!hook) throw new Error('auto-hide setup failed')

  return {
    hook,
    revealed: () => hook.revealed.value,
    movePointer(clientY: number) {
      emit('pointermove', { clientY })
      flushFrames()
    },
    leaveDocument() {
      emit('pointerleave', {})
    },
    blurWindow() {
      emit('blur', {})
    },
    setHidden(hidden: boolean) {
      ;(g.document as { hidden: boolean }).hidden = hidden
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    dispose: () => scope.stop()
  }
}

test('enabling auto-hide tucks the bar away immediately', () => {
  const autoHide = ref(true)
  const harness = createHarness({ autoHide })
  assert.equal(harness.revealed(), false)
  assert.ok(harness.listenerCount() > 0, 'listeners attach while auto-hide is on')
  harness.dispose()
})

test('disabling auto-hide pins the bar open and detaches listeners', async () => {
  const autoHide = ref(true)
  const harness = createHarness({ autoHide })
  autoHide.value = false
  await nextTick()
  assert.equal(harness.revealed(), true)
  assert.equal(harness.listenerCount(), 0)
  harness.dispose()
})

test('the pointer entering the bottom band reveals, leaving it hides after the delay', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const autoHide = ref(true)
    const harness = createHarness({ autoHide, hideDelayMs: 500 })
    harness.movePointer(700)
    assert.equal(harness.revealed(), true)

    harness.movePointer(200)
    assert.equal(harness.revealed(), true, 'still open while the countdown runs')
    mock.timers.tick(499)
    assert.equal(harness.revealed(), true)
    mock.timers.tick(1)
    assert.equal(harness.revealed(), false)
    harness.dispose()
  } finally {
    mock.timers.reset()
  }
})

test('pointer moves are ignored while the tab is hidden', () => {
  const autoHide = ref(true)
  const harness = createHarness({ autoHide })
  harness.setHidden(true)
  harness.movePointer(790)
  assert.equal(harness.revealed(), false, 'a background window must not animate the bar')
  harness.setHidden(false)
  harness.movePointer(790)
  assert.equal(harness.revealed(), true)
  harness.dispose()
})

test('an open floating panel holds the bar open past the delay', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const autoHide = ref(true)
    const keepOpen = ref(false)
    const harness = createHarness({ autoHide, keepOpen, hideDelayMs: 200 })
    harness.movePointer(790)
    assert.equal(harness.revealed(), true)
    keepOpen.value = true

    harness.movePointer(100)
    mock.timers.tick(1000)
    assert.equal(harness.revealed(), true, 'queue drawer / volume popover keeps it visible')

    keepOpen.value = false
    harness.hook.onBarPointerLeave()
    mock.timers.tick(200)
    assert.equal(harness.revealed(), false)
    harness.dispose()
  } finally {
    mock.timers.reset()
  }
})

test('hovering or focusing the bar keeps it open', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const autoHide = ref(true)
    const harness = createHarness({ autoHide, hideDelayMs: 100 })
    harness.hook.onBarPointerEnter()
    assert.equal(harness.revealed(), true)
    harness.movePointer(0)
    mock.timers.tick(1000)
    assert.equal(harness.revealed(), true, 'the pointer is resting on the bar')

    harness.hook.onBarPointerLeave()
    mock.timers.tick(100)
    assert.equal(harness.revealed(), false)

    harness.hook.onBarFocusIn()
    assert.equal(harness.revealed(), true)
    mock.timers.tick(1000)
    assert.equal(harness.revealed(), true, 'keyboard focus is inside the bar')
    harness.dispose()
  } finally {
    mock.timers.reset()
  }
})

test('focus moving between the bar own controls does not start the countdown', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const autoHide = ref(true)
    const bar = new FakeElement()
    const insideButton = bar.adopt(new FakeNode())
    const outsideButton = new FakeNode()
    const harness = createHarness({ autoHide, hideDelayMs: 100, bar })

    harness.hook.onBarFocusIn()
    harness.hook.onBarFocusOut({ relatedTarget: insideButton } as unknown as FocusEvent)
    mock.timers.tick(1000)
    assert.equal(harness.revealed(), true, 'tabbing from prev to play stays inside')

    harness.hook.onBarFocusOut({ relatedTarget: outsideButton } as unknown as FocusEvent)
    mock.timers.tick(100)
    assert.equal(harness.revealed(), false)
    harness.dispose()
  } finally {
    mock.timers.reset()
  }
})

test('the pointer leaving the document and the window blurring both start the countdown', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const autoHide = ref(true)
    const harness = createHarness({ autoHide, hideDelayMs: 300 })
    harness.hook.onBarPointerEnter()
    harness.leaveDocument()
    mock.timers.tick(300)
    assert.equal(harness.revealed(), false, 'pointer left the window entirely')

    harness.movePointer(790)
    assert.equal(harness.revealed(), true)
    harness.blurWindow()
    mock.timers.tick(300)
    assert.equal(harness.revealed(), false)
    harness.dispose()
  } finally {
    mock.timers.reset()
  }
})

test('flashReveal shows the bar for one delay window, and only while auto-hide is on', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const autoHide = ref(true)
    const harness = createHarness({ autoHide, hideDelayMs: 400 })
    assert.equal(harness.revealed(), false)
    harness.hook.flashReveal()
    assert.equal(harness.revealed(), true, 'a track change announces itself')
    mock.timers.tick(400)
    assert.equal(harness.revealed(), false)

    autoHide.value = false
    await nextTick()
    harness.hook.flashReveal()
    mock.timers.tick(10_000)
    assert.equal(harness.revealed(), true, 'with auto-hide off the bar never hides')
    harness.dispose()
  } finally {
    mock.timers.reset()
  }
})
