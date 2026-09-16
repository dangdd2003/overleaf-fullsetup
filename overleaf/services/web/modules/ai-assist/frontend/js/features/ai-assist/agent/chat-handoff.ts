import customLocalStorage from '@/infrastructure/local-storage'

export type ChatHandoff = {
  /** The compile-log entry this came from, for the chip and for de-duping. */
  entryId: string
  level: 'error' | 'warning'
  file: string | null
  line: number | null
  message: string
  /** The visible prompt: what the transcript shows the user having said. */
  text: string
  /** The provider-facing payload: original fix context, prior run, handoff. */
  contextText: string
  createdAt: number
}

export type ChatHandoffRequest = Omit<ChatHandoff, 'createdAt'>

/**
 * How long a handoff waits to be collected.
 *
 * Long enough to cover opening a panel that has never been mounted, short
 * enough that an error moved across, abandoned, and rediscovered after lunch
 * does not silently send itself against a document that has moved on.
 */
export const HANDOFF_TTL_MS = 5 * 60 * 1000

export const CHAT_HANDOFF_EVENT = 'aiAssist:chatHandoff'

const keyFor = (projectId: string) => `ai-assist:handoff:${projectId}`

/**
 * Parks a handoff for the chat panel, then tells it to come and get it.
 *
 * Both halves are load-bearing. The chat panel is mounted lazily (`rail.tsx`
 * uses `mountOnEnter`, and the right dock renders null while closed), so a
 * chat the user has never opened has no listener and would drop the event
 * outright; storage is what survives until it mounts. A chat that *is* already
 * mounted, on the other hand, will not re-read storage on its own, which is
 * what the event is for. The reader clears the slot, so whichever path gets
 * there first, the handoff is consumed exactly once.
 */
export function requestChatHandoff(
  projectId: string,
  handoff: ChatHandoffRequest
): void {
  const payload: ChatHandoff = { ...handoff, createdAt: Date.now() }

  try {
    customLocalStorage.setItem(keyFor(projectId), payload)
  } catch {
    // A full or denied store still leaves the event, which covers the common
    // case of a chat panel that is already open.
  }

  window.dispatchEvent(
    new CustomEvent(CHAT_HANDOFF_EVENT, { detail: { projectId } })
  )
}

/** Reads and clears the pending handoff, or returns null if there is none. */
export function takePendingHandoff(projectId: string): ChatHandoff | null {
  let stored: ChatHandoff | null = null
  try {
    stored = customLocalStorage.getItem(keyFor(projectId)) as ChatHandoff | null
  } catch {
    return null
  }

  clearPendingHandoff(projectId)

  if (!stored || typeof stored.contextText !== 'string') return null
  if (Date.now() - (stored.createdAt ?? 0) > HANDOFF_TTL_MS) return null

  return stored
}

export function clearPendingHandoff(projectId: string): void {
  try {
    customLocalStorage.removeItem(keyFor(projectId))
  } catch {}
}
