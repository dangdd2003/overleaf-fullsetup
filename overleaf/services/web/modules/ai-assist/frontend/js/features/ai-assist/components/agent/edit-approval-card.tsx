import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLBadge from '@/shared/components/ol/ol-badge'
import { EditRequest } from '../../agent/project-handle'
import { useOpenFileInEditor } from '../../hooks/use-open-file'
import DiffView from './diff-view'

export function EditApprovalCard({
  edit,
  onDecision,
  decided,
  startLine = 1,
}: {
  edit: EditRequest
  onDecision: (decision: { accepted: boolean; note?: string }) => void
  decided?: 'accepted' | 'rejected'
  startLine?: number
}) {
  const { t } = useTranslation()
  const openFile = useOpenFileInEditor()
  const [note, setNote] = useState('')
  const locked = Boolean(decided)

  const raw = (edit || {}) as any
  const path = typeof raw.path === 'string' ? raw.path : ''
  const oldText =
    typeof raw.oldText === 'string'
      ? raw.oldText
      : typeof raw.old_text === 'string'
      ? raw.old_text
      : typeof raw.old_string === 'string'
      ? raw.old_string
      : ''
  const newText =
    typeof raw.newText === 'string'
      ? raw.newText
      : typeof raw.new_text === 'string'
      ? raw.new_text
      : typeof raw.new_string === 'string'
      ? raw.new_string
      : typeof raw.content === 'string'
      ? raw.content
      : ''
  const isCreation = !oldText
  const safeStartLine =
    typeof startLine === 'number' && Number.isFinite(startLine) && startLine > 0
      ? startLine
      : 1

  const handleOpen = () => {
    if (path) {
      openFile(path, safeStartLine)
    }
  }

  return (
    <div className="ai-assist-edit-approval">
      <div className="ai-assist-edit-approval-header">
        <span className="ai-assist-edit-approval-prompt">
          {isCreation
            ? t('ai_assist_confirm_create_title', 'Review new file before adding:')
            : t('ai_assist_confirm_edit_title', 'Review proposed change before applying:')}
        </span>
        {decided && (
          <span className={`ai-assist-edit-decision-badge is-${decided}`}>
            {decided === 'accepted' ? '✓ Accepted' : '✗ Rejected'}
          </span>
        )}
      </div>

      <div className="ai-assist-edit-approval-path">
        <span
          role="button"
          tabIndex={0}
          className="ai-assist-file-link"
          title={t('ai_assist_open_file', {
            path,
            defaultValue: `Open ${path}`,
          })}
          onClick={handleOpen}
          onKeyDown={e => e.key === 'Enter' && handleOpen()}
        >
          {path}
        </span>
        {safeStartLine > 1 && (
          <span className="ai-assist-edit-approval-line">:{safeStartLine}</span>
        )}
        {isCreation && (
          <OLBadge bg="info" className="ms-2">
            {t('ai_assist_new_file_badge', 'new file')}
          </OLBadge>
        )}
      </div>

      <DiffView
        oldText={oldText}
        newText={newText}
        startLine={safeStartLine}
        onLineClick={line => {
          if (path) openFile(path, line)
        }}
      />

      <OLFormControl
        type="text"
        size="sm"
        value={note}
        disabled={locked}
        placeholder={t(
          'ai_assist_reject_note_placeholder',
          'Reason for rejection (optional — guides assistant what to do next)'
        )}
        onChange={event => setNote(event.target.value)}
      />

      <div className="ai-assist-edit-approval-actions">
        <OLButton
          type="button"
          variant="secondary"
          size="sm"
          disabled={locked}
          onClick={() => onDecision({ accepted: false, note: note || undefined })}
        >
          {t('reject', 'Reject')}
        </OLButton>
        <OLButton
          type="button"
          variant="primary"
          size="sm"
          disabled={locked}
          onClick={() => onDecision({ accepted: true })}
        >
          {t('accept', 'Accept')}
        </OLButton>
      </div>
    </div>
  )
}
