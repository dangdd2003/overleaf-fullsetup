import { expect } from 'chai'
import sinon from 'sinon'
import customLocalStorage from '@/infrastructure/local-storage'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import ProviderForm from '../../../../frontend/js/features/ai-assist/components/provider-form'

function setMeta() {
  window.metaAttributesCache?.clear()
  document.head.innerHTML =
    '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
}

const OPENAI_MODELS = 'https://api.openai.com/v1/models'
const OPENAI_CHAT = 'https://api.openai.com/v1/chat/completions'

const STORED = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
}

function renderForm(props = {}) {
  return render(
    <ProviderForm onSave={() => {}} onCancel={() => {}} {...props} />
  )
}

function modelList(ids: string[]) {
  return { object: 'list', data: ids.map(id => ({ id, object: 'model' })) }
}

/** A minimal OpenAI-format SSE body. */
function chatStream() {
  return {
    body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    headers: { 'Content-Type': 'text/event-stream' },
  }
}

describe('ProviderForm', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    setMeta()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('starts with a free-text model field', function () {
    renderForm()
    expect(screen.queryByTestId('ai-provider-model-select')).to.be.null
  })

  it('calls the provider directly, not an Overleaf endpoint', async function () {
    fetchMock.get(OPENAI_MODELS, modelList(['gpt-4o']))
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))

    await waitFor(() => {
      expect(fetchMock.callHistory.calls(OPENAI_MODELS)).to.have.length(1)
    })
    // Nothing may be sent to Overleaf: there is no endpoint to send it to.
    expect(
      fetchMock.callHistory
        .calls()
        .every(call => call.url.startsWith('https://api.openai.com'))
    ).to.be.true
  })

  it('sends the key as a bearer token to the provider', async function () {
    fetchMock.get(OPENAI_MODELS, modelList(['gpt-4o']))
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))

    await waitFor(() => {
      expect(fetchMock.callHistory.calls(OPENAI_MODELS)).to.have.length(1)
    })
    const headers = fetchMock.callHistory.calls(OPENAI_MODELS)[0].options
      .headers as Record<string, string>
    expect(headers.authorization ?? headers.Authorization).to.equal(
      'Bearer sk-test'
    )
  })

  it('loads models and swaps the field for a dropdown', async function () {
    fetchMock.get(OPENAI_MODELS, modelList(['gpt-4o', 'gpt-4o-mini']))
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))

    await waitFor(() => {
      expect(screen.getByTestId('ai-provider-model-select')).to.exist
    })
    expect(screen.getByRole('option', { name: 'gpt-4o' })).to.exist
  })

  it('keeps the current model when the provider still offers it', async function () {
    fetchMock.get(OPENAI_MODELS, modelList(['gpt-4o', 'gpt-4o-mini']))
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))

    await waitFor(() => {
      expect(screen.getByTestId('ai-provider-model-select')).to.exist
    })
    expect(
      (screen.getByTestId('ai-provider-model-select') as HTMLSelectElement).value
    ).to.equal('gpt-4o-mini')
  })

  it('lets the user switch back to typing a model name', async function () {
    fetchMock.get(OPENAI_MODELS, modelList(['gpt-4o']))
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))
    await waitFor(() => {
      expect(screen.getByTestId('ai-provider-model-select')).to.exist
    })

    fireEvent.click(screen.getByRole('button', { name: /enter manually/i }))
    expect(screen.queryByTestId('ai-provider-model-select')).to.be.null
  })

  it('stays on manual entry when the endpoint has no models route', async function () {
    // Azure OpenAI and similar gateways have no /v1/models.
    fetchMock.get(OPENAI_MODELS, { status: 404, body: 'not found' })
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))

    await waitFor(() => {
      expect(screen.getByText(/does not list models/i)).to.exist
    })
    expect(screen.queryByTestId('ai-provider-model-select')).to.be.null
  })

  it('shows the provider’s own words when the key is rejected', async function () {
    // The key is this user's own and the call came from their browser, so the
    // real message is safe to show and far more useful than a generic one.
    fetchMock.get(OPENAI_MODELS, {
      status: 401,
      body: 'Incorrect API key provided: sk-test',
    })
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))

    await waitFor(() => {
      expect(screen.getByText(/incorrect api key provided/i)).to.exist
    })
  })

  it('reports a successful connection test', async function () {
    fetchMock.post(OPENAI_CHAT, chatStream())
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByText(/connected in \d+ ms/i)).to.exist
    })
  })

  it('sends a single token when testing so it costs almost nothing', async function () {
    fetchMock.post(OPENAI_CHAT, chatStream())
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(fetchMock.callHistory.calls(OPENAI_CHAT)).to.have.length(1)
    })
    const body = JSON.parse(
      fetchMock.callHistory.calls(OPENAI_CHAT)[0].options.body as string
    )
    expect(body.max_tokens).to.equal(1)
  })

  it('surfaces the reason a connection test failed', async function () {
    fetchMock.post(OPENAI_CHAT, {
      status: 401,
      body: 'invalid_api_key',
    })
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }))

    await waitFor(() => {
      expect(screen.getByText(/invalid_api_key/i)).to.exist
    })
  })

  it('cannot be tested or saved before a model is chosen', function () {
    renderForm()
    expect(
      screen.getByRole('button', { name: /test connection/i })
    ).to.have.property('disabled', true)
    expect(screen.getByRole('button', { name: 'Save' })).to.have.property(
      'disabled',
      true
    )
  })

  it('discards a loaded list when the provider type changes', async function () {
    fetchMock.get(OPENAI_MODELS, modelList(['gpt-4o']))
    renderForm({ initial: STORED })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))
    await waitFor(() => {
      expect(screen.getByTestId('ai-provider-model-select')).to.exist
    })

    fireEvent.change(screen.getByLabelText('Provider type'), {
      target: { value: 'anthropic' },
    })

    expect(screen.queryByTestId('ai-provider-model-select')).to.be.null
  })

  it('hands the whole configuration back on save', function () {
    let saved: any = null
    renderForm({ initial: STORED, onSave: (v: any) => (saved = v) })

    fireEvent.submit(
      screen.getByRole('button', { name: 'Save' }).closest('form')!
    )

    expect(saved).to.deep.equal(STORED)
  })

  it('falls back to the default base URL when the field is blank', function () {
    let saved: any = null
    renderForm({
      initial: { ...STORED, baseUrl: '' },
      onSave: (v: any) => (saved = v),
    })

    fireEvent.submit(
      screen.getByRole('button', { name: 'Save' }).closest('form')!
    )

    expect(saved.baseUrl).to.equal('https://api.openai.com/v1')
  })

  it('offers OpenAI, Anthropic, Google Gemini, and Ollama in provider type selector', function () {
    renderForm()
    const options = screen
      .getAllByRole('option')
      .map(opt => (opt as HTMLOptionElement).value)
    expect(options).to.deep.equal(['openai', 'anthropic', 'google', 'ollama'])
  })

  it('falls back to Google default base URL when base URL is blank', function () {
    let saved: any = null
    renderForm({
      initial: { type: 'google', baseUrl: '', apiKey: 'g-key', model: 'gemini-2.0-flash' },
      onSave: (v: any) => (saved = v),
    })

    fireEvent.submit(
      screen.getByRole('button', { name: 'Save' }).closest('form')!
    )

    expect(saved.baseUrl).to.equal('https://generativelanguage.googleapis.com/v1beta')
  })

  it('falls back to http://localhost:11434 for Ollama when base URL is blank', function () {
    let saved: any = null
    renderForm({
      initial: { type: 'ollama', baseUrl: '', apiKey: '', model: 'llama3.2' },
      onSave: (v: any) => (saved = v),
    })

    fireEvent.submit(
      screen.getByRole('button', { name: 'Save' }).closest('form')!
    )

    expect(saved.baseUrl).to.equal('http://localhost:11434')
  })

  it('loads models from Ollama /api/tags', async function () {
    fetchMock.get('http://localhost:11434/api/tags', {
      models: [{ name: 'llama3.2', model: 'llama3.2' }],
    })
    renderForm({
      initial: {
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        apiKey: '',
        model: 'llama3.2',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /load models/i }))
    await waitFor(() => {
      expect(screen.getByTestId('ai-provider-model-select')).to.exist
    })
    expect(fetchMock.callHistory.calls('http://localhost:11434/api/tags')).to.have.length(1)
  })

  it('lets the user set a context window and output cap', async function () {
    // A model must already be chosen or Save stays disabled (see 'cannot be
    // tested or saved before a model is chosen' above) — that gate predates
    // this task and is orthogonal to what this spec is checking, so seed a
    // model the same way the other save-path tests below do.
    const onSave = sinon.stub()
    renderForm({ initial: STORED, onSave })

    fireEvent.change(screen.getByLabelText(/context window/i), {
      target: { value: '32000' },
    })
    fireEvent.change(screen.getByLabelText(/max output tokens/i), {
      target: { value: '2048' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave.lastCall.args[0]).to.include({
      contextWindow: 32000,
      maxOutputTokens: 2048,
    })
  })

  it('leaves the fields empty when the provider uses its defaults', function () {
    renderForm({})
    expect((screen.getByLabelText(/context window/i) as HTMLInputElement).value).to.equal('')
  })

  it('omits both limit keys when the fields are left blank', function () {
    const onSave = sinon.stub()
    renderForm({ initial: STORED, onSave })

    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave.lastCall.args[0]).to.not.have.property('contextWindow')
    expect(onSave.lastCall.args[0]).to.not.have.property('maxOutputTokens')
  })

  it('omits a limit key when the field is cleared after having a value, rather than storing 0', function () {
    const onSave = sinon.stub()
    renderForm({
      initial: { ...STORED, contextWindow: 64000, maxOutputTokens: 4096 },
      onSave,
    })
    expect((screen.getByLabelText(/context window/i) as HTMLInputElement).value).to.equal('64000')

    fireEvent.change(screen.getByLabelText(/context window/i), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave.lastCall.args[0]).to.not.have.property('contextWindow')
    // The field nobody touched keeps its loaded value — clearing one field
    // must not disturb the other.
    expect(onSave.lastCall.args[0].maxOutputTokens).to.equal(4096)
  })

  it('omits a limit key when the stored settings hold a non-numeric value', function () {
    // Not reachable by typing into the rendered field: it is a native
    // type="number" input, so both the browser and jsdom sanitise any
    // non-numeric keystroke to '' before React ever sees it (verified
    // empirically — 'abc', '1e400', 'NaN', and whitespace all land as '').
    // The realistic way a non-numeric value reaches `numeric()` is a
    // previously-stored setting that predates validation, or a corrupted
    // localStorage entry — modelled here by seeding `initial` directly,
    // bypassing the `ProviderSettings['contextWindow']: number` type that
    // only TypeScript, not a JSON round-trip, enforces.
    const onSave = sinon.stub()
    renderForm({
      initial: { ...STORED, contextWindow: 'not-a-number' as unknown as number },
      onSave,
    })

    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave.lastCall.args[0]).to.not.have.property('contextWindow')
  })
})
