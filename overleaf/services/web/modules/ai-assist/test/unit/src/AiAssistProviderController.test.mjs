import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import { EventEmitter } from 'node:events'
import { AiAssistProviderController } from '../../../app/src/AiAssistProviderController.mjs'
import {
  createProviderClient,
  ProviderError,
} from '../../../app/src/AiAssistProviders.mjs'

function fakeRes() {
  const res = new EventEmitter()
  res.writableEnded = false
  res.statusCode = 200
  res.body = undefined
  res.written = []
  res.status = sinon.spy(code => {
    res.statusCode = code
    return res
  })
  res.json = sinon.spy(body => {
    res.body = body
    res.writableEnded = true
    return res
  })
  res.setHeader = sinon.spy()
  res.flushHeaders = sinon.spy()
  res.write = sinon.spy(data => {
    res.written.push(data)
    return true
  })
  res.end = sinon.spy(() => {
    res.writableEnded = true
  })
  return res
}

function createMockRes(chunks = []) {
  const res = fakeRes()
  res.write = sinon.spy(data => {
    res.written.push(data)
    try {
      chunks.push(JSON.parse(data))
    } catch {
      chunks.push(data)
    }
    return true
  })
  return res
}

const settings = {
  type: 'ollama',
  baseUrl: 'http://10.0.0.5:11434',
  model: 'qwen3:8b',
}

