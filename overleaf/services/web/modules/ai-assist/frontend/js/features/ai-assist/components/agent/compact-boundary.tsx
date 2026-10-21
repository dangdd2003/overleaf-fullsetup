import { FC, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive } from '@phosphor-icons/react'
import { CompactEntry } from '../../agent/agent-messages'
import {
  formatTokenCount,
  renderCompactLedger,
} from '../../agent/context/compaction'
import { MarkdownContent } from './markdown-content'
import type { CompactingState } from '../../agent/agent-state'

/** The status line while compacting: "Compacting conversation… (summarizing 2/3)". */
export function compactStatusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  compacting: CompactingState
): string {
  const phase = (() => {
    switch (compacting.phase) {
      case 'masking':
        return t('ai_assist_compact_phase_masking', 'preparing')
      case 'summarizing':
        return t('ai_assist_compact_phase_summarizing', 'summarizing')
      case 'verifying':
        return t('ai_assist_compact_phase_verifying', 'checking')
      case 'repairing':
        return t('ai_assist_compact_phase_repairing', 'repairing')
    }
  })()
  const chunk =
    compacting.chunks && compacting.chunks > 1 && compacting.chunk
      ? ` ${compacting.chunk}/${compacting.chunks}`
      : ''
  return t('ai_assist_compacting_status', {
    phase: `${phase}${chunk}`,
    defaultValue: `Compacting conversation… (${phase}${chunk})`,
  })
}

/**
 * The row a `/compact` leaves in the transcript. Collapsed it is one line of
 * numbers; expanded it shows the summary and the ledger the model resumes
 * from. Uses the thinking block's disclosure so the two read alike.
 */
export const CompactBoundary: FC<{ entry: CompactEntry }> = ({ entry }) => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const retained = Math.round(entry.retention.score * 100)
  const ledgerText = useMemo(
    () => (expanded ? renderCompactLedger(entry.ledger) : ''),
    [expanded, entry.ledger]
  )

  const parts = [
    t('ai_assist_compact_title', 'Conversation compacted'),
    t('ai_assist_compact_tokens', {
      before: formatTokenCount(entry.preTokens),
      after: formatTokenCount(entry.postTokens),
      defaultValue: `${formatTokenCount(entry.preTokens)} → ${formatTokenCount(entry.postTokens)} tokens`,
    }),
    t('ai_assist_compact_retained', {
      percent: retained,
      defaultValue: `${retained}% retained`,
    }),
  ]
  if (entry.trigger === 'auto') {
    parts.push(t('ai_assist_compact_badge_auto', 'auto'))
  }
  if (entry.fallback) {
    parts.push(t('ai_assist_compact_badge_fallback', 'fallback'))
  }
  const title = parts.join(' · ')

  return (
    <div className="ai-assist-thinking-block ai-assist-compact-boundary">
      <button
        type="button"
        className="ai-assist-thinking-header"
        aria-expanded={expanded}
        onClick={() => setExpanded(prev => !prev)}
      >
        <span className="ai-assist-thinking-icon" aria-hidden="true">
          <Archive size={14} />
        </span>
        <span className="ai-assist-thinking-title">{title}</span>
        <svg
          className={`ai-assist-thinking-chevron ${expanded ? 'is-expanded' : ''}`}
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 4 10 8 6 12" />
        </svg>
      </button>
      {expanded && (
        <div className="ai-assist-thinking-body is-expanded">
          <div className="ai-assist-thinking-content ai-assist-compact-content">
            <MarkdownContent content={entry.summary} />
            {ledgerText && <MarkdownContent content={ledgerText} />}
          </div>
        </div>
      )}
    </div>
  )
}
