import React, { useState, useEffect, useCallback } from 'react'
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
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import MaterialIcon from '@/shared/components/material-icon'
import Notification from '@/shared/components/notification'
import {
  ConnectNext,
  ConnectorAuthMode,
  ConnectorInput,
  ConnectorsMeta,
  ConnectorTransport,
  ConnectorView,
  OAuthClientMode,
  ProbeResult,
  TokenEndpointAuthMethod,
} from '../../connectors/types'
import {
  connectorErrorMessage,
  createConnector,
  notifyConnectorsChanged,
  probeConnector,
  updateConnector,
} from '../../connectors/api'
import { connectWithPopup } from '../../connectors/oauth-popup'
import { TEST_RESULT_MS, useAutoDismiss } from '../../hooks/use-auto-dismiss'

export function isSensitiveHeaderKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false
  return /^(proxy-)?authorization$|api-?key|token|secret|bearer|password/i.test(
    key.trim()
  )
}

type HeaderDraft = {
  name: string
  value: string
  keep?: boolean
  isRevealed?: boolean
}

export type ConnectorModalProps = {
  show: boolean
  onHide: () => void
  connector?: ConnectorView | null
  onSaved: (connector: ConnectorView, next: ConnectNext) => void
  meta?: ConnectorsMeta | null
}

