import { closeCompletion, completionStatus } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { hasConsented } from '../provider-store'
import { resolveSlotModel, ResolvedModel } from '../language-suggestions/model-choice'
import type { TexGptNotice } from '../components/texgpt/texgpt-notices'
import {
  regenerateSuggestion,
  SuggestionSource,
  startSuggestion,
  suggestionField,
} from '../inline-suggestion/engine'
import { chatTextStream } from '../inline-suggestion/stream'
import {
  closeInlinePopup,
  inlinePopupField,
  openInlinePopup,
} from '../inline-suggestion/popup-field'
import { canTriggerAt } from '../inline-suggestion/guards'
import { readInlineSuggestionsPreferences } from '../inline-suggestion/preferences'
import { mathAncestorNode } from '@/features/source-editor/utils/tree-operations/math'
import { CompletionKind, Detection, detectCompletion } from './detect'
import { completionFacts, completionWindow, CompletionWindow } from './context'
import { buildCompletionMessage, COMPLETION_SYSTEM, MAX_TOKENS } from './prompt'
import { cleanCompletion } from './clean'
import { indentUnit } from './layout'
import { CursorSituation, describeCursor } from './placement'
import { cacheKey, completionCache, completionGate } from './rate'
import { claimModel } from '../inline-context/model-priority'

/**
 * Added to a request's output budget: a reasoning model thinks before its
 * first word, and on the kind's budget alone it can stop with nothing
 * written. The text is still held to the kind's natural end (clean.ts).
 */
export const THINKING_ALLOWANCE = 1024

type CompletionRun = {
  pos: number
  kind: CompletionKind
  model: ResolvedModel
  fallbackModel?: ResolvedModel | null
  window: CompletionWindow
  /** The whole document when the request was made. */
  text: string
  key: string
  manual: boolean
  /** Shift+Space where a suggestion was already shown: the words to write differently from. */
  rejected: string | undefined
  /** Where the cursor is, and what may be written there. */
  situation: CursorSituation
}

/**
 * Shift+Space is going ahead: the LaTeX autocomplete list (open, or still
 * loading after the last keystroke) and an earlier notice of ours make way,
 * so neither turns the key into a plain space.
 */
function takeOver(view: EditorView) {
  if (completionStatus(view.state) !== null) closeCompletion(view)
  if (view.state.field(inlinePopupField, false)) {
    view.dispatch({ effects: closeInlinePopup.of(null) })
  }
}

function showNotice(view: EditorView, pos: number, notice: TexGptNotice) {
  view.dispatch({ effects: openInlinePopup.of({ pos, mode: 'notice', notice }) })
}

/**
 * Shift+Space, in Manual and Automatic alike. Every press asks the model
 * again: a suggestion on screen is replaced, never shown again from the
 * cache. Returns false (a space is typed) wherever no completion applies.
 */
export function completeAtCursor(view: EditorView): boolean {
  if (readInlineSuggestionsPreferences().completionMode === 'disabled') return false
  return requestCompletion(view, { manual: true })
}

/**
 * Asks for a completion at the cursor. False where none applies (nothing is
 * sent): see detect.ts for where that is. Automatic is sent at once, or
 * shown from the cache, and passes the detection it already made; Shift+Space
 * always asks again, at least `MIN_REQUEST_GAP_MS` after the last press.
 * True once either is under way, or — manual only — a notice at the cursor
 * says why it cannot run.
 */
export function requestCompletion(
  view: EditorView,
  { manual, detection }: { manual: boolean; detection?: Detection }
): boolean {
  if (!canTriggerAt(view, { takeOver: manual })) return false
  // A pause in typing never replaces a Shift+Space waiting for the gap
  if (!manual && completionGate.waiting) return false
  const { state } = view
  const pos = state.selection.main.head
  const { kind } = detection ?? detectCompletion(state, pos, { automatic: !manual })
  if (!kind) return false

  const fastModel = resolveSlotModel('fast')
  const mainModel = resolveSlotModel('main')
  const primaryModel = fastModel ?? mainModel
  const fallbackModel = fastModel ? mainModel : null

  if (!primaryModel) {
    if (!manual) return false
    takeOver(view)
    showNotice(view, pos, { name: 'noProvider' })
    return true
  }
  if (manual) takeOver(view)
  if (!hasConsented()) {
    if (manual) showNotice(view, pos, { name: 'consent' })
    return manual
  }

  const doc = state.doc
  const text = doc.toString()
  const window = completionWindow(text, pos)
  const key = cacheKey(primaryModel.model, kind, window.prefix, window.suffix)
  const current = view.state.field(suggestionField, false)
  const rejected = manual
    ? current?.pos === pos && current.text
      ? current.typed + current.text
      : completionCache.get(key)
    : undefined
  const inMath = kind === 'math' || Boolean(mathAncestorNode(state, pos))
  const situation = describeCursor(text, pos, kind, inMath)
  const run = { pos, kind, model: primaryModel, fallbackModel, window, text, key, manual, rejected, situation }
  if (!manual) {
    // Automatic waited for its pause in typing already: no gap, sent now
    const cached = completionCache.get(key)
    if (cached !== undefined) showCached(view, pos, cached, 'auto')
    else runCompletion(view, run)
    return true
  }
  // A regeneration: the suggestion on screen goes now, its request with it
  regenerateSuggestion(view)
  // Shift+Space presses start at least the gap apart, so holding it down is not a flood
  completionGate.schedule(() => {
    // Dropped when the text or the cursor moved while it waited for the gap
    if (view.state.doc !== doc || view.state.selection.main.head !== pos) return
    runCompletion(view, run)
  })
  return true
}

function showCached(
  view: EditorView,
  pos: number,
  text: string,
  source: SuggestionSource
) {
  void startSuggestion(view, {
    source,
    pos,
    stream: async function* () {
      yield text
    },
    shape: raw => ({ text: raw, stop: true }),
  })
}

function runCompletion(view: EditorView, run: CompletionRun) {
  const { pos, kind, model, fallbackModel, window, text, key, manual, rejected, situation } = run
  const facts = completionFacts(text, pos)
  const stream = chatTextStream({
    settings: model.settings,
    fallbackSettings: fallbackModel?.settings ?? null,
    system: COMPLETION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: buildCompletionMessage({ window, facts, kind, situation, rejected }),
      },
    ],
    maxTokens: MAX_TOKENS[kind] + THINKING_ALLOWANCE,
  })
  const options = {
    kind,
    before: window.prefix,
    after: window.suffix,
    situation,
    unit: indentUnit(window.prefix + window.suffix),
  }
  let final = ''
  // The language check on the same server makes way until this one ends
  const release = claimModel(model.settings)

  startSuggestion(view, {
    source: manual ? 'completion' : 'auto',
    pos,
    stream,
    shape: (raw, done) => {
      const cleaned = cleanCompletion(raw, done, options)
      if (done) final = cleaned.text
      return { text: cleaned.text, stop: cleaned.complete }
    },
  })
    .then(outcome => {
      if (outcome.status === 'shown' && final) completionCache.set(key, final)
    })
    .catch((error: any) => {
      // Automatic suggestions fail silently; a manual one says why, unless the author moved on
      if (!manual || view.state.selection.main.head !== pos) return
      showNotice(view, pos, {
        name: 'error',
        message: error?.message || 'The request failed.',
        hint: error?.hint,
      })
    })
    .finally(release)
}
