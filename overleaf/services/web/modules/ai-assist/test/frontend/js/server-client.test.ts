import { expect } from 'chai'
import sinon from 'sinon'
import { ServerProviderClient } from '../../../frontend/js/features/ai-assist/providers/server-client'
import {
  ProviderError,
  ProviderSettings,
} from '../../../frontend/js/features/ai-assist/providers/types'

const settings: ProviderSettings = {
  type: 'ollama',
  baseUrl: 'http://10.0.0.5:11434',
  apiKey: '',
  model: 'qwen3:8b',
}

function ndjsonResponse(lines: string[]) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function collect(client: ServerProviderClient) {
  const chunks: any[] = []
  for await (const chunk of client.streamChat({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 10,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

describe('ServerProviderClient', function () {
  let fakeFetch: sinon.SinonStub

  beforeEach(function () {
    fakeFetch = sinon.stub(globalThis, 'fetch' as any)
  })

  afterEach(function () {
    fakeFetch.restore()
  })

  it('never calls the provider directly — only Overleaf endpoints', async function () {
    fakeFetch.resolves(
      new Response(JSON.stringify({ models: [{ id: 'a', label: 'a' }] }))
    )
    const models = await new ServerProviderClient(settings).listModels()

    expect(models).to.deep.equal([{ id: 'a', label: 'a' }])
    const [url, init] = fakeFetch.firstCall.args
    expect(url).to.equal('/ai-assist/providers/models')
    expect(JSON.parse(init.body)).to.deep.equal({ providerSettings: settings })
  })

  it('surfaces server error payloads as ProviderError', async function () {
    fakeFetch.resolves(
      new Response(
        JSON.stringify({ error: { code: 'providerAuth', message: 'bad key' } }),
        { status: 502 }
      )
    )
    try {
      await new ServerProviderClient(settings).test()
      expect.fail('should reject')
    } catch (error: any) {
      expect(error).to.be.instanceOf(ProviderError)
      expect(error.code).to.equal('providerAuth')
      expect(error.message).to.equal('bad key')
    }
  })

  it('parses NDJSON chunks split across network reads', async function () {
    fakeFetch.resolves(
      ndjsonResponse([
        '{"type":"text","te',
        'xt":"hel"}\n{"type":"tool_call","id":"c1","name":"read_file","args":{}}\n',
        '{"type":"done"}\n',
      ])
    )
    const chunks = await collect(new ServerProviderClient(settings))

    expect(chunks).to.deep.equal([
      { type: 'text', text: 'hel' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: {} },
      { type: 'done' },
    ])
    const body = JSON.parse(fakeFetch.firstCall.args[1].body)
    expect(fakeFetch.firstCall.args[0]).to.equal('/ai-assist/providers/chat')
    expect(body.request).to.include({ system: 's', maxTokens: 10 })
  })

  it('throws the streamed error line', async function () {
    fakeFetch.resolves(
      ndjsonResponse([
        '{"type":"text","text":"x"}\n',
        '{"type":"error","error":{"code":"network","message":"Could not reach Ollama"}}\n',
      ])
    )
    try {
      await collect(new ServerProviderClient(settings))
      expect.fail('should reject')
    } catch (error: any) {
      expect(error.code).to.equal('network')
      expect(error.message).to.equal('Could not reach Ollama')
    }
  })

  it('treats a stream without done as interrupted', async function () {
    fakeFetch.resolves(ndjsonResponse(['{"type":"text","text":"x"}\n']))
    try {
      await collect(new ServerProviderClient(settings))
      expect.fail('should reject')
    } catch (error: any) {
      expect(error.code).to.equal('network')
    }
  })
})
