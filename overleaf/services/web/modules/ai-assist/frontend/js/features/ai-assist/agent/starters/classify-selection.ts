import { cursorContext } from '../../inline-context/cursor-context'
import { ALL_MATH_ENVS, ALL_TABLE_ENVS, envRole } from '../../completion/structure'
import { maskComments } from '../../texgpt/latex-text'
import { SelectionCue, SelectionKind, SelectionScope } from './selection-types'

/**
 * Classifies a highlighted LaTeX selection by the structure it is, so the
 * quick actions offered for it fit what it is. Pure string work: the editor
 * hands over the text and offsets it already has.
 */

const BEGIN = /\\begin\s*\{([^}]*)\}/g
const TIKZ_ENV = /\\begin\s*\{(tikzpicture|tikzcd|axis|circuitikz|forest)\}/
const TIKZ_STATEMENT = /\\(?:draw|node|path|fill|filldraw|coordinate)(?![a-zA-Z@])[^;]*;/
const FIGURE_ENV = /\\begin\s*\{(figure|figure\*|subfigure|wrapfigure)\}/
const INCLUDE_GRAPHICS = /\\includegraphics(?![a-zA-Z@])/
const CODE_ENV = /\\begin\s*\{(lstlisting|verbatim|Verbatim|minted|algorithmic|algorithm)\}/
const LIST_ENV = /\\begin\s*\{(itemize|enumerate|description)\}/
const ITEM_LINE = /^\s*\\item(?![a-zA-Z@])/
const PREAMBLE_LINE =
  /^\s*\\(?:documentclass|usepackage|RequirePackage|newcommand|renewcommand|DeclareMathOperator|def|usetikzlibrary|geometry|hypersetup|setlength)(?![a-zA-Z@])/
