import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { OpenAiClient } from '../../../../frontend/js/features/ai-assist/providers/openai'

const OPENAI = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
}

const READ_FILE = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

function sse(body: string) {
  return { body, headers: { 'Content-Type': 'text/event-stream' } }
}

async function collect(generator: AsyncGenerator<any>) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

describe('OpenAiClient tool calling', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('sends tool specs and tool_choice auto', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse('data: [DONE]\n\n')
    )

    await collect(
      new OpenAiClient(OPENAI).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const body = JSON.parse(
      fetchMock.callHistory.lastCall()!.options!.body as string
    )
    expect(body.tools).to.deep.equal([{ type: 'function', function: READ_FILE }])
    expect(body.tool_choice).to.equal('auto')
  })

  it('assembles one tool_call from argument fragments split across frames', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"main.tex\\"}"}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )

    const chunks = await collect(
      new OpenAiClient(OPENAI).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    expect(chunks.filter(c => c.type === 'tool_call')).to.deep.equal([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        args: { path: 'main.tex' },
      },
    ])
    expect(chunks.at(-1)).to.deep.equal({ type: 'done', stopReason: 'tool_calls' })
  })

  it('reports malformed arguments as an args parse failure rather than throwing', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"read_file","arguments":"{not json"}}]}}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )

    const chunks = await collect(
      new OpenAiClient(OPENAI).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const call = chunks.find(c => c.type === 'tool_call')
    expect(call.args).to.deep.equal({ __parseError: '{not json' })
  })

  it('replays a tool result as a role:tool message', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse('data: [DONE]\n\n')
    )

    await collect(
      new OpenAiClient(OPENAI).streamChat({
        system: 's',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'call_1', name: 'read_file', args: { path: 'main.tex' } },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_1',
            name: 'read_file',
            content: '1: hello',
          },
        ],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const body = JSON.parse(
      fetchMock.callHistory.lastCall()!.options!.body as string
    )
    expect(body.messages[2]).to.deep.equal({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"main.tex"}' },
        },
      ],
    })
    expect(body.messages[3]).to.deep.equal({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '1: hello',
    })
  })
})
