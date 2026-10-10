const SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * Minimal glob matching: `*` stops at a slash, `**` crosses them.
 * Port of frontend/js/features/ai-assist/agent/tools/search-text.ts:matchesGlob.
 */
export function matchesGlob(path, pattern) {
  const sanitized = String(pattern || '')
    .replace(/(?:\*\*\/)+/g, '**/')
    .replace(/\*{2,}/g, '**')
  const source = sanitized
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .filter(Boolean)
    .map(token => {
      if (token === '**/') return '(?:.*/)?'
      if (token === '**') return '.*'
      if (token === '*') return '[^/]*'
      if (token === '?') return '[^/]'
      return token.replace(SPECIALS, '\\$&')
    })
    .join('')

  return new RegExp(`^${source}$`).test(path)
}
