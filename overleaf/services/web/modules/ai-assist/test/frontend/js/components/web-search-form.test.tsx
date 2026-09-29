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

    // Now Tavily should appear in the added providers list (expanded by default)
    expect(screen.getByText(/1 API key/i)).to.exist
    expect(screen.getByRole('button', { name: /done configuring tavily/i })).to
      .exist
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

    // Verify Exa appears in the added providers list
    expect(screen.getByText(/1 API key/i)).to.exist
    expect(screen.getByRole('button', { name: /done configuring exa/i })).to
      .exist

    // Save form
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(onSave.calledOnce).to.be.true
    const saved = onSave.firstCall.args[0] as MultiWebSearchSettings
    expect(saved.providers?.exa?.enabled).to.be.true
    expect(saved.providers?.exa?.apiKeys).to.deep.equal(['exa-key-test-456'])
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
})
