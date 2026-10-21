import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLFormSwitch from '@/shared/components/ol/ol-form-switch'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import {
  OLDropdown,
  OLDropdownDivider,
  OLDropdownItem,
  OLDropdownMenu,
  OLDropdownToggle,
} from '@/shared/components/ol/ol-dropdown-menu'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import MaterialIcon from '@/shared/components/material-icon'
import Notification from '@/shared/components/notification'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import { ConnectorStatus, ConnectorView } from '../../connectors/types'
import {
  connectorErrorMessage,
  disconnectConnector,
  notifyConnectorsChanged,
  refreshConnector,
  removeConnector,
  updateConnector,
} from '../../connectors/api'
import { connectWithPopup } from '../../connectors/oauth-popup'
import { TEST_RESULT_MS, useAutoDismiss } from '../../hooks/use-auto-dismiss'
import { SiteIcon, connectorIconUrl } from '../agent/site-icon'

export type ConnectorCardProps = {
  connector: ConnectorView
  onEdit: () => void
  onConfigureTools: () => void
  onRefresh: () => void
}

function StatusBadge({
  status,
  lastErrorMessage,
  connectorId,
}: {
  status: ConnectorStatus
  lastErrorMessage?: string | null
  connectorId: string
}) {
  const { t } = useTranslation()

  switch (status) {
    case 'connected':
      return (
        <OLBadge bg="success">
          {t('connector_status_connected', 'Connected')}
        </OLBadge>
      )
    case 'needs_auth':
      return (
        <OLBadge bg="warning">
          {t('connector_status_needs_sign_in', 'Needs sign-in')}
        </OLBadge>
      )
    case 'error':
      return (
        <OLTooltip
          id={`connector-error-badge-${connectorId}`}
          description={
            lastErrorMessage ||
            t('connector_status_connection_error', 'Connection error')
          }
        >
          <span>
            <OLBadge bg="danger">
              {t('connector_status_error', 'Error')}
            </OLBadge>
          </span>
        </OLTooltip>
      )
    case 'disconnected':
      return (
        <OLBadge bg="secondary">
          {t('connector_status_disconnected', 'Disconnected')}
        </OLBadge>
      )
    case 'pending':
    default:
      return (
        <OLBadge bg="info">{t('connector_status_pending', 'Pending')}</OLBadge>
      )
  }
}

