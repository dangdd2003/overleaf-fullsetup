/**
 * Puts jsdom's focus back to where a fresh page starts.
 *
 * Removing a focused element hands the focus to <body>, and jsdom then reports
 * document.hasFocus() as true for the rest of the run. Code that checks whether
 * the author is on the page then sees them as present in tests that expect them
 * away. Focusing and blurring a throwaway element clears that state.
 */
export function resetDocumentFocus() {
  const probe = document.createElement('button')
  document.body.appendChild(probe)
  probe.focus()
  probe.blur()
  probe.remove()
}
