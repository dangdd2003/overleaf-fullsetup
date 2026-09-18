import { expect } from 'chai'
import sinon from 'sinon'
import { EventEmitter } from 'node:events'
import { AiAssistProviderController } from '../../../app/src/AiAssistProviderController.mjs'
import { createProviderClient, ProviderError } from '../../../app/src/AiAssistProviders.mjs'

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

const settings = { type: 'ollama', baseUrl: 'http://10.0.0.5:11434', model: 'qwen3:8b' }

describe('AiAssistProviderController', function () {
  it('lists models through the server-side client', async function () {
    const client = { listModels: sinon.stub().resolves([{ id: 'qwen3:8b', label: 'qwen3:8b' }]) }
    const clientFactory = sinon.stub().returns(client)
    const controller = new AiAssistProviderController({ clientFactory })
    const res = fakeRes()

    await controller.listModels({ body: { providerSettings: settings } }, res)

    expect(clientFactory.firstCall.args[0]).to.deep.equal(settings)
    expect(res.body).to.deep.equal({ models: [{ id: 'qwen3:8b', label: 'qwen3:8b' }] })
  })

  it('rejects requests without provider settings', async function () {
    const controller = new AiAssistProviderController({ clientFactory: sinon.stub() })
    const res = fakeRes()

    await controller.listModels({ body: {} }, res)

    expect(res.statusCode).to.equal(400)
  })

  it('returns upstream failures as 502 with the provider message', async function () {
    const client = {
      listModels: sinon.stub().rejects(new ProviderError('bad key', { code: 'providerAuth', status: 401 })),
    }
    const controller = new AiAssistProviderController({ clientFactory: () => client })
    const res = fakeRes()

    await controller.listModels({ body: { providerSettings: settings } }, res)

    expect(res.statusCode).to.equal(502)
    expect(res.body.error).to.deep.equal({ code: 'providerAuth', message: 'bad key' })
  })

  it('refuses internal service URLs with 400', async function () {
    const controller = new AiAssistProviderController({ clientFactory: createProviderClient })
    const res = fakeRes()

    await controller.test(
      { body: { providerSettings: { type: 'openai', baseUrl: 'http://mongo:27017', model: 'x' } } },
      res
    )

    expect(res.statusCode).to.equal(400)
    expect(res.body.error.code).to.equal('restrictedProviderUrl')
  })

  it('tests the connection with a one-token chat', async function () {
    const streamChat = sinon.spy(async function* () {
      yield { type: 'text', text: 'ok' }
    })
    const controller = new AiAssistProviderController({ clientFactory: () => ({ streamChat }) })
    const res = fakeRes()

    await controller.test({ body: { providerSettings: settings } }, res)

    expect(streamChat.firstCall.args[0].maxTokens).to.equal(1)
    expect(res.body.latencyMs).to.be.a('number')
  })

  it('streams chat chunks as NDJSON and ends with done', async function () {
    const streamChat = sinon.spy(async function* () {
      yield { type: 'thinking', text: 'hmm' }
      yield { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'main.tex' } }
    })
    const controller = new AiAssistProviderController({ clientFactory: () => ({ streamChat }) })
    const res = fakeRes()
    const request = {
      system: 'fix it',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      tools: [{ name: 'read_file', description: 'd', parameters: {} }],
    }

    await controller.chat({ body: { providerSettings: settings, request } }, res)

    expect(streamChat.firstCall.args[0]).to.include({ system: 'fix it', maxTokens: 100 })
    expect(res.written.map(line => JSON.parse(line))).to.deep.equal([
      { type: 'thinking', text: 'hmm' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'main.tex' } },
      { type: 'done' },
    ])
    expect(res.end.called).to.equal(true)
  })

  it('forwards the context window and relays stop chunks', async function () {
    const streamChat = sinon.spy(async function* () {
      yield { type: 'text', text: 'partial' }
      yield { type: 'stop', reason: 'max_tokens' }
    })
    const controller = new AiAssistProviderController({ clientFactory: () => ({ streamChat }) })
    const res = fakeRes()
    const request = {
      system: 'fix it',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      contextWindow: 32768,
    }

    await controller.chat({ body: { providerSettings: settings, request } }, res)

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
    const controller = new AiAssistProviderController({ clientFactory: () => ({ streamChat }) })
    const res = fakeRes()

    await controller.chat(
      { body: { providerSettings: settings, request: { messages: [], maxTokens: 10 } } },
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
    const controller = new AiAssistProviderController({ clientFactory: () => ({ streamChat }) })
    const res = fakeRes()

    const done = controller.chat(
      { body: { providerSettings: settings, request: { messages: [], maxTokens: 10 } } },
      res
    )
    await new Promise(resolve => setImmediate(resolve))
    res.emit('close')
    await done

    expect(seenSignal.aborted).to.equal(true)
    expect(res.written.map(line => JSON.parse(line).type)).to.deep.equal(['text'])
  })
})
