import { expect } from 'chai'
import { runAgent } from '../../../../frontend/js/features/ai-assist/agent/run-agent'
import { AgentEvent } from '../../../../frontend/js/features/ai-assist/agent/agent-events'
import { AgentTool } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { ProviderError } from '../../../../frontend/js/features/ai-assist/providers/types'
import { createFakeHandle } from './helpers/fake-handle'

/** A provider client that replays a scripted list of turns. */
function fakeClient(turns: any[]) {
  const requests: any[] = []
  let turn = 0

  const turnsList =
    turns.length > 0 && !Array.isArray(turns[0]) ? [turns] : turns

  const client = {
    requests,
    async *streamChat(request: any) {
      requests.push({ ...request, messages: [...request.messages] })
      const chunks = turnsList[turn++] ?? [{ type: 'done', stopReason: 'stop' }]
      for (const chunk of chunks) yield chunk
    },
    async listModels() {
      return []
    },
  }

  return Object.assign(client, { client, requests })
}

const echoTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: {} },
  },
  async execute(args) {
    return { echoed: args }
  },
}

const throwingTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'boom',
    description: 'boom',
    parameters: { type: 'object', properties: {} },
  },
  async execute() {
    throw new Error('tool exploded')
  },
}

async function collect(generator: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = []
  for await (const event of generator) events.push(event)
  return events
}

