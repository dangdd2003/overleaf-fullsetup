import { expect } from 'chai'
import sinon from 'sinon'
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import ConnectorsWidget from '../../../../../frontend/js/features/ai-assist/components/connectors/connectors-widget'
import {
  ConnectorView,
  ConnectorsMeta,
} from '../../../../../frontend/js/features/ai-assist/connectors/types'

// Connectors are part of the assistant: they are on whenever it is.
function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    (enabled
      ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
      : '')
}

/** Opens a connector's "more actions" menu. Edit, test, disconnect and remove live there. */
async function openConnectorMenu(name: string) {
  fireEvent.click(
    await screen.findByRole('button', { name: `More actions for ${name}` })
  )
}

// The bootstrap BroadcastChannel stub has no close(), which the widget and the
// OAuth popup call on cleanup. Installed for this suite only.
class ChannelStub {
  onmessage: unknown = null
  close() {}
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
}

function fakePopup() {
  const popup = {
    closed: false,
    location: { href: '' },
    close() {
      popup.closed = true
    },
  }
  return popup
}

/** Fake timers for the auto-dismiss delays. Promises and I/O stay real. */
function useFakeTimers() {
  return sinon.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
}

// setImmediate is not faked, so this lets pending fetch and React work run
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

async function advance(clock: sinon.SinonFakeTimers, ms: number) {
  clock.tick(ms)
  for (let i = 0; i < 5; i++) await flush()
}

/** Advances fake time in small steps until the check passes. */
async function until(clock: sinon.SinonFakeTimers, check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return
    await advance(clock, 20)
  }
  throw new Error('Timed out waiting for the condition under fake timers')
}

/** A banner with no dismiss button: the notification's close control is absent. */
function expectNoDismiss(text: string) {
  const banner = screen.getByText(text).closest('.notification')
  expect(banner, `banner for "${text}"`).to.exist
  expect(banner!.querySelector('.notification-close-btn')).to.be.null
  expect(banner!.querySelector('button')).to.be.null
}

function bannerType(text: string) {
  return screen.getByText(text).closest('.notification')!.className
}

const MOCK_META: ConnectorsMeta = {
  redirectUri:
    'https://overleaf.example.com/ai-assist/connectors/oauth/callback',
  clientMetadataUrl: null,
}

const MOCK_CONNECTOR_CONNECTED: ConnectorView = {
  id: 'conn-1',
  name: 'GitHub Docs',
  url: 'https://mcp.github.com',
  transport: 'streamable-http',
  authMode: 'oauth',
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
  server: {
    name: 'github-docs-mcp',
    title: 'GitHub Docs MCP Server',
    version: '1.2.0',
    protocolVersion: '2024-11-05',
  },
  tools: [
    {
      name: 'search_docs',
      title: 'Search Documentation',
      description: 'Search documentation pages',
      readOnly: true,
      destructive: false,
      openWorld: false,
      permission: 'allow',
    },
    {
      name: 'create_issue',
      title: 'Create Issue',
      description: 'Create an issue on GitHub',
      readOnly: false,
      destructive: false,
      openWorld: false,
      permission: 'ask',
    },
  ],
  toolsUpdatedAt: '2026-10-15T10:00:00Z',
  createdAt: '2026-10-14T10:00:00Z',
  updatedAt: '2026-10-15T10:00:00Z',
  lastConnectedAt: '2026-10-15T10:00:00Z',
}

const MOCK_CONNECTOR_NEEDS_AUTH: ConnectorView = {
  id: 'conn-2',
  name: 'Stripe API',
  url: 'https://mcp.stripe.com',
  transport: 'auto',
  authMode: 'oauth',
  enabled: true,
  status: 'needs_auth',
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
    issuer: 'https://auth.stripe.com',
    registration: null,
    grantedScopes: null,
    expiresAt: null,
    hasRefreshToken: false,
  },
  server: null,
  tools: [],
  toolsUpdatedAt: null,
  createdAt: '2026-10-14T10:00:00Z',
  updatedAt: '2026-10-14T10:00:00Z',
  lastConnectedAt: null,
}

