import type { CompileOutcome } from './project-handle'

/**
 * LaTeX can log errors and still write a PDF (non-stop mode). That is not a
 * failure to the user, who can read the PDF, and it is not a clean build
 * either, so it gets its own status, the same word the MCP tools use.
 */
export function withPdfStatus<T extends CompileOutcome>(
  outcome: T,
  pdfProduced: boolean
): T {
  if (pdfProduced && outcome.status === 'failure' && outcome.errors.length > 0) {
    return { ...outcome, status: 'success_with_errors' }
  }
  return outcome
}
