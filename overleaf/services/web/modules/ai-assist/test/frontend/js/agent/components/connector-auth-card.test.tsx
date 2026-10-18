import { createElement } from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConnectorAuthCard } from '../../../../../frontend/js/features/ai-assist/components/agent/connector-auth-card'
import { stopBackgroundWatches } from '../../../../../frontend/js/features/ai-assist/connectors/oauth-popup'

const CONNECTOR_ID = 'conn-1'
const AUTHORIZE_URL = `/ai-assist/connectors/${CONNECTOR_ID}/authorize`

function setMeta() {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
}

// The bootstrap BroadcastChannel stub has no close(), which the popup calls.
class ChannelStub {
  onmessage: unknown = null
  close() {}
  postMessage() {}
}

function renderCard(onDecision = sinon.spy()) {
  render(
    createElement(ConnectorAuthCard, {
      connectorId: CONNECTOR_ID,
      connectorName: 'Docs',
      toolName: 'search',
      onDecision,
    })
  )
  return onDecision
}

describe('ConnectorAuthCard', function () {
  let openStub: sinon.SinonStub
  let originalChannel: typeof BroadcastChannel

  beforeEach(function () {
    setMeta()
    originalChannel = globalThis.BroadcastChannel
    globalThis.BroadcastChannel = ChannelStub as unknown as typeof BroadcastChannel
    fetchMock.removeRoutes().clearHistory()
    fetchMock.get('/ai-assist/connectors', () => ({
      connectors: [],
      meta: { redirectUri: '', clientMetadataUrl: null },
    }))
  })

  afterEach(function () {
    stopBackgroundWatches()
    openStub?.restore()
    globalThis.BroadcastChannel = originalChannel
    fetchMock.removeRoutes().clearHistory()
  })

  it('shows the server message on an error outcome and stops loading', async function () {
    openStub = sinon
      .stub(window, 'open')
      .returns({ closed: false, location: { href: '' }, close() {} } as unknown as Window)
    fetchMock.post(AUTHORIZE_URL, {
      status: 500,
      body: { error: 'Discovery failed' },
    })
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Connect to Docs' }))

    await waitFor(() =>
      expect(screen.getByText('Discovery failed')).to.exist
    )
    const button = screen.getByRole('button', { name: 'Connect to Docs' }) as HTMLButtonElement
    expect(button.disabled).to.equal(false)
  })

  it('shows a not-completed note when the window closes, and stops loading', async function () {
    this.timeout(8000)
    const popup = { closed: false, location: { href: '' }, close() {} }
    openStub = sinon.stub(window, 'open').returns(popup as unknown as Window)
    fetchMock.post(AUTHORIZE_URL, { authorizationUrl: 'https://auth.example.com/authorize' })
    const onDecision = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Connect to Docs' }))
    // Once the window has gone to the authorization server, the user closes it
    await waitFor(() =>
      expect(popup.location.href).to.equal('https://auth.example.com/authorize')
    )
    popup.closed = true

    await waitFor(
      () =>
        expect(
          screen.getByText('Sign-in was not completed. Click Connect to try again.')
        ).to.exist,
      { timeout: 5000 }
    )
    expect(onDecision).not.to.have.been.called
    expect(screen.getByRole('button', { name: 'Connect to Docs' })).to.exist
  })
})
