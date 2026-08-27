import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'

// Shared back-affordance stack for the shell title bar (same module-level
// pattern as useDismissLayer's escape stack). Pages and deep in-page states
// register layered handlers — page level first, deeper states later — and
// `goBack` always resolves the newest entry, so one title-bar button walks the
// user out layer by layer.

interface BackEntry {
  id: number
  label?: string
  run: () => void
}

const entries = ref<BackEntry[]>([])
let nextId = 1
let running = false

export const canGoBack = computed(() => entries.value.length > 0)
export const backHint = computed(() => entries.value[entries.value.length - 1]?.label)

// Registers `run` until the returned disposer is called. Contract: `run`
// resolves ONE layer (pops a detail, exits a sub-state, closes a page). If
// deeper layers of the same entry remain afterwards the entry simply stays
// registered and resolves the next one on the following back; once its state
// is gone the owner disposes it (useBackHandler does this via watch/unmount).
export function pushBackHandler(run: () => void, label?: string): () => void {
  const entry: BackEntry = { id: nextId++, label, run }
  entries.value.push(entry)
  let active = true
  return () => {
    if (!active) return
    active = false
    const index = entries.value.findIndex((item) => item.id === entry.id)
    if (index !== -1) entries.value.splice(index, 1)
  }
}

// Runs the newest registered handler. Entries are NOT removed here — the
// owner disposes them when its state is gone, so multi-level layers keep
// working. A re-entrancy guard makes goBack inside a handler a no-op so a
// misbehaving handler cannot recurse.
export function goBack(): boolean {
  if (running) return false
  const top = entries.value[entries.value.length - 1]
  if (!top) return false
  running = true
  try {
    top.run()
  } finally {
    running = false
  }
  return true
}

// Keeps a handler registered while `active` is truthy and drops it when the
// owning scope unmounts. Register deeper states after their page's base
// handler so they land on top of the stack:
//   useBackHandler(isDetail, popDetail, '返回推荐')
export function useBackHandler(active: Ref<boolean>, run: () => void, label?: string): void {
  let dispose: (() => void) | null = null
  watch(
    active,
    (value) => {
      if (value && !dispose) {
        dispose = pushBackHandler(run, label)
      } else if (!value && dispose) {
        dispose()
        dispose = null
      }
    },
    { immediate: true }
  )
  onScopeDispose(() => {
    dispose?.()
    dispose = null
  })
}

// Registers a page-level layer for as long as the component is mounted. Use
// this when the page itself must control closing (e.g. an unsaved-changes
// confirm) instead of the App-level navigation flags.
export function useBackHandlerWhileMounted(run: () => void, label?: string): void {
  const dispose = pushBackHandler(run, label)
  onScopeDispose(dispose)
}

export function useBackStack(): {
  canGoBack: typeof canGoBack
  backHint: typeof backHint
  goBack: typeof goBack
  pushBackHandler: typeof pushBackHandler
  useBackHandler: typeof useBackHandler
  useBackHandlerWhileMounted: typeof useBackHandlerWhileMounted
} {
  return {
    canGoBack,
    backHint,
    goBack,
    pushBackHandler,
    useBackHandler,
    useBackHandlerWhileMounted
  }
}