const HEADING = /^\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\]\s*)?\{/
const CITATION =
  /^~?\\(?:cite|citep|citet|parencite|textcite|autocite|footcite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{[^{}]*\}$/
const ROW_END = /\\\\\s*$/
const NUMBER = /(?<![\\\w])\d+(?:[.,]\d+)?%?/g
const BARE_DOLLAR = /(?<!\\)\$/
/** Math written inline or as a display, removed before counting words. */
const MATH_SPAN =
  /(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$[^$]*?(?<!\\)\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g
const COMMAND = /\\[A-Za-z@]+\*?/g
const WORD = /\p{L}{2,}/gu

const CITE_COMMAND = /\\[A-Za-z]*cite[A-Za-z]*\*?(?![a-zA-Z@])/
const CLAIM =
  /\b(?:(?:studies|research|work|experiments|evidence|literature)\s+(?:has\s+|have\s+)?(?:shows?|shown|suggests?|suggested|demonstrated?|indicates?|found)|it\s+is\s+(?:well[-\s])?(?:known|established|accepted)|widely\s+(?:used|adopted|accepted|studied)|state[-\s]of[-\s]the[-\s]art|has\s+been\s+(?:shown|demonstrated|reported)|(?:previous|prior|recent|existing)\s+(?:work|works|studies|research|approaches|methods))\b/i
const CONTRACTION = /\b(?:\p{L}+n['’]t|\p{L}+['’](?:re|ve|ll|d|m)|it['’]s|that['’]s|there['’]s|let['’]s|here['’]s|what['’]s)\b/iu
const INFORMAL_WORD =
  /\b(?:a\s+lot|lots\s+of|really|pretty\s+much|kind\s+of|sort\s+of|stuff|basically|huge|awesome|totally|gonna|wanna|okay|nowadays|super|tons\s+of|a\s+bit)\b/gi
const FILLER =
  /\b(?:in\s+order\s+to|due\s+to\s+the\s+fact\s+that|it\s+is\s+(?:important|worth)\s+(?:to\s+note|noting)\s+that|it\s+should\s+be\s+noted\s+that|in\s+terms\s+of|a\s+(?:large\s+)?number\s+of|the\s+fact\s+that|at\s+this\s+point\s+in\s+time|for\s+the\s+purpose\s+of|with\s+respect\s+to|in\s+the\s+case\s+of|it\s+can\s+be\s+seen\s+that)\b/gi
const ORDINAL = /\b(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|finally|lastly)\b/gi
const ENUM_MARKER = /\((?:i{1,3}|iv|vi?)\)/g
const PROCESS_WORD =
  /\b(?:then|next|afterwards|subsequently|consists?\s+of|composed\s+of|comprises?|(?:is|are)\s+fed\s+(?:in)?to|feeds?\s+into|flows?\s+(?:in)?to|pass(?:es|ed)?\s+(?:through|to)|pipeline|workflow|stages?|steps?|phases?|modules?|components?|encoder|decoder)\b/gi
const ARROW = /\\(?:to|rightarrow|Rightarrow|longrightarrow)(?![a-zA-Z@])|->|→/g
const SENTENCE_END = /[.!?]+(?=\s|$)/
const LETTERS = /\p{L}+/gu
const TERM = /^\p{L}[\p{L}\p{N}\s'’-]*$/u

/** A sentence this many words long on average reads as wordy. */
const WORDY_SENTENCE = 30
/** Filler phrases that alone make a selection wordy. */
const MIN_FILLERS = 2
/** Conversational words that alone make a selection informal. */
const MIN_INFORMAL = 2
/** Process words and arrows that together suggest a diagram. */
const MIN_PROCESS = 3
/** A term is at most this many words. */
const MAX_TERM_WORDS = 4

/** Prose needs this many words of two or more letters. */
const MIN_WORDS = 3
/** Prose or a list needs this many numbers to be a table candidate. */
const MIN_NUMBERS = 3
/** Headings longer than this many lines are not headings. */
const MAX_HEADING_LINES = 2

/** Matrix and array families are math, never a table. */
function isMatrixLike(name: string): boolean {
  return /matrix/i.test(name) || name === 'array' || name === 'NiceArray' || name === 'darray'
}

function isMathEnv(name: string): boolean {
  return ALL_MATH_ENVS.has(name) || isMatrixLike(name)
}

function isTableEnv(name: string): boolean {
  return ALL_TABLE_ENVS.has(name) && !isMatrixLike(name)
}

type MathWrap = 'display' | 'inline'

function wraps(text: string, open: string, close: string): boolean {
  if (!text.startsWith(open) || !text.endsWith(close)) return false
  const inner = text.slice(open.length, text.length - close.length)
  if (inner.trim() === '') return false
  return open.startsWith('$') ? !BARE_DOLLAR.test(inner) : !inner.includes(close)
}

/** Whether the whole text is one math span, and which kind. */
function mathWrap(text: string): MathWrap | null {
  if (wraps(text, '$$', '$$') || wraps(text, '\\[', '\\]')) return 'display'
  if (wraps(text, '$', '$') || wraps(text, '\\(', '\\)')) return 'inline'
  return null
}

function rowCount(masked: string): number {
  return masked.split('\n').filter(line => line.includes('&') && ROW_END.test(line)).length
}

function numericFor(kind: SelectionKind, masked: string): boolean {
  return (kind === 'prose' || kind === 'list') && (masked.match(NUMBER)?.length ?? 0) >= MIN_NUMBERS
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

/** The text with its math, commands and braces removed. */
function plainProse(masked: string): string {
  return masked.replace(MATH_SPAN, ' ').replace(COMMAND, ' ').replace(/[{}]/g, ' ')
}

function averageSentenceWords(prose: string): number {
  const sentences = prose
    .split(SENTENCE_END)
    .map(sentence => count(sentence, LETTERS))
    .filter(words => words > 0)
  if (sentences.length === 0) return 0
  return sentences.reduce((sum, words) => sum + words, 0) / sentences.length
}

/**
 * What the words of a prose or short LaTeX selection suggest. Cheap regex
 * work on the selection only, run once per settled selection.
 */
function textCues(kind: SelectionKind, masked: string): SelectionCue[] {
  if (kind !== 'prose' && kind !== 'latex') return []
  const trimmed = masked.trim()
  const prose = plainProse(masked)
  const words = count(prose, LETTERS)

  if (
    words > 0 &&
    words <= MAX_TERM_WORDS &&
    !trimmed.includes('\n') &&
    TERM.test(trimmed)
  ) {
    return ['term']
  }
  if (kind !== 'prose') return []

  const cues: SelectionCue[] = []
  if (CLAIM.test(prose) && !CITE_COMMAND.test(masked)) {
    cues.push('uncited_claim')
  }
  if (CONTRACTION.test(prose) || count(prose, INFORMAL_WORD) >= MIN_INFORMAL) {
    cues.push('informal')
  }
  if (averageSentenceWords(prose) >= WORDY_SENTENCE || count(prose, FILLER) >= MIN_FILLERS) {
    cues.push('wordy')
  }
  const ordinals = new Set((prose.match(ORDINAL) ?? []).map(word => word.toLowerCase()))
  if (ordinals.size >= 2 || count(prose, /;/g) >= 2 || count(masked, ENUM_MARKER) >= 2) {
    cues.push('enumeration')
  }
  // One arrow may be notation (`f \colon X \to Y`); two, or one among steps, is a flow.
  const arrows = count(masked, ARROW)
  if (arrows >= 2 || arrows + count(prose, PROCESS_WORD) >= MIN_PROCESS) {
    cues.push('process')
  }
  return cues
}

/** The kind a text gets from its own structure, before any context is known. */
export function classifySelectionText(text: string, path: string): SelectionScope {
  const masked = maskComments(text)
  const trimmed = masked.trim()
  const lines = text.split('\n').length
  const scope = (kind: SelectionKind, env: string | null = null, inline = false): SelectionScope => ({
    kind,
    env,
    lines,
    numeric: numericFor(kind, masked),
    inline,
    cues: textCues(kind, masked),
  })
  const names = [...masked.matchAll(BEGIN)].map(match => match[1].trim())

  if (/\.bib$/i.test(path)) return scope('bibtex')

  const tikz = TIKZ_ENV.exec(masked)
  if (tikz) return scope('tikz', tikz[1])
  if (TIKZ_STATEMENT.test(masked)) return scope('tikz')

  // A table env wins; rows of `&` only count when the text is not math.
  const table = names.find(isTableEnv)
  if (table) return scope('table', table)
  const mathy = names.some(isMathEnv) || mathWrap(trimmed) !== null
  if (!mathy && rowCount(masked) >= 2) return scope('table')

  const figure = FIGURE_ENV.exec(masked)
  if (figure) return scope('figure', figure[1])
  if (INCLUDE_GRAPHICS.test(masked)) return scope('figure')

  const math = names.find(isMathEnv)
  if (math) return scope('math', math)
  const wrap = mathWrap(trimmed)
  if (wrap) return scope('math', null, wrap === 'inline')

  const code = CODE_ENV.exec(masked)
  if (code) return scope('code', code[1])

  const list = LIST_ENV.exec(masked)
  if (list) return scope('list', list[1])
  if (masked.split('\n').filter(line => ITEM_LINE.test(line)).length >= 2) return scope('list')

  // Blank lines do not count, and neither do comments (masked above).
  const content = masked.split('\n').filter(line => line.trim() !== '')
  const preamble = content.filter(line => PREAMBLE_LINE.test(line)).length
  if (content.length > 0 && preamble * 5 >= content.length * 3) return scope('preamble')

  if (lines <= MAX_HEADING_LINES && HEADING.test(trimmed)) return scope('heading')

  if (CITATION.test(trimmed)) return scope('citation')

  if (trimmed === '') return scope('latex')
  const words = plainProse(masked).match(WORD)?.length ?? 0
  return scope(words >= MIN_WORDS ? 'prose' : 'latex')
}

/** Start of the paragraph that holds the end of `text`: after its last blank line. */
function paragraphStart(text: string): number {
  let start = 0
  for (const blank of text.matchAll(/\n[ \t]*\n/g)) {
    start = (blank.index ?? 0) + blank[0].length
  }
  return start
}

/** Whether an odd number of unescaped single `$` opens inline math. `$$` pairs and `\$` are skipped. */
function oddSingleDollar(text: string): boolean {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
    } else if (text[i] === '$') {
      if (text[i + 1] === '$') {
        i++
      } else {
        count++
      }
    }
  }
  return count % 2 === 1
}

/** Whether the position `from` sits inside inline math of its paragraph. */
function inlineMathBefore(doc: string, from: number): boolean {
  const before = maskComments(doc.slice(0, from))
  const paragraph = before.slice(paragraphStart(before))
  return (
    oddSingleDollar(paragraph) ||
    paragraph.lastIndexOf('\\(') > paragraph.lastIndexOf('\\)')
  )
}

/**
 * The kind a text gets in its document: its own structure first, and for
 * prose or plain LaTeX, the heading, preamble, math or environment around it.
 */
export function classifySelectionInDoc(
  doc: string,
  from: number,
  to: number,
  path: string
): SelectionScope {
  const text = doc.slice(from, to)
  const scope = classifySelectionText(text, path)
  const bareRows = scope.kind === 'table' && scope.env === null
  if (scope.kind !== 'prose' && scope.kind !== 'latex' && !bareRows) {
    return scope
  }

  const prefix = doc.slice(0, to)
  const context = cursorContext(prefix, from)

  // `a &= b \\` rows read as a table's on their own; inside align they are math.
  if (bareRows) {
    for (let i = context.envs.length - 1; i >= 0; i--) {
      const env = context.envs[i]
      if (isMathEnv(env) || envRole(env, prefix) === 'math') {
        return { ...scope, kind: 'math', env }
      }
      if (isTableEnv(env)) return { ...scope, env }
    }
    return scope
  }

  const refine = (kind: SelectionKind, env: string | null = null, inline = false): SelectionScope => {
    const masked = maskComments(text)
    return {
      kind,
      env,
      lines: scope.lines,
      numeric: numericFor(kind, masked),
      inline,
      cues: textCues(kind, masked),
    }
  }
  // Prose keeps its text cues and gains the part of the paper it sits in.
  const inSection = (prose: SelectionScope): SelectionScope => {
    const cues = sectionCues(context)
    return cues.length === 0 ? prose : { ...prose, cues: [...(prose.cues ?? []), ...cues] }
  }

  if (context.container === 'heading') return refine('heading')
  if (context.region === 'preamble') return refine('preamble')
  if (inlineMathBefore(prefix, from)) return refine('math', null, true)

  // Innermost first: the first environment that decides the kind wins.
  for (let i = context.envs.length - 1; i >= 0; i--) {
    const env = context.envs[i]
    const role = envRole(env, prefix)
    if (isMathEnv(env) || role === 'math') return refine('math', env)
    if (role === 'drawing') return refine('tikz', env)
    if (isTableEnv(env)) return refine('table', env)
    if (role === 'float') return refine('figure', env)
    if (role === 'code') return refine('code', env)
    // A selected item stays prose; only bare LaTeX in a list becomes a list.
    if (role === 'list') return scope.kind === 'latex' ? refine('list', env) : inSection(scope)
  }
  return scope.kind === 'prose' ? inSection(scope) : scope
}

const INTRODUCTION_HEADING = /^(?:\d+(?:\.\d+)*\.?\s*)?introduction\b/i
const ABSTRACT_HEADING = /^abstract\b/i

/** The section cues for prose at `context`: abstract first, then the top heading. */
function sectionCues(context: ReturnType<typeof cursorContext>): SelectionCue[] {
  const headings = context.section.split(' / ').filter(Boolean)
  if (
    context.container === 'abstract' ||
    context.envs.includes('abstract') ||
    headings.some(heading => ABSTRACT_HEADING.test(heading))
  ) {
    return ['abstract']
  }
  if (headings.length > 0 && INTRODUCTION_HEADING.test(headings[0])) {
    return ['introduction']
  }
  return []
}
