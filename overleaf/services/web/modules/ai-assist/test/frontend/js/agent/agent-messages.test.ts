import { expect } from 'chai'
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
})
