import { ChangeSet, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  showTooltip,
  Tooltip,
  TooltipView,
} from '@codemirror/view'
import { learnedWords } from '@/features/source-editor/extensions/spelling/learned-words'
import { sameEdit } from './cache'
import { containsEdit, displayEdit, editKind, type MaskedEdit } from './edits'
import type { MaskedText } from './masked-text'
import { isBlocked, readLanguageSuggestionsPreferences } from './preferences'
import { dismissedOften, undoesAccepted } from './memory'

/** Accepting a suggestion writes with this user event. */
export const ACCEPT_USER_EVENT = 'input.language-suggestion'

/** A checked sentence that has something to suggest. */
export type UnitSuggestions = {
  hash: string
  /** Its range now, mapped through every change since it was scanned. */
  from: number
  to: number
  /** As scanned: its positions are those of that moment (see `unitDelta`). */
  masked: MaskedText
  edits: MaskedEdit[]
}

export type CheckStatus =
  | { kind: 'idle' }
  | {
      kind: 'checking'
      /** During a check of many sentences (opening a file): how far it got. */
      progress?: { checked: number; total: number }
    }
  | { kind: 'error'; message: string }
  | { kind: 'stopped'; message: string }

export type CardState = {
  hash: string
  /** The unit's `from`: tells two copies of one sentence apart. */
  from: number
  /** Index into the unit's edits. */
  edit: number
  /** Whether the card is pinned to stay open while navigating or opening others. */
  pinned: boolean
  /** Increasing layer order for pinned cards so newer pins sit above older ones. */
  pinOrder: number
  tooltip: Tooltip
  /** This card's own tooltip DOM, kept across moves (see `cardTooltip`). */
  create: () => TooltipView
}

export type LanguageSuggestionsState = {
  units: UnitSuggestions[]
  /** All cards currently open on screen (pinned and active unpinned). */
  cards: CardState[]
  /** The open card; a click elsewhere or a change closes it. */
  card: CardState | null
  status: CheckStatus
  /** Bumped when the blocked list or the dictionary changes. */
  filters: number
}

export const setUnitResults = StateEffect.define<UnitSuggestions[]>()
export const addUnit = StateEffect.define<UnitSuggestions>()
export const removeEdits = StateEffect.define<{
  hash: string
  edits: MaskedEdit[]
}>()
export const openCard = StateEffect.define<{
  hash: string
  from: number
  edit: number
}>()
/** Closes the open card, or with a target that card. */
export const closeCard = StateEffect.define<{ hash: string; from: number } | null>()
export const togglePinCard = StateEffect.define<{ hash: string; from: number }>()
export const bringCardToFront = StateEffect.define<{ hash: string; from: number }>()
export const setStatus = StateEffect.define<CheckStatus>()
export const refreshFilters = StateEffect.define<null>()

const SINGLE_WORD = /^[\p{L}\p{N}'’-]+$/u

/**
 * Out of sight: blocked, it changes a word in the user's dictionary, it would
 * undo a change the author accepted, the author keeps dismissing it, or it
 * is of a type the Suggestion options leave out (memory.ts).
 */
export function isEditHidden(edit: MaskedEdit): boolean {
  if (isBlocked(edit.original, edit.insert)) return true
  const word = edit.original.trim()
  if (SINGLE_WORD.test(word) && learnedWords.global.has(word)) return true
  if (undoesAccepted(edit) || dismissedOften(edit)) return true
  const { types } = readLanguageSuggestionsPreferences()
  return types !== 'all' && editKind(edit) !== types
}

export function visibleEdits(
  unit: UnitSuggestions
): Array<{ index: number; edit: MaskedEdit }> {
  const shown = unit.edits
    .map((edit, index) => ({ index, edit }))
    .filter(({ edit }) => !isEditHidden(edit))
  // A rewording around a correction waits until the correction is taken or dropped
  const corrections = shown.filter(({ edit }) => editKind(edit) === 'grammar')
  return shown.filter(
    ({ edit }) =>
      editKind(edit) === 'grammar' ||
      !corrections.some(({ edit: correction }) => containsEdit(edit, correction))
  )
}

/** How far the unit moved since it was scanned. */
export function unitDelta(unit: UnitSuggestions): number {
  return unit.from - unit.masked.starts[0]
}

/**
 * The text an edit underlines: its own range, widened to the word for
 * punctuation, or for an insertion the word before it.
 */
export function displayRange(
  unit: UnitSuggestions,
  edit: MaskedEdit
): { from: number; to: number } {
  const { text, starts, ends } = unit.masked
  // A punctuation edit underlines the word its mark sticks to
  const shown = displayEdit(unit.masked, edit)
  let a = shown.from
  let b = shown.to
  if (b === a) {
    let end = a
    while (end > 0 && text[end - 1] === ' ') end--
    let start = end
    while (start > 0 && text[start - 1] !== ' ') start--
    if (start < end) {
      a = start
      b = end
    } else {
      b = a
      while (b < text.length && text[b] !== ' ') b++
      if (b === a) b = Math.min(text.length, a + 1)
    }
  }
  const delta = unitDelta(unit)
  return { from: starts[a] + delta, to: ends[b - 1] + delta }
}

export function suggestionCount(state: LanguageSuggestionsState): number {
  return state.units.reduce((n, unit) => n + visibleEdits(unit).length, 0)
}

export type SuggestionTarget = {
  hash: string
  unitFrom: number
  index: number
  /** Where its underline starts. */
  from: number
}

export function orderedSuggestions(
  state: LanguageSuggestionsState
): SuggestionTarget[] {
  return state.units
    .flatMap(unit =>
      visibleEdits(unit).map(({ index, edit }) => ({
        hash: unit.hash,
        unitFrom: unit.from,
        index,
        from: displayRange(unit, edit).from,
      }))
    )
    .sort((a, b) => a.from - b.from)
}

/** The suggestion after (1) or before (-1) the cursor, wrapping around. */
export function nextSuggestion(
  state: LanguageSuggestionsState,
  cursor: number,
  direction: 1 | -1
): SuggestionTarget | null {
  const list = orderedSuggestions(state)
  if (list.length === 0) return null
  if (direction === 1) return list.find(target => target.from > cursor) ?? list[0]
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].from < cursor) return list[i]
  }
  return list[list.length - 1]
}

