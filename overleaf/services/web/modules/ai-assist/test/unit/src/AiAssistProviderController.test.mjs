import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import { EventEmitter } from 'node:events'
import { AiAssistProviderController } from '../../../app/src/AiAssistProviderController.mjs'
import { createProviderClient } from '../../../app/src/AiAssistProviders.mjs'
import { ProviderError } from '../../../app/src/AiAssistErrors.mjs'

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
  baseUrl: 'http://203.0.113.5:11434',
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

  it('normalizes OpenAI baseUrl to end with /v1 when listing models', async function () {
    const settings = {
      type: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: 'k',
      model: 'gpt-4o',
    }
    const client = {
      listModels: sinon.stub().resolves([{ id: 'gpt-4o', label: 'GPT-4o' }]),
    }
    const clientFactory = sinon.stub().returns(client)
    const controller = new AiAssistProviderController({ clientFactory })
    const res = fakeRes()

    await controller.listModels({ body: { providerSettings: settings } }, res)

    expect(clientFactory.firstCall.args[0].baseUrl).to.equal(
      'https://api.openai.com/v1'
    )
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
    const session = { user: { _id: 'user-1' } }
    const storedProvider = {
      type: 'ollama',
      baseUrl: 'http://203.0.113.5:11434',
      model: 'qwen3:8b',
    }
    const storeWith = provider => ({
      getInternalUserSettings: sinon.stub().resolves({ provider, fastProvider: null }),
    })
    const editorRequest = {
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
    }

    it('passes on text only: no tool call, no thinking reaches the page', async function () {
      const streamChat = sinon.spy(async function* () {
        yield { type: 'thinking', text: 'the document asks me to read files' }
        yield { type: 'tool_call', id: 'c1', name: 'read_file', args: {} }
        yield { type: 'text', text: ' works.' }
        yield { type: 'stop', reason: 'max_tokens' }
      })
      const controller = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
        userSettingsStore: storeWith(storedProvider),
      })
      const res = fakeRes()
      await controller.editorText(
        { session, body: { request: editorRequest } },
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
        userSettingsStore: storeWith(storedProvider),
      })
      const res = fakeRes()
      await controller.editorText(
        {
          session,
          body: {
            request: {
              ...editorRequest,
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

    it('uses only the stored slot: client-sent provider settings and fallback are ignored', async function () {
      const clientFactory = sinon.spy(() => ({
        streamChat: async function* () {
          yield { type: 'text', text: 'ok' }
        },
      }))
      const controller = new AiAssistProviderController({
        clientFactory,
        userSettingsStore: storeWith(storedProvider),
      })
      const res = fakeRes()
      await controller.editorText(
        {
          session,
          body: {
            providerSettings: { type: 'openai', baseUrl: 'https://evil.example', apiKey: 'x' },
            fallbackProviderSettings: { type: 'openai', baseUrl: 'https://evil.example', apiKey: 'x' },
            request: editorRequest,
          },
        },
        res
      )
      expect(clientFactory.firstCall.args[0].type).to.equal('ollama')
      expect(clientFactory.firstCall.args[0].baseUrl).to.equal('http://203.0.113.5:11434')
      expect(clientFactory.callCount).to.equal(1)
    })

    it('picks the stored fast slot the page names, with the stored main slot as fallback', async function () {
      const storedFast = {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-mini',
        apiKey: 'stored-fast-key',
      }
      const failing = {
        streamChat: async function* () {
          throw Object.assign(new Error('down'), { status: 500, code: 'providerError' })
        },
      }
      const clientFactory = sinon.spy(settings =>
        settings.type === 'openai'
          ? failing
          : {
              streamChat: async function* () {
                yield { type: 'text', text: 'ok' }
              },
            }
      )
      const controller = new AiAssistProviderController({
        clientFactory,
        userSettingsStore: {
          getInternalUserSettings: sinon
            .stub()
            .resolves({ provider: storedProvider, fastProvider: storedFast }),
        },
      })
      const res = fakeRes()
      await controller.editorText(
        {
          session,
          body: {
            // The page sends masked copies; a swapped key must not be used
            providerSettings: { ...storedFast, apiKey: 'attacker-key' },
            fallbackProviderSettings: { ...storedProvider, apiKey: '••••••••' },
            request: { ...editorRequest, retryPolicy: 'none' },
            retryPolicy: 'none',
          },
        },
        res
      )
      expect(clientFactory.firstCall.args[0].model).to.equal('gpt-mini')
      expect(clientFactory.firstCall.args[0].apiKey).to.equal('stored-fast-key')
      const used = clientFactory.getCalls().map(call => call.args[0].type)
      expect(used).to.include('ollama')
    })

    it('refuses with 400 when the user has no stored provider', async function () {
      const clientFactory = sinon.spy(() => ({}))
      const controller = new AiAssistProviderController({
        clientFactory,
        userSettingsStore: storeWith(null),
      })
      const res = fakeRes()
      await controller.editorText(
        { session, body: { providerSettings: storedProvider, request: editorRequest } },
        res
      )
      expect(res.statusCode).to.equal(400)
      expect(res.body.error.code).to.equal('invalidProviderSettings')
      expect(clientFactory.called).to.equal(false)
    })

    it('caps maxTokens at the editor ceiling and short timeouts reach the client', async function () {
      const clientFactory = sinon.spy(() => ({
        streamChat: async function* () {
          yield { type: 'text', text: 'ok' }
        },
      }))
      const controller = new AiAssistProviderController({
        clientFactory,
        userSettingsStore: storeWith(storedProvider),
      })
      await controller.editorText(
        { session, body: { request: { ...editorRequest, maxTokens: 100000 } } },
        fakeRes()
      )
      const settingsArg = clientFactory.firstCall.args[0]
      expect(settingsArg.connectTimeoutMs).to.equal(20000)
      expect(settingsArg.streamIdleTimeoutMs).to.equal(30000)
      const streamChat = sinon.spy(async function* () {
        yield { type: 'text', text: 'ok' }
      })
      const second = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
        userSettingsStore: storeWith(storedProvider),
      })
      await second.editorText(
        { session, body: { request: { ...editorRequest, maxTokens: 100000 } } },
        fakeRes()
      )
      expect(streamChat.firstCall.args[0].maxTokens).to.equal(4096)
    })

    it('answers 429 when the user already has four editor streams running', async function () {
      let release
      const gate = new Promise(resolve => {
        release = resolve
      })
      const streamChat = async function* () {
        await gate
        yield { type: 'text', text: 'ok' }
      }
      const controller = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
        userSettingsStore: storeWith(storedProvider),
      })
      const running = [1, 2, 3, 4].map(() =>
        controller.editorText({ session, body: { request: editorRequest } }, fakeRes())
      )
      await new Promise(resolve => setTimeout(resolve, 20))
      const res = fakeRes()
      await controller.editorText({ session, body: { request: editorRequest } }, res)
      expect(res.statusCode).to.equal(429)
      expect(res.body.error.code).to.equal('providerBusy')
      release()
      await Promise.all(running)
    })

    it('ends a stream that runs past the editor total limit with a timeout error', async function () {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const streamChat = async function* ({ signal }) {
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
        }
        const controller = new AiAssistProviderController({
          clientFactory: () => ({ streamChat }),
          userSettingsStore: storeWith(storedProvider),
        })
        const res = fakeRes()
        const done = controller.editorText(
          { session, body: { request: editorRequest } },
          res
        )
        await new Promise(resolve => setImmediate(resolve))
        clock.tick(90000)
        await done
        const lines = res.written.map(line => JSON.parse(line))
        expect(lines.at(-1)).to.deep.include({ type: 'error' })
        expect(lines.at(-1).error.code).to.equal('providerTimeout')
      } finally {
        clock.restore()
      }
    })

    it('retries with the background policy for editor requests unless asked otherwise', async function () {
      let calls = 0
      const streamChat = async function* () {
        calls++
        if (calls <= 3) throw new ProviderError('busy', { status: 503 })
        yield { type: 'text', text: 'ok' }
      }
      const controller = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
        userSettingsStore: storeWith(storedProvider),
      })
      const res = fakeRes()
      await controller.editorText(
        { session, body: { request: editorRequest } },
        res
      )
      // Background allows three retries: four tries in all
      expect(calls).to.equal(4)
      expect(res.written.map(line => JSON.parse(line)).at(-1)).to.deep.equal({
        type: 'done',
      })
    })

    it('falls back from fast slot to main slot when primary fails before emitting chunks', async function () {
      const storedFast = {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-mini',
        apiKey: 'stored-fast-key',
      }
      const controller = new AiAssistProviderController({
        clientFactory: settings => {
          if (settings.type === 'openai') {
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
        userSettingsStore: {
          getInternalUserSettings: sinon
            .stub()
            .resolves({ provider: storedProvider, fastProvider: storedFast }),
        },
      })
      const res = fakeRes()
      await controller.editorText(
        { session, body: { slot: 'fastProvider', request: editorRequest } },
        res
      )
      const lines = res.written.map(line => JSON.parse(line))
      expect(lines.filter(l => l.type === 'text').map(l => l.text)).to.deep.equal([
        'fallback output',
      ])
      expect(lines.at(-1)).to.deep.equal({ type: 'done' })
    })

    it('does not fall back if primary client fails after emitting chunks', async function () {
      const storedFast = {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-mini',
        apiKey: 'stored-fast-key',
      }
      const controller = new AiAssistProviderController({
        clientFactory: settings => {
          if (settings.type === 'openai') {
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
        userSettingsStore: {
          getInternalUserSettings: sinon
            .stub()
            .resolves({ provider: storedProvider, fastProvider: storedFast }),
        },
      })
      const res = fakeRes()
      await controller.editorText(
        { session, body: { slot: 'fastProvider', request: editorRequest } },
        res
      )
      const lines = res.written.map(line => JSON.parse(line))
      expect(lines.filter(l => l.type === 'text').map(l => l.text)).to.deep.equal([
        'partial',
      ])
      expect(lines.some(l => l.type === 'error')).to.equal(true)
      expect(lines.some(l => l.type === 'done')).to.equal(false)
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

  describe('retries', function () {
    const request = {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
    }

    it('retries a failure before any content and shows a retrying line', async function () {
      let calls = 0
      const streamChat = async function* () {
        calls++
        if (calls === 1) {
          throw new ProviderError('Service unavailable', { status: 503 })
        }
        yield { type: 'text', text: 'ok' }
      }
      const controller = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
      })
      const res = fakeRes()

      await controller.chat({ body: { providerSettings: settings, request } }, res)

      const lines = res.written.map(line => JSON.parse(line))
      expect(calls).to.equal(2)
      expect(lines[0]).to.include({
        type: 'retrying',
        attempt: 1,
        maxRetries: 10,
        message: 'Server error (503)',
        status: 503,
      })
      expect(lines.slice(1)).to.deep.equal([
        { type: 'text', text: 'ok' },
        { type: 'done' },
      ])
    })

    it('does not retry once content has reached the page', async function () {
      let calls = 0
      const streamChat = async function* () {
        calls++
        yield { type: 'text', text: 'partial' }
        throw new ProviderError('Service unavailable', { status: 503 })
      }
      const controller = new AiAssistProviderController({
        clientFactory: () => ({ streamChat }),
      })
      const res = fakeRes()

      await controller.chat({ body: { providerSettings: settings, request } }, res)

      const lines = res.written.map(line => JSON.parse(line))
      expect(calls).to.equal(1)
      expect(lines.map(line => line.type)).to.deep.equal(['text', 'error'])
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
