import { expect } from 'chai'
import customLocalStorage from '@/infrastructure/local-storage'
import { render, screen, fireEvent } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import AiProvidersWidget from '../../../../frontend/js/features/ai-assist/components/ai-providers-widget'

function setMeta({ enabled = true, webTools = false } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    (enabled
      ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
      : '') +
    (webTools
      ? '<meta name="ol-aiAssistWebToolsEnabled" data-type="boolean" content="">'
      : '')
}

const STORED = {
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-secret-value',
  model: 'gpt-4o-mini',
  modelName: 'GPT-4o mini',
}

const FAST = {
  type: 'ollama',
  baseUrl: 'http://ollama:11434/v1',
  apiKey: '',
  model: 'qwen3:4b',
  modelName: 'Qwen3 4B',
}

describe('AiProvidersWidget', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    setMeta()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('renders nothing when the feature is disabled', function () {
    setMeta({ enabled: false })
    const { container } = render(<AiProvidersWidget />)
    expect(container.textContent).to.equal('')
  })

  it('invites the user to add a provider when none is stored', function () {
    render(<AiProvidersWidget />)
    expect(screen.getByText(/no provider configured/i)).to.exist
  })

  it('shows the provider stored in this browser with friendly model name', function () {
    customLocalStorage.setItem('ai-assist:provider', STORED)
    render(<AiProvidersWidget />)
    expect(screen.getByTestId('provider-current')).to.exist
    expect(screen.getByText(/GPT-4o mini/)).to.exist
  })

  it('shows the real model name from API response', function () {
    customLocalStorage.setItem('ai-assist:provider', {
      type: 'anthropic',
      baseUrl: 'http://api.dangdd.tech:8317',
      apiKey: 'sk-test',
      model: 'claude-fable-5-dd-orP 4V keeSpeeD',
      modelName: 'DeepSeek V4 Pro',
    })
    render(<AiProvidersWidget />)
    expect(screen.getByText(/DeepSeek V4 Pro/)).to.exist
  })

  it('falls back to model id when modelName is absent', function () {
    customLocalStorage.setItem('ai-assist:provider', {
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'raw-model-id',
    })
    render(<AiProvidersWidget />)
    expect(screen.getByText(/raw-model-id/)).to.exist
  })

  it('never renders the API key', function () {
    customLocalStorage.setItem('ai-assist:provider', STORED)
    const { container } = render(<AiProvidersWidget />)
    expect(container.textContent).to.not.contain('sk-secret-value')
  })

  it('reports that consent is still pending', function () {
    customLocalStorage.setItem('ai-assist:provider', STORED)
    render(<AiProvidersWidget />)
    expect(screen.getByText(/consent pending/i)).to.exist
  })

  it('reports readiness once consent is recorded', function () {
    customLocalStorage.setItem('ai-assist:provider', STORED)
    customLocalStorage.setItem('ai-assist:consent', true)
    render(<AiProvidersWidget />)
    expect(screen.getByText(/ready/i)).to.exist
  })

  it('removes the stored provider', function () {
    customLocalStorage.setItem('ai-assist:provider', STORED)
    render(<AiProvidersWidget />)

    fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    expect(customLocalStorage.getItem('ai-assist:provider')).to.be.null
    expect(screen.getByText(/no provider configured/i)).to.exist
  })

  it('makes no request to any Overleaf endpoint', function () {
    // The whole point of this design: configuration is local, and the server is
    // not involved in the assistant at all.
    customLocalStorage.setItem('ai-assist:provider', STORED)
    render(<AiProvidersWidget />)
    expect(fetchMock.callHistory.calls()).to.have.length(0)
  })

  it('opens the form to change an existing provider', function () {
    customLocalStorage.setItem('ai-assist:provider', STORED)
    render(<AiProvidersWidget />)

    fireEvent.click(screen.getByRole('button', { name: /change provider/i }))
    expect(screen.getByLabelText('Provider type')).to.exist
  })

  it('renders Disable AI features button by default and has consistent full button size', function () {
    render(<AiProvidersWidget />)
    const disableButton = screen.getByRole('button', {
      name: /disable ai features/i,
    })
    expect(disableButton).to.exist
    expect(disableButton.className).to.contain('btn-danger-ghost')
    expect(disableButton.className).to.not.contain('btn-sm')
  })

  it('toggles AI features to disabled and updates storage and backend', async function () {
    fetchMock.post('/user/settings', 200)
    customLocalStorage.setItem('ai-assist:provider', STORED)
    render(<AiProvidersWidget />)

    const disableButton = screen.getByRole('button', {
      name: /disable ai features/i,
    })
    fireEvent.click(disableButton)

    expect(customLocalStorage.getItem('ai-assist:enabled')).to.equal(false)
    expect(screen.getByRole('button', { name: /enable ai features/i })).to.exist
    expect(screen.getByText('Disabled')).to.exist

    // Re-enable
    const enableButton = screen.getByRole('button', {
      name: /enable ai features/i,
    })
    expect(enableButton.className).to.not.contain('btn-sm')
    fireEvent.click(enableButton)

    expect(customLocalStorage.getItem('ai-assist:enabled')).to.equal(true)
    expect(screen.getByRole('button', { name: /disable ai features/i })).to
      .exist
  })

  it('initializes as disabled when ol-showAiFeatures is false (default for new accounts)', function () {
    window.metaAttributesCache?.clear()
    document.head.innerHTML =
      '<meta name="ol-csrfToken" content="csrf-token-123">' +
      '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">' +
      '<meta name="ol-showAiFeatures" data-type="boolean">'
    customLocalStorage.setItem('ai-assist:provider', STORED)

    render(<AiProvidersWidget />)

    expect(screen.getByRole('button', { name: /enable ai features/i })).to.exist
    expect(screen.getByText('Disabled')).to.exist
  })

  describe('web search', function () {
    it('is not offered unless the instance enables web tools', function () {
      render(<AiProvidersWidget />)
      expect(screen.queryByTestId('web-search-settings')).to.equal(null)
    })

    it('saves a SearXNG instance in this browser and shows it', function () {
      setMeta({ webTools: true })
      render(<AiProvidersWidget />)

      fireEvent.click(screen.getByRole('button', { name: 'Set up web search' }))
      fireEvent.click(screen.getByText(/add search provider/i))
      const select = screen.getByLabelText(/select provider to add/i)
      fireEvent.change(select, { target: { value: 'searxng' } })
      fireEvent.change(screen.getByPlaceholderText('http://searxng:8080'), {
        target: { value: 'http://searxng:8080' },
      })
      fireEvent.click(screen.getByRole('button', { name: /add searxng/i }))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      expect(customLocalStorage.getItem('ai-assist:web-search')).to.deep.equal({
        sourceMode: 'custom',
        providers: {
          searxng: {
            enabled: true,
            baseUrls: ['http://searxng:8080'],
          },
        },
        rotationStrategy: 'round-robin',
        primaryProvider: 'searxng',
      })
      expect(screen.getByText(/SearXNG \(1 instance\)/)).to.exist
    })

    it('tests the search through the Overleaf server', async function () {
      setMeta({ webTools: true })
      fetchMock.post('/ai-assist/web-search/test', {
        latencyMs: 42,
        resultCount: 1,
        activeEndpoints: 1,
        provider: 'ollama',
      })
      render(<AiProvidersWidget />)

      fireEvent.click(screen.getByRole('button', { name: 'Set up web search' }))
      fireEvent.click(screen.getByText(/add search provider/i))
      const select = screen.getByLabelText(/select provider to add/i)
      fireEvent.change(select, { target: { value: 'ollama' } })
      fireEvent.change(screen.getByPlaceholderText('Ollama API key'), {
        target: { value: 'key-1' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Test search' }))

      expect(await screen.findByText(/Search answered in 42 ms/)).to.exist
      const body = JSON.parse(
        fetchMock.callHistory.lastCall('/ai-assist/web-search/test')?.options
          .body as string
      )
      expect(body.webSearchSettings.providers.ollama.apiKeys).to.deep.equal([
        'key-1',
      ])
    })

    it('removes the stored web search', function () {
      setMeta({ webTools: true })
      customLocalStorage.setItem('ai-assist:web-search', {
        type: 'ollama',
        apiKey: 'k',
      })
      render(<AiProvidersWidget />)

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

      expect(customLocalStorage.getItem('ai-assist:web-search')).to.equal(null)
      expect(screen.getByRole('button', { name: 'Set up web search' })).to.exist
    })
  })

  it('shows an empty fast model slot next to the main one', function () {
    render(<AiProvidersWidget />)
    expect(screen.getByText('Main model')).to.exist
    expect(screen.getByText('Fast model')).to.exist
    expect(screen.getByText(/no fast model configured/i)).to.exist
    expect(screen.getByRole('button', { name: /add fast model/i })).to.exist
  })

  it('shows the fast model stored in this browser and removes only it', function () {
    customLocalStorage.setItem('ai-assist:provider', STORED)
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    render(<AiProvidersWidget />)

    const card = screen.getByTestId('fast-provider-current')
    expect(card.textContent).to.contain('Qwen3 4B')
    expect(card.textContent).to.contain('http://ollama:11434/v1')
    expect(card.textContent).to.contain('Ollama')

    fireEvent.click(screen.getByRole('button', { name: 'Remove fast model' }))
    expect(customLocalStorage.getItem('ai-assist:fast-provider')).to.be.null
    expect(customLocalStorage.getItem('ai-assist:provider')).to.deep.equal(STORED)
    expect(screen.getByText(/no fast model configured/i)).to.exist
  })

  it('offers every provider for the fast model', function () {
    render(<AiProvidersWidget />)
    fireEvent.click(screen.getByRole('button', { name: /add fast model/i }))
    const select = screen.getByLabelText('Provider type') as HTMLSelectElement
    expect([...select.options].map(option => option.textContent)).to.deep.equal([
      'OpenAI',
      'Anthropic',
      'Google Gemini',
      'Ollama',
    ])
    expect(screen.getByText(/code completion and language suggestions/i)).to.exist
  })
})
