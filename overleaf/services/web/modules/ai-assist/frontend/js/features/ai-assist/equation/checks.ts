import { diffArrays } from 'diff'
import { KEYED_COMMAND_PATTERN } from '../writing-tools/latex-patterns'
import { braceBalance } from '../writing-tools/latex-check'

/** Where the equation goes in the model's passage. */
export const SLOT = '<equation/>'
const SLOT_SPELLINGS = /<equation\s*\/>/g

export function normalizeSlots(passage: string): string {
  return passage.replace(SLOT_SPELLINGS, SLOT)
}

/** Every key of `\cite…`, `\ref`, `\eqref`, `\cref`, `\label`… in the text. */
export function keysIn(text: string): Set<string> {
  const keys = new Set<string>()
  for (const match of text.matchAll(KEYED_COMMAND_PATTERN)) {
    for (const key of match[3].split(',')) {
      if (key.trim()) keys.add(key.trim())
    }
  }
  return keys
}

/** Models like `<passage>\n…\n</passage>`: a newline the original lacks is formatting, not an edit. */
export function alignEdges(reply: string, original: string): string {
  let text = reply
  if (!original.startsWith('\n') && text.startsWith('\n')) text = text.slice(1)
  if (!original.endsWith('\n') && text.endsWith('\n')) text = text.slice(0, -1)
  return text
}

function tokens(text: string): string[] {
  return text.split(/(\s+)/).filter(Boolean)
}

/** Runs of changed words (`hunks`) and how many words they add or remove. */
export function editStats(original: string, result: string): { hunks: number; words: number } {
  let hunks = 0
  let words = 0
  let inHunk = false
  for (const part of diffArrays(tokens(original), tokens(result))) {
    if (part.added || part.removed) {
      if (!inHunk) hunks++
      inHunk = true
      words += part.value.filter(token => /\S/.test(token)).length
    } else if (part.value.some(token => /\S/.test(token))) {
      inHunk = false
    }
  }
  return { hunks, words }
}

export type GuardResult =
  | { ok: true; editCount: number; changedWords: number }
  | { ok: false; problems: string[] }

export const MAX_CHANGED_WORDS = 12

function blankLines(text: string): number {
  return (text.match(/\n[ \t]*\n/g) ?? []).length
}

function commentCount(text: string): number {
  return [...text.matchAll(/(?<!\\)%/g)].length
}

/** Every `\begin`/`\end` name with its count, as one comparable string. */
function environmentCounts(text: string): string {
  const counts = new Map<string, number>()
  for (const match of text.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
    const key = `${match[1]}:${match[2].trim()}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}=${count}`)
    .join(',')
}

/**
 * Whether the model's passage only made the small edits it was allowed:
 * the slot once, every key kept, balanced braces, unchanged environments,
 * no added comments or blank lines, and at most 12 changed words.
 */
export function guardPassage(
  original: { before: string; after: string },
  reply: string
): GuardResult {
  const pieces = normalizeSlots(reply).split(SLOT)
  if (pieces.length !== 2) {
    return { ok: false, problems: [`The <passage> must contain ${SLOT} exactly once.`] }
  }
  const [left, right] = pieces
  const problems: string[] = []
  const kept = keysIn(left + right)
  const lost = [...keysIn(original.before + original.after)].filter(key => !kept.has(key))
  if (lost.length > 0) problems.push(`Keep these keys: ${lost.join(', ')}.`)
  const was = original.before + original.after
  const now = left + right
  if (braceBalance(now) !== braceBalance(was)) {
    problems.push('Keep the braces in the passage balanced as they were.')
  }
  if (environmentCounts(now) !== environmentCounts(was)) {
    problems.push('Do not add or remove \\begin or \\end in the passage.')
  }
  if (commentCount(now) > commentCount(was)) {
    problems.push('Do not add comments to the passage.')
  }
  if (blankLines(now) > blankLines(was)) {
    problems.push('Do not add blank lines to the passage.')
  }
  if (problems.length > 0) return { ok: false, problems }

  const before = editStats(original.before, left)
  const after = editStats(original.after, right)
  const changedWords = before.words + after.words
  if (changedWords > MAX_CHANGED_WORDS) {
    return {
      ok: false,
      problems: [`Change at most ${MAX_CHANGED_WORDS} words around the equation.`],
    }
  }
  return { ok: true, editCount: before.hunks + after.hunks, changedWords }
}
