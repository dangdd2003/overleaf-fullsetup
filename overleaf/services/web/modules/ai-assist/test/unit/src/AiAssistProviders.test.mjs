import { expect } from 'chai'
import sinon from 'sinon'
import {
  createProviderClient,
  ProviderError,
  fetchWithRetry,
  isOfficialOpenAiUrl,
  markMessageCacheBreakpoints,
  parseSseLines,
  promptCacheKey,
  safeParseToolArgs,
  validateSafeProviderBaseUrl,
} from '../../../app/src/AiAssistProviders.mjs'

describe('AiAssistProviders', function () {
  describe('validateSafeProviderBaseUrl', function () {
    it('allows standard public cloud LLM endpoints', function () {
      expect(() => validateSafeProviderBaseUrl('https://api.openai.com/v1')).to.not.throw()
      expect(() => validateSafeProviderBaseUrl('https://api.anthropic.com')).to.not.throw()
      expect(() => validateSafeProviderBaseUrl('https://generativelanguage.googleapis.com')).to.not.throw()
    })

    it('allows Docker host gateway for local Ollama', function () {
      const gateway = process.env.DOCKER_HOST_GATEWAY || '172.20.0.1'
      expect(() => validateSafeProviderBaseUrl(`http://${gateway}:11434`)).to.not.throw()
    })

    it('blocks internal Docker container hostnames', function () {
      const blocked = [
        'http://mongo:27017',
        'http://mongodb:27017',
        'http://redis:6379',
        'http://clsi:3013',
        'http://filestore:3009',
        'http://docstore:3016',
        'http://document-updater:10000',
        'http://chat:3000',
        'http://real-time:3026',
        'http://spelling:3005',
        'http://notifications:3042',
        'http://git-bridge:3010',
        'http://project-history:3054',
      ]
      for (const url of blocked) {
        expect(() => validateSafeProviderBaseUrl(url), `Should block ${url}`).to.throw(ProviderError)
      }
    })

    it('blocks cloud metadata endpoints', function () {
      expect(() => validateSafeProviderBaseUrl('http://169.254.169.254/latest/meta-data')).to.throw(ProviderError)
      expect(() => validateSafeProviderBaseUrl('http://metadata.google.internal/computeMetadata/v1')).to.throw(ProviderError)
    })

    it('blocks non-HTTP protocols', function () {
      expect(() => validateSafeProviderBaseUrl('file:///etc/passwd')).to.throw(ProviderError)
      expect(() => validateSafeProviderBaseUrl('gopher://127.0.0.1:6379')).to.throw(ProviderError)
    })
  })

  describe('parseSseLines', function () {
    it('parses data frames across chunk boundaries', async function () {
      const chunks = [
        'event: message\ndata: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: [DONE]\n\n',
      ]
      async function* source() {
        for (const c of chunks) yield new TextEncoder().encode(c)
      }

      const events = []
      for await (const line of parseSseLines(source())) {
        events.push(line)
      }
      expect(events).to.have.lengthOf(2)
      expect(events[0]).to.include('"Hello"')
      expect(events[1]).to.equal('[DONE]')
    })
  })

  describe('Anthropic Provider Client', function () {
    it('streams thinking, text, and tool_use blocks', async function () {
      const sseBody = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_1","name":"read_file","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"main.tex\\"}"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('')

      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(sseBody)
        })(),
      }

      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-3-7-sonnet',
        fetchFn: sinon.stub().resolves(fakeResponse),
      })

      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        chunks.push(chunk)
      }

      expect(chunks).to.deep.include({ type: 'thinking', text: 'Plan' })
      expect(chunks).to.deep.include({ type: 'text', text: 'Hi' })
      expect(chunks).to.deep.include({
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        args: { path: 'main.tex' },
      })
    })

    it('throws ProviderError on non-200 responses', async function () {
      const fakeResponse = {
        ok: false,
        status: 401,
        json: sinon.stub().resolves({ error: { message: 'Invalid API key' } }),
      }

      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'bad-key',
        model: 'claude-3-7-sonnet',
        fetchFn: sinon.stub().resolves(fakeResponse),
      })

      let error = null
      try {
        for await (const event of client.streamChat({ system: 'x', messages: [] })) {
          if (event) break
        }
      } catch (err) {
        error = err
      }

      expect(error).to.be.instanceOf(ProviderError)
      expect(error.status).to.equal(401)
      expect(error.message).to.include('Invalid API key')
    })

    it('does not inject thinking config for non-Claude models containing 3.7', async function () {
      const sseBody = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('')
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(sseBody)
        })(),
      }
      const fetchStub = sinon.stub().resolves(fakeResponse)
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'qwen3.7 max (free)',
        fetchFn: fetchStub,
      })
      for await (const _ of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {}
      const calledBody = JSON.parse(fetchStub.firstCall.args[1]?.body)
      expect(calledBody).to.not.have.property('thinking')
      expect(calledBody.model).to.equal('qwen3.7 max (free)')
    })

    it('surfaces Anthropic error event frame as a thrown ProviderError', async function () {
      const sseBody = [
        'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"Invalid x-api-key"}}\n\n',
      ].join('')

      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(sseBody)
        })(),
      }

      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'bad-key',
        model: 'claude-3-7-sonnet',
        fetchFn: sinon.stub().resolves(fakeResponse),
      })

      let error = null
      try {
        for await (const _ of client.streamChat({ system: 'x', messages: [] })) {}
      } catch (err) {
        error = err
      }

      expect(error).to.be.instanceOf(ProviderError)
      expect(error.code).to.equal('providerAuth')
      expect(error.message).to.include('Invalid x-api-key')
    })

    it('attaches prompt cache control breakpoints when cacheHints are provided', async function () {
      let sentPayload = null
      const fakeFetch = sinon.stub().callsFake((_url, opts) => {
        sentPayload = JSON.parse(opts.body)
        const sseBody = 'data: {"type":"message_stop"}\n\n'
        return Promise.resolve({
          ok: true,
          status: 200,
          body: (async function* () {
            yield new TextEncoder().encode(sseBody)
          })(),
        })
      })

      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'key',
        model: 'claude-3-7-sonnet',
        fetchFn: fakeFetch,
      })

      for await (const _ of client.streamChat({
        system: 'You are an assistant.',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Reply 1' },
          { role: 'user', content: 'Turn 2' },
        ],
        tools: [
          { name: 'tool_a', description: 'desc a', parameters: {} },
          { name: 'tool_b', description: 'desc b', parameters: {} },
        ],
        cacheHints: {
          cacheSystem: true,
          cacheTools: true,
          lastStableMessage: 1,
        },
      })) {}

      expect(sentPayload).to.exist
      // 1. System prompt cached
      expect(sentPayload.system).to.deep.equal([
        { type: 'text', text: 'You are an assistant.', cache_control: { type: 'ephemeral' } },
      ])
      // 2. Only the last tool is marked
      expect(sentPayload.tools[0].cache_control).to.be.undefined
      expect(sentPayload.tools[1].cache_control).to.deep.equal({ type: 'ephemeral' })
      // 3. The newest message, and the message before the newest assistant
      //    turn (the previous request's breakpoint)
      expect(sentPayload.messages[2].content).to.deep.equal([
        { type: 'text', text: 'Turn 2', cache_control: { type: 'ephemeral' } },
      ])
      expect(sentPayload.messages[1].content).to.equal('Reply 1')
      expect(sentPayload.messages[0].content).to.deep.equal([
        { type: 'text', text: 'Turn 1', cache_control: { type: 'ephemeral' } },
      ])
    })
  })

  describe('markMessageCacheBreakpoints', function () {
    const ephemeral = { type: 'ephemeral' }

    it('marks the merged tool-result message, not an index counted before merging', function () {
      const wire = [
        { role: 'user', content: 'fix it' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
            { type: 'tool_use', id: 't2', name: 'read_file', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'a' },
            { type: 'tool_result', tool_use_id: 't2', content: 'b' },
          ],
        },
      ]

      markMessageCacheBreakpoints(wire)

      expect(wire[2].content[1].cache_control).to.deep.equal(ephemeral)
      expect(wire[2].content[0].cache_control).to.equal(undefined)
      expect(wire[1].content.some(block => block.cache_control)).to.equal(false)
      expect(wire[0].content).to.deep.equal([
        { type: 'text', text: 'fix it', cache_control: ephemeral },
      ])
    })

    it('marks only the newest message when there is no assistant turn', function () {
      const wire = [{ role: 'user', content: 'hello' }]
      markMessageCacheBreakpoints(wire)
      expect(wire[0].content).to.deep.equal([
        { type: 'text', text: 'hello', cache_control: ephemeral },
      ])
    })

    it('never marks more than two messages', function () {
      const wire = []
      for (let i = 0; i < 6; i++) {
        wire.push({ role: 'user', content: `q${i}` })
        wire.push({ role: 'assistant', content: `a${i}` })
      }
      wire.push({ role: 'user', content: 'latest' })

      markMessageCacheBreakpoints(wire)

      const marked = wire.filter(
        message => Array.isArray(message.content) && message.content.some(block => block.cache_control)
      )
      expect(marked).to.have.length(2)
      expect(wire.at(-1).content[0].cache_control).to.deep.equal(ephemeral)
      expect(wire.at(-3).content[0].cache_control).to.deep.equal(ephemeral)
    })

    it('sends at most four cache breakpoints for a multi-call tool turn', async function () {
      let sentPayload = null
      const fakeFetch = sinon.stub().callsFake((_url, opts) => {
        sentPayload = JSON.parse(opts.body)
        return Promise.resolve({
          ok: true,
          status: 200,
          body: (async function* () {
            yield new TextEncoder().encode('data: {"type":"message_stop"}\n\n')
          })(),
        })
      })
      const client = createProviderClient({ type: 'anthropic', apiKey: 'k', model: 'claude-opus-5', fetchFn: fakeFetch })

      for await (const _ of client.streamChat({
        system: 'sys',
        messages: [
          { role: 'user', content: 'fix it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't1', name: 'read_file', args: { path: 'a.tex' } },
              { id: 't2', name: 'read_file', args: { path: 'b.tex' } },
            ],
          },
          { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'a' },
          { role: 'tool', toolCallId: 't2', name: 'read_file', content: 'b' },
        ],
        tools: [{ name: 'read_file', description: 'r', parameters: {} }],
        cacheHints: { cacheSystem: true, cacheTools: true, lastStableMessage: 2 },
      })) {}

      expect(sentPayload.messages).to.have.length(3)
      expect(sentPayload.messages[2].content.at(-1).cache_control).to.deep.equal(ephemeral)
      const count = JSON.stringify(sentPayload).split('"cache_control"').length - 1
      expect(count).to.be.at.most(4)
    })
  })

  describe('listModels', function () {
    async function rejectionOf(promise) {
      try {
        await promise
      } catch (err) {
        return err
      }
      throw new Error('expected rejection')
    }

    function jsonResponse(body, status = 200) {
      return { ok: status >= 200 && status < 300, status, json: async () => body }
    }

    it('lists Ollama models from native /api/tags', async function () {
      const fetchFn = sinon.stub().resolves(
        jsonResponse({ models: [{ name: 'qwen3:8b' }, { name: 'gemma4:cloud', details: { context_length: 256000 } }] })
      )
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://ollama.lan:11434/v1', model: 'x', fetchFn })
      const models = await client.listModels()
      expect(fetchFn.firstCall.args[0]).to.equal('http://ollama.lan:11434/api/tags')
      expect(models.map(m => m.id)).to.deep.equal(['gemma4:cloud', 'qwen3:8b'])
      expect(models[0]).to.include({ contextWindow: 256000, maxOutputTokens: 65536 })
    })

    it('lists OpenAI-compatible models under /v1/models', async function () {
      const fetchFn = sinon.stub().resolves(jsonResponse({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }))
      const client = createProviderClient({ type: 'openai', baseUrl: 'https://gw.example.com', apiKey: 'k', model: 'x', fetchFn })
      const models = await client.listModels()
      expect(fetchFn.firstCall.args[0]).to.equal('https://gw.example.com/v1/models')
      expect(fetchFn.firstCall.args[1].headers.Authorization).to.equal('Bearer k')
      expect(models.map(m => m.id)).to.deep.equal(['gpt-a', 'gpt-b'])
    })

    it('pages through Anthropic models', async function () {
      const fetchFn = sinon.stub()
      fetchFn.onFirstCall().resolves(jsonResponse({ data: [{ id: 'm1' }], has_more: true, last_id: 'm1' }))
      fetchFn.onSecondCall().resolves(jsonResponse({ data: [{ id: 'm2', display_name: 'Model 2' }], has_more: false }))
      const client = createProviderClient({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'x', fetchFn })
      const models = await client.listModels()
      expect(fetchFn.secondCall.args[0]).to.include('after_id=m1')
      expect(models).to.deep.equal([{ id: 'm1', label: 'm1' }, { id: 'm2', label: 'Model 2' }])
    })

    it('keeps only Gemini models that generate content', async function () {
      const fetchFn = sinon.stub().resolves(
        jsonResponse({
          models: [
            { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          ],
        })
      )
      const client = createProviderClient({ type: 'google', apiKey: 'k', model: 'x', fetchFn })
      const models = await client.listModels()
      expect(models.map(m => m.id)).to.deep.equal(['gemini-2.5-pro'])
    })

    it('maps upstream failures to provider error codes', async function () {
      const auth = createProviderClient({
        type: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'bad', model: 'x',
        fetchFn: sinon.stub().resolves(jsonResponse({ error: { message: 'bad key' } }, 401)),
      })
      expect(await rejectionOf(auth.listModels())).to.include({ code: 'providerAuth', message: 'bad key' })

      const missing = createProviderClient({
        type: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'k', model: 'x',
        fetchFn: sinon.stub().resolves(jsonResponse({}, 404)),
      })
      expect(await rejectionOf(missing.listModels())).to.include({ code: 'modelsUnsupported' })

      const unreachable = createProviderClient({
        type: 'ollama', baseUrl: 'http://10.0.0.5:11434', model: 'x',
        fetchFn: sinon.stub().rejects(new TypeError('fetch failed')),
      })
      expect(await rejectionOf(unreachable.listModels())).to.include({ code: 'network' })
    })
  })

  describe('Ollama Provider Client', function () {
    it('streams thinking, text, and tool calls from native /api/chat', async function () {
      const ndjsonBody = [
        JSON.stringify({ message: { role: 'assistant', thinking: 'Analyzing the paper...' } }) + '\n',
        JSON.stringify({ message: { role: 'assistant', content: 'Here is the answer' } }) + '\n',
        JSON.stringify({
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                function: { name: 'read_file', arguments: { path: 'main.tex' } },
              },
            ],
          },
        }) + '\n',
      ].join('')

      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(ndjsonBody)
        })(),
      }

      const client = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'gemma4:cloud',
        fetchFn: sinon.stub().resolves(fakeResponse),
      })

      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        chunks.push(chunk)
      }

      expect(chunks).to.deep.include({ type: 'thinking', text: 'Analyzing the paper...' })
      expect(chunks).to.deep.include({ type: 'text', text: 'Here is the answer' })
      expect(chunks).to.deep.include({
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        args: { path: 'main.tex' },
      })
    })
  })

  describe('OpenAI Provider Client thinking support', function () {
    it('streams reasoning_content as thinking', async function () {
      const sseBody = [
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(sseBody)
        })(),
      }

      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        model: 'o3-mini',
        fetchFn: sinon.stub().resolves(fakeResponse),
      })

      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'think' }],
      })) {
        chunks.push(chunk)
      }

      expect(chunks).to.deep.include({ type: 'thinking', text: 'Let me think' })
      expect(chunks).to.deep.include({ type: 'text', text: 'Done' })
    })

    it('extracts <think>...</think> tags embedded in delta content', async function () {
      const sseBody = [
        'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"nk>Internal thought</thi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"nk>Final response"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(sseBody)
        })(),
      }

      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        model: 'deepseek-r1',
        fetchFn: sinon.stub().resolves(fakeResponse),
      })

      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
      })) {
        chunks.push(chunk)
      }

      expect(chunks).to.deep.include({ type: 'thinking', text: 'Internal thought' })
      expect(chunks).to.deep.include({ type: 'text', text: 'Final response' })
    })
  })

  describe('Google Gemini Native Provider Client', function () {
    it('creates GoogleServerClient and connects to native streamGenerateContent endpoint', async function () {
      const sseBody = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Thinking about solution...","thought":true}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello from native Gemini"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"main.tex"}}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(sseBody)
        })(),
      }

      const fetchStub = sinon.stub().resolves(fakeResponse)
      const client = createProviderClient({
        type: 'google',
        apiKey: 'gemini-key',
        model: 'gemini-2.0-flash',
        fetchFn: fetchStub,
      })

      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        chunks.push(chunk)
      }

      expect(chunks).to.deep.include({ type: 'thinking', text: 'Thinking about solution...' })
      expect(chunks).to.deep.include({ type: 'text', text: 'Hello from native Gemini' })
      expect(chunks.some(c => c.type === 'tool_call' && c.name === 'read_file')).to.be.true
      expect(fetchStub.calledOnce).to.be.true
      const calledUrl = fetchStub.firstCall.args[0]
      expect(calledUrl).to.include('generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse')
      const calledHeaders = fetchStub.firstCall.args[1]?.headers
      expect(calledHeaders['x-goog-api-key']).to.equal('gemini-key')
      const calledBody = JSON.parse(fetchStub.firstCall.args[1]?.body)
      expect(calledBody.contents[0].parts[0].text).to.equal('hello')
      expect(calledBody.systemInstruction.parts[0].text).to.equal('test')
    })

    it('properly URL-encodes model names containing parentheses and spaces', async function () {
      const sseBody = 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\ndata: [DONE]\n\n'
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(sseBody)
        })(),
      }
      const fetchStub = sinon.stub().resolves(fakeResponse)
      const client = createProviderClient({
        type: 'google',
        apiKey: 'gemini-key',
        model: 'qwen3.8 max (free)',
        fetchFn: fetchStub,
      })
      for await (const _ of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {}
      expect(fetchStub.calledOnce).to.be.true
      const calledUrl = fetchStub.firstCall.args[0]
      expect(calledUrl).to.include('models/qwen3.8%20max%20%28free%29:streamGenerateContent?alt=sse')
    })
  })

  describe('fetchWithRetry', function () {
    it('retries on transient 503 and returns response on success', async function () {
      const failResponse = {
        ok: false,
        status: 503,
        headers: new Map(),
      }
      failResponse.headers.get = () => null

      const successResponse = {
        ok: true,
        status: 200,
      }

      const fetchStub = sinon.stub()
      fetchStub.onFirstCall().resolves(failResponse)
      fetchStub.onSecondCall().resolves(successResponse)

      const { fetchWithRetry } = await import('../../../app/src/AiAssistProviders.mjs')
      const res = await fetchWithRetry('https://api.example.com', {}, {
        maxRetries: 2,
        initialDelayMs: 10,
        fetchFn: fetchStub,
      })

      expect(res.status).to.equal(200)
      expect(fetchStub.calledTwice).to.be.true
    })

    it('aborts mid-backoff and throws ProviderError with code aborted and message Request was cancelled', async function () {
      const failResponse = {
        ok: false,
        status: 503,
        headers: new Map(),
      }
      failResponse.headers.get = () => null

      const fetchStub = sinon.stub().resolves(failResponse)
      const controller = new AbortController()

      const promise = fetchWithRetry('https://api.example.com', { signal: controller.signal }, {
        maxRetries: 2,
        initialDelayMs: 200,
        fetchFn: fetchStub,
      })

      // Abort while waiting in backoff
      await new Promise(r => setTimeout(r, 20))
      controller.abort()

      let error = null
      try {
        await promise
      } catch (err) {
        error = err
      }

      expect(error).to.be.instanceOf(ProviderError)
      expect(error.code).to.equal('aborted')
      expect(error.message).to.equal('Request was cancelled')
    })

    it('cleans up abort listener after backoff resolves normally', async function () {
      const failResponse = {
        ok: false,
        status: 503,
        headers: new Map(),
      }
      failResponse.headers.get = () => null
      const successResponse = { ok: true, status: 200 }

      const fetchStub = sinon.stub()
      fetchStub.onFirstCall().resolves(failResponse)
      fetchStub.onSecondCall().resolves(successResponse)

      const controller = new AbortController()
      const removeListenerSpy = sinon.spy(controller.signal, 'removeEventListener')

      await fetchWithRetry('https://api.example.com', { signal: controller.signal }, {
        maxRetries: 2,
        initialDelayMs: 10,
        fetchFn: fetchStub,
      })

      expect(removeListenerSpy.calledWith('abort')).to.be.true
    })
  })

  describe('timeouts and watchdog', function () {
    it('aborts when connect timeout elapses before headers arrive', async function () {
      const hangingFetch = sinon.stub().callsFake((_url, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        fetchFn: hangingFetch,
        connectTimeoutMs: 15,
      })

      let error = null
      try {
        for await (const _ of client.streamChat({ system: 'x', messages: [] })) {}
      } catch (err) {
        error = err
      }

      expect(error).to.exist
      expect(error.code).to.equal('aborted')
    })

    it('aborts when stream stalls and idle watchdog timeout elapses', async function () {
      const fetchStub = sinon.stub().callsFake((_url, opts) => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"start"}}]}\n\n')
            )
            opts?.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted')
              err.name = 'AbortError'
              controller.error(err)
            })
          },
        })
        return Promise.resolve({
          ok: true,
          status: 200,
          body: stream,
        })
      })

      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        fetchFn: fetchStub,
        streamIdleTimeoutMs: 25,
      })

      let error = null
      const chunks = []
      try {
        for await (const chunk of client.streamChat({ system: 'x', messages: [] })) {
          chunks.push(chunk)
        }
      } catch (err) {
        error = err
      }

      expect(chunks).to.have.lengthOf(1)
      expect(error).to.exist
      expect(error.code).to.equal('providerError')
      expect(error.message).to.include('stalled')
    })

    it('allows a stream that emits chunks within idle watchdog interval', async function () {
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"chunk1"}}]}\n\n')
          await new Promise(r => setTimeout(r, 10))
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"chunk2"}}]}\n\n')
          yield new TextEncoder().encode('data: [DONE]\n\n')
        })(),
      }

      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        fetchFn: sinon.stub().resolves(fakeResponse),
        streamIdleTimeoutMs: 50,
      })

      const chunks = []
      for await (const chunk of client.streamChat({ system: 'x', messages: [] })) {
        chunks.push(chunk)
      }

      expect(chunks).to.have.lengthOf(2)
      expect(chunks[0].text).to.equal('chunk1')
      expect(chunks[1].text).to.equal('chunk2')
    })

    it('exits OpenAI stream and yields tool calls when finish_reason is received without [DONE]', async function () {
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"thinking about edit"}}]}\n\n')
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"edit_file","arguments":"{\\"path\\":\\"main.tex\\"}"}}]}}]}\n\n')
          yield new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
          // Never emits [DONE], but stream shouldn't hang
        })(),
      }

      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        fetchFn: sinon.stub().resolves(fakeResponse),
        streamIdleTimeoutMs: 500,
      })

      const chunks = []
      for await (const chunk of client.streamChat({ system: 'x', messages: [] })) {
        chunks.push(chunk)
      }

      expect(chunks).to.have.lengthOf(2)
      expect(chunks[0].type).to.equal('thinking')
      expect(chunks[0].text).to.equal('thinking about edit')
      expect(chunks[1].type).to.equal('tool_call')
      expect(chunks[1].name).to.equal('edit_file')
      expect(chunks[1].args).to.deep.equal({ path: 'main.tex' })
    })

    it('exits Anthropic stream immediately on message_stop', async function () {
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode('data: {"type":"message_start","message":{"id":"msg_1"}}\n\n')
          yield new TextEncoder().encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n')
          yield new TextEncoder().encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"main.tex\\"}"}}\n\n')
          yield new TextEncoder().encode('data: {"type":"content_block_stop","index":0}\n\n')
          yield new TextEncoder().encode('data: {"type":"message_stop"}\n\n')
        })(),
      }

      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'key',
        fetchFn: sinon.stub().resolves(fakeResponse),
        streamIdleTimeoutMs: 500,
      })

      const chunks = []
      for await (const chunk of client.streamChat({ system: 'x', messages: [] })) {
        chunks.push(chunk)
      }

      expect(chunks).to.have.lengthOf(1)
      expect(chunks[0].type).to.equal('tool_call')
      expect(chunks[0].name).to.equal('read_file')
      expect(chunks[0].args).to.deep.equal({ path: 'main.tex' })
    })

    it('exits Ollama stream when done: true is received', async function () {
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode('{"message":{"thinking":"analyzing"}}\n')
          yield new TextEncoder().encode('{"message":{"tool_calls":[{"function":{"name":"read_file","arguments":{"path":"main.tex"}}}]},"done":true}\n')
        })(),
      }

      const client = createProviderClient({
        type: 'ollama',
        apiKey: '',
        fetchFn: sinon.stub().resolves(fakeResponse),
        streamIdleTimeoutMs: 500,
      })

      const chunks = []
      for await (const chunk of client.streamChat({ system: 'x', messages: [] })) {
        chunks.push(chunk)
      }

      expect(chunks).to.have.lengthOf(2)
      expect(chunks[0].type).to.equal('thinking')
      expect(chunks[1].type).to.equal('tool_call')
      expect(chunks[1].name).to.equal('read_file')
    })
  })

  describe('safeParseToolArgs', function () {
    it('parses valid JSON string', function () {
      expect(safeParseToolArgs('{"path":"main.tex","oldText":"a"}')).to.deep.equal({
        path: 'main.tex',
        oldText: 'a',
      })
    })

    it('returns empty object for empty or whitespace string', function () {
      expect(safeParseToolArgs('')).to.deep.equal({})
      expect(safeParseToolArgs('   ')).to.deep.equal({})
      expect(safeParseToolArgs(null)).to.deep.equal({})
    })

    it('repairs common truncated JSON strings and marks them repaired', function () {
      const repaired = safeParseToolArgs('{"path":"main.tex","newText":"hello')
      expect(repaired.path).to.equal('main.tex')
      expect(repaired.newText).to.equal('hello')
      expect(repaired._repaired).to.equal(true)
    })

    it('does not mark complete JSON as repaired', function () {
      expect(safeParseToolArgs('{"path":"main.tex"}')).to.not.have.property('_repaired')
    })

    it('returns _parseError flag for unrecoverable malformed JSON', function () {
      const bad = safeParseToolArgs('{something invalid without quotes or values')
      expect(bad._parseError).to.be.true
    })
  })

  describe('output limit signal', function () {
    const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const streamOf = text => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(text)
      })(),
    })
    const collect = async client => {
      const chunks = []
      for await (const chunk of client.streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 })) {
        chunks.push(chunk)
      }
      return chunks
    }

    it('Anthropic: yields stop after a tool call cut off at max_tokens', async function () {
      const body = sse([
        { type: 'message_start', message: { id: 'm1' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"main.tex","newText":"abc' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        { type: 'message_stop' },
      ])
      const client = createProviderClient({ type: 'anthropic', apiKey: 'k', model: 'claude-opus-5', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({ type: 'stop', reason: 'max_tokens' })
      const call = chunks.find(chunk => chunk.type === 'tool_call')
      expect(call.args).to.deep.equal({ path: 'main.tex', newText: 'abc', _repaired: true })
    })

    it('Anthropic: yields no stop chunk for a normal end_turn', async function () {
      const body = sse([
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
      const client = createProviderClient({ type: 'anthropic', apiKey: 'k', model: 'claude-opus-5', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.some(chunk => chunk.type === 'stop')).to.equal(false)
    })

    it('OpenAI: yields stop when finish_reason is length', async function () {
      const body = sse([
        { choices: [{ delta: { content: 'partial' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ])
      const client = createProviderClient({ type: 'openai', apiKey: 'k', model: 'gpt-4o', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({ type: 'stop', reason: 'max_tokens' })
    })

    it('Gemini: yields stop when finishReason is MAX_TOKENS', async function () {
      const body = sse([
        { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] },
      ])
      const client = createProviderClient({ type: 'google', apiKey: 'k', model: 'gemini-2.0-flash', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({ type: 'stop', reason: 'max_tokens' })
    })

    it('Ollama: yields stop when done_reason is length', async function () {
      const body = [
        JSON.stringify({ message: { content: 'partial' } }),
        JSON.stringify({ message: { content: '' }, done: true, done_reason: 'length' }),
      ].join('\n') + '\n'
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({ type: 'stop', reason: 'max_tokens' })
    })
  })

  describe('OpenAI request parameters', function () {
    const okStream = () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n')
      })(),
    })
    const send = async settings => {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({ type: 'openai', apiKey: 'k', model: 'gpt-5', fetchFn, ...settings })
      for await (const _ of client.streamChat({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1000,
        cacheHints: { cacheSystem: true, cacheTools: true, lastStableMessage: null, cacheKey: 'project-1' },
      })) {}
      return body
    }

    it('recognises only api.openai.com as the official API', function () {
      expect(isOfficialOpenAiUrl('https://api.openai.com')).to.equal(true)
      expect(isOfficialOpenAiUrl('https://api.openai.com/v1')).to.equal(true)
      expect(isOfficialOpenAiUrl('https://openrouter.ai/api/v1')).to.equal(false)
      expect(isOfficialOpenAiUrl('not a url')).to.equal(false)
    })

    it('hashes the cache key to 32 hex characters', function () {
      expect(promptCacheKey('project-1')).to.match(/^[0-9a-f]{32}$/)
      expect(promptCacheKey('project-1')).to.equal(promptCacheKey('project-1'))
      expect(promptCacheKey('project-1')).to.not.equal(promptCacheKey('project-2'))
    })

    it('sends max_completion_tokens and prompt_cache_key to api.openai.com', async function () {
      const body = await send({})
      expect(body.max_completion_tokens).to.equal(1000)
      expect(body).to.not.have.property('max_tokens')
      expect(body.prompt_cache_key).to.equal(promptCacheKey('project-1'))
      expect(body).to.not.have.property('stream_options')
    })

    it('keeps max_tokens and sends no OpenAI-only fields to compatible gateways', async function () {
      const body = await send({ baseUrl: 'https://openrouter.ai/api/v1' })
      expect(body.max_tokens).to.equal(1000)
      expect(body).to.not.have.property('max_completion_tokens')
      expect(body).to.not.have.property('prompt_cache_key')
    })
  })

  describe('Ollama request parameters', function () {
    const okStream = () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(JSON.stringify({ message: { content: 'hi' }, done: true, done_reason: 'stop' }) + '\n')
      })(),
    })

    it('sends the context window as num_ctx', async function () {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', fetchFn })

      for await (const _ of client.streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 512, contextWindow: 32768 })) {}

      expect(body.options).to.deep.equal({ num_predict: 512, num_ctx: 32768 })
    })

    it('omits num_ctx when no context window is given', async function () {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', fetchFn })

      for await (const _ of client.streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 512 })) {}

      expect(body.options).to.deep.equal({ num_predict: 512 })
    })

    it('retries without think for a model that does not support thinking, and remembers it', async function () {
      const bodies = []
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        const body = JSON.parse(opts.body)
        bodies.push(body)
        if (body.think) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: async () => ({ error: '"no-think-test:1b" does not support thinking' }),
          })
        }
        return Promise.resolve(okStream())
      })
      const settings = { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'no-think-test:1b', fetchFn }

      const chunks = []
      for await (const chunk of createProviderClient(settings).streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(chunk)
      }
      expect(chunks).to.deep.include({ type: 'text', text: 'hi' })
      expect(bodies).to.have.length(2)
      expect(bodies[0].think).to.equal(true)
      expect(bodies[1]).to.not.have.property('think')

      // A new client for the same model skips the failing attempt.
      for await (const _ of createProviderClient(settings).streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }] })) {}
      expect(bodies).to.have.length(3)
      expect(bodies[2]).to.not.have.property('think')
    })

    it('still surfaces other 400 errors', async function () {
      const fetchFn = sinon.stub().resolves({
        ok: false,
        status: 400,
        json: async () => ({ error: 'model "missing:7b" not found' }),
      })
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'missing:7b', fetchFn })

      let error = null
      try {
        for await (const _ of client.streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }] })) {}
      } catch (err) {
        error = err
      }
      expect(error).to.be.an.instanceOf(ProviderError)
      expect(error.message).to.include('not found')
      expect(fetchFn.callCount).to.equal(1)
    })
  })
})
