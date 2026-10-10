/**
 * Whether the author is on this page: its tab is visible and its window has
 * the focus. Automatic AI features send nothing while the author is away —
 * in another tab, another window or another app — and catch up on return.
 *
 * It starts as attended when the tab is visible and changes only on browser
 * events, so a page opened in the foreground works before any focus event.
 */
type Listener = (attended: boolean) => void

const listeners = new Set<Listener>()
let attended = true
let installed = false

function visible(): boolean {
  return document.visibilityState !== 'hidden'
}

function set(next: boolean) {
  if (next === attended) return
  attended = next
  for (const listener of [...listeners]) listener(next)
}

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  attended = visible()
  document.addEventListener('visibilitychange', () =>
    set(visible() && document.hasFocus())
  )
  window.addEventListener('focus', () => set(visible()))
  // Focus moving into an iframe of the page (a PDF, a dialog) blurs the
  // window too; the page still has it once the move is done
  window.addEventListener('blur', () =>
    setTimeout(() => set(visible() && document.hasFocus()), 0)
  )
}

export function pageAttended(): boolean {
  install()
  return attended
}

/** Calls `listener` whenever the page gains or loses the author; returns the unsubscribe. */
export function onPageAttention(listener: Listener): () => void {
  install()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
