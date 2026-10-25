import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLBadge from '@/shared/components/ol/ol-badge'
import MaterialIcon from '@/shared/components/material-icon'
import Notification from '@/shared/components/notification'
import { connectWithPopup } from '../../connectors/oauth-popup'
import { ConnectorDecision } from './connector-approval-card'

export function ConnectorAuthCard({
  connectorId,
  connectorName,
  toolName,
  onDecision,
  decided,
}: {
  connectorId: string
  connectorName: string
  toolName?: string
  onDecision: (decision: ConnectorDecision) => void
  decided?: 'accepted' | 'rejected'
}) {
  const { t } = useTranslation()
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const locked = Boolean(decided)

  const handleConnect = async () => {
    setConnecting(true)
    setError(null)
    setNotice(null)
    try {
      const outcome = await connectWithPopup(connectorId)
      if (outcome.status === 'connected') {
        onDecision({ accepted: true })
      } else if (outcome.status === 'error') {
        setError(outcome.error || 'Authorization failed')
      } else {
        setNotice(
          t(
            'connector_sign_in_not_completed',
            'Sign-in was not completed. Click Connect to try again.'
          )
        )
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : undefined
      setError(message || 'Failed to start authorization')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="ai-assist-edit-approval ai-assist-connector-auth">
      <div className="ai-assist-edit-approval-header">
        <span className="ai-assist-edit-approval-prompt">
          {t('ai_assist_auth_connector_title', 'Authentication required:')}
        </span>
        <OLBadge bg="warning" className="ms-1">
          {connectorName}
        </OLBadge>
        {decided && (
          <OLBadge
            bg={decided === 'accepted' ? 'success' : 'danger'}
            className="ai-assist-edit-decision-badge"
            prepend={
              <MaterialIcon type={decided === 'accepted' ? 'check' : 'close'} />
            }
          >
            {decided === 'accepted'
              ? t('ai_assist_auth_decision_authenticated', 'Authenticated')
              : t('ai_assist_auth_decision_cancelled', 'Cancelled')}
          </OLBadge>
        )}
      </div>

      <p className="ai-assist-connector-auth-desc">
        {t(
          'ai_assist_auth_connector_desc',
          'This external MCP tool requires authorization before the assistant can use it.'
        )}
      </p>
      {toolName ? (
        <div className="ai-assist-settings-list">
          <div className="ai-assist-settings-row">
            <span className="ai-assist-settings-key">Tool:</span>
            <span className="ai-assist-settings-value">{toolName}</span>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mb-2">
          <Notification type="error" content={error} />
        </div>
      ) : null}

      {notice ? (
        <div className="mb-2">
          <Notification type="warning" content={notice} />
        </div>
      ) : null}

      <div className="ai-assist-edit-approval-actions mt-2">
        <OLButton
          type="button"
          variant="secondary"
          size="sm"
          disabled={locked || connecting}
          onClick={() =>
            onDecision({
              accepted: false,
              note: 'User cancelled authentication',
            })
          }
        >
          {t('cancel', 'Cancel')}
        </OLButton>
        <OLButton
          type="button"
          variant="primary"
          size="sm"
          leadingIcon="link"
          disabled={locked || connecting}
          onClick={handleConnect}
        >
          {connecting
            ? t('connecting', 'Connecting…')
            : t('connect_to_server', `Connect to ${connectorName}`)}
        </OLButton>
      </div>
    </div>
  )
}
