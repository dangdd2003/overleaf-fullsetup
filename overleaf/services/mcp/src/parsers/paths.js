import { CODES, OverleafApiError } from '../errors.js'

/**
 * Normalise a project path the model supplied to the canonical form web
 * expects: a leading slash, forward slashes, no empty or '.' segments and no
 * trailing slash. Backslashes, a './' prefix and surrounding quotes are
 * accepted. A '..' that would climb above the project root is refused.
 *
 * @param {unknown} input
 * @returns {string} e.g. '/chapters/intro.tex', or '/' for the root
 */
export function normalisePath(input) {
  const value = String(input ?? '')
    .trim()
    .replace(/^(["'`])(.*)\1$/, '$2')
  const segments = []
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          `path escapes the project root: ${value}`,
          400,
          { hint: 'Paths are relative to the project root, e.g. /main.tex.' }
        )
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/**
 * Normalise a path that must name a document or file, not the project root.
 *
 * @param {unknown} input
 * @param {string} [label] the parameter name, for the error message
 * @returns {string}
 */
export function requireFilePath(input, label = 'path') {
  if (typeof input !== 'string' || !input.trim()) {
    throw new OverleafApiError(
      CODES.VALIDATION_ERROR,
      `${label} is required`,
      400,
      { hint: 'Pass a project path such as /main.tex. Call list_files to find one.' }
    )
  }
  const normalised = normalisePath(input)
  if (normalised === '/') {
    throw new OverleafApiError(
      CODES.VALIDATION_ERROR,
      `${label} must name a file or folder, not the project root`,
      400,
      { hint: 'Call list_files to find the exact path.' }
    )
  }
  return normalised
}

/**
 * Compile a shell-style glob into a predicate over project paths.
 *
 * `*` matches within one folder, `**` across folders, `?` one character. A
 * pattern without a slash matches the file name at any depth, so `*.tex`
 * selects every .tex file. Matching is case-insensitive.
 *
 * @param {string} glob
 * @returns {(path: string) => boolean} tests a normalised path such as /a/b.tex
 */
export function globMatcher(glob) {
  const pattern = normalisePath(glob).slice(1).toLowerCase()
  // The glob becomes a small NFA walked once over the subject with the set of
  // live states, so matching is O(path x pattern) whatever the glob: a regex
  // built from user `*`s backtracks polynomially on long names.
  // Each state may consume a character and move on (`step`), consume one and
  // stay (`loop`), or move on without consuming (`skip`, a list of states).
  const states = []
  const notSlash = c => c !== '/'
  const anyChar = () => true
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    const at = states.length
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // `**/`: nothing, or anything ending in a slash
        states.push({ skip: [at + 1, at + 3] })
        states.push({ loop: anyChar, skip: [at + 2] })
        states.push({ step: c => c === '/' })
        i += 2
      } else {
        states.push({ loop: anyChar, skip: [at + 1] })
        i += 1
      }
    } else if (ch === '*') {
      states.push({ loop: notSlash, skip: [at + 1] })
    } else if (ch === '?') {
      states.push({ step: notSlash })
    } else {
      states.push({ step: c => c === ch })
    }
  }
  const accept = states.length

  /** Adds `start` and every state reachable from it without consuming. */
  const addClosed = (live, start) => {
    const stack = [start]
    while (stack.length) {
      const state = stack.pop()
      if (live[state]) continue
      live[state] = true
      for (const next of states[state]?.skip ?? []) stack.push(next)
    }
  }

  const matchesFullPath = pattern.includes('/')
  return path => {
    const subject = (
      matchesFullPath ? path.slice(1) : path.slice(path.lastIndexOf('/') + 1)
    ).toLowerCase()
    let live = new Array(accept + 1).fill(false)
    addClosed(live, 0)
    for (const c of subject) {
      const next = new Array(accept + 1).fill(false)
      let any = false
      for (let state = 0; state < accept; state++) {
        if (!live[state]) continue
        const { step, loop } = states[state]
        if (step?.(c)) {
          addClosed(next, state + 1)
          any = true
        }
        if (loop?.(c)) {
          addClosed(next, state)
          any = true
        }
      }
      if (!any) return false
      live = next
    }
    return live[accept]
  }
}
