import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { OpenAiClient } from '../../../frontend/js/features/ai-assist/providers/openai'
import { AnthropicClient } from '../../../frontend/js/features/ai-assist/providers/anthropic'
import { OllamaClient } from '../../../frontend/js/features/ai-assist/providers/ollama'
import { GoogleClient } from '../../../frontend/js/features/ai-assist/providers/google'
import { ProviderError } from '../../../frontend/js/features/ai-assist/providers/types'

const OPENAI = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
}

const ANTHROPIC = {
  type: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5',
}

const GOOGLE = {
  type: 'google' as const,
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: 'AIza-test',
  model: 'gemini-2.0-flash',
}

function sse(body: string) {
  return { body, headers: { 'Content-Type': 'text/event-stream' } }
}

async function collect(generator: AsyncGenerator<any>) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

function textOf(chunks: any[]) {
  return chunks
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('')
}

async function captureError(promise: Promise<unknown>) {
  try {
    await promise
    return null
  } catch (error) {
    return error as ProviderError
  }
}

const CHAT_REQUEST = {
  system: 's',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 100,
}

describe('OpenAiClient', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('streams delta text and ends at [DONE]', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
          'data: [DONE]\n\n' +
          'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n'
      )
    )
    const chunks = await collect(new OpenAiClient(OPENAI).streamChat(CHAT_REQUEST))
    expect(textOf(chunks)).to.equal('Hello')
    expect(chunks.at(-1)).to.deep.equal({ type: 'done' })
  })

  it('skips a malformed frame rather than ending the stream', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
          'data: {not json\n\n' +
          'data: {"choices":[{"delta":{"content":"b"}}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )
    const chunks = await collect(new OpenAiClient(OPENAI).streamChat(CHAT_REQUEST))
    expect(textOf(chunks)).to.equal('ab')
  })

  it('sends the model, the cap and a bearer token', async function () {
    fetchMock.post('https://api.openai.com/v1/chat/completions', sse('data: [DONE]\n\n'))
    await collect(new OpenAiClient(OPENAI).streamChat(CHAT_REQUEST))

    const call = fetchMock.callHistory.calls()[0]
    const body = JSON.parse(call.options.body as string)
    expect(body.model).to.equal('gpt-4o-mini')
    expect(body.max_tokens).to.equal(100)
    expect(body.stream).to.equal(true)
    const headers = call.options.headers as Record<string, string>
    expect(headers.authorization ?? headers.Authorization).to.equal('Bearer sk-test')
  })

  it('omits the bearer token when there is no key', async function () {
    fetchMock.post('https://custom-openai.example/v1/chat/completions', sse('data: [DONE]\n\n'))
    await collect(
      new OpenAiClient({
        type: 'openai',
        baseUrl: 'https://custom-openai.example/v1',
        apiKey: '',
        model: 'llama3.1',
      }).streamChat(CHAT_REQUEST)
    )
    const headers = fetchMock.callHistory.calls()[0].options.headers as Record<
      string,
      string
    >
    expect(headers.authorization ?? headers.Authorization).to.be.undefined
  })

  it('sorts the model list by id', async function () {
    fetchMock.get('https://api.openai.com/v1/models', {
      object: 'list',
      data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'mid' }],
    })
    const models = await new OpenAiClient(OPENAI).listModels()
    expect(models.map(m => m.id)).to.deep.equal(['alpha', 'mid', 'zeta'])
  })

  it('skips model entries with no usable id', async function () {
    fetchMock.get('https://api.openai.com/v1/models', {
      data: [{ id: 'ok' }, {}, { id: 42 }, null],
    })
    const models = await new OpenAiClient(OPENAI).listModels()
    expect(models).to.deep.equal([{ id: 'ok', label: 'ok' }])
  })

  it('reports a rejected key as providerAuth, keeping the provider’s wording', async function () {
    fetchMock.get('https://api.openai.com/v1/models', {
      status: 401,
      body: 'Incorrect API key provided',
    })
    const error = await captureError(new OpenAiClient(OPENAI).listModels())
    expect(error?.code).to.equal('providerAuth')
    expect(error?.message).to.contain('Incorrect API key')
  })

  it('reports a missing models route as modelsUnsupported', async function () {
    fetchMock.get('https://api.openai.com/v1/models', { status: 404, body: 'nope' })
    const error = await captureError(new OpenAiClient(OPENAI).listModels())
    expect(error?.code).to.equal('modelsUnsupported')
  })

  it('strips a trailing slash from the base URL', async function () {
    fetchMock.get('https://api.openai.com/v1/models', { data: [] })
    await new OpenAiClient({ ...OPENAI, baseUrl: 'https://api.openai.com/v1//' }).listModels()
    expect(fetchMock.callHistory.calls()[0].url).to.equal(
      'https://api.openai.com/v1/models'
    )
  })
})

