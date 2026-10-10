import { expect } from 'chai'
import {
  maxTokensFor,
  runWritingTool,
  StreamingClient,
} from '../../../../frontend/js/features/ai-assist/writing-tools/run-writing-tool'
import { writingToolsSettings } from '../../../../frontend/js/features/ai-assist/writing-tools/model-settings'
import {
  ChatChunk,
  ChatRequest,
  ProviderSettings,
} from '../../../../frontend/js/features/ai-assist/providers/types'

const SETTINGS: ProviderSettings = {
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'k',
  model: 'claude',
}

function fakeClient(chunks: ChatChunk[]) {
  const requests: ChatRequest[] = []
  const client: StreamingClient = {
    async *streamChat(request) {
      requests.push(request)
      for (const chunk of chunks) yield chunk
    },
  }
  return { client, requests }
}

describe('writing tools: runWritingTool', function () {
  it('streams the reply text and ignores thinking', async function () {
    const { client, requests } = fakeClient([
      { type: 'thinking', text: 'hmm' },
      { type: 'text', text: '<rewrite>Hel' },
      { type: 'text', text: 'lo</rewrite>' },
      { type: 'done' },
    ])
    const seen: string[] = []
    const text = await runWritingTool({
      settings: SETTINGS,
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'USER' }],
      maxTokens: 2000,
      onText: t => seen.push(t),
      client,
    })
    expect(text).to.equal('<rewrite>Hello</rewrite>')
    expect(seen).to.deep.equal(['<rewrite>Hel', '<rewrite>Hello</rewrite>'])
    expect(requests[0].system).to.equal('SYSTEM')
    expect(requests[0].messages).to.deep.equal([{ role: 'user', content: 'USER' }])
    expect(requests[0].maxTokens).to.equal(2000)
    expect(requests[0].cacheHints?.cacheSystem).to.equal(true)
  })

  it('fails when the reply hit the output limit', async function () {
    const { client } = fakeClient([
      { type: 'text', text: '<rewrite>Hel' },
      { type: 'stop', reason: 'max_tokens' },
    ])
    let error: any
    try {
      await runWritingTool({
        settings: SETTINGS,
        system: '',
        messages: [{ role: 'user', content: '' }],
        maxTokens: 10,
        onText: () => {},
        client,
      })
    } catch (err) {
      error = err
    }
    expect(error?.code).to.equal('outputTruncated')
  })

  it('budgets output by selection length', function () {
    expect(maxTokensFor('short')).to.equal(1024)
    expect(maxTokensFor('x'.repeat(4000))).to.equal(4512)
  })
})

describe('writing tools: model settings', function () {
  it('turns thinking off and drops the effort for thinking providers', function () {
    expect(
      writingToolsSettings(
        { ...SETTINGS, thinking: true, reasoningEffort: 'high' },
        'high'
      )
    ).to.deep.equal({ ...SETTINGS, thinking: false })
  })

  it('caps a chosen OpenAI effort at low and keeps Auto', function () {
    const openai: ProviderSettings = { ...SETTINGS, type: 'openai' }
    expect(writingToolsSettings(openai, 'high').reasoningEffort).to.equal('low')
    expect(writingToolsSettings(openai, 'minimal').reasoningEffort).to.equal(
      'minimal'
    )
    expect(writingToolsSettings(openai, undefined)).to.deep.equal(openai)
    expect(writingToolsSettings(openai, 'high').thinking).to.equal(undefined)
  })
})
