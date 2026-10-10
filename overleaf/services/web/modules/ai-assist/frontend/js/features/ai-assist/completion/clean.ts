import type { CompletionKind } from './detect'
import type { CursorSituation } from './placement'
import { ALL_TABLE_ENVS, BLOCK_START_PATTERN, MAJOR_BLOCK_PATTERN } from './structure'
import { layoutLatex } from './layout'

export type CleanCompletion = {
  text: string
  /** A natural end was found (sentence, line, block): stop reading. */
  complete: boolean
}

export type CleanOptions = {
  kind: CompletionKind
  /** The text before the cursor (the prefix window). */
  before: string
  /** The text after the cursor (the suffix window). */
  after: string
  /** Where the cursor is (placement.ts): the reply is held to it. */
  situation?: Pick<
    CursorSituation,
    | 'newLine'
    | 'sameLine'
    | 'indent'
    | 'forbidBegin'
    | 'forbidEnd'
    | 'rows'
    | 'argumentOf'
    | 'envs'
    | 'argumentClosed'
    | 'rowEndAfter'
    | 'region'
    | 'announces'
  >
  /** One level of indentation, as the document writes it (layout.ts `indentUnit`). */
  unit?: string
}

type Situation = NonNullable<CleanOptions['situation']>

/** Commands that start a document part: never inside an environment or an argument. */
const SECTIONING = /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/

/** Where a reply stops fitting the cursor's place; -1 when it fits throughout. */
function structureBreak(text: string, situation: Situation): number {
  let cut = -1
  const earliest = (at: number) => {
    if (at !== -1 && (cut === -1 || at < cut)) cut = at
  }
  for (const match of text.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    const name = match[2].trim()
    // A second table inside the table being written; a closing the text already has
    if (match[1] === 'begin' && situation.forbidBegin.includes(name)) earliest(match.index!)
    if (match[1] === 'end' && situation.forbidEnd.includes(name)) earliest(match.index!)
    // Strictly prevent loop tables: inside a table, any new table/tabular environment is cut
    if (match[1] === 'begin' && (situation.rows !== null || situation.envs.some(e => ALL_TABLE_ENVS.has(e.name))) && ALL_TABLE_ENVS.has(name)) {
      earliest(match.index!)
    }
  }
  if (situation.envs.length > 0 || situation.argumentOf) earliest(text.search(SECTIONING))
  if (situation.argumentOf) {
    // An argument ends at its closing brace (kept when the text has none yet) or the line end
    let depth = 0
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c === '\\') {
        i++
        continue
      }
      if (c === '{') depth++
      else if (c === '}') {
        if (depth === 0) {
          earliest(situation.argumentClosed === false ? i + 1 : i)
          break
        }
        depth--
      } else if (c === '\n') {
        earliest(i)
        break
      }
    }
  }
  const { rows } = situation
  // The row's `\\` is already after the cursor: the reply is the rest of the row before it
  if (situation.rowEndAfter) earliest(text.indexOf('\\\\'))
  if (rows?.columns) {
    // No row gets more cells than the table has
    let allowed = rows.columns - 1 - (rows.atRowStart ? 0 : rows.separatorsBefore)
    let depth = 0
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c === '\\') {
        if (text[i + 1] === '\\') {
          allowed = rows.columns - 1
        }
        i++
        continue
      }
      if (c === '{') depth++
      else if (c === '}') depth = Math.max(0, depth - 1)
      else if (c === '&' && depth === 0) {
        if (allowed <= 0) {
          earliest(i)
          break
        }
        allowed--
      }
    }
  }
  return cut
}

/**
 * Code and drawings, which the LaTeX layout leaves alone, are placed here:
 * - If the text begins with a block structure (\\begin, \\[, \\section, \\item...)
 *   or situation.newLine is true, and preceding text exists on the cursor line,
 *   it is ALWAYS placed on a new line (or paragraph break) at proper indent.
 * - Inside an existing empty line, it ensures lines are indented properly.
 */
