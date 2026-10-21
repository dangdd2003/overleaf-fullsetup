/**
 * Helpers for the compact text every tool result is rendered as.
 *
 * The text block is what a model reads, so it carries only what the model
 * needs to act: no echoed inputs, no null/false/empty fields, no JSON
 * escaping of LaTeX backslashes, and records as one line each rather than
 * pretty-printed objects. `structuredContent` keeps the full JSON for
 * programmatic clients.
 */

function isEmpty(value) {
  if (value === undefined || value === null || value === false || value === '') {
    return true
  }
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/**
 * Drop undefined, null, false, '' and empty arrays/objects, recursively.
 * Zero is kept: a count of 0 is information.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function prune(value) {
  if (Array.isArray(value)) {
    return value.map(prune).filter(item => !isEmpty(item))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const pruned = prune(item)
      if (!isEmpty(pruned)) out[key] = pruned
    }
    return out
  }
  return value
}

/** Single-line JSON of the pruned value, or '' when nothing is left. */
export function compactJson(value) {
  const pruned = prune(value)
  if (isEmpty(pruned)) return ''
  return JSON.stringify(pruned)
}

/** `path:line`, `path:line-end`, or just `path` when the line is unknown. */
export function ref(path, line, endLine) {
  if (line == null) return path ?? '?'
  const span = endLine != null && endLine !== line ? `${line}-${endLine}` : `${line}`
  return `${path ?? '?'}:${span}`
}

/**
 * Join the truthy parts with newlines; arrays are flattened, so a renderer
 * can mix single lines and lists of lines.
 *
 * @param {...(string|string[]|false|null|undefined)} parts
 */
export function lines(...parts) {
  return parts
    .flat(Infinity)
    .filter(part => part !== undefined && part !== null && part !== false && part !== '')
    .join('\n')
}

/**
 * Collapse a run of integers into ranges: [1,2,3,7,9,10] -> "1-3,7,9-10".
 *
 * @param {number[]} numbers
 */
export function numberRuns(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  const runs = []
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++
    runs.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`)
  }
  return runs.join(',')
}

/** Shorten text to max characters, marking the cut with an ellipsis. */
export function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
