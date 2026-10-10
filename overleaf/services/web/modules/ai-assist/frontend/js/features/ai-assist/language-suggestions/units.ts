import type { TextContainer } from '../inline-context/cursor-context'
import { MaskedText, sliceMasked } from './masked-text'
import { scanProse } from './prose'
import { normalizeForCheck } from './semantic'
import { foreignParagraphs, inRanges, switchedOffRanges } from './skip'

/** One sentence to check: its masked text and where it was. */
export type Unit = {
  hash: string
  container: TextContainer
  /** Index of its paragraph, in document order. */
  paragraph: number
  masked: MaskedText
  /** Its source range when scanned. */
  from: number
  to: number
}

export const MIN_WORDS = 3

/** A sentence never ends after these, whatever follows. */
const ALWAYS_JOIN = [
  'e.g.',
  'i.e.',
  'et al.',
  'cf.',
  'vs.',
  'Fig.',
  'Figs.',
  'Eq.',
  'Eqs.',
  'Sec.',
  'Ch.',
  'Tab.',
  'No.',
  'Ref.',
  'Refs.',
  'Dr.',
  'Prof.',
]

const PLACEHOLDER = /\[\[[MCRX]\d+\]\]/g

export function wordCount(text: string): number {
  return (text.replace(PLACEHOLDER, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length
}

function endsWithAbbreviation(text: string): boolean {
  const end = text.trimEnd()
  return ALWAYS_JOIN.some(
    abbreviation =>
      end === abbreviation ||
      end.endsWith(` ${abbreviation}`) ||
      end.endsWith(`(${abbreviation}`)
  )
}

/** A break the segmenter made that a reader would not: after an abbreviation, or before a lowercase word. */
function falseBreak(before: string, after: string): boolean {
  return endsWithAbbreviation(before) || /^[\p{Ll}\p{N}]/u.test(after.trimStart())
}

function rawSentences(text: string): Array<[number, number]> {
  const Segmenter = (Intl as any).Segmenter
  if (typeof Segmenter === 'function') {
    const segmenter = new Segmenter(undefined, { granularity: 'sentence' })
    return Array.from(
      segmenter.segment(text) as Iterable<{ index: number; segment: string }>,
      ({ index, segment }) => [index, index + segment.length]
    )
  }
  const ranges: Array<[number, number]> = []
  for (const match of text.matchAll(/[^.?!]*[.?!]+(?:\s+|$)|[^.?!]+$/g)) {
    if (match[0]) ranges.push([match.index!, match.index! + match[0].length])
  }
  return ranges
}

/** Sentence ranges in `text`, trimmed, with false breaks joined. */
export function splitSentences(text: string): Array<[number, number]> {
  const joined: Array<[number, number]> = []
  for (const range of rawSentences(text)) {
    const previous = joined[joined.length - 1]
    if (
      previous &&
      falseBreak(text.slice(previous[0], previous[1]), text.slice(range[0], range[1]))
    ) {
      previous[1] = range[1]
    } else {
      joined.push([range[0], range[1]])
    }
  }
  return joined.map(([from, to]) => {
    let start = from
    let end = to
    while (start < end && text[start] === ' ') start++
    while (end > start && text[end - 1] === ' ') end--
    return [start, end]
  })
}

/**
 * cyrb53, a fast 53-bit string hash in base 36, of the text as a check reads
 * it: sentences differing only in whitespace or placeholder numbers share it.
 */
export function hashUnit(container: TextContainer, text: string): string {
  const input = `${container}\u0000${normalizeForCheck(text).text}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** Every sentence worth checking in a LaTeX file, in document order (see skip.ts). */
export function buildUnits(doc: string): Unit[] {
  const units: Unit[] = []
  const paragraphs = scanProse(doc)
  const off = switchedOffRanges(doc)
  const foreign = foreignParagraphs(
    doc,
    paragraphs.map(paragraph => paragraph.masked.text)
  )
  paragraphs.forEach((paragraph, index) => {
    if (foreign.has(index)) return
    for (const [start, end] of splitSentences(paragraph.masked.text)) {
      if (end <= start) continue
      const masked = sliceMasked(paragraph.masked, start, end)
      if (masked.text.length === 0) continue
      const words = wordCount(masked.text)
      if (words < MIN_WORDS || masked.placeholders.length > words) continue
      if (off.length > 0 && inRanges(off, masked.starts[0])) continue
      units.push({
        hash: hashUnit(paragraph.container, masked.text),
        container: paragraph.container,
        paragraph: index,
        masked,
        from: masked.starts[0],
        to: masked.ends[masked.ends.length - 1],
      })
    }
  })
  return units
}

/** The unit whose source range holds `pos`. */
export function unitAt(units: Unit[], pos: number): Unit | undefined {
  return units.find(unit => unit.from <= pos && pos <= unit.to)
}