/** Whether a change touches the inside of [from, to); typing at either edge does not. */
function touches(changes: ChangeSet, from: number, to: number): boolean {
  let hit = false
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA < to && toA > from) hit = true
    else if (fromA === toA && fromA > from && fromA < to) hit = true
  })
  return hit
}

/**
 * One function per card: CodeMirror keeps a tooltip's DOM while the new
 * tooltip has the same `create`, so the card keeps its React state, and it
 * matches tooltips by `create`, so two open cards must not share one.
 */
function cardContainer(): () => TooltipView {
  return () => {
    const dom = document.createElement('div')
    dom.className = 'ol-language-suggestion-card-container'
    return { dom, overlap: true, offset: { x: 0, y: 4 } }
  }
}

function cardTooltip(pos: number, create: () => TooltipView): Tooltip {
  return { pos, above: false, strictSide: true, arrow: false, create }
}

const sameUnit = (a: { hash: string; from: number }, b: { hash: string; from: number }) =>
  a.hash === b.hash && a.from === b.from

/** The card again, after a change: on a visible edit of its unit, or gone. */
function resolveCard(
  card: CardState | null,
  units: UnitSuggestions[]
): CardState | null {
  if (!card) return null
  const unit = units.find(u => u.hash === card.hash && u.from === card.from)
  if (!unit) return null
  const visible = visibleEdits(unit)
  if (visible.length === 0) return null
  const edit = visible.some(v => v.index === card.edit)
    ? card.edit
    : visible[0].index
  const pos = displayRange(unit, unit.edits[edit]).from
  if (edit === card.edit && card.tooltip.pos === pos) return card
  return { ...card, edit, tooltip: cardTooltip(pos, card.create) }
}

function nextPinOrder(cards: CardState[]): number {
  return cards.reduce((max, c) => Math.max(max, c.pinOrder || 0), 0) + 1
}

function resolveCards(
  cards: CardState[],
  units: UnitSuggestions[]
): CardState[] {
  return cards
    .map(c => resolveCard(c, units))
    .filter((c): c is CardState => c !== null)
}

function decorationsFor(
  value: LanguageSuggestionsState,
  docLength: number
): DecorationSet {
  const ranges = []
  const activeCards = value.cards?.length ? value.cards : value.card ? [value.card] : []
  for (const unit of value.units) {
    for (const { index, edit } of visibleEdits(unit)) {
      const { from, to } = displayRange(unit, edit)
      if (from >= to || to > docLength) continue
      const active = activeCards.some(
        c => sameUnit(c, unit) && c.edit === index
      )
      ranges.push(
        Decoration.mark({
          // Style (blue) is told apart from corrections (orange) by its underline colour
          class: [
            'ol-language-suggestion',
            editKind(edit) === 'style' ? 'ol-language-suggestion-style' : '',
            active ? 'ol-language-suggestion-active' : '',
          ]
            .filter(Boolean)
            .join(' '),
          attributes: { 'data-language-suggestion': `${unit.from}:${index}` },
        }).range(from, to)
      )
    }
  }
  return Decoration.set(ranges, true)
}

