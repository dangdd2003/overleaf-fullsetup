import { AgentTool } from './registry'
import { MAX_SEARCH_HITS } from '../project-handle'

type GlobToken =
  | { kind: 'text'; text: string }
  | { kind: 'dirs' }
  | { kind: 'any' }
  | { kind: 'word' }
  | { kind: 'char' }

/**
 * Minimal glob matching: `*` stops at a slash, `**` crosses them, `**\/` matches
 * zero or more whole directories, `?` is one character that is not a slash.
 *
 * Patterns come from the model, so this does not build a RegExp from them: a
 * pattern with many stars makes a backtracking RegExp take exponential time on
 * a path that almost matches. Instead each token moves the set of reachable
 * positions in the path, which costs O(tokens x path length).
 *
 * Deliberately not a dependency. Same semantics as the server's
 * modules/ai-assist/app/src/AiAssistGlob.mjs, which runs the same matching.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const sanitized = String(pattern || '')
    .replace(/(?:\*\*\/)+/g, '**/')
    .replace(/\*{2,}/g, '**')
  const tokens: GlobToken[] = sanitized
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .filter(Boolean)
    .map((token): GlobToken => {
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

export const searchTextTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'search_text',
    description:
      "Find a string or regular expression across the project's text files, with surrounding context lines. Pass glob to search only matching files. Use this to locate something whose file you do not know.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        glob: {
          type: 'string',
          description: 'Only search files matching this glob, e.g. sections/*.tex',
        },
        path: {
          type: 'string',
          description: 'Specific file path or glob pattern to search in (alias for glob)',
        },
        contextLines: {
          type: 'number',
          description: 'Lines of surrounding context per hit. Defaults to 1.',
        },
        caseSensitive: { type: 'boolean' },
        regexp: { type: 'boolean' },
      },
      required: ['query'],
    },
  },

  async execute(
    {
      query,
      glob,
      path: legacyPath,
      contextLines = 1,
      caseSensitive,
      regexp,
    }: {
      query: string
      glob?: string
      path?: string
      contextLines?: number
      caseSensitive?: boolean
      regexp?: boolean
    },
    handle
  ) {
    const pattern = glob ?? legacyPath
    const all = await handle.search(query, { caseSensitive, regexp, glob: pattern })
    const filtered = pattern ? all.filter(hit => matchesGlob(hit.path, pattern)) : all
    const shown = filtered.slice(0, MAX_SEARCH_HITS)

    const cache = new Map<string, string[]>()
    const linesOf = async (filePath: string) => {
      if (!cache.has(filePath)) {
        const { lines } = await handle.readFile(filePath)
        cache.set(filePath, lines)
      }
      return cache.get(filePath)!
    }

    const hits = []
    for (const hit of shown) {
      if (contextLines <= 0) {
        hits.push(hit)
        continue
      }
      const lines = await linesOf(hit.path)
      hits.push({
        ...hit,
        before: lines.slice(Math.max(0, hit.line - 1 - contextLines), hit.line - 1),
        after: lines.slice(hit.line, hit.line + contextLines),
      })
    }

    return { hits, total: filtered.length, truncated: filtered.length > shown.length }
  },

  render(result: any) {
    if (!result || !Array.isArray(result.hits)) return JSON.stringify(result)
    if (result.hits.length === 0) return 'No matches found.'
    const lines = [`Found ${result.total ?? result.hits.length} hit(s):`]
    for (const hit of result.hits) {
      if (typeof hit === 'string') {
        lines.push(hit)
      } else {
        if (Array.isArray(hit.before) && hit.before.length > 0) {
          lines.push(...hit.before.map((l: string, i: number) => `  ${hit.line - hit.before.length + i}: ${l}`))
        }
        lines.push(`${hit.path}:${hit.line}: ${hit.text}`)
        if (Array.isArray(hit.after) && hit.after.length > 0) {
          lines.push(...hit.after.map((l: string, i: number) => `  ${hit.line + 1 + i}: ${l}`))
        }
      }
    }
    if (result.truncated) {
      lines.push(`(truncated - ${result.total - result.hits.length} more hits)`)
    }
    return lines.join('\n')
  },
}
