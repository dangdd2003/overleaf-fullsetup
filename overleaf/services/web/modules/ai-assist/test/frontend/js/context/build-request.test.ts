import { expect } from 'chai'
import { buildRequest } from '../../../../frontend/js/features/ai-assist/agent/context/build-request'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'
import type { TranscriptEntry } from '../../../../frontend/js/features/ai-assist/agent/agent-messages'

const limits = { contextWindow: 128000, maxOutputTokens: 8192 }

const turnOne: TranscriptEntry[] = [
  {
    id: 'u1',
    role: 'user',
    text: 'why does this not build?',
    contextText: '<project-context turn="1">\n<files>main.tex</files>\n</project-context>',
  },
]

const turnTwo: TranscriptEntry[] = [
  ...turnOne,
  {
    id: 'a1',
    role: 'assistant',
    text: 'Let me look.',
    toolCalls: [
      { id: 'c1', name: 'read_file', args: { path: 'main.tex' }, result: { content: '1: hi' } },
    ],
  },
  {
    id: 'u2',
    role: 'user',
    text: 'and now?',
    contextText: '<project-context turn="2">\n<files>unchanged since turn 1</files>\n</project-context>',
  },
]

describe('buildRequest', function () {
  it('uses the constant system prompt verbatim', function () {
    const { system } = buildRequest({ transcript: turnOne, limits })
    expect(system).to.equal(SYSTEM_PROMPT)
  })

  it('prefixes the frozen envelope onto the user message', function () {
    const { messages } = buildRequest({ transcript: turnOne, limits })
    expect(messages[0].role).to.equal('user')
    expect(messages[0].content).to.equal(
      '<project-context turn="1">\n<files>main.tex</files>\n</project-context>\n\nwhy does this not build?'
    )
  })

  it('sends the user text alone when an entry has no envelope', function () {
    const bare: TranscriptEntry[] = [{ id: 'u1', role: 'user', text: 'hello' }]
    const { messages } = buildRequest({ transcript: bare, limits })
    expect(messages[0].content).to.equal('hello')
  })

  // The regression test that protects the entire caching design.
  //
  // It does NOT subsume 'prefixes the frozen envelope onto the user message'
  // above. This one compares two calls to each other, so a change that is
  // wrong but consistent — swapping the concatenation to `text\n\ncontextText`,
  // say — moves both turns the same way and leaves it green. Only the
  // exact-content spec pins which bytes. Do not delete that one believing
  // this one covers it.
  it('builds turn 2 as a byte-exact extension of turn 1', function () {
    const first = buildRequest({ transcript: turnOne, limits })
    const second = buildRequest({ transcript: turnTwo, limits })

    expect(second.system).to.equal(first.system)
    const prefix = second.messages.slice(0, first.messages.length)
    expect(JSON.stringify(prefix)).to.equal(JSON.stringify(first.messages))
  })

  it('replays tool calls and their results in order', function () {
    const { messages } = buildRequest({ transcript: turnTwo, limits })
    const roles = messages.map(message => message.role)
    expect(roles).to.deep.equal(['user', 'assistant', 'tool', 'user'])
  })

  it('marks the system prompt and tools as cacheable', function () {
    const { cacheHints } = buildRequest({ transcript: turnTwo, limits })
    expect(cacheHints.cacheSystem).to.equal(true)
    expect(cacheHints.cacheTools).to.equal(true)
  })

  it('places the stable breakpoint just before the newest user turn', function () {
    const { messages, cacheHints } = buildRequest({ transcript: turnTwo, limits })
    expect(cacheHints.lastStableMessage).to.equal(messages.length - 2)
  })

  it('has no stable breakpoint on the very first turn', function () {
    const { cacheHints } = buildRequest({ transcript: turnOne, limits })
    expect(cacheHints.lastStableMessage).to.equal(null)
  })

  it('passes a cache key through when given one', function () {
    const { cacheHints } = buildRequest({
      transcript: turnOne,
      limits,
      cacheKey: 'project-abc',
    })
    expect(cacheHints.cacheKey).to.equal('project-abc')
  })

  it('reports exhaustion from the budget pass', function () {
    const { exhausted } = buildRequest({
      transcript: turnTwo,
      limits: { contextWindow: 100, maxOutputTokens: 50 },
    })
    expect(exhausted).to.equal(true)
  })

  // A window whose output cap plus safety margin already consumes the whole
  // window is a misconfigured model, not an overlong chat. Only this layer
  // sees the budget pass's verdict, so if it does not forward the reason, no
  // UI can ever tell the user which of the two happened.
  it('forwards the misconfigured-budget reason rather than reporting a long chat', function () {
    const { exhausted, reason } = buildRequest({
      transcript: turnTwo,
      limits: { contextWindow: 100, maxOutputTokens: 95 },
    })
    expect(exhausted).to.equal(true)
    expect(reason).to.equal('budget-non-positive')
  })

  it('leaves the reason unset when the conversation merely grew too long', function () {
    const { exhausted, reason } = buildRequest({
      transcript: turnTwo,
      limits: { contextWindow: 100, maxOutputTokens: 50 },
    })
    expect(exhausted).to.equal(true)
    expect(reason).to.equal(undefined)
  })

  // Assembly only: the transcript's own invariant is that a conversation
  // opens with a user turn, so buildRequest neither synthesises one nor
  // rejects a transcript missing it. These two pin that contract so a future
  // guard is a deliberate change rather than an accident.
  it('assembles an empty request from an empty transcript', function () {
    const { messages, cacheHints, exhausted } = buildRequest({
      transcript: [],
      limits,
    })
    expect(messages).to.deep.equal([])
    expect(cacheHints.lastStableMessage).to.equal(null)
    expect(exhausted).to.equal(false)
  })

  it('does not invent a user turn in front of an assistant-first transcript', function () {
    const { messages, cacheHints } = buildRequest({
      transcript: [{ id: 'a1', role: 'assistant', text: 'unprompted', toolCalls: [] }],
      limits,
    })
    expect(messages.map(message => message.role)).to.deep.equal(['assistant'])
    expect(cacheHints.lastStableMessage).to.equal(null)
  })

  // The breakpoint is "everything except the final message", not "one before
  // the newest user turn". After a completed turn the last message is a tool
  // result, and anchoring on the user turn would push indices 3-5 of this
  // six-message transcript out of the cached prefix and re-send a whole turn
  // as fresh input on every regenerate or loop resume.
  it('caches the prefix of a transcript that does not end on a user turn', function () {
    const { messages, cacheHints } = buildRequest({
      transcript: [
        ...turnTwo,
        {
          id: 'a2',
          role: 'assistant',
          text: 'Found it.',
          toolCalls: [
            { id: 'c2', name: 'read_file', args: { path: 'main.tex' }, result: { content: '1: hi' } },
          ],
        },
      ],
      limits,
    })
    expect(messages).to.have.length(6)
    expect(messages.at(-1)?.role).to.equal('tool')
    expect(cacheHints.lastStableMessage).to.equal(4)
  })
})
