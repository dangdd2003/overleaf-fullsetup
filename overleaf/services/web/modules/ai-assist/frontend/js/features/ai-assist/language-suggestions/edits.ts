import { diffWordsWithSpace } from 'diff'
import type { MaskedText } from './masked-text'

/**
 * What a suggestion is, by the result it came from (prompt.ts):
 * - grammar: a correction, the language check official Overleaf has
 *   (grammar, spelling, punctuation, word use), underlined in orange;
 * - style: a rewording that fits the document, underlined in blue.
 */
export type SuggestionKind = 'grammar' | 'style'

/** One suggested change, in the unit's masked text. */
export type MaskedEdit = {
  from: number
  to: number
  insert: string
  /** `masked.text.slice(from, to)`: what the edit replaces. */
  original: string
  /** Unset in results stored before kinds existed: those are corrections. */
  kind?: SuggestionKind
}

export function editKind(edit: MaskedEdit): SuggestionKind {
  return edit.kind === 'style' ? 'style' : 'grammar'
}

/** One change to the document. */
export type SourceChange = { from: number; to: number; insert: string }

/** A rewrite that changes more of the words than this is a new sentence. */
export const MAX_CHANGED_SHARE = 0.5

const PLACEHOLDER = /\[\[[MCRX]\d+\]\]/g
/** The masked text never holds these, so an edit that adds them adds LaTeX. */
const FORBIDDEN_IN_INSERT = /\[\[|\]\]|[\\{}~]/
const QUOTES = /[`'"“”‘’]/g

/** Typographic characters a model likes, written the way LaTeX source does. */
export function normaliseRewrite(text: string): string {
  return text
    .replace(/“/g, '``')
    .replace(/”/g, "''")
    .replace(/‘/g, '`')
    .replace(/’/g, "'")
    .replace(/—/g, '---')
    .replace(/–/g, '--')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function placeholders(text: string): string[] {
  return text.match(PLACEHOLDER) ?? []
}

function words(text: string): string[] {
  return text.replace(PLACEHOLDER, ' ').match(/[\p{L}\p{N}]+/gu) ?? []
}

function plain(text: string): string {
  return text.replace(QUOTES, '').replace(/\s+/g, ' ').trim()
}

/** Word-level edits from `original` to `rewrite`; edits one space apart merge. */
export function diffEdits(original: string, rewrite: string): MaskedEdit[] {
  const edits: MaskedEdit[] = []
  const parts = diffWordsWithSpace(original, rewrite)
  let position = 0
  let pending: MaskedEdit | null = null
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]
    if (part.added) {
      pending = pending ?? { from: position, to: position, insert: '', original: '' }
      pending.insert += part.value
    } else if (part.removed) {
      pending = pending ?? { from: position, to: position, insert: '', original: '' }
      pending.original += part.value
      position += part.value.length
      pending.to = position
    } else {
      const next = parts[k + 1]
      if (pending && part.value === ' ' && next && (next.added || next.removed)) {
        pending.original += ' '
        pending.insert += ' '
        position += 1
        pending.to = position
        continue
      }
      if (pending) edits.push(pending)
      pending = null
      position += part.value.length
    }
  }
  if (pending) edits.push(pending)
  return edits
}

/** Marks a space must not come before (in English and most languages the check corrects). */
const CLOSING_MARKS = /^[?!:;,.)\]]/
/** Marks a word follows after a space. */
const SPACED_MARKS = /^[,;:?!]$/

/**
 * A change only in spacing that a reader sees: a space dropped before a
 * mark (`responsibility ?` → `responsibility?`), or one added after a comma
 * or colon glued to the next word (`it,then` → `it, then`). Every other
 * whitespace change is invisible in the typeset document.
 */
export function isSpacingFix(edit: MaskedEdit, text: string): boolean {
  const { original, insert } = edit
  if (/^\s+\S/.test(original) && insert === original.trimStart() && CLOSING_MARKS.test(insert)) return true
  return (
    SPACED_MARKS.test(original) &&
    insert === `${original} ` &&
    /^\p{L}/u.test(text.slice(edit.to, edit.to + 1))
  )
}

/**
 * Edits that change spacing next to a mark take the mark in, so the card
 * shows `responsibility?` for `responsibility ?`, never a lone space:
 * - a space dropped before a mark (alone, or at the end of a reworded phrase);
 * - a space added after a mark.
 */
