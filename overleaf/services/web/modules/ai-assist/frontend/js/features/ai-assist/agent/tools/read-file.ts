import { AgentTool } from './registry'
import { MAX_READ_LINES } from '../project-handle'

function number(lines: string[], offset: number) {
  return lines.map((line, index) => `${offset + index}: ${line}`).join('\n')
}

export const readFileTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'read_file',
    description:
      'Read one text file, or a line range of one, as numbered lines. Get the range from get_outline or search_text first rather than guessing it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        from: { type: 'number', description: 'First line, 1-indexed' },
        to: { type: 'number', description: 'Last line, inclusive' },
      },
      required: ['path'],
    },
  },
  async execute(
    {
      path,
      from,
      to,
    }: {
      path: string
      from?: number
      to?: number
    },
    handle
  ) {
    const files = await handle.listFiles()
    const file = files.find(candidate => candidate.path === path)

    if (!file) return { error: `File not found: ${path}` }
    if (file.type === 'binary') {
      return { error: `${path} is a binary file and cannot be read as text.` }
    }

    // Read the whole file so the total is honest. It is already in the
    // browser's project snapshot, so this costs nothing extra.
    const { lines } = await handle.readFile(path)
    const totalLines = lines.length

    const start = Math.max(1, from ?? 1)
    const requestedEnd = Math.min(to ?? totalLines, totalLines)
    const capped = lines.slice(start - 1, requestedEnd).slice(0, MAX_READ_LINES)
    const end = start + capped.length - 1

    const nextRange =
      end < totalLines
        ? { from: end + 1, to: Math.min(end + MAX_READ_LINES, totalLines) }
        : undefined

    return {
      path,
      from: start,
      to: end,
      totalLines,
      content: number(capped, start),
      truncated: Boolean(nextRange),
      ...(nextRange ? { nextRange } : {}),
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    const header = `${result.path} lines ${result.from}-${result.to} of ${result.totalLines}`
    const footer = result.nextRange
      ? `\n(truncated - call read_file with from=${result.nextRange.from}, to=${result.nextRange.to} for the rest)`
      : ''

    return [header, '```', result.content, '```'].join('\n') + footer
  },
}
