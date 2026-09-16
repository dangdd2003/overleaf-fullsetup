import { AgentTool } from './registry'
import { matchesGlob } from './search-text'

const MAX_FILE_ROWS = 400

export const listFilesTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'list_files',
    description:
      'List the files in the project with their type and line count. Pass glob to narrow the listing, for example sections/*.tex. Answered from a prebuilt index, so it is far cheaper than reading files.',
    parameters: {
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description: 'Pattern to narrow the listing, e.g. sections/*.tex',
        },
      },
      required: [],
    },
  },

  async execute({ glob }: { glob?: string } = {}, handle) {
    const files = await handle.listFiles()
    const listed = glob
      ? files.filter(file => matchesGlob(file.path, glob))
      : files
    const shown = listed.slice(0, MAX_FILE_ROWS)
    return {
      files: shown,
      total: listed.length,
      truncated: listed.length > shown.length,
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    if (result.files) {
      const rows = result.files.map(
        (file: any) =>
          `${file.path}  ${file.type}  ${file.lines ?? Math.round(file.size / 1024) + ' KB'}`
      )
      if (result.truncated) {
        rows.push(`(${result.total - result.files.length} more; narrow with glob=)`)
      }
      return rows.length > 0 ? rows.join('\n') : '(no files found)'
    }

    return JSON.stringify(result)
  },
}