export function absorbMarks(text: string, edits: MaskedEdit[]): MaskedEdit[] {
  return edits.map((edit, k) => {
    const next = edits[k + 1]
    const mark = /^[?!:;,.)\]]+/.exec(text.slice(edit.to))?.[0]
    if (
      mark &&
      /\s$/.test(edit.original) &&
      !/\s$/.test(edit.insert) &&
      (!next || next.from >= edit.to + mark.length)
    ) {
      return {
        ...edit,
        to: edit.to + mark.length,
        original: edit.original + mark,
        insert: edit.insert + mark,
      }
    }
    if (/^\s+$/.test(edit.insert) && edit.original === '' && edit.from > 0 && SPACED_MARKS.test(text[edit.from - 1])) {
      const previous = edits[k - 1]
      if (!previous || previous.to < edit.from - 1) {
        return {
          ...edit,
          from: edit.from - 1,
          original: text[edit.from - 1],
          insert: text[edit.from - 1] + edit.insert,
        }
      }
    }
    return edit
  })
}

/** Whether an edit can be written to the source without touching any LaTeX. */
export function editIsSafe(masked: MaskedText, edit: MaskedEdit): boolean {
  const { kinds, owners, starts, ends } = masked
  if (FORBIDDEN_IN_INSERT.test(edit.insert)) return false
  // Only whitespace or quote characters change: not worth a suggestion, unless the spacing shows
  if (plain(edit.original) === plain(edit.insert) && !isSpacingFix(edit, masked.text)) return false
  for (let i = edit.from; i < edit.to; i++) {
    if (kinds[i] === 'placeholder' || kinds[i] === 'hard') return false
    // Hidden LaTeX (a formatting command, a comment) between two covered characters
    if (i + 1 < edit.to && ends[i] !== starts[i + 1]) return false
  }
  if (
    edit.from === edit.to &&
    edit.from > 0 &&
    owners[edit.from] >= 0 &&
    owners[edit.from - 1] === owners[edit.from]
  ) {
    return false
  }
  return true
}

/**
 * Everything the checks keep from a model's rewrite of one sentence: the
 * safe edits, [] when there is nothing to suggest, or null when the whole
 * sentence is dropped.
 */
export function editsForRewrite(
  masked: MaskedText,
  rawRewrite: string,
  maxChangedShare = MAX_CHANGED_SHARE
): MaskedEdit[] | null {
  const original = masked.text
  const rewrite = normaliseRewrite(rawRewrite)
  if (!rewrite || rewrite === original) return []
  if (placeholders(original).join() !== placeholders(rewrite).join()) return null
  const edits = diffEdits(original, rewrite)
  const total = words(original).length
  const changed = edits.reduce((n, edit) => n + words(edit.original).length, 0)
  if (total > 0 && changed > total * maxChangedShare) return null
  return absorbMarks(original, edits).filter(edit => editIsSafe(masked, edit))
}

/** A style rewrite may reword more of a sentence than a correction. */
export const MAX_STYLE_CHANGED_SHARE = 0.6

const overlaps = (a: MaskedEdit, b: MaskedEdit) =>
  a.from === b.from || (a.from < b.to && b.from < a.to)

const sameEdit = (a: MaskedEdit, b: MaskedEdit) =>
  a.from === b.from && a.to === b.to && a.insert === b.insert

/** Whether `inner` lies inside `outer`: an insertion strictly inside, a replacement within it. */
export function containsEdit(outer: MaskedEdit, inner: MaskedEdit): boolean {
  if (inner.from < outer.from || inner.to > outer.to) return false
  return inner.to > inner.from || (inner.from > outer.from && inner.from < outer.to)
}

/**
 * A sentence's suggestions from its two results: `grammar`, the sentence
 * corrected, and `style`, the corrected sentence reworded:
 * - grammar edits: from the sentence to its correction;
 * - style edits: from the sentence to the rewording, less those the
 *   correction already makes. A rewording around a correction holds it: it
 *   waits, hidden, while the correction is open (state.ts), and once the
 *   correction is taken it is moved onto the corrected words (apply.ts).
 *   One that cuts through a correction is dropped.
 * Null when neither result is usable.
 */
