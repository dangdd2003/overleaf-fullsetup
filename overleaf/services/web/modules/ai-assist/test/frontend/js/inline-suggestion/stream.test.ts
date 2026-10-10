import { expect } from 'chai'
import sinon from 'sinon'
import { chatTextStream } from '../../../../frontend/js/features/ai-assist/inline-suggestion/stream'

const SETTINGS = {
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'k',
  model: 'claude',
} as any

describe('inline suggestions: chat text stream', function () {
  it('yields the reply so far, skips thinking, stops at the output limit', async function () {
    let seen: any = null
    const client = {
      async *streamChat(request: any) {
        seen = request
        yield { type: 'thinking', text: 'hmm' } as const
        yield { type: 'text', text: 'Hel' } as const
        yield { type: 'text', text: 'lo' } as const
        yield { type: 'stop', reason: 'max_tokens' } as const
      },
    }
    const controller = new AbortController()
    const stream = chatTextStream({
      settings: SETTINGS,
      system: 'S',
      messages: [{ role: 'user', content: 'U' }],
      maxTokens: 120,
      client,
    })
    const replies: string[] = []
    for await (const reply of stream(controller.signal)) replies.push(reply)

    expect(replies).to.deep.equal(['Hel', 'Hello'])
    expect(seen.system).to.equal('S')
    expect(seen.messages).to.deep.equal([{ role: 'user', content: 'U' }])
    expect(seen.maxTokens).to.equal(120)
    expect(seen.signal).to.equal(controller.signal)
  })

  it('passes fallbackSettings to EditorTextClient when constructed', async function () {
    const fakeFetch = sinon.stub(globalThis, 'fetch' as any).resolves(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"type":"text","text":"hi"}\n{"type":"done"}\n'
              )
            )
            controller.close()
          },
        }),
        { status: 200 }
      )
    )
    try {
      const fallbackSettings = {
        type: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'key2',
        model: 'gpt-4o',
      } as any
      const stream = chatTextStream({
        settings: SETTINGS,
        fallbackSettings,
        system: 'S',
        messages: [{ role: 'user', content: 'U' }],
        maxTokens: 10,
      })
      for await (const _ of stream(new AbortController().signal)) {}
      expect(fakeFetch.calledOnce).to.be.true
      const body = JSON.parse(fakeFetch.firstCall.args[1].body)
      expect(body.fallbackProviderSettings).to.deep.equal(fallbackSettings)
    } finally {
      fakeFetch.restore()
    }
  })
})
