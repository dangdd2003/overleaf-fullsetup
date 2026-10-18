import { expect } from 'chai'
import sinon from 'sinon'
import customLocalStorage from '@/infrastructure/local-storage'
import { render, screen, fireEvent } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import WebSearchForm from '../../../../frontend/js/features/ai-assist/components/web-search-form'
import { MultiWebSearchSettings } from '../../../../frontend/js/features/ai-assist/providers/types'

function setMeta() {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">' +
    '<meta name="ol-aiAssistServerWebSearchEnabled" data-type="boolean" content="">' +
    '<meta name="ol-csrfToken" content="test-token">'
}

describe('WebSearchForm', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    setMeta()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('renders an add provider box rather than listing all providers in full', function () {
    render(
      <WebSearchForm
        initial={{ sourceMode: 'custom', providers: {} }}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )

    // Should show the add provider box
    expect(screen.getByText(/add search provider/i)).to.exist
    // Should NOT have full provider cards for all providers
    expect(screen.queryByText(/tavily dashboard/i)).to.be.null
    expect(screen.queryByText(/firecrawl dashboard/i)).to.be.null
  })

  it('opens provider dropdown when clicking add provider box', function () {
    render(
      <WebSearchForm
        initial={{ sourceMode: 'custom', providers: {} }}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )

    const addBox = screen.getByText(/add search provider/i)
    fireEvent.click(addBox)

    expect(screen.getByLabelText(/select provider to add/i)).to.exist
    expect(screen.getByRole('option', { name: /tavily/i })).to.exist
    expect(screen.getByRole('option', { name: /searxng/i })).to.exist
  })

  it('allows choosing a provider to configure and adding it', function () {
    const onSave = sinon.spy()
    render(
      <WebSearchForm
        initial={{ sourceMode: 'custom', providers: {} }}
        onSave={onSave}
        onCancel={() => {}}
      />
    )

    // Click add provider box
    fireEvent.click(screen.getByText(/add search provider/i))

    // Select Tavily from dropdown
    const select = screen.getByLabelText(/select provider to add/i)
    fireEvent.change(select, { target: { value: 'tavily' } })

    // Configuration fields for Tavily should appear
    expect(screen.getByPlaceholderText('tvly-...')).to.exist

    // Add button should be disabled until key is provided
    const addButton = screen.getByRole('button', { name: /add tavily/i })
    expect((addButton as HTMLButtonElement).disabled).to.be.true

    // Enter API key
    const keyInput = screen.getByPlaceholderText('tvly-...')
    fireEvent.change(keyInput, { target: { value: 'tvly-secret-123' } })
    expect((addButton as HTMLButtonElement).disabled).to.be.false

    // Click Add Tavily
    fireEvent.click(addButton)

    // Now Tavily should appear in the added providers list (folded immediately)
    expect(screen.getByText(/1 API key/i)).to.exist
    expect(screen.getByRole('button', { name: /configure tavily/i })).to.exist
    expect(screen.getByRole('button', { name: /remove tavily/i })).to.exist

    // Save form
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSave.calledOnce).to.be.true
    const saved = onSave.firstCall.args[0] as MultiWebSearchSettings
    expect(saved.providers?.tavily?.enabled).to.be.true
    expect(saved.providers?.tavily?.apiKeys).to.deep.equal(['tvly-secret-123'])
    expect(saved.providers?.searxng).to.be.undefined
  })

  it('allows adding and configuring Exa provider with search and read options', function () {
    const onSave = sinon.spy()
    render(
      <WebSearchForm
        initial={{ sourceMode: 'custom', providers: {} }}
        onSave={onSave}
        onCancel={() => {}}
      />
    )

    // Click add provider box
    fireEvent.click(screen.getByText(/add search provider/i))

    // Select Exa from dropdown
    const select = screen.getByLabelText(/select provider to add/i)
    fireEvent.change(select, { target: { value: 'exa' } })

    // Configuration fields for Exa should appear
    expect(screen.getByPlaceholderText('Exa API key')).to.exist

    // Enter API key
    const keyInput = screen.getByPlaceholderText('Exa API key')
    fireEvent.change(keyInput, { target: { value: 'exa-key-test-456' } })

    // Click Add Exa
    const addButton = screen.getByRole('button', { name: /add exa/i })
    fireEvent.click(addButton)

    // Verify Exa appears in the added providers list folded immediately
    expect(screen.getByText(/1 API key/i)).to.exist
    expect(screen.getByRole('button', { name: /configure exa/i })).to.exist

    // Save form
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSave.calledOnce).to.be.true
    const saved = onSave.firstCall.args[0] as MultiWebSearchSettings
    expect(saved.providers?.exa?.enabled).to.be.true
    expect(saved.providers?.exa?.apiKeys).to.deep.equal(['exa-key-test-456'])
  })

  it('allows adding and configuring Parallel provider with search and read options', function () {
    const onSave = sinon.spy()
    render(
      <WebSearchForm
        initial={{ sourceMode: 'custom', providers: {} }}
        onSave={onSave}
        onCancel={() => {}}
      />
    )

    // Click add provider box
    fireEvent.click(screen.getByText(/add search provider/i))

    // Select Parallel from dropdown
    const select = screen.getByLabelText(/select provider to add/i)
    fireEvent.change(select, { target: { value: 'parallel' } })

    // Configuration fields for Parallel should appear
    expect(screen.getByPlaceholderText('Parallel API key')).to.exist

    // Enter API key
    const keyInput = screen.getByPlaceholderText('Parallel API key')
    fireEvent.change(keyInput, { target: { value: 'parallel-key-test-789' } })

    // Click Add Parallel
    const addButton = screen.getByRole('button', { name: /add parallel/i })
    fireEvent.click(addButton)

    // Verify Parallel appears in the added providers list folded immediately
    expect(screen.getByText(/1 API key/i)).to.exist
    expect(screen.getByRole('button', { name: /configure parallel/i })).to
      .exist

    // Save form
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSave.calledOnce).to.be.true
    const saved = onSave.firstCall.args[0] as MultiWebSearchSettings
    expect(saved.providers?.parallel?.enabled).to.be.true
    expect(saved.providers?.parallel?.apiKeys).to.deep.equal(['parallel-key-test-789'])
  })

  it('allows removing an added provider', function () {
    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        tavily: {
          enabled: true,
          apiKeys: ['tvly-123'],
        },
      },
    }

    const onSave = sinon.spy()
    render(
      <WebSearchForm initial={initial} onSave={onSave} onCancel={() => {}} />
    )

    // Tavily is in added list
    expect(screen.getByText(/1 API key/i)).to.exist

    // Remove Tavily
    const removeBtn = screen.getByRole('button', { name: /remove tavily/i })
    fireEvent.click(removeBtn)

    // Tavily should no longer be in added providers
    expect(screen.queryByText(/1 API key/i)).to.be.null
    expect(screen.getByText(/no search providers added yet/i)).to.exist
  })

  it('allows expanding and editing an added provider', function () {
    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        searxng: {
          enabled: true,
          baseUrls: ['http://searxng:8080'],
        },
      },
    }

    render(
      <WebSearchForm initial={initial} onSave={() => {}} onCancel={() => {}} />
    )

    // Initially collapsed: categories input is not visible
    expect(screen.queryByLabelText(/default categories/i)).to.be.null

    // Click Edit
    fireEvent.click(screen.getByRole('button', { name: /configure searxng/i }))

    // Now categories input is visible
    expect(screen.getByLabelText(/default categories/i)).to.exist

    // Click Done to collapse
    fireEvent.click(
      screen.getByRole('button', { name: /done configuring searxng/i })
    )

    expect(screen.queryByLabelText(/default categories/i)).to.be.null
  })

  it('allows switching to server default search via top radio', function () {
    const onSave = sinon.spy()
    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        searxng: {
          enabled: true,
          baseUrls: ['http://searxng:8080'],
        },
      },
    }

    render(
      <WebSearchForm initial={initial} onSave={onSave} onCancel={() => {}} />
    )

    const serverRadio = screen.getByLabelText(/server default search/i)
    fireEvent.click(serverRadio)

    expect(screen.getByText(/pre-configured web search/i)).to.exist

    // Save form
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSave.calledOnce).to.be.true
    const saved = onSave.firstCall.args[0] as MultiWebSearchSettings
    expect(saved.sourceMode).to.equal('server')
  })

  it('tests web search successfully when configuring Parallel in draft mode before adding', async function () {
    fetchMock.post('/ai-assist/web-search/test', {
      latencyMs: 88,
      resultCount: 4,
      activeEndpoints: 1,
      provider: 'parallel',
    })

    render(
      <WebSearchForm
        initial={{ sourceMode: 'custom', providers: {} }}
        onSave={() => {}}
        onCancel={() => {}}
      />
    )

    // Open add provider box
    fireEvent.click(screen.getByText(/add search provider/i))

    // Select Parallel
    const select = screen.getByLabelText(/select provider to add/i)
    fireEvent.change(select, { target: { value: 'parallel' } })

    // Enter Parallel API key
    const keyInput = screen.getByPlaceholderText('Parallel API key')
    fireEvent.change(keyInput, { target: { value: 'sk-parallel-test-123' } })

    // Click "Test search" directly at the bottom without clicking "Add Parallel"
    const testButton = screen.getByRole('button', { name: /test search/i })
    expect((testButton as HTMLButtonElement).disabled).to.be.false
    fireEvent.click(testButton)

    // Should display success message with latency and provider
    expect(await screen.findByText(/Search answered in 88 ms/)).to.exist
    expect(screen.getByText(/via parallel/i)).to.exist

    const lastCall = fetchMock.callHistory.lastCall(
      '/ai-assist/web-search/test'
    )
    const body = JSON.parse(lastCall?.options.body as string)
    expect(body.webSearchSettings.providers.parallel.apiKeys).to.deep.equal([
      'sk-parallel-test-123',
    ])
    expect(body.webSearchSettings.providers.parallel.enabled).to.be.true
    expect(body.webSearchSettings.forTest).to.be.true
  })

  it('tests web search successfully when Parallel is added and enabled', async function () {
    fetchMock.post('/ai-assist/web-search/test', {
      latencyMs: 95,
      resultCount: 5,
      activeEndpoints: 1,
      provider: 'parallel',
    })

    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        parallel: {
          enabled: true,
          apiKeys: ['sk-parallel-saved'],
        },
      },
    }

    render(
      <WebSearchForm initial={initial} onSave={() => {}} onCancel={() => {}} />
    )

    const testButton = screen.getByRole('button', { name: /test search/i })
    expect((testButton as HTMLButtonElement).disabled).to.be.false
    fireEvent.click(testButton)

    expect(await screen.findByText(/Search answered in 95 ms/)).to.exist
    const lastCall = fetchMock.callHistory.lastCall(
      '/ai-assist/web-search/test'
    )
    const body = JSON.parse(lastCall?.options.body as string)
    expect(body.webSearchSettings.providers.parallel.apiKeys).to.deep.equal([
      'sk-parallel-saved',
    ])
  })

  it('excludes toggled-off providers from test payload and tests only enabled providers', async function () {
    fetchMock.post('/ai-assist/web-search/test', {
      latencyMs: 102,
      anySuccess: true,
      providers: [
        {
          provider: 'tavily',
          searchable: true,
          latencyMs: 102,
          keys: [
            {
              index: 1,
              label: 'Key 1',
              target: 'sk-t****on',
              status: 'works',
              message: 'Works (Searchable, 1 result in 102 ms)',
              latencyMs: 102,
              resultCount: 1,
            },
          ],
        },
      ],
      activeEndpoints: 1,
      provider: 'tavily',
    })

    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        parallel: {
          enabled: false,
          apiKeys: ['sk-parallel-off'],
        },
        tavily: {
          enabled: true,
          apiKeys: ['sk-tavily-on'],
        },
      },
    }

    render(
      <WebSearchForm initial={initial} onSave={() => {}} onCancel={() => {}} />
    )

    const testButton = screen.getByRole('button', { name: /test search/i })
    expect((testButton as HTMLButtonElement).disabled).to.be.false
    fireEvent.click(testButton)

    expect(await screen.findByText(/Web search health check: Operational/i)).to.exist
    const lastCall = fetchMock.callHistory.lastCall(
      '/ai-assist/web-search/test'
    )
    const body = JSON.parse(lastCall?.options.body as string)
    expect(body.webSearchSettings.providers.tavily).to.exist
    expect(body.webSearchSettings.providers.tavily.enabled).to.be.true
    expect(body.webSearchSettings.providers.parallel).to.be.undefined
  })

  it('renders green notification with check and cross icons on mixed provider health outcomes', async function () {
    fetchMock.post('/ai-assist/web-search/test', {
      latencyMs: 140,
      anySuccess: true,
      providers: [
        {
          provider: 'tavily',
          searchable: true,
          latencyMs: 95,
          keys: [
            {
              index: 1,
              label: 'Key 1',
              target: 'sk-t****avily',
              status: 'works',
              message: 'Works (Searchable, 1 result in 95 ms)',
              latencyMs: 95,
              resultCount: 1,
            },
          ],
        },
        {
          provider: 'exa',
          searchable: false,
          latencyMs: 40,
          keys: [
            {
              index: 1,
              label: 'Key 1',
              target: 'sk-b****-exa',
              status: 'dead',
              message: 'Die: Invalid API key (401)',
              latencyMs: 40,
            },
          ],
          error: 'Die: Invalid API key (401)',
        },
      ],
      activeEndpoints: 2,
      provider: 'tavily',
    })

    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        tavily: { enabled: true, apiKeys: ['sk-tavily'] },
        exa: { enabled: true, apiKeys: ['sk-bad-exa'] },
      },
    }

    render(
      <WebSearchForm initial={initial} onSave={() => {}} onCancel={() => {}} />
    )

    const testButton = screen.getByRole('button', { name: /test search/i })
    fireEvent.click(testButton)

    expect(await screen.findByText(/Web search health check: Operational/i)).to.exist
    expect(screen.getByText(/Works \(Searchable, 1 result in 95 ms\)/i)).to.exist
    expect(screen.getByText(/Die: Invalid API key \(401\)/i)).to.exist
    expect(screen.getAllByText('check_circle')).to.have.length.at.least(1)
    expect(screen.getByText('cancel')).to.exist
    // Notification container is success type
    const notif = document.querySelector('.notification-type-success')
    expect(notif).to.exist
  })

  it('renders red notification with all cross icons when all providers fail health check', async function () {
    fetchMock.post('/ai-assist/web-search/test', {
      latencyMs: 65,
      anySuccess: false,
      providers: [
        {
          provider: 'tavily',
          searchable: false,
          latencyMs: 0,
          keys: [
            {
              index: 1,
              label: 'Key 1',
              target: 'sk-t****avily',
              status: 'dead',
              message: 'Die: Unauthorized (401)',
              latencyMs: 30,
            },
          ],
          error: 'Die: Unauthorized (401)',
        },
        {
          provider: 'exa',
          searchable: false,
          latencyMs: 0,
          keys: [
            {
              index: 1,
              label: 'Key 1',
              target: 'sk-e****exa1',
              status: 'dead',
              message: 'Die: Payment required (402)',
              latencyMs: 35,
            },
          ],
          error: 'Die: Payment required (402)',
        },
      ],
      activeEndpoints: 2,
      provider: null,
    })

    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        tavily: { enabled: true, apiKeys: ['sk-tavily'] },
        exa: { enabled: true, apiKeys: ['sk-exa'] },
      },
    }

    render(
      <WebSearchForm initial={initial} onSave={() => {}} onCancel={() => {}} />
    )

    const testButton = screen.getByRole('button', { name: /test search/i })
    fireEvent.click(testButton)

    expect(await screen.findByText(/Web search health check: Failed/i)).to.exist
    expect(screen.getByText(/Die: Unauthorized \(401\)/i)).to.exist
    expect(screen.getByText(/Die: Payment required \(402\)/i)).to.exist
    // Notification container is error type
    const notif = document.querySelector('.notification-type-error')
    expect(notif).to.exist
  })

  it('renders rich provider searchability status and individual 1..n key statuses (works, alive, die)', async function () {
    fetchMock.post('/ai-assist/web-search/test', {
      latencyMs: 180,
      anySuccess: true,
      providers: [
        {
          provider: 'tavily',
          searchable: true,
          latencyMs: 120,
          keys: [
            {
              index: 1,
              label: 'Key 1',
              target: 'tvly-****3a8f',
              status: 'works',
              message: 'Works (Searchable, 5 results in 120 ms)',
              latencyMs: 120,
              resultCount: 5,
            },
            {
              index: 2,
              label: 'Key 2',
              target: 'tvly-****99bc',
              status: 'alive',
              message: 'Alive (Authorized)',
              latencyMs: 60,
            },
            {
              index: 3,
              label: 'Key 3',
              target: 'tvly-****0001',
              status: 'dead',
              message: 'Die: HTTP 401: Invalid API key',
              latencyMs: 20,
            },
          ],
        },
        {
          provider: 'searxng',
          searchable: false,
          latencyMs: 50,
          keys: [
            {
              index: 1,
              label: 'Instance 1',
              target: 'http://searxng:8080',
              status: 'dead',
              message: 'Die: Connection refused (50 ms)',
              latencyMs: 50,
            },
          ],
          error: 'Connection refused',
        },
      ],
      activeEndpoints: 4,
      provider: 'tavily',
      resultCount: 5,
    })

    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        tavily: {
          enabled: true,
          apiKeys: ['tvly-secret-1', 'tvly-secret-2', 'tvly-secret-3'],
        },
        searxng: {
          enabled: true,
          baseUrls: ['http://searxng:8080'],
        },
      },
    }

    render(
      <WebSearchForm initial={initial} onSave={() => {}} onCancel={() => {}} />
    )

    const testButton = screen.getByRole('button', { name: /test search/i })
    fireEvent.click(testButton)

    expect(await screen.findByText(/Web search health check: Operational/i)).to.exist
    expect(screen.getByText(/1 provider searchable/i)).to.exist

    // Key targets and messages
    expect(screen.getByText('tvly-****3a8f')).to.exist
    expect(screen.getByText(/Works \(Searchable, 5 results in 120 ms\)/i)).to.exist
    expect(screen.getByText('tvly-****99bc')).to.exist
    expect(screen.getByText(/Alive \(Authorized\)/i)).to.exist
    expect(screen.getByText('tvly-****0001')).to.exist
    expect(screen.getByText(/Die: HTTP 401: Invalid API key/i)).to.exist
    expect(screen.getByText('http://searxng:8080')).to.exist
    expect(screen.getByText(/Die: Connection refused \(50 ms\)/i)).to.exist
    expect(document.querySelector('.web-search-probe-badge')).to.be.null
  })

  it('truncates long error logs and toggles the full log via the triangle dropdown button', async function () {
    const longErrorMessage =
      'Die: Custom web search returned HTTP 400: Validation error: 11 validation errors for JSONRPCMessage JSONRPCRequest.method Field required [type=missing, input_value={\'q\': \'LaTeX\'}]'

    fetchMock.post('/ai-assist/web-search/test', {
      latencyMs: 334,
      anySuccess: false,
      providers: [
        {
          provider: 'mcp',
          searchable: false,
          latencyMs: 0,
          keys: [
            {
              index: 1,
              label: 'Instance 1',
              target: 'https://search.parallel.ai/mcp',
              status: 'dead',
              message: longErrorMessage,
              latencyMs: 334,
            },
          ],
          error: longErrorMessage,
        },
      ],
      activeEndpoints: 1,
      provider: 'mcp',
      resultCount: 0,
    })

    const initial: MultiWebSearchSettings = {
      sourceMode: 'custom',
      providers: {
        mcp: {
          enabled: true,
          serverUrls: ['https://search.parallel.ai/mcp'],
        },
      },
    }

    render(
      <WebSearchForm initial={initial} onSave={() => {}} onCancel={() => {}} />
    )

    const testButton = screen.getByRole('button', { name: /test search/i })
    fireEvent.click(testButton)

    expect(await screen.findByText(/Web search health check: Failed/i)).to.exist

    // Full log should NOT be in the DOM initially
    expect(document.querySelector('.web-search-log-details')).to.be.null

    // Truncated preview text is visible
    expect(screen.getByText(/Die: Custom web search returned HTTP 400/i)).to.exist

    // Triangle button exists with 'Show full error log'
    const toggleBtn = screen.getByRole('button', { name: /show full error log/i })
    expect(toggleBtn).to.exist
    expect(toggleBtn.textContent).to.include('arrow_drop_down')

    // Click triangle button to expand
    fireEvent.click(toggleBtn)

    // Full log is now displayed in .web-search-log-details
    const logDetails = document.querySelector('.web-search-log-details')
    expect(logDetails).to.exist
    expect(logDetails?.textContent).to.equal(longErrorMessage)
    expect(toggleBtn.textContent).to.include('arrow_drop_up')

    // Click again to collapse
    fireEvent.click(toggleBtn)
    expect(document.querySelector('.web-search-log-details')).to.be.null
    expect(toggleBtn.textContent).to.include('arrow_drop_down')
  })
})
