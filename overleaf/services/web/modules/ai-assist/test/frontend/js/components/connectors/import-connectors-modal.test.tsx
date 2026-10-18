import { expect } from 'chai'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { ImportConnectorsModal } from '../../../../../frontend/js/features/ai-assist/components/connectors/import-connectors-modal'
import {
  ConnectorView,
  ImportResult,
} from '../../../../../frontend/js/features/ai-assist/connectors/types'
import { CONNECTORS_CHANGED_EVENT } from '../../../../../frontend/js/features/ai-assist/connectors/api'

const CONFIG = JSON.stringify({
  mcpServers: {
    docs: { type: 'http', url: 'https://mcp.example.com/mcp' },
    local: { command: 'node', args: ['server.js'] },
  },
})

function connectorView(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: 'conn-imported',
    name: 'docs',
    url: 'https://mcp.example.com/mcp',
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

function setMeta() {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
}

let changed = 0
const onChanged = () => {
  changed += 1
}

function renderModal() {
  render(<ImportConnectorsModal show onHide={() => {}} />)
  // The widget refetches on this event
  return { getImportedCount: () => changed }
}

function importCalls() {
  return fetchMock.callHistory.calls('/ai-assist/connectors/import')
}

describe('ImportConnectorsModal', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    setMeta()
    changed = 0
    window.addEventListener(CONNECTORS_CHANGED_EVENT, onChanged)
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    window.removeEventListener(CONNECTORS_CHANGED_EVENT, onChanged)
  })

  it('keeps Import disabled until a configuration is pasted', function () {
    renderModal()
    const importBtn = screen.getByRole('button', {
      name: 'Import',
    }) as HTMLButtonElement
    expect(importBtn.disabled).to.be.true

    fireEvent.change(screen.getByLabelText('MCP configuration (JSON)'), {
      target: { value: CONFIG },
    })
    expect(importBtn.disabled).to.be.false
  })

  it('posts the pasted config and renders created and skipped results', async function () {
    const result: ImportResult = {
      created: [
        {
          connector: connectorView({ id: 'conn-9', name: 'docs' }),
          next: 'connected',
        },
      ],
      skipped: [
        {
          name: 'local',
          reason: 'Local stdio servers cannot be added as connectors',
        },
      ],
    }
    fetchMock.post('/ai-assist/connectors/import', result)

    const { getImportedCount } = renderModal()

    fireEvent.change(screen.getByLabelText('MCP configuration (JSON)'), {
      target: { value: CONFIG },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => {
      expect(importCalls()).to.have.length(1)
    })
    const body = JSON.parse(importCalls()[0].options.body as string)
    expect(body).to.deep.equal({ config: CONFIG })

    expect(await screen.findByText('Added docs.')).to.exist
    expect(
      screen.getByText(
        'local: Local stdio servers cannot be added as connectors'
      )
    ).to.exist
    expect(getImportedCount()).to.equal(1)

    // After an import the footer offers Close instead of Cancel.
    expect(screen.getByRole('button', { name: 'Close' })).to.exist
  })

  it('names every imported connector that still needs a sign-in', async function () {
    fetchMock.post('/ai-assist/connectors/import', {
      created: [
        {
          connector: connectorView({ id: 'a', name: 'bigquery' }),
          next: 'authorize',
        },
        {
          connector: connectorView({ id: 'b', name: 'maps' }),
          next: 'authorize',
        },
        {
          connector: connectorView({ id: 'c', name: 'docs' }),
          next: 'connected',
        },
      ],
      skipped: [],
    })

    renderModal()
    fireEvent.change(screen.getByLabelText('MCP configuration (JSON)'), {
      target: { value: CONFIG },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(
      await screen.findByText(
        'Sign in from the connector card: bigquery, maps.'
      )
    ).to.exist
  })

  it('shows only skipped reasons when nothing was created', async function () {
    fetchMock.post('/ai-assist/connectors/import', {
      created: [],
      skipped: [{ name: 'local', reason: 'No remote URL' }],
    })

    renderModal()
    fireEvent.change(screen.getByLabelText('MCP configuration (JSON)'), {
      target: { value: CONFIG },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText('local: No remote URL')).to.exist
    expect(screen.queryByText(/^Added /)).to.be.null
  })

  it('shows the server error when the configuration is rejected', async function () {
    fetchMock.post('/ai-assist/connectors/import', {
      status: 400,
      body: { error: 'Could not read the JSON configuration' },
    })

    const { getImportedCount } = renderModal()
    fireEvent.change(screen.getByLabelText('MCP configuration (JSON)'), {
      target: { value: '{ not json' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText('Could not read the JSON configuration')).to
      .exist
    expect(getImportedCount()).to.equal(0)
  })
})
