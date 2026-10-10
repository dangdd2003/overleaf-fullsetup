import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { SyntaxNode } from '@lezer/common'
import { ancestorNodeOfType } from '@/features/source-editor/utils/tree-operations/ancestors'
import { mathAncestorNode } from '@/features/source-editor/utils/tree-operations/math'
import { matchingBrace } from '../texgpt/latex-text'

export type MathKind = 'inline' | 'display' | 'align'
export type Container = 'text' | 'caption' | 'heading' | 'cell'

/** Where the anchor is, with the bounds a passage must stay inside. */
export type CursorWhere =
  | { kind: 'text'; container: Container; from: number; to: number }
  | { kind: 'math'; math: MathKind; from: number; to: number }
  | { kind: 'refused' }

export type PassageParts = {
  from: number
  to: number
  /** Passage text before the anchor. */
  before: string
  /** The selected text the equation replaces; empty at a cursor. */
  selection: string
  /** Passage text after the anchor. */
  after: string
}

export const MIN_WORDS_BEFORE = 8
export const MAX_WORDS_BEFORE = 40
export const MAX_CHARS_BEFORE = 300
export const MAX_WORDS_AFTER = 25
export const MAX_CHARS_AFTER = 200

const COMMENT_START = /(?<!\\)%/

/** Lines a passage never crosses. */
const HARD_STOP_LINE =
  /^\s*(?:$|%|\\(?:begin|end)\s*\{|\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]|\\\[|\\\]|\$\$)/

/** Things that end one stretch of text and start another inside a line. */
const IN_LINE_STOP =
  /\\item\b\s*(?:\[[^\]]*\]\s*)?|\\(?:begin|end)\s*\{[^}]*\}\s*|\\\[\s*|\\\]\s*|\\\\\s*(?:\[[^\]]*\]\s*)?|\\par\b\s*|\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{[^}]*\}\s*|(?<!\\)&\s*/g

const SENTENCE_END_BEFORE = /[.?!](?=\s+[A-Z\\])/g
const SENTENCE_END_AFTER = /[.?!](?=\s|$)/g

