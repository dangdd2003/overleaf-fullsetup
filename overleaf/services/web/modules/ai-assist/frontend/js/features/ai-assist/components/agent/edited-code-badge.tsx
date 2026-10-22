import { FC, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Code } from '@phosphor-icons/react'
import { diffLines } from 'diff'
import { ToolCallRecord, TranscriptEntry, blocksForEntry } from '../../agent/agent-messages'
import { DiffStats, editTextsOf, sumDiffStats } from './diff-stats'
import { DiffStatBadge } from './diff-stat-badge'
import { useOpenFileInEditor } from '../../hooks/use-open-file'

/**
 * Extracts all edit_file and create_file tool calls from an assistant turn.
 */
export function getFileEditCalls(
  entry: Extract<TranscriptEntry, { role: 'assistant' }>
): ToolCallRecord[] {
  const calls: ToolCallRecord[] = []
  const seenIds = new Set<string>()

  const candidateCalls = [
    ...(entry.toolCalls ?? []),
    ...blocksForEntry(entry)
      .filter((b): b is Extract<typeof b, { type: 'tool_call' }> => b.type === 'tool_call')
      .map(b => b.call),
  ]

  for (const call of candidateCalls) {
    if (!call || seenIds.has(call.id)) continue
    if (call.name === 'edit_file' || call.name === 'create_file') {
      seenIds.add(call.id)
      calls.push(call)
    }
  }

  return calls
}

function toArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export type EditedCodeBadgeProps = {
  entry: Extract<TranscriptEntry, { role: 'assistant' }>
  toolCalls?: ToolCallRecord[]
}

export const EditedCodeBadge: FC<EditedCodeBadgeProps> = ({
  entry,
  toolCalls,
}) => {
  const { t } = useTranslation()
  const openFile = useOpenFileInEditor()

  const calls = useMemo(() => {
    return toolCalls && toolCalls.length > 0
      ? toolCalls.filter(c => c.name === 'edit_file' || c.name === 'create_file')
      : getFileEditCalls(entry)
  }, [toolCalls, entry])

  // Extract affected file paths
  const paths = useMemo(() => {
    const list: string[] = []
    for (const call of calls) {
      const args = toArgs(call.args)
      const p = args.path ?? args.filePath ?? args.file
      if (typeof p === 'string' && p.trim() && !list.includes(p.trim())) {
        list.push(p.trim())
      }
    }
    return list
  }, [calls])

  // Compute diff stats (+added -removed)
  const stats: DiffStats | null = useMemo(() => {
    const calculated = sumDiffStats(calls)
    if (calculated && (calculated.added > 0 || calculated.removed > 0)) {
      return calculated
    }

    // Fallback: estimate from args if call result doesn't have 'applied' status
    let added = 0
    let removed = 0
    let hasDiff = false

    for (const call of calls) {
      const { oldText, newText } = editTextsOf(call)

      if (oldText || newText) {
        try {
          const changes = diffLines(
            oldText ? `${oldText}\n` : '',
            newText ? `${newText}\n` : ''
          )
          for (const change of changes) {
            if (change.added) added += change.count ?? 0
            if (change.removed) removed += change.count ?? 0
          }
          hasDiff = true
        } catch {}
      }
    }

    return hasDiff && (added > 0 || removed > 0) ? { added, removed } : calculated
  }, [calls])

  const primaryCall = calls[0]
  const primaryPath = paths[0] || ''
  const primaryArgs = toArgs(primaryCall?.args)
  const primaryResult = toArgs(primaryCall?.result)
  const rawStartLine = primaryArgs.startLine ?? primaryResult.startLine
  const startLine =
    typeof rawStartLine === 'number' && rawStartLine > 0 ? rawStartLine : 1

  // Format file label: "main.tex" or "main.tex, intro.tex" or "3 files"
  const fileLabel =
    paths.length === 1
      ? paths[0]
      : paths.length === 2
        ? `${paths[0]}, ${paths[1]}`
        : paths.length > 2
          ? `${paths.length} files`
          : ''

  const handleClick = useCallback(() => {
    if (primaryPath) {
      openFile(primaryPath, startLine)
    }

    window.dispatchEvent(new CustomEvent('aiAssist:stickToBottom'))
  }, [primaryPath, startLine, openFile])

  if (calls.length === 0) return null

  return (
    <button
      type="button"
      className="ai-assist-edited-code-badge"
      onClick={handleClick}
      title={t('ai_assist_view_edited_code', {
        file: fileLabel || 'code',
        defaultValue: `View edited code in ${fileLabel || 'editor'}`,
      })}
      aria-label={t('ai_assist_view_edited_code', {
        file: fileLabel || 'code',
        defaultValue: `View edited code in ${fileLabel || 'editor'}`,
      })}
    >
      <Code size={13} className="ai-assist-edited-code-icon" aria-hidden="true" />
      <span className="ai-assist-edited-code-title">
        {t('ai_assist_edited_code', 'Edited code')}
      </span>
      {stats && (stats.added > 0 || stats.removed > 0) && (
        <DiffStatBadge stats={stats} />
      )}
      {fileLabel && (
        <span className="ai-assist-edited-code-file">in {fileLabel}</span>
      )}
    </button>
  )
}
