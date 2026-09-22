import { AgentTool } from './registry'
import {
  cleanLineNumbers,
  cleanOldText,
  cleanLineNumberPrefixes,
  countOccurrences,
  findFuzzyUniqueAnchor,
  findFuzzyWordWindow,
  findMatchingLines,
  formatAmbiguousOccurrences,
  locateAnchorInText,
  nearestLines,
  normalizeLines,
} from '../latex-matcher'

// Re-export matching utilities for external callers and backwards compatibility
export {
  cleanLineNumbers,
  cleanOldText,
  cleanLineNumberPrefixes,
  countOccurrences,
  findFuzzyUniqueAnchor,
  findFuzzyWordWindow,
  findMatchingLines,
  formatAmbiguousOccurrences,
  locateAnchorInText,
  nearestLines,
}

/**
 * The 1-based line of the last uncommented `\end{document}`, or null. Text
 * appended to the end of such a file lands after it, where LaTeX never reads
 * it. Mirrors `endDocumentLine` in AiAssistTools.mjs.
 */
export function endDocumentLine(docText: string): number | null {
  const lines = String(docText || '').split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const code = lines[index].replace(/(^|[^\\])%.*$/, '$1')
    if (code.includes('\\end{document}')) return index + 1
  }
  return null
}

/**
 * What the model reads when the user rejects an edit. States the outcome as a
 * fact first — nothing was applied — so the model cannot go on to describe the
 * change as made.
 */
export function rejectedMessage(path: string, note?: string): string {
  const reason = note ? ` Their reason: "${note}".` : ''
  return `REJECTED: the user declined this edit, so it was NOT applied and ${path} is unchanged.${reason} Do not send the same change again, and never describe it as done: say what you proposed and that it was not applied.`
}

