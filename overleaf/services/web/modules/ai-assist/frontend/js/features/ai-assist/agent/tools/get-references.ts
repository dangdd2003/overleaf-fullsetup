import { AgentTool } from './registry'

export const getReferencesTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'get_references',
    description:
      'Every \\label, \\ref and \\cite in the project with its file, line and whether it resolves, plus any duplicated labels. Pass kind to narrow, or unresolvedOnly to see just what is broken.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['labels', 'refs', 'citations', 'all'],
          description: 'Which kind to return. Defaults to all.',
        },
        unresolvedOnly: {
          type: 'boolean',
          description: 'Return only refs and citations that do not resolve',
        },
      },
      required: [],
    },
  },

  async execute(
    {
      kind = 'all',
      unresolvedOnly = false,
    }: {
      kind?: 'labels' | 'refs' | 'citations' | 'all'
      unresolvedOnly?: boolean
    } = {},
    handle
  ) {
    const index = await handle.index()
    const refs = index.references
    const pick = {
      labels: { labels: refs.labels, duplicateLabels: refs.duplicateLabels },
      refs: { refs: refs.refs },
      citations: { citations: refs.citations, bibKeys: refs.bibKeys },
      all: refs,
    }[kind] ?? refs

    if (!unresolvedOnly) return pick

    const filterUnresolved = (uses: any[]) =>
      uses.filter(use => !use.resolved)
    return {
      ...('refs' in pick ? { refs: filterUnresolved(pick.refs as any[]) } : {}),
      ...('citations' in pick
        ? { citations: filterUnresolved(pick.citations as any[]) }
        : {}),
      ...('labels' in pick
        ? { labels: pick.labels, duplicateLabels: pick.duplicateLabels }
        : {}),
      ...('bibKeys' in pick ? { bibKeys: pick.bibKeys } : {}),
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    const lines: string[] = []
    if (result.labels) {
      lines.push(...result.labels.map((l: any) => `label ${l.key}  ${l.path}:${l.line}`))
      lines.push(...(result.duplicateLabels ?? []).map((k: string) => `DUPLICATE label ${k}`))
    }
    if (result.refs) {
      lines.push(
        ...result.refs.map(
          (r: any) => `${r.command} ${r.key}  ${r.path}:${r.line}  ${r.resolved ? 'ok' : 'UNRESOLVED'}`
        )
      )
    }
    if (result.citations) {
      lines.push(
        ...result.citations.map(
          (c: any) => `${c.command} ${c.key}  ${c.path}:${c.line}  ${c.resolved ? 'ok' : 'MISSING'}`
        )
      )
    }
    if (result.bibKeys) {
      lines.push(...result.bibKeys.map((b: any) => `bib ${b.key}  ${b.path}:${b.line}`))
    }
    return lines.length > 0
      ? lines.join('\n')
      : '(no labels, references, or citations found in project)'
  },
}
