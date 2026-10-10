import type { TextContainer } from '../inline-context/cursor-context'

export type WritingActionId =
  | 'rephrase'
  | 'shorten'
  | 'scientific'
  | 'split'
  | 'join'
  | 'translate'
  | 'synonyms'

/** Up to this many words in one sentence is a phrase: Synonyms leads. */
export const SHORT_SELECTION_WORDS = 5
/** Below this many words there is nothing worth shortening. */
export const SHORTEN_MIN_WORDS = 10
/** A sentence at least this long is offered "Split long sentences". */
export const LONG_SENTENCE_WORDS = 25
/** A sentence at most this long is short enough to join with its neighbour. */
export const SHORT_SENTENCE_WORDS = 12
/** Two sentences are joined only when the result stays at most this long. */
export const JOINED_SENTENCE_WORDS = 35
/** The longest selection sent in one request, in characters. */
export const MAX_SELECTION_CHARS = 8000

export type SelectionShape = {
  /** Prose words: math, keys, command names and comments not counted. */
  words: number
  sentences: number
  longestSentence: number
  /** Neighbouring sentences in one paragraph that would read better joined. */
  joinable: number
  /** Whether the prose has any letters, not only numbers. */
  hasLetters: boolean
  /** The selection's length without its surrounding whitespace. */
  chars: number
}

/** Why the menu has no actions, shown in their place. */
export type WritingMenuNotice = 'empty' | 'tooLong' | 'noProse'

export function menuNotice(shape: SelectionShape): WritingMenuNotice | null {
  if (shape.chars === 0) return 'empty'
  if (shape.chars > MAX_SELECTION_CHARS) return 'tooLong'
  if (shape.words === 0 || !shape.hasLetters) return 'noProse'
  return null
}

/**
 * The menu for a selection, in display order, by what was selected:
 * - a word: its synonyms, or a translation;
 * - a phrase: alternatives first, then rewording;
 * - sentences: rewording, with Shorten, Split and Join only where the text
 *   gives them something to do. A heading stays one title, never split or joined.
 */
export function availableActions(
  shape: SelectionShape,
  container: TextContainer = 'text'
): WritingActionId[] {
  if (menuNotice(shape)) return []
  if (shape.words === 1) return ['synonyms', 'translate']
  if (shape.words <= SHORT_SELECTION_WORDS && shape.sentences <= 1) {
    return ['synonyms', 'rephrase', 'scientific', 'translate']
  }
  const actions: WritingActionId[] = ['rephrase']
  if (shape.words >= SHORTEN_MIN_WORDS) actions.push('shorten')
  actions.push('scientific')
  if (container !== 'heading') {
    if (shape.longestSentence >= LONG_SENTENCE_WORDS) actions.push('split')
    if (shape.joinable > 0) actions.push('join')
  }
  actions.push('translate')
  return actions
}
