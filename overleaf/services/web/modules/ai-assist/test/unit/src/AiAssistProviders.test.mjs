import { expect } from 'chai'
import sinon from 'sinon'
import {
  createProviderClient,
  ProviderError,
  parseSseLines,
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

    it('repairs common truncated JSON strings', function () {
      const repaired = safeParseToolArgs('{"path":"main.tex","newText":"hello')
      expect(repaired.path).to.equal('main.tex')
      expect(repaired.newText).to.equal('hello')
    })

    it('returns _parseError flag for unrecoverable malformed JSON', function () {
      const bad = safeParseToolArgs('{something invalid without quotes or values')
      expect(bad._parseError).to.be.true
    })
  })
})
