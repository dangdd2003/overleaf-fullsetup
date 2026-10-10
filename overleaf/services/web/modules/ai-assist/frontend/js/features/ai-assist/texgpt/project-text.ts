import { scanPackages } from '../agent/context/project-index'
import { extractReferences } from '../agent/context/references'
import {
  documentClassOf,
  findCommandArgument,
  maskComments,
  matchingBrace,
  stripComments,
} from './latex-text'

/** What TeXGPT knows about the project for one request. */
export type ProjectSource = {
  /** Editable docs by path, without a leading slash; the open file holds its live editor text. */
  docs: Record<string, string>
  rootPath: string | null
  openPath: string
  /** False when the project files could not be read: only the open file is in `docs`. */
  complete: boolean
}

/** The most of the paper a generator sends, in characters. */
export const PAPER_BUDGET = 40000
/** Over budget: this much from the start… */
export const PAPER_HEAD = 28000
/** …and this much from the end, with the headings in between. */
export const PAPER_TAIL = 8000

const MAX_DEPTH = 5
const INPUT = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g
const HEADING =
  /^\s*\\(?:part|chapter|section|subsection|subsubsection)\*?\s*[[{]/

/** Like TeX: relative to the project root first, then to the including file. */
function resolveInput(
  docs: Record<string, string>,
  name: string,
  fromPath: string
): string | null {
  const clean = name.trim().replace(/^\.\//, '')
  const dir = fromPath.includes('/')
    ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1)
    : ''
  const candidates = [clean, `${clean}.tex`, `${dir}${clean}`, `${dir}${clean}.tex`]
  return candidates.find(path => typeof docs[path] === 'string') ?? null
}

/**
 * The document in reading order: the root file (or the open one when the
 * root is unknown) with its \input, \include and \subfile files inlined,
 * comments stripped. A file is inlined once; deeper nesting is left as is.
 */
export function flattenDocument(source: ProjectSource): string {
  const start =
    source.rootPath && typeof source.docs[source.rootPath] === 'string'
      ? source.rootPath
      : source.openPath
  const seen = new Set<string>()
  const expand = (path: string, depth: number): string => {
    seen.add(path)
    return stripComments(source.docs[path] ?? '').replace(
      new RegExp(INPUT.source, 'g'),
      (whole: string, name: string) => {
        const target =
          depth < MAX_DEPTH ? resolveInput(source.docs, name, path) : null
        if (!target || seen.has(target)) return whole
        return expand(target, depth + 1)
      }
    )
  }
  return expand(start, 0)
}

/** The first closing section after the start: its text is kept whole. */
const CLOSING_HEADING =
  /^[ \t]*\\(?:section|chapter)\*?\s*(?:\[[^\]]*\]\s*)?\{[^}]*(?:conclu|discussion|summary|outlook|future work)/im
const CAPTION = /\\caption\s*(?:\[[^\]]*\])?\s*\{/g
const MAX_CAPTION = 300

/** The headings and captions of a left-out stretch, in order, within `budget` characters. */
function skeleton(text: string, budget: number): string[] {
  const items: Array<{ at: number; line: string }> = []
  let offset = 0
  for (const line of text.split('\n')) {
    if (HEADING.test(line)) items.push({ at: offset, line: line.trim() })
    offset += line.length + 1
  }
  for (const match of text.matchAll(CAPTION)) {
    const open = match.index! + match[0].length - 1
    const close = matchingBrace(text, open)
    if (close === -1) continue
    const caption = text
      .slice(open + 1, close)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CAPTION)
    items.push({ at: match.index!, line: `\\caption{${caption}}` })
  }
  items.sort((a, b) => a.at - b.at)
  const lines: string[] = []
  let used = 0
  for (const item of items) {
    used += item.line.length + 1
    if (used > budget) break
    lines.push(item.line)
  }
  return lines
}

/**
 * A long paper cut to fit one request: its start, the headings and captions
 * of what is left out, and its conclusion (or, without one, its end).
 */
export function fitPaper(text: string): { text: string; cut: boolean } {
  if (text.length <= PAPER_BUDGET) return { text, cut: false }
  const rest = text.slice(PAPER_HEAD)
  const closing = CLOSING_HEADING.exec(rest)
  const tailFrom = closing ? closing.index : rest.length - PAPER_TAIL
  return {
    text: [
      text.slice(0, PAPER_HEAD),
      '[…]',
      ...skeleton(rest.slice(0, tailFrom), PAPER_BUDGET - PAPER_HEAD - PAPER_TAIL - 20),
      '[…]',
      rest.slice(tailFrom, tailFrom + PAPER_TAIL),
    ].join('\n'),
    cut: true,
  }
}

const APPENDIX = /\\appendix\b|\\begin\s*\{appendices\}/
const BIBLIOGRAPHY = /\\begin\s*\{thebibliography\}[\s\S]*?\\end\s*\{thebibliography\}/g

/**
 * What a generator needs of the flattened paper: the title and the body,
 * without the rest of the preamble, the bibliography or the appendices.
 */
export function paperDigest(text: string): string {
  let body = text
  let title = ''
  const begin = /\\begin\s*\{document\}/.exec(text)
  if (begin) {
    const preamble = text.slice(0, begin.index)
    const range = findCommandArgument(preamble, 'title')
    if (range) title = `\\title{${preamble.slice(range.from, range.to).trim()}}`
    body = text.slice(begin.index + begin[0].length)
  }
  const end = /\\end\s*\{document\}/.exec(body)
  if (end) body = body.slice(0, end.index)
  const appendix = APPENDIX.exec(body)
  if (appendix) body = body.slice(0, appendix.index)
  body = body.replace(BIBLIOGRAPHY, '')
  return [title, body.trim()]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** Every package the project's .tex files load. */
export function projectPackages(source: ProjectSource): Set<string> {
  const names = new Set<string>()
  for (const [path, content] of Object.entries(source.docs)) {
    if (!path.endsWith('.tex')) continue
    for (const use of scanPackages(content)) names.add(use.name)
  }
  return names
}

/** The class of the root document, else of the open file. */
export function projectClass(source: ProjectSource): string | null {
  const root = source.rootPath ? source.docs[source.rootPath] : undefined
  return (
    (root ? documentClassOf(root) : null) ??
    documentClassOf(source.docs[source.openPath] ?? '')
  )
}

/** The most bibliography keys, and the most labels, one request lists. */
export const MAX_KEYS_LISTED = 80

const BIBITEM = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g

/**
 * The project's bibliography keys and labels, so TeXGPT cites and refers
 * without inventing keys. Keys the project already cites come first;
 * labels of the open file come first.
 */
export function projectKeys(source: ProjectSource): {
  citeKeys: string[]
  labels: string[]
} {
  const references = extractReferences({ docs: source.docs })
  const defined = references.bibKeys.map(entry => entry.key)
  for (const [path, content] of Object.entries(source.docs)) {
    if (!path.endsWith('.tex')) continue
    for (const match of maskComments(content).matchAll(BIBITEM)) {
      defined.push(match[1].trim())
    }
  }
  const unique = [...new Set(defined)]
  const cited = new Set(references.citations.map(use => use.key))
  const citeKeys = [
    ...unique.filter(key => cited.has(key)),
    ...unique.filter(key => !cited.has(key)),
  ].slice(0, MAX_KEYS_LISTED)
  const labels = [
    ...new Set([
      ...references.labels
        .filter(label => label.path === source.openPath)
        .map(label => label.key),
      ...references.labels.map(label => label.key),
    ]),
  ].slice(0, MAX_KEYS_LISTED)
  return { citeKeys, labels }
}
