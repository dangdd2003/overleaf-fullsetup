import type { TextContainer } from '../inline-context/cursor-context'
import { maskComments, matchingBrace } from '../texgpt/latex-text'
import { MaskedBuilder, MaskedText, PlaceholderKind } from './masked-text'

/** A paragraph of prose and what kind of text it is. */
export type Paragraph = { container: TextContainer; masked: MaskedText }

/** Commands that only format the words in their argument: hidden, words kept. */
const WRAPPERS = new Set([
  'emph',
  'textbf',
  'textit',
  'textsl',
  'textsc',
  'textup',
  'textmd',
  'textrm',
  'textsf',
  'textnormal',
  'underline',
  'uline',
  'mbox',
  'text',
])

/** Commands that print nothing worth checking: hidden with their arguments. */
const HIDDEN = new Set([
  'label',
  'index',
  'glossary',
  'nocite',
  'noindent',
  'indent',
  'centering',
  'raggedright',
  'raggedleft',
  'hspace',
  'vspace',
  'smallskip',
  'medskip',
  'bigskip',
  'quad',
  'qquad',
  'newpage',
  'clearpage',
  'cleardoublepage',
  'pagebreak',
  'nopagebreak',
  'linebreak',
  'nolinebreak',
  'protect',
  'phantomsection',
  'maketitle',
  'tableofcontents',
  'listoffigures',
  'listoftables',
  'footnotemark',
  'addcontentsline',
  'bibliographystyle',
  'bibliography',
  'printbibliography',
  'appendix',
  'frontmatter',
  'mainmatter',
  'backmatter',
  'selectlanguage',
  'vfill',
  'hfill',
  'relax',
  'normalsize',
  'small',
  'footnotesize',
  'scriptsize',
  'tiny',
  'large',
  'Large',
  'LARGE',
  'huge',
  'Huge',
  'bfseries',
  'itshape',
  'mdseries',
  'rmfamily',
  'sffamily',
  'ttfamily',
  'upshape',
  'slshape',
  'scshape',
  'normalfont',
  'em',
  'sloppy',
  'fussy',
  'enlargethispage',
  'thispagestyle',
  'pagestyle',
  'setlength',
  'addtolength',
  'setcounter',
  'addtocounter',
  'input',
  'include',
  'includeonly',
  'includegraphics',
])

const SECTIONS = new Set([
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
])
const CAPTIONS = new Set(['caption', 'subcaption'])
const FOOTNOTES = new Set(['footnote', 'footnotetext'])
const REFS = new Set([
  'ref',
  'eqref',
  'cref',
  'Cref',
  'autoref',
  'pageref',
  'nameref',
  'vref',
  'Vref',
  'labelcref',
  'cpageref',
])
const CITE = /^[A-Za-z]*cite[A-Za-z]*$/
const DOTS = new Set(['ldots', 'dots', 'textellipsis'])

/** Environments whose content is never prose. */
const SKIPPED_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'eqnarray',
  'eqnarray*',
  'displaymath',
  'math',
  'tabular',
  'tabular*',
  'tabularx',
  'tabulary',
  'longtable',
  'array',
  'verbatim',
  'verbatim*',
  'Verbatim',
  'lstlisting',
  'minted',
  'comment',
  'thebibliography',
  'tikzpicture',
  'pgfpicture',
  'filecontents',
  'filecontents*',
  'algorithmic',
])

/** Mandatory arguments after `\begin{name}`, besides the name. */
const ENVIRONMENT_ARGUMENTS: Record<string, number> = {
  minipage: 1,
  multicols: 1,
  subfigure: 1,
  wrapfigure: 2,
  wraptable: 2,
  otherlanguage: 1,
}

/** `\'e` and friends: the combining mark each accent command adds. */
const ACCENTS: Record<string, string> = {
  "'": '́',
  '`': '̀',
  '^': '̂',
  '"': '̈',
  '~': '̃',
  '=': '̄',
  '.': '̇',
}

