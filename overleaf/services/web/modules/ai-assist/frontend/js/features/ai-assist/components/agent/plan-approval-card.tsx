import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLBadge from '@/shared/components/ol/ol-badge'
import { AgentMode } from '../../agent/agent-mode'
import { MarkdownContent } from './markdown-content'

export function PlanApprovalCard({
  plan,
  onDecision,
  decided,
}: {
  plan: string
  onDecision: (decision: { accepted: boolean; note?: string; nextMode?: AgentMode }) => void
  decided?: 'accepted' | 'rejected'
}) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)
  const locked = Boolean(decided)

  return (
    <div className="ai-assist-edit-approval ai-assist-plan-approval">
      <div className="ai-assist-edit-approval-header">
        <span className="ai-assist-edit-approval-prompt">
          {t('ai_assist_plan_approval_title', 'Proposed Implementation Plan')}
        </span>
        <OLBadge bg="primary" className="ms-2">
          {t('ai_assist_plan_badge', 'plan')}
        </OLBadge>
        {decided && (
          <span className={`ai-assist-edit-decision-badge is-${decided}`}>
            {decided === 'accepted' ? '✓ Approved' : '✗ Feedback Sent'}
          </span>
        )}
      </div>

      <div className="ai-assist-plan-body">
        <MarkdownContent content={plan} />
      </div>

      {showFeedback && (
        <div className="my-2">
          <OLFormControl
            as="textarea"
            rows={3}
            size="sm"
            value={note}
            disabled={locked}
            placeholder={t(
              'ai_assist_plan_feedback_placeholder',
              'What should be adjusted in this plan?'
            )}
            onChange={e => setNote(e.target.value)}
          />
          <div className="d-flex justify-content-end gap-1 mt-1">
            <OLButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowFeedback(false)}
            >
              {t('cancel', 'Cancel')}
            </OLButton>
            <OLButton
              type="button"
              variant="danger"
              size="sm"
              disabled={locked || !note.trim()}
              onClick={() => onDecision({ accepted: false, note: note.trim() })}
            >
              {t('send_feedback', 'Send feedback')}
            </OLButton>
          </div>
        </div>
      )}

      {!showFeedback && (
        <div className="ai-assist-plan-approval-actions d-flex flex-wrap gap-1 mt-2">
          <OLButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={locked}
            onClick={() => setShowFeedback(true)}
          >
            {t('ai_assist_plan_keep_planning', 'No, keep planning')}
          </OLButton>
          <OLButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={locked}
            onClick={() => onDecision({ accepted: true, nextMode: 'manual' })}
          >
            {t('ai_assist_plan_manual_edits', 'Yes, manually approve edits')}
          </OLButton>
          <OLButton
            type="button"
            variant="primary"
            size="sm"
            disabled={locked}
            onClick={() => onDecision({ accepted: true, nextMode: 'acceptEdits' })}
          >
            {t('ai_assist_plan_auto_edits', 'Yes, auto-accept edits')}
          </OLButton>
        </div>
      )}
    </div>
  )
}
