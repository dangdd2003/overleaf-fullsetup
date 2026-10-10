import type { MaskedEdit } from './edits'

/**
 * When a change to the text is worth a new check. A sentence is checked once;
 * it is checked again only when what the model reads changes:
 * - its own words or punctuation (grammar can change with any of them);
 * - its neighbours' words, by enough to change its meaning in context.
 *
 * Changes the model would not see do not count: whitespace and line breaks,
 * curly against straight quotes, and the LaTeX behind a placeholder (a
 * formula, a citation, a command) — `[[M3]]` and `[[M4]]` read the same, so
 * adding math earlier in a paragraph, which renumbers the placeholders after
 * it, checks nothing again.
 */

const PLACEHOLDER = /^\[\[([MCRX])\d+\]\]/
const QUOTES: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
}

export type Normalized = {
  /** What a check reads. */
  text: string
  /** Per character of `text`, and one past its end: the index in the original. */
  toRaw: number[]
}

/** The text a check reads, with where each of its characters came from. */
export function normalizeForCheck(raw: string): Normalized {
  let text = ''
  const toRaw: number[] = []
  let i = 0
  while (i < raw.length) {
    const placeholder = PLACEHOLDER.exec(raw.slice(i, i + 12))
    if (placeholder) {
      const token = `[[${placeholder[1]}]]`
      // Each kept character maps to the start of the token, its end to the end
      for (let k = 0; k < token.length; k++) toRaw.push(i)
      text += token
      i += placeholder[0].length
      toRaw[toRaw.length - 1] = i - 1
      continue
    }
    const ch = raw[i]
    if (/\s/.test(ch)) {
      let end = i
      while (end < raw.length && /\s/.test(raw[end])) end++
      if (text.length > 0 && end < raw.length) {
        text += ' '
        toRaw.push(i)
      }
      i = end
      continue
    }
    text += QUOTES[ch] ?? ch
    toRaw.push(i)
    i++
  }
  toRaw.push(raw.length)
  return { text, toRaw }
}

/** The index in `normalized.text` of the first character at or after raw index `pos`. */
function toNormalized(normalized: Normalized, pos: number): number {
  const { toRaw } = normalized
  let k = 0
  while (k < toRaw.length - 1 && toRaw[k] < pos) k++
  return k
}

/**
 * `edits`, made for `fromText`, moved onto `toText`, which reads the same to
 * a check. Null when the texts differ, or an edit no longer lands on the
 * words it was made for: the sentence is then checked again.
 */
export function moveEdits(
  edits: MaskedEdit[],
  fromText: string,
  toText: string
): MaskedEdit[] | null {
  if (fromText === toText) return edits
  const from = normalizeForCheck(fromText)
  const to = normalizeForCheck(toText)
  if (from.text !== to.text) return null
  const moved: MaskedEdit[] = []
  for (const edit of edits) {
    const start = to.toRaw[toNormalized(from, edit.from)]
    const end =
      edit.to === edit.from ? start : to.toRaw[toNormalized(from, edit.to) - 1] + 1
    const original = toText.slice(start, end)
    if (normalizeForCheck(original).text !== normalizeForCheck(edit.original).text) {
      return null
    }
    moved.push({ ...edit, from: start, to: end, original })
  }
  return moved
}

/** At most this many words of each neighbour count. */
const CONTEXT_WORDS = 40
/** A neighbour change of at least this many words… */
export const CONTEXT_MIN_WORDS = 3
/** …and this share of the neighbours' words changes the sentence's context. */
export const CONTEXT_SHARE = 0.25

function words(text: string): string[] {
  return (
    normalizeForCheck(text)
      .text.replace(/\[\[[MCRX]\]\]/g, ' ')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

/** The words of the sentences before and after, as a check reads them. */
export function contextFingerprint(before: string | null, after: string | null): string {
  const side = (text: string | null) => (text ? words(text).slice(-CONTEXT_WORDS) : [])
  return `${side(before).join(' ')}|${(after ? words(after).slice(0, CONTEXT_WORDS) : []).join(' ')}`
}

/**
 * How many words changed between two lists: the larger of those removed and
 * those added (a word replaced counts once), by longest common subsequence.
 */
function wordDistance(a: string[], b: string[]): number {
  const row = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1])
      diagonal = above
    }
  }
  const common = row[b.length]
  return Math.max(a.length - common, b.length - common)
}

/**
 * Whether the neighbours changed enough to change what the sentence means:
 * a fixed typo or a reworded phrase next door does not, and neither does a
 * sentence added where there was none (writing on after it does not change
 * it); rewriting or removing a neighbour does.
 */
export function contextChanged(checked: string, now: string): boolean {
  if (checked === now) return false
  const [beforeA = '', afterA = ''] = checked.split('|')
  const [beforeB = '', afterB = ''] = now.split('|')
  const split = (text: string) => (text ? text.split(' ') : [])
  let changed = 0
  let total = 0
  for (const [a, b] of [
    [split(beforeA), split(beforeB)],
    [split(afterA), split(afterB)],
  ]) {
    if (a.length === 0) continue
    changed += wordDistance(a, b)
    total += Math.max(a.length, b.length)
  }
  return changed >= CONTEXT_MIN_WORDS && changed >= CONTEXT_SHARE * total
}

/** Whether any of the contexts a sentence was checked in still holds; true when none was kept. */
export function contextHolds(checked: string[] | undefined, now: string): boolean {
  return !checked || checked.some(context => !contextChanged(context, now))
}
