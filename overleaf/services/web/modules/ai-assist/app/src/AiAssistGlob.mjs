/**
 * Minimal glob matching: `*` stops at a slash, `**` crosses them, `**\/` matches
 * zero or more whole directories, `?` is one character that is not a slash.
 *
 * Patterns come from the model, so this does not build a RegExp from them: a
 * pattern with many stars makes a backtracking RegExp take exponential time on
 * a path that almost matches, and this runs on the web process itself. Instead
 * each token moves the set of reachable positions in the path, which costs
 * O(tokens x path length).
 *
 * Port of frontend/js/features/ai-assist/agent/tools/search-text.ts:matchesGlob.
 */
export function matchesGlob(path, pattern) {
  const sanitized = String(pattern || '')
    .replace(/(?:\*\*\/)+/g, '**/')
    .replace(/\*{2,}/g, '**')
  const tokens = sanitized
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .filter(Boolean)
    .map(token => {
      if (token === '**/') return { kind: 'dirs' }
      if (token === '**') return { kind: 'any' }
      if (token === '*') return { kind: 'word' }
      if (token === '?') return { kind: 'char' }
      return { kind: 'text', text: token }
    })

  const text = String(path)
  const length = text.length
  // reachable[i] is 1 when the tokens so far can match text[0, i)
  let reachable = new Uint8Array(length + 1)
  reachable[0] = 1
  for (const token of tokens) {
    const next = new Uint8Array(length + 1)
    switch (token.kind) {
      case 'text':
        for (let i = 0; i <= length; i++) {
          if (reachable[i] && text.startsWith(token.text, i)) {
            next[i + token.text.length] = 1
          }
        }
        break
      case 'char':
        for (let i = 0; i < length; i++) {
          if (reachable[i] && text[i] !== '/') next[i + 1] = 1
        }
        break
      case 'word':
        // Zero or more characters, none of them a slash
        next.set(reachable)
        for (let i = 0; i < length; i++) {
          if (next[i] && text[i] !== '/') next[i + 1] = 1
        }
        break
      case 'any': {
        // Zero or more characters of any kind
        const first = reachable.indexOf(1)
        if (first !== -1) next.fill(1, first)
        break
      }
      case 'dirs': {
        // Nothing, or anything that ends in a slash
        next.set(reachable)
        let started = false
        for (let q = 1; q <= length; q++) {
          if (reachable[q - 1]) started = true
          if (started && text[q - 1] === '/') next[q] = 1
        }
        break
      }
    }
    reachable = next
    if (reachable.indexOf(1) === -1) return false
  }
  return reachable[length] === 1
}
