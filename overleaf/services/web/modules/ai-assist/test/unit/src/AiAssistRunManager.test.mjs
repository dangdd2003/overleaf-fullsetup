import { expect } from 'chai'
import sinon from 'sinon'
import {
  AiAssistRunManager,
  TRIM_TARGET_FRACTION,
  applyContextBudget,
  estimateMessagesTokens,
  extractTextToolCall,
} from '../../../app/src/AiAssistRunManager.mjs'

describe('AiAssistRunManager', function () {
  let manager
  let mockStore
  let mockTools
  let mockClient

  beforeEach(function () {
    mockStore = {
      createRun: sinon.stub().resolves(),
      appendEvent: sinon.stub().resolves(1),
      updateStatus: sinon.stub().resolves(),
      setPendingApproval: sinon.stub().resolves(),
      clearPendingApproval: sinon.stub().resolves(),
      getPendingApproval: sinon.stub().resolves({ id: 'c1', edit: { path: 'a.tex' } }),
      getRun: sinon.stub().resolves({ status: 'running' }),
      touchHeartbeat: sinon.stub().resolves(),
    }

    mockTools = {
      execute: sinon.stub().resolves({ content: 'file content' }),
    }

    mockClient = {
      streamChat: sinon.stub(),
    }

    manager = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
    })
  })

  it('sends tool results back to the provider with the tool name and error flag', async function () {
    let secondRequest = null
    let callCount = 0
    mockClient.streamChat.callsFake(async function* (opts) {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'missing.tex' } }
      } else {
        secondRequest = opts
        yield { type: 'text', text: 'done' }
      }
    })
    mockTools.execute.resolves({ error: 'File not found: missing.tex' })

    await manager.startRun({
      runId: 'run-tool-msg',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'read it' }],
      providerSettings: { type: 'google', apiKey: 'k', model: 'gemini-2.5-pro' },
    })

    const toolMessage = secondRequest.messages.find(m => m.role === 'tool')
    expect(toolMessage).to.include({ toolCallId: 'r1', name: 'read_file', isError: true })
  })

  it('does not stop an edit-compile style loop whose calls change between rounds', async function () {
    const script = [
      { name: 'read_file', args: { path: 'main.tex', from: 1, to: 40 } },
      { name: 'compile_project', args: {} },
      { name: 'read_file', args: { path: 'main.tex', from: 41, to: 80 } },
      { name: 'compile_project', args: {} },
    ]
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      const step = script[callCount]
      callCount++
      if (step) {
        yield { type: 'tool_call', id: `c${callCount}`, ...step }
      } else {
        yield { type: 'text', text: 'All fixed.' }
      }
    })

    await manager.startRun({
      runId: 'run-progress',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'fix the build' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    const loopErrors = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[1]?.code === 'runawayToolLoop')
    expect(loopErrors).to.have.lengthOf(0)
    expect(mockStore.appendEvent.calledWith('run-progress', sinon.match({ type: 'text', text: 'All fixed.' }))).to.be.true
  })

  it('stops an alternating loop whose calls repeat exactly', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      const name = callCount % 2 === 1 ? 'compile_project' : 'get_compile_result'
      yield { type: 'tool_call', id: `c${callCount}`, name, args: {} }
    })

    await manager.startRun({
      runId: 'run-spin',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'check the build' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    expect(mockStore.appendEvent.calledWith('run-spin', sinon.match({ type: 'error', code: 'runawayToolLoop' }))).to.be.true
    expect(callCount).to.equal(4)
  })

  it('runs an agent turn yielding text and finishing cleanly', async function () {
    mockClient.streamChat.callsFake(async function* () {
      yield { type: 'thinking', text: 'pondering' }
      yield { type: 'text', text: 'Hello from server' }
    })

    const runPromise = manager.startRun({
      runId: 'run-1',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'hi' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await runPromise

    expect(mockStore.appendEvent.calledWith('run-1', sinon.match({ type: 'thinking', text: 'pondering' }))).to.be.true
    expect(mockStore.appendEvent.calledWith('run-1', sinon.match({ type: 'text', text: 'Hello from server' }))).to.be.true
    expect(mockStore.appendEvent.calledWith('run-1', sinon.match({ type: 'turnFinished', reason: 'stop' }))).to.be.true
    expect(mockStore.updateStatus.calledWith('run-1', 'done')).to.be.true
  })

  it('suspends on edit_file and resumes when approveEdit is called', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'edit-1', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'b' } }
      } else {
        yield { type: 'text', text: 'Edit completed.' }
      }
    })

    const runPromise = manager.startRun({
      runId: 'run-2',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'edit' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    // Allow loop to reach awaitingApproval
    await new Promise(r => setTimeout(r, 10))
    expect(mockStore.setPendingApproval.calledOnce).to.be.true

    // Resume approval
    await manager.approveEdit('run-2', { accepted: true })
    await runPromise

    expect(mockTools.execute.calledWith('edit_file')).to.be.true
    expect(mockStore.appendEvent.calledWith('run-2', sinon.match({ type: 'toolCallFinished', id: 'edit-1', name: 'edit_file' }))).to.be.true
  })

  describe('compile_project with an editor watching', function () {
    function scriptCompile() {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* () {
        callCount++
        if (callCount === 1) {
          yield { type: 'tool_call', id: 'comp-1', name: 'compile_project', args: { clean: true } }
        } else {
          yield { type: 'text', text: 'done' }
        }
      })
      mockTools.execute.callsFake(async (name, args, context) => ({
        outcome: await context.compileInEditor({ id: context.callId, clean: args.clean }),
      }))
    }

    it('asks the editor to compile and resumes with its outcome', async function () {
      mockStore.getWatcherCount = sinon.stub().resolves(1)
      scriptCompile()

      const runPromise = manager.startRun({
        runId: 'run-compile',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'compile' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      await new Promise(r => setTimeout(r, 10))
      expect(mockStore.appendEvent.calledWith('run-compile', { type: 'awaitingCompile', id: 'comp-1', clean: true })).to.be.true

      await manager.submitCompileResult('run-compile', { id: 'stale', outcome: { status: 'success' } })
      await manager.submitCompileResult('run-compile', {
        id: 'comp-1',
        outcome: { status: 'failure', errors: [{ file: 'main.tex', line: 2, message: 'Bad', extra: 'x' }] },
      })
      await runPromise

      expect(mockStore.appendEvent.calledWith('run-compile', sinon.match({
        type: 'toolCallFinished',
        id: 'comp-1',
        result: {
          outcome: {
            status: 'failure',
            errors: [{ file: 'main.tex', line: 2, message: 'Bad' }],
            warnings: [],
            rawLog: '',
          },
        },
      }))).to.be.true
    })

    it('leaves the compile to the server when nobody is watching', async function () {
      mockStore.getWatcherCount = sinon.stub().resolves(0)
      scriptCompile()

      await manager.startRun({
        runId: 'run-compile-headless',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'compile' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(mockStore.appendEvent.calledWith('run-compile-headless', sinon.match({ type: 'awaitingCompile' }))).to.be.false
      expect(mockStore.appendEvent.calledWith('run-compile-headless', sinon.match({
        type: 'toolCallFinished',
        result: { outcome: null },
      }))).to.be.true
    })
  })

  it('emits toolCallFinished with call id and name on non-edit tool', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'read-1', name: 'read_file', args: { path: 'main.tex' } }
      } else {
        yield { type: 'text', text: 'File read.' }
      }
    })

    mockTools.execute.resolves({ path: 'main.tex', content: 'hello' })

    const runPromise = manager.startRun({
      runId: 'run-tool-name',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'read file' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await runPromise

    expect(
      mockStore.appendEvent.calledWith(
        'run-tool-name',
        sinon.match({
          type: 'toolCallFinished',
          id: 'read-1',
          name: 'read_file',
        })
      )
    ).to.be.true
  })

  it('aborts cleanly when stopRun is invoked', async function () {
    mockClient.streamChat.callsFake(async function* () {
      yield { type: 'thinking', text: 'long thought...' }
      await new Promise(r => setTimeout(r, 200))
      yield { type: 'text', text: 'never reached' }
    })

    const runPromise = manager.startRun({
      runId: 'run-3',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'slow' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await new Promise(r => setTimeout(r, 10))
    await manager.stopRun('run-3')
    await runPromise

    expect(mockStore.appendEvent.calledWith('run-3', sinon.match({ type: 'turnFinished', reason: 'aborted' }))).to.be.true
    expect(mockStore.appendEvent.calledWith('run-3', sinon.match({ type: 'error' }))).to.be.false
    expect(mockStore.updateStatus.calledWith('run-3', 'stopped')).to.be.true
  })

  it('stops runaway loop and outer while loop when identical tool call fails repeatedly', async function () {
    const lastMessages = []
    mockClient.streamChat.callsFake(async function* (opts) {
      lastMessages.push(opts.messages.at(-1)?.content)
      yield {
        type: 'tool_call',
        id: 'call-fail',
        name: 'read_file',
        args: { path: 'nonexistent.tex' },
      }
    })

    mockTools.execute.resolves({ error: 'File not found' })

    await manager.startRun({
      runId: 'run-fail',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    // First failure: plain error. Second: a warning. Third: the run stops.
    expect(mockClient.streamChat.callCount).to.equal(3)
    expect(lastMessages[2]).to.include('failed 2 times')
    const turnFinishedCalls = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[1]?.type === 'turnFinished')
    expect(turnFinishedCalls).to.have.lengthOf(1)
    expect(mockStore.appendEvent.calledWith('run-fail', sinon.match({ type: 'error', code: 'runawayToolLoop' }))).to.be.true
    expect(mockStore.updateStatus.calledWith('run-fail', 'done')).to.be.true
  })

  it('stops prompting user when user rejects an edit and completes turn cleanly', async function () {
    let callCount = 0
    let passedToolsInSecondCall = null

    mockTools.getToolSpecs = () => [
      { name: 'read_file', description: 'r', parameters: {} },
      { name: 'search_text', description: 's', parameters: {} },
      { name: 'edit_file', description: 'e', parameters: {} },
      { name: 'create_file', description: 'c', parameters: {} },
    ]

    mockClient.streamChat.callsFake(async function* (opts) {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'edit-1',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
        }
      } else {
        passedToolsInSecondCall = opts.tools
        yield { type: 'text', text: 'Understood, I will not modify the file.' }
      }
    })

    const runPromise = manager.startRun({
      runId: 'run-reject',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'fix this' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await new Promise(r => setTimeout(r, 10))
    expect(mockStore.setPendingApproval.calledOnce).to.be.true

    // User explicitly rejects
    await manager.approveEdit('run-reject', { accepted: false })
    await runPromise

    // The tool list never changes during a run: changing it would throw away
    // the provider's prompt cache. Further edits are refused by the loop.
    expect(passedToolsInSecondCall.map(t => t.name)).to.deep.equal(['read_file', 'search_text', 'edit_file', 'create_file'])
    expect(mockStore.setPendingApproval.calledOnce).to.be.true
    expect(mockStore.appendEvent.calledWith('run-reject', sinon.match({ type: 'text', text: 'Understood, I will not modify the file.' }))).to.be.true
    expect(mockStore.updateStatus.calledWith('run-reject', 'done')).to.be.true
  })

  it('propagates rejection note to tool result message when user rejects with feedback', async function () {
    let callCount = 0
    let secondCallMessages = null

    mockClient.streamChat.callsFake(async function* (opts) {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'edit-note',
          name: 'edit_file',
          args: { path: 'sections/intro.tex', oldText: 'foo', newText: 'bar' },
        }
      } else {
        secondCallMessages = opts.messages
        yield { type: 'text', text: 'Acknowledged note.' }
      }
    })

    const runPromise = manager.startRun({
      runId: 'run-note',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'update intro' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await new Promise(r => setTimeout(r, 10))
    await manager.approveEdit('run-note', { accepted: false, note: 'Prefer keeping original wording' })
    await runPromise

    expect(secondCallMessages).to.be.an('array')
    const toolMsg = secondCallMessages.find(m => m.role === 'tool' && m.toolCallId === 'edit-note')
    expect(toolMsg).to.exist
    const parsed = JSON.parse(toolMsg.content)
    expect(parsed.status).to.equal('rejected')
    expect(parsed.note).to.equal('Prefer keeping original wording')
    expect(parsed.message).to.include('Prefer keeping original wording')
  })

  it('settles approval on timeout with rejection and finishes cleanly', async function () {
    const timeoutManager = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
      approvalTimeoutMs: 15,
    })

    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'edit-timeout',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
        }
      } else {
        yield { type: 'text', text: 'Approval timed out.' }
      }
    })

    const runPromise = timeoutManager.startRun({
      runId: 'run-timeout',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'edit' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await runPromise

    expect(mockStore.appendEvent.calledWith('run-timeout', sinon.match({
      type: 'toolCallFinished',
      id: 'edit-timeout',
      result: sinon.match({ status: 'rejected', note: 'Approval timed out' }),
    }))).to.be.true
    expect(mockStore.updateStatus.calledWith('run-timeout', 'done')).to.be.true
  })

  it('produces exactly one turnFinished event when stopRun is invoked', async function () {
    mockClient.streamChat.callsFake(async function* () {
      yield { type: 'thinking', text: 'pondering' }
      await new Promise(r => setTimeout(r, 200))
      yield { type: 'text', text: 'never reached' }
    })

    const runPromise = manager.startRun({
      runId: 'run-single-term',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await new Promise(r => setTimeout(r, 10))
    await manager.stopRun('run-single-term')
    await runPromise

    const turnFinishedCalls = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[0] === 'run-single-term' && c.args[1]?.type === 'turnFinished')
    expect(turnFinishedCalls).to.have.lengthOf(1)
    expect(turnFinishedCalls[0].args[1]).to.deep.include({ type: 'turnFinished', reason: 'aborted' })
  })

  it('forwards resolved maxTokens and cacheHints to provider client', async function () {
    let capturedOpts = null
    mockClient.streamChat.callsFake(async function* (opts) {
      capturedOpts = opts
      yield { type: 'text', text: 'done' }
    })

    await manager.startRun({
      runId: 'run-limits',
      projectId: 'p1',
      userId: 'u1',
      transcript: [
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'turn 2' },
      ],
      providerSettings: { type: 'anthropic', apiKey: 'k', model: 'claude-3-7-sonnet' },
    })

    expect(capturedOpts).to.exist
    expect(capturedOpts.maxTokens).to.equal(32000)
    expect(capturedOpts.contextWindow).to.equal(200000)
    expect(capturedOpts.cacheHints).to.deep.equal({
      cacheSystem: true,
      cacheTools: true,
      lastStableMessage: 1,
      cacheKey: 'p1',
    })
  })

  it('coalesces streamed text chunks into batched writes', async function () {
    mockClient.streamChat.callsFake(async function* () {
      for (let i = 0; i < 100; i++) {
        yield { type: 'text', text: 'x' }
      }
    })

    await manager.startRun({
      runId: 'run-coalesce',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'k' },
    })

    const textEvents = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[0] === 'run-coalesce' && c.args[1]?.type === 'text')

    // 100 1-char chunks flushed at 100 chars or 50ms should produce far fewer than 100 writes
    expect(textEvents.length).to.be.lessThan(5)
    const combined = textEvents.map(c => c.args[1].text).join('')
    expect(combined).to.equal('x'.repeat(100))
  })

  it('coalesces streamed thinking chunks and keeps thinking/text order', async function () {
    mockClient.streamChat.callsFake(async function* () {
      for (let i = 0; i < 30; i++) yield { type: 'thinking', text: 't' }
      yield { type: 'text', text: 'answer' }
    })

    await manager.startRun({
      runId: 'run-think',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'hi' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    const streamed = mockStore.appendEvent
      .getCalls()
      .map(c => c.args[1])
      .filter(e => e.type === 'thinking' || e.type === 'text')

    const thinkingEvents = streamed.filter(e => e.type === 'thinking')
    expect(thinkingEvents.length).to.be.lessThan(30)
    expect(thinkingEvents.map(e => e.text).join('')).to.equal('t'.repeat(30))
    expect(streamed.at(-1)).to.deep.equal({ type: 'text', text: 'answer' })
    expect(streamed.findIndex(e => e.type === 'text')).to.equal(streamed.length - 1)
  })

  it('preserves ordering and does not merge text across non-text boundaries', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'text', text: 'before tool ' }
        yield {
          type: 'tool_call',
          id: 'c1',
          name: 'read_file',
          args: { path: 'main.tex' },
        }
      } else {
        yield { type: 'text', text: 'after tool' }
      }
    })

    mockTools.execute.resolves({ path: 'main.tex', content: 'hello' })

    await manager.startRun({
      runId: 'run-order',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'k' },
    })

    const eventTypes = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[0] === 'run-order')
      .map(c => c.args[1])

    const summary = eventTypes.map(e => e.type === 'text' ? `text:${e.text.trim()}` : e.type)
    expect(summary).to.deep.equal([
      'text:before tool',
      'toolCallStarted',
      'toolCallFinished',
      'text:after tool',
      'turnFinished',
    ])
  })

  it('runs an unlimited number of tool calls', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount <= 25) {
        yield {
          type: 'tool_call',
          id: `c_${callCount}`,
          name: 'read_file',
          args: { path: `file_${callCount}.tex` },
        }
      } else {
        yield { type: 'text', text: 'finished 25 calls' }
      }
    })

    mockTools.execute.resolves({ path: 'file.tex', content: 'ok' })

    await manager.startRun({
      runId: 'run-unlimited',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'run many tools' }],
      providerSettings: { type: 'openai', apiKey: 'k' },
    })

    expect(mockStore.appendEvent.calledWith('run-unlimited', sinon.match({ type: 'turnFinished', reason: 'stop' }))).to.be.true
    expect(callCount).to.equal(26)
  })

  describe('applyContextBudget', function () {
    it('returns messages unchanged when within context limits', function () {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]
      const result = applyContextBudget({
        system: 'System prompt',
        messages,
        limits: { contextWindow: 100000, maxOutputTokens: 1000 },
      })
      expect(result.exhausted).to.be.false
      expect(result.messages).to.deep.equal(messages)
    })

    it('elides older tool results to fit budget while preserving recent ones', function () {
      const messages = [
        { role: 'user', content: 'run tool 1' },
        { role: 'assistant', content: 'calling', toolCalls: [{ id: '1', name: 'read_file' }] },
        { role: 'tool', toolCallId: '1', name: 'read_file', content: 'x'.repeat(4000) },
        { role: 'user', content: 'run tool 2' },
        { role: 'assistant', content: 'calling', toolCalls: [{ id: '2', name: 'read_file' }] },
        { role: 'tool', toolCallId: '2', name: 'read_file', content: 'x'.repeat(4000) },
        { role: 'user', content: 'run tool 3' },
        { role: 'assistant', content: 'calling', toolCalls: [{ id: '3', name: 'read_file' }] },
        { role: 'tool', toolCallId: '3', name: 'read_file', content: 'x'.repeat(4000) },
        { role: 'user', content: 'run tool 4' },
        { role: 'assistant', content: 'calling', toolCalls: [{ id: '4', name: 'read_file' }] },
        { role: 'tool', toolCallId: '4', name: 'read_file', content: 'x'.repeat(4000) },
      ]

      const result = applyContextBudget({
        system: 'Sys',
        messages,
        limits: { contextWindow: 5000, maxOutputTokens: 500 },
      })

      expect(result.exhausted).to.be.false
      const toolMsg0 = result.messages[2]
      expect(toolMsg0.content).to.include('elided')
      const toolMsg3 = result.messages[11]
      expect(toolMsg3.content).to.equal('x'.repeat(4000))
    })

    it('flags exhausted: true when raw budget <= 0', function () {
      const result = applyContextBudget({
        system: 'Sys',
        messages: [{ role: 'user', content: 'hi' }],
        limits: { contextWindow: 1000, maxOutputTokens: 1000 },
      })
      expect(result.exhausted).to.be.true
    })

    it('drops oldest turns when eliding tool results is still not enough to fit budget', function () {
      const messages = [
        { role: 'user', content: 'huge prompt 1 ' + 'a'.repeat(4000) },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'huge prompt 2 ' + 'b'.repeat(4000) },
        { role: 'assistant', content: 'reply 2' },
        { role: 'user', content: 'latest message' },
      ]

      const result = applyContextBudget({
        system: 'Sys',
        messages,
        limits: { contextWindow: 2500, maxOutputTokens: 200 },
      })

      expect(result.exhausted).to.be.false
      expect(result.messages.length).to.be.lessThan(messages.length)
      expect(result.messages.at(-1).content).to.equal('latest message')
    })

    it('drops whole turns so the trimmed conversation still opens with a user message', function () {
      const messages = [
        { role: 'user', content: 'first request ' + 'a'.repeat(6000) },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'main.tex' } }],
        },
        { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'x'.repeat(400) },
        { role: 'user', content: 'second request' },
        { role: 'assistant', content: 'second reply' },
        { role: 'user', content: 'latest message' },
      ]

      const result = applyContextBudget({
        system: 'Sys',
        messages,
        limits: { contextWindow: 2000, maxOutputTokens: 100 },
      })

      expect(result.exhausted).to.equal(false)
      expect(result.messages[0].role).to.equal('user')
      expect(result.messages[0].content).to.equal('second request')
      expect(result.messages.some(m => m.role === 'tool')).to.equal(false)
      expect(result.messages.at(-1).content).to.equal('latest message')
    })

    it('reports exhausted instead of cutting inside the only remaining turn', function () {
      const messages = [
        { role: 'user', content: 'only request' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'main.tex' } }],
        },
        { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'x'.repeat(20000) },
      ]

      const result = applyContextBudget({
        system: 'Sys',
        messages,
        limits: { contextWindow: 2000, maxOutputTokens: 100 },
      })

      expect(result.exhausted).to.equal(true)
      expect(result.messages[0].role).to.equal('user')
    })

    it('trims to 70% of the budget in one pass, so the next steps reuse the cache', function () {
      const messages = []
      for (let i = 0; i < 8; i++) {
        messages.push({ role: 'user', content: `q${i}` })
        messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `${i}`, name: 'read_file', args: { path: 'main.tex' } }] })
        messages.push({ role: 'tool', toolCallId: `${i}`, name: 'read_file', content: 'x'.repeat(8000) })
      }
      messages.push({ role: 'user', content: 'latest' })
      // budget = 20000 - 1000 - 2000 = 17000; target = 11900
      const limits = { contextWindow: 20000, maxOutputTokens: 1000 }

      const result = applyContextBudget({ system: 'Sys', messages, limits })

      const elided = result.messages.filter(m => m.role === 'tool' && m.content.includes('"elided":true'))
      expect(result.exhausted).to.equal(false)
      expect(elided).to.have.length(3)
      expect(estimateMessagesTokens('Sys', result.messages)).to.be.at.most(Math.floor(17000 * TRIM_TARGET_FRACTION))

      // The next step appends a small turn: nothing earlier changes.
      const next = [...result.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }]
      const again = applyContextBudget({ system: 'Sys', messages: next, limits })
      expect(again.messages.slice(0, result.messages.length)).to.deep.equal(result.messages)
    })
  })

  it('emits contextExhausted and finishes turn when conversation exceeds context window', async function () {
    const hugeUserMessage = 'x'.repeat(100000)
    await manager.startRun({
      runId: 'run-exhausted',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: hugeUserMessage }],
      providerSettings: {
        type: 'openai',
        apiKey: 'k',
        contextWindow: 1000,
        maxOutputTokens: 500,
      },
    })

    expect(mockStore.appendEvent.calledWith('run-exhausted', sinon.match({
      type: 'error',
      code: 'contextExhausted',
    }))).to.be.true
    expect(mockStore.appendEvent.calledWith('run-exhausted', sinon.match({
      type: 'turnFinished',
      reason: 'stop',
    }))).to.be.true
    expect(mockStore.updateStatus.calledWith('run-exhausted', 'done')).to.be.true
    expect(mockClient.streamChat.called).to.be.false
  })

  it("does not ask for approval of an edit that cannot apply", async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: "tool_call", id: "e1", name: "edit_file", args: { path: "main.tex", oldText: "nope", newText: "x" } }
      } else {
        yield { type: "text", text: "Let me read the file first." }
      }
    })
    mockTools.checkEdit = sinon.stub().resolves({ status: "noMatch", error: "Could not find target text" })

    await manager.startRun({
      runId: "run-nomatch",
      projectId: "p1",
      userId: "u1",
      transcript: [{ role: "user", content: "edit" }],
      providerSettings: { type: "openai", apiKey: "k", model: "gpt-4o" },
    })

    expect(mockStore.setPendingApproval.called).to.equal(false)
    expect(mockTools.execute.calledWith("edit_file")).to.equal(false)
    expect(mockStore.appendEvent.calledWith("run-nomatch", sinon.match({
      type: "toolCallFinished",
      id: "e1",
      result: sinon.match({ status: "noMatch" }),
    }))).to.be.true
  })

  it("follows a planned edit to the file that actually contains the anchor", async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: "tool_call", id: "e2", name: "edit_file", args: { path: "main.tex", oldText: "intro", newText: "x" } }
      } else {
        yield { type: "text", text: "ok" }
      }
    })
    mockTools.checkEdit = sinon.stub().resolves({ status: "ok", path: "chapters/intro.tex" })

    const runPromise = manager.startRun({
      runId: "run-redirect",
      projectId: "p1",
      userId: "u1",
      transcript: [{ role: "user", content: "edit" }],
      providerSettings: { type: "openai", apiKey: "k", model: "gpt-4o" },
    })
    await new Promise(r => setTimeout(r, 10))

    expect(mockStore.setPendingApproval.calledWith("run-redirect", sinon.match({
      edit: sinon.match({ path: "chapters/intro.tex" }),
    }))).to.be.true

    await manager.approveEdit("run-redirect", { accepted: true })
    await runPromise
  })

  it('renders tool results as text for the provider and renders history the same way', async function () {
    const readResult = { path: 'main.tex', from: 1, to: 1, totalLines: 1, content: '1: hi', truncated: false }
    let secondRequest = null
    let callCount = 0
    mockClient.streamChat.callsFake(async function* (opts) {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'main.tex' } }
      } else {
        secondRequest = opts
        yield { type: 'text', text: 'done' }
      }
    })
    mockTools.execute.resolves(readResult)

    await manager.startRun({
      runId: 'run-render',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'read' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    const live = secondRequest.messages.find(m => m.role === 'tool')
    expect(live.content).to.equal('main.tex lines 1-1 of 1\n```\n1: hi\n```')

    const { toAgentMessages } = await import('../../../app/src/AiAssistRunManager.mjs')
    const rebuilt = toAgentMessages([
      { role: 'user', text: 'read' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'main.tex' }, result: readResult }] },
    ]).find(m => m.role === 'tool')
    expect(rebuilt.content).to.equal(live.content)
    expect(rebuilt).to.include({ name: 'read_file', isError: false })
  })

  it('executes the leading read-only calls of a turn concurrently, keeping event order', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'a', name: 'read_file', args: { path: 'a.tex' } }
        yield { type: 'tool_call', id: 'b', name: 'search_text', args: { query: 'x' } }
        yield { type: 'tool_call', id: 'c', name: 'get_outline', args: {} }
      } else {
        yield { type: 'text', text: 'done' }
      }
    })

    let inFlight = 0
    let maxInFlight = 0
    mockTools.execute.callsFake(async name => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 20))
      inFlight--
      return { tool: name }
    })

    await manager.startRun({
      runId: 'run-parallel',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'look around' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    expect(maxInFlight).to.equal(3)
    const finished = mockStore.appendEvent
      .getCalls()
      .map(c => c.args[1])
      .filter(e => e.type === 'toolCallFinished')
      .map(e => e.id)
    expect(finished).to.deep.equal(['a', 'b', 'c'])
  })

  it('does not run a read ahead of an edit that precedes it in the same turn', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'e', name: 'edit_file', args: { path: 'a.tex', oldText: 'x', newText: 'y' } }
        yield { type: 'tool_call', id: 'r', name: 'read_file', args: { path: 'a.tex' } }
      } else {
        yield { type: 'text', text: 'done' }
      }
    })

    const runPromise = manager.startRun({
      runId: 'run-order',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'edit then read' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })
    await new Promise(r => setTimeout(r, 10))

    // Waiting for approval: the read must not have run yet.
    expect(mockTools.execute.calledWith('read_file')).to.equal(false)

    await manager.approveEdit('run-order', { accepted: true })
    await runPromise
    expect(mockTools.execute.calledWith('read_file')).to.equal(true)
  })

  describe('extractTextToolCall', function () {
    const specs = [{ name: 'edit_file' }, { name: 'read_file' }]

    it('extracts fenced JSON tool call and preserves leading prose', function () {
      const text = 'I will now edit the document.\n```json\n{\n  "name": "edit_file",\n  "arguments": { "path": "main.tex", "oldText": "a", "newText": "b" }\n}\n```'
      const extracted = extractTextToolCall(text, specs)
      expect(extracted).to.exist
      expect(extracted.call.name).to.equal('edit_file')
      expect(extracted.call.args).to.deep.equal({ path: 'main.tex', oldText: 'a', newText: 'b' })
      expect(extracted.prose).to.equal('I will now edit the document.')
    })

    it('rescues text-based tool call when model outputs fenced tool call after thinking', async function () {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* () {
        callCount++
        if (callCount === 1) {
          yield { type: 'thinking', text: 'I should edit main.tex.' }
          yield {
            type: 'text',
            text: '```json\n{\n  "name": "edit_file",\n  "arguments": { "path": "main.tex", "oldText": "intro", "newText": "intro updated" }\n}\n```',
          }
        } else {
          yield { type: 'text', text: 'All done.' }
        }
      })

      const runPromise = manager.startRun({
        runId: 'run-text-rescue',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'fix it' }],
        providerSettings: { type: 'openai', apiKey: 'k' },
      })
      await new Promise(r => setTimeout(r, 10))

      expect(mockStore.setPendingApproval.calledWith('run-text-rescue', sinon.match({
        edit: sinon.match({ path: 'main.tex' }),
      }))).to.be.true

      await manager.approveEdit('run-text-rescue', { accepted: true })
      await runPromise

      expect(mockTools.execute.calledWith('edit_file')).to.be.true
    })
  })

  describe('Agent modes enforcement and approvals', function () {
    function createMockStore() {
      return {
        createRun: sinon.stub().resolves(),
        appendEvent: sinon.stub().resolves(1),
        updateStatus: sinon.stub().resolves(),
        setPendingApproval: sinon.stub().resolves(),
        clearPendingApproval: sinon.stub().resolves(),
        getPendingApproval: sinon.stub().resolves(null),
        getRun: sinon.stub().resolves({ status: 'running' }),
        touchHeartbeat: sinon.stub().resolves(),
        setMode: sinon.stub().resolves(),
      }
    }

    it('enforces acceptEdits mode: auto-applies file edits without emitting awaitingApproval', async () => {
      let approvalEmitted = false
      let toolExecuted = false
      const fakeTools = {
        getToolSpecs: () => [{ name: 'edit_file' }],
        checkEdit: async () => ({ status: 'ok', path: 'main.tex', oldText: 'a', newText: 'b' }),
        execute: async (name, args) => {
          if (name === 'edit_file') toolExecuted = true
          return { status: 'applied' }
        },
      }
      const fakeStore = createMockStore()
      const originalAppend = fakeStore.appendEvent
      fakeStore.appendEvent = async (runId, event) => {
        if (event.type === 'awaitingApproval') approvalEmitted = true
        return originalAppend(runId, event)
      }

      let turn = 0
      const fakeClient = {
        streamChat: async function* () {
          turn++
          if (turn === 1) {
            yield { type: 'tool_call', id: 'call_1', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'b' } }
          } else {
            yield { type: 'text', text: 'Done' }
          }
        },
      }

      const manager = new AiAssistRunManager({
        store: fakeStore,
        tools: fakeTools,
        clientFactory: () => fakeClient,
      })

      await manager.startRun({
        runId: 'test_accept_edits',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', text: 'fix typo' }],
        providerSettings: { type: 'anthropic' },
        mode: 'acceptEdits',
      })

      expect(toolExecuted).to.be.true
      expect(approvalEmitted).to.be.false
    })

    it('enforces plan mode: denies edit_file call, excludes edit tools from specs, includes present_plan', async () => {
      let capturedTools = null
      let toolExecuted = false
      const fakeTools = {
        getToolSpecs: () => [{ name: 'read_file' }, { name: 'edit_file' }],
        execute: async () => { toolExecuted = true },
      }
      const fakeStore = createMockStore()
      const capturedEvents = []
      fakeStore.appendEvent = async (runId, event) => {
        capturedEvents.push(event)
      }

      let turn = 0
      const fakeClient = {
        streamChat: async function* (options) {
          capturedTools = options.tools
          turn++
          if (turn === 1) {
            yield { type: 'tool_call', id: 'call_edit', name: 'edit_file', args: { path: 'main.tex', newText: 'foo' } }
          } else {
            yield { type: 'text', text: 'I understand.' }
          }
        },
      }

      const manager = new AiAssistRunManager({
        store: fakeStore,
        tools: fakeTools,
        clientFactory: () => fakeClient,
      })

      await manager.startRun({
        runId: 'test_plan_mode',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', text: 'plan work' }],
        providerSettings: { type: 'anthropic' },
        mode: 'plan',
      })

      expect(toolExecuted).to.be.false
      const names = capturedTools.map(t => t.name)
      expect(names).to.include('read_file')
      expect(names).to.include('present_plan')
      expect(names).to.not.include('edit_file')

      const finishedCall = capturedEvents.find(e => e.type === 'toolCallFinished' && e.id === 'call_edit')
      expect(finishedCall).to.exist
      expect(finishedCall.result.status).to.equal('denied')
    })

    it('handles present_plan approval: switches mode and emits modeChanged', async () => {
      const fakeTools = {
        getToolSpecs: () => [{ name: 'read_file' }, { name: 'edit_file' }],
        execute: async () => ({ status: 'applied' }),
      }
      const fakeStore = createMockStore()
      const capturedEvents = []
      fakeStore.appendEvent = async (runId, event) => {
        capturedEvents.push(event)
      }

      let turn = 0
      const fakeClient = {
        streamChat: async function* () {
          turn++
          if (turn === 1) {
            yield { type: 'tool_call', id: 'call_plan', name: 'present_plan', args: { plan: 'Step 1: edit main.tex' } }
          } else {
            yield { type: 'text', text: 'Executing plan.' }
          }
        },
      }

      const manager = new AiAssistRunManager({
        store: fakeStore,
        tools: fakeTools,
        clientFactory: () => fakeClient,
      })

      const runPromise = manager.startRun({
        runId: 'test_present_plan',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', text: 'make a plan' }],
        providerSettings: { type: 'anthropic' },
        mode: 'plan',
      })

      // Wait for awaitingApproval event
      await new Promise(resolve => setTimeout(resolve, 50))
      await manager.approveEdit('test_present_plan', { accepted: true, nextMode: 'acceptEdits' })
      await runPromise

      const modeChangedEvent = capturedEvents.find(e => e.type === 'modeChanged')
      expect(modeChangedEvent).to.exist
      expect(modeChangedEvent.mode).to.equal('acceptEdits')
      expect(modeChangedEvent.source).to.equal('planApproval')
    })
  })

  describe('messages sent while the run is going', function () {
    it('injects a queued message at the next request and announces it', async function () {
      let turn = 0
      const sentMessages = []
      mockClient.streamChat.callsFake(async function* (opts) {
        turn++
        sentMessages.push(opts.messages.map(m => m.content))
        if (turn === 1) {
          yield { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'main.tex' } }
          // Sent while this turn was still streaming.
          await manager.queueMessage('run-queue', {
            id: 'q1',
            text: 'also check the bibliography',
            contextText: '<project-context turn="2"/>',
          })
        } else {
          yield { type: 'text', text: 'Checked both.' }
        }
      })

      await manager.startRun({
        runId: 'run-queue',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'check the preamble' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      // The second request carries it, assembled envelope-first like a stored turn.
      expect(sentMessages[1]).to.include(
        '<project-context turn="2"/>\n\nalso check the bibliography'
      )
      expect(
        mockStore.appendEvent.calledWith(
          'run-queue',
          sinon.match({ type: 'userMessage', id: 'q1', text: 'also check the bibliography' })
        )
      ).to.be.true
    })

    it('keeps the run going when a message lands as the model finishes', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'text', text: 'Done.' }
          await manager.queueMessage('run-late', { id: 'q1', text: 'one more thing' })
        } else {
          yield { type: 'text', text: 'And that too.' }
        }
      })

      await manager.startRun({
        runId: 'run-late',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'go' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(mockClient.streamChat.callCount).to.equal(2)
      // One run, so exactly one terminal event.
      expect(
        mockStore.appendEvent.getCalls().filter(c => c.args[1]?.type === 'turnFinished')
      ).to.have.lengthOf(1)
    })

    it('clears the decline block so a new instruction can edit again', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'e1', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'b' } }
        } else if (turn === 2) {
          await manager.queueMessage('run-unblock', { id: 'q1', text: 'try this instead' })
          yield { type: 'text', text: 'Understood.' }
        } else if (turn === 3) {
          yield { type: 'tool_call', id: 'e2', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'c' } }
        } else {
          yield { type: 'text', text: 'Applied.' }
        }
      })

      const runPromise = manager.startRun({
        runId: 'run-unblock',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'edit it' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
        mode: 'acceptEdits',
      })
      await new Promise(r => setTimeout(r, 10))
      await runPromise

      // The second edit was not refused as "declined earlier in this turn".
      const secondEdit = mockStore.appendEvent
        .getCalls()
        .find(c => c.args[1]?.type === 'toolCallFinished' && c.args[1]?.id === 'e2')
      expect(secondEdit?.args[1]?.result?.status).to.not.equal('rejected')
    })
  })

  describe('failure accounting', function () {
    const start = (runId, extra = {}) =>
      manager.startRun({
        runId,
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'go' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
        ...extra,
      })

    it('refuses a further edit after a decline without asking again or ending the run', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'e1', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'b' } }
        } else if (turn === 2) {
          yield { type: 'tool_call', id: 'e2', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'c' } }
        } else {
          yield { type: 'text', text: 'I will leave it as it is.' }
        }
      })

      const runPromise = start('run-blocked')
      await new Promise(r => setTimeout(r, 10))
      await manager.approveEdit('run-blocked', { accepted: false })
      await runPromise

      expect(mockStore.setPendingApproval.calledOnce).to.be.true
      expect(mockClient.streamChat.callCount).to.equal(3)
      expect(mockStore.appendEvent.calledWith('run-blocked', sinon.match({
        type: 'toolCallFinished',
        id: 'e2',
        result: sinon.match({ status: 'rejected' }),
      }))).to.be.true
      expect(mockTools.execute.calledWith('edit_file')).to.be.false
      expect(mockStore.updateStatus.calledWith('run-blocked', 'done')).to.be.true
    })

    it('counts a turn whose calls all failed once, however many calls it made', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        for (let i = 0; i < 3; i++) {
          yield { type: 'tool_call', id: `r${turn}-${i}`, name: 'read_file', args: { path: `missing-${turn}-${i}.tex` } }
        }
      })
      mockTools.execute.resolves({ error: 'File not found' })

      await start('run-turns')

      expect(mockClient.streamChat.callCount).to.equal(4)
      expect(mockStore.appendEvent.calledWith('run-turns', sinon.match({ type: 'error', code: 'consecutiveToolFailures' }))).to.be.true
      expect(mockStore.appendEvent.getCalls().filter(c => c.args[1]?.type === 'turnFinished')).to.have.lengthOf(1)
    })

    it('forgets earlier failures once a call changes the project', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 3) {
          yield { type: 'tool_call', id: `s${turn}`, name: 'configure_editor_settings', args: { mode: 'vim' } }
        } else if (turn <= 5) {
          yield { type: 'tool_call', id: `r${turn}`, name: 'read_file', args: { path: 'missing.tex' } }
        } else {
          yield { type: 'text', text: 'done' }
        }
      })
      mockTools.execute.callsFake(async name =>
        name === 'configure_editor_settings' ? { status: 'applied' } : { error: 'File not found' }
      )

      const runPromise = start('run-forget')
      await new Promise(r => setTimeout(r, 20))
      await manager.approveEdit('run-forget', { accepted: true })
      await runPromise

      expect(mockClient.streamChat.callCount).to.equal(6)
      expect(mockStore.appendEvent.calledWith('run-forget', sinon.match({ type: 'error' }))).to.be.false
    })

    it('does not count get_compile_result with nothing compiled as a failure', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn <= 3) {
          yield { type: 'tool_call', id: `g${turn}`, name: 'get_compile_result', args: {} }
        } else {
          yield { type: 'text', text: 'Nothing has been compiled yet.' }
        }
      })
      mockTools.execute.resolves({ status: 'none', message: 'No compile has run in this chat yet.' })

      await start('run-none')

      expect(mockClient.streamChat.callCount).to.equal(4)
      expect(mockStore.appendEvent.calledWith('run-none', sinon.match({ type: 'error' }))).to.be.false
    })
  })

  describe('incomplete tool calls', function () {
    const start = runId =>
      manager.startRun({
        runId,
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'go' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

    it('never runs an edit that was cut off at the output limit', async function () {
      let turn = 0
      const requests = []
      mockClient.streamChat.callsFake(async function* (opts) {
        turn++
        requests.push(JSON.parse(JSON.stringify(opts.messages)))
        if (turn === 1) {
          yield { type: 'tool_call', id: 'e1', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'half of it', _repaired: true } }
          yield { type: 'stop', reason: 'max_tokens' }
        } else {
          yield { type: 'text', text: 'ok' }
        }
      })
      mockTools.checkEdit = sinon.stub().resolves({ status: 'ok', path: 'main.tex' })

      await start('run-cut')

      expect(mockStore.setPendingApproval.called).to.be.false
      expect(mockTools.checkEdit.called).to.be.false
      expect(mockTools.execute.called).to.be.false
      const assistant = requests[1].find(m => m.role === 'assistant')
      expect(assistant.toolCalls[0].args).to.deep.equal({ path: 'main.tex' })
      const tool = requests[1].find(m => m.role === 'tool')
      expect(tool.content).to.include('cut off at the 32000-token output limit')
    })

    it('never runs a file change whose arguments only parsed after repair', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'c1', name: 'create_file', args: { path: 'new.tex', content: 'x', _repaired: true } }
        } else {
          yield { type: 'text', text: 'ok' }
        }
      })

      await start('run-repaired')

      expect(mockTools.execute.called).to.be.false
      expect(mockStore.setPendingApproval.called).to.be.false
    })

    it('runs a read whose arguments were repaired, without the marker', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'main.tex', _repaired: true } }
        } else {
          yield { type: 'text', text: 'ok' }
        }
      })

      await start('run-repaired-read')

      expect(mockTools.execute.calledWith('read_file', { path: 'main.tex' })).to.be.true
    })

    it('reports a text reply cut off at the output limit', async function () {
      mockClient.streamChat.callsFake(async function* () {
        yield { type: 'text', text: 'A long answer that' }
        yield { type: 'stop', reason: 'max_tokens' }
      })

      await start('run-cut-text')

      expect(mockStore.appendEvent.calledWith('run-cut-text', sinon.match({ type: 'error', code: 'outputTruncated' }))).to.be.true
      expect(mockStore.updateStatus.calledWith('run-cut-text', 'done')).to.be.true
    })
  })
})