function placed(text: string, situation: Situation | undefined, before: string): string {
  const isBlock = BLOCK_START_PATTERN.test(text)
  const forceNewLine = Boolean(situation?.newLine)
  if (!isBlock && !forceNewLine) return text

  const body = text.replace(/^\s*\n?/, '')
  if (!body.trim()) return ''

  const hasTextBefore = /\S/.test(before)
  const indent = situation?.indent || ''

  if (hasTextBefore || forceNewLine) {
    const isMajor = MAJOR_BLOCK_PATTERN.test(body)
    const afterSentence = /[.?!:]\s*$/.test(before)
    const prefix = hasTextBefore && (isMajor || afterSentence) ? '\n\n' : '\n'
    const lines = body.split('\n').map(line =>
      line && !/^[ \t]/.test(line) ? indent + line : line
    )
    return `${prefix}${lines.join('\n')}`
  }

  // Preceding line is already empty/indented at cursor
  const lines = body.split('\n').map((line, idx) => {
    if (!line) return ''
    if (idx === 0) return /^[ \t]/.test(line) ? line.trimStart() : line
    return /^[ \t]/.test(line) ? line : indent + line
  })
  return lines.join('\n')
}

const EMPTY: CleanCompletion = { text: '', complete: false }

/** A full stop after these ends an abbreviation, not the sentence. */
const ABBREVIATION =
  /(?:^|[\s~(])(?:e\.g|i\.e|et al|etc|cf|vs|resp|approx|Fig|Figs|Eq|Eqs|Sec|Secs|Ref|Refs|Tab|Ch|No|Dr|Prof|[A-Z])\.$/
const OVERLAP_MAX = 200
const OVERLAP_MIN = 3
export const MAX_BLOCK_LINES = 16
/** However long, an environment the reply opened is let run this far to reach its `\end`. */
export const MAX_OPEN_BLOCK_LINES = 80

/** Fences and a wrapping quote off; null while a fence may still be opening. */
function unwrap(reply: string, done: boolean, kind: CompletionKind): string | null {
  if (!done && /^\s*`{1,3}[A-Za-z]*$/.test(reply)) return null
  let text = reply.replace(/^\s*```[A-Za-z]*[ \t]*\n?/, '')
  text = text.replace(/\n?```\s*$/, '')
  text = text.replace(/^\s*<completion>\s*/i, '')
  text = text.replace(/\s*<\/completion>\s*$/i, '')
  // The request's own markers, echoed
  text = text.replace(/^\s*<\/?excerpt[^>]*>[ \t]*\n?/i, '').replace(/\n?[ \t]*<\/excerpt>\s*$/i, '')
  text = text.replace(/<cursor\s*\/?>/gi, '')
  if (!done && /<[a-z/]*$/i.test(text)) text = text.replace(/<[a-z/]*$/i, '')
  // The markers of the system prompt's examples, echoed
  text = text.replace(/^\s*(?:reply|assistant):[ \t]?/i, '').replace(/⏎/g, '\n')
  text = text.replace(/\n?[ \t]*end of reply[\s\S]*$/i, '')
  if (!done) text = text.replace(/\n[ \t]*e(?:n(?:d(?: (?:o(?:f(?: (?:r(?:e(?:p(?:l(?:y)?)?)?)?)?)?)?)?)?)?)?$/i, '')
  // Lines keep their leading newline and indentation; the rest starts at a character
  text =
    kind === 'block' || kind === 'code'
      ? text.replace(/^[ \t]*(?=\n)/, '')
      : text.replace(/^\s+/, '')
  if (/^["“]/.test(text)) {
    text = text.slice(1)
    if (done) text = text.replace(/["”]\s*$/, '')
  }
  return text
}

/** How an assistant opens a remark to the user, rather than text for the document. */
const ASSISTANT_OPENER =
  /^(?:it (?:appears|seems|looks like)|here(?:'s| is| are)|sure\b|certainly\b|of course\b|i(?:'m| am| can| cannot| can't| will| would| see| notice| need)\b|your\b|you\b|please\b|note\b|unfortunately\b|based on\b|the (?:provided|given|above|latex|code|document|snippet|text)\b|this (?:latex|code|document|snippet)\b)/i
/** What such a remark is about: the request itself. */
const ABOUT_THE_REQUEST =
  /\b(?:your (?:[A-Za-z]+\s+)?(?:code|document|text|latex|input|message|snippet)|(?:provided|given|above) (?:[A-Za-z]+\s+)?(?:code|text|document|snippet|latex)|(?:was|is|got|been|has been)?\s*(?:cut off|truncated|incomplete|missing)|the cursor|<\/?(?:before|after|cursor|open|before_cursor|after_cursor|excerpt|task)\s*\/?>|autocomplet|(?:more|full) context|what you(?:['’]d| would) like|syntax error|mid-sentence)\b/i
/** Enough of a reply to tell a remark from the document's own words. */
const REMARK_WINDOW = 160

/**
 * A compiler's or a linter's message rather than text: it opens the reply
 * (`! Undefined control sequence`, `LaTeX Error: …`). The same words inside
 * a sentence of the document are the author's own.
 */
const COMPILER_MESSAGE =
  /^(?:!\s|(?:latex |package \S+ )?error(?::| on line)|syntax error\b|(?:compilation|compile) (?:error|fail\w*)|undefined control sequence|(?:latex |package \S+ )?warning:)/i
/** An assistant pointing at an error in the request. */
const ERROR_REMARK =
  /\b(?:(?:error|mistake)s? in (?:your|the) (?:code|latex|document)|code (?:contains|has) (?:an? )?error)\b/i

/**
 * Whether the reply talks to the author about the request ("It appears your
 * LaTeX code was cut off.") instead of continuing the text; null while a
 * streaming reply that opens like one cannot tell yet.
 */
function isRemark(text: string, done: boolean): boolean | null {
  const head = text.trimStart()
  if (COMPILER_MESSAGE.test(head) || ERROR_REMARK.test(head.slice(0, REMARK_WINDOW))) return true
  if (ASSISTANT_OPENER.test(head)) {
    if (ABOUT_THE_REQUEST.test(head.slice(0, REMARK_WINDOW))) return true
    return done || head.length >= REMARK_WINDOW ? false : null
  }
  return false
}

/**
 * The reply without the text before the cursor it repeats (matched from a
 * word start); null while a streaming reply may still turn into a repeat.
 */
function dropOverlap(text: string, before: string, done: boolean): string | null {
  const trimmed = before.replace(/\s+$/, '')
  for (let n = Math.min(OVERLAP_MAX, trimmed.length); n >= OVERLAP_MIN; n--) {
    const start = trimmed.length - n
    if (start > 0 && !/\s/.test(trimmed[start - 1])) continue
    const suffix = trimmed.slice(start)
    if (text.startsWith(suffix)) return text.slice(n)
    if (!done && suffix.startsWith(text)) return null
  }
  return text
}

/** Where the sentence ends (after its `.`, `?` or `!`); -1 when not yet known. */
function sentenceEnd(text: string, done: boolean): number {
  let depth = 0
  let math = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      // `\(` … `\)` is inline math, like `$` … `$`
      if (text[i + 1] === '(') math = true
      else if (text[i + 1] === ')') math = false
      i++
      continue
    }
    if (c === '$') math = !math
    else if (math) continue
    else if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === '.' || c === '?' || c === '!')) {
      const next = text[i + 1]
      if (next === undefined && !done) return -1
      if (next !== undefined && !/\s/.test(next)) continue
      if (c === '.' && ABBREVIATION.test(text.slice(0, i + 1))) continue
      return i + 1
    }
  }
  return -1
}

/** Just after an `\end{…}` closing an environment opened before the text; -1 if none. */
function closingEnd(text: string): number {
  const open: string[] = []
  for (const match of text.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    if (match[1] === 'begin') {
      open.push(match[2])
    } else if (open.length > 0 && open[open.length - 1] === match[2]) {
      open.pop()
    } else {
      return match.index! + match[0].length
    }
  }
  return -1
}

/** Where the `count`-th newline is; -1 when there are fewer. */
function nthNewline(text: string, count: number): number {
  let at = -1
  for (let i = 0; i < count; i++) {
    at = text.indexOf('\n', at + 1)
    if (at === -1) return -1
  }
  return at
}

/** A line that starts a block: `\\begin{…}`, `\\[`, `$$` or a heading. */
const BLOCK_LINE =
  /(?:^|\n)[ \t]*(\\begin\s*\{([^}]*)\}|\\\[|\$\$|\\(?:part|chapter|section|subsection|subsubsection|paragraph)\b)/

/** The first block in the text: where its line starts, and whether it is an environment or display (not a heading). */
function firstBlock(text: string): { at: number; env: boolean } | null {
  const match = BLOCK_LINE.exec(text)
  if (!match) return null
  return { at: match.index, env: !/^\\(?:part|chapter|section|subsection|subsubsection|paragraph)\b/.test(match[1]) }
}

/** How many environments the text opens and leaves open by `at`. */
function openAt(text: string, at: number): number {
  let depth = 0
  // `\\` (a row break, `\\[2pt]` too) is matched first so that its `\[` is not a display
  for (const match of text.slice(0, at).matchAll(/\\\\|\\(begin|end)\s*\{[^}]*\}|\\\[|\\\]/g)) {
    if (match[0] === '\\\\') continue
    const opens = match[1] === 'begin' || match[0] === '\\['
    depth = Math.max(0, depth + (opens ? 1 : -1))
  }
  return depth
}

/** The first paragraph break after `from` outside any environment the reply opened; -1 if none. */
function paragraphBreak(text: string, from: number): number {
  for (const match of text.slice(from).matchAll(/\n[ \t]*\n/g)) {
    const at = from + match.index!
    if (openAt(text, at) === 0) return at
  }
  return -1
}

/** The `count`-th line end that is outside every environment the reply opened; -1 when there is none yet. */
function lineLimit(text: string, count: number): number {
  const at = nthNewline(text, count)
  if (at === -1 || openAt(text, at) === 0) return at
  // Inside an environment: let it reach its \end, within reason
  for (let n = count + 1; n <= MAX_OPEN_BLOCK_LINES; n++) {
    const next = nthNewline(text, n)
    if (next === -1) return -1
    if (openAt(text, next) === 0) return next
  }
  return nthNewline(text, MAX_OPEN_BLOCK_LINES)
}

/** Just after the end of the display that starts at `from`; -1 while it is still open. */
function displayClose(text: string, from: number): number {
  const rest = text.slice(from)
  const opener = /^\s*(\\begin\s*\{([^}]*)\}|\\\[|\$\$)/.exec(rest)
  if (!opener) return -1
  const start = from + opener.index + opener[0].length
  if (!opener[2]) {
    const close = text.indexOf(opener[1] === '$$' ? '$$' : '\\]', start)
    return close === -1 ? -1 : close + 2
  }
  const name = opener[2].trim()
  let depth = 1
  for (const match of text.slice(start).matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)) {
    if (match[2].trim() !== name) continue
    depth += match[1] === 'begin' ? 1 : -1
    if (depth === 0) return start + match.index! + match[0].length
  }
  return -1
}

/** The kind's natural end: a sentence, a line, a block. */
function applyStops(
  text: string,
  kind: CompletionKind,
  done: boolean,
  announced: boolean
): CleanCompletion {
  let complete = false
  const cut = (at: number) => {
    text = text.slice(0, at)
    complete = true
  }
  if (kind === 'math') {
    const newline = text.indexOf('\n')
    if (newline !== -1) cut(newline)
    return { text, complete }
  }
  // A paragraph break ends it, unless it is inside an environment the reply
  // opened; the line breaks the reply starts with only place it
  const lead = /^\s*/.exec(text)![0].length
  const paragraph = paragraphBreak(text, lead)
  if (paragraph !== -1) cut(paragraph)
  if (kind === 'prose') {
    // One sentence, or the block it runs into (a formula, a list, a table…) up to its end
    const block = firstBlock(text)
    const end = sentenceEnd(block ? text.slice(0, block.at) : text, done || block !== null)
    if (end !== -1) {
      cut(end)
    } else if (block?.env) {
      const close = displayClose(text, block.at)
      if (close !== -1) cut(close)
    } else if (block && block.at > 0) {
      // A heading starts the next part: the sentence before it is the completion
      cut(block.at)
    }
    return { text, complete }
  }
  if (kind === 'block') {
    const end = closingEnd(text)
    if (end !== -1) {
      cut(end)
    } else if (announced) {
      // The table, figure or formula a sentence announced: the reply ends with it
      const block = firstBlock(text)
      if (block?.env && !/\S/.test(text.slice(0, block.at))) {
        const close = displayClose(text, block.at)
        if (close !== -1) cut(close)
      }
    }
  }
  const limit = lineLimit(text, MAX_BLOCK_LINES)
  if (limit !== -1) cut(limit)
  return { text, complete }
}

/** Whether a one- or two-character tail is a duplicate closer, not the text's own. */
function repeatsShortTail(body: string, piece: string): boolean {
  if (/^[.,;:!?]+$/.test(piece)) return true
  const count = (pattern: RegExp) => (body.match(pattern) ?? []).length
  return (
    count(/\}/g) > count(/\{/g) ||
    count(/\)/g) > count(/\(/g) ||
    count(/\]/g) > count(/\[/g) ||
    count(/(?<!\\)\$/g) % 2 === 1
  )
}

/** The text without a tail that repeats the start of `after`. */
function dropSuffixOverlap(text: string, after: string): string {
  const head = after.replace(/^\s+/, '')
  const body = text.replace(/\s+$/, '')
  for (let n = Math.min(OVERLAP_MAX, body.length, head.length); n >= 1; n--) {
    const piece = head.slice(0, n)
    if (!body.endsWith(piece)) continue
    if (n >= OVERLAP_MIN) return body.slice(0, body.length - n)
    // Short repeats count only for closers and punctuation, never for words
    if (!/[\p{L}\p{N}]/u.test(piece) && repeatsShortTail(body, piece)) {
      return body.slice(0, body.length - n)
    }
  }
  return text
}

/** One space between the text before the cursor and the completion, where words meet. */
function spaced(text: string, before: string): string {
  const body = text.replace(/^[ \t]+/, '')
  if (before === '' || /\s$/.test(before)) return body
  if (
    /[\p{L}\p{N},.;:!?)\]}'`"]$/u.test(before) &&
    /^[\p{L}\p{N}\\($`]/u.test(body)
  ) {
    return ` ${body}`
  }
  return body
}

/** A command the stream has cut short: held back so the layout does not move text already shown. */
const UNFINISHED_COMMAND =
  /\\(?:[A-Za-z]*\*?|(?:begin|end|part|chapter|(?:sub)*section)\*?\s*\{[^}\n]*)$/

/** Kinds whose replies are LaTeX text, laid out by layout.ts. */
const LAID_OUT: ReadonlySet<CompletionKind> = new Set(['prose', 'block'])

/**
 * The reply with every environment (and `\[`) it opened but did not close
 * closed on its own line, at its `\begin`'s indentation: a reply cut by the
 * output limit or a stop is completed, never dropped. An environment with
 * nothing in it yet is not content: it is left out.
 */
function closeOpenBlocks(text: string): string {
  const stack: Array<{ name: string | null; indent: string; at: number; bodyFrom: number }> = []
  for (const match of text.matchAll(/\\\\|\\(begin|end)\s*\{([^}]*)\}|\\\[|\\\]/g)) {
    if (match[0] === '\\\\') continue
    const at = match.index!
    if (match[1] === 'begin' || match[0] === '\\[') {
      const lineStart = text.lastIndexOf('\n', at - 1) + 1
      stack.push({
        name: match[1] ? match[2].trim() : null,
        indent: /^[ \t]*/.exec(text.slice(lineStart))![0],
        at,
        bodyFrom: at + match[0].length,
      })
    } else {
      // Closing one opened before the reply is the text's business (forbidEnd)
      const index = stack.map(env => env.name).lastIndexOf(match[1] ? match[2].trim() : null)
      if (index !== -1) stack.splice(index)
    }
  }
  let out = text.replace(/\s+$/, '')
  for (let k = stack.length - 1; k >= 0; k--) {
    const env = stack[k]
    // The `[h]` and `{lc}` of the `\begin` line are not content
    const body = out.slice(env.bodyFrom).replace(/^(?:[ \t]*(?:\[[^\]\n]*\]|\{[^}\n]*\}))*/, '')
    if (!/\S/.test(body)) {
      out = out.slice(0, env.at).replace(/\s+$/, '')
      continue
    }
    out += `\n${env.indent}${env.name !== null ? `\\end{${env.name}}` : '\\]'}`
  }
  return out
}

/** In the middle of a sentence: this line, unless the sentence runs into a block (formula, list, table…) on the next lines. */
function holdToLine(text: string): { text: string; cut: boolean } {
  const newline = text.indexOf('\n')
  if (newline === -1) return { text, cut: false }
  const block = firstBlock(text.slice(newline))
  if (block?.env && block.at === 0) return { text, cut: false }
  return { text: text.slice(0, newline), cut: true }
}

/** The model's reply (so far) → the ghost text at the cursor. */
export function cleanCompletion(
  reply: string,
  done: boolean,
  { kind, before, after, situation, unit }: CleanOptions
): CleanCompletion {
  const unwrapped = unwrap(reply, done, kind)
  if (unwrapped === null) return EMPTY
  // Nothing is shown of a remark, and nothing more is read
  const remark = isRemark(unwrapped, done)
  if (remark === null) return EMPTY
  if (remark) return { text: '', complete: true }
  const rest = dropOverlap(unwrapped, before, done)
  if (rest === null) return EMPTY
  let text = rest

  // In the document body, preamble commands never fit: the reply ends before the first
  const inBody = situation?.region ? situation.region === 'body' : /\\begin\s*\{\s*document\s*\}/.test(before)
  let cutByPreamble = false
  if (inBody) {
    const preamble = text.search(/\\(?:documentclass|usepackage)\b|\\begin\s*\{\s*document\s*\}/)
    if (preamble !== -1) {
      text = text.slice(0, preamble)
      cutByPreamble = true
    }
  }

  if (!done) text = text.replace(UNFINISHED_COMMAND, '')
  const lastLine = before.slice(before.lastIndexOf('\n') + 1)
  // The cursor stands after the line's indentation: the reply does not indent again
  if (lastLine !== '' && !/\S/.test(lastLine)) text = text.replace(/^[ \t]+/, '')

  const laidOut = LAID_OUT.has(kind) && !situation?.argumentOf
  if (laidOut) {
    text = layoutLatex(text, {
      before,
      envs: situation?.envs.map(env => env.name) ?? [],
      indent: situation?.indent ?? /^[ \t]*/.exec(lastLine)![0],
      unit: unit ?? '    ',
      newLine: situation?.newLine,
    })
  }

  let cutByStructure = false
  if (situation) {
    if (situation.sameLine) {
      // In the middle of a sentence: this line, then at most the display it introduces
      const held = holdToLine(laidOut ? text : text.replace(/^\s+/, ' '))
      text = held.text
      if (held.cut) cutByStructure = true
    }
    const cut = structureBreak(text, situation)
    if (cut !== -1) {
      text = text.slice(0, cut)
      cutByStructure = true
    }
  }
  const stopped = applyStops(text, kind, done, Boolean(situation?.announces))
  text = stopped.text
  if (cutByStructure || cutByPreamble) stopped.complete = true
  if (!laidOut && (BLOCK_START_PATTERN.test(text) || situation?.newLine)) {
    text = placed(text, situation, before)
  }
  const final = done || stopped.complete
  if (final && laidOut) text = closeOpenBlocks(text)
  if (final) text = dropSuffixOverlap(text, after)
  const startsLine = /^[ \t]*\n/.test(text)
  if (!startsLine && !situation?.newLine && kind !== 'block' && kind !== 'code') {
    text = spaced(text, before)
  }
  if (final) {
    text = text.replace(/\s+$/, '')
  }
  return text.trim() ? { text, complete: stopped.complete } : { text: '', complete: stopped.complete }
}
