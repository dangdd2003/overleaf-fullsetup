import { AgentTool } from './registry'

function normalizeLines(str: string): string {
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function cleanLineNumbers(text: string): string {
  return text.replace(/^\s*\d+[:|]\s?/gm, '')
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)
  let count = 0
  let index = normH.indexOf(normN)
  while (index !== -1) {
    count += 1
    index = normH.indexOf(normN, index + normN.length)
  }
  if (count > 0) return count

  // Fallback: trimmed lines (ignore trailing whitespace differences)
  const trimH = normH
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const trimN = normN
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  index = trimH.indexOf(trimN)
  while (index !== -1) {
    count += 1
    index = trimH.indexOf(trimN, index + trimN.length)
  }
  return count
}

export function findFuzzyUniqueAnchor(haystack: string, needle: string): string | null {
  if (!needle) return null
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)

  // 1. Try stripped line numbers
  const stripped = cleanLineNumbers(normN)
  if (stripped && stripped !== normN) {
    const strippedOccurrences = countOccurrences(normH, stripped)
    if (strippedOccurrences === 1) {
      return stripped
    }
  }

  // 2. Line-by-line trimmed matching against haystack lines
  const hLines = normH.split('\n')
  const nLines = (stripped || normN).split('\n')

  while (nLines.length > 1 && nLines[nLines.length - 1].trim() === '') {
    nLines.pop()
  }

  const trimmedN = nLines.map(l => l.trim())
  if (trimmedN.length === 0 || trimmedN.every(l => l === '')) return null

  const matchIndices: number[] = []

  for (let i = 0; i <= hLines.length - trimmedN.length; i++) {
    let matches = true
    for (let j = 0; j < trimmedN.length; j++) {
      if (hLines[i + j].trim() !== trimmedN[j]) {
        matches = false
        break
      }
    }
    if (matches) {
      matchIndices.push(i)
    }
  }

  if (matchIndices.length === 1) {
    const startIdx = matchIndices[0]
    return hLines.slice(startIdx, startIdx + trimmedN.length).join('\n')
  }

  return null
}

export const editFileTool: AgentTool = {
  // The loop must wait for the user's decision before continuing.
  suspends: true,
  mutates: true,
  spec: {
    name: 'edit_file',
    description:
      'Edit a project file. Replace oldText with newText, or leave oldText empty ("") to append newText to the end of the file. The user reviews the change as a diff and may reject it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        oldText: {
          type: 'string',
          description:
            'The exact text to replace, unique within the file. Pass an empty string "" to append newText to the end of the file.',
        },
        newText: { type: 'string', description: 'The replacement text (or text to append if oldText is empty)' },
      },
      required: ['path', 'newText'],
    },
  },

  async execute({ path, oldText, newText }, handle) {
    if (typeof newText !== 'string') {
      return { error: 'newText must be a string containing the replacement or appended text.' }
    }

    const files = await handle.listFiles()
    const file = files.find(candidate => candidate.path === path)
    if (!file) return { error: `File not found: ${path}` }
    if (file.type === 'binary') {
      return { error: `${path} is a binary file and cannot be edited.` }
    }

    // Append mode: when oldText is empty or omitted
    const isAppend = typeof oldText !== 'string' || oldText.length === 0
    if (isAppend) {
      const outcome = await handle.proposeEdit({ path, oldText: '', newText })
      switch (outcome.status) {
        case 'applied':
          return {
            status: 'applied',
            message: `Appended the change to ${path}.`,
            startLine: (outcome as any).startLine,
          }
        case 'rejected': {
          const userNote = outcome.note ? ` with note: "${outcome.note}"` : ''
          return {
            status: 'rejected',
            note: outcome.note,
            message: `The user rejected this change${userNote}. Do not attempt the same change again in this turn. Acknowledge the rejection, address their feedback, and explain an alternative approach or ask how they would like to proceed.`,
          }
        }
        case 'drifted':
          return {
            status: 'drifted',
            message: `${path} changed while the user was reviewing. Re-read it before trying again.`,
          }
        default:
          return outcome
      }
    }

    const { lines } = await handle.readFile(path)
    const docText = lines.join('\n')

    let targetAnchor = oldText
    let matches = countOccurrences(docText, targetAnchor)

    if (matches === 0) {
      const fuzzyAnchor = findFuzzyUniqueAnchor(docText, targetAnchor)
      if (fuzzyAnchor) {
        targetAnchor = fuzzyAnchor
        matches = 1
      }
    }

    if (matches === 0) {
      return {
        status: 'noMatch',
        message: `That text did not appear in ${path}. If you want to append content to the end of ${path}, call edit_file with oldText: "" and newText with your content. If replacing existing text, copy an existing anchor line that already appears in ${path}.`,
      }
    }
    if (matches > 1) {
      return {
        status: 'ambiguous',
        matches,
        message: `That text appears ${matches} times in ${path}. Include more context so the anchor is unique.`,
      }
    }

    const outcome = await handle.proposeEdit({ path, oldText: targetAnchor, newText })

    switch (outcome.status) {
      case 'applied':
        return {
          status: 'applied',
          message: `Applied the change to ${path}.`,
          startLine: (outcome as any).startLine,
        }
      case 'rejected': {
        const userNote = outcome.note ? ` with note: "${outcome.note}"` : ''
        return {
          status: 'rejected',
          note: outcome.note,
          message: `The user rejected this change${userNote}. Do not attempt the same change again in this turn. Acknowledge the rejection, address their feedback, and explain an alternative approach or ask how they would like to proceed.`,
        }
      }
      case 'drifted':
        return {
          status: 'drifted',
          message: `${path} changed while the user was reviewing. Re-read it before trying again.`,
        }
      default:
        return outcome
    }
  },
}
