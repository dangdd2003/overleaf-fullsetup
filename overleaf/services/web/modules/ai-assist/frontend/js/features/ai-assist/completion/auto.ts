import { closeCompletion, completionStatus } from '@codemirror/autocomplete'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import {
  cancelSuggestion,
  REGENERATE_EVENT,
  suggestionField,
} from '../inline-suggestion/engine'
import { readInlineSuggestionsPreferences } from '../inline-suggestion/preferences'
import { onPageAttention, pageAttended } from '../inline-context/page-attention'
import { noteWriting } from '../inline-context/model-priority'
import { ACCEPT_USER_EVENT } from '../language-suggestions/state'
import { requestCompletion } from './trigger'
import { detectCompletion } from './detect'

/** A command name right before the cursor: the LaTeX autocomplete list is for it. */
const COMMAND_BEFORE = /\\[A-Za-z@]*\*?$/

/**
 * The LaTeX autocomplete list left open where no command is being typed
 * (after `\documentclass{article}` it stays up, listing every command): it
 * offers nothing for the words that come next, and would keep Automatic
 * silent there.
 */
function staleList(state: EditorState, pos: number): boolean {
  if (completionStatus(state) === null) return false
  const line = state.doc.lineAt(pos)
  return !COMMAND_BEFORE.test(line.text.slice(0, pos - line.from))
}

/** Ignored suggestions in a row before Automatic starts waiting longer. */
export const IGNORED_BEFORE_SLOWDOWN = 2
/** The longest Automatic waits, however many suggestions were ignored. */
export const MAX_AUTO_DELAY_MS = 2000

/** Automatic suggestions shown in a row and dismissed or typed over; one accepted resets it. */
let ignoredInARow = 0

/** For tests. */
export function resetAutoCompletion() {
  ignoredInARow = 0
}

/**
 * The author's chosen pause, doubled for each suggestion ignored in a row
 * past the first: an author who keeps typing over suggestions gets fewer of
 * them, and fewer requests are sent, until they accept one again.
 */
export function autoDelay(chosenMs: number, ignored = ignoredInARow): number {
  const extra = Math.max(0, ignored - IGNORED_BEFORE_SLOWDOWN + 1)
  if (extra === 0) return chosenMs
  return Math.max(chosenMs, Math.min(chosenMs * 2 ** extra, MAX_AUTO_DELAY_MS))
}

/**
 * The author writing: typing, Enter (a new line, a new `\item`), picking a
 * LaTeX autocomplete entry, accepting a suggestion (the next one follows),
 * or Backspace. Not pasting or dropping text, cutting, undo, a
 * collaborator's edit, or accepting a language-suggestion fix.
 */
function authorWrote(update: ViewUpdate): boolean {
  return update.transactions.some(tr => {
    if (!tr.docChanged || tr.annotation(Transaction.remote)) return false
    if (
      tr.isUserEvent('input.paste') ||
      tr.isUserEvent('input.drop') ||
      tr.isUserEvent('delete.cut') ||
      tr.isUserEvent('undo') ||
      tr.isUserEvent('redo') ||
      tr.isUserEvent(ACCEPT_USER_EVENT)
    ) {
      return false
    }
    return (
      tr.isUserEvent('input') ||
      tr.isUserEvent('delete') ||
      tr.isUserEvent('delete.backward') ||
      tr.isUserEvent('delete.forward') ||
      !tr.annotation(Transaction.userEvent)
    )
  })
}

/** Tracks whether automatic suggestions get accepted or ignored. */
function noteOutcome(update: ViewUpdate) {
  const before = update.startState.field(suggestionField, false)
  if (!before || before.source !== 'auto' || before.status !== 'ready') return
  if (update.transactions.some(tr => tr.isUserEvent('input.complete'))) {
    ignoredInARow = 0
    return
  }
  // Shift+Space asked for another one: the author wants suggestions here
  if (update.transactions.some(tr => tr.isUserEvent(REGENERATE_EVENT))) return
  const after = update.state.field(suggestionField, false)
  if (after?.id !== before.id) ignoredInARow++
}

/**
 * Automatic mode: a pause of `completionDelayMs` after the author's typing
 * asks for a completion at the cursor, as if Shift+Space had been pressed,
 * but silently: no notices. Only while the author is on the page, only where
 * a suggestion fits (`detectCompletion`), and less often while suggestions
 * keep being ignored.
 */
export const autoCompletion = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null
    private stopWatchingPage: () => void

    constructor(readonly view: EditorView) {
      this.stopWatchingPage = onPageAttention(attended => {
        if (attended) return
        this.cancel()
        // A suggestion still streaming is abandoned; a finished one stays
        const current = this.view.state.field(suggestionField, false)
        if (current?.source === 'auto' && current.status === 'streaming') {
          cancelSuggestion(this.view)
        }
      })
    }

    update(update: ViewUpdate) {
      noteOutcome(update)
      if (!update.docChanged && !update.selectionSet && !update.focusChanged) {
        return
      }
      this.cancel()
      const preferences = readInlineSuggestionsPreferences()
      if (preferences.completionMode !== 'automatic') return
      if (!authorWrote(update)) return
      // A completion may follow: the language check holds its next batch
      noteWriting()
      // Typed through: the suggestion is still showing
      if (update.state.field(suggestionField, false)) return
      const pos = update.state.selection.main.head

      const { doc } = update.state
      this.timer = setTimeout(() => {
        this.timer = null
        const { state } = this.view
        if (state.doc !== doc || state.selection.main.head !== pos) return
        if (state.field(suggestionField, false)) return
        if (!pageAttended()) return
        // Only where a suggestion fits and the writing pauses naturally (see detect.ts)
        const detection = detectCompletion(state, pos, { automatic: true })
        if (!detection.kind) return
        if (staleList(state, pos)) closeCompletion(this.view)
        requestCompletion(this.view, { manual: false, detection })
      }, autoDelay(preferences.completionDelayMs))
    }

    cancel() {
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
    }

    destroy() {
      this.cancel()
      this.stopWatchingPage()
    }
  }
)
