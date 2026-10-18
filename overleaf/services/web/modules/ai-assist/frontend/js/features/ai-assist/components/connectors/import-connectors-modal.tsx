import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
  OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import Notification from '@/shared/components/notification'
import { ImportResult } from '../../connectors/types'
import {
  connectorErrorMessage,
  importConnectors,
  notifyConnectorsChanged,
} from '../../connectors/api'

const PLACEHOLDER = `{
  "mcpServers": {
    "bigquery": {
      "httpUrl": "https://bigquery.googleapis.com/mcp",
      "authProviderType": "google_credentials",
      "oauth": { "scopes": ["https://www.googleapis.com/auth/bigquery"] }
    },
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp" }
  }
}`

export function ImportConnectorsModal({
  show,
  onHide,
}: {
  show: boolean
  onHide: () => void
}) {
  const { t } = useTranslation()

  const [config, setConfig] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const handleImport = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await importConnectors(config)
      setResult(res)
      notifyConnectorsChanged()
    } catch (err) {
      setError(
        connectorErrorMessage(
          err,
          t('connector_import_failed', 'Could not import the configuration')
        )
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <OLModal
      show={show}
      onHide={onHide}
      size="lg"
      className="connector-import-modal"
    >
      <OLModalHeader closeButton>
        <OLModalTitle id="connector-import-modal-title">
          {t('import_connectors', 'Import connectors')}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error ? (
          <div className="mb-3">
            <Notification type="error" content={error} />
          </div>
        ) : null}
        {result ? (
          <div className="mb-3 d-flex flex-column gap-2">
            {result.created.length ? (
              <Notification
                type="success"
                content={t('connector_import_added', 'Added __names__.', {
                  names: result.created.map(c => c.connector.name).join(', '),
                })}
              />
            ) : null}
            {result.created.some(c => c.next === 'authorize') ? (
              <Notification
                type="info"
                content={t(
                  'connector_import_sign_in',
                  'Sign in from the connector card: __names__.',
                  {
                    names: result.created
                      .filter(c => c.next === 'authorize')
                      .map(c => c.connector.name)
                      .join(', '),
                  }
                )}
              />
            ) : null}
            {result.skipped.map((s, i) => (
              <Notification
                key={i}
                type="warning"
                content={`${s.name}: ${s.reason}`}
              />
            ))}
          </div>
        ) : null}
        <OLFormGroup>
          <OLFormLabel htmlFor="connectors-import-config">
            {t('connector_mcp_configuration', 'MCP configuration (JSON)')}
          </OLFormLabel>
          <p className="small text-muted">
            {t(
              'connector_import_help',
              'Paste the mcpServers section of Gemini CLI’s settings.json, Claude Code’s .mcp.json, Claude Desktop, Cursor or VS Code. Remote servers are added with their headers, OAuth client, timeout and tool filters; Google servers (authProviderType: google_credentials) sign in with Google.'
            )}
          </p>
          <OLFormControl
            id="connectors-import-config"
            as="textarea"
            rows={12}
            className="font-monospace small"
            placeholder={PLACEHOLDER}
            value={config}
            onChange={e => setConfig(e.target.value)}
          />
        </OLFormGroup>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={saving}>
          {result ? t('close', 'Close') : t('cancel', 'Cancel')}
        </OLButton>
        <OLButton
          variant="primary"
          onClick={handleImport}
          disabled={!config.trim()}
          isLoading={saving}
          loadingLabel={t('connector_importing', 'Importing...')}
        >
          {t('import', 'Import')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
