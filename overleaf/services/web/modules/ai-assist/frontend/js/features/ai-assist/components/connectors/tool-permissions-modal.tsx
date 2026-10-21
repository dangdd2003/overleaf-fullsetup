import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
  OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import MaterialIcon from '@/shared/components/material-icon'
import Notification from '@/shared/components/notification'
import {
  ConnectorTool,
  ConnectorView,
  ToolPermission,
} from '../../connectors/types'
import {
  connectorErrorMessage,
  notifyConnectorsChanged,
  refreshConnector,
  updateConnector,
} from '../../connectors/api'

export type ToolPermissionsModalProps = {
  show: boolean
  onHide: () => void
  connector: ConnectorView
  onSaved: (connector: ConnectorView) => void
}

export function ToolPermissionsModal({
  show,
  onHide,
  connector,
  onSaved,
}: ToolPermissionsModalProps) {
  const { t } = useTranslation()

  const [tools, setTools] = useState<ConnectorTool[]>(
    () => connector.tools || []
  )
  const [permissions, setPermissions] = useState<
    Record<string, ToolPermission>
  >(() => {
    const initial: Record<string, ToolPermission> = {}
    for (const tool of connector.tools || []) {
      initial[tool.name] = tool.permission || 'ask'
    }
    return initial
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handlePermissionChange = useCallback(
    (toolName: string, permission: ToolPermission) => {
      setPermissions(prev => ({
        ...prev,
        [toolName]: permission,
      }))
    },
    []
  )

  const handleSetAllToAsk = useCallback(() => {
    setPermissions(prev => {
      const next: Record<string, ToolPermission> = { ...prev }
      for (const tool of tools) {
        next[tool.name] = 'ask'
      }
      return next
    })
  }, [tools])

  const handleAllowAllReadOnly = useCallback(() => {
    setPermissions(prev => {
      const next: Record<string, ToolPermission> = { ...prev }
      for (const tool of tools) {
        if (tool.readOnly) {
          next[tool.name] = 'allow'
        }
      }
      return next
    })
  }, [tools])

  const handleRefreshTools = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await refreshConnector(connector.id)
      const refreshedTools = res.connector.tools || []
      setTools(refreshedTools)
      setPermissions(prev => {
        const next = { ...prev }
        for (const tool of refreshedTools) {
          if (!next[tool.name]) {
            next[tool.name] = tool.permission || 'ask'
          }
        }
        return next
      })
      notifyConnectorsChanged()
    } catch (err) {
      setError(
        connectorErrorMessage(
          err,
          t('connector_refresh_tools_failed', 'Failed to refresh tools')
        )
      )
    } finally {
      setRefreshing(false)
    }
  }, [connector.id, t])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await updateConnector(connector.id, {
        toolPermissions: permissions,
      })
      notifyConnectorsChanged()
      onSaved(res.connector)
      onHide()
    } catch (err) {
      setError(
        connectorErrorMessage(
          err,
          t(
            'connector_save_permissions_failed',
            'Failed to save tool permissions'
          )
        )
      )
    } finally {
      setSaving(false)
    }
  }, [connector.id, permissions, onSaved, onHide, t])

  const filteredTools = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return tools
    return tools.filter(
      tool =>
        tool.name.toLowerCase().includes(q) ||
        (tool.title && tool.title.toLowerCase().includes(q)) ||
        (tool.description && tool.description.toLowerCase().includes(q))
    )
  }, [tools, searchQuery])

  const readOnlyTools = useMemo(
    () => filteredTools.filter(t => t.readOnly),
    [filteredTools]
  )

  const writeTools = useMemo(
    () => filteredTools.filter(t => !t.readOnly),
    [filteredTools]
  )

  return (
    <OLModal
      show={show}
      onHide={onHide}
      size="lg"
      className="tool-permissions-modal"
    >
      <OLModalHeader closeButton>
        <OLModalTitle id="tool-permissions-modal-title">
          {t('connector_configure_tools_title', 'Configure tools - __name__', {
            name: connector.name,
          })}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p className="small text-muted mb-3">
          {t(
            'connector_tools_help',
            'Control how each tool exposed by this connector is executed by the AI assistant. Tools set to “Needs approval” will ask for confirmation before running.'
          )}
        </p>

        {error ? (
          <div className="mb-3">
            <Notification
              type="error"
              isDismissible
              onDismiss={() => setError(null)}
              content={error}
            />
          </div>
        ) : null}

        {tools.length > 0 ? (
          <>
            <div className="tool-permissions-toolbar">
              <div className="tool-permissions-search">
                <OLFormControl
                  size="sm"
                  type="text"
                  placeholder={t('connector_filter_tools', 'Filter tools...')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  prepend={<MaterialIcon type="search" />}
                  aria-label={t('connector_filter_tools_label', 'Filter tools')}
                />
              </div>
              <div className="tool-permissions-batch-actions">
                <OLButton
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={handleSetAllToAsk}
                >
                  {t('connector_set_all_ask', 'Set all to Needs approval')}
                </OLButton>
                <OLButton
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={handleAllowAllReadOnly}
                >
                  {t('connector_allow_all_read_only', 'Allow all read-only')}
                </OLButton>
                <OLButton
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={handleRefreshTools}
                  isLoading={refreshing}
                  loadingLabel={t('connector_refreshing', 'Refreshing...')}
                >
                  {t('refresh', 'Refresh')}
                </OLButton>
              </div>
            </div>

            {filteredTools.length === 0 ? (
              <div className="tool-permissions-empty small text-muted">
                {t('connector_no_tools_match', 'No tools match “__query__”.', {
                  query: searchQuery,
                })}
              </div>
            ) : null}

            {readOnlyTools.length > 0 ? (
              <div className="tool-permissions-group">
                <div className="tool-permissions-group-title">
                  {t(
                    'connector_read_only_group',
                    'Read-only tools (__count__)',
                    {
                      count: readOnlyTools.length,
                    }
                  )}
                </div>
                <ul className="tool-permissions-list">
                  {readOnlyTools.map(tool => (
                    <ToolRow
                      key={tool.name}
                      tool={tool}
                      permission={permissions[tool.name] || 'ask'}
                      onChange={p => handlePermissionChange(tool.name, p)}
                    />
                  ))}
                </ul>
              </div>
            ) : null}

            {writeTools.length > 0 ? (
              <div className="tool-permissions-group">
                <div className="tool-permissions-group-title">
                  {t(
                    'connector_write_group',
                    'Write / Action tools (__count__)',
                    {
                      count: writeTools.length,
                    }
                  )}
                </div>
                <ul className="tool-permissions-list">
                  {writeTools.map(tool => (
                    <ToolRow
                      key={tool.name}
                      tool={tool}
                      permission={permissions[tool.name] || 'ask'}
                      onChange={p => handlePermissionChange(tool.name, p)}
                    />
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <div className="tool-permissions-empty">
            <p className="small text-muted mb-3">
              {t(
                'connector_no_tools_discovered',
                'No tools discovered for this connector yet. Try testing or refreshing the connector to fetch available tools.'
              )}
            </p>
            <OLButton
              variant="secondary"
              size="sm"
              onClick={handleRefreshTools}
              isLoading={refreshing}
              loadingLabel={t(
                'connector_refreshing_tools',
                'Refreshing tools...'
              )}
            >
              {t('connector_discover_tools', 'Discover tools now')}
            </OLButton>
          </div>
        )}
      </OLModalBody>
      <OLModalFooter>
        <OLButton
          variant="secondary"
          onClick={onHide}
          disabled={saving}
          type="button"
        >
          {t('cancel', 'Cancel')}
        </OLButton>
        <OLButton
          variant="primary"
          onClick={handleSave}
          disabled={tools.length === 0}
          isLoading={saving}
          loadingLabel={t('connector_saving', 'Saving...')}
          type="button"
        >
          {t('connector_save_permissions', 'Save permissions')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}

function ToolRow({
  tool,
  permission,
  onChange,
}: {
  tool: ConnectorTool
  permission: ToolPermission
  onChange: (permission: ToolPermission) => void
}) {
  const { t } = useTranslation()

  return (
    <li className="tool-permissions-row" data-testid={`tool-row-${tool.name}`}>
      <div className="tool-permissions-details">
        <div className="tool-permissions-name-row">
          <span className="tool-permissions-name">{tool.name}</span>
          {tool.title && tool.title !== tool.name ? (
            <span className="tool-permissions-title">({tool.title})</span>
          ) : null}
          {tool.readOnly ? (
            <OLBadge bg="info">
              {t('connector_tool_read_only', 'Read-only')}
            </OLBadge>
          ) : (
            <OLBadge bg="warning">{t('connector_tool_write', 'Write')}</OLBadge>
          )}
          {tool.destructive ? (
            <OLBadge bg="danger">
              {t('connector_tool_destructive', 'Destructive')}
            </OLBadge>
          ) : null}
          {tool.openWorld ? (
            <OLBadge bg="light" text="dark">
              {t('connector_tool_open_world', 'Open world')}
            </OLBadge>
          ) : null}
        </div>
        {tool.description ? (
          <p className="tool-permissions-desc">{tool.description}</p>
        ) : null}
      </div>
      <div className="tool-permissions-control">
        <OLFormSelect
          size="sm"
          value={permission}
          onChange={e => onChange(e.target.value as ToolPermission)}
          aria-label={t('connector_permission_for', 'Permission for __name__', {
            name: tool.name,
          })}
        >
          <option value="allow">
            {t('connector_permission_allow', 'Always allow')}
          </option>
          <option value="ask">
            {t('connector_permission_ask', 'Needs approval')}
          </option>
          <option value="block">
            {t('connector_permission_block', 'Blocked')}
          </option>
        </OLFormSelect>
      </div>
    </li>
  )
}
