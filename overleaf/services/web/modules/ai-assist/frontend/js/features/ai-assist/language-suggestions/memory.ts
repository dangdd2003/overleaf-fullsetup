import customLocalStorage from '@/infrastructure/local-storage'
import type { MaskedEdit } from './edits'
import { blockKey } from './preferences'

/**
 * What this browser remembers about the author's answers, across reloads:
 * - accepted changes, so a later suggestion that would undo one (A→B
 *   accepted, then B→A suggested) is not shown: models flip-flop;
 * - how often each change was dismissed, so one dismissed `DISMISS_LIMIT`
 *   times, on any sentence, is not suggested again.
 * The blocked list in the settings stays the explicit, editable way to hide one.
 */

export const MEMORY_KEY = 'ai-assist:language-suggestions:answers'
export const DISMISS_LIMIT = 3
const MAX_ACCEPTED = 300
const MAX_DISMISSED = 500

type Stored = { v: 1; accepted: string[]; dismissed: Array<[string, number]> }

let accepted: string[] | null = null
let dismissed: Map<string, number> | null = null

function load() {
  if (accepted && dismissed) return
  let stored: Stored | null = null
  try {
    stored = customLocalStorage.getItem(MEMORY_KEY)
  } catch {}
  const valid = stored?.v === 1
  accepted = valid && Array.isArray(stored!.accepted)
    ? stored!.accepted.filter(key => typeof key === 'string')
    : []
  dismissed = new Map(
    valid && Array.isArray(stored!.dismissed)
      ? stored!.dismissed.filter(
          entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number'
        )
      : []
  )
}

function save() {
  try {
    customLocalStorage.setItem(MEMORY_KEY, {
      v: 1,
      accepted: accepted!.slice(-MAX_ACCEPTED),
      dismissed: [...dismissed!].slice(-MAX_DISMISSED),
    } satisfies Stored)
  } catch {}
}

/** For tests, and when another tab changed it. */
export function forgetAnswers() {
  accepted = null
  dismissed = null
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === MEMORY_KEY) forgetAnswers()
  })
}

export function noteAccepted(edits: MaskedEdit[]) {
  if (edits.length === 0) return
  load()
  for (const edit of edits) {
    const key = blockKey(edit.original, edit.insert)
    accepted = accepted!.filter(other => other !== key)
    accepted.push(key)
  }
  save()
}

export function noteDismissed(edits: MaskedEdit[]) {
  if (edits.length === 0) return
  load()
  for (const edit of edits) {
    const key = blockKey(edit.original, edit.insert)
    const count = (dismissed!.get(key) ?? 0) + 1
    dismissed!.delete(key)
    dismissed!.set(key, count)
  }
  save()
}

/** It would undo a change the author accepted. */
export function undoesAccepted(edit: MaskedEdit): boolean {
  load()
  return accepted!.includes(blockKey(edit.insert, edit.original))
}

/** The author keeps dismissing this exact change. */
export function dismissedOften(edit: MaskedEdit): boolean {
  load()
  return (dismissed!.get(blockKey(edit.original, edit.insert)) ?? 0) >= DISMISS_LIMIT
}
