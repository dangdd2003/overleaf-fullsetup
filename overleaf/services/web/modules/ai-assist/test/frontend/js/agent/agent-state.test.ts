import { expect } from 'chai'
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

  it('records a budget stop so the panel can offer Continue', function () {
    const state = reduceAgentEvent(emptyAgentState([]), {
      type: 'turnFinished',
      reason: 'budget',
    })
    expect(state.running).to.equal(false)
    expect(state.stoppedForBudget).to.equal(true)
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
      pendingApproval: { id: 'call_1', edit: { path: 'main.tex', oldText: 'a', newText: 'b' } },
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

  it('sets running to false and clears pendingApproval when an error event arrives', function () {
    const initialState = {
      ...emptyAgentState([]),
      running: true,
      pendingApproval: { id: 'call_1', edit: { path: 'main.tex', oldText: 'a', newText: 'b' } },
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
})