export function editsForCheck(
  masked: MaskedText,
  { grammar, style }: { grammar?: string; style?: string }
): MaskedEdit[] | null {
  const corrections = grammar === undefined ? [] : editsForRewrite(masked, grammar)
  const rewording =
    style === undefined ? [] : editsForRewrite(masked, style, MAX_STYLE_CHANGED_SHARE)
  const unusable = (given: string | undefined, edits: MaskedEdit[] | null) =>
    given === undefined || edits === null
  if (
    (grammar !== undefined || style !== undefined) &&
    unusable(grammar, corrections) &&
    unusable(style, rewording)
  ) {
    return null
  }
  const grammarEdits = (corrections ?? []).map(edit => ({ ...edit, kind: 'grammar' as const }))
  // A rewording around a correction holds it; one cutting through a correction cannot be taken with it
  const styleEdits = (rewording ?? [])
    .filter(edit => !grammarEdits.some(other => sameEdit(edit, other)))
    .filter(edit =>
      grammarEdits.every(other => !overlaps(edit, other) || containsEdit(edit, other))
    )
    .map(edit => ({ ...edit, kind: 'style' as const }))
  return [...grammarEdits, ...styleEdits].sort((a, b) => a.from - b.from || a.to - b.to)
}

/** Replaces the space nearest each kept line break's relative position with `\n`. */
function keepLineBreaks(insert: string, offsets: number[], length: number): string {
  let result = insert
  for (const offset of offsets) {
    const target = Math.round((offset / Math.max(1, length)) * result.length)
    for (let distance = 0; distance <= result.length; distance++) {
      const candidates = [target - distance, target + distance]
      const hit = candidates.find(i => i >= 0 && i < result.length && result[i] === ' ')
      if (hit !== undefined) {
        result = result.slice(0, hit) + '\n' + result.slice(hit + 1)
        break
      }
    }
  }
  return result
}

/**
 * Where an edit goes in the document and what it writes there. `delta` is
 * how far the sentence moved since it was scanned.
 */
export function sourceChange(
  masked: MaskedText,
  edit: MaskedEdit,
  delta = 0
): SourceChange {
  const { starts, ends, kinds, text } = masked
  let from: number
  let to: number
  if (edit.to > edit.from) {
    from = starts[edit.from]
    to = ends[edit.to - 1]
  } else if (edit.from >= text.length) {
    from = to = ends[text.length - 1]
  } else if (edit.from === 0) {
    from = to = starts[0]
  } else {
    // Between two characters with hidden formatting between them, stay
    // outside it: punctuation after a closing brace, words before an opening one
    const before = ends[edit.from - 1]
    const after = starts[edit.from]
    from = to = before === after || /^[,.;:!?)\]]/.test(edit.insert) ? after : before
  }
  let insert = edit.insert.replace(/[%&#_$]/g, char => `\\${char}`)
  const breaks: number[] = []
  for (let i = edit.from; i < edit.to; i++) {
    if (kinds[i] === 'break') breaks.push(i - edit.from)
  }
  if (breaks.length > 0) insert = keepLineBreaks(insert, breaks, edit.to - edit.from)
  return { from: from + delta, to: to + delta, insert }
}

const MARKS_ONLY = /^[\s\p{P}\p{S}]*$/u
const WORD_CHAR = /[\p{L}\p{N}]/u

/** Whether an edit only adds, drops or swaps punctuation (a comma, a full stop…). */
export function isMarkEdit(edit: MaskedEdit): boolean {
  return (
    (edit.original + edit.insert).trim() !== '' &&
    MARKS_ONLY.test(edit.original) &&
    MARKS_ONLY.test(edit.insert)
  )
}

/**
 * How a punctuation edit is shown: with the word its mark sticks to, so
 * "," → "First" / "First," rather than a lone comma. Grows back over the
 * word before, or else forward over the word after; never past `min`/`max`
 * (a neighbouring edit) or into the author's LaTeX. Other edits as they are.
 */
export function displayEdit(
  masked: MaskedText,
  edit: MaskedEdit,
  min = 0,
  max = masked.text.length
): MaskedEdit {
  if (!isMarkEdit(edit)) return edit
  const { text, owners } = masked
  const isWord = (i: number) => owners[i] < 0 && WORD_CHAR.test(text[i])
  let from = edit.from
  while (from > min && isWord(from - 1)) from--
  if (from < edit.from) {
    const word = text.slice(from, edit.from)
    return {
      ...edit,
      from,
      original: word + edit.original,
      insert: word + edit.insert,
    }
  }
  let to = edit.to
  while (to < max && isWord(to)) to++
  if (to > edit.to) {
    const word = text.slice(edit.to, to)
    return {
      ...edit,
      to,
      original: edit.original + word,
      insert: edit.insert + word,
    }
  }
  return edit
}