export function ConnectorModal({
  show,
  onHide,
  connector,
  onSaved,
  meta,
}: ConnectorModalProps) {
  const { t } = useTranslation()
  const isEditing = Boolean(connector)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<ConnectorTransport>('auto')
  const [authMode, setAuthMode] = useState<ConnectorAuthMode>('auto')
  // Seconds a tool call may run; blank waits as long as the server takes
  const [timeoutSeconds, setTimeoutSeconds] = useState('')

  // Advanced settings
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [oauthClientMode, setOAuthClientMode] =
    useState<OAuthClientMode>('auto')
  const [oauthClientId, setOAuthClientId] = useState('')
  const [oauthClientSecret, setOAuthClientSecret] = useState('')
  const [showClientSecret, setShowClientSecret] = useState(false)
  const [keepClientSecret, setKeepClientSecret] = useState(false)
  const [oauthScopes, setOAuthScopes] = useState('')
  const [oauthAuthUrl, setOAuthAuthUrl] = useState('')
  const [oauthTokenUrl, setOAuthTokenUrl] = useState('')
  const [oauthAuthMethod, setOAuthAuthMethod] =
    useState<TokenEndpointAuthMethod>('auto')

  // Custom Headers
  const [headers, setHeaders] = useState<HeaderDraft[]>([])

  // Probe state
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  // Saved by this dialog: later saves update it instead of adding another
  const [created, setCreated] = useState<ConnectorView | null>(null)
  // Saved, and the server asked for sign-in
  const [signInFor, setSignInFor] = useState<ConnectorView | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  // A passing result's banner goes away by itself; the result stays, since
  // it picks the preset. A failure stays up until a test passes.
  const [probeBannerHidden, setProbeBannerHidden] = useState(false)
  useAutoDismiss(
    Boolean(probeResult?.ok) && !probeError && !probeBannerHidden,
    () => setProbeBannerHidden(true),
    TEST_RESULT_MS.success,
    probeResult
  )

  // Form submission state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A sign-in that was closed before it finished: a warning, not an error
  const [signInNotice, setSignInNotice] = useState<string | null>(null)

  useEffect(() => {
    if (connector) {
      setName(connector.name)
      setUrl(connector.url)
      setTransport(connector.transport || 'auto')
      setAuthMode(connector.authMode || 'auto')
      setTimeoutSeconds(
        connector.timeoutSeconds ? String(connector.timeoutSeconds) : ''
      )
      setOAuthClientMode(connector.oauth?.clientMode || 'auto')
      setOAuthClientId(connector.oauth?.clientId || '')
      setOAuthClientSecret('')
      setKeepClientSecret(connector.oauth?.hasClientSecret || false)
      setOAuthScopes(connector.oauth?.scopes || '')
      setOAuthAuthUrl(connector.oauth?.authorizationUrl || '')
      setOAuthTokenUrl(connector.oauth?.tokenUrl || '')
      setOAuthAuthMethod(connector.oauth?.tokenEndpointAuthMethod || 'auto')
      setHeaders(
        connector.headers?.map(h => ({
          name: h.name,
          value: '',
          keep: h.hasValue,
          isRevealed: false,
        })) || []
      )
    } else {
      setName('')
      setUrl('')
      setTransport('auto')
      setAuthMode('auto')
      setTimeoutSeconds('')
      setOAuthClientMode('auto')
      setOAuthClientId('')
      setOAuthClientSecret('')
      setKeepClientSecret(false)
      setOAuthScopes('')
      setOAuthAuthUrl('')
      setOAuthTokenUrl('')
      setOAuthAuthMethod('auto')
      setHeaders([])
    }
    setProbeResult(null)
    setProbeError(null)
    setProbeBannerHidden(false)
    setError(null)
    setCreated(null)
    setSignInFor(null)
    setShowAdvanced(false)
  }, [connector, show])

  const handleAddHeader = useCallback(() => {
    setHeaders(prev => [
      ...prev,
      { name: '', value: '', keep: false, isRevealed: false },
    ])
  }, [])

  const handleUpdateHeader = useCallback(
    (idx: number, field: 'name' | 'value', val: string) => {
      setHeaders(prev =>
        prev.map((h, i) =>
          i === idx
            ? {
                ...h,
                [field]: val,
                keep: field === 'value' ? false : h.keep,
              }
            : h
        )
      )
    },
    []
  )

  const handleToggleHeaderReveal = useCallback((idx: number) => {
    setHeaders(prev =>
      prev.map((h, i) => (i === idx ? { ...h, isRevealed: !h.isRevealed } : h))
    )
  }, [])

  const handleRemoveHeader = useCallback((idx: number) => {
    setHeaders(prev => prev.filter((_, i) => i !== idx))
  }, [])

  const buildCurrentInput = useCallback((): ConnectorInput => {
    return {
      name: name.trim() || 'Connector',
      url: url.trim(),
      transport,
      authMode,
      timeoutSeconds:
        Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : null,
      headers: headers
        .filter(h => h.name.trim())
        .map(h => ({
          name: h.name.trim(),
          value: h.keep ? '' : h.value,
          keep: h.keep,
        })),
      oauth: {
        clientMode: oauthClientMode,
        clientId: oauthClientId.trim() || undefined,
        clientSecret: keepClientSecret
          ? undefined
          : oauthClientSecret || undefined,
        keepClientSecret,
        scopes: oauthScopes.trim() || undefined,
        authorizationUrl: oauthAuthUrl.trim() || undefined,
        tokenUrl: oauthTokenUrl.trim() || undefined,
        tokenEndpointAuthMethod: oauthAuthMethod,
      },
    }
  }, [
    name,
    url,
    transport,
    authMode,
    timeoutSeconds,
    headers,
    oauthClientMode,
    oauthClientId,
    oauthClientSecret,
    keepClientSecret,
    oauthScopes,
    oauthAuthUrl,
    oauthTokenUrl,
    oauthAuthMethod,
  ])

  const handleProbe = useCallback(async () => {
    if (!url.trim()) return
    setProbing(true)
    setProbeResult(null)
    setProbeBannerHidden(false)
    try {
      const input = buildCurrentInput()
      const result = await probeConnector(input)
      setProbeResult(result)
      // A failure stays up until a test passes
      if (result.ok) setProbeError(null)
      if (result.preset?.needsClient && !oauthClientId.trim()) {
        setOAuthClientMode('custom')
        setShowAdvanced(true)
      }
      if (!result.ok) {
        setProbeError(
          result.error ||
            t('connector_probe_server_error', 'Server responded with an error')
        )
      }
    } catch (err) {
      setProbeError(
        connectorErrorMessage(
          err,
          t('connector_probe_failed', 'Could not probe the MCP server')
        )
      )
    } finally {
      setProbing(false)
    }
  }, [url, buildCurrentInput, oauthClientId, t])

  // Saving verifies the server at once. The dialog only closes once it
  // connects; a server that needs sign-in is signed in to from here, and one
  // that fails stays open (as an edit of what was saved) to be fixed.
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!name.trim() || !url.trim()) return

    setSaving(true)
    setError(null)
    setSignInNotice(null)
    setSignInFor(null)
    try {
      const input = buildCurrentInput()
      const target = connector ?? created
      const res = target
        ? await updateConnector(target.id, input)
        : await createConnector(input)
      if (!target) setCreated(res.connector)
      notifyConnectorsChanged()
      // A missing `next` is read from the saved connector's status. A disabled
      // connector is saved as it is: it is not connected, so nothing to sign in to.
      const decision = res.next ?? res.connector.status
      const enabled = res.connector.enabled !== false
      if (enabled && (decision === 'authorize' || decision === 'needs_auth')) {
        setSignInFor(res.connector)
      } else if (enabled && decision === 'error') {
        setError(
          res.connector.lastError?.message ||
            t('connector_test_unreachable', 'Could not reach the server.')
        )
      } else {
        onSaved(res.connector, 'connected')
        onHide()
      }
    } catch (err) {
      setError(
        connectorErrorMessage(
          err,
          t('connector_save_failed', 'Failed to save connector')
        )
      )
    } finally {
      setSaving(false)
    }
  }

  // The server asked for it, so the popup opens from this click
  const handleSignIn = async () => {
    if (!signInFor) return
    setSigningIn(true)
    setError(null)
    setSignInNotice(null)
    try {
      const outcome = await connectWithPopup(signInFor.id)
      if (outcome.status === 'connected') {
        notifyConnectorsChanged()
        onSaved(signInFor, 'connected')
        onHide()
      } else if (outcome.status === 'error') {
        setError(outcome.error)
      } else {
        setSignInNotice(
          t(
            'connector_sign_in_not_completed',
            'Sign-in was not completed. Click Sign in to try again.'
          )
        )
      }
    } finally {
      setSigningIn(false)
    }
  }

  const isHttpUrl = url.trim().toLowerCase().startsWith('http://')
  const preset = probeResult?.preset || connector?.preset || null

  return (
    <OLModal show={show} onHide={onHide} size="lg" className="connector-modal">
      <form onSubmit={handleSubmit}>
        <OLModalHeader closeButton>
          <OLModalTitle id="connector-modal-title">
            {isEditing
              ? t('edit_connector', 'Edit connector')
              : t('add_custom_connector', 'Add custom connector')}
          </OLModalTitle>
        </OLModalHeader>
        <OLModalBody>
          <div className="mb-3">
            <Notification
              type="warning"
              content={t(
                'connector_trust_warning',
                'Only use connectors from developers you trust. Connectors can read and act on external data, and what they return is sent to your AI provider.'
              )}
            />
          </div>

          {signInFor ? (
            <div className="mb-3">
              <Notification
                type="warning"
                content={t(
                  'connector_requires_sign_in_to_add',
                  'This server requires you to sign in. Click Sign in to finish adding it.'
                )}
              />
            </div>
          ) : null}

          {error ? (
            <div className="mb-3">
              <Notification type="error" content={error} />
            </div>
          ) : null}

          {signInNotice ? (
            <div className="mb-3">
              <Notification type="warning" content={signInNotice} />
            </div>
          ) : null}

          {/* Name Field */}
          <OLFormGroup className="mb-3">
            <OLFormLabel htmlFor="connector-name">
              {t('connector_name', 'Name')}{' '}
              <span className="text-danger">*</span>
            </OLFormLabel>
            <OLFormControl
              id="connector-name"
              type="text"
              placeholder={t(
                'connector_name_placeholder',
                'e.g. Stripe API, Documentation Server'
              )}
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </OLFormGroup>

          {/* URL field with the reachability test beside it */}
          <OLFormGroup className="mb-3">
            <OLFormLabel htmlFor="connector-url">
              {t('connector_mcp_server_url', 'MCP Server URL')}{' '}
              <span className="text-danger">*</span>
            </OLFormLabel>
            <div className="connector-url-row">
              <OLFormControl
                id="connector-url"
                type="url"
                placeholder="https://mcp.example.com"
                value={url}
                onChange={e => setUrl(e.target.value)}
                required
              />
              <OLButton
                variant="secondary"
                type="button"
                onClick={handleProbe}
                disabled={!url.trim()}
                isLoading={probing}
                loadingLabel={t(
                  'connector_probe_testing',
                  'Testing connection...'
                )}
              >
                {t('test_connection', 'Test connection')}
              </OLButton>
            </div>
            {isHttpUrl ? (
              <div className="mt-2">
                <Notification
                  type="warning"
                  content={t(
                    'connector_http_warning',
                    'HTTP URLs are insecure. MCP connectors should use HTTPS in production.'
                  )}
                />
              </div>
            ) : null}
          </OLFormGroup>

          {/* Probe results */}
          {probing ? (
            <div className="connector-modal-probe-results mb-3">
              <div className="d-flex align-items-center gap-2">
                <OLSpinner size="sm" />
                <span className="small">
                  {t(
                    'connector_probe_testing_long',
                    'Testing connection to MCP server...'
                  )}
                </span>
              </div>
            </div>
          ) : null}

          {probeError && !probeBannerHidden ? (
            <div className="mb-3">
              <Notification
                type="error"
                title={t('connector_test_failed', 'Test failed')}
                content={probeError}
              />
            </div>
          ) : null}

          {probeResult && !probing && !probeError && !probeBannerHidden ? (
            <div className="connector-modal-probe-results mb-3">
              <div className="connector-probe-row">
                <span className="fw-bold d-flex align-items-center gap-1 text-success">
                  <MaterialIcon type="check_circle" />
                  {t('connector_server_reachable', 'Server reachable')}
                </span>
                <OLBadge bg="success">
                  {t('connector_online', 'Online')}
                </OLBadge>
              </div>
              <div className="connector-probe-row connector-probe-meta">
                <span>{t('connector_protocol_era', 'Protocol era:')}</span>
                <span className="font-monospace">
                  {probeResult.era === 'modern'
                    ? t('connector_era_modern', 'Modern (2024-11-05+)')
                    : probeResult.era === 'legacy'
                      ? t('connector_era_legacy', 'Legacy')
                      : probeResult.era ||
                        t('connector_era_unknown', 'Unknown')}
                </span>
              </div>
              <div className="connector-probe-row connector-probe-meta">
                <span>{t('connector_authentication', 'Authentication:')}</span>
                <span>
                  {probeResult.requiresAuth
                    ? t('connector_auth_required', 'OAuth / Sign-in required')
                    : t('connector_auth_not_required', 'No sign-in required')}
                </span>
              </div>
              {typeof probeResult.toolCount === 'number' ? (
                <div className="connector-probe-row connector-probe-meta">
                  <span>
                    {t('connector_detected_tools', 'Detected tools:')}
                  </span>
                  <span className="fw-bold">
                    {probeResult.toolCount === 1
                      ? t('connector_one_tool', '1 tool')
                      : t('connector_tool_count', '__count__ tools', {
                          count: probeResult.toolCount,
                        })}
                  </span>
                </div>
              ) : null}
              {probeResult.server?.name || probeResult.server?.title ? (
                <div className="connector-probe-row connector-probe-meta">
                  <span>{t('connector_server', 'Server:')}</span>
                  <span>
                    {probeResult.server.title || probeResult.server.name}
                    {probeResult.server.version
                      ? ` (${probeResult.server.version})`
                      : ''}
                  </span>
                </div>
              ) : null}
              {probeResult.auth?.issuer ? (
                <div className="connector-probe-row connector-probe-meta">
                  <span>{t('connector_auth_issuer', 'Auth issuer:')}</span>
                  <span className="font-monospace text-truncate connector-probe-issuer">
                    {probeResult.auth.issuer}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {preset?.needsClient ? (
            <div className="mb-3">
              <Notification
                type="info"
                content={
                  <>
                    {t(
                      'connector_preset_needs_client',
                      '__label__ MCP servers sign in with Google and need your own OAuth client: create a Web application client in',
                      { label: preset.label }
                    )}{' '}
                    <a
                      href={preset.clientHelpUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('google_cloud_console', 'Google Cloud Console')}
                    </a>
                    {meta?.redirectUri ? (
                      <>
                        {' '}
                        {t(
                          'with_the_redirect_uri',
                          'with the redirect URI'
                        )}{' '}
                        <code className="user-select-all">
                          {meta.redirectUri}
                        </code>
                      </>
                    ) : null}
                    ,{' '}
                    {t(
                      'connector_preset_enter_client',
                      'then enter its client ID and secret under Advanced settings. Endpoints and scopes are filled in for you.'
                    )}
                  </>
                }
              />
            </div>
          ) : null}

          {/* Authentication mode */}
          <OLFormGroup className="mb-3">
            <OLFormLabel htmlFor="connector-auth-mode">
              {t('connector_authentication_mode', 'Authentication Mode')}
            </OLFormLabel>
            <OLFormSelect
              id="connector-auth-mode"
              value={authMode}
              onChange={e => setAuthMode(e.target.value as ConnectorAuthMode)}
            >
              <option value="auto">
                {t(
                  'connector_auth_option_auto',
                  'Sign in when needed (Recommended)'
                )}
              </option>
              <option value="oauth">
                {t('connector_auth_option_oauth', 'Sign in now')}
              </option>
              <option value="none">
                {t('connector_auth_option_none', 'No sign-in')}
              </option>
            </OLFormSelect>
            <p className="small text-muted mt-1 mb-0">
              {authMode === 'oauth'
                ? t(
                    'connector_auth_help_oauth',
                    'Opens the server’s sign-in as soon as the connector is added.'
                  )
                : authMode === 'none'
                  ? t(
                      'connector_auth_help_none',
                      'Never signs in. Put API keys or tokens in Request headers under Advanced settings.'
                    )
                  : t(
                      'connector_auth_help_auto',
                      'Connects as is, and opens the server’s sign-in only if it asks for one.'
                    )}
            </p>
          </OLFormGroup>

          {/* Collapsible advanced settings */}
          <div className="mb-3">
            <button
              type="button"
              className="connector-advanced-toggle"
              onClick={() => setShowAdvanced(!showAdvanced)}
              aria-expanded={showAdvanced}
              aria-controls={
                showAdvanced ? 'connector-advanced-body' : undefined
              }
            >
              <MaterialIcon
                type={showAdvanced ? 'expand_less' : 'expand_more'}
              />
              {t('connector_advanced_settings', 'Advanced settings')}
            </button>

            {showAdvanced ? (
              <div
                id="connector-advanced-body"
                className="connector-advanced-body"
              >
                <OLFormGroup>
                  <OLFormLabel htmlFor="connector-transport">
                    {t('connector_transport', 'Transport Protocol')}
                  </OLFormLabel>
                  <OLFormSelect
                    id="connector-transport"
                    value={transport}
                    onChange={e =>
                      setTransport(e.target.value as ConnectorTransport)
                    }
                  >
                    <option value="auto">
                      {t(
                        'connector_transport_auto',
                        'Auto-detect (Recommended)'
                      )}
                    </option>
                    <option value="streamable-http">
                      {t(
                        'connector_transport_streamable_http',
                        'Streamable HTTP'
                      )}
                    </option>
                    <option value="sse">
                      {t('connector_transport_sse', 'Server-Sent Events (SSE)')}
                    </option>
                  </OLFormSelect>
                </OLFormGroup>

                <OLFormGroup>
                  <OLFormLabel htmlFor="connector-timeout">
                    {t(
                      'connector_timeout_label',
                      'Tool call timeout in seconds (optional)'
                    )}
                  </OLFormLabel>
                  <OLFormControl
                    id="connector-timeout"
                    type="number"
                    min={1}
                    placeholder={t(
                      'connector_timeout_placeholder',
                      'No timeout'
                    )}
                    value={timeoutSeconds}
                    onChange={e => setTimeoutSeconds(e.target.value)}
                  />
                  <p className="small text-muted mt-1 mb-0">
                    {t(
                      'connector_timeout_help',
                      'Leave blank to wait as long as the server takes; Stop still ends a call.'
                    )}
                  </p>
                </OLFormGroup>

                {/* OAuth client options */}
                {authMode === 'oauth' || authMode === 'auto' ? (
                  <div className="d-flex flex-column gap-3">
                    <OLFormGroup>
                      <OLFormLabel htmlFor="connector-oauth-mode">
                        {t(
                          'connector_oauth_registration',
                          'OAuth Client Registration'
                        )}
                      </OLFormLabel>
                      <OLFormSelect
                        id="connector-oauth-mode"
                        value={oauthClientMode}
                        onChange={e =>
                          setOAuthClientMode(e.target.value as OAuthClientMode)
                        }
                      >
                        <option value="auto">
                          {t('connector_oauth_auto', 'Automatic (Recommended)')}
                        </option>
                        <option
                          value="cimd"
                          disabled={!meta?.clientMetadataUrl}
                        >
                          {t(
                            'connector_oauth_cimd',
                            'Use Overleaf’s published identity (CIMD)'
                          )}
                        </option>
                        <option value="dcr">
                          {t(
                            'connector_oauth_dcr',
                            'Register automatically (DCR)'
                          )}
                        </option>
                        <option value="custom">
                          {t(
                            'connector_oauth_custom',
                            'Use your own OAuth client'
                          )}
                        </option>
                      </OLFormSelect>
                      <p className="small text-muted mt-1 mb-0">
                        {t(
                          'connector_oauth_help',
                          'Automatic uses Overleaf’s published identity when the server accepts it, otherwise registers with the server.'
                        )}
                      </p>
                    </OLFormGroup>

                    {oauthClientMode === 'custom' ? (
                      <div className="connector-custom-client">
                        <OLFormGroup>
                          <OLFormLabel htmlFor="connector-oauth-client-id">
                            {t('connector_oauth_client_id', 'OAuth Client ID')}{' '}
                            <span className="text-danger">*</span>
                          </OLFormLabel>
                          <OLFormControl
                            id="connector-oauth-client-id"
                            type="text"
                            placeholder={t(
                              'connector_oauth_client_id_placeholder',
                              'Client ID from provider'
                            )}
                            value={oauthClientId}
                            onChange={e => setOAuthClientId(e.target.value)}
                          />
                        </OLFormGroup>

                        <OLFormGroup>
                          <OLFormLabel htmlFor="connector-oauth-client-secret">
                            {t(
                              'connector_oauth_client_secret',
                              'OAuth Client Secret'
                            )}
                          </OLFormLabel>
                          {isEditing && connector?.oauth?.hasClientSecret ? (
                            <OLFormCheckbox
                              id="connector-keep-secret"
                              className="mb-2"
                              label={t(
                                'connector_keep_saved_secret',
                                'Keep saved secret (leave unchecked to replace)'
                              )}
                              checked={keepClientSecret}
                              onChange={e =>
                                setKeepClientSecret(e.target.checked)
                              }
                            />
                          ) : null}
                          <div className="connector-secret-row">
                            <OLFormControl
                              id="connector-oauth-client-secret"
                              type={showClientSecret ? 'text' : 'password'}
                              placeholder={
                                keepClientSecret
                                  ? '••••••••••••'
                                  : t(
                                      'connector_client_secret_placeholder',
                                      'Client Secret'
                                    )
                              }
                              value={oauthClientSecret}
                              onChange={e =>
                                setOAuthClientSecret(e.target.value)
                              }
                              disabled={keepClientSecret}
                              autoComplete="off"
                            />
                            <OLTooltip
                              id="connector-secret-visibility"
                              description={
                                showClientSecret
                                  ? t('connector_hide_secret', 'Hide secret')
                                  : t('connector_show_secret', 'Show secret')
                              }
                            >
                              <span>
                                <OLIconButton
                                  variant="secondary"
                                  type="button"
                                  onClick={() =>
                                    setShowClientSecret(!showClientSecret)
                                  }
                                  disabled={keepClientSecret}
                                  accessibilityLabel={
                                    showClientSecret
                                      ? t(
                                          'connector_hide_client_secret',
                                          'Hide client secret'
                                        )
                                      : t(
                                          'connector_show_client_secret',
                                          'Show client secret'
                                        )
                                  }
                                  icon={
                                    showClientSecret
                                      ? 'visibility_off'
                                      : 'visibility'
                                  }
                                />
                              </span>
                            </OLTooltip>
                          </div>
                        </OLFormGroup>

                        <OLFormGroup>
                          <OLFormLabel htmlFor="connector-oauth-scopes">
                            {t(
                              'connector_oauth_scopes',
                              'Custom Scopes (optional)'
                            )}
                          </OLFormLabel>
                          <OLFormControl
                            id="connector-oauth-scopes"
                            type="text"
                            placeholder={t(
                              'connector_oauth_scopes_placeholder',
                              'e.g. read write'
                            )}
                            value={oauthScopes}
                            onChange={e => setOAuthScopes(e.target.value)}
                          />
                        </OLFormGroup>

                        <OLFormGroup>
                          <OLFormLabel htmlFor="connector-oauth-auth-url">
                            {t(
                              'connector_oauth_auth_url',
                              'Custom Authorization URL (optional)'
                            )}
                          </OLFormLabel>
                          <OLFormControl
                            id="connector-oauth-auth-url"
                            type="url"
                            placeholder="https://auth.example.com/oauth/authorize"
                            value={oauthAuthUrl}
                            onChange={e => setOAuthAuthUrl(e.target.value)}
                          />
                        </OLFormGroup>

                        <OLFormGroup>
                          <OLFormLabel htmlFor="connector-oauth-token-url">
                            {t(
                              'connector_oauth_token_url',
                              'Custom Token URL (optional)'
                            )}
                          </OLFormLabel>
                          <OLFormControl
                            id="connector-oauth-token-url"
                            type="url"
                            placeholder="https://auth.example.com/oauth/token"
                            value={oauthTokenUrl}
                            onChange={e => setOAuthTokenUrl(e.target.value)}
                          />
                        </OLFormGroup>

                        <OLFormGroup>
                          <OLFormLabel htmlFor="connector-oauth-auth-method">
                            {t(
                              'connector_token_endpoint_auth_method',
                              'Token Endpoint Auth Method'
                            )}
                          </OLFormLabel>
                          <OLFormSelect
                            id="connector-oauth-auth-method"
                            value={oauthAuthMethod}
                            onChange={e =>
                              setOAuthAuthMethod(
                                e.target.value as TokenEndpointAuthMethod
                              )
                            }
                          >
                            <option value="auto">
                              {t('connector_token_auth_auto', 'Auto-detect')}
                            </option>
                            <option value="client_secret_basic">
                              client_secret_basic (HTTP Basic Auth)
                            </option>
                            <option value="client_secret_post">
                              client_secret_post (Request Body)
                            </option>
                            <option value="none">
                              {t(
                                'connector_token_auth_none',
                                'none (Public Client / PKCE only)'
                              )}
                            </option>
                          </OLFormSelect>
                        </OLFormGroup>

                        {meta?.redirectUri ? (
                          <div className="small text-muted">
                            {t(
                              'connector_redirect_uri_help',
                              'Redirect URI to register in your OAuth provider:'
                            )}{' '}
                            <code className="user-select-all font-monospace">
                              {meta.redirectUri}
                            </code>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Request headers */}
                <OLFormGroup>
                  <div className="connector-section-header">
                    <OLFormLabel className="mb-0">
                      {t('connector_request_headers', 'Request Headers')}
                    </OLFormLabel>
                    <OLButton
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={handleAddHeader}
                    >
                      {t('connector_add_header', 'Add header')}
                    </OLButton>
                  </div>
                  <p className="small text-muted mb-2">
                    {t(
                      'connector_headers_help',
                      'Custom headers sent with each request (e.g. Authorization, API keys). Sensitive headers are automatically masked.'
                    )}
                  </p>

                  {headers.length > 0 ? (
                    <div className="connector-headers-table">
                      {headers.map((header, idx) => {
                        const sensitive = isSensitiveHeaderKey(header.name)
                        const inputType =
                          sensitive && !header.isRevealed ? 'password' : 'text'

                        return (
                          <div key={idx} className="connector-header-row">
                            <OLFormControl
                              size="sm"
                              type="text"
                              placeholder={t(
                                'connector_header_name_placeholder',
                                'Header name'
                              )}
                              value={header.name}
                              onChange={e =>
                                handleUpdateHeader(idx, 'name', e.target.value)
                              }
                              className="connector-header-name"
                              aria-label={t(
                                'connector_header_name_label',
                                'Header __number__ name',
                                { number: idx + 1 }
                              )}
                            />
                            <OLFormControl
                              size="sm"
                              type={inputType}
                              placeholder={
                                header.keep
                                  ? t('connector_saved_value', '(Saved value)')
                                  : t('connector_value_placeholder', 'Value')
                              }
                              value={header.value}
                              onChange={e =>
                                handleUpdateHeader(idx, 'value', e.target.value)
                              }
                              className="connector-header-value"
                              aria-label={t(
                                'connector_header_value_label',
                                'Header __number__ value',
                                { number: idx + 1 }
                              )}
                            />
                            {sensitive ? (
                              <OLTooltip
                                id={`header-mask-${idx}`}
                                description={
                                  header.isRevealed
                                    ? t('connector_hide_value', 'Hide value')
                                    : t('connector_show_value', 'Show value')
                                }
                              >
                                <span>
                                  <OLIconButton
                                    variant="secondary"
                                    size="sm"
                                    type="button"
                                    onClick={() =>
                                      handleToggleHeaderReveal(idx)
                                    }
                                    accessibilityLabel={
                                      header.isRevealed
                                        ? t(
                                            'connector_hide_header_value',
                                            'Hide header value'
                                          )
                                        : t(
                                            'connector_show_header_value',
                                            'Show header value'
                                          )
                                    }
                                    icon={
                                      header.isRevealed
                                        ? 'visibility_off'
                                        : 'visibility'
                                    }
                                  />
                                </span>
                              </OLTooltip>
                            ) : null}
                            <OLTooltip
                              id={`header-remove-${idx}`}
                              description={t(
                                'connector_remove_header',
                                'Remove header'
                              )}
                            >
                              <span>
                                <OLIconButton
                                  variant="danger-ghost"
                                  size="sm"
                                  type="button"
                                  onClick={() => handleRemoveHeader(idx)}
                                  accessibilityLabel={t(
                                    'connector_remove_header_number',
                                    'Remove header __number__',
                                    { number: idx + 1 }
                                  )}
                                  icon="delete"
                                />
                              </span>
                            </OLTooltip>
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </OLFormGroup>
              </div>
            ) : null}
          </div>
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
          {signInFor ? (
            <OLButton
              variant="primary"
              type="button"
              onClick={handleSignIn}
              isLoading={signingIn}
              loadingLabel={t('connector_signing_in', 'Signing in...')}
            >
              {t('connector_sign_in', 'Sign in')}
            </OLButton>
          ) : (
            <OLButton
              variant="primary"
              type="submit"
              disabled={!name.trim() || !url.trim()}
              isLoading={saving}
              loadingLabel={t('connector_verifying', 'Connecting...')}
            >
              {isEditing || created
                ? t('save_changes', 'Save changes')
                : t('add_connector', 'Add connector')}
            </OLButton>
          )}
        </OLModalFooter>
      </form>
    </OLModal>
  )
}