const WHITESPACE = /[ \t\r\n]/
const LETTER = /[A-Za-z@]/

type State = {
  builder: MaskedBuilder
  /** The container of the paragraph being built. */
  container: TextContainer
  /** Containers opened by environments; the last one applies to new paragraphs. */
  stack: TextContainer[]
}

/**
 * The prose of a LaTeX file, paragraph by paragraph, in document order:
 * the body only when the file has `\begin{document}`, all of it otherwise.
 */
export function scanProse(doc: string): Paragraph[] {
  const masked = maskComments(doc)
  const begin = /\\begin\s*\{document\}/.exec(masked)
  const from = begin ? begin.index + begin[0].length : 0
  let to = doc.length
  if (begin) {
    const endPattern = /\\end\s*\{document\}/g
    endPattern.lastIndex = from
    const end = endPattern.exec(masked)
    if (end) to = end.index
  }
  const paragraphs: Paragraph[] = []
  new ProseScanner(doc, masked, paragraphs).scan(from, to, 'text')
  return paragraphs.sort((a, b) => a.masked.starts[0] - b.masked.starts[0])
}

class ProseScanner {
  constructor(
    private readonly doc: string,
    /** The source with comments blanked: same length, for structure searches. */
    private readonly masked: string,
    private readonly out: Paragraph[]
  ) {}

  scan(from: number, to: number, container: TextContainer) {
    const st: State = { builder: new MaskedBuilder(), container, stack: [container] }
    let afterComment = false
    let i = from
    while (i < to) {
      const ch = this.doc[i]
      if (ch === '%') {
        i = this.lineEnd(i, to)
        afterComment = true
        continue
      }
      if (WHITESPACE.test(ch)) {
        let j = i
        let newlines = 0
        while (j < to && WHITESPACE.test(this.doc[j])) {
          if (this.doc[j] === '\n') newlines++
          j++
        }
        if (newlines >= 2) {
          this.flush(st)
        } else if (!afterComment) {
          // A comment eats its line end and the next line's indentation
          st.builder.pushSpace(i, j, newlines === 1 ? 'break' : 'space')
        }
        afterComment = false
        i = j
        continue
      }
      afterComment = false
      if (ch === '\\') {
        i = this.command(st, i, to)
      } else if (ch === '$') {
        i = this.math(st, i, to)
      } else if (ch === '~') {
        st.builder.pushSpace(i, i + 1, 'hard')
        i++
      } else if (ch === '{' || ch === '}' || ch === '&') {
        i++
      } else {
        st.builder.push(ch, i, i + 1, 'text')
        i++
      }
    }
    this.flush(st)
  }

  private flush(st: State, next?: TextContainer) {
    const masked = st.builder.build()
    if (masked.text.length > 0) this.out.push({ container: st.container, masked })
    st.builder = new MaskedBuilder()
    st.container = next ?? st.stack[st.stack.length - 1]
  }

  private lineEnd(i: number, to: number): number {
    const newline = this.doc.indexOf('\n', i)
    return newline === -1 || newline > to ? to : newline
  }

  private math(st: State, i: number, to: number): number {
    if (this.doc[i + 1] === '$') {
      this.flush(st)
      const close = this.findUnescaped('$$', i + 2, to)
      return close === -1 ? to : close + 2
    }
    const close = this.findUnescaped('$', i + 1, to)
    const stop = close === -1 ? this.lineEnd(i, to) : close + 1
    return this.placeholder(st, 'M', i, stop)
  }

  private findUnescaped(token: string, from: number, to: number): number {
    let at = this.masked.indexOf(token, from)
    while (at !== -1 && at < to) {
      let backslashes = 0
      for (let k = at - 1; k >= 0 && this.doc[k] === '\\'; k--) backslashes++
      if (backslashes % 2 === 0) return at
      at = this.masked.indexOf(token, at + 1)
    }
    return -1
  }

