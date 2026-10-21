import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  anthropicSystemField,
  cacheControlValue,
  createProviderClient,
  GoogleServerClient,
  OllamaServerClient,
  OpenAiServerClient,
  fetchWithRetry,
  toolWireSpec,
  isOfficialOpenAiUrl,
  markMessageCacheBreakpoints,
  parseSseLines,
  promptCacheKey,
  safeParseToolArgs,
  toGeminiContents,
  toolImageTurns,
  toOllamaMessages,
  validateSafeProviderBaseUrl,
  normalizeProviderBaseUrl,
} from '../../../app/src/AiAssistProviders.mjs'
import Settings from '@overleaf/settings'
import { dockerHostGateway } from '../../../app/src/DockerHost.mjs'
import { readJsonReply } from '../../../app/src/AiAssistProviders.mjs'
import { ProviderError } from '../../../app/src/AiAssistErrors.mjs'

describe('AiAssistProviders', function () {
  describe('validateSafeProviderBaseUrl', function () {
    it('allows standard public cloud LLM endpoints', function () {
      expect(() =>
        validateSafeProviderBaseUrl('https://api.openai.com/v1')
      ).to.not.throw()
      expect(() =>
        validateSafeProviderBaseUrl('https://api.anthropic.com')
      ).to.not.throw()
      expect(() =>
        validateSafeProviderBaseUrl('https://generativelanguage.googleapis.com')
      ).to.not.throw()
    })

    it('refuses the Docker host gateway a user-typed Ollama URL is mapped to', function () {
      const gateway = dockerHostGateway()
      expect(() =>
        validateSafeProviderBaseUrl(`http://${gateway}:11434`)
      ).to.throw(/private network address/)
    })

    it('allows a private provider address the admin configured in an env URL', function () {
      const saved = process.env.AI_ASSIST_SEARXNG_URLS
      process.env.AI_ASSIST_SEARXNG_URLS = 'http://192.168.50.9:8888'
      try {
        expect(() =>
          validateSafeProviderBaseUrl('http://192.168.50.9:11434')
        ).to.not.throw()
      } finally {
        if (saved === undefined) delete process.env.AI_ASSIST_SEARXNG_URLS
        else process.env.AI_ASSIST_SEARXNG_URLS = saved
      }
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
        expect(
          () => validateSafeProviderBaseUrl(url),
          `Should block ${url}`
        ).to.throw(ProviderError)
      }
    })

    it('blocks cloud metadata endpoints', function () {
      expect(() =>
        validateSafeProviderBaseUrl('http://169.254.169.254/latest/meta-data')
      ).to.throw(ProviderError)
      expect(() =>
        validateSafeProviderBaseUrl(
          'http://metadata.google.internal/computeMetadata/v1'
        )
      ).to.throw(ProviderError)
    })

    it('blocks non-HTTP protocols', function () {
      expect(() => validateSafeProviderBaseUrl('file:///etc/passwd')).to.throw(
        ProviderError
      )
      expect(() =>
        validateSafeProviderBaseUrl('gopher://127.0.0.1:6379')
      ).to.throw(ProviderError)
    })
  })

  describe('provider destinations', function () {
    it('refuses loopback and metadata addresses', function () {
      for (const url of [
        'http://127.0.0.1:11434',
        'http://169.254.169.254/latest',
        'http://[::1]:11434',
        'http://localhost:11434',
      ]) {
        expect(() => validateSafeProviderBaseUrl(url)).to.throw(ProviderError)
      }
    })

    it('accepts a LAN address, where a self-hosted provider lives', function () {
      expect(validateSafeProviderBaseUrl('http://203.0.113.20:11434')).to.be.true
    })
  })

  describe('normalizeProviderBaseUrl', function () {
    it('hard fixes the ending /v1 for openai endpoints', function () {
      expect(normalizeProviderBaseUrl('openai', '')).to.equal(
        'https://api.openai.com/v1'
      )
      expect(normalizeProviderBaseUrl('openai', 'https://api.openai.com')).to.equal(
        'https://api.openai.com/v1'
      )
      expect(normalizeProviderBaseUrl('openai', 'https://api.openai.com/')).to.equal(
        'https://api.openai.com/v1'
      )
      expect(normalizeProviderBaseUrl('openai', 'https://api.openai.com/v1')).to.equal(
        'https://api.openai.com/v1'
      )
      expect(normalizeProviderBaseUrl('openai', 'https://api.openai.com/v1/')).to.equal(
        'https://api.openai.com/v1'
      )
      expect(
        normalizeProviderBaseUrl(
          'openai',
          'https://api.openai.com/v1/chat/completions'
        )
      ).to.equal('https://api.openai.com/v1')
      expect(
        normalizeProviderBaseUrl(
          'openai',
          'https://api.openai.com/chat/completions'
        )
      ).to.equal('https://api.openai.com/v1')
      expect(
        normalizeProviderBaseUrl('openai', 'https://api.openai.com/v1/models')
      ).to.equal('https://api.openai.com/v1')
      expect(
        normalizeProviderBaseUrl('openai', 'http://localhost:1234')
      ).to.equal('http://localhost:1234/v1')
      expect(
        normalizeProviderBaseUrl('openai', 'http://localhost:1234/')
      ).to.equal('http://localhost:1234/v1')
      expect(
        normalizeProviderBaseUrl('openai', 'http://localhost:1234/v1')
      ).to.equal('http://localhost:1234/v1')
      expect(
        normalizeProviderBaseUrl('openai', 'https://openrouter.ai/api')
      ).to.equal('https://openrouter.ai/api/v1')
      expect(
        normalizeProviderBaseUrl('openai', 'https://openrouter.ai/api/v1')
      ).to.equal('https://openrouter.ai/api/v1')
    })

    it('defaults and cleans anthropic compatible endpoints without /v1 suffix', function () {
      expect(normalizeProviderBaseUrl('anthropic', '')).to.equal(
        'https://api.anthropic.com'
      )
      expect(
        normalizeProviderBaseUrl('anthropic', 'https://api.anthropic.com')
      ).to.equal('https://api.anthropic.com')
      expect(
        normalizeProviderBaseUrl('anthropic', 'https://api.anthropic.com/')
      ).to.equal('https://api.anthropic.com')
      expect(
        normalizeProviderBaseUrl('anthropic', 'https://api.anthropic.com/v1')
      ).to.equal('https://api.anthropic.com')
      expect(
        normalizeProviderBaseUrl(
          'anthropic',
          'https://api.anthropic.com/v1/messages'
        )
      ).to.equal('https://api.anthropic.com')
      expect(
        normalizeProviderBaseUrl('anthropic', 'https://api.deepseek.com')
      ).to.equal('https://api.deepseek.com')
      expect(
        normalizeProviderBaseUrl('anthropic', 'https://api.deepseek.com/v1')
      ).to.equal('https://api.deepseek.com')
      expect(
        normalizeProviderBaseUrl(
          'anthropic',
          'https://api.deepseek.com/v1/messages'
        )
      ).to.equal('https://api.deepseek.com')
      expect(
        normalizeProviderBaseUrl(
          'anthropic',
          'https://api.deepseek.com/v1/models'
        )
      ).to.equal('https://api.deepseek.com')
    })

    it('normalizes google gemini endpoints to have /v1beta and strip /openai', function () {
      expect(normalizeProviderBaseUrl('google', '')).to.equal(
        'https://generativelanguage.googleapis.com/v1beta'
      )
      expect(
        normalizeProviderBaseUrl(
          'google',
          'https://generativelanguage.googleapis.com'
        )
      ).to.equal('https://generativelanguage.googleapis.com/v1beta')
      expect(
        normalizeProviderBaseUrl(
          'google',
          'https://generativelanguage.googleapis.com/'
        )
      ).to.equal('https://generativelanguage.googleapis.com/v1beta')
      expect(
        normalizeProviderBaseUrl(
          'google',
          'https://generativelanguage.googleapis.com/v1beta'
        )
      ).to.equal('https://generativelanguage.googleapis.com/v1beta')
      expect(
        normalizeProviderBaseUrl(
          'google',
          'https://generativelanguage.googleapis.com/v1beta/'
        )
      ).to.equal('https://generativelanguage.googleapis.com/v1beta')
      expect(
        normalizeProviderBaseUrl(
          'google',
          'https://generativelanguage.googleapis.com/v1beta/openai'
        )
      ).to.equal('https://generativelanguage.googleapis.com/v1beta')
      expect(
        normalizeProviderBaseUrl(
          'google',
          'https://generativelanguage.googleapis.com/v1beta/openai/'
        )
      ).to.equal('https://generativelanguage.googleapis.com/v1beta')
      expect(
        normalizeProviderBaseUrl(
          'google',
          'https://generativelanguage.googleapis.com/v1beta/models'
        )
      ).to.equal('https://generativelanguage.googleapis.com/v1beta')
      expect(
        normalizeProviderBaseUrl('google', 'https://custom-proxy.com/v1')
      ).to.equal('https://custom-proxy.com/v1')
    })

    it('normalizes ollama endpoints to root host and strips /v1 or /api', function () {
      expect(normalizeProviderBaseUrl('ollama', '')).to.equal(
        'http://localhost:11434'
      )
      expect(
        normalizeProviderBaseUrl('ollama', 'http://localhost:11434')
      ).to.equal('http://localhost:11434')
      expect(
        normalizeProviderBaseUrl('ollama', 'http://localhost:11434/')
      ).to.equal('http://localhost:11434')
      expect(
        normalizeProviderBaseUrl('ollama', 'http://localhost:11434/v1')
      ).to.equal('http://localhost:11434')
      expect(
        normalizeProviderBaseUrl('ollama', 'http://localhost:11434/api')
      ).to.equal('http://localhost:11434')
      expect(
        normalizeProviderBaseUrl('ollama', 'http://localhost:11434/api/tags')
      ).to.equal('http://localhost:11434')
      expect(
        normalizeProviderBaseUrl('ollama', 'http://localhost:11434/api/chat')
      ).to.equal('http://localhost:11434')
      expect(
        normalizeProviderBaseUrl('ollama', 'http://ollama.lan:11434/v1')
      ).to.equal('http://ollama.lan:11434')
    })
  })

  describe('createProviderClient URL handling', function () {
    it('hard fixes OpenAI baseURL to end with /v1', function () {
      const client = createProviderClient({
        type: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'key',
        model: 'gpt-4o',
      })
      expect(client.baseURL).to.equal('https://api.openai.com/v1')
    })

    it('cleans Anthropic compatible baseURL so it does not end with /v1', function () {
      const client = createProviderClient({
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'key',
        model: 'claude-3-7-sonnet',
      })
      expect(client.baseURL).to.equal('https://api.anthropic.com')
    })

    it('ensures Google Gemini baseURL has /v1beta', function () {
      const client = createProviderClient({
        type: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'key',
        model: 'gemini-2.0-flash',
      })
      expect(client.baseURL).to.equal(
        'https://generativelanguage.googleapis.com/v1beta'
      )
    })

    it('ensures Ollama baseURL strips /v1', function () {
      const client = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://ollama.lan:11434/v1',
        model: 'llama3',
      })
      expect(client.baseURL).to.equal('http://ollama.lan:11434')
    })
  })

  describe('readJsonReply', function () {
    it('reads a reply within the cap', async function () {
      const res = new Response(JSON.stringify({ ok: 1 }))
      expect(await readJsonReply(res, 1024)).to.deep.equal({ ok: 1 })
    })

    it('refuses a reply past the cap', async function () {
      const res = new Response('x'.repeat(4096))
      let caught
      try {
        await readJsonReply(res, 1024)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(ProviderError)
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
        for await (const event of client.streamChat({
          system: 'x',
          messages: [],
        })) {
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
      })) {
      }
      const calledBody = JSON.parse(fetchStub.firstCall.args[1]?.body)
      expect(calledBody).to.not.have.property('thinking')
      expect(calledBody.model).to.equal('qwen3.7 max (free)')
    })

    it('sends adaptive thinking with the chosen effort level', async function () {
      const fetchStub = sinon.stub().resolves({
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          )
        })(),
      })
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'Qwen3.8 Max',
        reasoningEffort: 'max',
        fetchFn: fetchStub,
      })
      for await (const _ of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
      }
      const calledBody = JSON.parse(fetchStub.firstCall.args[1]?.body)
      expect(calledBody.thinking).to.deep.equal({ type: 'adaptive' })
      expect(calledBody.output_config).to.deep.equal({ effort: 'max' })
    })

    it('sends no thinking field when the switch is off', async function () {
      const fetchStub = sinon.stub().resolves({
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          )
        })(),
      })
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'Qwen3.8 Max',
        reasoningEffort: 'low',
        thinking: false,
        fetchFn: fetchStub,
      })
      for await (const _ of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
      }
      const calledBody = JSON.parse(fetchStub.firstCall.args[1]?.body)
      expect(calledBody).to.not.have.property('thinking')
      expect(calledBody.output_config).to.deep.equal({ effort: 'low' })
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
        for await (const _ of client.streamChat({
          system: 'x',
          messages: [],
        })) {
        }
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
      })) {
      }

      expect(sentPayload).to.exist
      // 1. System prompt cached
      expect(sentPayload.system).to.deep.equal([
        {
          type: 'text',
          text: 'You are an assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ])
      // 2. Only the last tool is marked
      expect(sentPayload.tools[0].cache_control).to.be.undefined
      expect(sentPayload.tools[1].cache_control).to.deep.equal({
        type: 'ephemeral',
      })
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

    it('sends a message typed while tools ran in the turn holding their results', async function () {
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
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'key',
        model: 'claude-sonnet-4-5',
        fetchFn: fakeFetch,
      })

      for await (const _ of client.streamChat({
        system: 'You are an assistant.',
        messages: [
          { role: 'user', content: 'fix it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 't1', name: 'read_file', args: {} }],
          },
          { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'a' },
          { role: 'user', content: 'also the title' },
          { role: 'user', content: 'and the date' },
        ],
        cacheHints: { cacheSystem: true },
      })) {
      }

      // One user turn after the assistant: results first, then each message
      expect(sentPayload.messages).to.have.length(3)
      expect(sentPayload.messages[2].role).to.equal('user')
      expect(sentPayload.messages[2].content).to.deep.equal([
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'a',
          is_error: false,
        },
        { type: 'text', text: 'also the title' },
        {
          type: 'text',
          text: 'and the date',
          cache_control: { type: 'ephemeral' },
        },
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
        message =>
          Array.isArray(message.content) &&
          message.content.some(block => block.cache_control)
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
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-opus-5',
        fetchFn: fakeFetch,
      })

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
        cacheHints: {
          cacheSystem: true,
          cacheTools: true,
          lastStableMessage: 2,
        },
      })) {
      }

      expect(sentPayload.messages).to.have.length(3)
      expect(
        sentPayload.messages[2].content.at(-1).cache_control
      ).to.deep.equal(ephemeral)
      const count =
        JSON.stringify(sentPayload).split('"cache_control"').length - 1
      expect(count).to.be.at.most(4)
    })

    it('uses 1h TTL when promptCacheTtl is set to 1h', () => {
      const orig = Settings.aiAssist?.promptCacheTtl
      try {
        if (!Settings.aiAssist) Settings.aiAssist = {}
        Settings.aiAssist.promptCacheTtl = '1h'
        expect(cacheControlValue()).to.deep.equal({
          type: 'ephemeral',
          ttl: '1h',
        })
        Settings.aiAssist.promptCacheTtl = '5m'
        expect(cacheControlValue()).to.deep.equal({
          type: 'ephemeral',
        })
      } finally {
        Settings.aiAssist.promptCacheTtl = orig
      }
    })
  })

  describe('toGeminiContents', () => {
    it('merges consecutive user turns when a mid-run message follows a tool result', () => {
      const messages = [
        { role: 'user', content: 'check this' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.tex' } }],
        },
        { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'file content' },
        { role: 'user', content: 'also check b.tex' },
      ]

      const contents = toGeminiContents(messages)
      // Alternating turns: user, model, user (with functionResponse + text)
      expect(contents).to.have.length(3)
      expect(contents[0].role).to.equal('user')
      expect(contents[1].role).to.equal('model')
      expect(contents[2].role).to.equal('user')
      expect(contents[2].parts).to.have.length(2)
      expect(contents[2].parts[0]).to.have.property('functionResponse')
      expect(contents[2].parts[1]).to.deep.equal({ text: 'also check b.tex' })
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
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }
    }

    it('lists Ollama models from native /api/tags', async function () {
      const fetchFn = sinon.stub().resolves(
        jsonResponse({
          models: [
            { name: 'qwen3:8b' },
            { name: 'gemma4:cloud', details: { context_length: 256000 } },
          ],
        })
      )
      const client = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://ollama.lan:11434/v1',
        model: 'x',
        fetchFn,
      })
      const models = await client.listModels()
      expect(fetchFn.firstCall.args[0]).to.equal(
        'http://ollama.lan:11434/api/tags'
      )
      expect(models.map(m => m.id)).to.deep.equal(['gemma4:cloud', 'qwen3:8b'])
      expect(models[0]).to.include({
        contextWindow: 256000,
        maxOutputTokens: 65536,
      })
    })

    it('lists OpenAI-compatible models under /v1/models', async function () {
      const fetchFn = sinon
        .stub()
        .resolves(jsonResponse({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }))
      const client = createProviderClient({
        type: 'openai',
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        model: 'x',
        fetchFn,
      })
      const models = await client.listModels()
      expect(fetchFn.firstCall.args[0]).to.equal(
        'https://gw.example.com/v1/models'
      )
      expect(fetchFn.firstCall.args[1].headers.Authorization).to.equal(
        'Bearer k'
      )
      expect(models.map(m => m.id)).to.deep.equal(['gpt-a', 'gpt-b'])
    })

    it('pages through Anthropic models', async function () {
      const fetchFn = sinon.stub()
      fetchFn
        .onFirstCall()
        .resolves(
          jsonResponse({ data: [{ id: 'm1' }], has_more: true, last_id: 'm1' })
        )
      fetchFn.onSecondCall().resolves(
        jsonResponse({
          data: [{ id: 'm2', display_name: 'Model 2' }],
          has_more: false,
        })
      )
      const client = createProviderClient({
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'k',
        model: 'x',
        fetchFn,
      })
      const models = await client.listModels()
      expect(fetchFn.secondCall.args[0]).to.include('after_id=m1')
      expect(models).to.deep.equal([
        { id: 'm1', label: 'm1' },
        { id: 'm2', label: 'Model 2' },
      ])
    })

    it('keeps only Gemini models that generate content', async function () {
      const fetchFn = sinon.stub().resolves(
        jsonResponse({
          models: [
            {
              name: 'models/gemini-2.5-pro',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/embedding-001',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        })
      )
      const client = createProviderClient({
        type: 'google',
        apiKey: 'k',
        model: 'x',
        fetchFn,
      })
      const models = await client.listModels()
      expect(models.map(m => m.id)).to.deep.equal(['gemini-2.5-pro'])
    })

    it('maps upstream failures to provider error codes', async function () {
      const auth = createProviderClient({
        type: 'openai',
        baseUrl: 'https://gw.example.com/v1',
        apiKey: 'bad',
        model: 'x',
        fetchFn: sinon
          .stub()
          .resolves(jsonResponse({ error: { message: 'bad key' } }, 401)),
      })
      expect(await rejectionOf(auth.listModels())).to.include({
        code: 'providerAuth',
        message: 'bad key',
      })

      const missing = createProviderClient({
        type: 'openai',
        baseUrl: 'https://gw.example.com/v1',
        apiKey: 'k',
        model: 'x',
        fetchFn: sinon.stub().resolves(jsonResponse({}, 404)),
      })
      expect(await rejectionOf(missing.listModels())).to.include({
        code: 'modelsUnsupported',
      })

      const unreachable = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://203.0.113.5:11434',
        model: 'x',
        fetchFn: sinon.stub().rejects(new TypeError('fetch failed')),
      })
      expect(await rejectionOf(unreachable.listModels())).to.include({
        code: 'network',
      })
    })
  })

  describe('Ollama Provider Client', function () {
    it('streams thinking, text, and tool calls from native /api/chat', async function () {
      const ndjsonBody = [
        JSON.stringify({
          message: { role: 'assistant', thinking: 'Analyzing the paper...' },
        }) + '\n',
        JSON.stringify({
          message: { role: 'assistant', content: 'Here is the answer' },
        }) + '\n',
        JSON.stringify({
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'read_file',
                  arguments: { path: 'main.tex' },
                },
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
        baseUrl: 'http://203.0.113.20:11434',
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

      expect(chunks).to.deep.include({
        type: 'thinking',
        text: 'Analyzing the paper...',
      })
      expect(chunks).to.deep.include({
        type: 'text',
        text: 'Here is the answer',
      })
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

    it('sends only the chosen reasoning_effort, with no thinking switch', async function () {
      const fetchStub = sinon.stub().resolves({
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode('data: [DONE]\n\n')
        })(),
      })
      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        thinking: false,
        fetchFn: fetchStub,
      })
      for await (const _ of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
      }
      const calledBody = JSON.parse(fetchStub.firstCall.args[1]?.body)
      expect(calledBody.reasoning_effort).to.equal('high')
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

      expect(chunks).to.deep.include({
        type: 'thinking',
        text: 'Internal thought',
      })
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

      expect(chunks).to.deep.include({
        type: 'thinking',
        text: 'Thinking about solution...',
      })
      expect(chunks).to.deep.include({
        type: 'text',
        text: 'Hello from native Gemini',
      })
      expect(chunks.some(c => c.type === 'tool_call' && c.name === 'read_file'))
        .to.be.true
      expect(fetchStub.calledOnce).to.be.true
      const calledUrl = fetchStub.firstCall.args[0]
      expect(calledUrl).to.include(
        'generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
      )
      const calledHeaders = fetchStub.firstCall.args[1]?.headers
      expect(calledHeaders['x-goog-api-key']).to.equal('gemini-key')
      const calledBody = JSON.parse(fetchStub.firstCall.args[1]?.body)
      expect(calledBody.contents[0].parts[0].text).to.equal('hello')
      expect(calledBody.systemInstruction.parts[0].text).to.equal('test')
    })

    it('properly URL-encodes model names containing parentheses and spaces', async function () {
      const sseBody =
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\ndata: [DONE]\n\n'
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
      })) {
      }
      expect(fetchStub.calledOnce).to.be.true
      const calledUrl = fetchStub.firstCall.args[0]
      expect(calledUrl).to.include(
        'models/qwen3.8%20max%20%28free%29:streamGenerateContent?alt=sse'
      )
    })
  })

  describe('provider usage', function () {
    function fakeStream(body) {
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(body)
        })(),
      }
    }

    function sseOf(frames) {
      return frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
    }

    async function collect(client) {
      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        chunks.push(chunk)
      }
      return chunks
    }

    function usageOf(chunks) {
      return chunks.filter(chunk => chunk.type === 'usage')
    }

    it('reads Anthropic input counts from message_start and output from message_delta', async function () {
      const sseBody = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":5,"cache_read_input_tokens":7,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('')
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-3-7-sonnet',
        fetchFn: sinon.stub().resolves(fakeStream(sseBody)),
      })

      const chunks = await collect(client)

      expect(usageOf(chunks)).to.deep.equal([
        {
          type: 'usage',
          usage: {
            inputTokens: 12,
            outputTokens: 42,
            cacheReadTokens: 7,
            cacheCreationTokens: 5,
          },
        },
      ])
      expect(chunks).to.deep.include({ type: 'text', text: 'Hi' })
    })

    it('asks OpenAI for usage and takes cached tokens out of the prompt count', async function () {
      const sseBody = sseOf([
        { choices: [{ delta: { content: 'Done' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 9,
            prompt_tokens_details: { cached_tokens: 30 },
          },
        },
      ]).concat('data: [DONE]\n\n')
      const fetchFn = sinon.stub().resolves(fakeStream(sseBody))
      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        model: 'gpt-4o',
        fetchFn,
      })

      const chunks = await collect(client)

      const payload = JSON.parse(fetchFn.firstCall.args[1].body)
      expect(payload.stream_options).to.deep.equal({ include_usage: true })
      // The usage chunk comes after the finish reason, so it must still be read
      expect(usageOf(chunks)).to.deep.equal([
        {
          type: 'usage',
          usage: {
            inputTokens: 70,
            outputTokens: 9,
            cacheReadTokens: 30,
            cacheCreationTokens: 0,
          },
        },
      ])
      expect(chunks).to.deep.include({ type: 'text', text: 'Done' })
    })

    it('sends no stream_options to a compatible gateway, and yields no usage it did not send', async function () {
      const sseBody = sseOf([
        { choices: [{ delta: { content: 'Done' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]).concat('data: [DONE]\n\n')
      const fetchFn = sinon.stub().resolves(fakeStream(sseBody))
      const client = createProviderClient({
        type: 'openai',
        baseUrl: 'https://gateway.example.com/v1',
        apiKey: 'key',
        model: 'some-model',
        fetchFn,
      })

      const chunks = await collect(client)

      const payload = JSON.parse(fetchFn.firstCall.args[1].body)
      expect(payload).to.not.have.property('stream_options')
      expect(usageOf(chunks)).to.have.lengthOf(0)
      expect(chunks).to.deep.include({ type: 'text', text: 'Done' })
    })

    it('reads Gemini usageMetadata from a chunk with no parts, thoughts billed as output', async function () {
      const sseBody = sseOf([
        { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] },
        {
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 50,
            cachedContentTokenCount: 20,
            candidatesTokenCount: 6,
            thoughtsTokenCount: 4,
          },
        },
      ])
      const client = createProviderClient({
        type: 'google',
        apiKey: 'gemini-key',
        model: 'gemini-2.0-flash',
        fetchFn: sinon.stub().resolves(fakeStream(sseBody)),
      })

      const chunks = await collect(client)

      expect(usageOf(chunks)).to.deep.equal([
        {
          type: 'usage',
          usage: {
            inputTokens: 30,
            outputTokens: 10,
            cacheReadTokens: 20,
            cacheCreationTokens: 0,
          },
        },
      ])
    })

    it('reads Ollama prompt_eval_count and eval_count from the done chunk', async function () {
      const ndjsonBody = [
        JSON.stringify({ message: { role: 'assistant', content: 'Hi' } }) +
          '\n',
        JSON.stringify({
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 33,
          eval_count: 8,
        }) + '\n',
      ].join('')
      const client = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://203.0.113.20:11434',
        model: 'gemma4:cloud',
        fetchFn: sinon.stub().resolves(fakeStream(ndjsonBody)),
      })

      const chunks = await collect(client)

      // prompt_eval_count leaves out the cached prefix: a floor, not the size
      expect(usageOf(chunks)).to.deep.equal([
        {
          type: 'usage',
          usage: {
            inputTokens: 33,
            outputTokens: 8,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            partialInput: true,
          },
        },
      ])
    })
  })

  describe('exact token counts', function () {
    const tool = {
      name: 'read_file',
      description: 'Reads a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }
    const reply = body =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    it('counts an Anthropic request on the count API, in the wire shape of the tools', async function () {
      const fetchFn = sinon.stub().resolves(reply({ input_tokens: 42 }))
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://api.anthropic.com',
        fetchFn,
      })

      const count = await client.countTokens({
        system: 'Be brief.',
        tools: [tool],
      })

      expect(count).to.equal(42)
      const [url, init] = fetchFn.firstCall.args
      expect(url).to.equal('https://api.anthropic.com/v1/messages/count_tokens')
      expect(init.headers['x-api-key']).to.equal('k')
      const body = JSON.parse(init.body)
      expect(body.model).to.equal('claude-sonnet-4-6')
      expect(body.system).to.equal('Be brief.')
      expect(body.messages).to.deep.equal([{ role: 'user', content: 'x' }])
      expect(body.tools).to.deep.equal([
        {
          name: 'read_file',
          description: 'Reads a file.',
          input_schema: body.tools[0].input_schema,
        },
      ])
    })

    it('sends a bearer token to Anthropic-compatible hosts such as Ollama cloud, but not to api.anthropic.com', async function () {
      const headersFor = async baseUrl => {
        const fetchFn = sinon.stub().resolves(reply({ input_tokens: 1 }))
        const client = createProviderClient({
          type: 'anthropic',
          apiKey: 'k',
          model: 'glm-4.6',
          baseUrl,
          fetchFn,
        })
        await client.countTokens({})
        return fetchFn.firstCall.args[1].headers
      }

      const official = await headersFor('https://api.anthropic.com')
      expect(official['x-api-key']).to.equal('k')
      expect(official.authorization).to.equal(undefined)

      const ollama = await headersFor('https://ollama.com')
      expect(ollama['x-api-key']).to.equal('k')
      expect(ollama.authorization).to.equal('Bearer k')
    })

    it('keeps the estimate on Ollama endpoints, which have no count API', function () {
      const supported = baseUrl =>
        createProviderClient({
          type: 'anthropic',
          apiKey: 'k',
          model: 'glm-4.6',
          baseUrl,
        }).exactCountsSupported

      expect(supported('https://api.anthropic.com')).to.equal(true)
      expect(supported('https://gateway.example.com')).to.equal(true)
      expect(supported('https://ollama.com')).to.equal(false)
      expect(supported('http://ollama:11434')).to.equal(false)
    })

    it('counts on a gateway base URL on the plain count endpoint, not the beta one', async function () {
      const fetchFn = sinon.stub().resolves(reply({ input_tokens: 7 }))
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://gateway.example.com',
        fetchFn,
      })

      expect(await client.countTokens({ system: 'S', tools: [] })).to.equal(7)
      const [url, init] = fetchFn.firstCall.args
      expect(url).to.match(/\/v1\/messages\/count_tokens$/)
      expect(url).to.not.include('beta')
      expect(init.headers).to.not.have.property('anthropic-beta')
    })

    it('keeps the provider message of a refused count, for the caller to classify', async function () {
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://gateway.example.com',
        fetchFn: sinon.stub().resolves(
          new Response(
            JSON.stringify({ error: { message: 'count_tokens route not found' } }),
            { status: 400 }
          )
        ),
      })

      let error = null
      await client.countTokens({}).catch(err => (error = err))
      expect(error.status).to.equal(400)
      expect(error.message).to.include('count_tokens route not found')
    })

    it('counts a Google request on countTokens with the generateContentRequest wrapper', async function () {
      const fetchFn = sinon.stub().resolves(reply({ totalTokens: 17 }))
      const client = createProviderClient({
        type: 'google',
        apiKey: 'g',
        model: 'models/gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        fetchFn,
      })

      const count = await client.countTokens({ system: 'Be brief.', tools: [tool] })

      expect(count).to.equal(17)
      const [url, init] = fetchFn.firstCall.args
      expect(url).to.equal(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens'
      )
      const { generateContentRequest } = JSON.parse(init.body)
      expect(generateContentRequest.model).to.equal('models/gemini-2.5-flash')
      expect(generateContentRequest.systemInstruction).to.deep.equal({
        parts: [{ text: 'Be brief.' }],
      })
      expect(generateContentRequest.tools[0].functionDeclarations[0].name).to.equal(
        'read_file'
      )
    })

    it('throws when the count API refuses the request or sends no count', async function () {
      const refused = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://api.anthropic.com',
        fetchFn: sinon.stub().resolves(new Response('{}', { status: 400 })),
      })
      const silent = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://api.anthropic.com',
        fetchFn: sinon.stub().resolves(reply({})),
      })

      let refusedError = null
      await refused.countTokens({}).catch(err => (refusedError = err))
      expect(refusedError).to.be.instanceOf(ProviderError)
      expect(refusedError.status).to.equal(400)
      let silentError = null
      await silent.countTokens({}).catch(err => (silentError = err))
      expect(silentError?.message).to.equal('Anthropic count API gave no count')
    })

    it('offers exact counts on any base URL of the provider type', function () {
      const official = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://api.anthropic.com',
        fetchFn: sinon.stub(),
      })
      const gateway = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        baseUrl: 'https://gateway.example.com',
        fetchFn: sinon.stub(),
      })
      const google = createProviderClient({
        type: 'google',
        apiKey: 'g',
        model: 'gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        fetchFn: sinon.stub(),
      })
      const openai = createProviderClient({
        type: 'openai',
        apiKey: 'k',
        model: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        fetchFn: sinon.stub(),
      })

      expect(official.exactCountsSupported).to.equal(true)
      expect(gateway.exactCountsSupported).to.equal(true)
      expect(google.exactCountsSupported).to.equal(true)
      expect(openai.countTokens).to.equal(undefined)
    })
  })

  describe('toolWireSpec', function () {
    const tool = {
      name: 'read_file',
      description: 'Reads a file.',
      parameters: { type: 'object', properties: {} },
    }

    it('takes the provider wire shape of each tool', function () {
      expect(toolWireSpec('anthropic', tool)).to.deep.include({
        name: 'read_file',
        description: 'Reads a file.',
      })
      expect(toolWireSpec('anthropic', tool)).to.have.property('input_schema')
      expect(toolWireSpec('openai', tool)).to.deep.equal({
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Reads a file.',
          parameters: toolWireSpec('openai', tool).function.parameters,
        },
      })
      expect(toolWireSpec('ollama', tool)).to.deep.equal(toolWireSpec('openai', tool))
    })

    it('omits the parameters of a no-argument tool for Google', function () {
      const wire = toolWireSpec('google', tool)

      expect(wire).to.deep.equal({ name: 'read_file', description: 'Reads a file.' })
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

      const { fetchWithRetry } =
        await import('../../../app/src/AiAssistProviders.mjs')
      const res = await fetchWithRetry(
        'https://api.example.com',
        {},
        {
          maxRetries: 2,
          initialDelayMs: 10,
          fetchFn: fetchStub,
        }
      )

      expect(res.status).to.equal(200)
      expect(fetchStub.calledTwice).to.be.true
    })

    it('consumes response body before retry to release socket', async function () {
      const textStub = sinon.stub().resolves('')
      const failResponse = {
        ok: false,
        status: 429,
        headers: new Map(),
        text: textStub,
      }
      failResponse.headers.get = () => null

      const successResponse = {
        ok: true,
        status: 200,
      }

      const fetchStub = sinon.stub()
      fetchStub.onFirstCall().resolves(failResponse)
      fetchStub.onSecondCall().resolves(successResponse)

      const { fetchWithRetry } =
        await import('../../../app/src/AiAssistProviders.mjs')
      const res = await fetchWithRetry(
        'https://api.example.com',
        {},
        {
          maxRetries: 2,
          initialDelayMs: 10,
          fetchFn: fetchStub,
        }
      )

      expect(res.status).to.equal(200)
      expect(textStub.calledOnce).to.be.true
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

      const promise = fetchWithRetry(
        'https://api.example.com',
        { signal: controller.signal },
        {
          maxRetries: 2,
          initialDelayMs: 200,
          fetchFn: fetchStub,
        }
      )

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
      const removeListenerSpy = sinon.spy(
        controller.signal,
        'removeEventListener'
      )

      await fetchWithRetry(
        'https://api.example.com',
        { signal: controller.signal },
        {
          maxRetries: 2,
          initialDelayMs: 10,
          fetchFn: fetchStub,
        }
      )

      expect(removeListenerSpy.calledWith('abort')).to.be.true
    })
  })

  describe('retry fields on provider errors', function () {
    it('carries Retry-After and x-should-retry from an error reply', async function () {
      const reply = new Response(
        JSON.stringify({ error: { type: 'rate_limit_error', message: 'Slow down' } }),
        {
          status: 429,
          headers: { 'retry-after': '3', 'x-should-retry': 'true' },
        }
      )
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'key',
        fetchFn: sinon.stub().resolves(reply),
      })

      const err = await (async () => {
        for await (const _ of client.streamChat({ system: 'x', messages: [] })) {
          void _
        }
      })().catch(e => e)

      expect(err).to.be.instanceOf(ProviderError)
      expect(err.status).to.equal(429)
      expect(err.retryAfterMs).to.equal(3000)
      expect(err.shouldRetry).to.be.true
    })

    it('maps a mid-stream overloaded_error to status 529', async function () {
      const sse =
        'event: error\n' +
        'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'key',
        fetchFn: sinon.stub().resolves(
          new Response(sse, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        ),
      })

      const err = await (async () => {
        for await (const _ of client.streamChat({ system: 'x', messages: [] })) {
          void _
        }
      })().catch(e => e)

      expect(err.status).to.equal(529)
      expect(err.message).to.equal('Overloaded')
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
        for await (const _ of client.streamChat({
          system: 'x',
          messages: [],
        })) {
        }
      } catch (err) {
        error = err
      }

      expect(error).to.exist
      expect(error.code).to.equal('providerTimeout')
      expect(error.message).to.equal('Connection timed out')
    })

    it('aborts when stream stalls and idle watchdog timeout elapses', async function () {
      const fetchStub = sinon.stub().callsFake((_url, opts) => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"start"}}]}\n\n'
              )
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
        for await (const chunk of client.streamChat({
          system: 'x',
          messages: [],
        })) {
          chunks.push(chunk)
        }
      } catch (err) {
        error = err
      }

      expect(chunks).to.have.lengthOf(1)
      expect(error).to.exist
      expect(error.code).to.equal('providerStalled')
      expect(error.message).to.include('stalled')
    })

    it('allows a stream that emits chunks within idle watchdog interval', async function () {
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"chunk1"}}]}\n\n'
          )
          await new Promise(r => setTimeout(r, 10))
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"chunk2"}}]}\n\n'
          )
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
      for await (const chunk of client.streamChat({
        system: 'x',
        messages: [],
      })) {
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
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"reasoning_content":"thinking about edit"}}]}\n\n'
          )
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"edit_file","arguments":"{\\"path\\":\\"main.tex\\"}"}}]}}]}\n\n'
          )
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
          )
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
      for await (const chunk of client.streamChat({
        system: 'x',
        messages: [],
      })) {
        chunks.push(chunk)
      }

      expect(chunks).to.have.lengthOf(2)
      expect(chunks[0].type).to.equal('thinking')
      expect(chunks[0].text).to.equal('thinking about edit')
      expect(chunks[1].type).to.equal('tool_call')
      expect(chunks[1].name).to.equal('edit_file')
      expect(chunks[1].args).to.deep.equal({ path: 'main.tex' })
    })

    it('keeps parallel tool calls apart when they share an index but not an id (Ollama /v1)', async function () {
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\\"query\\":\\"To Lam\\"}"}},{"index":0,"id":"call_2","function":{"name":"web_fetch","arguments":"{\\"url\\":\\"https://a.example\\"}"}}]}}]}\n\n'
          )
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_3","function":{"name":"web_fetch","arguments":"{\\"url\\":"}}]}}]}\n\n'
          )
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"https://b.example\\"}"}}]}}]}\n\n'
          )
          yield new TextEncoder().encode(
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
          )
        })(),
      }

      const client = createProviderClient({
        type: 'openai',
        apiKey: 'key',
        baseUrl: 'https://ollama.com/v1',
        fetchFn: sinon.stub().resolves(fakeResponse),
        streamIdleTimeoutMs: 500,
      })

      const calls = []
      for await (const chunk of client.streamChat({ system: 'x', messages: [] })) {
        if (chunk.type === 'tool_call') calls.push(chunk)
      }

      expect(calls.map(({ id, name, args }) => ({ id, name, args }))).to.deep.equal([
        { id: 'call_1', name: 'web_search', args: { query: 'To Lam' } },
        { id: 'call_2', name: 'web_fetch', args: { url: 'https://a.example' } },
        { id: 'call_3', name: 'web_fetch', args: { url: 'https://b.example' } },
      ])
    })

    it('exits Anthropic stream immediately on message_stop', async function () {
      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n'
          )
          yield new TextEncoder().encode(
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n'
          )
          yield new TextEncoder().encode(
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"main.tex\\"}"}}\n\n'
          )
          yield new TextEncoder().encode(
            'data: {"type":"content_block_stop","index":0}\n\n'
          )
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
      for await (const chunk of client.streamChat({
        system: 'x',
        messages: [],
      })) {
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
          yield new TextEncoder().encode(
            '{"message":{"thinking":"analyzing"}}\n'
          )
          yield new TextEncoder().encode(
            '{"message":{"tool_calls":[{"function":{"name":"read_file","arguments":{"path":"main.tex"}}}]},"done":true}\n'
          )
        })(),
      }

      const client = createProviderClient({
        type: 'ollama',
        apiKey: '',
        baseUrl: 'http://203.0.113.20:11434',
        fetchFn: sinon.stub().resolves(fakeResponse),
        streamIdleTimeoutMs: 500,
      })

      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'x',
        messages: [],
      })) {
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
      expect(
        safeParseToolArgs('{"path":"main.tex","oldText":"a"}')
      ).to.deep.equal({
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
      expect(safeParseToolArgs('{"path":"main.tex"}')).to.not.have.property(
        '_repaired'
      )
    })

    it('returns _parseError flag for unrecoverable malformed JSON', function () {
      const bad = safeParseToolArgs(
        '{something invalid without quotes or values'
      )
      expect(bad._parseError).to.be.true
    })
  })

  describe('output limit signal', function () {
    const sse = events =>
      events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const streamOf = text => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(text)
      })(),
    })
    const collect = async client => {
      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
      })) {
        chunks.push(chunk)
      }
      return chunks
    }

    it('Anthropic: yields stop after a tool call cut off at max_tokens', async function () {
      const body = sse([
        { type: 'message_start', message: { id: 'm1' } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"path":"main.tex","newText":"abc',
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        { type: 'message_stop' },
      ])
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-opus-5',
        fetchFn: sinon.stub().resolves(streamOf(body)),
      })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({
        type: 'stop',
        reason: 'max_tokens',
      })
      const call = chunks.find(chunk => chunk.type === 'tool_call')
      expect(call.args).to.deep.equal({
        path: 'main.tex',
        newText: 'abc',
        _repaired: true,
      })
    })

    it('Anthropic: yields no stop chunk for a normal end_turn', async function () {
      const body = sse([
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'done' },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-opus-5',
        fetchFn: sinon.stub().resolves(streamOf(body)),
      })

      const chunks = await collect(client)

      expect(chunks.some(chunk => chunk.type === 'stop')).to.equal(false)
    })

    it('OpenAI: yields stop when finish_reason is length', async function () {
      const body = sse([
        { choices: [{ delta: { content: 'partial' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ])
      const client = createProviderClient({
        type: 'openai',
        apiKey: 'k',
        model: 'gpt-4o',
        fetchFn: sinon.stub().resolves(streamOf(body)),
      })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({
        type: 'stop',
        reason: 'max_tokens',
      })
    })

    it('Gemini: yields stop when finishReason is MAX_TOKENS', async function () {
      const body = sse([
        {
          candidates: [
            {
              content: { parts: [{ text: 'partial' }] },
              finishReason: 'MAX_TOKENS',
            },
          ],
        },
      ])
      const client = createProviderClient({
        type: 'google',
        apiKey: 'k',
        model: 'gemini-2.0-flash',
        fetchFn: sinon.stub().resolves(streamOf(body)),
      })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({
        type: 'stop',
        reason: 'max_tokens',
      })
    })

    it('Ollama: yields stop when done_reason is length', async function () {
      const body =
        [
          JSON.stringify({ message: { content: 'partial' } }),
          JSON.stringify({
            message: { content: '' },
            done: true,
            done_reason: 'length',
          }),
        ].join('\n') + '\n'
      const client = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://203.0.113.20:11434',
        model: 'qwen3:8b',
        fetchFn: sinon.stub().resolves(streamOf(body)),
      })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({
        type: 'stop',
        reason: 'max_tokens',
      })
    })
  })

  describe('OpenAI request parameters', function () {
    const okStream = () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
        )
      })(),
    })
    const send = async settings => {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({
        type: 'openai',
        apiKey: 'k',
        model: 'gpt-5',
        fetchFn,
        ...settings,
      })
      for await (const _ of client.streamChat({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1000,
        cacheHints: {
          cacheSystem: true,
          cacheTools: true,
          lastStableMessage: null,
          cacheKey: 'project-1',
        },
      })) {
      }
      return body
    }

    it('recognises only api.openai.com as the official API', function () {
      expect(isOfficialOpenAiUrl('https://api.openai.com')).to.equal(true)
      expect(isOfficialOpenAiUrl('https://api.openai.com/v1')).to.equal(true)
      expect(isOfficialOpenAiUrl('https://openrouter.ai/api/v1')).to.equal(
        false
      )
      expect(isOfficialOpenAiUrl('not a url')).to.equal(false)
    })

    it('hashes the cache key to 32 hex characters', function () {
      expect(promptCacheKey('project-1')).to.match(/^[0-9a-f]{32}$/)
      expect(promptCacheKey('project-1')).to.equal(promptCacheKey('project-1'))
      expect(promptCacheKey('project-1')).to.not.equal(
        promptCacheKey('project-2')
      )
    })

    it('sends max_completion_tokens and prompt_cache_key to api.openai.com', async function () {
      const body = await send({})
      expect(body.max_completion_tokens).to.equal(1000)
      expect(body).to.not.have.property('max_tokens')
      expect(body.prompt_cache_key).to.equal(promptCacheKey('project-1'))
      expect(body.stream_options).to.deep.equal({ include_usage: true })
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
        yield new TextEncoder().encode(
          JSON.stringify({
            message: { content: 'hi' },
            done: true,
            done_reason: 'stop',
          }) + '\n'
        )
      })(),
    })

    it('sends the context window as num_ctx', async function () {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://203.0.113.20:11434',
        model: 'qwen3:8b',
        fetchFn,
      })

      for await (const _ of client.streamChat({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 512,
        contextWindow: 32768,
      })) {
      }

      expect(body.options).to.deep.equal({ num_predict: 512, num_ctx: 32768 })
    })

    it('omits num_ctx when no context window is given', async function () {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://203.0.113.20:11434',
        model: 'qwen3:8b',
        fetchFn,
      })

      for await (const _ of client.streamChat({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 512,
      })) {
      }

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
            json: async () => ({
              error: '"no-think-test:1b" does not support thinking',
            }),
          })
        }
        return Promise.resolve(okStream())
      })
      const settings = {
        type: 'ollama',
        baseUrl: 'http://203.0.113.20:11434',
        model: 'no-think-test:1b',
        fetchFn,
      }

      const chunks = []
      for await (const chunk of createProviderClient(settings).streamChat({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk)
      }
      expect(chunks).to.deep.include({ type: 'text', text: 'hi' })
      expect(bodies).to.have.length(2)
      expect(bodies[0].think).to.equal(true)
      expect(bodies[1]).to.not.have.property('think')

      // A new client for the same model skips the failing attempt.
      for await (const _ of createProviderClient(settings).streamChat({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
      }
      expect(bodies).to.have.length(3)
      expect(bodies[2]).to.not.have.property('think')
    })

    it('still surfaces other 400 errors', async function () {
      const fetchFn = sinon.stub().resolves({
        ok: false,
        status: 400,
        json: async () => ({ error: 'model "missing:7b" not found' }),
      })
      const client = createProviderClient({
        type: 'ollama',
        baseUrl: 'http://203.0.113.20:11434',
        model: 'missing:7b',
        fetchFn,
      })

      let error = null
      try {
        for await (const _ of client.streamChat({
          system: 'x',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
        }
      } catch (err) {
        error = err
      }
      expect(error).to.be.an.instanceOf(ProviderError)
      expect(error.message).to.include('not found')
      expect(fetchFn.callCount).to.equal(1)
    })
  })

  describe('anthropicSystemField', function () {
    const ephemeral = { type: 'ephemeral' }

    it('is one cached block without a prefix hint', function () {
      expect(anthropicSystemField('S', { cacheSystem: true })).to.deep.equal([
        { type: 'text', text: 'S', cache_control: ephemeral },
      ])
    })

    it('caches the shared prefix and leaves the project block after it', function () {
      expect(
        anthropicSystemField('SHARED\n\nAGENTS', {
          cacheSystem: true,
          systemPrefix: 'SHARED',
        })
      ).to.deep.equal([
        { type: 'text', text: 'SHARED', cache_control: ephemeral },
        { type: 'text', text: 'AGENTS' },
      ])
    })

    it('ignores a hint that is not a prefix', function () {
      expect(
        anthropicSystemField('OTHER', { cacheSystem: true, systemPrefix: 'X' })
      ).to.deep.equal([{ type: 'text', text: 'OTHER', cache_control: ephemeral }])
    })

    it('sends a plain string when caching is off', function () {
      expect(anthropicSystemField('S', null)).to.equal('S')
    })

    it('keeps within four cache breakpoints with a split system prompt', async function () {
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
      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'key',
        model: 'claude-x',
        fetchFn: fakeFetch,
      })
      for await (const _ of client.streamChat({
        system: 'SHARED\n\nAGENTS',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Reply 1' },
          { role: 'user', content: 'Turn 2' },
        ],
        tools: [{ name: 'tool_a', description: 'a', parameters: {} }],
        cacheHints: {
          cacheSystem: true,
          cacheTools: true,
          systemPrefix: 'SHARED',
          lastStableMessage: 1,
        },
      })) {
      }
      const marks = JSON.stringify(sentPayload).match(/"cache_control"/g)
      expect(marks).to.have.length(4)
      expect(sentPayload.system[1]).to.deep.equal({
        type: 'text',
        text: 'AGENTS',
      })
    })
  })

  describe('images on user messages', function () {
    const IMAGE = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }
    const withImage = [{ role: 'user', content: 'what is this', images: [IMAGE] }]

    async function sentBody(type, sse) {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve({
          ok: true,
          status: 200,
          body: (async function* () {
            yield new TextEncoder().encode(sse)
          })(),
        })
      })
      const client = createProviderClient({ type, apiKey: 'k', model: 'm', fetchFn })
      for await (const _ of client.streamChat({
        system: 'sys',
        messages: withImage,
        maxTokens: 100,
      })) {
      }
      return body
    }

    it('Ollama: sends the images beside the text', function () {
      expect(toOllamaMessages('sys', withImage)).to.deep.equal([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'what is this', images: ['iVBORw0KGgo='] },
      ])
      expect(toOllamaMessages('', [{ role: 'user', content: 'hi' }])).to.deep.equal([
        { role: 'user', content: 'hi' },
      ])
    })

    it('Gemini: puts inline data before the text', function () {
      expect(toGeminiContents(withImage)).to.deep.equal([
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
            { text: 'what is this' },
          ],
        },
      ])
    })

    it('Anthropic: sends an image block before the text', async function () {
      const body = await sentBody(
        'anthropic',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      )
      expect(body.messages[0]).to.deep.equal({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          { type: 'text', text: 'what is this' },
        ],
      })
    })

    it('OpenAI: sends a data URL image part before the text', async function () {
      const body = await sentBody(
        'openai',
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
      )
      const user = body.messages.find(message => message.role === 'user')
      expect(user).to.deep.equal({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' },
          },
          { type: 'text', text: 'what is this' },
        ],
      })
    })
  })

  describe('images on tool results', function () {
    const PAGE = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }
    // Two parallel calls; the first returned a page image
    const messages = [
      { role: 'user', content: 'check page 2' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't1', name: 'view_compiled_pdf_page', args: { page: 2 } },
          { id: 't2', name: 'read_file', args: { path: 'main.tex' } },
        ],
      },
      {
        role: 'tool',
        toolCallId: 't1',
        name: 'view_compiled_pdf_page',
        content: 'PDF page 2 of 5.',
        images: [PAGE],
      },
      {
        role: 'tool',
        toolCallId: 't2',
        name: 'read_file',
        content: 'main.tex lines 1-2 of 2',
      },
      { role: 'user', content: 'and?' },
    ]

    async function sentBody(type, sse) {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve({
          ok: true,
          status: 200,
          body: (async function* () {
            yield new TextEncoder().encode(sse)
          })(),
        })
      })
      const client = createProviderClient({ type, apiKey: 'k', model: 'm', fetchFn })
      for await (const _ of client.streamChat({
        system: 'sys',
        messages,
        maxTokens: 100,
      })) {
      }
      return body
    }

    it('Anthropic: puts the image inside its tool result', async function () {
      const body = await sentBody(
        'anthropic',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      )
      expect(body.messages[2].content[0]).to.deep.equal({
        type: 'tool_result',
        tool_use_id: 't1',
        content: [
          { type: 'text', text: 'PDF page 2 of 5.' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
          },
        ],
        is_error: false,
      })
      // A result without an image stays a plain string
      expect(body.messages[2].content[1].content).to.equal('main.tex lines 1-2 of 2')
    })

    it('OpenAI: follows the step\'s tool results with a user turn holding the image', async function () {
      const body = await sentBody(
        'openai',
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
      )
      expect(body.messages.map(message => message.role)).to.deep.equal([
        'system',
        'user',
        'assistant',
        'tool',
        'tool',
        'user',
        'user',
      ])
      expect(body.messages[3].content).to.equal('PDF page 2 of 5.')
      expect(body.messages[5].content).to.deep.equal([
        { type: 'text', text: '[The image returned by view_compiled_pdf_page above.]' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' },
        },
      ])
    })

    it('Ollama: follows the step\'s tool results with a user turn holding the image', function () {
      const wire = toOllamaMessages('sys', messages)
      expect(wire.map(message => message.role)).to.deep.equal([
        'system',
        'user',
        'assistant',
        'tool',
        'tool',
        'user',
        'user',
      ])
      expect(wire[5]).to.deep.equal({
        role: 'user',
        content: '[The image returned by view_compiled_pdf_page above.]',
        images: ['iVBORw0KGgo='],
      })
    })

    it('Gemini: puts the image after the step\'s function responses', function () {
      const contents = toGeminiContents(messages)
      // The user's next message shares the turn, after the image
      expect(contents[2].parts.map(part => Object.keys(part)[0])).to.deep.equal([
        'functionResponse',
        'functionResponse',
        'inlineData',
        'text',
      ])
      expect(contents[2].parts[2]).to.deep.equal({
        inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      })
    })

    it('sends nothing extra for tool results without images', function () {
      const plain = messages.map(({ images, ...rest }) => rest)
      expect(toOllamaMessages('', plain).map(m => m.role)).to.deep.equal([
        'user',
        'assistant',
        'tool',
        'tool',
        'user',
      ])
      expect(toolImageTurns(plain).size).to.equal(0)
    })
  })
})