describe('AnthropicClient', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('sends the version and the browser-access header', async function () {
    // Anthropic refuses browser requests without the second header; this build
    // keeps the key in the browser, which is exactly what it acknowledges.
    fetchMock.post('https://api.anthropic.com/v1/messages', sse('event: message_stop\ndata: {}\n\n'))
    await collect(new AnthropicClient(ANTHROPIC).streamChat(CHAT_REQUEST))

    const headers = fetchMock.callHistory.calls()[0].options.headers as Record<
      string,
      string
    >
    expect(headers['anthropic-version']).to.equal('2023-06-01')
    expect(headers['anthropic-dangerous-direct-browser-access']).to.equal('true')
    expect(headers['x-api-key']).to.equal('sk-ant-test')
  })

  it('yields only text deltas', async function () {
    fetchMock.post(
      'https://api.anthropic.com/v1/messages',
      sse(
        'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","text":"hmm"}}\n\n' +
          'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
          'event: message_stop\ndata: {}\n\n'
      )
    )
    const chunks = await collect(
      new AnthropicClient(ANTHROPIC).streamChat(CHAT_REQUEST)
    )
    expect(textOf(chunks)).to.equal('Hi')
  })

  it('sends system as a top-level field', async function () {
    fetchMock.post('https://api.anthropic.com/v1/messages', sse('event: message_stop\ndata: {}\n\n'))
    await collect(new AnthropicClient(ANTHROPIC).streamChat(CHAT_REQUEST))
    const body = JSON.parse(
      fetchMock.callHistory.calls()[0].options.body as string
    )
    expect(body.system).to.equal('s')
    expect(body.messages).to.deep.equal([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
  })

  it('raises a mid-stream error frame', async function () {
    fetchMock.post(
      'https://api.anthropic.com/v1/messages',
      sse('event: error\ndata: {"error":{"message":"overloaded"}}\n\n')
    )
    const error = await captureError(
      collect(new AnthropicClient(ANTHROPIC).streamChat(CHAT_REQUEST))
    )
    expect(error?.code).to.equal('providerError')
    expect(error?.message).to.contain('overloaded')
  })

  it('prefers display_name for the model label', async function () {
    fetchMock.get('begin:https://api.anthropic.com/v1/models', {
      data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }],
      has_more: false,
      last_id: null,
    })
    const models = await new AnthropicClient(ANTHROPIC).listModels()
    expect(models).to.deep.equal([
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
    ])
  })

  it('follows after_id pagination', async function () {
    fetchMock
      .once('https://api.anthropic.com/v1/models?limit=1000', {
        data: [{ id: 'a' }, { id: 'b' }],
        has_more: true,
        last_id: 'b',
      })
      .once('https://api.anthropic.com/v1/models?limit=1000&after_id=b', {
        data: [{ id: 'c' }],
        has_more: false,
        last_id: null,
      })

    const models = await new AnthropicClient(ANTHROPIC).listModels()
    expect(models.map(m => m.id)).to.deep.equal(['a', 'b', 'c'])
  })

  it('stops paginating when the provider never stops claiming more', async function () {
    fetchMock.get('begin:https://api.anthropic.com/v1/models', {
      data: [{ id: 'loop' }],
      has_more: true,
      last_id: 'loop',
    })
    await new AnthropicClient(ANTHROPIC).listModels()
    expect(fetchMock.callHistory.calls().length).to.be.at.most(5)
  })
})

