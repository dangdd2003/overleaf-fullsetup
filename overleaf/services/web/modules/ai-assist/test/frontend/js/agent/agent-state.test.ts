import { expect } from 'chai'
import sinon from 'sinon'
import {
  reduceAgentEvent,
  emptyAgentState,
} from '../../../../frontend/js/features/ai-assist/agent/agent-state'

describe('reduceAgentEvent', function () {
  it('accumulates streamed text into the open assistant turn', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, { type: 'text', text: 'Hel' })
    state = reduceAgentEvent(state, { type: 'text', text: 'lo' })

    expect(state.transcript.at(-1)).to.deep.include({
      role: 'assistant',
      text: 'Hello',
    })
  })

  it('records a tool call and then its result', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, {
      type: 'toolCallStarted',
      id: 'c1',
      name: 'read_file',
      args: { path: 'main.tex' },
    })
    expect((state.transcript.at(-1) as any).toolCalls[0]).to.not.have.property(
      'result'
    )

    state = reduceAgentEvent(state, {
      type: 'toolCallFinished',
      id: 'c1',
      result: { content: 'x' },
      isError: false,
    })
    expect((state.transcript.at(-1) as any).toolCalls[0].result).to.deep.equal({
      content: 'x',
    })
  })

  it('records chronological blocks for thinking, tool calls, and text', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'query' }])
    state = reduceAgentEvent(state, {
      type: 'thinking',
      text: 'Analyzing the query...',
    })
    state = reduceAgentEvent(state, {
      type: 'toolCallStarted',
      id: 'c1',
      name: 'search_project',
      args: { query: 'LI202121' },
    })
    state = reduceAgentEvent(state, {
      type: 'toolCallFinished',
      id: 'c1',
      result: { hits: ['ref.bib:37'] },
      isError: false,
    })
    state = reduceAgentEvent(state, {
      type: 'text',
      text: 'I found the citation in ref.bib.',
    })

    const last = state.transcript.at(-1) as any
    expect(last.blocks).to.have.length(3)
    expect(last.blocks[0].type).to.equal('thinking')
    expect(last.blocks[0].thinking).to.equal('Analyzing the query...')
    expect(last.blocks[1].type).to.equal('tool_call')
    expect(last.blocks[1].call.id).to.equal('c1')
    expect(last.blocks[1].call.result).to.deep.equal({ hits: ['ref.bib:37'] })
    expect(last.blocks[2].type).to.equal('text')
    expect(last.blocks[2].text).to.equal('I found the citation in ref.bib.')
  })

  it('marks the run as awaiting approval and clears it on the result', function () {
    let state = emptyAgentState([])
    state = reduceAgentEvent(state, {
      type: 'awaitingApproval',
      id: 'c1',
      edit: { path: 'main.tex', oldText: 'a', newText: 'b' },
    })
    expect(state.pendingApproval).to.deep.include({ id: 'c1' })

    state = reduceAgentEvent(state, {
      type: 'toolCallFinished',
      id: 'c1',
      result: { status: 'applied' },
      isError: false,
    })
    expect(state.pendingApproval).to.equal(null)
  })

  it('keeps a provider error on the state', function () {
    const state = reduceAgentEvent(emptyAgentState([]), {
      type: 'error',
      code: 'providerAuth',
      message: 'key rejected',
    })
    expect(state.error).to.deep.include({ code: 'providerAuth' })
  })

  it('records a contextExhausted error on the state', function () {
    const state = reduceAgentEvent(emptyAgentState([]), {
      type: 'error',
      code: 'contextExhausted',
      message:
        'This conversation no longer fits in the model context window. Start a new chat to continue.',
    })
    expect(state.error).to.deep.equal({
      code: 'contextExhausted',
      message:
        'This conversation no longer fits in the model context window. Start a new chat to continue.',
    })
  })

  it('records a user-aborted stop without error', function () {
    const initialState = {
      ...emptyAgentState([]),
      running: true,
      pendingApproval: {
        id: 'call_1',
        kind: 'edit' as const,
        edit: { path: 'main.tex', oldText: 'a', newText: 'b' },
      },
    }
    const state = reduceAgentEvent(initialState, {
      type: 'turnFinished',
      reason: 'aborted',
    })
    expect(state.running).to.equal(false)
    expect(state.stoppedByUser).to.equal(true)
    expect(state.pendingApproval).to.be.null
    expect(state.error).to.be.null
  })

  it('finalizes pending in-flight tool calls when turnFinished aborted arrives', function () {
    let state = emptyAgentState([])
    state = reduceAgentEvent(state, {
      type: 'toolCallStarted',
      id: 'c1',
      name: 'edit_file',
      args: { path: 'main.tex', oldText: 'a', newText: 'b' },
    })
    state = reduceAgentEvent(state, {
      type: 'turnFinished',
      reason: 'aborted',
    })
    const last = state.transcript.at(-1) as any
    expect(last.toolCalls[0].result).to.deep.equal({ status: 'stopped' })
    expect(last.blocks[0].call.result).to.deep.equal({ status: 'stopped' })
  })

  it('finalizes pending in-flight tool calls when an error event arrives', function () {
    let state = emptyAgentState([])
    state = reduceAgentEvent(state, {
      type: 'toolCallStarted',
      id: 'c1',
      name: 'read_file',
      args: { path: 'main.tex' },
    })
    state = reduceAgentEvent(state, {
      type: 'error',
      code: 'providerError',
      message: 'terminated',
    })
    const last = state.transcript.at(-1) as any
    expect(last.toolCalls[0].result).to.deep.equal({ status: 'stopped' })
    expect(last.blocks[0].call.result).to.deep.equal({ status: 'stopped' })
  })

  it('sets running to false and clears pendingApproval when an error event arrives', function () {
    const initialState = {
      ...emptyAgentState([]),
      running: true,
      pendingApproval: {
        id: 'call_1',
        kind: 'edit' as const,
        edit: { path: 'main.tex', oldText: 'a', newText: 'b' },
      },
    }
    const state = reduceAgentEvent(initialState, {
      type: 'error',
      code: 'consecutiveToolFailures',
      message: 'Stopped after 3 consecutive failed tool operations.',
    })
    expect(state.running).to.equal(false)
    expect(state.pendingApproval).to.be.null
    expect(state.error?.code).to.equal('consecutiveToolFailures')
  })

  it('records an interrupted run as terminal with an interrupted error code', function () {
    const initialState = {
      ...emptyAgentState([]),
      running: true,
    }
    const state = reduceAgentEvent(initialState, {
      type: 'turnFinished',
      reason: 'interrupted' as any,
    })
    expect(state.running).to.equal(false)
    expect(state.stoppedByUser).to.equal(false)
    expect(state.error).to.deep.equal({
      code: 'interrupted',
      message: 'This run was interrupted.',
    })
  })

  it('handles modeChanged event', () => {
    const initial = emptyAgentState([])
    expect(initial.mode).to.equal('manual')

    const next = reduceAgentEvent(initial, {
      type: 'modeChanged',
      mode: 'plan',
      source: 'user',
    })
    expect(next.mode).to.equal('plan')
  })

  it('stores settings and plan approvals in pendingApproval', () => {
    const initial = emptyAgentState([])

    const stateWithPlan = reduceAgentEvent(initial, {
      type: 'awaitingApproval',
      id: 'plan_call_1',
      kind: 'plan',
      plan: '# The Plan',
    })
    expect(stateWithPlan.pendingApproval).to.deep.equal({
      id: 'plan_call_1',
      kind: 'plan',
      edit: undefined,
      settings: undefined,
      plan: '# The Plan',
      connector: undefined,
    })

    const stateCleared = reduceAgentEvent(stateWithPlan, {
      type: 'toolCallFinished',
      id: 'plan_call_1',
      result: { status: 'approved' },
      isError: false,
    })
    expect(stateCleared.pendingApproval).to.be.null
  })

  it('clears the pending flag when the run reads a queued message', () => {
    const initial = {
      ...emptyAgentState([
        { id: 'u0', role: 'user', text: 'first' },
        { id: 'q1', role: 'user', text: 'and also this', pending: true },
      ]),
    }

    const next = reduceAgentEvent(initial, {
      type: 'userMessage',
      id: 'q1',
      text: 'and also this',
    })

    expect(next.transcript).to.have.length(2)
    expect(next.transcript[1]).to.deep.equal({
      id: 'q1',
      role: 'user',
      text: 'and also this',
      sentDuringRun: true,
    })
  })

  it('appends a queued message a tab has never seen', () => {
    const initial = emptyAgentState([{ id: 'u0', role: 'user', text: 'first' }])

    const next = reduceAgentEvent(initial, {
      type: 'userMessage',
      id: 'q1',
      text: 'sent from another tab',
    })

    expect(next.transcript).to.have.length(2)
    expect(next.transcript[1]).to.deep.equal({
      id: 'q1',
      role: 'user',
      text: 'sent from another tab',
      sentDuringRun: true,
    })
  })

  it('stores the envelope the run was sent with a message it read mid-run', () => {
    const initial = emptyAgentState([
      { id: 'u0', role: 'user', text: 'first' },
      { id: 'q1', role: 'user', text: 'and this', pending: true },
    ])

    const next = reduceAgentEvent(initial, {
      type: 'userMessage',
      id: 'q1',
      text: 'and this',
      contextText: '<project-context turn="2"/>',
    })

    expect(next.transcript[1]).to.deep.include({
      contextText: '<project-context turn="2"/>',
      sentDuringRun: true,
    })
  })

  it('places a message the run read after those read before it and ahead of those still queued', () => {
    const initial = emptyAgentState([
      { id: 'u0', role: 'user', text: 'first' },
      { id: 'a0', role: 'assistant', text: 'working', toolCalls: [] },
      { id: 'mine', role: 'user', text: 'mine, queued', pending: true },
    ])

    // Another tab's message reached the run first
    const next = reduceAgentEvent(initial, {
      type: 'userMessage',
      id: 'theirs',
      text: 'from the other tab',
    })

    expect(next.transcript.map(entry => entry.id)).to.deep.equal([
      'u0',
      'a0',
      'theirs',
      'mine',
    ])
    expect(next.transcript[3]).to.deep.include({ pending: true })
  })

  it('records which provider request a tool call came from', () => {
    let state = emptyAgentState([{ id: 'u0', role: 'user', text: 'go' }])
    state = reduceAgentEvent(state, {
      type: 'toolCallStarted',
      id: 'c1',
      name: 'read_file',
      args: { path: 'main.tex' },
      step: 2,
    })

    const assistant = state.transcript[1] as any
    expect(assistant.toolCalls[0].step).to.equal(2)
    expect(assistant.blocks[0].call.step).to.equal(2)
  })

  it('updates chatTitle on chatTitle event', () => {
    const initial = emptyAgentState([])
    expect(initial.isTitleGenerated).to.be.false
    const next = reduceAgentEvent(initial, {
      type: 'chatTitle',
      title: 'Smart Generated Title',
    })
    expect(next.chatTitle).to.equal('Smart Generated Title')
    expect(next.isTitleGenerated).to.be.true
  })

  it('keeps active assistant streaming intact when a mid-turn user message is pending', function () {
    let state = emptyAgentState([
      { id: 'u1', role: 'user', text: 'who is nguyen duy ngoc' },
    ])
    // Assistant 1 starts thinking
    state = reduceAgentEvent(state, {
      type: 'thinking',
      text: 'Analyzing first query...',
    })
    // User sends second question mid-run (optimistically appended as pending)
    state = {
      ...state,
      transcript: [
        ...state.transcript,
        {
          id: 'u2',
          role: 'user',
          text: 'who is fan van giang?',
          pending: true,
        },
      ],
    }

    // Assistant 1 continues streaming text for first query
    state = reduceAgentEvent(state, {
      type: 'text',
      text: 'Nguyen Duy Ngoc is a politician.',
    })

    // Expect Assistant 1 to contain its full text and thinking, positioned before the pending User 2
    expect(state.transcript).to.have.length(3)
    expect(state.transcript[0]).to.deep.include({
      id: 'u1',
      role: 'user',
      text: 'who is nguyen duy ngoc',
    })
    const assistant1 = state.transcript[1] as any
    expect(assistant1.role).to.equal('assistant')
    expect(assistant1.text).to.equal('Nguyen Duy Ngoc is a politician.')
    expect(assistant1.thinking).to.equal('Analyzing first query...')
    expect(state.transcript[2]).to.deep.include({
      id: 'u2',
      role: 'user',
      text: 'who is fan van giang?',
      pending: true,
    })

    // Now server processes queued message and emits userMessage event
    state = reduceAgentEvent(state, {
      type: 'userMessage',
      id: 'u2',
      text: 'who is fan van giang?',
    })
    expect(state.transcript[2]).to.deep.equal({
      id: 'u2',
      role: 'user',
      text: 'who is fan van giang?',
      sentDuringRun: true,
    })

    // Assistant 2 starts streaming for second query
    state = reduceAgentEvent(state, {
      type: 'text',
      text: 'Phan Van Giang is a general.',
    })
    expect(state.transcript).to.have.length(4)
    const assistant2 = state.transcript[3] as any
    expect(assistant2.role).to.equal('assistant')
    expect(assistant2.text).to.equal('Phan Van Giang is a general.')
  })

  it('replaces the text of the request still going, keeping its thinking', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, { type: 'text', text: 'Reading. ' })
    state = reduceAgentEvent(state, {
      type: 'toolCallStarted',
      id: 'c1',
      name: 'read_file',
      args: {},
      step: 1,
    })
    state = reduceAgentEvent(state, { type: 'thinking', text: 'hmm' })
    state = reduceAgentEvent(state, { type: 'text', text: 'Half a rep' })
    state = reduceAgentEvent(state, { type: 'stepText', text: '' })
    state = reduceAgentEvent(state, { type: 'text', text: 'Whole.' })

    const entry = state.transcript.at(-1) as any
    expect(entry.text).to.equal('Reading. Whole.')
    expect(entry.blocks.map((b: any) => b.type)).to.deep.equal([
      'text',
      'tool_call',
      'thinking',
      'text',
    ])
    expect(entry.blocks[3].text).to.equal('Whole.')
  })

  it('records where the run asked for its reply, and what it trimmed', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, { type: 'nudge' })
    expect((state.transcript.at(-1) as any).nudge).to.deep.equal({
      after: null,
    })

    state = reduceAgentEvent(state, {
      type: 'toolCallStarted',
      id: 'c1',
      name: 'read_file',
      args: {},
      step: 1,
    })
    state = reduceAgentEvent(state, { type: 'nudge' })
    expect((state.transcript.at(-1) as any).nudge).to.deep.equal({
      after: 'c1',
    })

    const trim = { total: 4, anchor: 'x', dropped: 0, elided: [2] }
    state = reduceAgentEvent(state, { type: 'contextTrimmed', trim })
    expect((state.transcript.at(-1) as any).contextTrim).to.deep.equal(trim)
  })

  it('stores usage and the context breakdown on the live assistant turn', function () {
    const breakdown = {
      systemPrompt: 900,
      projectInstructions: 0,
      connectorInstructions: 0,
      builtinTools: 300,
      webTools: 0,
      connectorTools: 0,
      userMessages: 40,
      projectContext: 0,
      assistantMessages: 0,
      toolResults: 0,
      images: 0,
      elidedMessages: 0,
      droppedMessages: 0,
      contextWindow: 200000,
      maxOutputTokens: 32000,
      budget: 167000,
    }
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1200,
      cacheCreationTokens: 0,
    }
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])

    // The breakdown arrives before the provider answers, so it opens the turn
    state = reduceAgentEvent(state, { type: 'contextBreakdown', breakdown })
    expect(state.transcript.at(-1)).to.deep.include({
      role: 'assistant',
      text: '',
      contextBreakdown: breakdown,
    })

    state = reduceAgentEvent(state, { type: 'usage', usage })
    state = reduceAgentEvent(state, { type: 'text', text: 'Hello' })
    expect(state.transcript.at(-1)).to.deep.include({
      role: 'assistant',
      text: 'Hello',
      usage,
      contextBreakdown: breakdown,
    })
  })

  it('keeps the newest usage and breakdown when a run has several requests', function () {
    const first = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const second = { inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, { type: 'usage', usage: first })
    state = reduceAgentEvent(state, { type: 'usage', usage: second })
    expect((state.transcript.at(-1) as any).usage).to.deep.equal(second)
    expect(state.transcript).to.have.length(2)
  })

  describe('usage paired with its breakdown by step', function () {
    const parts = {
      projectInstructions: 0,
      connectorInstructions: 0,
      builtinTools: 0,
      webTools: 0,
      connectorTools: 0,
      userMessages: 0,
      projectContext: 0,
      assistantMessages: 0,
      toolResults: 0,
      images: 0,
      elidedMessages: 0,
      droppedMessages: 0,
      contextWindow: 200000,
      maxOutputTokens: 32000,
      budget: 167000,
    }
    const at = (step: number, systemPrompt: number, extra = {}) => ({
      ...parts,
      systemPrompt,
      step,
      ...extra,
    })
    const usageAt = (step: number, inputTokens: number) => ({
      inputTokens,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      step,
    })
    const lastEntry = (state: { transcript: unknown[] }) =>
      state.transcript.at(-1) as any

    it('pairs the usage with the breakdown of the same step, in either order', function () {
      let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: at(1, 900),
        step: 1,
      })
      state = reduceAgentEvent(state, {
        type: 'usage',
        usage: usageAt(1, 1000),
        step: 1,
      })
      expect(lastEntry(state).usageBreakdown).to.deep.equal(at(1, 900))
    })

    it('leaves usageBreakdown out when the usage has no breakdown of its step', function () {
      let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: at(2, 900),
        step: 2,
      })
      state = reduceAgentEvent(state, {
        type: 'usage',
        usage: usageAt(1, 1000),
        step: 1,
      })
      expect(lastEntry(state)).to.not.have.property('usageBreakdown')
      expect(lastEntry(state).contextBreakdown).to.deep.equal(at(2, 900))
    })

    it('keeps the paired breakdown while the newer breakdown is for another step', function () {
      let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: at(1, 900),
        step: 1,
      })
      state = reduceAgentEvent(state, {
        type: 'usage',
        usage: usageAt(1, 1000),
        step: 1,
      })
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: at(2, 950),
        step: 2,
      })
      expect(lastEntry(state).usageBreakdown).to.deep.equal(at(1, 900))
      expect(lastEntry(state).contextBreakdown).to.deep.equal(at(2, 950))
    })

    it('replaces the paired breakdown with a later exact count of the same step', function () {
      let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: at(1, 900),
        step: 1,
      })
      state = reduceAgentEvent(state, {
        type: 'usage',
        usage: usageAt(1, 1000),
        step: 1,
      })
      const exact = at(1, 880, { exactFixed: true })
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: exact,
        step: 1,
      })
      expect(lastEntry(state).usageBreakdown).to.deep.equal(exact)
      expect(lastEntry(state).contextBreakdown).to.deep.equal(exact)
    })

    it('keeps an exact count over a later estimate of the same step', function () {
      const exact = at(1, 880, { exactFixed: true })
      let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: exact,
        step: 1,
      })
      state = reduceAgentEvent(state, {
        type: 'usage',
        usage: usageAt(1, 1000),
        step: 1,
      })
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: at(1, 900),
        step: 1,
      })
      expect(lastEntry(state).usageBreakdown).to.deep.equal(exact)
      expect(lastEntry(state).contextBreakdown).to.deep.equal(at(1, 900))
    })

    it('drops the paired breakdown when a newer usage is for another step', function () {
      let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: at(1, 900),
        step: 1,
      })
      state = reduceAgentEvent(state, {
        type: 'usage',
        usage: usageAt(1, 1000),
        step: 1,
      })
      state = reduceAgentEvent(state, {
        type: 'usage',
        usage: usageAt(2, 1200),
        step: 2,
      })
      expect(lastEntry(state)).to.not.have.property('usageBreakdown')
      expect(lastEntry(state).usage.step).to.equal(2)
    })

    it('takes the step from the event when the usage carries none', function () {
      let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
      state = reduceAgentEvent(state, {
        type: 'contextBreakdown',
        breakdown: at(3, 900),
        step: 3,
      })
      state = reduceAgentEvent(state, {
        type: 'usage',
        usage: { ...usageAt(3, 1000), step: undefined },
        step: 3,
      })
      expect(lastEntry(state).usage.step).to.equal(3)
      expect(lastEntry(state).usageBreakdown).to.deep.equal(at(3, 900))
    })
  })
})