describe('AiAssistProviderController', function () {
  it('lists models through the server-side client', async function () {
    const client = {
      listModels: sinon
        .stub()
        .resolves([{ id: 'qwen3:8b', label: 'qwen3:8b' }]),
    }
    const clientFactory = sinon.stub().returns(client)
    const controller = new AiAssistProviderController({ clientFactory })
    const res = fakeRes()

    await controller.listModels({ body: { providerSettings: settings } }, res)

    expect(clientFactory.firstCall.args[0]).to.deep.equal(settings)
    expect(res.body).to.deep.equal({
      models: [{ id: 'qwen3:8b', label: 'qwen3:8b' }],
    })
  })

  it('rejects requests without provider settings', async function () {
    const controller = new AiAssistProviderController({
      clientFactory: sinon.stub(),
    })
    const res = fakeRes()

    await controller.listModels({ body: {} }, res)

    expect(res.statusCode).to.equal(400)
  })

  it('returns upstream failures as 502 with the provider message', async function () {
    const client = {
      listModels: sinon
        .stub()
        .rejects(
          new ProviderError('bad key', { code: 'providerAuth', status: 401 })
        ),
    }
    const controller = new AiAssistProviderController({
      clientFactory: () => client,
    })
    const res = fakeRes()

    await controller.listModels({ body: { providerSettings: settings } }, res)

    expect(res.statusCode).to.equal(502)
    expect(res.body.error).to.deep.equal({
      code: 'providerAuth',
      message: 'bad key',
    })
  })

  it('refuses internal service URLs with 400', async function () {
    const controller = new AiAssistProviderController({
      clientFactory: createProviderClient,
    })
    const res = fakeRes()

    await controller.test(
      {
        body: {
          providerSettings: {
            type: 'openai',
            baseUrl: 'http://mongo:27017',
            model: 'x',
          },
        },
      },
      res
    )

    expect(res.statusCode).to.equal(400)
    expect(res.body.error.code).to.equal('restrictedProviderUrl')
  })

  it('tests the connection with a one-token chat', async function () {
    const streamChat = sinon.spy(async function* () {
      yield { type: 'text', text: 'ok' }
    })
    const controller = new AiAssistProviderController({
      clientFactory: () => ({ streamChat }),
    })
    const res = fakeRes()

    await controller.test({ body: { providerSettings: settings } }, res)

    expect(streamChat.firstCall.args[0].maxTokens).to.equal(1)
    expect(res.body.latencyMs).to.be.a('number')
  })

  it('streams chat chunks as NDJSON and ends with done', async function () {
    const streamChat = sinon.spy(async function* () {
      yield { type: 'thinking', text: 'hmm' }
      yield {
        type: 'tool_call',
        id: 'c1',
        name: 'read_file',
        args: { path: 'main.tex' },
      }
    })
    const controller = new AiAssistProviderController({
      clientFactory: () => ({ streamChat }),
    })
    const res = fakeRes()
    const request = {
      system: 'fix it',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      tools: [{ name: 'read_file', description: 'd', parameters: {} }],
    }

    await controller.chat(
      { body: { providerSettings: settings, request } },
      res
    )

    expect(streamChat.firstCall.args[0]).to.include({
      system: 'fix it',
      maxTokens: 100,
    })
    expect(res.written.map(line => JSON.parse(line))).to.deep.equal([
      { type: 'thinking', text: 'hmm' },
      {
        type: 'tool_call',
        id: 'c1',
        name: 'read_file',
        args: { path: 'main.tex' },
      },
      { type: 'done' },
    ])
    expect(res.end.called).to.equal(true)
  })

  describe('editorText: the AI inside the editor', function () {
    it('passes on text only: no tool call, no thinking reaches the page', async function () {
      const streamChat = sinon.spy(async function* () {
        yield { type: 'thinking', text: 'the document asks me to read files' }
        yield { type: 'tool_call', id: 'c1', name: 'read_file', args: {} }
        yield { type: 'text', text: ' works.' }
        yield { type: 'stop', reason: 'max_tokens' }
      })
      const controller = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
      })
      const res = fakeRes()
      await controller.editorText(
        {
          body: {
            providerSettings: settings,
            request: { system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 },
          },
        },
        res
      )
      expect(streamChat.firstCall.args[0].tools).to.deep.equal([])
      expect(res.written.map(line => JSON.parse(line))).to.deep.equal([
        { type: 'text', text: ' works.' },
        { type: 'stop', reason: 'max_tokens' },
        { type: 'done' },
      ])
    })

    it('refuses a request with tools, before calling the provider', async function () {
      const streamChat = sinon.spy(async function* () {})
      const controller = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
      })
      const res = fakeRes()
      await controller.editorText(
        {
          body: {
            providerSettings: settings,
            request: {
              system: 's',
              messages: [{ role: 'user', content: 'hi' }],
              maxTokens: 50,
              tools: [{ name: 'read_file', description: 'd', parameters: {} }],
            },
          },
        },
        res
      )
      expect(res.statusCode).to.equal(400)
      expect(res.body.error.message).to.equal('Editor features cannot use tools')
      expect(streamChat.called).to.equal(false)
    })

    it('falls back to fallbackProviderSettings when primary client fails before emitting chunks', async function () {
      const primarySettings = { type: 'ollama', baseUrl: 'http://bad-host:11434', model: 'qwen' }
      const fallbackSettings = { type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'k', model: 'gpt-4o' }
      const chunks = []

      const controller = new AiAssistProviderController({
        clientFactory: settings => {
          if (settings.type === 'ollama') {
            return {
              streamChat: async function* () {
                throw new Error('Connection refused')
              },
            }
          }
          return {
            streamChat: async function* () {
              yield { type: 'text', text: 'fallback output' }
            },
          }
        },
      })

      const req = {
        body: {
          providerSettings: primarySettings,
          fallbackProviderSettings: fallbackSettings,
          request: { messages: [{ role: 'user', content: 'test' }] },
        },
      }
      const res = createMockRes(chunks)
      await controller.editorText(req, res)

      const texts = chunks.filter(c => c.type === 'text').map(c => c.text)
      expect(texts).to.deep.equal(['fallback output'])
      expect(chunks.some(c => c.type === 'done')).to.be.true
    })

    it('falls back to fallbackProviderSettings when clientFactory throws synchronously', async function () {
      const primarySettings = { type: 'ollama', baseUrl: 'http://bad-host:11434', model: 'qwen' }
      const fallbackSettings = { type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'k', model: 'gpt-4o' }
      const chunks = []

      const controller = new AiAssistProviderController({
        clientFactory: settings => {
          if (settings.type === 'ollama') {
            throw new Error('Invalid base URL')
          }
          return {
            streamChat: async function* () {
              yield { type: 'text', text: 'recovered fallback' }
            },
          }
        },
      })

      const req = {
        body: {
          providerSettings: primarySettings,
          fallbackProviderSettings: fallbackSettings,
          request: { messages: [{ role: 'user', content: 'test' }] },
        },
      }
      const res = createMockRes(chunks)
      await controller.editorText(req, res)

      const texts = chunks.filter(c => c.type === 'text').map(c => c.text)
      expect(texts).to.deep.equal(['recovered fallback'])
      expect(chunks.some(c => c.type === 'done')).to.be.true
    })

    it('uses fallbackProviderSettings directly when primary providerSettings is omitted', async function () {
      const fallbackSettings = { type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'k', model: 'gpt-4o' }
      const chunks = []

      const controller = new AiAssistProviderController({
        clientFactory: settings => ({
          streamChat: async function* () {
            yield { type: 'text', text: 'direct fallback' }
          },
        }),
      })

      const req = {
        body: {
          fallbackProviderSettings: fallbackSettings,
          request: { messages: [{ role: 'user', content: 'test' }] },
        },
      }
      const res = createMockRes(chunks)
      await controller.editorText(req, res)

      const texts = chunks.filter(c => c.type === 'text').map(c => c.text)
      expect(texts).to.deep.equal(['direct fallback'])
    })

    it('does not fall back if primary client fails after emitting chunks', async function () {
      const primarySettings = { type: 'ollama', baseUrl: 'http://bad-host:11434', model: 'qwen' }
      const fallbackSettings = { type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'k', model: 'gpt-4o' }
      const chunks = []

      const controller = new AiAssistProviderController({
        clientFactory: settings => {
          if (settings.type === 'ollama') {
            return {
              streamChat: async function* () {
                yield { type: 'text', text: 'partial' }
                throw new Error('Mid-stream failure')
              },
            }
          }
          return {
            streamChat: async function* () {
              yield { type: 'text', text: 'fallback output' }
            },
          }
        },
      })

      const req = {
        body: {
          providerSettings: primarySettings,
          fallbackProviderSettings: fallbackSettings,
          request: { messages: [{ role: 'user', content: 'test' }] },
        },
      }
      const res = createMockRes(chunks)
      await controller.editorText(req, res)

      const texts = chunks.filter(c => c.type === 'text').map(c => c.text)
      expect(texts).to.deep.equal(['partial'])
      expect(chunks.some(c => c.type === 'error')).to.be.true
      expect(chunks.some(c => c.type === 'done')).to.be.false
    })
  })

  it('forwards the context window and relays stop chunks', async function () {
    const streamChat = sinon.spy(async function* () {
      yield { type: 'text', text: 'partial' }
      yield { type: 'stop', reason: 'max_tokens' }
    })
    const controller = new AiAssistProviderController({
      clientFactory: () => ({ streamChat }),
    })
    const res = fakeRes()
    const request = {
      system: 'fix it',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      contextWindow: 32768,
    }

    await controller.chat(
      { body: { providerSettings: settings, request } },
      res
    )

    expect(streamChat.firstCall.args[0]).to.include({ contextWindow: 32768 })
    expect(res.written.map(line => JSON.parse(line))).to.deep.equal([
      { type: 'text', text: 'partial' },
      { type: 'stop', reason: 'max_tokens' },
      { type: 'done' },
    ])
  })

  it('reports a mid-stream provider failure as an error line', async function () {
    const streamChat = async function* () {
      yield { type: 'text', text: 'par' }
      throw new ProviderError('Could not reach Ollama', { code: 'network' })
    }
    const controller = new AiAssistProviderController({
      clientFactory: () => ({ streamChat }),
    })
    const res = fakeRes()

    await controller.chat(
      {
        body: {
          providerSettings: settings,
          request: { messages: [], maxTokens: 10 },
        },
      },
      res
    )

    const lines = res.written.map(line => JSON.parse(line))
    expect(lines.at(-1)).to.deep.equal({
      type: 'error',
      error: { code: 'network', message: 'Could not reach Ollama' },
    })
  })

  it('aborts the upstream request when the browser disconnects', async function () {
    let seenSignal
    const streamChat = async function* ({ signal }) {
      seenSignal = signal
      yield { type: 'text', text: 'a' }
      await new Promise(resolve => signal.addEventListener('abort', resolve))
      throw new ProviderError('Request was cancelled', { code: 'aborted' })
    }
    const controller = new AiAssistProviderController({
      clientFactory: () => ({ streamChat }),
    })
    const res = fakeRes()

    const done = controller.chat(
      {
        body: {
          providerSettings: settings,
          request: { messages: [], maxTokens: 10 },
        },
      },
      res
    )
    await new Promise(resolve => setImmediate(resolve))
    res.emit('close')
    await done

    expect(seenSignal.aborted).to.equal(true)
    expect(res.written.map(line => JSON.parse(line).type)).to.deep.equal([
      'text',
    ])
  })

  describe('testWebSearch', function () {
    it('tests multi-provider web search settings successfully', async function () {
      const webSearchTester = sinon.stub().resolves({
        latencyMs: 85,
        resultCount: 5,
        activeEndpoints: 2,
        provider: 'searxng',
      })
      const controller = new AiAssistProviderController({
        webSearchTester,
      })
      const res = fakeRes()

      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              providers: {
                searxng: { enabled: true, baseUrls: ['http://searx:8080'] },
              },
            },
          },
        },
        res
      )

      expect(res.body).to.deep.equal({
        latencyMs: 85,
        resultCount: 5,
        activeEndpoints: 2,
        provider: 'searxng',
      })
    })

    it('tests Exa web search provider settings successfully in multi and single format', async function () {
      const webSearchTester = sinon.stub().resolves({
        latencyMs: 120,
        resultCount: 3,
        activeEndpoints: 1,
        provider: 'exa',
      })
      const controller = new AiAssistProviderController({
        webSearchTester,
      })

      const res1 = fakeRes()
      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              providers: {
                exa: { enabled: true, apiKeys: ['test-exa-key'] },
              },
            },
          },
        },
        res1
      )
      expect(res1.body).to.deep.equal({
        latencyMs: 120,
        resultCount: 3,
        activeEndpoints: 1,
        provider: 'exa',
      })

      const res2 = fakeRes()
      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              type: 'exa',
              apiKey: 'test-exa-key',
            },
          },
        },
        res2
      )
      expect(res2.body).to.deep.equal({
        latencyMs: 120,
        resultCount: 3,
        activeEndpoints: 1,
        provider: 'exa',
      })
    })

    it('tests MCP web search provider settings successfully in multi and single format', async function () {
      const webSearchTester = sinon.stub().resolves({
        latencyMs: 95,
        resultCount: 4,
        activeEndpoints: 1,
        provider: 'mcp',
      })
      const controller = new AiAssistProviderController({
        webSearchTester,
      })

      const res1 = fakeRes()
      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              providers: {
                mcp: {
                  enabled: true,
                  serverUrls: ['https://api.agentshop247.com/api/mcp'],
                  headers: [{ key: 'Authorization', value: 'Bearer token' }],
                },
              },
            },
          },
        },
        res1
      )
      expect(res1.body).to.deep.equal({
        latencyMs: 95,
        resultCount: 4,
        activeEndpoints: 1,
        provider: 'mcp',
      })

      const res2 = fakeRes()
      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              type: 'mcp',
              baseUrl: 'https://api.agentshop247.com/api/mcp',
            },
          },
        },
        res2
      )
      expect(res2.body).to.deep.equal({
        latencyMs: 95,
        resultCount: 4,
        activeEndpoints: 1,
        provider: 'mcp',
      })
    })

    it('tests Parallel web search provider settings successfully in multi and single format', async function () {
      const webSearchTester = sinon.stub().resolves({
        latencyMs: 110,
        resultCount: 5,
        activeEndpoints: 1,
        provider: 'parallel',
      })
      const controller = new AiAssistProviderController({
        webSearchTester,
      })

      const res1 = fakeRes()
      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              providers: {
                parallel: { enabled: true, apiKeys: ['test-parallel-key'] },
              },
            },
          },
        },
        res1
      )
      expect(res1.body).to.deep.equal({
        latencyMs: 110,
        resultCount: 5,
        activeEndpoints: 1,
        provider: 'parallel',
      })

      const res2 = fakeRes()
      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              type: 'parallel',
              apiKey: 'test-parallel-key',
            },
          },
        },
        res2
      )
      expect(res2.body).to.deep.equal({
        latencyMs: 110,
        resultCount: 5,
        activeEndpoints: 1,
        provider: 'parallel',
      })
    })

    it('allows testing configured Parallel provider in draft mode even when enabled is false', async function () {
      const webSearchTester = sinon.stub().resolves({
        latencyMs: 75,
        resultCount: 3,
        activeEndpoints: 1,
        provider: 'parallel',
      })
      const controller = new AiAssistProviderController({
        webSearchTester,
      })
      const res = fakeRes()

      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              providers: {
                parallel: {
                  enabled: false,
                  apiKeys: ['test-parallel-key'],
                },
              },
            },
          },
        },
        res
      )

      expect(res.body).to.deep.equal({
        latencyMs: 75,
        resultCount: 3,
        activeEndpoints: 1,
        provider: 'parallel',
      })
    })

    it('allows testing configured provider in draft mode even when enabled is false', async function () {
      const webSearchTester = sinon.stub().resolves({
        latencyMs: 60,
        resultCount: 2,
        activeEndpoints: 1,
        provider: 'mcp',
      })
      const controller = new AiAssistProviderController({
        webSearchTester,
      })
      const res = fakeRes()

      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              providers: {
                mcp: {
                  enabled: false,
                  serverUrls: ['https://api.agentshop247.com/api/mcp'],
                },
              },
            },
          },
        },
        res
      )

      expect(res.body).to.deep.equal({
        latencyMs: 60,
        resultCount: 2,
        activeEndpoints: 1,
        provider: 'mcp',
      })
    })

    it('returns 200 with structured results even when all providers fail', async function () {
      const webSearchTester = sinon.stub().resolves({
        latencyMs: 110,
        anySuccess: false,
        results: [
          { provider: 'searxng', ok: false, error: 'Connection refused' },
          { provider: 'tavily', ok: false, error: 'Invalid API key (401)' },
        ],
        activeEndpoints: 2,
        provider: null,
      })
      const controller = new AiAssistProviderController({ webSearchTester })
      const res = fakeRes()

      await controller.testWebSearch(
        {
          body: {
            webSearchSettings: {
              providers: {
                searxng: { enabled: true, baseUrls: ['http://bad:8080'] },
                tavily: { enabled: true, apiKeys: ['bad-key'] },
              },
            },
          },
        },
        res
      )

      expect(res.statusCode).to.equal(200)
      expect(res.body.anySuccess).to.be.false
      expect(res.body.results).to.have.length(2)
      expect(res.body.results[0].provider).to.equal('searxng')
      expect(res.body.results[1].provider).to.equal('tavily')
    })

    it('rejects testWebSearch without webSearchSettings', async function () {
      const controller = new AiAssistProviderController()
      const res = fakeRes()

      await controller.testWebSearch({ body: {} }, res)

      expect(res.statusCode).to.equal(400)
      expect(res.body.error.code).to.equal('invalidWebSearchSettings')
    })
  })

  describe('images', function () {
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }
    const run = async (
      messages,
      streamChat = async function* () {
        yield { type: 'text', text: 'ok' }
      }
    ) => {
      const controller = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
      })
      const res = fakeRes()
      await controller.chat(
        { body: { providerSettings: settings, request: { messages, maxTokens: 10 } } },
        res
      )
      return res
    }

    it('passes images on a user message through to the provider', async function () {
      const streamChat = sinon.spy(async function* () {
        yield { type: 'text', text: 'ok' }
      })
      await run([{ role: 'user', content: 'eq', images: [image] }], streamChat)
      expect(streamChat.firstCall.args[0].messages[0].images).to.deep.equal([image])
    })

    it('refuses images it cannot accept, before calling the provider', async function () {
      const streamChat = sinon.spy(async function* () {})
      const res = await run([{ role: 'assistant', content: 'x', images: [image] }], streamChat)
      expect(res.statusCode).to.equal(400)
      expect(res.body.error.code).to.equal('invalidRequest')
      expect(streamChat.called).to.equal(false)
    })

    it('reports a provider refusing images as imageUnsupported', async function () {
      const res = await run([{ role: 'user', content: 'x', images: [image] }], async function* () {
        throw new ProviderError('image_url is only supported by certain models', { status: 400 })
      })
      expect(JSON.parse(res.written.at(-1)).error.code).to.equal('imageUnsupported')
    })

    it('keeps other failures as they are', async function () {
      const res = await run([{ role: 'user', content: 'x', images: [image] }], async function* () {
        throw new ProviderError('max_tokens is too large', { status: 400 })
      })
      expect(JSON.parse(res.written.at(-1)).error.code).to.equal('providerError')
    })
  })
})
