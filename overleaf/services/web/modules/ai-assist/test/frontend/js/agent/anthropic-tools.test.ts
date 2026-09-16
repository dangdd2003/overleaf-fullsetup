import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { AnthropicClient } from '../../../../frontend/js/features/ai-assist/providers/anthropic'

const ANTHROPIC = {
  type: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5',
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

describe('AnthropicClient tool calling', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('sends tools with input_schema', async function () {
    fetchMock.post(
      'https://api.anthropic.com/v1/messages',
      sse('data: {"type":"message_stop"}\n\n')
    )

    await collect(
      new AnthropicClient(ANTHROPIC).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const body = JSON.parse(
      fetchMock.callHistory.lastCall()!.options!.body as string
    )
    expect(body.tools).to.deep.equal([
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: READ_FILE.parameters,
      },
    ])
  })

  it('assembles a tool_use block from input_json_delta fragments', async function () {
    fetchMock.post(
      'https://api.anthropic.com/v1/messages',
      sse(
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n' +
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n' +
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"main.tex\\"}"}}\n\n' +
          'data: {"type":"content_block_stop","index":0}\n\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
      )
    )

    const chunks = await collect(
      new AnthropicClient(ANTHROPIC).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    expect(chunks.filter(c => c.type === 'tool_call')).to.deep.equal([
      {
        type: 'tool_call',
        id: 'toolu_1',
        name: 'read_file',
        args: { path: 'main.tex' },
      },
    ])
    expect(chunks.at(-1)).to.deep.equal({ type: 'done', stopReason: 'tool_calls' })
  })

  it('replays tool results as a user message of tool_result blocks', async function () {
    fetchMock.post(
      'https://api.anthropic.com/v1/messages',
      sse('data: {"type":"message_stop"}\n\n')
    )

    await collect(
      new AnthropicClient(ANTHROPIC).streamChat({
        system: 's',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: 'Looking.',
            toolCalls: [
              { id: 'toolu_1', name: 'read_file', args: { path: 'main.tex' } },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'toolu_1',
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
    expect(body.messages[1].content).to.deep.equal([
      { type: 'text', text: 'Looking.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'read_file',
        input: { path: 'main.tex' },
      },
    ])
    expect(body.messages[2]).to.deep.equal({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '1: hello',
          is_error: false,
        },
      ],
    })
  })
})
