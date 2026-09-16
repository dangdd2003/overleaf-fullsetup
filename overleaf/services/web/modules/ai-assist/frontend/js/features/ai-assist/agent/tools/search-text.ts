import { AgentTool } from './registry'
import { MAX_SEARCH_HITS } from '../project-handle'

const SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * Minimal glob matching: `*` stops at a slash, `**` crosses them.
 *
 * Deliberately not a dependency. The agent only ever needs `sections/*.tex`
 * shaped patterns, and a full glob library is a lot of bundle for that.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const source = pattern
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
    const all = await handle.search(query, { caseSensitive, regexp })
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
}