export const languageSuggestionsField =
  StateField.define<LanguageSuggestionsState>({
    create: () => ({
      units: [],
      cards: [],
      card: null,
      status: { kind: 'idle' },
      filters: 0,
    }),
    update(value, tr) {
      let { units, cards, card, status, filters } = value
      if (!cards) cards = card ? [card] : []

      if (tr.docChanged) {
        units = units
          .filter(unit => !touches(tr.changes, unit.from, unit.to))
          .map(unit => ({
            ...unit,
            from: tr.changes.mapPos(unit.from, 1),
            to: tr.changes.mapPos(unit.to, -1),
          }))
        if (tr.isUserEvent(ACCEPT_USER_EVENT)) {
          cards = cards.map(c => ({
            ...c,
            from: tr.changes.mapPos(c.from, 1),
          }))
        } else {
          // Pinned cards hold on screen across edits in other parts of the document
          cards = cards
            .filter(c => c.pinned)
            .map(c => ({
              ...c,
              from: tr.changes.mapPos(c.from, 1),
            }))
        }
      }
      for (const effect of tr.effects) {
        if (effect.is(setUnitResults)) {
          units = effect.value
        } else if (effect.is(addUnit)) {
          units = [...units, effect.value].sort((a, b) => a.from - b.from)
        } else if (effect.is(removeEdits)) {
          const { hash, edits } = effect.value
          units = units
            .map(unit =>
              unit.hash === hash
                ? {
                    ...unit,
                    edits: unit.edits.filter(
                      edit => !edits.some(removed => sameEdit(removed, edit))
                    ),
                  }
                : unit
            )
            .filter(unit => unit.edits.length > 0)
        } else if (effect.is(openCard)) {
          const { hash, from, edit } = effect.value
          const target = { hash, from }
          const existingIndex = cards.findIndex(c => sameUnit(c, target))
          if (existingIndex >= 0) {
            const existing = cards[existingIndex]
            const order = existing.pinned ? nextPinOrder(cards) : existing.pinOrder
            const updatedCard: CardState = {
              ...existing,
              edit,
              pinOrder: order,
            }
            cards = [
              ...cards.slice(0, existingIndex),
              ...cards.slice(existingIndex + 1),
              updatedCard,
            ]
          } else {
            // Dismiss unpinned card when opening another, but keep all pinned cards
            cards = cards.filter(c => c.pinned)
            const create = cardContainer()
            const newCard: CardState = {
              hash,
              from,
              edit,
              pinned: false,
              pinOrder: nextPinOrder(cards),
              create,
              tooltip: cardTooltip(-1, create),
            }
            cards = [...cards, newCard]
          }
        } else if (effect.is(togglePinCard)) {
          const target = effect.value
          const index = cards.findIndex(c => sameUnit(c, target))
          if (index >= 0) {
            const currentCard = cards[index]
            const willPin = !currentCard.pinned
            const updatedCard: CardState = {
              ...currentCard,
              pinned: willPin,
              pinOrder: willPin ? nextPinOrder(cards) : 0,
            }
            cards = [
              ...cards.slice(0, index),
              ...cards.slice(index + 1),
              updatedCard,
            ]
          }
        } else if (effect.is(bringCardToFront)) {
          const target = effect.value
          const index = cards.findIndex(c => sameUnit(c, target))
          if (index >= 0) {
            const currentCard = cards[index]
            const updatedCard: CardState = {
              ...currentCard,
              pinOrder: nextPinOrder(cards),
            }
            cards = [
              ...cards.slice(0, index),
              ...cards.slice(index + 1),
              updatedCard,
            ]
          }
        } else if (effect.is(closeCard)) {
          const target = effect.value
          if (!target) {
            // Clicking elsewhere: close only unpinned cards, keep pinned cards holding
            cards = cards.filter(c => c.pinned)
          } else {
            // Explicit close on a targeted card (Accept, Reject, Block, or Close)
            cards = cards.filter(c => !sameUnit(c, target))
          }
        } else if (effect.is(setStatus)) {
          status = effect.value
        } else if (effect.is(refreshFilters)) {
          filters++
        }
      }

      cards = resolveCards(cards, units)
      const unpinned = cards.find(c => !c.pinned)
      card = unpinned ?? (cards.length > 0 ? cards[cards.length - 1] : null)

      if (
        units === value.units &&
        cards === value.cards &&
        card === value.card &&
        status === value.status &&
        filters === value.filters
      ) {
        return value
      }
      return { units, cards, card, status, filters }
    },
    provide: field => [
      EditorView.decorations.compute([field], state =>
        decorationsFor(state.field(field), state.doc.length)
      ),
      showTooltip.computeN([field], state => {
        const { cards, card } = state.field(field)
        const allCards = cards?.length ? cards : card ? [card] : []
        return allCards.map(c => c.tooltip)
      }),
    ],
  })
