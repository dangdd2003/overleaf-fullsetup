import { EditorState } from '@codemirror/state'
import { TextChange } from '../writing-tools/apply'
import { maskComments } from './latex-text'

/** Starts that make a snippet a paragraph-level block of its own. */
const BLOCK_START =
  /^\s*(?:\\begin\s*\{|\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]|\\item\b|\\\[|\\maketitle\b)/

/** Several lines, an environment, a heading…: code that wants its own lines. */
export function isBlock(code: string): boolean {
  return code.trim().includes('\n') || BLOCK_START.test(code)
}

/** Blank lines around a block are the document's business, not the snippet's. */
function blockBody(code: string): string {
  return code.replace(/^\s*\n/, '').replace(/\s+$/, '')
}

/**
 * The change that puts `code` at `pos`. A block gets its own lines: a line
 * break is added before it when text precedes `pos` on its line, and after
 * it when text follows. Anything else goes in as is.
 */
export function insertChange(
  state: EditorState,
  pos: number,
  code: string,
  { block = isBlock(code) }: { block?: boolean } = {}
): TextChange {
  if (!block) return { from: pos, to: pos, insert: code.trim() }
  const line = state.doc.lineAt(pos)
  let insert = blockBody(code)
  if (state.sliceDoc(line.from, pos).trim()) insert = `\n${insert}`
  if (state.sliceDoc(pos, line.to).trim()) insert = `${insert}\n`
  return { from: pos, to: pos, insert }
}

/**
 * `code` on new lines under the last line of `from`–`to`. A selection that
 * ends at a line start (a triple-click) ends on the line before it.
 */
export function insertBelowChange(
  state: EditorState,
  from: number,
  to: number,
  code: string
): TextChange {
  const last = to > from && state.doc.lineAt(to).from === to ? to - 1 : to
  const end = state.doc.lineAt(last).to
  const body = isBlock(code) ? blockBody(code) : code.trim()
  return { from: end, to: end, insert: `\n${body}` }
}

const PACKAGE_USE =
  /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g

/**
 * `\usepackage` lines for `packages`: after the last package the open
 * file's preamble loads, or right before `\begin{document}` when it loads
 * none. Null when this file holds no preamble (it is a chapter, or the
 * preamble lives elsewhere).
 */
export function preambleChange(
  doc: string,
  packages: string[]
): TextChange | null {
  if (packages.length === 0) return null
  const masked = maskComments(doc)
  const begin = masked.search(/\\begin\s*\{document\}/)
  if (begin === -1) return null
  const preamble = masked.slice(0, begin)
  if (!/\\documentclass\b/.test(preamble)) return null

  const lines = packages.map(name => `\\usepackage{${name}}`).join('\n')
  let last: RegExpMatchArray | null = null
  for (const match of preamble.matchAll(PACKAGE_USE)) last = match
  if (last) {
    const after = (last.index ?? 0) + last[0].length
    const lineEnd = doc.indexOf('\n', after)
    const at = lineEnd === -1 || lineEnd > begin ? after : lineEnd
    return { from: at, to: at, insert: `\n${lines}` }
  }
  const lineStart = doc.lastIndexOf('\n', begin - 1) + 1
  return { from: lineStart, to: lineStart, insert: `${lines}\n` }
}
