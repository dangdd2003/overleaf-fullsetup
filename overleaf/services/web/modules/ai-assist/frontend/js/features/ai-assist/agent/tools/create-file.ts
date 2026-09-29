import { AgentTool } from './registry'

const BINARY_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.eps',
  '.zip',
  '.gz',
  '.ttf',
  '.otf',
]

/** Returns an error message, or null when the path is acceptable. */
export function validateNewPath(path: string, existing: string[]): string | null {
  if (!path || !path.trim()) return 'A path is required.'
  if (path.startsWith('/')) {
    return 'The path must be relative to the project root, not absolute.'
  }
  if (path.split('/').includes('..')) {
    return 'The path must not contain "..".'
  }
  if (existing.includes(path)) {
    return `${path} already exists. To edit ${path}, call read_file to inspect it, then call edit_file with oldText containing the exact lines to replace and newText containing the replacement.`
  }
  if (BINARY_EXTENSIONS.some(extension => path.toLowerCase().endsWith(extension))) {
    return `${path} looks like a binary file, which this tool cannot create.`
  }
  return null
}

export const createFileTool: AgentTool = {
  // The user reviews the new file before it is added.
  suspends: true,
  mutates: true,
  spec: {
    name: 'create_file',
    description:
      'Create a new text file in the project. The path must not already exist. The user reviews the new file before it is added, and may reject it. Not for editing — edit_file does that.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root, e.g. sections/new.tex',
        },
        content: { type: 'string', description: 'The full contents of the new file' },
      },
      required: ['path', 'content'],
    },
  },

  async execute({ path, content }, handle) {
    if (typeof content !== 'string' || content.length === 0) {
      return { error: 'content must be the full text of the new file.' }
    }

    const files = await handle.listFiles()
    const problem = validateNewPath(path, files.map(file => file.path))
    if (problem) return { error: problem }

    const outcome = await handle.createFile({ path, content })

    switch (outcome.status) {
      case 'applied':
        return {
          status: 'applied',
          message: `Created ${path}.`,
          startLine: (outcome as any).startLine ?? 1,
        }
      case 'rejected': {
        const userNote = outcome.note ? ` with note: "${outcome.note}"` : ''
        return {
          status: 'rejected',
          note: outcome.note,
          message: `The user rejected creating ${path}${userNote}. Do not attempt to create the same file again in this turn. Acknowledge the rejection, address their feedback, and explain alternatives or ask how they would like to proceed.`,
        }
      }
      case 'timeout':
        return {
          status: 'timeout',
          message:
            outcome.message ||
            `The editor bridge timed out while creating ${path}. Please retry.`,
        }
      case 'error':
        return {
          status: 'error',
          message:
            outcome.message ||
            `An error occurred while creating ${path}.`,
        }
      default:
        return outcome
    }
  },
}
