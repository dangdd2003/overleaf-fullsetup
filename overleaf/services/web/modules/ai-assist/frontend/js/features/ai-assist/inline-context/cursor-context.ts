import { maskComments, matchingBrace } from '../texgpt/latex-text'

export type TextContainer = 'text' | 'caption' | 'heading' | 'footnote' | 'item' | 'abstract'

export type LineState = 'empty' | 'start' | 'middle' | 'end'

/** Where a position sits in the document, as the model is told. */
export type CursorContext = {
  /** Before `\begin{document}`, or in a file that only loads packages. */
  region: 'preamble' | 'body'
  /** The headings above the position, outermost first: "Method / Training". */
  section: string
  /** The open environments around the position, outermost first, at most three. */
  envs: string[]
  container: TextContainer
}

const HEADING_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
}
const HEADING =
  /\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{/g
const ENVIRONMENT = /\\(begin|end)\s*\{([^}]+)\}/g
const COMMAND_BEFORE = /\\([A-Za-z@]+)\*?\s*(?:\[[^\]]*\]\s*)*$/
const MAX_TITLE = 60
const MAX_ENVS = 3
/** How far back an open `{` is looked for. */
const GROUP_LOOKBACK = 3000

/** Commands whose argument is a container of its own. */
const COMMAND_CONTAINERS: Record<string, TextContainer> = {
  caption: 'caption',
  footnote: 'footnote',
  title: 'heading',
  part: 'heading',
  chapter: 'heading',
  section: 'heading',
  subsection: 'heading',
  subsubsection: 'heading',
  paragraph: 'heading',
}
const LIST_ENVIRONMENTS = new Set(['itemize', 'enumerate', 'description'])

function regionAt(masked: string, pos: number): CursorContext['region'] {
  const begin = masked.search(/\\begin\s*\{document\}/)
  if (begin !== -1) return pos <= begin ? 'preamble' : 'body'
  // An \input file: one that loads packages is part of the preamble
  return /\\(?:documentclass|usepackage)\b/.test(masked) ? 'preamble' : 'body'
}

function shortTitle(title: string): string {
  const text = title.replace(/\s+/g, ' ').trim()
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text
}

function sectionAt(masked: string, doc: string, pos: number): string {
  const path: Array<{ level: number; title: string }> = []
  for (const match of masked.slice(0, pos).matchAll(HEADING)) {
    const open = match.index! + match[0].length - 1
    const close = matchingBrace(masked, open)
    // A heading still open at the position is the container, not the path
    if (close === -1 || close >= pos) continue
    const level = HEADING_LEVELS[match[1]]
    while (path.length > 0 && path[path.length - 1].level >= level) path.pop()
    path.push({ level, title: shortTitle(doc.slice(open + 1, close)) })
  }
  return path.map(entry => entry.title).join(' / ')
}

function environmentsAt(masked: string, pos: number): string[] {
  const open: string[] = []
  for (const match of masked.slice(0, pos).matchAll(ENVIRONMENT)) {
    const name = match[2].trim()
    if (name === 'document') continue
    if (match[1] === 'begin') {
      open.push(name)
    } else {
      const at = open.lastIndexOf(name)
      if (at !== -1) open.splice(at)
    }
  }
  return open.slice(-MAX_ENVS)
}

/** The innermost `{…}` around the position whose command is a container. */
function commandContainerAt(masked: string, pos: number): TextContainer | null {
  const stack: number[] = []
  for (let i = Math.max(0, pos - GROUP_LOOKBACK); i < pos; i++) {
    const char = masked[i]
    if (char === '\\') {
      i++
    } else if (char === '{') {
      stack.push(i)
    } else if (char === '}') {
      stack.pop()
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const head = masked.slice(Math.max(0, stack[k] - 100), stack[k])
    const name = COMMAND_BEFORE.exec(head)?.[1]
    if (name && COMMAND_CONTAINERS[name]) return COMMAND_CONTAINERS[name]
  }
  return null
}

/** Where `pos` is: preamble or body, under which headings, in what. */
export function cursorContext(doc: string, pos: number): CursorContext {
  const masked = maskComments(doc)
  const envs = environmentsAt(masked, pos)
  const innermost = envs[envs.length - 1]
  const container =
    commandContainerAt(masked, pos) ??
    (innermost === 'abstract'
      ? 'abstract'
      : innermost && LIST_ENVIRONMENTS.has(innermost)
        ? 'item'
        : 'text')
  return {
    region: regionAt(masked, pos),
    section: sectionAt(masked, doc, pos),
    envs,
    container,
  }
}

/** What is around `pos` on its line: nothing, text after, text on both sides, or text before. */
export function lineState(doc: string, pos: number): LineState {
  const start = doc.lastIndexOf('\n', pos - 1) + 1
  const newline = doc.indexOf('\n', pos)
  const end = newline === -1 ? doc.length : newline
  const before = doc.slice(start, pos).trim() !== ''
  const after = doc.slice(pos, end).trim() !== ''
  if (before && after) return 'middle'
  if (before) return 'end'
  if (after) return 'start'
  return 'empty'
}
