import { documentHints } from '../writing-tools/prompt'
import { isEnglishOrUnknown } from './prompt'

/**
 * Text that is never sent for a check, besides what the prose scanner leaves
 * out (the preamble, math, code, the bibliography):
 * - anything between `% ai-check-off` and `% ai-check-on` (or the file end);
 * - in an English document, a paragraph in another language (a quotation,
 *   an abstract in a second language), which an English check would flag.
 */

const OFF = /^[ \t]*%[ \t]*ai-check-off\b/i
const ON = /^[ \t]*%[ \t]*ai-check-on\b/i

/** Source ranges switched off by `% ai-check-off` … `% ai-check-on` lines. */
export function switchedOffRanges(doc: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let offAt: number | null = null
  let lineStart = 0
  while (lineStart <= doc.length) {
    let lineEnd = doc.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = doc.length
    const line = doc.slice(lineStart, lineEnd)
    if (offAt === null && OFF.test(line)) offAt = lineStart
    else if (offAt !== null && ON.test(line)) {
      ranges.push([offAt, lineEnd])
      offAt = null
    }
    lineStart = lineEnd + 1
  }
  if (offAt !== null) ranges.push([offAt, doc.length])
  return ranges
}

export function inRanges(ranges: Array<[number, number]>, pos: number): boolean {
  return ranges.some(([from, to]) => from <= pos && pos <= to)
}

/** The commonest English words: academic English is full of them. */
const ENGLISH_WORDS = new Set(
  (
    'the of and to in is a for that we on with as are by this be an it from at ' +
    'which or not can our these was were has have its their also than more used ' +
    'using such between each other into both when where how what all may one two'
  ).split(' ')
)
/** A paragraph needs this many words before its language is judged. */
const MIN_WORDS_TO_JUDGE = 12
/** English prose: at least this share of its words are common English words… */
const ENGLISH_SHARE = 0.15
/** …and a paragraph below this share is in another language. */
const FOREIGN_SHARE = 0.04

function words(text: string): string[] {
  return text.replace(/\[\[[MCRX]\d*\]\]/g, ' ').toLowerCase().match(/\p{L}+/gu) ?? []
}

function englishShare(list: string[]): number {
  if (list.length === 0) return 0
  return list.filter(word => ENGLISH_WORDS.has(word)).length / list.length
}

/**
 * Which paragraphs to leave out as not English, given each paragraph's text.
 * Only in a document that is English: one that says so (babel, polyglossia),
 * or, saying nothing (a chapter file), whose prose as a whole reads as
 * English. A document in another language is never filtered.
 */
export function foreignParagraphs(doc: string, paragraphs: string[]): Set<number> {
  const skipped = new Set<number>()
  const { language } = documentHints(doc)
  if (!isEnglishOrUnknown(language)) return skipped
  if (!language && englishShare(paragraphs.flatMap(words)) < ENGLISH_SHARE) return skipped
  paragraphs.forEach((text, index) => {
    const list = words(text)
    if (list.length >= MIN_WORDS_TO_JUDGE && englishShare(list) < FOREIGN_SHARE) {
      skipped.add(index)
    }
  })
  return skipped
}