describe('reduceAgentEvent: context usage records', function () {
  const lastEntry = (state: { transcript: unknown[] }) =>
    state.transcript.at(-1) as Record<string, any>

  const thresholds = {
    effective: 180000,
    autoCompactAt: 167000,
    warnAt: 160000,
    blockAt: 177000,
  }
  const record = (step: number, tokens: number) => ({
    step,
    tokens,
    anchoredTokens: tokens,
    estimatedTokens: 0,
    exact: true,
    contextWindow: 200000,
    thresholds,
    state: 'ok' as const,
  })

  it('stores the record on the open assistant turn, without its type', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, { type: 'text', text: 'Hello' })
    state = reduceAgentEvent(state, {
      type: 'contextUsage',
      ...record(2, 5000),
    })

    expect(lastEntry(state).contextUsage).to.deep.equal(record(2, 5000))
    expect(lastEntry(state).contextUsage).to.not.have.property('type')
  })

  it('keeps the newest record of the turn', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, { type: 'contextUsage', ...record(1, 1000) })
    state = reduceAgentEvent(state, { type: 'contextUsage', ...record(2, 2000) })

    expect(lastEntry(state).contextUsage?.tokens).to.equal(2000)
  })

  it('clears compacting on a failed automatic compaction and keeps the run going', function () {
    let state = { ...emptyAgentState([{ id: '1', role: 'user', text: 'hi' }]), running: true }
    state = reduceAgentEvent(state, { type: 'compactStarted', trigger: 'auto' })
    state = reduceAgentEvent(state, {
      type: 'compactFailed',
      trigger: 'auto',
      code: 'compactNoProgress',
      message: 'Nothing would shrink',
    })

    expect(state.compacting).to.equal(null)
    expect(state.error).to.equal(null)
    expect(state.running).to.equal(true)
  })
})

