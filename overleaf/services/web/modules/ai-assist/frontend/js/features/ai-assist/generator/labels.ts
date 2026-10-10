import { maskComments } from '../texgpt/latex-text'

/**
 * The prefix among `prefixes` that the labels use most; `fallback` when
 * none uses any. List the longer of two overlapping prefixes first.
 */
export function labelStyle(
  labels: Iterable<string>,
  prefixes: string[],
  fallback: string
): string {
  const counts = new Map<string, number>()
  for (const label of labels) {
    const prefix = prefixes.find(candidate => label.startsWith(candidate))
    if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }
  let best = fallback
  let bestCount = 0
  for (const [prefix, count] of counts) {
    if (count > bestCount) {
      best = prefix
      bestCount = count
    }
  }
  return best
}

const LABEL = /\\label\s*\{([^}]*)\}/g

/** Every `\label` key in the text, outside comments. */
export function labelsIn(doc: string): Set<string> {
  const keys = new Set<string>()
  for (const match of maskComments(doc).matchAll(LABEL)) {
    const key = match[1].trim()
    if (key) keys.add(key)
  }
  return keys
}

/** `label`, or `label-2`, `label-3`… when the project already uses it. */
export function uniqueLabel(label: string, taken: Set<string>): string {
  if (!taken.has(label)) return label
  for (let n = 2; ; n++) {
    const candidate = `${label}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
