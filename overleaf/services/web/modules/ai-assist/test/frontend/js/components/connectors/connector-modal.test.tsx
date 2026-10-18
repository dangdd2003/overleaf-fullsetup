import { expect } from 'chai'
import { useState } from 'react'
import sinon from 'sinon'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import {
  ConnectorModal,
  isSensitiveHeaderKey,
} from '../../../../../frontend/js/features/ai-assist/components/connectors/connector-modal'
import {
  ConnectNext,
  ConnectorInput,
  ConnectorView,
  ConnectorsMeta,
} from '../../../../../frontend/js/features/ai-assist/connectors/types'

const META: ConnectorsMeta = {
  redirectUri:
    'https://overleaf.example.com/ai-assist/connectors/oauth/callback',
  clientMetadataUrl: null,
}

const SIGN_IN_NEEDED =
  'This server requires you to sign in. Click Sign in to finish adding it.'
const SIGN_IN_NOT_COMPLETED =
  'Sign-in was not completed. Click Sign in to try again.'

function setMeta() {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
}

function connectorView(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: 'conn-new',
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
  }
}

function renderAddModal() {
  const onSaved = () => {}
  const onHide = () => {}
  render(
    <ConnectorModal
      show
      onHide={onHide}
      connector={null}
      onSaved={onSaved}
      meta={META}
    />
  )
}

/** Keeps the modal's `show` state in the test, so closing it can be observed. */
function ModalHarness({
  connector = null,
  onSaved,
  onHide,
}: {
  connector?: ConnectorView | null
  onSaved: (connector: ConnectorView, next: ConnectNext) => void
  onHide: () => void
}) {
  const [show, setShow] = useState(true)
  return (
    <ConnectorModal
      show={show}
      connector={connector}
      meta={META}
      onSaved={onSaved}
      onHide={() => {
        onHide()
        setShow(false)
      }}
    />
  )
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText(/e\.g\. Stripe API/i), {
    target: { value: 'Docs' },
  })
  fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com'), {
    target: { value: 'https://docs.example.com/mcp' },
  })
}

function renderEditModal(connector: ConnectorView) {
  render(
    <ConnectorModal
      show
      onHide={() => {}}
      connector={connector}
      onSaved={() => {}}
      meta={META}
    />
  )
}

function patchCalls(id: string) {
  return fetchMock.callHistory.calls(`/ai-assist/connectors/${id}`)
}

function createCalls() {
  return fetchMock.callHistory
    .calls()
    .filter(
      c =>
        c.url.endsWith('/ai-assist/connectors') &&
        c.options.method?.toUpperCase() === 'POST'
    )
}

function submittedInput(): ConnectorInput {
  return JSON.parse(createCalls()[0].options.body as string)
}

// The bootstrap BroadcastChannel stub has no close(), which the OAuth popup
// calls when it settles. Installed for this suite only.
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

