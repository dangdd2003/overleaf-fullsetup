import { diffLines } from 'diff'
import { ToolCallRecord } from '../../agent/agent-messages'

export type DiffStats = { added: number; removed: number }

/**
 * jsdiff's line tokenizer keeps a trailing partial line (one with no `\n`) as
 * its own token, so a final line that's identical between old and new but
 * only terminated in one of them is counted as both removed and added
 * instead of unchanged. Forcing both sides to end in `\n` avoids that.
 */
function withTrailingNewline(text: unknown): string {
  const str = typeof text === 'string' ? text : String(text ?? '')
  if (str === '' || str.endsWith('\n')) return str
  return `${str}\n`
}

/**
 * Line-level added/removed counts for a single edit_file or create_file call,
 * or null when the call isn't a successful file write (still running, failed,
 * rejected, or a different tool entirely).
 */
function toArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The old and new text a file-edit call carries, under any of its argument names. */
export function editTextsOf(call: ToolCallRecord): {
  oldText: string
  newText: string
} {
  const args = toArgs(call.args)
  const oldVal = args.oldText ?? args.old_text ?? args.old_string
  const newVal = args.newText ?? args.new_text ?? args.new_string
  const contentVal = args.content
  return {
    oldText:
      call.name === 'create_file'
        ? ''
        : typeof oldVal === 'string'
          ? oldVal
          : '',
    newText:
      call.name === 'create_file'
        ? typeof contentVal === 'string'
          ? contentVal
          : ''
        : typeof newVal === 'string'
          ? newVal
          : '',
  }
}

export function diffStatsForCall(call: ToolCallRecord): DiffStats | null {
  if (!call || !call.name) return null
  if (call.name !== 'edit_file' && call.name !== 'create_file') return null
  if (!('result' in call) || call.isError) return null

  const result = call.result as { status?: string } | undefined
  if (result?.status !== 'applied') return null

  const { oldText, newText } = editTextsOf(call)

  try {
    const changes = diffLines(
      withTrailingNewline(oldText),
      withTrailingNewline(newText)
    )
    let added = 0
    let removed = 0
    for (const change of changes) {
      const lineCount = change.count ?? 0
      if (change.added) added += lineCount
      if (change.removed) removed += lineCount
    }
    return { added, removed }
  } catch {
    return { added: 0, removed: 0 }
  }
}

export function sumDiffStats(calls: ToolCallRecord[]): DiffStats | null {
  if (!Array.isArray(calls)) return null
  let added = 0
  let removed = 0
  let any = false

  for (const call of calls) {
    if (!call) continue
    const stats = diffStatsForCall(call)
    if (!stats) continue
    any = true
    added += stats.added
    removed += stats.removed
  }

  return any ? { added, removed } : null
}
