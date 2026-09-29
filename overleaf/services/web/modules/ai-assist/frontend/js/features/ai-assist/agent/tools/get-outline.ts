import { AgentTool } from './registry'
import { matchSection } from '../context/project-index'

export const getOutlineTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'get_outline',
    description:
      "The section tree with each section's file and line range, plus the \\input graph. Pass section to get one subtree. Use this before read_file to find where something lives — it costs a fraction of reading the file.",
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Return only this section and its subsections',
        },
      },
      required: [],
    },
  },

  async execute({ section }: { section?: string } = {}, handle) {
    const index = await handle.index()

    if (!section) {
      return {
        documentClass: index.outline.documentClass,
        sections: index.outline.sections,
        includes: index.outline.includes,
        notes: index.outline.notes,
      }
    }

    const match = matchSection(index.outline, section)
    if (match.kind === 'none') {
      return {
        error: `No section matches "${section}".`,
        candidates: index.outline.sections.map(s => s.title),
      }
    }
    if (match.kind === 'ambiguous') {
      return {
        error: `"${section}" matches more than one section. Pick one.`,
        candidates: match.candidates.map(c => ({
          title: c.title,
          path: c.path,
          line: c.line,
        })),
      }
    }
    const target = match.section
    const siblings = index.outline.sections
    const startIndex = siblings.indexOf(target)
    const nextPeer = siblings
      .slice(startIndex + 1)
      .find(candidate => candidate.level <= target.level)
    const nextPeerInFile = siblings
      .slice(startIndex + 1)
      .find(
        candidate =>
          candidate.path === target.path && candidate.level <= target.level
      )
    // Bound to file line count if no next peer in file
    let fileLines: number | undefined
    try {
      const fileEntry = (await handle.listFiles()).find(f => f.path === target.path)
      fileLines = fileEntry?.lines
    } catch {
      // ignore
    }

    const end = nextPeerInFile
      ? nextPeerInFile.line - 1
      : fileLines

    const nextIndex = nextPeer ? siblings.indexOf(nextPeer) : siblings.length
    const hint = end !== undefined
      ? `read_file with path=${target.path} from=${target.line} to=${end} for the body`
      : `read_file with path=${target.path} from=${target.line} for the body`

    return {
      range: { from: target.line, ...(end !== undefined ? { to: end } : {}) },
      sections: siblings.slice(startIndex, nextIndex),
      hint,
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    if (result.sections && result.range) {
      return [
        `section lines ${result.range.from}-${result.range.to}`,
        ...result.sections.map(
          (s: any) => `${'  '.repeat(s.level + 1)}${s.path}:${s.line} ${s.title}`
        ),
        result.hint ?? '',
      ]
        .filter(Boolean)
        .join('\n')
    }

    if (result.sections) {
      return [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        ...result.sections.map(
          (s: any) => `${'  '.repeat(s.level + 1)}${s.path}:${s.line} ${s.title}`
        ),
        ...result.includes.map(
          (i: any) =>
            `\\input ${i.from}:${i.line} -> ${i.to}${i.resolved ? '' : ' (UNRESOLVED)'}`
        ),
        ...result.notes,
      ].join('\n')
    }

    return JSON.stringify(result)
  },
}