describe('runAgent', function () {
  describe('requireTool', function () {
    it('asks once for the required tool when the model ends on prose', async function () {
      const { client, requests } = fakeClient([
        [
          { type: 'text', text: 'The package is missing.' },
          { type: 'done', stopReason: 'stop' },
        ],
        [
          { type: 'tool_call', id: 'c1', name: 'echo', args: {} },
          { type: 'done', stopReason: 'tool_calls' },
        ],
        [
          { type: 'text', text: 'Added it.' },
          { type: 'done', stopReason: 'stop' },
        ],
      ])
      const { handle } = createFakeHandle()

      const events = await collect(
        runAgent({
          client,
          handle,
          tools: { echo: echoTool },
          transcript: [{ id: '1', role: 'user', text: 'fix' }],
          requireTool: 'echo',
        })
      )

      expect(requests).to.have.length(3)
      const nudge: any = requests[1].messages.at(-1)
      expect(nudge.role).to.equal('user')
      expect(nudge.content).to.contain('echo')
      expect(events.filter(e => e.type === 'toolCallStarted')).to.have.length(1)
      expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
    })

    it('nudges only once, then lets the run finish', async function () {
      const { client, requests } = fakeClient([
        [
          { type: 'text', text: 'Explained.' },
          { type: 'done', stopReason: 'stop' },
        ],
        [
          { type: 'text', text: 'Explained again.' },
          { type: 'done', stopReason: 'stop' },
        ],
      ])
      const { handle } = createFakeHandle()

      const events = await collect(
        runAgent({
          client,
          handle,
          tools: { echo: echoTool },
          transcript: [{ id: '1', role: 'user', text: 'fix' }],
          requireTool: 'echo',
        })
      )

      expect(requests).to.have.length(2)
      expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
    })

    it('does not nudge once the required tool was called', async function () {
      const { client, requests } = fakeClient([
        [
          { type: 'tool_call', id: 'c1', name: 'echo', args: {} },
          { type: 'done', stopReason: 'tool_calls' },
        ],
        [
          { type: 'text', text: 'Done.' },
          { type: 'done', stopReason: 'stop' },
        ],
      ])
      const { handle } = createFakeHandle()

      await collect(
        runAgent({
          client,
          handle,
          tools: { echo: echoTool },
          transcript: [{ id: '1', role: 'user', text: 'fix' }],
          requireTool: 'echo',
        })
      )

      expect(requests).to.have.length(2)
    })
  })

  it('streams a text-only turn and finishes', async function () {
    const { client } = fakeClient([
      [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'there' },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'hi' }],
      })
    )

    expect(
      events
        .filter(e => e.type === 'text')
        .map((e: any) => e.text)
        .join('')
    ).to.equal('Hello there')
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('executes a tool call and feeds the result into the next turn', async function () {
    const { client, requests } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'echo', args: { a: 1 } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(events.filter(e => e.type === 'toolCallStarted')).to.have.length(1)
    const finished: any = events.find(e => e.type === 'toolCallFinished')
    expect(finished.result).to.deep.equal({ echoed: { a: 1 } })
    expect(finished.isError).to.equal(false)

    const toolMessage: any = requests[1].messages.at(-1)
    expect(toolMessage.role).to.equal('tool')
    expect(toolMessage.toolCallId).to.equal('c1')
  })

  it('runs several tool calls from one turn in order', async function () {
    const { client } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'echo', args: { n: 1 } },
        { type: 'tool_call', id: 'c2', name: 'echo', args: { n: 2 } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(
      events.filter(e => e.type === 'toolCallFinished').map((e: any) => e.id)
    ).to.deep.equal(['c1', 'c2'])
  })

  it('turns a thrown tool into an error result instead of ending the run', async function () {
    const { client } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'boom', args: {} },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        { type: 'text', text: 'recovered' },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { boom: throwingTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const finished: any = events.find(e => e.type === 'toolCallFinished')
    expect(finished.isError).to.equal(true)
    expect(JSON.stringify(finished.result)).to.match(/tool exploded/)
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('emits an unknown-tool error result when the model invents a name', async function () {
    const { client } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'not_a_tool', args: {} },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const finished: any = events.find(e => e.type === 'toolCallFinished')
    expect(finished.isError).to.equal(true)
    expect(JSON.stringify(finished.result)).to.match(/unknown tool/i)
  })

  it('runs an unlimited number of tool calls', async function () {
    const looping = Array.from({ length: 35 }, () => [
      { type: 'tool_call', id: 'c', name: 'echo', args: {} },
      { type: 'done', stopReason: 'tool_calls' },
    ])
    looping.push([
      { type: 'text', text: 'all done' },
      { type: 'done', stopReason: 'stop' },
    ])
    const { client, requests } = fakeClient(looping)
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(events.filter(e => e.type === 'toolCallStarted')).to.have.length(35)
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
    expect(requests).to.have.length(36)
  })

  it('emits awaitingApproval before a suspending tool runs', async function () {
    const editTool: AgentTool = {
      suspends: true,
      mutates: true,
      spec: {
        name: 'edit_file',
        description: 'edit',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        return { status: 'applied' }
      },
    }

    const { client } = fakeClient([
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { edit_file: editTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const approval: any = events.find(e => e.type === 'awaitingApproval')
    expect(approval.edit).to.deep.equal({
      path: 'main.tex',
      oldText: 'a',
      newText: 'b',
    })
    expect(events.indexOf(approval)).to.be.lessThan(
      events.findIndex(e => e.type === 'toolCallFinished')
    )
  })

  it('blocks a second suspending edit until the first one is decided, never batch-approving', async function () {
    // Models can return several edit_file calls in one turn (as happened in
    // practice — 8 edits from a single response). Each one must independently
    // await a human decision: the second call must not even *start* until the
    // first's approval promise resolves, let alone auto-complete alongside it.
    const resolvers: Array<(v: { status: string }) => void> = []
    const started: string[] = []
    const finished: string[] = []

    const editTool: AgentTool = {
      suspends: true,
      mutates: true,
      spec: {
        name: 'edit_file',
        description: 'edit',
        parameters: { type: 'object', properties: {} },
      },
      async execute(args: any) {
        started.push(args.oldText)
        const result = await new Promise<{ status: string }>(resolve => {
          resolvers.push(resolve)
        })
        finished.push(args.oldText)
        return result
      },
    }

    const { client } = fakeClient([
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'first', newText: 'FIRST' },
        },
        {
          type: 'tool_call',
          id: 'c2',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'second', newText: 'SECOND' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ])
    const { handle } = createFakeHandle()

    const generator = runAgent({
      client,
      handle,
      tools: { edit_file: editTool },
      transcript: [{ id: '1', role: 'user', text: 'go' }],
    })

    const events: AgentEvent[] = []
    const drain = (async () => {
      for await (const event of generator) events.push(event)
    })()

    // Give the run a moment to reach the first edit's suspend point.
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(started).to.deep.equal(['first'])
    expect(
      events.filter(e => e.type === 'awaitingApproval')
    ).to.have.length(1)
    expect(resolvers).to.have.length(1)

    // Resolving the first decision must not touch the second at all.
    resolvers[0]({ status: 'applied' })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(finished).to.deep.equal(['first'])
    expect(started).to.deep.equal(['first', 'second'])
    expect(resolvers).to.have.length(2)
    // The second edit is now suspended awaiting its own decision — it must
    // not have finished on its own.
    expect(finished).to.not.include('second')

    resolvers[1]({ status: 'applied' })
    await drain

    expect(finished).to.deep.equal(['first', 'second'])
    expect(
      events.filter(e => e.type === 'awaitingApproval')
    ).to.have.length(2)
  })

  it('reports a provider failure as an error event and stops', async function () {
    const client = {
      // Yields nothing on purpose: a rejected key throws before the stream
      // produces anything.
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new ProviderError('providerAuth', 'key rejected', 401)
      },
      async listModels() {
        return []
      },
    }
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client: client as any,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(events[0]).to.deep.include({ type: 'error', code: 'providerAuth' })
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('finishes with reason aborted when the signal fires', async function () {
    const controller = new AbortController()
    const client = {
      async *streamChat() {
        controller.abort()
        yield { type: 'text', text: 'partial' }
        throw new ProviderError('aborted', 'Cancelled')
      },
      async listModels() {
        return []
      },
    }
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client: client as any,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'go' }],
        signal: controller.signal,
      })
    )

    expect(events.some(e => e.type === 'text')).to.equal(true)
    expect(events.at(-1)).to.deep.equal({
      type: 'turnFinished',
      reason: 'aborted',
    })
  })

  it('sends the frozen envelope rather than rebuilding a system prompt', async function () {
    const client = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [
          {
            id: 'u1',
            role: 'user',
            text: 'hi',
            contextText: '<project-context turn="1"></project-context>',
          },
        ],
        limits: { contextWindow: 128000, maxOutputTokens: 8192 },
      })
    )

    const request = client.requests[0]
    expect(request.system).to.include('You are an AI assistant embedded in the Overleaf')
    expect(request.system).to.not.include('<project-context turn=')
    expect(request.system).to.not.include('main.tex')
    expect(request.messages[0].content).to.include('<project-context turn="1">')
  })

  it('passes cache hints through to the provider', async function () {
    const client = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: 'u1', role: 'user', text: 'hi' }],
        limits: { contextWindow: 128000, maxOutputTokens: 8192 },
        cacheKey: 'project-abc',
      })
    )

    expect(client.requests[0].cacheHints?.cacheSystem).to.equal(true)
    expect(client.requests[0].cacheHints?.cacheKey).to.equal('project-abc')
  })

  it('uses the caller-supplied output cap', async function () {
    const client = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: 'u1', role: 'user', text: 'hi' }],
        limits: { contextWindow: 32000, maxOutputTokens: 2048 },
      })
    )

    expect(client.requests[0].maxTokens).to.equal(2048)
  })

  it('stops with contextExhausted instead of sending a doomed request', async function () {
    const client = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [
          { id: 'u1', role: 'user', text: 'x'.repeat(200000) },
        ],
        limits: { contextWindow: 1000, maxOutputTokens: 500 },
      })
    )

    expect(events.some(event => event.type === 'error' && event.code === 'contextExhausted')).to.equal(true)
    expect(client.requests).to.have.length(0)
  })

  it('retains the frozen envelope when files are mutated between turns', async function () {
    const docs: Record<string, string> = { 'main.tex': 'hello' }
    const { handle } = createFakeHandle({ docs })
    const client = fakeClient([
      [{ type: 'text', text: 'reply 1' }, { type: 'done', stopReason: 'stop' }],
      [{ type: 'text', text: 'reply 2' }, { type: 'done', stopReason: 'stop' }],
    ])

    const turn1Context = '<project-context turn="1">\n<file path="main.tex" lines="1">\n</project-context>'
    const transcript: any[] = [
      {
        id: 'u1',
        role: 'user',
        text: 'hello',
        contextText: turn1Context,
      },
    ]

    // Turn 1
    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript,
        limits: { contextWindow: 128000, maxOutputTokens: 8192 },
      })
    )

    const turn1ContentBeforeMutation = client.requests[0].messages[0].content
    expect(turn1ContentBeforeMutation).to.equal(`${turn1Context}\n\nhello`)

    // Mutate the handle's files between turns
    docs['new-chapter.tex'] = '\\chapter{New}'
    docs['extra.tex'] = 'more files'

    // Turn 2
    transcript.push(
      {
        id: 'a1',
        role: 'assistant',
        text: 'reply 1',
        toolCalls: [],
      },
      {
        id: 'u2',
        role: 'user',
        text: 'second message',
        contextText: '<project-context turn="2">\n<file path="new-chapter.tex" lines="1">\n</project-context>',
      }
    )

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript,
        limits: { contextWindow: 128000, maxOutputTokens: 8192 },
      })
    )

    expect(client.requests).to.have.length(2)
    const turn1ContentAfterMutation = client.requests[1].messages[0].content
    // Byte-identical to turn 1 content before mutation
    expect(turn1ContentAfterMutation).to.equal(turn1ContentBeforeMutation)
    expect(turn1ContentAfterMutation).to.not.include('new-chapter.tex')
    expect(turn1ContentAfterMutation).to.not.include('extra.tex')
  })

  it('stops with runawayToolLoop when identical failing tool call repeats', async function () {
    const failingEditTool: AgentTool = {
      suspends: false,
      mutates: false,
      spec: {
        name: 'edit_file',
        description: 'edit',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        return { status: 'noMatch', message: 'That text did not appear' }
      },
    }

    const turns = [
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool_call',
          id: 'c2',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool_call',
          id: 'c3',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
    ]

    const { client, requests } = fakeClient(turns)
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { edit_file: failingEditTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const runawayError: any = events.find(
      e => e.type === 'error' && (e as any).code === 'runawayToolLoop'
    )
    expect(runawayError).to.not.be.undefined
    expect(runawayError.message).to.match(/repeated failing call/i)
    // The second identical failure carried a warning; the third stopped the run.
    expect(requests).to.have.length(3)
    expect(requests[2].messages.at(-1).content).to.include('failed 2 times')
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('stops with consecutiveToolFailures after 4 turns in which every call failed', async function () {
    let callCount = 0
    const failingEditTool: AgentTool = {
      suspends: false,
      mutates: false,
      spec: {
        name: 'edit_file',
        description: 'edit',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        callCount++
        return { status: 'noMatch', message: `fail ${callCount}` }
      },
    }

    const turns = [
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing1', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool_call',
          id: 'c2',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing2', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool_call',
          id: 'c3',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing3', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool_call',
          id: 'c4',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing4', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
    ]

    const { client } = fakeClient(turns)
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { edit_file: failingEditTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const consecutiveError: any = events.find(
      e => e.type === 'error' && (e as any).code === 'consecutiveToolFailures'
    )
    expect(consecutiveError).to.not.be.undefined
    expect(consecutiveError.message).to.match(/4 turns in a row/i)
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('continues turn when user rejects an edit and delivers rejection to model to act on', async function () {
    const rejectingEditTool: AgentTool = {
      suspends: true,
      mutates: true,
      spec: {
        name: 'edit_file',
        description: 'edit',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        return {
          status: 'rejected',
          note: 'keep the original table format',
          message:
            'The user rejected this change with note: "keep the original table format". Acknowledge the rejection and propose an alternative approach.',
        }
      },
    }

    const turns = [
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'table', newText: 'new table' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        {
          type: 'text',
          text: 'I understand you prefer keeping the original table format. Would you like me to add it in an appendix instead?',
        },
        { type: 'done', stopReason: 'stop' },
      ],
    ]

    const { client } = fakeClient(turns)
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { edit_file: rejectingEditTool },
        transcript: [{ id: '1', role: 'user', text: 'make a table' }],
      })
    )

    const finished: any = events.find(e => e.type === 'toolCallFinished')
    expect(finished).to.exist
    expect(finished.result.status).to.equal('rejected')
    expect(finished.result.note).to.equal('keep the original table format')

    // Model was given the tool result and produced its response
    const textEvent: any = events.find(e => e.type === 'text')
    expect(textEvent.text).to.include('original table format')
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('re-checks the context budget before every request, not only the first', async function () {
    const bigTool: AgentTool = {
      suspends: false,
      mutates: false,
      spec: { name: 'big', description: 'big', parameters: { type: 'object', properties: {} } },
      async execute() {
        return { text: 'x'.repeat(40000) }
      },
    }
    const { client, requests } = fakeClient([
      [{ type: 'tool_call', id: 'c1', name: 'big', args: {} }],
      [{ type: 'text', text: 'never sent' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { big: bigTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
        limits: { contextWindow: 8000, maxOutputTokens: 1000 },
      })
    )

    expect(requests).to.have.length(1)
    expect(events.some(e => e.type === 'error' && (e as any).code === 'contextExhausted')).to.equal(true)
  })

  it('stops an alternating loop whose calls repeat exactly', async function () {
    const turns = Array.from({ length: 6 }, (_, i) => [
      { type: 'tool_call', id: `c${i}`, name: 'echo', args: { n: i % 2 } },
    ])
    const { client, requests } = fakeClient(turns)
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const error: any = events.find(e => e.type === 'error')
    expect(error.code).to.equal('runawayToolLoop')
    expect(error.message).to.match(/alternating/)
    expect(requests).to.have.length(4)
  })

  it('never runs an edit that was cut off at the output limit', async function () {
    let executed = false
    const editTool: AgentTool = {
      suspends: false,
      mutates: true,
      spec: { name: 'edit_file', description: 'edit', parameters: { type: 'object', properties: {} } },
      async execute() {
        executed = true
        return { status: 'applied' }
      },
    }
    const { client, requests } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'edit_file', args: { path: 'main.tex', newText: 'half', _repaired: true } },
        { type: 'stop', reason: 'max_tokens' },
      ],
      [{ type: 'text', text: 'ok' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { edit_file: editTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
        limits: { contextWindow: 128000, maxOutputTokens: 4096 },
      })
    )

    expect(executed).to.equal(false)
    expect(events.some(e => e.type === 'awaitingApproval')).to.equal(false)
    const assistant = requests[1].messages.find((m: any) => m.role === 'assistant')
    expect(assistant.toolCalls[0].args).to.deep.equal({ path: 'main.tex' })
    const tool = requests[1].messages.find((m: any) => m.role === 'tool')
    expect(tool.content).to.include('cut off at the 4096-token output limit')
  })

  it('reports a text reply cut off at the output limit', async function () {
    const { client } = fakeClient([
      [
        { type: 'text', text: 'A long answer that' },
        { type: 'stop', reason: 'max_tokens' },
      ],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(events.some(e => e.type === 'error' && (e as any).code === 'outputTruncated')).to.equal(true)
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('sends the context window with every request', async function () {
    const { client, requests } = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle()

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'hi' }],
        limits: { contextWindow: 32000, maxOutputTokens: 2048 },
      })
    )

    expect(requests[0].contextWindow).to.equal(32000)
  })
})
