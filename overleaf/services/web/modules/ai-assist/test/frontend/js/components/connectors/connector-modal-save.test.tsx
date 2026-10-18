import { createElement } from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConnectorModal } from '../../../../../frontend/js/features/ai-assist/components/connectors/connector-modal'
import {
  ConnectorView,
  ConnectorsMeta,
} from '../../../../../frontend/js/features/ai-assist/connectors/types'

const CONNECTOR_ID = 'conn-1'
const META: ConnectorsMeta = {
  redirectUri: 'https://overleaf.example.com/ai-assist/connectors/oauth/callback',
  clientMetadataUrl: null,
}

function setMeta() {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
}

function connectorView(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: CONNECTOR_ID,
    name: 'Docs',
    url: 'https://docs.example.com/mcp',
    transport: 'auto',
    authMode: 'auto',
    enabled: true,
    status: 'connected',
    lastError: null,
    timeoutSeconds: null,
    preset: null,
    defaultPermission: 'ask',
    headers: [],
    oauth: {
      clientMode: 'auto',
      clientId: null,
      hasClientSecret: false,
      scopes: '',
      authorizationUrl: '',
      tokenUrl: '',
      tokenEndpointAuthMethod: 'auto',
      extraParams: [],
      issuer: null,
      registration: null,
      grantedScopes: null,
      expiresAt: null,
      hasRefreshToken: false,
    },
    server: null,
    tools: [],
    toolsUpdatedAt: null,
    createdAt: '2026-10-15T10:00:00Z',
    updatedAt: '2026-10-15T10:00:00Z',
    lastConnectedAt: null,
    ...overrides,
  } as ConnectorView
}

/** Saves the edit dialog for a connector whose PATCH answers with `body`. */
function saveWith(body: unknown) {
  fetchMock.patch(`/ai-assist/connectors/${CONNECTOR_ID}`, body as object)
  const onSaved = sinon.spy()
  const onHide = sinon.spy()
  render(
    createElement(ConnectorModal, {
      show: true,
      onHide,
      connector: connectorView(),
      onSaved,
      meta: META,
    })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  return { onSaved, onHide }
}

describe('ConnectorModal save decision', function () {
  beforeEach(function () {
    setMeta()
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('shows the sign-in step when next is missing and the connector needs auth', async function () {
    const { onSaved, onHide } = saveWith({
      connector: connectorView({ status: 'needs_auth' }),
    })

    await waitFor(() =>
      expect(
        screen.getByText(
          'This server requires you to sign in. Click Sign in to finish adding it.'
        )
      ).to.exist
    )
    expect(onSaved).not.to.have.been.called
    expect(onHide).not.to.have.been.called
  })

  it('shows the saved lastError when next is error', async function () {
    const { onSaved, onHide } = saveWith({
      connector: connectorView({
        status: 'error',
        lastError: { message: 'Server refused the handshake', at: '2026-10-15T10:00:00Z' },
      }),
      next: 'error',
    })

    await waitFor(() =>
      expect(screen.getByText('Server refused the handshake')).to.exist
    )
    expect(onSaved).not.to.have.been.called
    expect(onHide).not.to.have.been.called
  })

  it('closes as saved when next is connected', async function () {
    const { onSaved, onHide } = saveWith({
      connector: connectorView({ status: 'connected' }),
      next: 'connected',
    })

    await waitFor(() => expect(onHide).to.have.been.calledOnce)
    expect(onSaved).to.have.been.calledOnce
  })

  it('closes as saved when next is missing and the connector is connected', async function () {
    const { onSaved, onHide } = saveWith({
      connector: connectorView({ status: 'connected' }),
    })

    await waitFor(() => expect(onHide).to.have.been.calledOnce)
    expect(onSaved).to.have.been.calledOnce
  })

  it('closes as saved when the connector is disabled, even if it reports needs_auth', async function () {
    const { onSaved, onHide } = saveWith({
      connector: connectorView({ enabled: false, status: 'needs_auth' }),
      next: null,
    })

    await waitFor(() => expect(onHide).to.have.been.calledOnce)
    expect(onSaved).to.have.been.calledOnce
  })
})
