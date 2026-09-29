import { closesFence, fenceMarker } from './extract/markdown-clean.mjs'
import { clip, collapse } from './util.mjs'

/**
 * What find searches: a document as blocks (paragraphs, list items, tables,
 * code blocks, headings), each with the headings above it, and text
 * normalized the same way on both sides of a comparison.
 */

/** Words a question is phrased with, which say nothing about what it asks. */
export const STOPWORDS = new Set(
  'a about all also an and any are as at be been but by can could did do does doing for from get had has have how i if in into is it its me my no not of on or our should so some than that the their them then there these they this those to too use used using was we were what when where which who whom whose why will with would you your'.split(
    ' '
  )
)

/** A backslash before ASCII punctuation is a Markdown escape: `\_`, `\\`, `\[`. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g
const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g

/**
 * Text as find compares it. Case, Markdown escapes, code and bold markers,
 * link targets, curly quotes and dashes, and whether two words are joined by
 * a space, a hyphen or an underscore all stop mattering.
 */
export function searchText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(MARKDOWN_LINK, '$1')
    .replace(MARKDOWN_ESCAPE, '$1')
    .replace(/`+|\*{2,}/g, '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/(?<=[\p{L}\p{N}])[-_]+(?=[\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The words of a normalized phrase worth searching for, LaTeX commands kept whole. */
export function termsOf(phrase, max = 8) {
  return [
    ...new Set(
      phrase
        .split(/[^\p{L}\p{N}\\]+/u)
        .filter(term => term.replace(/\\/g, '').length >= 2)
        .filter(term => !STOPWORDS.has(term))
    ),
  ].slice(0, max)
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A term matches at the start of a word: "unit" finds "units", not "community". */
export function termPattern(term) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}`, 'gu')
}

export function countOf(pattern, text) {
  pattern.lastIndex = 0
  let count = 0
  while (pattern.exec(text)) count++
  return count
}

export function occurrences(text, phrase) {
  if (!phrase) return 0
  let count = 0
  for (
    let at = text.indexOf(phrase);
    at !== -1;
    at = text.indexOf(phrase, at + phrase.length)
  ) {
    count++
  }
  return count
}

function headingTitle(text) {
  return clip(collapse(text.replace(MARKDOWN_LINK, '$1')), 80)
}

/**
 * The document as blocks separated by blank lines, each with its offsets and
 * the titles of the headings above it. A code fence is one block, and so is
 * each heading. `onBlock` receives them in order, so a caller can stream them
 * into an index instead of holding them all.
 */
export function eachBlock(text, onBlock) {
  const path = []
  let lines = []
  let start = 0
  let fence = null
  let index = 0
  const emit = (kind, from, to, level = 0) =>
    onBlock({
      index: index++,
      kind,
      start: from,
      end: to,
      level,
      path: path.map(entry => entry.title),
    })
  const flush = () => {
    if (lines.length === 0) return
    emit(
      lines.every(line => line.text.startsWith('|')) ? 'table' : 'text',
      start,
      lines[lines.length - 1].end
    )
    lines = []
  }
  let pos = 0
  while (pos <= text.length) {
    let newline = text.indexOf('\n', pos)
    if (newline === -1) newline = text.length
    const line = { text: text.slice(pos, newline), start: pos, end: newline }
    pos = newline + 1
    if (fence) {
      lines.push(line)
      if (closesFence(fence, line.text)) {
        emit('fence', start, line.end)
        lines = []
        fence = null
      }
      continue
    }
    const marker = fenceMarker(line.text)
    if (marker) {
      flush()
      start = line.start
      lines.push(line)
      fence = marker
      continue
    }
    const heading = /^(#{1,6}) +(\S.*)$/.exec(line.text)
    if (heading) {
      flush()
      const level = heading[1].length
      while (path.length && path[path.length - 1].level >= level) path.pop()
      emit('heading', line.start, line.end, level)
      path.push({ level, title: headingTitle(heading[2]) })
      continue
    }
    if (line.text.trim()) {
      if (lines.length === 0) start = line.start
      lines.push(line)
    } else {
      flush()
    }
  }
  // A fence left open at the end is still code
  if (fence) emit('fence', start, lines[lines.length - 1].end)
  else flush()
  return index
}

export function blocksOf(text) {
  const blocks = []
  eachBlock(text, block => {
    block.text = text.slice(block.start, block.end)
    blocks.push(block)
  })
  return blocks
}