  private placeholder(
    st: State,
    kind: PlaceholderKind,
    from: number,
    to: number
  ): number {
    st.builder.pushPlaceholder(kind, from, to, this.doc.slice(from, to))
    return to
  }

  private command(st: State, i: number, to: number): number {
    const next = this.doc[i + 1]
    if (next === undefined || i + 1 >= to) return i + 1
    if (!LETTER.test(next)) return this.controlSymbol(st, i, to, next)
    let j = i + 1
    while (j < to && LETTER.test(this.doc[j])) j++
    const name = this.doc.slice(i + 1, j)
    if (this.doc[j] === '*') j++
    return this.controlWord(st, i, j, to, name)
  }

  private controlSymbol(st: State, i: number, to: number, symbol: string): number {
    const end = i + 2
    if (symbol === '\\') {
      let j = end
      if (this.doc[j] === '*') j++
      j = this.skipOptional(j, to)
      st.builder.pushSpace(i, j, 'hard')
      return j
    }
    if ('%&#_$'.includes(symbol)) {
      st.builder.push(symbol, i, end, 'escaped')
      return end
    }
    if (',;: \n\t'.includes(symbol)) {
      st.builder.pushSpace(i, end, 'hard')
      return end
    }
    if (symbol === '(') {
      const close = this.masked.indexOf('\\)', end)
      return this.placeholder(st, 'M', i, close === -1 || close >= to ? to : close + 2)
    }
    if (symbol === '[') {
      this.flush(st)
      const close = this.masked.indexOf('\\]', end)
      return close === -1 || close >= to ? to : close + 2
    }
    if (ACCENTS[symbol] !== undefined) return this.accent(st, i, to, symbol)
    if ('@/-!'.includes(symbol)) return end
    return this.placeholder(st, 'X', i, end)
  }

  private accent(st: State, i: number, to: number, symbol: string): number {
    let base = this.doc[i + 2]
    let stop = i + 3
    if (base === '{') {
      const close = this.doc.indexOf('}', i + 3)
      if (close === i + 4 && close < to) {
        base = this.doc[i + 3]
        stop = close + 1
      } else {
        base = ''
      }
    }
    const composed = /^[A-Za-z]$/.test(base ?? '')
      ? (base + ACCENTS[symbol]).normalize('NFC')
      : ''
    if (composed.length !== 1 || stop > to) {
      return this.placeholder(st, 'X', i, i + 2)
    }
    st.builder.push(composed, i, stop, 'hard')
    return stop
  }

  private controlWord(
    st: State,
    i: number,
    j: number,
    to: number,
    name: string
  ): number {
    if (name === 'begin') return this.begin(st, j, to)
    if (name === 'end') return this.end(st, j, to)
    if (name === 'par') {
      this.flush(st)
      return j
    }
    if (name === 'item') {
      this.flush(st, 'item')
      let k = j
      while (this.doc[k] === ' ' || this.doc[k] === '\t') k++
      return this.skipOptional(k, to)
    }
    if (SECTIONS.has(name) || CAPTIONS.has(name)) {
      this.flush(st)
      const arg = this.group(this.skipOptional(j, to), to)
      if (!arg) return j
      this.scan(arg.from, arg.to, CAPTIONS.has(name) ? 'caption' : 'heading')
      return arg.end
    }
    if (FOOTNOTES.has(name)) {
      const arg = this.group(this.skipOptional(j, to), to)
      if (!arg) return j
      this.placeholder(st, 'X', i, arg.end)
      this.scan(arg.from, arg.to, 'footnote')
      return arg.end
    }
    if (HIDDEN.has(name)) return this.skipArguments(j, to)
    if (CITE.test(name)) return this.placeholder(st, 'C', i, this.skipArguments(j, to))
    if (REFS.has(name)) return this.placeholder(st, 'R', i, this.skipArguments(j, to))
    if (name === 'newline') {
      st.builder.pushSpace(i, j, 'hard')
      return j
    }
    if (DOTS.has(name)) {
      const stop = this.doc.startsWith('{}', j) ? j + 2 : j
      st.builder.push('...', i, stop, 'hard')
      return stop
    }
    // The command goes; its braces are hidden by the main loop, its words stay
    if (WRAPPERS.has(name)) return this.skipOptional(j, to)
    if (name === 'href') {
      const url = this.group(j, to)
      return url ? url.end : j
    }
    if (name === 'verb' || name === 'lstinline') {
      const start = name === 'lstinline' ? this.skipOptional(j, to) : j
      const delimiter = this.doc[start] === '{' ? '}' : this.doc[start]
      const close = delimiter ? this.doc.indexOf(delimiter, start + 1) : -1
      const stop = close === -1 || close >= to ? this.lineEnd(i, to) : close + 1
      return this.placeholder(st, 'X', i, stop)
    }
    return this.placeholder(st, 'X', i, this.skipArguments(j, to))
  }