const MOCK_CONNECTOR_ERROR: ConnectorView = {
  id: 'conn-3',
  name: 'Broken Server',
  url: 'https://bad.example.com',
  transport: 'auto',
  authMode: 'none',
  enabled: false,
  status: 'error',
  lastError: {
    message: 'ECONNREFUSED: Connection refused at 10.0.0.1:443',
    code: 'ECONNREFUSED',
    at: '2026-10-15T09:00:00Z',
  },
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
  createdAt: '2026-10-14T10:00:00Z',
  updatedAt: '2026-10-15T09:00:00Z',
  lastConnectedAt: null,
}

describe('ConnectorsWidget', function () {
  const originalChannel = globalThis.BroadcastChannel

  before(function () {
    globalThis.BroadcastChannel = ChannelStub as unknown as typeof BroadcastChannel
    window.BroadcastChannel = globalThis.BroadcastChannel
  })

  after(function () {
    globalThis.BroadcastChannel = originalChannel
    window.BroadcastChannel = originalChannel
  })

  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    setMeta({ enabled: true })
  })

  afterEach(function () {
    sinon.restore()
    fetchMock.removeRoutes().clearHistory()
  })

  it('renders nothing when ai-assist feature is disabled', function () {
    setMeta({ enabled: false })
    const { container } = render(<ConnectorsWidget />)
    expect(container.textContent).to.equal('')
  })

  it('does not fetch connectors when ai-assist feature is disabled', function () {
    setMeta({ enabled: false })
    render(<ConnectorsWidget />)
    expect(fetchMock.callHistory.calls()).to.have.length(0)
  })

  it('renders empty state when no connectors exist', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [],
      meta: MOCK_META,
    })

    render(<ConnectorsWidget />)

    expect(await screen.findByTestId('connectors-settings')).to.exist
    expect(await screen.findByTestId('connectors-empty')).to.exist
    expect(screen.getByText('Connectors')).to.exist
    expect(screen.getByText(/Not configured/i)).to.exist
    expect(screen.getByRole('button', { name: /Add custom connector/i })).to
      .exist
  })

  it('renders configured connectors with status badges and URLs', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [
        MOCK_CONNECTOR_CONNECTED,
        MOCK_CONNECTOR_NEEDS_AUTH,
        MOCK_CONNECTOR_ERROR,
      ],
      meta: MOCK_META,
    })

    render(<ConnectorsWidget />)

    expect(await screen.findByText('GitHub Docs')).to.exist
    expect(screen.getByText('Stripe API')).to.exist
    expect(screen.getByText('Broken Server')).to.exist

    // Status badges
    expect(screen.getByText('Connected')).to.exist
    expect(screen.getByText('Needs sign-in')).to.exist
    expect(screen.getByText('Error')).to.exist

    // Tool counts
    expect(screen.getByText('2 tools')).to.exist
    expect(screen.getAllByText('0 tools')).to.have.length(2)

    // Status summary
    expect(screen.getByText(/1 of 3 active/i)).to.exist

    // URLs
    expect(screen.getByText('https://mcp.github.com')).to.exist
    expect(screen.getByText('https://mcp.stripe.com')).to.exist

    // Error message
    expect(screen.getByText(/ECONNREFUSED: Connection refused/i)).to.exist
  })

  it('toggles connector enabled state via switch', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })
    fetchMock.patch('/ai-assist/connectors/conn-1', {
      connector: { ...MOCK_CONNECTOR_CONNECTED, enabled: false },
    })

    render(<ConnectorsWidget />)

    const switchToggle = await screen.findByTestId('connector-toggle-conn-1')
    expect(switchToggle).to.exist

    fireEvent.click(switchToggle)

    await waitFor(() => {
      const calls = fetchMock.callHistory.calls('/ai-assist/connectors/conn-1')
      expect(calls).to.have.length(1)
      const body = JSON.parse(calls[0].options.body as string)
      expect(body).to.deep.equal({ enabled: false })
    })
  })

  it('shows Sign in for a connector the server asked to sign in', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_NEEDS_AUTH],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/conn-2/authorize', {
      authorizationUrl: 'https://auth.stripe.com/authorize?client_id=123',
    })
    const popup = fakePopup()
    sinon.stub(window, 'open').returns(popup as unknown as Window)

    render(<ConnectorsWidget />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in to Stripe API' })
    )

    await waitFor(() => {
      const calls = fetchMock.callHistory.calls(
        '/ai-assist/connectors/conn-2/authorize'
      )
      expect(calls).to.have.length(1)
    })
    // Finish the sign-in so the popup helper stops watching
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'ai-assist:connector-oauth',
          connectorId: 'conn-2',
          status: 'connected',
        },
        origin: window.location.origin,
      })
    )
    expect(await screen.findByText('Signed in and connected.')).to.exist
  })

  it('shows Reconnect button for error connector', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_ERROR],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/conn-3/refresh', {
      connector: { ...MOCK_CONNECTOR_ERROR, status: 'connected' },
      next: 'connected',
    })

    render(<ConnectorsWidget />)

    const reconnectBtn = await screen.findByRole('button', {
      name: /Reconnect Broken Server/i,
    })
    expect(reconnectBtn).to.exist

    fireEvent.click(reconnectBtn)

    await waitFor(() => {
      const calls = fetchMock.callHistory.calls(
        '/ai-assist/connectors/conn-3/refresh'
      )
      expect(calls).to.have.length(1)
    })
  })

  it('opens Add custom connector modal and tests probe and creation', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/probe', {
      ok: true,
      reachable: true,
      requiresAuth: false,
      era: 'modern',
      toolCount: 5,
      server: { name: 'test-mcp', version: '1.0' },
    })
    fetchMock.post('/ai-assist/connectors', {
      connector: {
        ...MOCK_CONNECTOR_CONNECTED,
        id: 'conn-new',
        name: 'New Server',
      },
      next: 'connected',
    })

    render(<ConnectorsWidget />)

    const addBtn = await screen.findByRole('button', {
      name: /Add custom connector/i,
    })
    fireEvent.click(addBtn)

    expect(screen.getByRole('heading', { name: 'Add custom connector' })).to
      .exist

    // Fill form
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Stripe API/i), {
      target: { value: 'New Server' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com'), {
      target: { value: 'https://new.example.com' },
    })

    // Click probe button
    const probeBtn = screen.getByRole('button', { name: 'Test connection' })
    fireEvent.click(probeBtn)

    expect(await screen.findByText('Server reachable')).to.exist
    expect(screen.getByText('5 tools')).to.exist

    // Submit form
    const submitBtn = screen.getByRole('button', { name: 'Add connector' })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      const postCalls = fetchMock.callHistory
        .calls()
        .filter(
          c =>
            c.url.endsWith('/ai-assist/connectors') &&
            c.options.method?.toUpperCase() === 'POST'
        )
      expect(postCalls).to.have.length(1)
      const body = JSON.parse(postCalls[0].options.body as string)
      expect(body.name).to.equal('New Server')
      expect(body.url).to.equal('https://new.example.com')
    })
  })

  it('opens Edit connector modal with populated values', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })

    render(<ConnectorsWidget />)

    await openConnectorMenu('GitHub Docs')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))

    expect(screen.getByRole('heading', { name: 'Edit connector' })).to.exist
    expect(screen.getByDisplayValue('GitHub Docs')).to.exist
    expect(screen.getByDisplayValue('https://mcp.github.com')).to.exist
  })

  it('opens Tool permissions modal and allows batch configuring permissions', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })
    fetchMock.patch('/ai-assist/connectors/conn-1', {
      connector: MOCK_CONNECTOR_CONNECTED,
    })

    render(<ConnectorsWidget />)

    const configToolsBtn = await screen.findByRole('button', {
      name: /Configure tools for GitHub Docs/i,
    })
    fireEvent.click(configToolsBtn)

    expect(
      screen.getByRole('heading', { name: /Configure tools - GitHub Docs/i })
    ).to.exist

    // Tools rendered
    expect(screen.getByText('search_docs')).to.exist
    expect(screen.getByText('create_issue')).to.exist
    expect(screen.getByText('Read-only tools (1)')).to.exist
    expect(screen.getByText('Write / Action tools (1)')).to.exist

    // Batch set all to ask
    const setAllBtn = screen.getByRole('button', {
      name: /Set all to Needs approval/i,
    })
    fireEvent.click(setAllBtn)

    // Save
    const saveBtn = screen.getByRole('button', { name: 'Save permissions' })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      const calls = fetchMock.callHistory.calls('/ai-assist/connectors/conn-1')
      expect(calls).to.have.length(1)
      const body = JSON.parse(calls[0].options.body as string)
      expect(body.toolPermissions).to.deep.equal({
        search_docs: 'ask',
        create_issue: 'ask',
      })
    })
  })

  it('filters tools by search query in Tool permissions modal', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })

    render(<ConnectorsWidget />)

    const configToolsBtn = await screen.findByRole('button', {
      name: /Configure tools for GitHub Docs/i,
    })
    fireEvent.click(configToolsBtn)

    const searchInput = screen.getByLabelText('Filter tools')
    fireEvent.change(searchInput, { target: { value: 'search' } })

    expect(screen.getByText('search_docs')).to.exist
    expect(screen.queryByText('create_issue')).to.be.null
  })

  it('removes connector after confirmation', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })
    fetchMock.delete('/ai-assist/connectors/conn-1', { ok: true })

    render(<ConnectorsWidget />)

    await openConnectorMenu('GitHub Docs')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Remove "GitHub Docs"\?/)).to.exist
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      const calls = fetchMock.callHistory.calls('/ai-assist/connectors/conn-1')
      expect(calls).to.have.length(1)
      expect(calls[0].options.method?.toUpperCase()).to.equal('DELETE')
    })
  })

  it('keeps the connector when removal is cancelled', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })
    fetchMock.delete('/ai-assist/connectors/conn-1', { ok: true })

    render(<ConnectorsWidget />)

    await openConnectorMenu('GitHub Docs')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).to.be.null
    })
    expect(
      fetchMock.callHistory.calls('/ai-assist/connectors/conn-1')
    ).to.have.length(0)
    expect(screen.getByText('GitHub Docs')).to.exist
  })

  it('disconnects connector when Disconnect is clicked', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/conn-1/disconnect', {
      connector: { ...MOCK_CONNECTOR_CONNECTED, status: 'disconnected' },
    })

    render(<ConnectorsWidget />)

    await openConnectorMenu('GitHub Docs')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect' }))

    await waitFor(() => {
      const calls = fetchMock.callHistory.calls(
        '/ai-assist/connectors/conn-1/disconnect'
      )
      expect(calls).to.have.length(1)
    })
  })

  it('summarises connectors when none are active', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_ERROR],
      meta: MOCK_META,
    })

    render(<ConnectorsWidget />)

    expect(await screen.findByText('No active connectors (1 configured)')).to
      .exist
  })

  it('connects a server that needs no sign-in without opening a sign-in window', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [{ ...MOCK_CONNECTOR_NEEDS_AUTH, status: 'disconnected' }],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/conn-2/refresh', {
      connector: {
        ...MOCK_CONNECTOR_NEEDS_AUTH,
        status: 'connected',
        tools: [{ name: 'a' }, { name: 'b' }],
      },
      next: 'connected',
    })
    fetchMock.post('/ai-assist/connectors/conn-2/authorize', {
      authorizationUrl: 'https://auth.stripe.com/authorize',
    })

    render(<ConnectorsWidget />)

    expect(await screen.findByText('Disconnected')).to.exist
    fireEvent.click(
      await screen.findByRole('button', { name: /Connect Stripe API/i })
    )

    await screen.findByText('Connected. 2 tools available.')
    expect(
      fetchMock.callHistory.calls('/ai-assist/connectors/conn-2/authorize')
    ).to.have.length(0)
  })

  it('asks to sign in only after the server says it needs it', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [{ ...MOCK_CONNECTOR_NEEDS_AUTH, status: 'disconnected' }],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/conn-2/refresh', {
      connector: { ...MOCK_CONNECTOR_NEEDS_AUTH, status: 'needs_auth' },
      next: 'authorize',
    })
    fetchMock.post('/ai-assist/connectors/conn-2/authorize', {
      authorizationUrl: 'https://auth.stripe.com/authorize',
    })

    render(<ConnectorsWidget />)

    fireEvent.click(
      await screen.findByRole('button', { name: /Connect Stripe API/i })
    )

    await screen.findByText(
      'This server requires you to sign in. Click Sign in to continue.'
    )
    expect(
      fetchMock.callHistory.calls('/ai-assist/connectors/conn-2/authorize')
    ).to.have.length(0)
  })

  it('shows the singular tool count', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [
        {
          ...MOCK_CONNECTOR_CONNECTED,
          tools: [MOCK_CONNECTOR_CONNECTED.tools[0]],
        },
      ],
      meta: MOCK_META,
    })

    render(<ConnectorsWidget />)

    expect(await screen.findByText('1 tool')).to.exist
  })

  it('retries loading connectors after a failure', async function () {
    fetchMock.get('/ai-assist/connectors', {
      status: 500,
      body: { error: 'Service unavailable' },
    })

    render(<ConnectorsWidget />)

    expect(await screen.findByText('Service unavailable')).to.exist

    fetchMock.removeRoutes()
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('GitHub Docs')).to.exist
  })

  it('tests a connected connector from its menu', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/conn-1/refresh', {
      connector: MOCK_CONNECTOR_CONNECTED,
      next: 'connected',
    })

    render(<ConnectorsWidget />)

    await openConnectorMenu('GitHub Docs')
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Test connection' })
    )

    await waitFor(() => {
      expect(
        fetchMock.callHistory.calls('/ai-assist/connectors/conn-1/refresh')
      ).to.have.length(1)
    })
  })

  it('refreshes tools and saves per-tool permissions', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [MOCK_CONNECTOR_CONNECTED],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/conn-1/refresh', {
      connector: MOCK_CONNECTOR_CONNECTED,
      next: 'connected',
    })
    fetchMock.patch('/ai-assist/connectors/conn-1', {
      connector: MOCK_CONNECTOR_CONNECTED,
    })

    render(<ConnectorsWidget />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Configure tools for GitHub Docs/i,
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => {
      expect(
        fetchMock.callHistory.calls('/ai-assist/connectors/conn-1/refresh')
      ).to.have.length(1)
    })

    fireEvent.change(screen.getByLabelText('Permission for search_docs'), {
      target: { value: 'block' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Allow all read-only' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    await waitFor(() => {
      const calls = fetchMock.callHistory.calls('/ai-assist/connectors/conn-1')
      expect(calls).to.have.length(1)
      const body = JSON.parse(calls[0].options.body as string)
      expect(body.toolPermissions).to.deep.equal({
        search_docs: 'allow',
        create_issue: 'ask',
      })
    })
  })

  it('discovers tools for a connector that has none yet', async function () {
    fetchMock.get('/ai-assist/connectors', {
      connectors: [{ ...MOCK_CONNECTOR_CONNECTED, tools: [] }],
      meta: MOCK_META,
    })
    fetchMock.post('/ai-assist/connectors/conn-1/refresh', {
      connector: MOCK_CONNECTOR_CONNECTED,
      next: 'connected',
    })

    render(<ConnectorsWidget />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Configure tools for GitHub Docs/i,
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Discover tools now' }))

    await waitFor(() => {
      expect(
        fetchMock.callHistory.calls('/ai-assist/connectors/conn-1/refresh')
      ).to.have.length(1)
    })
  })

  describe('connector card checks', function () {
    let clock: sinon.SinonFakeTimers | null = null

    afterEach(function () {
      clock?.restore()
      clock = null
      sinon.restore()
    })

    it('Connect asks the server to check first and reports the tools it found', async function () {
      fetchMock.get('/ai-assist/connectors', {
        connectors: [{ ...MOCK_CONNECTOR_NEEDS_AUTH, status: 'disconnected' }],
        meta: MOCK_META,
      })
      fetchMock.post('/ai-assist/connectors/conn-2/refresh', {
        connector: {
          ...MOCK_CONNECTOR_NEEDS_AUTH,
          status: 'connected',
          tools: [{ name: 'a' }, { name: 'b' }],
        },
        next: 'connected',
      })
      const open = sinon.stub(window, 'open')

      render(<ConnectorsWidget />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'Connect Stripe API' })
      )

      expect(await screen.findByText('Connected. 2 tools available.')).to.exist
      expect(
        fetchMock.callHistory.calls('/ai-assist/connectors/conn-2/refresh')
      ).to.have.length(1)
      expect(
        fetchMock.callHistory.calls('/ai-assist/connectors/conn-2/authorize')
      ).to.have.length(0)
      expect(open.called).to.be.false
      expect(bannerType('Connected. 2 tools available.')).to.contain(
        'notification-type-success'
      )
    })

    it('hides the Connected result after six seconds', async function () {
      fetchMock.get('/ai-assist/connectors', {
        connectors: [{ ...MOCK_CONNECTOR_NEEDS_AUTH, status: 'disconnected' }],
        meta: MOCK_META,
      })
      fetchMock.post('/ai-assist/connectors/conn-2/refresh', {
        connector: {
          ...MOCK_CONNECTOR_NEEDS_AUTH,
          status: 'connected',
          tools: [{ name: 'a' }, { name: 'b' }],
        },
        next: 'connected',
      })

      render(<ConnectorsWidget />)
      const connect = await screen.findByRole('button', {
        name: 'Connect Stripe API',
      })
      clock = useFakeTimers()
      fireEvent.click(connect)

      await until(clock, () => !!screen.queryByText('Connected. 2 tools available.'))
      await advance(clock, 5500)
      expect(screen.getByText('Connected. 2 tools available.')).to.exist
      await advance(clock, 600)
      expect(screen.queryByText('Connected. 2 tools available.')).to.be.null
    })

    it('Connect shows the sign-in notice only after the server asks, then offers Sign in', async function () {
      let current: ConnectorView = {
        ...MOCK_CONNECTOR_NEEDS_AUTH,
        status: 'disconnected',
      }
      fetchMock.get('/ai-assist/connectors', () => ({
        connectors: [current],
        meta: MOCK_META,
      }))
      fetchMock.post('/ai-assist/connectors/conn-2/refresh', () => {
        current = { ...MOCK_CONNECTOR_NEEDS_AUTH, status: 'needs_auth' }
        return { connector: current, next: 'authorize' }
      })
      fetchMock.post('/ai-assist/connectors/conn-2/authorize', {
        authorizationUrl: 'https://auth.stripe.com/authorize',
      })
      const open = sinon.stub(window, 'open')

      render(<ConnectorsWidget />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'Connect Stripe API' })
      )

      expect(
        await screen.findByText(
          'This server requires you to sign in. Click Sign in to continue.'
        )
      ).to.exist
      expect(bannerType('This server requires you to sign in. Click Sign in to continue.')).to.contain(
        'notification-type-warning'
      )
      expectNoDismiss(
        'This server requires you to sign in. Click Sign in to continue.'
      )
      // Once the list reloads, the card offers Sign in instead of Connect
      expect(
        await screen.findByRole('button', { name: 'Sign in to Stripe API' })
      ).to.exist
      expect(
        screen.queryByRole('button', { name: 'Connect Stripe API' })
      ).to.be.null
      expect(
        fetchMock.callHistory.calls('/ai-assist/connectors/conn-2/authorize')
      ).to.have.length(0)
      expect(open.called).to.be.false
    })

    it('Reconnect keeps a failure on screen until a later check succeeds', async function () {
      fetchMock.get('/ai-assist/connectors', {
        connectors: [MOCK_CONNECTOR_ERROR],
        meta: MOCK_META,
      })
      const replies: unknown[] = [
        {
          connector: {
            ...MOCK_CONNECTOR_ERROR,
            lastError: {
              message: 'Upstream returned 503',
              code: 'HTTP_503',
              at: '2026-10-15T10:00:00Z',
            },
          },
          next: 'error',
        },
        {
          connector: {
            ...MOCK_CONNECTOR_CONNECTED,
            tools: [{ name: 'a' }, { name: 'b' }],
          },
          next: 'connected',
        },
      ]
      fetchMock.post('/ai-assist/connectors/conn-3/refresh', () =>
        replies.shift()
      )

      render(<ConnectorsWidget />)
      const reconnect = await screen.findByRole('button', {
        name: /Reconnect Broken Server/i,
      })
      clock = useFakeTimers()
      fireEvent.click(reconnect)

      await until(clock, () => !!screen.queryByText('Upstream returned 503'))
      expect(bannerType('Upstream returned 503')).to.contain(
        'notification-type-error'
      )
      expectNoDismiss('Upstream returned 503')

      // Well past the success delay, the failure is still there
      await advance(clock, 7000)
      expect(screen.getByText('Upstream returned 503')).to.exist

      fireEvent.click(
        screen.getByRole('button', { name: /Reconnect Broken Server/i })
      )
      await until(clock, () => !!screen.queryByText('Connected. 2 tools available.'))
      expect(screen.queryByText('Upstream returned 503')).to.be.null
    })

    it('Sign in opens the sign-in window from the click and reports success', async function () {
      fetchMock.get('/ai-assist/connectors', {
        connectors: [MOCK_CONNECTOR_NEEDS_AUTH],
        meta: MOCK_META,
      })
      fetchMock.post('/ai-assist/connectors/conn-2/authorize', {
        authorizationUrl: 'https://auth.stripe.com/authorize',
      })
      const popup = fakePopup()
      const open = sinon.stub(window, 'open').returns(popup as unknown as Window)

      render(<ConnectorsWidget />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'Sign in to Stripe API' })
      )

      // The window is opened synchronously from the click
      expect(open.calledOnce).to.be.true
      await waitFor(() => {
        expect(
          fetchMock.callHistory.calls('/ai-assist/connectors/conn-2/authorize')
        ).to.have.length(1)
      })
      await waitFor(() => {
        expect(popup.location.href).to.not.equal('')
      })

      // The callback page reports that the sign-in finished
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: {
            type: 'ai-assist:connector-oauth',
            connectorId: 'conn-2',
            status: 'connected',
          },
          origin: window.location.origin,
        })
      )
      expect(await screen.findByText('Signed in and connected.')).to.exist
    })

    it('reports when the sign-in window closes without signing in, and frees the button', async function () {
      fetchMock.get('/ai-assist/connectors', {
        connectors: [MOCK_CONNECTOR_NEEDS_AUTH],
        meta: MOCK_META,
      })
      fetchMock.post('/ai-assist/connectors/conn-2/authorize', {
        authorizationUrl: 'https://auth.stripe.com/authorize',
      })
      const popup = fakePopup()
      sinon.stub(window, 'open').returns(popup as unknown as Window)

      render(<ConnectorsWidget />)
      const signIn = await screen.findByRole('button', {
        name: 'Sign in to Stripe API',
      })
      clock = useFakeTimers()
      fireEvent.click(signIn)
      await until(clock, () => popup.location.href !== '')

      // The user closes the window without signing in
      popup.closed = true
      await until(clock, () =>
        !!screen.queryByText(
          'Sign-in was not completed. Click Sign in to try again.'
        )
      )
      expect(bannerType('Sign-in was not completed. Click Sign in to try again.')).to.contain(
        'notification-type-warning'
      )
      expectNoDismiss(
        'Sign-in was not completed. Click Sign in to try again.'
      )

      const button = screen.getByRole('button', {
        name: 'Sign in to Stripe API',
      }) as HTMLButtonElement
      expect(button.disabled).to.be.false
      expect(button.getAttribute('data-ol-loading')).to.equal('false')
    })

    it('hides a passing Test connection result after six seconds', async function () {
      fetchMock.get('/ai-assist/connectors', {
        connectors: [MOCK_CONNECTOR_CONNECTED],
        meta: MOCK_META,
      })
      fetchMock.post('/ai-assist/connectors/conn-1/refresh', {
        connector: MOCK_CONNECTOR_CONNECTED,
        next: 'connected',
      })

      render(<ConnectorsWidget />)
      await openConnectorMenu('GitHub Docs')
      const test = await screen.findByRole('menuitem', {
        name: 'Test connection',
      })
      clock = useFakeTimers()
      fireEvent.click(test)

      await until(clock, () =>
        !!screen.queryByText('Connection works. 2 tools available.')
      )
      expectNoDismiss('Connection works. 2 tools available.')
      await advance(clock, 5500)
      expect(screen.getByText('Connection works. 2 tools available.')).to.exist
      await advance(clock, 600)
      expect(
        screen.queryByText('Connection works. 2 tools available.')
      ).to.be.null
    })

    it('keeps a failed Test connection result until a later test succeeds', async function () {
      fetchMock.get('/ai-assist/connectors', {
        connectors: [MOCK_CONNECTOR_CONNECTED],
        meta: MOCK_META,
      })
      const replies: unknown[] = [
        {
          connector: {
            ...MOCK_CONNECTOR_CONNECTED,
            status: 'error',
            lastError: {
              message: 'Upstream returned 503',
              at: '2026-10-15T10:00:00Z',
            },
          },
          next: 'error',
        },
        {
          connector: {
            ...MOCK_CONNECTOR_CONNECTED,
            tools: [{ name: 'a' }, { name: 'b' }],
          },
          next: 'connected',
        },
      ]
      fetchMock.post('/ai-assist/connectors/conn-1/refresh', () =>
        replies.shift()
      )

      render(<ConnectorsWidget />)
      await openConnectorMenu('GitHub Docs')
      const test = await screen.findByRole('menuitem', {
        name: 'Test connection',
      })
      clock = useFakeTimers()
      fireEvent.click(test)

      await until(clock, () => !!screen.queryByText('Upstream returned 503'))
      expect(bannerType('Upstream returned 503')).to.contain(
        'notification-type-error'
      )
      expectNoDismiss('Upstream returned 503')

      await advance(clock, 7000)
      expect(screen.getByText('Upstream returned 503')).to.exist

      // Run the test again; a pass replaces the failure
      fireEvent.click(
        screen.getByRole('button', { name: 'More actions for GitHub Docs' })
      )
      await until(clock, () =>
        !!screen.queryByRole('menuitem', { name: 'Test connection' })
      )
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Test connection' })
      )
      await until(clock, () =>
        !!screen.queryByText('Connection works. 2 tools available.')
      )
      expect(screen.queryByText('Upstream returned 503')).to.be.null
      await advance(clock, 6100)
      expect(
        screen.queryByText('Connection works. 2 tools available.')
      ).to.be.null
    })
  })
})