/** Confirms before a connector is removed. Destructive, so the danger style. */
export function RemoveConnectorModal({
  show,
  name,
  removing,
  onConfirm,
  onHide,
}: {
  show: boolean
  name: string
  removing: boolean
  onConfirm: () => void
  onHide: () => void
}) {
  const { t } = useTranslation()

  return (
    <OLModal
      show={show}
      onHide={onHide}
      aria-labelledby="remove-connector-modal-title"
    >
      <OLModalHeader closeButton>
        <OLModalTitle id="remove-connector-modal-title">
          {t('remove_connector_title', 'Remove connector?')}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p>
          {t(
            'remove_connector_confirm',
            'Remove "__name__"? The assistant will no longer have access to its tools.',
            { name }
          )}
        </p>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={removing}>
          {t('cancel', 'Cancel')}
        </OLButton>
        <OLButton
          variant="danger"
          onClick={onConfirm}
          isLoading={removing}
          loadingLabel={t('connector_removing', 'Removing...')}
        >
          {t('remove', 'Remove')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}

function ConnectorCardAvatar({ connector }: { connector: ConnectorView }) {
  return (
    <span className="connector-card-avatar">
      <SiteIcon
        url={connector.url ?? ''}
        src={connectorIconUrl(connector)}
        className="connector-card-icon"
        fallback={<MaterialIcon type="extension" />}
      />
    </span>
  )
}

export function ConnectorCard({
  connector,
  onEdit,
  onConfigureTools,
  onRefresh,
}: ConnectorCardProps) {
  const { t } = useTranslation()

  const [isUpdating, setIsUpdating] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isAuthorizing, setIsAuthorizing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  // What the last action came to. A failure stays until something succeeds;
  // a success goes away by itself.
  const [result, setResult] = useState<{
    type: 'success' | 'warning' | 'error'
    text: string
  } | null>(null)

  // Set when the sign-in window closed before the sign-in finished. If the
  // connector connects later, the warning gives way to a success.
  const [signInPending, setSignInPending] = useState(false)

  useAutoDismiss(
    result?.type === 'success',
    () => setResult(null),
    TEST_RESULT_MS.success,
    result
  )

  const toolCount = connector.tools?.length || 0
  const isConnected = connector.status === 'connected'

  useEffect(() => {
    if (!signInPending || !isConnected) return
    setSignInPending(false)
    setResult({
      type: 'success',
      text: t('connector_signed_in', 'Signed in and connected.'),
    })
  }, [signInPending, isConnected, t])

  const toolsText = useCallback(
    (count: number) =>
      count === 1
        ? t('connector_one_tool_available', '1 tool available.')
        : t('connector_tools_available', '__count__ tools available.', {
            count,
          }),
    [t]
  )

  const handleToggleEnabled = useCallback(async () => {
    setIsUpdating(true)
    try {
      await updateConnector(connector.id, { enabled: !connector.enabled })
      setResult(null)
      notifyConnectorsChanged()
      onRefresh()
    } catch (err) {
      setResult({
        type: 'error',
        text: connectorErrorMessage(
          err,
          t('connector_update_failed', 'Failed to update connector status')
        ),
      })
    } finally {
      setIsUpdating(false)
    }
  }, [connector.id, connector.enabled, onRefresh, t])

  // Only after the server has asked for it: the user clicks Sign in, and the
  // popup opens from that click.
  const handleSignIn = useCallback(async () => {
    setIsAuthorizing(true)
    setSignInPending(false)
    try {
      const outcome = await connectWithPopup(connector.id)
      if (outcome.status === 'connected') {
        setResult({
          type: 'success',
          text: t('connector_signed_in', 'Signed in and connected.'),
        })
        notifyConnectorsChanged()
        onRefresh()
      } else if (outcome.status === 'error') {
        setResult({ type: 'error', text: outcome.error })
      } else {
        setSignInPending(true)
        setResult({
          type: 'warning',
          text: t(
            'connector_sign_in_not_completed',
            'Sign-in was not completed. Click Sign in to try again.'
          ),
        })
      }
    } catch (err) {
      setResult({
        type: 'error',
        text: connectorErrorMessage(
          err,
          t('connector_sign_in_failed', 'Sign-in failed')
        ),
      })
    } finally {
      setIsAuthorizing(false)
    }
  }, [connector.id, onRefresh, t])

  // Connect and Test connection both let the server decide: it connects
  // straight away when it takes no sign-in, and only says so when it does.
  const checkConnection = useCallback(
    async (kind: 'test' | 'connect') => {
      setIsRefreshing(true)
      setTesting(true)
      setSignInPending(false)
      try {
        const { connector: checked, next } = await refreshConnector(
          connector.id
        )
        const count = checked?.tools?.length ?? 0
        if (next === 'connected') {
          setResult({
            type: 'success',
            text: `${
              kind === 'test'
                ? t('connector_test_ok_prefix', 'Connection works.')
                : t('connector_connected_prefix', 'Connected.')
            } ${toolsText(count)}`,
          })
        } else if (next === 'authorize') {
          setResult({
            type: 'warning',
            text: t(
              'connector_requires_sign_in',
              'This server requires you to sign in. Click Sign in to continue.'
            ),
          })
        } else {
          setResult({
            type: 'error',
            text:
              checked?.lastError?.message ||
              t('connector_test_unreachable', 'Could not reach the server.'),
          })
        }
        notifyConnectorsChanged()
        onRefresh()
      } catch (err) {
        setResult({
          type: 'error',
          text: connectorErrorMessage(
            err,
            kind === 'test'
              ? t('connector_test_failed', 'Failed to test connector')
              : t('connector_reconnect_failed', 'Reconnection failed')
          ),
        })
      } finally {
        setIsRefreshing(false)
        setTesting(false)
      }
    },
    [connector.id, onRefresh, t, toolsText]
  )

  const handleDisconnect = useCallback(async () => {
    setIsUpdating(true)
    try {
      await disconnectConnector(connector.id)
      setResult(null)
      notifyConnectorsChanged()
      onRefresh()
    } catch (err) {
      setResult({
        type: 'error',
        text: connectorErrorMessage(
          err,
          t('connector_disconnect_failed', 'Failed to disconnect connector')
        ),
      })
    } finally {
      setIsUpdating(false)
    }
  }, [connector.id, onRefresh, t])

  const handleRemove = useCallback(async () => {
    setIsUpdating(true)
    try {
      await removeConnector(connector.id)
      setConfirmingRemove(false)
      notifyConnectorsChanged()
      onRefresh()
    } catch (err) {
      setResult({
        type: 'error',
        text: connectorErrorMessage(
          err,
          t('connector_remove_failed', 'Failed to remove connector')
        ),
      })
    } finally {
      setIsUpdating(false)
    }
  }, [connector.id, onRefresh, t])

  // The one primary action a connector needs right now, if any. Sign in only
  // shows once the server has said it needs one.
  const primaryAction =
    connector.status === 'needs_auth' ? (
      <OLButton
        variant="primary"
        size="sm"
        type="button"
        onClick={handleSignIn}
        isLoading={isAuthorizing}
        loadingLabel={t('connector_signing_in', 'Signing in...')}
        aria-label={t('connector_sign_in_named', 'Sign in to __name__', {
          name: connector.name,
        })}
      >
        {t('connector_sign_in', 'Sign in')}
      </OLButton>
    ) : connector.status === 'connected' ? null : (
      <OLButton
        variant="primary"
        size="sm"
        type="button"
        onClick={() => checkConnection('connect')}
        isLoading={isRefreshing}
        loadingLabel={t('connector_connecting', 'Connecting...')}
        aria-label={
          connector.status === 'error'
            ? t('connector_reconnect_named', 'Reconnect __name__', {
                name: connector.name,
              })
            : t('connector_connect_named', 'Connect __name__', {
                name: connector.name,
              })
        }
      >
        {connector.status === 'error'
          ? t('connector_reconnect', 'Reconnect')
          : t('connect', 'Connect')}
      </OLButton>
    )

  return (
    <div
      className="connector-card"
      data-testid={`connector-card-${connector.id}`}
    >
      <div className="connector-card-main">
        <ConnectorCardAvatar connector={connector} />

        <div className="connector-card-info">
          <div className="connector-card-name-row">
            <span className="connector-card-name">{connector.name}</span>
            <StatusBadge
              status={connector.status}
              lastErrorMessage={connector.lastError?.message}
              connectorId={connector.id}
            />
          </div>
          <span
            className="connector-card-url"
            title={connector.url}
            data-testid={`connector-url-${connector.id}`}
          >
            {connector.url}
          </span>
          <span className="connector-card-meta small">
            {testing ? (
              <span className="connector-card-testing" role="status">
                <OLSpinner size="sm" />
                {t('connector_testing', 'Testing connection…')}
              </span>
            ) : toolCount === 1
              ? t('connector_one_tool', '1 tool')
              : t('connector_tool_count', '__count__ tools', {
                  count: toolCount,
                })}
          </span>
        </div>

        <div className="connector-card-controls">
          {primaryAction}

          {isConnected ? (
            <OLButton
              variant="secondary"
              size="sm"
              type="button"
              onClick={onConfigureTools}
              aria-label={t(
                'connector_configure_tools_named',
                'Configure tools for __name__',
                {
                  name: connector.name,
                }
              )}
            >
              {t('connector_configure_tools', 'Configure tools')}
            </OLButton>
          ) : null}

          <OLFormSwitch
            id={`connector-toggle-${connector.id}`}
            label={t('connector_enable_named', 'Enable __name__', {
              name: connector.name,
            })}
            checked={connector.enabled}
            onChange={handleToggleEnabled}
            disabled={isUpdating}
            data-testid={`connector-toggle-${connector.id}`}
          />

          <OLDropdown align="end">
            <OLDropdownToggle
              id={`connector-menu-${connector.id}`}
              bsPrefix="connector-card-menu-toggle"
              aria-label={t(
                'connector_more_actions_named',
                'More actions for __name__',
                {
                  name: connector.name,
                }
              )}
            >
              <MaterialIcon type="more_vert" />
            </OLDropdownToggle>
            <OLDropdownMenu flip={false}>
              {isConnected ? (
                <li role="none">
                  <OLDropdownItem
                    as="button"
                    leadingIcon="sync"
                    onClick={() => checkConnection('test')}
                    disabled={isRefreshing}
                  >
                    {t('test_connection', 'Test connection')}
                  </OLDropdownItem>
                </li>
              ) : null}
              <li role="none">
                <OLDropdownItem as="button" leadingIcon="edit" onClick={onEdit}>
                  {t('edit', 'Edit')}
                </OLDropdownItem>
              </li>
              {isConnected ? (
                <li role="none">
                  <OLDropdownItem
                    as="button"
                    leadingIcon="link_off"
                    onClick={handleDisconnect}
                    disabled={isUpdating}
                  >
                    {t('disconnect', 'Disconnect')}
                  </OLDropdownItem>
                </li>
              ) : null}
              <OLDropdownDivider />
              <li role="none">
                <OLDropdownItem
                  as="button"
                  leadingIcon="delete"
                  variant="danger"
                  onClick={() => setConfirmingRemove(true)}
                  disabled={isUpdating}
                >
                  {t('remove', 'Remove')}
                </OLDropdownItem>
              </li>
            </OLDropdownMenu>
          </OLDropdown>
        </div>
      </div>

      {connector.status === 'error' &&
      connector.lastError?.message &&
      !result ? (
        <div className="connector-card-error">
          {connector.lastError.message}
        </div>
      ) : null}

      {result ? (
        <Notification type={result.type} content={result.text} />
      ) : null}

      <RemoveConnectorModal
        show={confirmingRemove}
        name={connector.name}
        removing={isUpdating}
        onConfirm={handleRemove}
        onHide={() => setConfirmingRemove(false)}
      />
    </div>
  )
}