  private begin(st: State, j: number, to: number): number {
    const nameGroup = this.group(j, to)
    if (!nameGroup) return j
    const env = this.doc.slice(nameGroup.from, nameGroup.to).trim()
    this.flush(st)
    if (SKIPPED_ENVIRONMENTS.has(env)) {
      return this.environmentEnd(env, nameGroup.end, to)
    }
    let k = this.skipOptional(nameGroup.end, to)
    for (let n = 0; n < (ENVIRONMENT_ARGUMENTS[env] ?? 0); n++) {
      const arg = this.group(k, to)
      if (!arg) break
      k = this.skipOptional(arg.end, to)
    }
    if (env === 'abstract') {
      st.stack.push('abstract')
      st.container = 'abstract'
    }
    return k
  }

  private end(st: State, j: number, to: number): number {
    const nameGroup = this.group(j, to)
    const env = nameGroup ? this.doc.slice(nameGroup.from, nameGroup.to).trim() : ''
    this.flush(st)
    if (env === 'abstract' && st.stack.length > 1) {
      st.stack.pop()
      st.container = st.stack[st.stack.length - 1]
    }
    return nameGroup ? nameGroup.end : j
  }

  /** Index after the `\end{env}` matching an environment opened before `from`. */
  private environmentEnd(env: string, from: number, to: number): number {
    const name = env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\\\(begin|end)\\s*\\{${name}\\}`, 'g')
    pattern.lastIndex = from
    let depth = 1
    for (
      let match = pattern.exec(this.masked);
      match && match.index < to;
      match = pattern.exec(this.masked)
    ) {
      depth += match[1] === 'begin' ? 1 : -1
      if (depth === 0) return match.index + match[0].length
    }
    return to
  }

  /** The `{…}` group at `k` (after optional whitespace): its content and the index after it. */
  private group(
    k: number,
    to: number
  ): { from: number; to: number; end: number } | null {
    let open = k
    while (open < to && WHITESPACE.test(this.doc[open])) open++
    if (this.doc[open] !== '{') return null
    const close = matchingBrace(this.masked, open)
    if (close === -1 || close >= to) return null
    return { from: open + 1, to: close, end: close + 1 }
  }

  /** Index after an optional argument `[…]` at `k`, or `k` when there is none. */
  private skipOptional(k: number, to: number): number {
    if (this.doc[k] !== '[') return k
    let depth = 0
    for (let i = k + 1; i < to; i++) {
      const ch = this.masked[i]
      if (ch === '\\') i++
      else if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === ']' && depth === 0) return i + 1
    }
    return k
  }

  /** Index after the arguments written straight after a command (no space between). */
  private skipArguments(k: number, to: number): number {
    let i = k
    for (;;) {
      if (this.doc[i] === '[') {
        const next = this.skipOptional(i, to)
        if (next === i) return i
        i = next
      } else if (this.doc[i] === '{') {
        const close = matchingBrace(this.masked, i)
        if (close === -1 || close >= to) return i
        i = close + 1
      } else {
        return i
      }
    }
  }
}
