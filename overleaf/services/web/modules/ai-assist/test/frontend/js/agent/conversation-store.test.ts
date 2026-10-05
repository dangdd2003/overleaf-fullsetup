import { expect } from 'chai'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  clearConversation,
  dropRepeatedEntries,
  loadConversation,
  mergeStoredTranscript,
  prepareTranscriptForRun,
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
    const rawResult = JSON.stringify(
      (finalLoaded[0] as any).toolCalls[0].result
    )
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
          {
            id: 'call_1',
            name: 'read_file',
            args: { path: 'main.tex' },
            result: 'content 1',
          },
          {
            id: 'call_1',
            name: 'read_file',
            args: { path: 'main.tex' },
            result: 'content 1',
          },
          {
            id: 'call_2',
            name: 'edit_file',
            args: { path: 'main.tex' },
            result: 'content 2',
          },
          {
            id: 'call_2',
            name: 'edit_file',
            args: { path: 'main.tex' },
            result: 'content 2',
          },
        ],
        blocks: [
          {
            type: 'tool_call',
            call: {
              id: 'call_1',
              name: 'read_file',
              args: { path: 'main.tex' },
              result: 'content 1',
            },
          },
          {
            type: 'tool_call',
            call: {
              id: 'call_1',
              name: 'read_file',
              args: { path: 'main.tex' },
              result: 'content 1',
            },
          },
          {
            type: 'tool_call',
            call: {
              id: 'call_2',
              name: 'edit_file',
              args: { path: 'main.tex' },
              result: 'content 2',
            },
          },
          {
            type: 'tool_call',
            call: {
              id: 'call_2',
              name: 'edit_file',
              args: { path: 'main.tex' },
              result: 'content 2',
            },
          },
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

  it('never opens a chat with the conversation kept before chats had ids', function () {
    saveConversation(PROJECT, [{ id: '1', role: 'user', text: 'legacy' }])
    // That copy is whichever chat was last open: a chat with no copy of its
    // own opens empty, and its turns come from the server's history
    expect(loadConversation(PROJECT, 'chat_new')).to.deep.equal([])
    expect(loadConversation(PROJECT, 'chat_other')).to.deep.equal([])
  })

  it('shows a question stored twice in a row once', function () {
    saveConversation(PROJECT, 'chat_A', [
      { id: 'u0', role: 'user', text: 'Scan this project' },
      { id: 'u0', role: 'user', text: 'Scan this project' },
      { id: 'a2', role: 'assistant', text: 'Done', toolCalls: [] },
    ])
    expect(loadConversation(PROJECT, 'chat_A').map(e => e.id)).to.deep.equal([
      'u0',
      'a2',
    ])
  })

  it("never shows one chat's turns in another", function () {
    saveConversation(PROJECT, 'chat_A', [{ id: '1', role: 'user', text: 'only A' }])
    expect(loadConversation(PROJECT, 'chat_new')).to.deep.equal([])
  })

  it('keeps conversations for different chatIds within the same project apart', function () {
    saveConversation(PROJECT, 'chat_A', [{ id: '1', role: 'user', text: 'chat A message' }])
    saveConversation(PROJECT, 'chat_B', [{ id: '2', role: 'user', text: 'chat B message' }])
    expect(loadConversation(PROJECT, 'chat_A')[0]).to.deep.include({ text: 'chat A message' })
    expect(loadConversation(PROJECT, 'chat_B')[0]).to.deep.include({ text: 'chat B message' })
  })

  it('preserves all turns intact without dropping top turns when tool outputs are large', function () {
    const multiTurn: TranscriptEntry[] = [
      { id: 'u0', role: 'user', text: 'turn 0 question' },
      {
        id: 'a0',
        role: 'assistant',
        text: 'turn 0 answer',
        toolCalls: [
          {
            id: 'c0',
            name: 'read_file',
            args: { path: 'a.tex' },
            result: { content: 'x'.repeat(60000) },
          },
        ],
      },
      { id: 'u1', role: 'user', text: 'turn 1 question' },
      {
        id: 'a1',
        role: 'assistant',
        text: 'turn 1 answer',
        toolCalls: [
          {
            id: 'c1',
            name: 'read_file',
            args: { path: 'b.tex' },
            result: { content: 'y'.repeat(60000) },
          },
        ],
      },
      { id: 'u2', role: 'user', text: 'turn 2 question' },
    ]

    saveConversation(PROJECT, 'chat_multi', multiTurn)
    const stored = loadConversation(PROJECT, 'chat_multi')

    // All 5 turns MUST still be present - never dropped from top!
    expect(stored.length).to.equal(5)
    expect(stored[0].id).to.equal('u0')
    expect((stored[0] as any).text).to.equal('turn 0 question')
    expect(stored[4].id).to.equal('u2')
  })

  describe('prepareTranscriptForRun', function () {
    it('returns empty or non-array transcript unchanged', function () {
      expect(prepareTranscriptForRun([])).to.deep.equal([])
      expect(prepareTranscriptForRun(null as any)).to.equal(null)
    })

    it('returns transcript as-is when size is within limit', function () {
      const transcript: TranscriptEntry[] = [
        { id: '1', role: 'user', text: 'hello' },
        { id: '2', role: 'assistant', text: 'hi', toolCalls: [] },
      ]
      expect(prepareTranscriptForRun(transcript, 10000)).to.deep.equal(
        transcript
      )
    })

    it('shrinks older assistant tool results while preserving the latest turn intact if it fits', function () {
      const largeResult = { content: 'x'.repeat(10000) }
      const smallResult = { content: 'y'.repeat(1000) }
      const transcript: TranscriptEntry[] = [
        { id: '1', role: 'user', text: 'read older file' },
        {
          id: '2',
          role: 'assistant',
          text: 'here is old file',
          toolCalls: [
            {
              id: 'call_1',
              name: 'read_file',
              args: { path: 'old.tex' },
              result: largeResult,
            },
          ],
        },
        { id: '3', role: 'user', text: 'read latest file' },
        {
          id: '4',
          role: 'assistant',
          text: 'here is latest file',
          toolCalls: [
            {
              id: 'call_2',
              name: 'read_file',
              args: { path: 'latest.tex' },
              result: smallResult,
            },
          ],
        },
      ]

      const prepared = prepareTranscriptForRun(transcript, 7000)
      const oldAssistant = prepared[1] as any
      const latestAssistant = prepared[3] as any

      expect(oldAssistant.toolCalls[0].result._shrunk).to.be.true
      expect(oldAssistant.toolCalls[0].result.truncated).to.be.true
      expect(latestAssistant.toolCalls[0].result._shrunk).to.be.undefined
      expect(latestAssistant.toolCalls[0].result.content).to.equal(
        smallResult.content
      )
    })

    it('shrinks all assistant turns if older shrinking alone is not enough', function () {
      const largeResult1 = { content: 'a'.repeat(8000) }
      const largeResult2 = { content: 'b'.repeat(8000) }
      const transcript: TranscriptEntry[] = [
        {
          id: '1',
          role: 'assistant',
          text: 'one',
          toolCalls: [
            {
              id: 'c1',
              name: 'read_file',
              args: { path: '1.tex' },
              result: largeResult1,
            },
          ],
        },
        {
          id: '2',
          role: 'assistant',
          text: 'two',
          toolCalls: [
            {
              id: 'c2',
              name: 'read_file',
              args: { path: '2.tex' },
              result: largeResult2,
            },
          ],
        },
      ]

      const prepared = prepareTranscriptForRun(transcript, 9000)
      expect((prepared[0] as any).toolCalls[0].result._shrunk).to.be.true
      expect((prepared[1] as any).toolCalls[0].result._shrunk).to.be.true
    })

    it('drops oldest entries if shrinking all turns still exceeds limit, keeping at least the latest turn', function () {
      const hugeText = 'z'.repeat(5000)
      const transcript: TranscriptEntry[] = [
        { id: '1', role: 'user', text: hugeText },
        { id: '2', role: 'user', text: hugeText },
        { id: '3', role: 'user', text: 'latest prompt' },
      ]

      const prepared = prepareTranscriptForRun(transcript, 6000)
      expect(prepared.length).to.be.lessThan(transcript.length)
      expect(prepared.at(-1)?.id).to.equal('3')
    })
  })

  describe('mergeStoredTranscript', function () {
    const u0: TranscriptEntry = { id: 'u0', role: 'user', text: 'Scan this project' }
    const a1: TranscriptEntry = {
      id: 'a1',
      role: 'assistant',
      text: 'Reading',
      toolCalls: [],
    }
    const a1Done: TranscriptEntry = {
      ...a1,
      text: 'Reading. Done.',
      durationMs: 3000,
    }
    const u2: TranscriptEntry = { id: 'u2', role: 'user', text: 'and the refs' }

    it("never repeats a message the browser's copy already holds", function () {
      // The server holds the reply so far; the browser dropped it to rebuild
      // it from the run. The question is the same message, not a missing one.
      const merged = mergeStoredTranscript([u0], [u0, a1])
      expect(merged.map(e => e.id)).to.deep.equal(['u0', 'a1'])
    })

    it('takes the turns the server has after the ones shown', function () {
      expect(mergeStoredTranscript([u0], [u0, a1Done, u2])).to.deep.equal([
        u0,
        a1Done,
        u2,
      ])
    })

    it('puts back the top turns the browser dropped to fit its storage', function () {
      expect(
        mergeStoredTranscript([a1Done, u2], [u0, a1Done]).map(e => e.id)
      ).to.deep.equal(['u0', 'a1', 'u2'])
    })

    it('keeps a finished reply over a copy saved while it was written', function () {
      expect(mergeStoredTranscript([u0, a1Done], [u0, a1])).to.deep.equal([
        u0,
        a1Done,
      ])
      expect(mergeStoredTranscript([u0, a1], [u0, a1Done])).to.deep.equal([
        u0,
        a1Done,
      ])
    })

    it('returns the same transcript when the server adds nothing', function () {
      const local = [u0, a1Done]
      expect(mergeStoredTranscript(local, [u0, a1Done])).to.equal(local)
      expect(mergeStoredTranscript(local, [])).to.equal(local)
    })

    it('takes the server copy for a chat this browser has none of', function () {
      expect(mergeStoredTranscript([], [u0, a1Done])).to.deep.equal([u0, a1Done])
    })
  })

  it('dropRepeatedEntries keeps distinct entries that share text', function () {
    const transcript: TranscriptEntry[] = [
      { id: 'u0', role: 'user', text: 'again' },
      { id: 'a1', role: 'assistant', text: 'ok', toolCalls: [] },
      { id: 'u2', role: 'user', text: 'again' },
    ]
    expect(dropRepeatedEntries(transcript)).to.deep.equal(transcript)
  })
})
