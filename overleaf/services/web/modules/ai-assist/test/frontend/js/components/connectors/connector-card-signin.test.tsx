import { createElement } from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConnectorCard } from '../../../../../frontend/js/features/ai-assist/components/connectors/connector-card'
import { stopBackgroundWatches } from '../../../../../frontend/js/features/ai-assist/connectors/oauth-popup'
import {
  ConnectorView,
  ConnectorsMeta,
} from '../../../../../frontend/js/features/ai-assist/connectors/types'

const CONNECTOR_ID = 'conn-1'
const AUTH_HREF = 'https://auth.example.com/authorize?client_id=abc'
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

function connectorView(status: ConnectorView['status']): ConnectorView {
  return {
    id: CONNECTOR_ID,
    name: 'Docs',
    url: 'https://docs.example.com/mcp',
    transport: 'auto',
    authMode: 'auto',
    enabled: true,
    status,
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
  } as ConnectorView
}

// The bootstrap BroadcastChannel stub has no close(), which the popup calls.
class ChannelStub {
  onmessage: unknown = null
  close() {}
  postMessage() {}
}

const NOT_COMPLETED = 'Sign-in was not completed. Click Sign in to try again.'
const SIGNED_IN = 'Signed in and connected.'

function renderCard(status: ConnectorView['status']) {
  const props = {
    connector: connectorView(status),
    onEdit: () => {},
    onConfigureTools: () => {},
  }
  return render(createElement(ConnectorCard, props))
}

describe('ConnectorCard sign-in', function () {
  let openStub: sinon.SinonStub
  let originalChannel: typeof BroadcastChannel
  let popup: { closed: boolean; location: { href: string }; close: () => void }

  beforeEach(function () {
    setMeta()
    originalChannel = globalThis.BroadcastChannel
    globalThis.BroadcastChannel = ChannelStub as unknown as typeof BroadcastChannel
    fetchMock.removeRoutes().clearHistory()
    fetchMock.post(`/ai-assist/connectors/${CONNECTOR_ID}/authorize`, {
      authorizationUrl: AUTH_HREF,
    })
    fetchMock.get('/ai-assist/connectors', () => ({
      connectors: [connectorView('needs_auth')],
      meta: META,
    }))
    popup = { closed: false, location: { href: '' }, close() {} }
    openStub = sinon.stub(window, 'open').returns(popup as unknown as Window)
  })

  afterEach(function () {
    stopBackgroundWatches()
    openStub.restore()
    globalThis.BroadcastChannel = originalChannel
    fetchMock.removeRoutes().clearHistory()
  })

  it('shows the not-completed note when the sign-in window closes, then replaces it once connected', async function () {
    this.timeout(8000)
    const { rerender } = renderCard('needs_auth')

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Docs' }))
    // Once the window has gone to the authorization server, the user closes it
    await waitFor(() => expect(popup.location.href).to.equal(AUTH_HREF))
    popup.closed = true

    // The window reads as closed: the note shows after the grace check
    await waitFor(() => expect(screen.getByText(NOT_COMPLETED)).to.exist, {
      timeout: 5000,
    })
    // The button is no longer loading
    expect(screen.getByRole('button', { name: 'Sign in to Docs' })).to.exist

    // The sign-in completes later and the list refreshes the connector
    rerender(
      createElement(ConnectorCard, {
        connector: connectorView('connected'),
        onEdit: () => {},
        onConfigureTools: () => {},
      })
    )

    await waitFor(() => expect(screen.getByText(SIGNED_IN)).to.exist)
    expect(screen.queryByText(NOT_COMPLETED)).to.equal(null)
  })
})
