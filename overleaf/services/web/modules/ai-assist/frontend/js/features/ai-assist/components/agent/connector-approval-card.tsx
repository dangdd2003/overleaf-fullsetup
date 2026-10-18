import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLBadge from '@/shared/components/ol/ol-badge'
import { PlugsConnected } from '@phosphor-icons/react'

export function ConnectorApprovalCard({
  connectorName,
  toolName,
  toolTitle,
  args = {},
  onDecision,
  decided,
}: {
  connectorName: string
  toolName: string
  toolTitle?: string
  args?: Record<string, unknown>
  onDecision: (decision: {
    accepted: boolean
    always?: boolean
    note?: string
  }) => void
  decided?: 'accepted' | 'rejected'
}) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const locked = Boolean(decided)

  const entries = Object.entries(args).filter(
    ([_, v]) => v !== undefined && v !== null
  )

  const displayTitle = toolTitle || toolName.replace(/^mcp__[a-zA-Z0-9_-]+__/, '')

  return (
    <div className="ai-assist-edit-approval ai-assist-connector-approval">
      <div className="ai-assist-edit-approval-header">
        <span className="ai-assist-edit-approval-prompt">
          <PlugsConnected size={16} className="me-1 inline-block align-middle" />
          {t('ai_assist_confirm_connector_title', 'External tool request:')}
        </span>
        <OLBadge bg="primary" className="ms-2">
          {connectorName}
        </OLBadge>
        {decided && (
          <span className={`ai-assist-edit-decision-badge is-${decided}`}>
            {decided === 'accepted' ? '✓ Allowed' : '✗ Denied'}
          </span>
        )}
      </div>

      <div className="ai-assist-settings-list">
        <div className="ai-assist-settings-tool-name fw-bold">{displayTitle}</div>
        {entries.length === 0 ? (
          <div className="text-muted small">(no parameters)</div>
        ) : (
          entries.map(([key, val]) => (
            <div key={key} className="ai-assist-settings-row">
              <span className="ai-assist-settings-key">{key}:</span>
              <span className="ai-assist-settings-value font-monospace">
                {typeof val === 'object' ? JSON.stringify(val) : String(val)}
              </span>
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

      <div className="ai-assist-edit-approval-actions d-flex gap-2 justify-content-end mt-2">
        <OLButton
          type="button"
          variant="secondary"
          size="sm"
          disabled={locked}
          onClick={() =>
            onDecision({ accepted: false, note: note || undefined })
          }
        >
          {t('deny', 'Deny')}
        </OLButton>
        <OLButton
          type="button"
          variant="secondary"
          size="sm"
          disabled={locked}
          onClick={() => onDecision({ accepted: true, always: false })}
        >
          {t('allow_once', 'Allow once')}
        </OLButton>
        <OLButton
          type="button"
          variant="primary"
          size="sm"
          disabled={locked}
          onClick={() => onDecision({ accepted: true, always: true })}
        >
          {t('always_allow', 'Always allow')}
        </OLButton>
      </div>
    </div>
  )
}
