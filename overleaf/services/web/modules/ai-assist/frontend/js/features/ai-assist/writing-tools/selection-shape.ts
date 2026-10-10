import {
  availableActions,
  JOINED_SENTENCE_WORDS,
  menuNotice,
  SelectionShape,
  SHORT_SENTENCE_WORDS,
  WritingActionId,
  WritingMenuNotice,
} from './actions'
import {
  COMMENT_PATTERN,
  KEYED_COMMAND_PATTERN,
  MATH_PATTERN,
} from './latex-patterns'
import type { TextContainer } from '../inline-context/cursor-context'

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu

function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0
}

/**
 * The prose a reader would see, for counting only: comments, math, keys and
 * command names are dropped. Hard line breaks inside a paragraph become
 * spaces, because a sentence segmenter treats every newline as a sentence end
 * and LaTeX source is usually hard-wrapped. Paragraphs, separated by a blank
 * line, \par, \item or an environment boundary, come out as "\n\n".
 */
export function proseOf(latex: string): string {
  return latex
    .replace(COMMENT_PATTERN, '$1')
    .replace(MATH_PATTERN, ' ')
    .replace(KEYED_COMMAND_PATTERN, ' ')
    .replace(
      /\\(?:begin|end)\s*\{[^}]*\}|\\(?:item|par)(?![a-zA-Z@])(?:\[[^\]]*\])?/g,
      '\n\n'
    )
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/\\./g, ' ')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .split(/\n[ \t]*\n\s*/)
    .map(paragraph => paragraph.replace(/[ \t]*\n[ \t]*/g, ' '))
    .join('\n\n')
}

/** Words, sentences and the longest sentence of a LaTeX selection. */
export function selectionShape(latex: string): SelectionShape {
  const prose = proseOf(latex)
  let sentences = 0
  let longestSentence = 0
  let joinable = 0
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })
  for (const paragraph of prose.split(/\n{2,}/)) {
    // Sentences are joined within a paragraph, never across one
    let previous = 0
    for (const { segment } of segmenter.segment(paragraph)) {
      const words = countWords(segment)
      if (words === 0) continue
      sentences++
      longestSentence = Math.max(longestSentence, words)
      if (
        previous > 0 &&
        Math.min(previous, words) <= SHORT_SENTENCE_WORDS &&
        previous + words <= JOINED_SENTENCE_WORDS
      ) {
        joinable++
      }
      previous = words
    }
  }
  return {
    words: countWords(prose),
    sentences,
    longestSentence,
    joinable,
    hasLetters: /\p{L}/u.test(prose),
    chars: latex.trim().length,
  }
}

/** The Writing tools menu for a LaTeX selection in a given kind of text. */
export function writingMenu(
  latex: string,
  container?: TextContainer
): { actions: WritingActionId[]; notice: WritingMenuNotice | null } {
  const shape = selectionShape(latex)
  return {
    actions: availableActions(shape, container),
    notice: menuNotice(shape),
  }
}