/** A full stop after one of these does not end the sentence. */
const ABBREVIATION =
  /(?:^|[\s~(])(?:e\.g|i\.e|cf|Eq|Eqs|Fig|Figs|Sec|Secs|Ref|Refs|al|etc|vs|resp|approx|No|Thm|Lem|Def|Prop|Cor|Ch|Tab|Alg|App)$/i

function mathContent(node: SyntaxNode): { from: number; to: number } {
  if (node.type.is('$Environment')) {
    const content = node.getChild('Content')
    return content
      ? { from: content.from, to: content.to }
      : { from: node.from, to: node.to }
  }
  if (node.type.is('DollarMath')) {
    const width = node.getChild('DisplayMath') ? 2 : 1
    return { from: node.from + width, to: node.to - width }
  }
  // \( … \) and \[ … \]
  return { from: node.from + 2, to: node.to - 2 }
}

/** What kind of place the anchor is in, from the editor's syntax tree. */
export function cursorWhere(state: EditorState, pos: number): CursorWhere {
  const line = state.doc.lineAt(pos)
  if (COMMENT_START.test(state.sliceDoc(line.from, pos))) return { kind: 'refused' }
  ensureSyntaxTree(state, Math.min(state.doc.length, line.to), 500)
  if (ancestorNodeOfType(state, pos, 'VerbatimEnvironment')) {
    return { kind: 'refused' }
  }

  const math = mathAncestorNode(state, pos)
  if (math) {
    // `&` and `\\` are allowed when the nearest math around the anchor aligns
    const array = ancestorNodeOfType(state, pos, 'EquationArrayEnvironment')
    const kind: MathKind =
      array && array.from >= math.from
        ? 'align'
        : math.type.is('EquationEnvironment') ||
            math.type.is('BracketMath') ||
            math.getChild('DisplayMath')
          ? 'display'
          : 'inline'
    return { kind: 'math', math: kind, ...mathContent(math) }
  }

  const caption = ancestorNodeOfType(state, pos, 'Caption')?.getChild('TextArgument')
  if (caption && caption.from < pos && pos < caption.to) {
    return { kind: 'text', container: 'caption', from: caption.from + 1, to: caption.to - 1 }
  }
  const heading = ancestorNodeOfType(state, pos, 'SectioningArgument')
  if (heading) {
    return { kind: 'text', container: 'heading', from: heading.from + 1, to: heading.to - 1 }
  }
  const cell = ancestorNodeOfType(state, pos, 'TabularContent')
  if (cell) return { kind: 'text', container: 'cell', from: cell.from, to: cell.to }
  return { kind: 'text', container: 'text', from: 0, to: state.doc.length }
}

function lineStart(doc: string, pos: number): number {
  return doc.lastIndexOf('\n', pos - 1) + 1
}

function lineEnd(doc: string, pos: number): number {
  const end = doc.indexOf('\n', pos)
  return end === -1 ? doc.length : end
}

/** The leading whitespace of the line holding `pos`. */
export function lineIndent(doc: string, pos: number): string {
  const start = lineStart(doc, pos)
  return /^[ \t]*/.exec(doc.slice(start, lineEnd(doc, pos)))![0]
}

/** End of the last in-line stop in `text`, or -1. */
function lastStopEnd(text: string): number {
  let end = -1
  for (const match of text.matchAll(IN_LINE_STOP)) {
    end = match.index! + match[0].length
  }
  return end
}

/** Start of the first in-line stop in `text`, or -1. */
function firstStop(text: string): number {
  const match = new RegExp(IN_LINE_STOP.source).exec(text)
  return match ? match.index : -1
}

/** How far the passage may reach: lines and in-line stops, never comments. */
function hardBounds(doc: string, anchor: { from: number; to: number }) {
  const startLine = lineStart(doc, anchor.from)
  let lo = startLine
  const head = lastStopEnd(doc.slice(startLine, anchor.from))
  if (head !== -1) {
    lo = startLine + head
  } else {
    while (lo > 0) {
      const prevFrom = lineStart(doc, lo - 1)
      const prev = doc.slice(prevFrom, lo - 1)
      if (HARD_STOP_LINE.test(prev) || COMMENT_START.test(prev)) break
      const stop = lastStopEnd(prev)
      if (stop !== -1) {
        lo = prevFrom + stop
        break
      }
      lo = prevFrom
    }
  }

  const endLineEnd = lineEnd(doc, anchor.to)
  const tail = doc.slice(anchor.to, endLineEnd)
  const cuts = [firstStop(tail), tail.search(COMMENT_START)].filter(i => i !== -1)
  let hi: number
  if (cuts.length > 0) {
    hi = anchor.to + Math.min(...cuts)
  } else {
    hi = endLineEnd
    while (hi < doc.length) {
      const nextFrom = hi + 1
      const nextTo = lineEnd(doc, nextFrom)
      const next = doc.slice(nextFrom, nextTo)
      if (HARD_STOP_LINE.test(next) || COMMENT_START.test(next)) break
      const stop = firstStop(next)
      if (stop !== -1) {
        hi = nextFrom + stop
        break
      }
      hi = nextTo
    }
  }
  return { lo, hi }
}

/** A selection that spans a stop is used as the whole passage. */
function crossesStop(selection: string): boolean {
  return (
    selection
      .split('\n')
      .slice(1)
      .some(line => HARD_STOP_LINE.test(line)) ||
    new RegExp(IN_LINE_STOP.source).test(selection) ||
    COMMENT_START.test(selection)
  )
}

/**
 * Same length: inline math and brace groups blanked, so the full stops and
 * words inside them never end a sentence.
 */
function maskInner(text: string): string {
  let out = text.replace(
    /(?<!\\)\$[^$]*\$|\\\([\s\S]*?\\\)/g,
    math => math[0] + 'x'.repeat(math.length - 2) + math[math.length - 1]
  )
  let previous: string
  do {
    previous = out
    out = out.replace(/\{[^{}]*\}/g, group => `<${'x'.repeat(group.length - 2)}>`)
  } while (out !== previous)
  return out
}

/** Offset in `text` (the stretch before the anchor) where the passage starts. */
function startBefore(text: string): number {
  const masked = maskInner(text)
  let start = 0
  for (const match of masked.matchAll(SENTENCE_END_BEFORE)) {
    if (!ABBREVIATION.test(masked.slice(0, match.index))) start = match.index! + 1
  }
  const words = [...text.matchAll(/\S+/g)].map(word => word.index!)
  const wordsFrom = (at: number) => words.filter(index => index >= at).length
  if (wordsFrom(start) < MIN_WORDS_BEFORE) {
    start = words.length >= MIN_WORDS_BEFORE ? words[words.length - MIN_WORDS_BEFORE] : 0
  }
  if (wordsFrom(start) > MAX_WORDS_BEFORE) {
    start = words[words.length - MAX_WORDS_BEFORE]
  }
  if (text.length - start > MAX_CHARS_BEFORE) {
    start = words.find(index => index >= text.length - MAX_CHARS_BEFORE) ?? text.length
  }
  return words.find(index => index >= start) ?? text.length
}

/** Offset in `text` (the stretch after the anchor) where the passage ends. */
function endAfter(text: string): number {
  const masked = maskInner(text)
  let end = text.length
  for (const match of masked.matchAll(SENTENCE_END_AFTER)) {
    if (!ABBREVIATION.test(masked.slice(0, match.index))) {
      end = match.index! + 1
      break
    }
  }
  const words = [...text.matchAll(/\S+/g)]
    .filter(word => word.index! < end)
    .map(word => ({ from: word.index!, to: word.index! + word[0].length }))
  if (words.length > MAX_WORDS_AFTER) end = words[MAX_WORDS_AFTER - 1].to
  if (end > MAX_CHARS_AFTER) {
    end = words.filter(word => word.to <= MAX_CHARS_AFTER).pop()?.to ?? 0
  }
  return text.slice(0, end).trimEnd().length
}

/** The innermost `{…}` group holding the whole anchor, as content bounds. */
function enclosingGroup(doc: string, lo: number, anchor: { from: number; to: number }) {
  const stack: number[] = []
  for (let i = lo; i < anchor.from; i++) {
    const char = doc[i]
    if (char === '\\') {
      i++
    } else if (char === '{') {
      stack.push(i)
    } else if (char === '}') {
      stack.pop()
    }
  }
  while (stack.length > 0) {
    const open = stack.pop()!
    const close = matchingBrace(doc, open)
    if (close !== -1 && close >= anchor.to) return { from: open + 1, to: close }
  }
  return null
}

/** Past a `}` whose group opened before the start; then to a word start. */
function shrinkStart(doc: string, from: number, anchorFrom: number): number {
  let depth = 0
  let start = from
  for (let i = from; i < anchorFrom; i++) {
    const char = doc[i]
    if (char === '\\') {
      i++
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      if (depth > 0) depth--
      else start = i + 1
    }
  }
  while (start < anchorFrom && /\s/.test(doc[start])) start++
  return start
}

/** Where the command owning the `{` at `open` starts (`\footnote{` → `\`). */
function commandStart(doc: string, open: number): number {
  const head = doc.slice(Math.max(0, open - 100), open)
  const match = /\\[A-Za-z@]+\*?\s*(?:\[[^\]]*\]\s*)*$/.exec(head)
  return match ? open - match[0].length : open
}

