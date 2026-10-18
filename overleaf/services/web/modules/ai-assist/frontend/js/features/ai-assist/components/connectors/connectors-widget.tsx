import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { PlugsConnected } from '@phosphor-icons/react'
import OLButton from '@/shared/components/ol/ol-button'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import LinkingStatus from '@/features/settings/components/linking/status'
import Notification from '@/shared/components/notification'
import { ConnectorCard } from './connector-card'
import { ConnectorModal } from './connector-modal'
import { ToolPermissionsModal } from './tool-permissions-modal'
import { ImportConnectorsModal } from './import-connectors-modal'
import { ConnectorsMeta, ConnectorView } from '../../connectors/types'
import {
  CONNECTORS_CHANGED_EVENT,
  connectorErrorMessage,
  isConnectorsEnabled,
  listConnectors,
} from '../../connectors/api'
import { OAUTH_CHANNEL, OAUTH_STORAGE_KEY } from '../../connectors/oauth-popup'

export default function ConnectorsWidget() {
  const { t } = useTranslation()
  const enabled = isConnectorsEnabled()

  const [connectors, setConnectors] = useState<ConnectorView[]>([])
  const [meta, setMeta] = useState<ConnectorsMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [modalConnector, setModalConnector] = useState<{
    open: boolean
    connector: ConnectorView | null
  }>({
    open: false,
    connector: null,
  })

  const [importing, setImporting] = useState(false)

  const [configuringToolsConnector, setConfiguringToolsConnector] =
    useState<ConnectorView | null>(null)

  const fetchConnectors = useCallback(async () => {
    try {
      const res = await listConnectors()
      setConnectors(res.connectors || [])
      setMeta(res.meta || null)
      setError(null)
    } catch (err) {
      setError(
        connectorErrorMessage(
          err,
          t('connectors_load_failed', 'Failed to load connectors')
        )
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (!enabled) return
    fetchConnectors()

    const handleChanged = () => {
      fetchConnectors()
    }
    window.addEventListener(CONNECTORS_CHANGED_EVENT, handleChanged)

    // A sign-in that finishes after its window stopped being watched (closed
    // early, or cut off by the server's opener policy) still shows up here
    const channel =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(OAUTH_CHANNEL)
        : null
    if (channel) channel.onmessage = handleChanged
    const handleStorage = (event: StorageEvent) => {
      if (event.key === OAUTH_STORAGE_KEY) handleChanged()
    }
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(CONNECTORS_CHANGED_EVENT, handleChanged)
      window.removeEventListener('storage', handleStorage)
      channel?.close()
    }
  }, [enabled, fetchConnectors])

  const handleSaved = useCallback(() => {
    fetchConnectors()
  }, [fetchConnectors])

  if (!enabled) return null

  const activeCount = connectors.filter(
    c => c.enabled && c.status === 'connected'
  ).length
  const totalCount = connectors.length

  return (
    <div
      className="settings-widget-container connectors-widget"
      data-testid="connectors-settings"
    >
      <div className="linking-icon-fixed-position">
        <PlugsConnected size={40} aria-hidden="true" />
      </div>

      <div className="description-container">
        <div className="title-row">
          <h4 id="ai-connectors">{t('connectors', 'Connectors')}</h4>
        </div>
        <p className="small">
          {t(
            'connectors_description',
            'Connect external resources and documentation tools via remote Model Context Protocol (MCP) servers.'
          )}
        </p>

        <div className="connectors-status">
          {totalCount === 0 ? (
            <span className="small linking-ai-assist-secondary-text">
              {t('connectors_not_configured', 'Not configured')}
            </span>
          ) : activeCount > 0 ? (
            <LinkingStatus
              status="success"
              description={t(
                'connectors_active_summary',
                '__active__ of __total__ active',
                { active: activeCount, total: totalCount }
              )}
            />
          ) : (
            <span className="small linking-ai-assist-secondary-text">
              {t(
                'connectors_none_active',
                'No active connectors (__total__ configured)',
                { total: totalCount }
              )}
            </span>
          )}
        </div>

        {error ? (
          <div className="mt-2">
            <Notification
              type="error"
              isDismissible
              onDismiss={() => setError(null)}
              content={error}
              action={
                <OLButton
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={fetchConnectors}
                >
                  {t('connector_try_again', 'Try again')}
                </OLButton>
              }
            />
          </div>
        ) : null}
      </div>

      <div className="connectors-widget-actions">
        <OLButton
          variant="secondary"
          type="button"
          onClick={() => setImporting(true)}
        >
          {t('import', 'Import')}
        </OLButton>
        <OLButton
          variant="primary"
          type="button"
          onClick={() => setModalConnector({ open: true, connector: null })}
        >
          {t('add_custom_connector', 'Add custom connector')}
        </OLButton>
      </div>

      <div className="connectors-widget-body">
        {loading && connectors.length === 0 ? (
          <div className="connectors-loading" role="status">
            <OLSpinner size="sm" />
            <span className="small">
              {t('loading_connectors', 'Loading connectors...')}
            </span>
          </div>
        ) : null}

        {connectors.length === 0 && !loading && !error ? (
          <div className="connectors-empty" data-testid="connectors-empty">
            <p className="small mb-0">
              {t(
                'connectors_empty_description',
                'No connectors configured. Add a remote MCP server to give the assistant access to external tools and documentation.'
              )}
            </p>
          </div>
        ) : null}

        {connectors.length > 0 ? (
          <ul
            className="connectors-card-list"
            aria-label={t('connectors', 'Connectors')}
          >
            {connectors.map(connector => (
              <li key={connector.id}>
                <ConnectorCard
                  connector={connector}
                  onEdit={() => setModalConnector({ open: true, connector })}
                  onConfigureTools={() =>
                    setConfiguringToolsConnector(connector)
                  }
                  onRefresh={fetchConnectors}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {importing ? (
        <ImportConnectorsModal
          show={importing}
          onHide={() => setImporting(false)}
        />
      ) : null}

      {modalConnector.open ? (
        <ConnectorModal
          show={modalConnector.open}
          onHide={() => setModalConnector({ open: false, connector: null })}
          connector={modalConnector.connector}
          onSaved={handleSaved}
          meta={meta}
        />
      ) : null}

      {configuringToolsConnector ? (
        <ToolPermissionsModal
          show={Boolean(configuringToolsConnector)}
          onHide={() => setConfiguringToolsConnector(null)}
          connector={configuringToolsConnector}
          onSaved={fetchConnectors}
        />
      ) : null}
    </div>
  )
}