describe('ConnectorModal', function () {
  const originalChannel = globalThis.BroadcastChannel
  let clock: sinon.SinonFakeTimers | null = null

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
    setMeta()
  })

  afterEach(function () {
    clock?.restore()
    clock = null
    sinon.restore()
    fetchMock.removeRoutes().clearHistory()
  })

  describe('authentication mode', function () {
    it('defaults to sign in when needed', function () {
      renderAddModal()

      const select = screen.getByLabelText(
        'Authentication Mode'
      ) as HTMLSelectElement
      expect(select.value).to.equal('auto')
      expect(select.selectedOptions[0].text).to.equal(
        'Sign in when needed (Recommended)'
      )
      expect(
        Array.from(select.options).map(option => option.value)
      ).to.deep.equal(['auto', 'oauth', 'none'])
    })

    it('submits the default mode when the user does not change it', async function () {
      fetchMock.post('/ai-assist/connectors', {
        connector: connectorView(),
        next: 'connected',
      })
      renderAddModal()
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))

      await waitFor(() => {
        expect(createCalls()).to.have.length(1)
      })
      expect(submittedInput().authMode).to.equal('auto')
    })
  })

  describe('request headers', function () {
    it('lets the user add more than eight headers', function () {
      renderAddModal()
      fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

      const addHeader = screen.getByRole('button', {
        name: 'Add header',
      }) as HTMLButtonElement
      for (let i = 0; i < 10; i++) {
        fireEvent.click(addHeader)
      }

      expect(addHeader.disabled).to.be.false
      expect(screen.getByLabelText('Header 10 name')).to.exist
      expect(document.body.textContent).not.to.contain('/8)')
    })
  })

  describe('tool call timeout', function () {
    it('sends the timeout in seconds when one is entered', async function () {
      fetchMock.post('/ai-assist/connectors', {
        connector: connectorView({ timeoutSeconds: 45 }),
        next: 'connected',
      })
      renderAddModal()
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
      fireEvent.change(
        screen.getByLabelText('Tool call timeout in seconds (optional)'),
        { target: { value: '45' } }
      )
      fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))

      await waitFor(() => {
        expect(createCalls()).to.have.length(1)
      })
      expect(submittedInput().timeoutSeconds).to.equal(45)
    })

    it('sends no timeout when the field is left blank', async function () {
      fetchMock.post('/ai-assist/connectors', {
        connector: connectorView(),
        next: 'connected',
      })
      renderAddModal()
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))

      await waitFor(() => {
        expect(createCalls()).to.have.length(1)
      })
      expect(submittedInput().timeoutSeconds).to.be.null
    })
  })

  describe('request header masking', function () {
    it('treats credential-like header names as sensitive', function () {
      expect(isSensitiveHeaderKey('Authorization')).to.be.true
      expect(isSensitiveHeaderKey('proxy-authorization')).to.be.true
      expect(isSensitiveHeaderKey('X-Api-Key')).to.be.true
      expect(isSensitiveHeaderKey('X-Auth-Token')).to.be.true
      expect(isSensitiveHeaderKey('Accept')).to.be.false
      expect(isSensitiveHeaderKey('')).to.be.false
    })

    it('masks a sensitive value until the user reveals it', function () {
      renderAddModal()
      fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add header' }))
      fireEvent.change(screen.getByLabelText('Header 1 name'), {
        target: { value: 'Authorization' },
      })

      const value = screen.getByLabelText('Header 1 value') as HTMLInputElement
      expect(value.type).to.equal('password')

      fireEvent.click(screen.getByRole('button', { name: 'Show header value' }))
      expect(value.type).to.equal('text')
    })

    it('removes a header row', function () {
      renderAddModal()
      fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add header' }))
      fireEvent.click(screen.getByRole('button', { name: 'Remove header 1' }))

      expect(screen.queryByLabelText('Header 1 name')).to.be.null
    })

    it('sends header names and values, trimming blank names', async function () {
      fetchMock.post('/ai-assist/connectors', {
        connector: connectorView(),
        next: 'connected',
      })
      renderAddModal()
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add header' }))
      fireEvent.change(screen.getByLabelText('Header 1 name'), {
        target: { value: ' X-Api-Key ' },
      })
      fireEvent.change(screen.getByLabelText('Header 1 value'), {
        target: { value: 'abc123' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Add header' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))

      await waitFor(() => {
        expect(createCalls()).to.have.length(1)
      })
      expect(submittedInput().headers).to.deep.equal([
        { name: 'X-Api-Key', value: 'abc123', keep: false },
      ])
    })
  })

  describe('connection test', function () {
    it('shows the reason when the server cannot be reached', async function () {
      fetchMock.post('/ai-assist/connectors/probe', {
        ok: false,
        reachable: false,
        requiresAuth: false,
        error: 'DNS lookup failed',
      })
      renderAddModal()
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

      expect(await screen.findByText('Test failed')).to.exist
      expect(screen.getByText('DNS lookup failed')).to.exist
    })

    it('switches to a custom OAuth client for a preset that needs one', async function () {
      fetchMock.post('/ai-assist/connectors/probe', {
        ok: true,
        reachable: true,
        requiresAuth: true,
        preset: {
          id: 'google',
          label: 'Google',
          needsClient: true,
          clientHelpUrl: 'https://console.cloud.google.com',
        },
      })
      renderAddModal()
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

      expect(await screen.findByText('Server reachable')).to.exist
      expect(screen.getByText(/Google MCP servers sign in with Google/)).to
        .exist
      const mode = screen.getByLabelText(
        'OAuth Client Registration'
      ) as HTMLSelectElement
      expect(mode.value).to.equal('custom')
    })

    it('warns when the URL is plain HTTP', function () {
      renderAddModal()
      fireEvent.change(screen.getByPlaceholderText('https://mcp.example.com'), {
        target: { value: 'http://insecure.example.com' },
      })

      expect(screen.getByText(/HTTP URLs are insecure/)).to.exist
    })
  })

  describe('saving verifies the server', function () {
    it('closes the dialog once a new connector connects', async function () {
      fetchMock.post('/ai-assist/connectors', {
        connector: connectorView({ id: 'conn-ok' }),
        next: 'connected',
      })
      const onSaved = sinon.spy()
      const onHide = sinon.spy()
      render(<ModalHarness onSaved={onSaved} onHide={onHide} />)
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))

      await waitFor(() => {
        expect(onSaved.calledOnce).to.be.true
      })
      expect(onSaved.firstCall.args[0].id).to.equal('conn-ok')
      expect(onSaved.firstCall.args[1]).to.equal('connected')
      expect(onHide.calledOnce).to.be.true
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).to.be.null
      })
    })

    it('closes the dialog when an edit is saved and the server gives no next step', async function () {
      const existing = connectorView({ id: 'conn-close', name: 'Docs' })
      fetchMock.patch('/ai-assist/connectors/conn-close', {
        connector: existing,
      })
      const onSaved = sinon.spy()
      const onHide = sinon.spy()
      render(
        <ModalHarness connector={existing} onSaved={onSaved} onHide={onHide} />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

      await waitFor(() => {
        expect(onSaved.calledOnce).to.be.true
      })
      expect(onSaved.firstCall.args[1]).to.equal('connected')
      expect(onHide.calledOnce).to.be.true
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).to.be.null
      })
    })

    it('asks for sign-in without authorizing until Sign in is clicked', async function () {
      const needsSignIn = connectorView({
        id: 'conn-auth',
        status: 'needs_auth',
      })
      fetchMock.post('/ai-assist/connectors', {
        connector: needsSignIn,
        next: 'authorize',
      })
      fetchMock.post('/ai-assist/connectors/conn-auth/authorize', {
        authorizationUrl: 'https://auth.example.com/authorize',
      })
      const popup = fakePopup()
      const open = sinon
        .stub(window, 'open')
        .returns(popup as unknown as Window)
      const onSaved = sinon.spy()
      const onHide = sinon.spy()
      render(<ModalHarness onSaved={onSaved} onHide={onHide} />)
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))

      expect(await screen.findByText(SIGN_IN_NEEDED)).to.exist
      expect(screen.getByRole('dialog')).to.exist
      expect(screen.queryByRole('button', { name: 'Add connector' })).to.be
        .null
      expect(screen.getByRole('button', { name: 'Sign in' })).to.exist
      expect(createCalls()).to.have.length(1)
      expect(
        fetchMock.callHistory.calls('/ai-assist/connectors/conn-auth/authorize')
      ).to.have.length(0)
      expect(open.called).to.be.false
      expect(onSaved.called).to.be.false
      expect(onHide.called).to.be.false

      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

      await waitFor(() => {
        expect(
          fetchMock.callHistory.calls(
            '/ai-assist/connectors/conn-auth/authorize'
          )
        ).to.have.length(1)
      })
      expect(open.calledOnce).to.be.true

      // The callback page reports that the sign-in finished
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: {
            type: 'ai-assist:connector-oauth',
            connectorId: 'conn-auth',
            status: 'connected',
          },
          origin: window.location.origin,
        })
      )

      await waitFor(() => {
        expect(onSaved.calledOnce).to.be.true
      })
      expect(onSaved.firstCall.args[1]).to.equal('connected')
      expect(onHide.calledOnce).to.be.true
    })

    it('stays open on a failed save and saves that connector again on the next save', async function () {
      const failed = connectorView({
        id: 'conn-err',
        status: 'error',
        lastError: {
          message: 'Upstream returned 503',
          at: '2026-10-15T10:00:00Z',
        },
      })
      fetchMock.post('/ai-assist/connectors', {
        connector: failed,
        next: 'error',
      })
      fetchMock.patch('/ai-assist/connectors/conn-err', {
        connector: {
          ...failed,
          lastError: { message: 'Still failing', at: '2026-10-15T10:01:00Z' },
        },
        next: 'error',
      })
      const onSaved = sinon.spy()
      const onHide = sinon.spy()
      render(<ModalHarness onSaved={onSaved} onHide={onHide} />)
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))

      expect(await screen.findByText('Upstream returned 503')).to.exist
      expect(screen.getByRole('dialog')).to.exist
      expectNoDismiss('Upstream returned 503')
      expect(onSaved.called).to.be.false
      expect(onHide.called).to.be.false
      expect(screen.queryByRole('button', { name: 'Add connector' })).to.be
        .null

      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

      expect(await screen.findByText('Still failing')).to.exist
      expect(createCalls()).to.have.length(1)
      expect(patchCalls('conn-err')).to.have.length(1)
      expect(screen.queryByText('Upstream returned 503')).to.be.null
      expect(onSaved.called).to.be.false
    })
  })

  describe('sign-in cancelled', function () {
    it('says sign-in was not completed when the sign-in window is closed', async function () {
      clock = useFakeTimers()
      const needsSignIn = connectorView({
        id: 'conn-cancel',
        status: 'needs_auth',
      })
      fetchMock.post('/ai-assist/connectors', {
        connector: needsSignIn,
        next: 'authorize',
      })
      fetchMock.post('/ai-assist/connectors/conn-cancel/authorize', {
        authorizationUrl: 'https://auth.example.com/authorize',
      })
      fetchMock.get('/ai-assist/connectors', {
        connectors: [needsSignIn],
        meta: META,
      })
      const popup = fakePopup()
      sinon.stub(window, 'open').returns(popup as unknown as Window)
      const onSaved = sinon.spy()
      const onHide = sinon.spy()
      render(<ModalHarness onSaved={onSaved} onHide={onHide} />)
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))
      await until(clock, () => !!screen.queryByText(SIGN_IN_NEEDED))

      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await until(clock, () => popup.location.href !== '')

      // The user closes the window without signing in
      popup.closed = true
      await until(clock, () => !!screen.queryByText(SIGN_IN_NOT_COMPLETED))

      expect(onSaved.called).to.be.false
      expect(onHide.called).to.be.false
      expect(screen.getByRole('dialog')).to.exist
      expect(screen.getByRole('button', { name: 'Sign in' })).to.exist
    })
  })

  describe('test connection banners', function () {
    it('hides a passing result after six seconds', async function () {
      clock = useFakeTimers()
      fetchMock.post('/ai-assist/connectors/probe', {
        ok: true,
        reachable: true,
        requiresAuth: false,
        era: 'modern',
        toolCount: 3,
      })
      renderAddModal()
      fillRequiredFields()
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
      await until(clock, () => !!screen.queryByText('Server reachable'))

      const passing = screen
        .getByText('Server reachable')
        .closest('.connector-modal-probe-results')
      expect(passing!.querySelector('button')).to.be.null

      await advance(clock, 5500)
      expect(screen.getByText('Server reachable')).to.exist

      await advance(clock, 600)
      expect(screen.queryByText('Server reachable')).to.be.null
    })

    it('keeps a failing result until a test passes', async function () {
      clock = useFakeTimers()
      const probeReplies = [
        {
          ok: false,
          reachable: false,
          requiresAuth: false,
          error: 'DNS lookup failed',
        },
        {
          ok: false,
          reachable: true,
          requiresAuth: false,
          error: 'Connection refused by server',
        },
        {
          ok: true,
          reachable: true,
          requiresAuth: false,
          era: 'modern',
          toolCount: 1,
        },
      ]
      fetchMock.post('/ai-assist/connectors/probe', () => probeReplies.shift())
      renderAddModal()
      fillRequiredFields()
      const testButton = () =>
        screen.getByRole('button', { name: 'Test connection' })

      // First failure stays up well past the success delay
      fireEvent.click(testButton())
      await until(clock, () => !!screen.queryByText('DNS lookup failed'))
      await advance(clock, 7000)
      expect(screen.getByText('Test failed')).to.exist
      expect(screen.getByText('DNS lookup failed')).to.exist
      expectNoDismiss('DNS lookup failed')

      // A new failing test replaces the message and stays too
      fireEvent.click(testButton())
      await until(clock, () =>
        !!screen.queryByText('Connection refused by server')
      )
      expect(screen.queryByText('DNS lookup failed')).to.be.null
      expect(screen.getByText('Test failed')).to.exist
      await advance(clock, 7000)
      expect(screen.getByText('Connection refused by server')).to.exist
      expectNoDismiss('Connection refused by server')

      // A passing test clears the failure and its own banner goes away later
      fireEvent.click(testButton())
      await until(clock, () => !!screen.queryByText('Server reachable'))
      expect(screen.queryByText('Test failed')).to.be.null
      expect(screen.queryByText('Connection refused by server')).to.be.null
      await advance(clock, 5500)
      expect(screen.getByText('Server reachable')).to.exist
      await advance(clock, 600)
      expect(screen.queryByText('Server reachable')).to.be.null
    })
  })

  describe('editing', function () {
    it('saves changes with a PATCH and keeps the saved client secret', async function () {
      const existing = connectorView({
        id: 'conn-edit',
        name: 'Old name',
        oauth: {
          clientMode: 'custom',
          clientId: 'client-123',
          hasClientSecret: true,
          scopes: '',
          authorizationUrl: '',
          tokenUrl: '',
          tokenEndpointAuthMethod: 'auto',
          extraParams: [],
          issuer: null,
          registration: 'custom',
          grantedScopes: null,
          expiresAt: null,
          hasRefreshToken: false,
        },
      })
      fetchMock.patch('/ai-assist/connectors/conn-edit', {
        connector: { ...existing, name: 'New name' },
      })
      renderEditModal(existing)

      expect(screen.getByRole('heading', { name: 'Edit connector' })).to.exist
      fireEvent.change(screen.getByLabelText(/Name/, { selector: 'input' }), {
        target: { value: 'New name' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))

      const keep = screen.getByLabelText(
        'Keep saved secret (leave unchecked to replace)'
      ) as HTMLInputElement
      expect(keep.checked).to.be.true

      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

      await waitFor(() => {
        expect(patchCalls('conn-edit')).to.have.length(1)
      })
      const body = JSON.parse(patchCalls('conn-edit')[0].options.body as string)
      expect(body.name).to.equal('New name')
      expect(body.oauth.keepClientSecret).to.be.true
      expect(body.oauth.clientSecret).to.be.undefined
    })
  })
})
