import { useCallback, useEffect, useState } from 'react'

/**
 * Whether the main chat panel is mid-run, readable from outside its tree.
 *
 * The compile-log panel needs this to refuse a handoff while the assistant is
 * already working: `run()` rebuilds the request from the transcript, so a
 * second one started underneath a live run would race it.
 *
 * Deliberately in-memory rather than localStorage. "Running" is a property of
 * a mounted panel with an open request, and both die with the page — a
 * persisted flag would survive a reload mid-run and leave the button refusing
 * a handoff forever, with no run left to finish and clear it.
 */
const busyProjects = new Set<string>()

export const CHAT_BUSY_EVENT = 'aiAssist:chatBusyChange'

export function isChatBusy(projectId: string): boolean {
  return busyProjects.has(projectId)
}

export function setChatBusy(projectId: string, busy: boolean): void {
  if (busy === busyProjects.has(projectId)) return

  if (busy) {
    busyProjects.add(projectId)
  } else {
    busyProjects.delete(projectId)
  }

  window.dispatchEvent(
    new CustomEvent(CHAT_BUSY_EVENT, { detail: { projectId, busy } })
  )
}

/** Subscribes a component to one project's busy flag. */
export function useChatBusy(projectId: string): boolean {
  const [busy, setBusy] = useState(() => isChatBusy(projectId))

  const refresh = useCallback(() => {
    setBusy(isChatBusy(projectId))
  }, [projectId])

  useEffect(() => {
    refresh()
    window.addEventListener(CHAT_BUSY_EVENT, refresh)
    return () => {
      window.removeEventListener(CHAT_BUSY_EVENT, refresh)
    }
  }, [refresh])

  return busy
}