describe('reduceAgentEvent: provider retries', function () {
  let clock: sinon.SinonFakeTimers

  beforeEach(function () {
    clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
  })

  afterEach(function () {
    clock.restore()
  })

  const retrying = {
    type: 'retrying' as const,
    attempt: 2,
    maxRetries: 10,
    retryInMs: 7000,
    retryAt: 1_007_000,
    message: 'API overloaded (529)',
    status: 529,
  }

  it('sets the retry with a deadline counted from receipt', function () {
    const state = reduceAgentEvent(emptyAgentState(), retrying)

    expect(state.retrying).to.deep.equal({
      attempt: 2,
      maxRetries: 10,
      deadline: 1_007_000,
      message: 'API overloaded (529)',
      status: 529,
    })
  })

  it('replaces an earlier retry with the newer one', function () {
    let state = reduceAgentEvent(emptyAgentState(), retrying)
    state = reduceAgentEvent(state, { ...retrying, attempt: 3, retryInMs: 1000 })

    expect(state.retrying?.attempt).to.equal(3)
    expect(state.retrying?.deadline).to.equal(1_001_000)
  })

  it('clears on output, a tool call and a compaction step', function () {
    const events: any[] = [
      { type: 'text', text: 'Hi' },
      { type: 'thinking', text: 'hmm' },
      { type: 'stepText', text: 'Hi' },
      { type: 'toolCallStarted', id: 'c1', name: 'read_file', args: {} },
      { type: 'compactProgress', phase: 'summarizing' },
      { type: 'compactFinished', entry: { id: 'k1' } as any },
    ]
    for (const event of events) {
      let state = reduceAgentEvent(emptyAgentState(), retrying)
      state = reduceAgentEvent(state, event)
      expect(state.retrying, event.type).to.equal(null)
    }
  })

  it('keeps the retry through an empty step, the request starting over', function () {
    let state = reduceAgentEvent(emptyAgentState(), retrying)
    state = reduceAgentEvent(state, { type: 'stepText', text: '' })

    expect(state.retrying).to.not.equal(null)
  })

  it('clears when the run ends or fails', function () {
    const ended: any[] = [
      { type: 'turnFinished', reason: 'stop' },
      { type: 'error', code: 'providerError', message: 'boom' },
    ]
    for (const event of ended) {
      let state = reduceAgentEvent(emptyAgentState(), retrying)
      state = reduceAgentEvent(state, event)
      expect(state.retrying, event.type).to.equal(null)
    }
  })
})
