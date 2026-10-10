/**
 * Small, comment-aware scanners over LaTeX source. Positions are offsets in
 * the text given, so a match turns straight into an editor range.
 */

export type TextRange = { from: number; to: number }

const COMMENT = /(^|[^\\])((?:\\\\)*)(%.*)$/gm

/** The text with every `%` comment blanked to spaces: same length, same offsets. */
export function maskComments(text: string): string {
  return text.replace(
    COMMENT,
    (match, prefix, backslashes, comment) => prefix + backslashes + ' '.repeat(comment.length)
  )
}

/** The text without `%` comments; lines that held only a comment are dropped. */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*%/.test(line))
    .map(line =>
      line.replace(
        /(^|[^\\])((?:\\\\)*)%.*$/,
        (m, prefix, backslashes) => prefix + backslashes
      )
    )
    .join('\n')
}

/** Index of the `}` closing the `{` at `open`, or -1. Escaped braces do not count. */
export function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') {
      i++
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Index just past the optional argument `[…]` starting at `open`, or -1. */
function skipOptional(text: string, open: number): number {
  let depth = 0
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') {
      i++
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
    } else if (char === ']' && depth === 0) {
      return i + 1
    }
  }
  return -1
}

/** What precedes `\name` when the text defines the command rather than uses it. */
const DEFINITION =
  /\\(?:(?:re|provide)?newcommand\*?|DeclareRobustCommand\*?|def|let)\s*\{?\s*$/

/**
 * The first mandatory argument of the first use of `\name` — not a
 * definition of it, not in a comment, not a longer command such as
 * `\titlepage`: the range between its braces.
 */
export function findCommandArgument(
  text: string,
  name: string
): TextRange | null {
  const masked = maskComments(text)
  const pattern = new RegExp(`\\\\${name}(?![a-zA-Z@])`, 'g')
  for (const match of masked.matchAll(pattern)) {
    const at = match.index ?? 0
    if (DEFINITION.test(masked.slice(Math.max(0, at - 40), at))) continue
    let i = at + match[0].length
    for (;;) {
      while (/\s/.test(masked[i] ?? '')) i++
      if (masked[i] !== '[') break
      i = skipOptional(masked, i)
      if (i === -1) break
    }
    if (i === -1 || masked[i] !== '{') continue
    const close = matchingBrace(masked, i)
    if (close !== -1) return { from: i + 1, to: close }
  }
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The body of the first `\begin{name}…\end{name}` outside comments. */
export function findEnvironmentBody(
  text: string,
  name: string
): TextRange | null {
  const masked = maskComments(text)
  const env = escapeRegExp(name)
  const begin = new RegExp(`\\\\begin\\s*\\{${env}\\}`).exec(masked)
  if (!begin) return null
  const from = begin.index + begin[0].length
  const tagRe = new RegExp(`\\\\(begin|end)\\s*\\{${env}\\}`, 'g')
  tagRe.lastIndex = from
  let depth = 1
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(masked)) !== null) {
    if (m[1] === 'begin') {
      depth++
    } else {
      depth--
      if (depth === 0) {
        return { from, to: m.index }
      }
    }
  }
  return null
}

/**
 * `range` without the whitespace at either end. A range holding only
 * whitespace keeps its full extent and is flagged empty.
 */
export function trimRange(
  text: string,
  range: TextRange
): TextRange & { empty: boolean } {
  const inner = text.slice(range.from, range.to)
  const lead = inner.length - inner.trimStart().length
  if (lead === inner.length) return { ...range, empty: true }
  const trail = inner.length - inner.trimEnd().length
  return { from: range.from + lead, to: range.to - trail, empty: false }
}

/** The `\documentclass` name, if the text has one outside comments. */
export function documentClassOf(text: string): string | null {
  const match = maskComments(text).match(
    /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/
  )
  return match ? match[1].trim() : null
}
