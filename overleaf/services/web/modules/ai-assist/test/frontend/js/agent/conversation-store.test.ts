import { expect } from 'chai'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  clearConversation,
  loadConversation,
  saveConversation,
} from '../../../../frontend/js/features/ai-assist/agent/conversation-store'
import { TranscriptEntry } from '../../../../frontend/js/features/ai-assist/agent/agent-messages'

const PROJECT = '6789abcdef0123456789abcd'

describe('conversation-store', function () {
  beforeEach(function () {
    customLocalStorage.clear()
  })

  it('returns an empty transcript for an unknown project', function () {
    expect(loadConversation(PROJECT)).to.deep.equal([])
  })

  it('round-trips a transcript', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'hello' },
      { id: '2', role: 'assistant', text: 'hi', toolCalls: [] },
    ]
    saveConversation(PROJECT, transcript)
    expect(loadConversation(PROJECT)).to.deep.equal(transcript)
  })

  it('keeps conversations for different projects apart', function () {
    saveConversation(PROJECT, [{ id: '1', role: 'user', text: 'a' }])
    saveConversation('other', [{ id: '1', role: 'user', text: 'b' }])
    expect(loadConversation(PROJECT)[0]).to.deep.include({ text: 'a' })
    expect(loadConversation('other')[0]).to.deep.include({ text: 'b' })
  })

  it('truncates a large tool result before storing it', function () {
    saveConversation(PROJECT, [
      {
        id: '2',
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'read_file',
            args: {},
            result: { content: 'x'.repeat(50000) },
          },
        ],
      },
    ])

    const stored = loadConversation(PROJECT)
    const result = JSON.stringify((stored[0] as any).toolCalls[0].result)
    expect(result.length).to.be.lessThan(5000)
    expect(result).to.match(/truncated/i)
  })

  it('does not recursively nest truncated results across repeated saves', function () {
    const transcript: TranscriptEntry[] = [
      {
        id: '2',
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'read_file',
            args: { path: 'big.tex' },
            result: { path: 'big.tex', content: 'z'.repeat(50000) },
          },
        ],
      },
    ]

    // Simulate saving across 10 successive conversation turns
    for (let i = 0; i < 10; i++) {
      saveConversation(PROJECT, transcript)
      const reloaded = loadConversation(PROJECT)
      transcript[0] = reloaded[0]
    }

    const finalLoaded = loadConversation(PROJECT)
    const rawResult = JSON.stringify((finalLoaded[0] as any).toolCalls[0].result)
    // Must NOT contain nested stringified preview JSON wrappers
    expect(rawResult).to.not.include('\\"preview\\"')
  })

  it('drops the oldest turns when the transcript exceeds the byte cap', function () {
    const many: TranscriptEntry[] = Array.from({ length: 400 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      text: 'y'.repeat(2000),
    }))
    saveConversation(PROJECT, many)

    const stored = loadConversation(PROJECT)
    expect(stored.length).to.be.lessThan(400)
    expect(stored.at(-1)!.id).to.equal('399')
  })

  it('clears a conversation', function () {
    saveConversation(PROJECT, [{ id: '1', role: 'user', text: 'a' }])
    clearConversation(PROJECT)
    expect(loadConversation(PROJECT)).to.deep.equal([])
  })

  it('returns an empty transcript rather than throwing on corrupt storage', function () {
    // Deliberately raw: customLocalStorage JSON-encodes, so it cannot write the
    // invalid value this test exists to read back.
    // eslint-disable-next-line no-restricted-syntax
    window.localStorage.setItem(`ai-assist:chat:${PROJECT}`, 'not json')
    expect(loadConversation(PROJECT)).to.deep.equal([])
  })

  it('deduplicates tool calls with the same id on save and load', function () {
    const duplicateTranscript: any[] = [
      {
        id: 'a1',
        role: 'assistant',
        text: 'Working on it',
        toolCalls: [
          { id: 'call_1', name: 'read_file', args: { path: 'main.tex' }, result: 'content 1' },
          { id: 'call_1', name: 'read_file', args: { path: 'main.tex' }, result: 'content 1' },
          { id: 'call_2', name: 'edit_file', args: { path: 'main.tex' }, result: 'content 2' },
          { id: 'call_2', name: 'edit_file', args: { path: 'main.tex' }, result: 'content 2' },
        ],
        blocks: [
          { type: 'tool_call', call: { id: 'call_1', name: 'read_file', args: { path: 'main.tex' }, result: 'content 1' } },
          { type: 'tool_call', call: { id: 'call_1', name: 'read_file', args: { path: 'main.tex' }, result: 'content 1' } },
          { type: 'tool_call', call: { id: 'call_2', name: 'edit_file', args: { path: 'main.tex' }, result: 'content 2' } },
          { type: 'tool_call', call: { id: 'call_2', name: 'edit_file', args: { path: 'main.tex' }, result: 'content 2' } },
        ],
      },
    ]

    saveConversation('dedup-project', duplicateTranscript)
    const loaded = loadConversation('dedup-project')
    const assistant = loaded[0] as any
    expect(assistant.toolCalls).to.have.lengthOf(2)
    expect(assistant.toolCalls[0].id).to.equal('call_1')
    expect(assistant.toolCalls[1].id).to.equal('call_2')
    expect(assistant.blocks).to.have.lengthOf(2)
  })
})
