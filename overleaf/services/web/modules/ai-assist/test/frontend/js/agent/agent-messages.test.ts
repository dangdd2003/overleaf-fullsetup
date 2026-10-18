import { expect } from 'chai'
import { AgentMessage } from '../../../../frontend/js/features/ai-assist/providers/types'
import {
  TranscriptEntry,
  toAgentMessages,
} from '../../../../frontend/js/features/ai-assist/agent/agent-messages'

describe('toAgentMessages', function () {
  it('converts a plain exchange', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'hello' },
      { id: '2', role: 'assistant', text: 'hi', toolCalls: [] },
    ]

    expect(toAgentMessages(transcript)).to.deep.equal([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('prefixes the frozen context block onto the user turn', function () {
    const messages = toAgentMessages([
      { id: 'u1', role: 'user', text: 'fix it', contextText: '<project-context turn="1"></project-context>' },
    ])
    expect(messages[0].content).to.equal(
      '<project-context turn="1"></project-context>\n\nfix it'
    )
  })

  it('expands each tool call into an assistant turn plus a tool result', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'read main' },
      {
        id: '2',
        role: 'assistant',
        text: 'Looking.',
        toolCalls: [
          {
            id: 'call_1',
            name: 'read_file',
            args: { path: 'main.tex' },
            result: { content: '1: hello' },
            isError: false,
          },
        ],
      },
    ]

    expect(toAgentMessages(transcript)).to.deep.equal([
      { role: 'user', content: 'read main' },
      {
        role: 'assistant',
        content: 'Looking.',
        toolCalls: [
          { id: 'call_1', name: 'read_file', args: { path: 'main.tex' } },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'read_file',
        content: '{"content":"1: hello"}',
        isError: false,
      },
    ])
  })

  it('synthesises a result for a call that never finished', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'go' },
      {
        id: '2',
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call_1', name: 'compile_project', args: {} }],
      },
    ]

    const messages = toAgentMessages(transcript)
    expect(messages.at(-1)).to.deep.include({
      role: 'tool',
      toolCallId: 'call_1',
      isError: true,
    })
  })

  it('drops an empty trailing assistant turn so the model is not asked to continue nothing', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'go' },
      { id: '2', role: 'assistant', text: '', toolCalls: [] },
    ]

    expect(toAgentMessages(transcript)).to.deep.equal([
      { role: 'user', content: 'go' },
    ])
  })

  it('preserves images on user transcript entries when calling toAgentMessages', function () {
    const entry: TranscriptEntry = {
      id: 'u1',
      role: 'user',
      text: 'Analyze this photo',
      images: [{ mediaType: 'image/png', data: 'base64...' }],
    }
    const messages = toAgentMessages([entry])
    expect((messages[0] as Extract<AgentMessage, { role: 'user' }>).images).to.deep.equal([
      { mediaType: 'image/png', data: 'base64...' },
    ])
  })

  it('omits images property on user message when entry has no images', function () {
    const entry: TranscriptEntry = {
      id: 'u1',
      role: 'user',
      text: 'No images here',
    }
    const messages = toAgentMessages([entry])
    expect((messages[0] as Extract<AgentMessage, { role: 'user' }>).images).to.be.undefined
  })
})

describe('toAgentMessages with a slash command', function () {
  const frozen = {
    id: 'u1',
    role: 'user' as const,
    contextText: 'CTX',
    command: { id: 'fix' as const, args: '' },
    commandText: '<command name="fix" scope="edit">\n</command>',
  }

  it('joins context, command block and words in that order', function () {
    const messages = toAgentMessages([{ ...frozen, text: 'the table' }])
    expect(messages[0].content).to.equal(
      'CTX\n\n<command name="fix" scope="edit">\n</command>\n\nthe table'
    )
  })

  it('leaves no blank part when the command has no words', function () {
    const messages = toAgentMessages([{ ...frozen, text: '' }])
    expect(messages[0].content).to.equal(
      'CTX\n\n<command name="fix" scope="edit">\n</command>'
    )
  })

  it('joins the command block alone when there is no context', function () {
    const messages = toAgentMessages([
      { ...frozen, contextText: undefined, text: 'words' },
    ])
    expect(messages[0].content).to.equal(
      '<command name="fix" scope="edit">\n</command>\n\nwords'
    )
  })

  it('keeps an older entry byte-identical to the context-and-text join', function () {
    const messages = toAgentMessages([
      { id: 'u1', role: 'user', contextText: 'CTX', text: '' },
      { id: 'u2', role: 'user', text: 'plain' },
    ])
    expect(messages.map(m => m.content)).to.deep.equal(['CTX\n\n', 'plain'])
  })
})

