import { escapeAttribute, neutraliseClosingTags } from './escape'

/**
 * The code a fix run is handed up front.
 *
 * A compile entry points at one or two lines, not at a project. Sending those
 * lines with the entry — plus the preamble, because the single most common
 * LaTeX fix is a `\usepackage` that was never loaded — is what lets the usual
 * run answer without calling a tool at all. Every tool call it saves is a
 * whole provider round trip the user is sitting through.
 *
 * The window is deliberately small. Widening it buys context the model rarely
 * reads and costs tokens on every single fix.
 */

/** Lines of context kept above the entry: enough to see an opened environment. */
export const WINDOW_BEFORE = 8

/** Lines kept below it: enough to see the environment close. */
export const WINDOW_AFTER = 6

/** The preamble is only ever a prefix; this caps a pathological one. */
export const PREAMBLE_MAX_LINES = 40

/** Renders `lines` with absolute line numbers, starting at `from`. */
function numbered(lines: string[], from: number): string {
  return lines
    .map((text, index) => `${from + index}: ${neutraliseClosingTags(text)}`)
    .join('\n')
}

/** The 1-based, clamped range to read around a line. */
export function windowFor(line: number): { from: number; to: number } {
  return {
    from: Math.max(1, line - WINDOW_BEFORE),
    to: line + WINDOW_AFTER,
  }
}

export function renderSourceWindow({
  path,
  from,
  lines,
  caret,
}: {
  path: string
  from: number
  lines: string[]
  caret: number | null
}): string {
  if (lines.length === 0) return ''
  const to = from + lines.length - 1
  const caretAttribute =
    caret !== null && caret >= from && caret <= to ? ` entry-line="${caret}"` : ''
  return [
    `<source file="${escapeAttribute(path)}" lines="${from}-${to}"${caretAttribute}>`,
    numbered(lines, from),
    '</source>',
  ].join('\n')
}

/**
 * Renders the preamble, cut at \begin{document}.
 *
 * Everything after that line is body text the entry's own window already
 * covers, so carrying it here would be paying twice for the same tokens.
 */
export function renderPreamble({
  path,
  lines,
}: {
  path: string
  lines: string[]
}): string {
  const end = lines.findIndex(line => line.includes('\\begin{document}'))
  const kept = (end === -1 ? lines : lines.slice(0, end + 1)).slice(
    0,
    PREAMBLE_MAX_LINES
  )
  if (kept.length === 0) return ''
  return [
    `<preamble file="${escapeAttribute(path)}" lines="1-${kept.length}">`,
    numbered(kept, 1),
    '</preamble>',
  ].join('\n')
}
