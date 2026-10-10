import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { SyntaxNode } from '@lezer/common'
import { getEnvironmentName } from '@/features/source-editor/utils/tree-operations/environments'
import { mathAncestorNode } from '@/features/source-editor/utils/tree-operations/math'
import { maskComments } from '../texgpt/latex-text'
import { structureProblems } from '../texgpt/checks'
import { isTabularText } from '../generator/clipboard'

/** Where the table goes: a new float, or only a tabular inside a float or box. */
export type InsertWhere = { kind: 'float' } | { kind: 'inner'; hasCaption: boolean }

export type TableWhere =
  | InsertWhere
  | { kind: 'refused'; reason: 'here' | 'table' | 'selection' }

/** What a selection holds: a table to rewrite, data to typeset, or prose. */
export type SelectionKind = 'table' | 'data' | 'text'

/** The passage for a block, and the line around it. */
export type BlockRange = {
  from: number
  to: number
  /** The anchor's line before the anchor. */
  lineBefore: string
  /** The anchor's line after the anchor's end. */
  lineAfter: string
  /** The leading whitespace of the anchor's line. */
  indent: string
}

/** Floats and boxes a float cannot go inside: only a tabular goes there. */
const INNER_ENVIRONMENTS = new Set([
  'table',
  'table*',
  'figure',
  'figure*',
  'subtable',
  'subfigure',
  'minipage',
  'wraptable',
  'wrapfigure',
  'sidewaystable',
  'sidewaysfigure',
  'threeparttable',
])

/** The inner environments that have a caption of their own. */
const FLOATS = new Set([
  'table',
  'table*',
  'figure',
  'figure*',
  'subtable',
  'subfigure',
  'wraptable',
  'wrapfigure',
  'sidewaystable',
  'sidewaysfigure',
])

/** Command arguments and groups: `\textbf{…}`, `\footnote{…}`, `{\small …}`. */
const GROUPS = ['Group', 'TextArgument', 'ShortTextArgument', 'OptionalArgument']
const COMMENT_START = /(?<!\\)%/

/** Syntax nodes that strictly contain `pos`, innermost first. */
function enclosing(state: EditorState, pos: number): SyntaxNode[] {
  const nodes: SyntaxNode[] = []
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.from < pos && pos < node.to) nodes.push(node)
  }
  return nodes
}

/** Where a table can go at `anchor`, read from the editor's syntax tree. */
export function tableWhere(
  state: EditorState,
  anchor: { from: number; to: number }
): TableWhere {
  const selection = state.sliceDoc(anchor.from, anchor.to)
  if (selection.trim() && structureProblems('', selection).length > 0) {
    return { kind: 'refused', reason: 'selection' }
  }
  const pos = anchor.from
  const line = state.doc.lineAt(pos)
  if (COMMENT_START.test(state.sliceDoc(line.from, pos))) {
    return { kind: 'refused', reason: 'here' }
  }
  ensureSyntaxTree(state, Math.min(state.doc.length, Math.max(line.to, anchor.to)), 500)
  if (mathAncestorNode(state, pos)) return { kind: 'refused', reason: 'here' }

  const nodes = enclosing(state, pos)
  if (nodes.some(node => node.type.is('TabularEnvironment'))) {
    return { kind: 'refused', reason: 'table' }
  }
  if (
    nodes.some(
      node =>
        node.type.is('VerbatimEnvironment') ||
        node.type.is('Caption') ||
        node.type.is('SectioningArgument') ||
        GROUPS.some(name => node.type.is(name))
    )
  ) {
    return { kind: 'refused', reason: 'here' }
  }

  const named = (node: SyntaxNode) =>
    node.type.is('$Environment') ? (getEnvironmentName(node, state) ?? '') : ''
  if (nodes.some(node => INNER_ENVIRONMENTS.has(named(node)))) {
    const float = nodes.find(node => FLOATS.has(named(node)))
    // A caption needs a float: in a bare minipage the tabular goes in alone
    if (!float) return { kind: 'inner', hasCaption: true }
    // The float's own text, without the selection the table replaces
    const around = state.sliceDoc(float.from, anchor.from) + state.sliceDoc(anchor.to, float.to)
    return { kind: 'inner', hasCaption: /\\caption\b/.test(maskComments(around)) }
  }
  return { kind: 'float' }
}

export function selectionKind(text: string): SelectionKind {
  if (/\\begin\s*\{(?:tabular\*?|tabularx|longtable)\}/.test(maskComments(text))) return 'table'
  return isTabularText(text) ? 'data' : 'text'
}

/**
 * The passage for a block at `anchor`. Where text shares the anchor's line,
 * the spaces at the cut join the passage, so no line ends in a space after
 * the block is spliced in.
 */
export function blockRange(doc: string, anchor: { from: number; to: number }): BlockRange {
  const start = doc.lastIndexOf('\n', anchor.from - 1) + 1
  const endAt = doc.indexOf('\n', anchor.to)
  const end = endAt === -1 ? doc.length : endAt
  const lineBefore = doc.slice(start, anchor.from)
  const lineAfter = doc.slice(anchor.to, end)
  const indent = /^[ \t]*/.exec(doc.slice(start, end))![0]
  const from = lineBefore.trim()
    ? anchor.from - (lineBefore.length - lineBefore.trimEnd().length)
    : anchor.from
  const to = lineAfter.trim()
    ? anchor.to + (lineAfter.length - lineAfter.trimStart().length)
    : anchor.to
  return { from, to, lineBefore, lineAfter, indent }
}
