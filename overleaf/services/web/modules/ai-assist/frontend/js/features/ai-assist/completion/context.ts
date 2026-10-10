import type { DocumentFacts } from '../inline-context/document-tag'
import { cursorContext } from '../inline-context/cursor-context'
import { documentClassOf, maskComments, matchingBrace, stripComments } from '../texgpt/latex-text'
import { documentHints } from '../writing-tools/prompt'

/** Up to this much text before the cursor, from a paragraph or line start… */
export const PREFIX_CHARS = 3000
/** …and after it, to a line end: what comes next is what the completion leads into. */
export const SUFFIX_CHARS = 800
/** A paragraph start this close to the window's edge is taken instead of a line start. */
const PARAGRAPH_SLACK = 0.3
const MAX_OUTLINE = 40
const MAX_KEYS = 40
const MAX_HEADING = 60
const MAX_TITLE = 120
const MAX_ABSTRACT = 600

export type CompletionWindow = {
  prefix: string
  suffix: string
  /** The prefix starts at the start of the document. */
  atStart: boolean
}

/**
 * The text the model sees around the cursor. The prefix starts a paragraph
 * when one starts near its edge, so the model reads whole paragraphs, not a
 * sentence cut in half; otherwise it starts a line.
 */
export function completionWindow(doc: string, pos: number): CompletionWindow {
  let start = Math.max(0, pos - PREFIX_CHARS)
  if (start > 0) {
    const limit = start + Math.floor(PREFIX_CHARS * PARAGRAPH_SLACK)
    const paragraph = /\n[ \t]*\n/g
    paragraph.lastIndex = Math.max(0, start - 1)
    const blank = paragraph.exec(doc)
    if (blank && blank.index + blank[0].length <= Math.min(limit, pos)) {
      start = blank.index + blank[0].length
    } else {
      const newline = doc.indexOf('\n', start - 1)
      if (newline !== -1 && newline < pos) start = newline + 1
    }
  }
  let end = Math.min(doc.length, pos + SUFFIX_CHARS)
  if (end < doc.length) {
    const newline = doc.lastIndexOf('\n', end)
    if (newline > pos) end = newline
  }
  return {
    prefix: doc.slice(start, pos),
    suffix: doc.slice(pos, end),
    atStart: start === 0,
  }
}

/** What the model is told about the whole document, besides the window. */
export type CompletionFacts = DocumentFacts & {
  title?: string
  /** The abstract, shortened: what the whole document is about. */
  abstract?: string
  /** Heading titles in document order. */
  outline: string[]
  /** The headings above the cursor: "Method / Training". */
  section: string
  /** The open environments around the cursor, outermost first. */
  envs: string[]
  /** `\label` keys, for `\ref`. */
  labels: string[]
  /** Keys already cited, for `\cite`. */
  cites: string[]
}

const HEADING =
  /\\(?:part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{/g
const TITLE = /\\title\s*(?:\[[^\]]*\]\s*)?\{/
const ABSTRACT = /\\begin\s*\{abstract\}([\s\S]*?)\\end\s*\{abstract\}/
const ABSTRACT_COMMAND = /\\abstract\s*\{/
const PACKAGE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g
const LABEL = /\\label\s*\{([^}]+)\}/g
const CITE =
  /\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]+)\}/g

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The `{…}` argument opening at `open` (in the masked text), from the real text. */
function argumentAt(masked: string, doc: string, open: number): string | null {
  const close = matchingBrace(masked, open)
  return close === -1 ? null : doc.slice(open + 1, close)
}

/** The keys of `pattern` in the document, those nearest the cursor kept when there are too many. */
function keysNear(masked: string, pattern: RegExp, pos: number, max: number): string[] {
  const found: Array<{ key: string; at: number }> = []
  for (const match of masked.matchAll(pattern)) {
    for (const key of match[1].split(',')) found.push({ key: key.trim(), at: match.index! })
  }
  const keys = distinct(found.map(entry => entry.key), Infinity)
  if (keys.length <= max) return keys
  const distance = new Map<string, number>()
  for (const { key, at } of found) {
    distance.set(key, Math.min(distance.get(key) ?? Infinity, Math.abs(at - pos)))
  }
  const nearest = new Set([...keys].sort((a, b) => distance.get(a)! - distance.get(b)!).slice(0, max))
  return keys.filter(key => nearest.has(key))
}

function distinct(values: Iterable<string>, max: number): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.size >= max) break
    const key = value.trim()
    if (key) seen.add(key)
  }
  return [...seen]
}

export function completionFacts(doc: string, pos: number): CompletionFacts {
  const masked = maskComments(doc)
  const { language, macros } = documentHints(doc)
  const { section, envs } = cursorContext(doc, pos)

  const titleMatch = TITLE.exec(masked)
  const title = titleMatch
    ? argumentAt(masked, doc, titleMatch.index + titleMatch[0].length - 1)
    : null

  const abstractMatch = ABSTRACT.exec(masked)
  const commandMatch = abstractMatch ? null : ABSTRACT_COMMAND.exec(masked)
  const abstract = abstractMatch
    ? doc.slice(abstractMatch.index + abstractMatch[0].indexOf('}') + 1, abstractMatch.index + abstractMatch[0].lastIndexOf('\\end'))
    : commandMatch
      ? argumentAt(masked, doc, commandMatch.index + commandMatch[0].length - 1)
      : null

  const outline: string[] = []
  for (const match of masked.matchAll(HEADING)) {
    if (outline.length >= MAX_OUTLINE) break
    const heading = argumentAt(masked, doc, match.index! + match[0].length - 1)
    if (heading) outline.push(oneLine(heading, MAX_HEADING))
  }

  return {
    docClass: documentClassOf(doc),
    language,
    packages: distinct(
      [...masked.matchAll(PACKAGE)].flatMap(match => match[1].split(',')),
      Infinity
    ),
    macros,
    ...(title ? { title: oneLine(title, MAX_TITLE) } : {}),
    ...(abstract && abstract.trim() ? { abstract: oneLine(stripComments(abstract), MAX_ABSTRACT) } : {}),
    outline,
    section,
    envs,
    labels: keysNear(masked, LABEL, pos, MAX_KEYS),
    cites: keysNear(masked, CITE, pos, MAX_KEYS),
  }
}