describe('OllamaClient', function () {
  const OLLAMA = {
    type: 'ollama' as const,
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    model: 'llama3.2',
  }

  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('streams text chunks from NDJSON and ends at done: true', async function () {
    fetchMock.post(
      'http://localhost:11434/api/chat',
      '{"model":"llama3.2","message":{"role":"assistant","content":"Hel"},"done":false}\n' +
        '{"model":"llama3.2","message":{"role":"assistant","content":"lo"},"done":false}\n' +
        '{"model":"llama3.2","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n'
    )

    const chunks = await collect(new OllamaClient(OLLAMA).streamChat(CHAT_REQUEST))
    expect(textOf(chunks)).to.equal('Hello')
    expect(chunks.at(-1)).to.deep.equal({ type: 'done', stopReason: 'stop' })
  })

  it('sends system and user messages in Ollama format', async function () {
    fetchMock.post(
      'http://localhost:11434/api/chat',
      '{"message":{"content":"ok"},"done":true}\n'
    )
    await collect(new OllamaClient(OLLAMA).streamChat(CHAT_REQUEST))

    const body = JSON.parse(
      fetchMock.callHistory.calls('http://localhost:11434/api/chat')[0].options
        .body as string
    )
    expect(body.model).to.equal('llama3.2')
    expect(body.messages).to.deep.equal([
      { role: 'system', content: 's' },
      { role: 'user', content: 'hi' },
    ])
    expect(body.stream).to.equal(true)
    expect(body.options.num_predict).to.equal(100)
  })

  it('lists models from /api/tags and auto-detects context window and 64k output cap', async function () {
    fetchMock.get('http://localhost:11434/api/tags', {
      models: [
        {
          name: 'gemma4:cloud',
          model: 'gemma4:cloud',
          details: { context_length: 262144 },
        },
        { name: 'deepseek-r1:8b', model: 'deepseek-r1:8b' },
      ],
    })

    const models = await new OllamaClient(OLLAMA).listModels()
    expect(models).to.deep.equal([
      { id: 'deepseek-r1:8b', label: 'deepseek-r1:8b' },
      {
        id: 'gemma4:cloud',
        label: 'gemma4:cloud',
        contextWindow: 262144,
        maxOutputTokens: 65536,
      },
    ])
  })

  it('strips /v1 from base URL to reach native /api endpoints', async function () {
    fetchMock.get('http://localhost:11434/api/tags', {
      models: [{ name: 'llama3.2', model: 'llama3.2' }],
    })

    const client = new OllamaClient({
      ...OLLAMA,
      baseUrl: 'http://localhost:11434/v1',
    })
    const models = await client.listModels()
    expect(models).to.have.length(1)
    expect(fetchMock.callHistory.calls()[0].url).to.equal(
      'http://localhost:11434/api/tags'
    )
  })

  it('surfaces an error in an NDJSON payload', async function () {
    fetchMock.post('http://localhost:11434/api/chat', {
      body: '{"error":"model not found"}\n',
    })

    const error = await captureError(
      collect(new OllamaClient(OLLAMA).streamChat(CHAT_REQUEST))
    )
    expect(error?.code).to.equal('providerError')
    expect(error?.message).to.contain('model not found')
  })

  it('streams thinking chunks and accumulates tool calls from NDJSON', async function () {
    fetchMock.post(
      'http://localhost:11434/api/chat',
      '{"message":{"thinking":"Let me check the weather."},"done":false}\n' +
        '{"message":{"tool_calls":[{"id":"call_123","function":{"name":"get_weather","arguments":{"city":"Hanoi"}}}]},"done":false}\n' +
        '{"message":{"tool_calls":[{"id":"call_123","function":{"name":"get_weather","arguments":{"city":"Hanoi"}}}]},"done":false}\n' +
        '{"done":true,"done_reason":"stop"}\n'
    )

    const chunks = await collect(
      new OllamaClient(OLLAMA).streamChat({
        ...CHAT_REQUEST,
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object' },
          },
        ],
      })
    )

    expect(chunks).to.deep.equal([
      { type: 'thinking', text: 'Let me check the weather.' },
      {
        type: 'tool_call',
        id: 'call_123',
        name: 'get_weather',
        args: { city: 'Hanoi' },
      },
      { type: 'done', stopReason: 'tool_calls' },
    ])
  })

  it('formats tool results and assistant tool calls with tool_call_id and name', async function () {
    fetchMock.post(
      'http://localhost:11434/api/chat',
      '{"message":{"content":"done"},"done":true}\n'
    )

    const client = new OllamaClient({
      ...OLLAMA,
      contextWindow: 64000,
    })

    await collect(
      client.streamChat({
        system: 'sys',
        messages: [
          { role: 'user', content: 'check' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'call_abc', name: 'read_file', args: { path: 'main.tex' } },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_abc',
            name: 'read_file',
            content: 'file contents',
          },
        ],
        maxTokens: 500,
      })
    )

    const sent = JSON.parse(
      fetchMock.callHistory.calls('http://localhost:11434/api/chat')[0].options
        .body as string
    )

    expect(sent.think).to.equal(true)
    expect(sent.keep_alive).to.equal('15m')
    expect(sent.max_tokens).to.equal(500)
    expect(sent.options.num_predict).to.equal(500)
    expect(sent.options.num_ctx).to.equal(64000)
    expect(sent.options.temperature).to.equal(0.2)
    expect(sent.messages).to.deep.equal([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'check' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: { path: 'main.tex' },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'file contents',
        tool_call_id: 'call_abc',
        name: 'read_file',
      },
    ])
  })
})