export const editFileTool: AgentTool = {
  // The loop must wait for the user's decision before continuing.
  suspends: true,
  mutates: true,
  spec: {
    name: 'edit_file',
    description:
      'Edit a project file. Replace oldText with newText. Pass oldText: "" to append newText to the end of the file. Pass newText: "" to delete oldText. The user reviews the change as a diff and may reject it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        oldText: {
          type: 'string',
          description:
            'The exact text to replace, unique within the file. Pass an empty string "" to append newText to the end of the file. Pass full file content if replacing the entire file.',
        },
        newText: {
          type: 'string',
          description:
            'The replacement text (or text to append if oldText is empty). Pass an empty string "" to delete oldText.',
        },
        startLine: {
          type: 'number',
          description:
            'Optional 1-based start line to constrain anchor search for ambiguous or repetitive LaTeX blocks.',
        },
        endLine: {
          type: 'number',
          description:
            'Optional 1-based end line to constrain anchor search for ambiguous or repetitive LaTeX blocks.',
        },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },

  async execute({ path, oldText, newText, startLine, endLine }, handle) {
    if (typeof newText !== 'string') {
      return { error: 'Parameter \'newText\' must be a string containing the replacement or appended text (pass "" to delete).' }
    }

    if (typeof oldText !== 'string') {
      return {
        error: `Parameter 'oldText' is required to replace text in ${path}. Provide the exact snippet from the file to replace, or pass "" to append to the end of the file.`,
      }
    }

    const files = await handle.listFiles()
    const file = files.find(candidate => candidate.path === path)
    if (!file) return { error: `File not found: ${path}` }
    if (file.type === 'binary') {
      return { error: `${path} is a binary file and cannot be edited.` }
    }

    // Determine if oldText had line number prefixes stripped
    const strippedOld = cleanLineNumbers(oldText)
    const oldTextWasStripped = strippedOld !== oldText && strippedOld.length > 0

    // Sanitize newText to prevent raw line-number prefix contamination
    const sanitizedNewText = cleanLineNumberPrefixes(newText, oldTextWasStripped)

    // Append mode: when oldText is explicitly empty string ""
    const isAppend = oldText.length === 0
    if (isAppend) {
      const current = await handle.readFile(path)
      const endLine = endDocumentLine(current.lines.join('\n'))
      if (endLine) {
        return {
          error: `Appending to ${path} would put the text after \\end{document} on line ${endLine}, where LaTeX ignores it. Insert it where it belongs instead: give an oldText anchor from the passage it follows.`,
        }
      }
      const outcome = await handle.proposeEdit({ path, oldText: '', newText: sanitizedNewText })
      switch (outcome.status) {
        case 'applied':
          return {
            status: 'applied',
            message: `Appended the change to ${path}.`,
            startLine: (outcome as any).startLine,
          }
        case 'rejected': {
          return {
            status: 'rejected',
            note: outcome.note,
            message: rejectedMessage(path, outcome.note),
          }
        }
        case 'drifted':
          return {
            status: 'drifted',
            message: `${path} changed while the user was reviewing. Re-read it before trying again.`,
          }
        case 'timeout':
          return {
            status: 'timeout',
            message:
              outcome.message ||
              `The editor bridge timed out while attempting to edit ${path}. The editor may be busy or unmounted. Please retry.`,
          }
        case 'error':
          return {
            status: 'error',
            message:
              outcome.message ||
              `An error occurred while communicating with the editor for ${path}.`,
          }
        default:
          return outcome
      }
    }

    const { lines } = await handle.readFile(path)
    const fullDocText = lines.join('\n')

    // Apply optional line scoping if startLine / endLine provided
    let searchDocText = fullDocText
    let lineOffset = 0
    if (typeof startLine === 'number' && startLine >= 1) {
      const startIdx = startLine - 1
      const anchorLineCount = oldText.split('\n').length
      // If endLine is omitted, prefer a tight local window around startLine first
      const windowRadius = Math.max(2, anchorLineCount + 1)
      const localEndIdx = typeof endLine === 'number' && endLine >= startLine ? endLine : Math.min(lines.length, startIdx + windowRadius)
      const localSearchText = lines.slice(startIdx, localEndIdx).join('\n')
      const localMatch = locateAnchorInText(localSearchText, oldText)

      if (localMatch) {
        searchDocText = localSearchText
        lineOffset = startIdx
      } else {
        const endIdx = typeof endLine === 'number' && endLine >= startLine ? endLine : lines.length
        searchDocText = lines.slice(startIdx, endIdx).join('\n')
        lineOffset = startIdx
      }
    }

    const match = locateAnchorInText(searchDocText, oldText)
    const cleanedOld = cleanOldText(oldText)
    let targetAnchor = match ? match.anchor : (countOccurrences(searchDocText, cleanedOld) > 0 ? cleanedOld : oldText)
    let matches = countOccurrences(searchDocText, targetAnchor)

    if (!match && matches === 0) {
      const candidateLines = findMatchingLines(fullDocText, oldText)
      const hints = nearestLines(fullDocText, oldText)
      let candidateHint = ''
      if (candidateLines.length > 0) {
        candidateHint = ` (Found similar line around line(s) ${candidateLines.join(', ')}). Use read_file to inspect the file around those lines.`
      } else if (hints.length > 0) {
        candidateHint = ` The closest lines in ${path} right now are:\n${hints
          .map(h => `${h.line}: ${h.text}`)
          .join('\n')}\nCopy the anchor from those exact lines (without line-number prefixes), or call read_file on ${path} first.`
      } else {
        candidateHint = ` Use read_file to inspect ${path} and copy the exact lines to replace.`
      }

      return {
        status: 'noMatch',
        message: `That text did not appear in ${path}.${candidateHint}`,
      }
    }

    if (matches > 1) {
      const candidateLines = findMatchingLines(searchDocText, targetAnchor).map(l => l + lineOffset)
      const lineList = candidateLines.length > 0 ? ` (around line(s) ${candidateLines.join(', ')})` : ''
      const contextPreviews = candidateLines.length > 0
        ? `:\n${formatAmbiguousOccurrences(fullDocText, candidateLines)}\n\nTo disambiguate, include more context (surrounding lines) in oldText, or pass startLine to target a specific line (e.g. startLine: ${candidateLines[0]}).`
        : '. Include more context (surrounding lines) or use startLine/endLine to disambiguate.'
      return {
        status: 'ambiguous',
        matches,
        message: `That text appears ${matches} times in ${path}${lineList}${contextPreviews}`,
      }
    }

    const outcome = await handle.proposeEdit({
      path,
      oldText: targetAnchor,
      newText: sanitizedNewText,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    })

    switch (outcome.status) {
      case 'applied':
        return {
          status: 'applied',
          message: `Applied the change to ${path}.`,
          startLine: (outcome as any).startLine,
        }
      case 'rejected': {
        return {
          status: 'rejected',
          note: outcome.note,
          message: rejectedMessage(path, outcome.note),
        }
      }
      case 'drifted':
        return {
          status: 'drifted',
          message: `${path} changed while the user was reviewing. Re-read it before trying again.`,
        }
      case 'timeout':
        return {
          status: 'timeout',
          message:
            outcome.message ||
            `The editor bridge timed out while attempting to edit ${path}. The editor may be busy or unmounted. Please retry.`,
        }
      case 'error':
        return {
          status: 'error',
          message:
            outcome.message ||
            `An error occurred while communicating with the editor for ${path}.`,
        }
      default:
        return outcome
    }
  },

  render(result: any) {
    if (!result) return JSON.stringify(result)
    if (result.error) return `Error: ${result.error}`
    if (result.status === 'applied') {
      return result.message || `Applied change to file.`
    }
    if (result.status === 'rejected') {
      return result.message || `The user rejected this change.`
    }
    if (result.status === 'noMatch') {
      return result.message || 'That text did not appear in the file.'
    }
    if (result.status === 'ambiguous') {
      return result.message || 'That text appears multiple times in the file.'
    }
    return JSON.stringify(result)
  },
}
