import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

// Shared dismiss/a11y helpers for menus, drawers, and dialogs.

// Calls the handler on Escape while `active` is true. Handlers registered later
// run first, so nested surfaces (menu above dialog) close innermost-first.
const escapeStack: Array<() => void> = []
let escapeListenerAttached = false

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.key !== 'Escape' || escapeStack.length === 0) return
  event.preventDefault()
  escapeStack[escapeStack.length - 1]()
}

export function hasDismissLayer(): boolean {
  return escapeStack.length > 0
}

function ensureEscapeListener(): void {
  if (escapeListenerAttached || typeof window === 'undefined') return
  window.addEventListener('keydown', onWindowKeydown)
  escapeListenerAttached = true
}

export function useEscapeToClose(active: Ref<boolean> | (() => boolean), close: () => void): void {
  const isActive = typeof active === 'function' ? active : () => active.value
  const entry = (): void => close()

  const sync = (value: boolean): void => {
    const index = escapeStack.indexOf(entry)
    if (value && index === -1) {
      ensureEscapeListener()
      escapeStack.push(entry)
    } else if (!value && index !== -1) {
      escapeStack.splice(index, 1)
    }
  }

  onMounted(() => sync(isActive()))
  watch(isActive, sync)
  onBeforeUnmount(() => sync(false))
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Keeps Tab focus inside `container` while `active` is true and moves focus to
// the first focusable element when the surface opens (aria-modal made real).
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  active: Ref<boolean> | (() => boolean)
): void {
  const isActive = typeof active === 'function' ? active : () => active.value
  let previouslyFocused: HTMLElement | null = null

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return
    const root = container.value
    if (!root) return
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    )
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement as HTMLElement | null
    if (event.shiftKey && (current === first || !root.contains(current))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (current === last || !root.contains(current))) {
      event.preventDefault()
      first.focus()
    }
  }

  watch(
    isActive,
    (value) => {
      const root = container.value
      if (value) {
        previouslyFocused = (document.activeElement as HTMLElement | null) ?? null
        window.addEventListener('keydown', onKeydown, true)
        requestAnimationFrame(() => {
          const target = container.value?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
          target?.focus()
        })
      } else {
        window.removeEventListener('keydown', onKeydown, true)
        if (previouslyFocused && (!root || !root.contains(document.activeElement))) {
          previouslyFocused.focus()
        }
        previouslyFocused = null
      }
    },
    { flush: 'post' }
  )

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, true)
  })
}
