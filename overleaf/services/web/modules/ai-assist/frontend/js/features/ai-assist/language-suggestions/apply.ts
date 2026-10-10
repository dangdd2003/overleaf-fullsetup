import type { EditorView } from '@codemirror/view'
import { cacheKey, suggestionCache } from './cache'
import { containsEdit, MaskedEdit, sourceChange } from './edits'
import { keyContext } from './model-choice'
import {
  blockSuggestion,
  readLanguageSuggestionsPreferences,
} from './preferences'
import {
  ACCEPT_USER_EVENT,
  addUnit,
  closeCard,
  languageSuggestionsField,
  openCard,
  refreshFilters,
  removeEdits,
  unitDelta,
  UnitSuggestions,
  visibleEdits,
} from './state'
import { buildUnits, unitAt } from './units'
import { noteAccepted, noteDismissed } from './memory'

function findUnit(
  view: EditorView,
  hash: string,
  from: number
): UnitSuggestions | undefined {
  return view.state
    .field(languageSuggestionsField, false)
    ?.units.find(unit => unit.hash === hash && unit.from === from)
}

/**
 * The edits left after accepting `accepted`, moved to fit the new sentence
 * text. An edit that holds an accepted one (a rewording around the
 * correction just taken) now replaces the corrected words; one that only
 * partly overlaps no longer fits, and the caller drops it.
 */
export function rebaseEdits(
  remaining: MaskedEdit[],
  accepted: MaskedEdit[]
): MaskedEdit[] {
  return remaining
    .map(edit => {
      let shift = 0
      let grow = 0
      let original = edit.original
      for (const done of accepted) {
        const change = done.insert.length - (done.to - done.from)
        if (containsEdit(edit, done)) {
          const at = done.from - edit.from + grow
          original = original.slice(0, at) + done.insert + original.slice(at + done.to - done.from)
          grow += change
        } else if (done.to <= edit.from) {
          shift += change
        }
      }
      return { ...edit, from: edit.from + shift, to: edit.to + shift + grow, original }
    })
    .filter(edit => edit.original !== edit.insert)
}

/**
 * The card's decision for a sentence: `accept` applied, `reject` (the
 * changes the author chose to keep their text for) dropped with it.
 */
export function settleEdits(
  view: EditorView,
  hash: string,
  from: number,
  accept: number[],
  reject: number[]
) {
  if (accept.length === 0) {
    rejectEdits(view, hash, from, reject)
    return
  }
  const unit = findUnit(view, hash, from)
  const context = keyContext(readLanguageSuggestionsPreferences())
  const dropped = reject
    .map(index => unit?.edits[index])
    .filter((edit): edit is MaskedEdit => Boolean(edit))
  if (context && dropped.length > 0) {
    suggestionCache.reject(cacheKey(context, hash), dropped)
  }
  acceptEdits(view, hash, from, accept, reject)
}

/**
 * Applies some of a sentence's edits in one transaction (one undo step,
 * tracked when track changes is on). The sentence is scanned again and
 * cached with its remaining edits, so accepting never triggers a check.
 */
export function acceptEdits(
  view: EditorView,
  hash: string,
  from: number,
  indexes: number[],
  /** Edits to drop with them, not carried to the new sentence. */
  dropIndexes: number[] = []
) {
  const unit = findUnit(view, hash, from)
  if (!unit) return
  const dropped = new Set(dropIndexes.map(index => unit.edits[index]))
  const accepted = indexes
    .map(index => unit.edits[index])
    .filter((edit): edit is MaskedEdit => Boolean(edit))
    .sort((a, b) => a.from - b.from)
  if (accepted.length === 0) return

  const delta = unitDelta(unit)
  const changes = accepted.map(edit => sourceChange(unit.masked, edit, delta))
  const changeSet = view.state.changes(changes)
  const nextDoc = changeSet.apply(view.state.doc).toString()
  const next = unitAt(buildUnits(nextDoc), changeSet.mapPos(unit.from, -1))

  const remaining = next
    ? rebaseEdits(
        unit.edits.filter(edit => !accepted.includes(edit) && !dropped.has(edit)),
        accepted
      ).filter(edit => next.masked.text.slice(edit.from, edit.to) === edit.original)
    : []

  noteAccepted(accepted)
  noteDismissed([...dropped].filter((edit): edit is MaskedEdit => Boolean(edit)))
  const context = keyContext(readLanguageSuggestionsPreferences())
  if (next && context) {
    suggestionCache.set(cacheKey(context, next.hash), {
      edits: remaining,
      rejected: [],
      text: next.masked.text,
    })
  }

  const effects = []
  if (next && remaining.length > 0) {
    const added: UnitSuggestions = {
      hash: next.hash,
      from: next.from,
      to: next.to,
      masked: next.masked,
      edits: remaining,
    }
    effects.push(addUnit.of(added))
    const first = visibleEdits(added)[0]
    effects.push(
      first
        ? openCard.of({
            hash: next.hash,
            from: next.from,
            edit: first.index,
          })
        : closeCard.of({ hash, from })
    )
  } else {
    effects.push(closeCard.of({ hash, from }))
  }

  view.dispatch({ changes: changeSet, effects, userEvent: ACCEPT_USER_EVENT })
}

/** Hides edits, and keeps them hidden for this session. */
export function rejectEdits(
  view: EditorView,
  hash: string,
  from: number,
  indexes: number[]
) {
  const unit = findUnit(view, hash, from)
  if (!unit) return
  const edits = indexes
    .map(index => unit.edits[index])
    .filter((edit): edit is MaskedEdit => Boolean(edit))
  if (edits.length === 0) return
  const context = keyContext(readLanguageSuggestionsPreferences())
  if (context) suggestionCache.reject(cacheKey(context, hash), edits)
  noteDismissed(edits)
  // A change dismissed often enough is hidden on every sentence now
  view.dispatch({ effects: [removeEdits.of({ hash, edits }), refreshFilters.of(null)] })
}

/** Adds the exact old→new pair to the account's blocked list. */
export function blockEdit(
  view: EditorView,
  hash: string,
  from: number,
  index: number
) {
  const edit = findUnit(view, hash, from)?.edits[index]
  if (!edit) return
  blockSuggestion(edit.original, edit.insert)
  view.dispatch({ effects: refreshFilters.of(null) })
}