describe('GoogleClient', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('lists models from native /v1beta/models filtering by generateContent', async function () {
    fetchMock.get('https://generativelanguage.googleapis.com/v1beta/models', {
      models: [
        {
          name: 'models/gemini-2.0-flash',
          displayName: 'Gemini 2.0 Flash',
          inputTokenLimit: 1048576,
          outputTokenLimit: 8192,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        {
          name: 'models/text-embedding-004',
          displayName: 'Text Embedding',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
    })

    const client = new GoogleClient(GOOGLE)
    const models = await client.listModels()

    expect(models).to.deep.equal([
      {
        id: 'gemini-2.0-flash',
        label: 'Gemini 2.0 Flash',
        contextWindow: 1048576,
        maxOutputTokens: 8192,
      },
    ])
    expect(
      fetchMock.callHistory.calls('https://generativelanguage.googleapis.com/v1beta/models')[0].options.headers
    ).to.deep.include({ 'x-goog-api-key': 'AIza-test' })
  })

  it('streams thinking, text, and functionCall from native streamGenerateContent?alt=sse', async function () {
    const sseBody = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Thinking step 1","thought":true}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"Final answer"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"main.tex"}}}]},"finishReason":"STOP"}]}\n\n',
    ].join('')

    fetchMock.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
      sse(sseBody)
    )

    const client = new GoogleClient(GOOGLE)
    const chunks = await collect(
      client.streamChat({
        system: 'System instructions',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 1024,
        tools: [
          {
            name: 'read_file',
            description: 'read file',
            parameters: { type: 'object' },
          },
        ],
      })
    )

    expect(chunks).to.deep.equal([
      { type: 'thinking', text: 'Thinking step 1' },
      { type: 'text', text: 'Final answer' },
      {
        type: 'tool_call',
        id: chunks[2].id,
        name: 'read_file',
        args: { path: 'main.tex' },
      },
      { type: 'done', stopReason: 'tool_calls' },
    ])

    const sent = JSON.parse(
      fetchMock.callHistory.calls('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse')[0]
        .options.body as string
    )
    expect(sent.systemInstruction.parts[0].text).to.equal('System instructions')
    expect(sent.contents[0].parts[0].text).to.equal('hello')
    expect(sent.tools[0].functionDeclarations[0].name).to.equal('read_file')
  })
})


