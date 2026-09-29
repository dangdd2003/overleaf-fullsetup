import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLBadge from '@/shared/components/ol/ol-badge'

export function SettingsApprovalCard({
  toolName,
  args = {},
  onDecision,
  decided,
}: {
  toolName: string
  args: Record<string, unknown>
  onDecision: (decision: { accepted: boolean; note?: string }) => void
  decided?: 'accepted' | 'rejected'
}) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const locked = Boolean(decided)

  const entries = Object.entries(args).filter(([_, v]) => v !== undefined && v !== null)

  return (
    <div className="ai-assist-edit-approval ai-assist-settings-approval">
      <div className="ai-assist-edit-approval-header">
        <span className="ai-assist-edit-approval-prompt">
          {t('ai_assist_confirm_settings_title', 'Review proposed settings change:')}
        </span>
        <OLBadge bg="info" className="ms-2">
          {t('ai_assist_settings_badge', 'settings')}
        </OLBadge>
        {decided && (
          <span className={`ai-assist-edit-decision-badge is-${decided}`}>
            {decided === 'accepted' ? '✓ Accepted' : '✗ Rejected'}
          </span>
        )}
      </div>

      <div className="ai-assist-settings-list">
        <div className="ai-assist-settings-tool-name">{toolName}</div>
        {entries.length === 0 ? (
          <div>(no parameters)</div>
        ) : (
          entries.map(([key, val]) => (
            <div key={key} className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">{key}:</span>
              <span className="ai-assist-settings-value">{String(val)}</span>
            </div>
          ))
        )}
      </div>

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
