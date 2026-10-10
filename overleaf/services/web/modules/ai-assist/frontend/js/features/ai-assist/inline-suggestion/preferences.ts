import customLocalStorage from '@/infrastructure/local-storage'
import {
  INLINE_SUGGESTIONS_CHANGED_EVENT,
  INLINE_SUGGESTIONS_KEY,
  saveComposerPreferences,
} from '../provider-store'

/** Off, on Shift+Space, or also after a pause in typing. */
export type CompletionMode = 'disabled' | 'manual' | 'automatic'

const COMPLETION_MODES: CompletionMode[] = ['disabled', 'manual', 'automatic']
/** The pauses Automatic can wait for, in milliseconds. */
export const COMPLETION_DELAYS = [100, 200, 300, 400, 500, 600, 800, 1000]
export const DEFAULT_COMPLETION_DELAY = 300

/** Settings → Editor → AI assistance. Everything starts off. */
export type InlineSuggestionsPreferences = {
  /** Space on an empty line opens the prompt bar. */
  emptyLineShortcut: boolean
  completionMode: CompletionMode
  /** How long Automatic waits after the last keystroke. */
  completionDelayMs: number
}

/**
 * Unknown values fall back to the defaults. A copy from before the mode
 * existed has `sentenceCompletion`, whose `true` was today's Manual.
 */
export function normalizeInlineSuggestionsPreferences(
  raw: any
): InlineSuggestionsPreferences {
  return {
    emptyLineShortcut: raw?.emptyLineShortcut === true,
    completionMode: COMPLETION_MODES.includes(raw?.completionMode)
      ? raw.completionMode
      : raw?.sentenceCompletion === true
        ? 'manual'
        : 'disabled',
    completionDelayMs: COMPLETION_DELAYS.includes(raw?.completionDelayMs)
      ? raw.completionDelayMs
      : DEFAULT_COMPLETION_DELAY,
  }
}

let memo: InlineSuggestionsPreferences | null = null

/** Drops the parsed copy; the next read parses this browser's copy again. */
export function forgetInlineSuggestionsPreferences() {
  memo = null
}

if (typeof window !== 'undefined') {
  // Another tab, or the account's copy loaded into this browser
  window.addEventListener('storage', forgetInlineSuggestionsPreferences)
  window.addEventListener(
    INLINE_SUGGESTIONS_CHANGED_EVENT,
    forgetInlineSuggestionsPreferences
  )
}

/** Parsed once and kept: the editor reads it on every key press and redraw. */
export function readInlineSuggestionsPreferences(): InlineSuggestionsPreferences {
  if (!memo) {
    memo = normalizeInlineSuggestionsPreferences(
      customLocalStorage.getItem(INLINE_SUGGESTIONS_KEY)
    )
  }
  return memo
}

/** Stores in this browser, saves to the account, and tells the page. */
export function updateInlineSuggestionsPreferences(
  patch: Partial<InlineSuggestionsPreferences>
): InlineSuggestionsPreferences {
  const normalized = normalizeInlineSuggestionsPreferences({
    ...readInlineSuggestionsPreferences(),
    ...patch,
  })
  customLocalStorage.setItem(INLINE_SUGGESTIONS_KEY, normalized)
  saveComposerPreferences()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INLINE_SUGGESTIONS_CHANGED_EVENT))
  }
  memo = normalized
  return normalized
}