function trimEndAt(doc: string, min: number, at: number): number {
  while (at > min && /\s/.test(doc[at - 1])) at--
  return at
}

/** A group opened after the anchor and still open at the end: complete it, or leave it out. */
function growEnd(doc: string, anchorTo: number, to: number, hi: number): number {
  const stack: number[] = []
  for (let i = anchorTo; i < to; i++) {
    const char = doc[i]
    if (char === '\\') {
      i++
    } else if (char === '{') {
      stack.push(i)
    } else if (char === '}') {
      if (stack.length > 0) stack.pop()
      else return trimEndAt(doc, anchorTo, i)
    }
  }
  if (stack.length === 0) return to
  const open = stack[0]
  const close = matchingBrace(doc, open)
  if (close !== -1 && close < hi) return close + 1
  return trimEndAt(doc, anchorTo, commandStart(doc, open))
}

/** The editable window around the anchor (see the spec, Context → Passage). */
export function findPassage(
  doc: string,
  anchor: { from: number; to: number },
  where: CursorWhere
): PassageParts {
  const parts = (from: number, to: number): PassageParts => ({
    from,
    to,
    before: doc.slice(from, anchor.from),
    selection: doc.slice(anchor.from, anchor.to),
    after: doc.slice(anchor.to, to),
  })
  if (where.kind === 'refused') return parts(anchor.from, anchor.to)
  if (where.kind === 'math') {
    const from = Math.max(lineStart(doc, anchor.from), where.from)
    const to = Math.min(lineEnd(doc, anchor.to), where.to)
    return parts(Math.min(from, anchor.from), Math.max(to, anchor.to))
  }
  if (anchor.to > anchor.from && crossesStop(doc.slice(anchor.from, anchor.to))) {
    return parts(anchor.from, anchor.to)
  }

  let { lo, hi } = hardBounds(doc, anchor)
  lo = Math.max(lo, where.from)
  hi = Math.min(hi, where.to)
  const group = enclosingGroup(doc, lo, anchor)
  if (group) {
    lo = Math.max(lo, group.from)
    hi = Math.min(hi, group.to)
  }
  lo = Math.min(lo, anchor.from)
  hi = Math.max(hi, anchor.to)

  let from = lo + startBefore(doc.slice(lo, anchor.from))
  let to = anchor.to + endAfter(doc.slice(anchor.to, hi))
  from = shrinkStart(doc, from, anchor.from)
  to = growEnd(doc, anchor.to, to, hi)
  return parts(from, to)
}

/** The passage as the model sees it: `<cursor/>` at the anchor, or the selection marked. */
export function passageMarkup(parts: PassageParts): string {
  const middle = parts.selection
    ? `<selection>${parts.selection}</selection>`
    : '<cursor/>'
  return `${parts.before}${middle}${parts.after}`
}
