import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  AiAssistRunManager,
  FINAL_REPLY_NUDGE,
  SENT_DURING_RUN_NOTE,
  TRIM_TARGET_FRACTION,
  WEB_CALL_NUDGE,
  applyContextBudget,
  applyContextTrim,
  estimateMessagesTokens,
  latestContextTrim,
  recordContextTrim,
  extractTextToolCall,
  toAgentMessages,
  toolMessageIsError,
} from '../../../app/src/AiAssistRunManager.mjs'
import {
  emptyAgentState,
  reduceAgentEvent,
} from '../../../frontend/js/features/ai-assist/agent/agent-state.ts'
import { hydrateTranscript } from '../../../app/src/AiAssistChatHistoryStore.mjs'

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
      getPendingApproval: sinon
        .stub()
        .resolves({ id: 'c1', edit: { path: 'a.tex' } }),
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
        yield {
          type: 'tool_call',
          id: 'r1',
          name: 'read_file',
          args: { path: 'missing.tex' },
        }
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
      providerSettings: {
        type: 'google',
        apiKey: 'k',
        model: 'gemini-2.5-pro',
      },
    })

    const toolMessage = secondRequest.messages.find(m => m.role === 'tool')
    expect(toolMessage).to.include({
      toolCallId: 'r1',
      name: 'read_file',
      isError: true,
    })
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
    expect(
      mockStore.appendEvent.calledWith(
        'run-progress',
        sinon.match({ type: 'text', text: 'All fixed.' })
      )
    ).to.be.true
  })

  it('stops an alternating loop whose calls repeat exactly', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      const name =
        callCount % 2 === 1 ? 'compile_project' : 'get_compile_result'
      yield { type: 'tool_call', id: `c${callCount}`, name, args: {} }
    })

    await manager.startRun({
      runId: 'run-spin',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'check the build' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    expect(
      mockStore.appendEvent.calledWith(
        'run-spin',
        sinon.match({ type: 'error', code: 'runawayToolLoop' })
      )
    ).to.be.true
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

    expect(
      mockStore.appendEvent.calledWith(
        'run-1',
        sinon.match({ type: 'thinking', text: 'pondering' })
      )
    ).to.be.true
    expect(
      mockStore.appendEvent.calledWith(
        'run-1',
        sinon.match({ type: 'text', text: 'Hello from server' })
      )
    ).to.be.true
    expect(
      mockStore.appendEvent.calledWith(
        'run-1',
        sinon.match({ type: 'turnFinished', reason: 'stop' })
      )
    ).to.be.true
    expect(mockStore.updateStatus.calledWith('run-1', 'done')).to.be.true
  })

  describe('provider 5xx errors', function () {
    let clock

    beforeEach(function () {
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })

    afterEach(function () {
      clock.restore()
    })

    // Moves the fake clock forward a second at a time, letting the run's
    // promises settle in between
    async function advance(ms) {
      for (let t = 0; t < ms; t += 1000) {
        clock.tick(1000)
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    const serverError = () =>
      Object.assign(new Error('Internal Server Error (ref: abc)'), {
        status: 500,
      })

    it('keeps retrying a step through five failures in a row', async function () {
      let calls = 0
      mockClient.streamChat.callsFake(async function* () {
        calls++
        if (calls <= 5) throw serverError()
        yield { type: 'text', text: 'Recovered' }
      })

      const runPromise = manager.startRun({
        runId: 'run-retry',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'hi' }],
        providerSettings: { type: 'ollama', model: 'm' },
      })
      await advance(60000)
      await runPromise

      expect(mockClient.streamChat.callCount).to.equal(6)
      expect(mockStore.updateStatus.calledWith('run-retry', 'done')).to.be.true
    })

    it('gives up after six failed attempts', async function () {
      mockClient.streamChat.callsFake(async function* () {
        throw serverError()
      })

      const runPromise = manager.startRun({
        runId: 'run-give-up',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'hi' }],
        providerSettings: { type: 'ollama', model: 'm' },
      })
      await advance(60000)
      await runPromise

      expect(mockClient.streamChat.callCount).to.equal(6)
      expect(mockStore.updateStatus.calledWith('run-give-up', 'error')).to.be
        .true
    })
  })

  it('suspends on edit_file and resumes when approveEdit is called', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'edit-1',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
        }
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
    expect(
      mockStore.appendEvent.calledWith(
        'run-2',
        sinon.match({
          type: 'toolCallFinished',
          id: 'edit-1',
          name: 'edit_file',
        })
      )
    ).to.be.true
  })

  describe('compile_project with an editor watching', function () {
    function scriptCompile() {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* () {
        callCount++
        if (callCount === 1) {
          yield {
            type: 'tool_call',
            id: 'comp-1',
            name: 'compile_project',
            args: { clean: true },
          }
        } else {
          yield { type: 'text', text: 'done' }
        }
      })
      mockTools.execute.callsFake(async (name, args, context) => ({
        outcome: await context.compileInEditor({
          id: context.callId,
          clean: args.clean,
        }),
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
      expect(
        mockStore.appendEvent.calledWith('run-compile', {
          type: 'awaitingCompile',
          id: 'comp-1',
          clean: true,
        })
      ).to.be.true

      await manager.submitCompileResult('run-compile', {
        id: 'stale',
        outcome: { status: 'success' },
      })
      await manager.submitCompileResult('run-compile', {
        id: 'comp-1',
        outcome: {
          status: 'failure',
          errors: [{ file: 'main.tex', line: 2, message: 'Bad', extra: 'x' }],
        },
      })
      await runPromise

      expect(
        mockStore.appendEvent.calledWith(
          'run-compile',
          sinon.match({
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
          })
        )
      ).to.be.true
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

      expect(
        mockStore.appendEvent.calledWith(
          'run-compile-headless',
          sinon.match({ type: 'awaitingCompile' })
        )
      ).to.be.false
      expect(
        mockStore.appendEvent.calledWith(
          'run-compile-headless',
          sinon.match({
            type: 'toolCallFinished',
            result: { outcome: null },
          })
        )
      ).to.be.true
    })
  })

  it('emits toolCallFinished with call id and name on non-edit tool', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'read-1',
          name: 'read_file',
          args: { path: 'main.tex' },
        }
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

    expect(
      mockStore.appendEvent.calledWith(
        'run-3',
        sinon.match({ type: 'turnFinished', reason: 'aborted' })
      )
    ).to.be.true
    expect(
      mockStore.appendEvent.calledWith('run-3', sinon.match({ type: 'error' }))
    ).to.be.false
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
    expect(
      mockStore.appendEvent.calledWith(
        'run-fail',
        sinon.match({ type: 'error', code: 'runawayToolLoop' })
      )
    ).to.be.true
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
    expect(passedToolsInSecondCall.map(t => t.name)).to.deep.equal([
      'read_file',
      'search_text',
      'edit_file',
      'create_file',
      'present_plan',
    ])
    expect(mockStore.setPendingApproval.calledOnce).to.be.true
    expect(
      mockStore.appendEvent.calledWith(
        'run-reject',
        sinon.match({
          type: 'text',
          text: 'Understood, I will not modify the file.',
        })
      )
    ).to.be.true
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
    await manager.approveEdit('run-note', {
      accepted: false,
      note: 'Prefer keeping original wording',
    })
    await runPromise

    expect(secondCallMessages).to.be.an('array')
    const toolMsg = secondCallMessages.find(
      m => m.role === 'tool' && m.toolCallId === 'edit-note'
    )
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

    expect(
      mockStore.appendEvent.calledWith(
        'run-timeout',
        sinon.match({
          type: 'toolCallFinished',
          id: 'edit-timeout',
          result: sinon.match({
            status: 'rejected',
            note: 'Approval timed out',
          }),
        })
      )
    ).to.be.true
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
      .filter(
        c =>
          c.args[0] === 'run-single-term' && c.args[1]?.type === 'turnFinished'
      )
    expect(turnFinishedCalls).to.have.lengthOf(1)
    expect(turnFinishedCalls[0].args[1]).to.deep.include({
      type: 'turnFinished',
      reason: 'aborted',
    })
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
      providerSettings: {
        type: 'anthropic',
        apiKey: 'k',
        model: 'claude-3-7-sonnet',
      },
    })

    expect(capturedOpts).to.exist
    expect(capturedOpts.maxTokens).to.equal(32000)
    expect(capturedOpts.contextWindow).to.equal(200000)
    expect(capturedOpts.cacheHints).to.deep.equal({
      cacheSystem: true,
      cacheTools: true,
      lastStableMessage: 1,
      cacheKey: 'p1',
      systemPrefix: capturedOpts.system,
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

    // 100 1-char chunks flushed every 8 chars (or 16ms) take at most 13 writes
    expect(textEvents.length).to.be.at.most(Math.ceil(100 / 8))
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
    expect(streamed.findIndex(e => e.type === 'text')).to.equal(
      streamed.length - 1
    )
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

    const summary = eventTypes.map(e =>
      e.type === 'text' ? `text:${e.text.trim()}` : e.type
    )
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

    expect(
      mockStore.appendEvent.calledWith(
        'run-unlimited',
        sinon.match({ type: 'turnFinished', reason: 'stop' })
      )
    ).to.be.true
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
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: '1', name: 'read_file' }],
        },
        {
          role: 'tool',
          toolCallId: '1',
          name: 'read_file',
          content: 'x'.repeat(4000),
        },
        { role: 'user', content: 'run tool 2' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: '2', name: 'read_file' }],
        },
        {
          role: 'tool',
          toolCallId: '2',
          name: 'read_file',
          content: 'x'.repeat(4000),
        },
        { role: 'user', content: 'run tool 3' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: '3', name: 'read_file' }],
        },
        {
          role: 'tool',
          toolCallId: '3',
          name: 'read_file',
          content: 'x'.repeat(4000),
        },
        { role: 'user', content: 'run tool 4' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: '4', name: 'read_file' }],
        },
        {
          role: 'tool',
          toolCallId: '4',
          name: 'read_file',
          content: 'x'.repeat(4000),
        },
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
        { role: 'user', content: 'huge prompt 1 ' + 'a'.repeat(5000) },
        { role: 'assistant', content: 'reply 1' },
        { role: 'user', content: 'huge prompt 2 ' + 'b'.repeat(5000) },
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
        { role: 'user', content: 'first request ' + 'a'.repeat(7000) },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 't1', name: 'read_file', args: { path: 'main.tex' } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 't1',
          name: 'read_file',
          content: 'x'.repeat(400),
        },
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
          toolCalls: [
            { id: 't1', name: 'read_file', args: { path: 'main.tex' } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 't1',
          name: 'read_file',
          content: 'x'.repeat(20000),
        },
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
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: `${i}`, name: 'read_file', args: { path: 'main.tex' } },
          ],
        })
        messages.push({
          role: 'tool',
          toolCallId: `${i}`,
          name: 'read_file',
          content: 'x'.repeat(8800),
        })
      }
      messages.push({ role: 'user', content: 'latest' })
      // budget = 20000 - 1000 - 2000 = 17000; target = 11900
      const limits = { contextWindow: 20000, maxOutputTokens: 1000 }

      const result = applyContextBudget({ system: 'Sys', messages, limits })

      const elided = result.messages.filter(
        m => m.role === 'tool' && m.content.includes('"elided":true')
      )
      expect(result.exhausted).to.equal(false)
      expect(elided).to.have.length(3)
      expect(estimateMessagesTokens('Sys', result.messages)).to.be.at.most(
        Math.floor(17000 * TRIM_TARGET_FRACTION)
      )

      // The next step appends a small turn: nothing earlier changes.
      const next = [
        ...result.messages,
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'more' },
      ]
      const again = applyContextBudget({
        system: 'Sys',
        messages: next,
        limits,
      })
      expect(again.messages.slice(0, result.messages.length)).to.deep.equal(
        result.messages
      )
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

    expect(
      mockStore.appendEvent.calledWith(
        'run-exhausted',
        sinon.match({
          type: 'error',
          code: 'contextExhausted',
        })
      )
    ).to.be.true
    expect(
      mockStore.appendEvent.calledWith(
        'run-exhausted',
        sinon.match({
          type: 'turnFinished',
          reason: 'stop',
        })
      )
    ).to.be.true
    expect(mockStore.updateStatus.calledWith('run-exhausted', 'done')).to.be
      .true
    expect(mockClient.streamChat.called).to.be.false
  })

  it('does not ask for approval of an edit that cannot apply', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'e1',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'nope', newText: 'x' },
        }
      } else {
        yield { type: 'text', text: 'Let me read the file first.' }
      }
    })
    mockTools.checkEdit = sinon
      .stub()
      .resolves({ status: 'noMatch', error: 'Could not find target text' })

    await manager.startRun({
      runId: 'run-nomatch',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'edit' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    expect(mockStore.setPendingApproval.called).to.equal(false)
    expect(mockTools.execute.calledWith('edit_file')).to.equal(false)
    expect(
      mockStore.appendEvent.calledWith(
        'run-nomatch',
        sinon.match({
          type: 'toolCallFinished',
          id: 'e1',
          result: sinon.match({ status: 'noMatch' }),
        })
      )
    ).to.be.true
  })

  it('follows a planned edit to the file that actually contains the anchor', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'e2',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'intro', newText: 'x' },
        }
      } else {
        yield { type: 'text', text: 'ok' }
      }
    })
    mockTools.checkEdit = sinon
      .stub()
      .resolves({ status: 'ok', path: 'chapters/intro.tex' })

    const runPromise = manager.startRun({
      runId: 'run-redirect',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'edit' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })
    await new Promise(r => setTimeout(r, 10))

    expect(
      mockStore.setPendingApproval.calledWith(
        'run-redirect',
        sinon.match({
          edit: sinon.match({ path: 'chapters/intro.tex' }),
        })
      )
    ).to.be.true

    await manager.approveEdit('run-redirect', { accepted: true })
    await runPromise
  })

  it('renders tool results as text for the provider and renders history the same way', async function () {
    const readResult = {
      path: 'main.tex',
      from: 1,
      to: 1,
      totalLines: 1,
      content: '1: hi',
      truncated: false,
    }
    let secondRequest = null
    let callCount = 0
    mockClient.streamChat.callsFake(async function* (opts) {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'r1',
          name: 'read_file',
          args: { path: 'main.tex' },
        }
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

    const { toAgentMessages } =
      await import('../../../app/src/AiAssistRunManager.mjs')
    const rebuilt = toAgentMessages([
      { role: 'user', text: 'read' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
            result: readResult,
          },
        ],
      },
    ]).find(m => m.role === 'tool')
    expect(rebuilt.content).to.equal(live.content)
    expect(rebuilt).to.include({ name: 'read_file', isError: false })
  })

  it('executes the leading read-only calls of a turn concurrently, keeping event order', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call',
          id: 'a',
          name: 'read_file',
          args: { path: 'a.tex' },
        }
        yield {
          type: 'tool_call',
          id: 'b',
          name: 'search_text',
          args: { query: 'x' },
        }
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
        yield {
          type: 'tool_call',
          id: 'e',
          name: 'edit_file',
          args: { path: 'a.tex', oldText: 'x', newText: 'y' },
        }
        yield {
          type: 'tool_call',
          id: 'r',
          name: 'read_file',
          args: { path: 'a.tex' },
        }
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
      const text =
        'I will now edit the document.\n```json\n{\n  "name": "edit_file",\n  "arguments": { "path": "main.tex", "oldText": "a", "newText": "b" }\n}\n```'
      const extracted = extractTextToolCall(text, specs)
      expect(extracted).to.exist
      expect(extracted.call.name).to.equal('edit_file')
      expect(extracted.call.args).to.deep.equal({
        path: 'main.tex',
        oldText: 'a',
        newText: 'b',
      })
      expect(extracted.prose).to.equal('I will now edit the document.')
    })

    it('rescues text-based tool call when model outputs fenced tool call after thinking', async function () {
      mockTools.getToolSpecs = () => [
        {
          name: 'edit_file',
          description: 'e',
          parameters: { type: 'object', properties: {} },
        },
      ]
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

      expect(
        mockStore.setPendingApproval.calledWith(
          'run-text-rescue',
          sinon.match({
            edit: sinon.match({ path: 'main.tex' }),
          })
        )
      ).to.be.true

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
        checkEdit: async () => ({
          status: 'ok',
          path: 'main.tex',
          oldText: 'a',
          newText: 'b',
        }),
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
            yield {
              type: 'tool_call',
              id: 'call_1',
              name: 'edit_file',
              args: { path: 'main.tex', oldText: 'a', newText: 'b' },
            }
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
        execute: async () => {
          toolExecuted = true
        },
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
            yield {
              type: 'tool_call',
              id: 'call_edit',
              name: 'edit_file',
              args: { path: 'main.tex', newText: 'foo' },
            }
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
      expect(names).to.include('edit_file')

      const finishedCall = capturedEvents.find(
        e => e.type === 'toolCallFinished' && e.id === 'call_edit'
      )
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
            yield {
              type: 'tool_call',
              id: 'call_plan',
              name: 'present_plan',
              args: { plan: 'Step 1: edit main.tex' },
            }
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
      await manager.approveEdit('test_present_plan', {
        accepted: true,
        nextMode: 'acceptEdits',
      })
      await runPromise

      const modeChangedEvent = capturedEvents.find(
        e => e.type === 'modeChanged'
      )
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
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
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

      // The second request carries it, assembled envelope-first like a stored
      // turn, with the note that it came in while the model was working.
      expect(sentMessages[1]).to.include(
        `<project-context turn="2"/>\n\nalso check the bibliography\n\n${SENT_DURING_RUN_NOTE}`
      )
      // As the last message: appended after the tool result, nothing moved
      expect(sentMessages[1].at(-1)).to.include('also check the bibliography')
      expect(
        mockStore.appendEvent.calledWith(
          'run-queue',
          sinon.match({
            type: 'userMessage',
            id: 'q1',
            text: 'also check the bibliography',
            contextText: '<project-context turn="2"/>',
          })
        )
      ).to.be.true
    })

    it('keeps the run going when a message lands as the model finishes', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'text', text: 'Done.' }
          await manager.queueMessage('run-late', {
            id: 'q1',
            text: 'one more thing',
          })
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
        mockStore.appendEvent
          .getCalls()
          .filter(c => c.args[1]?.type === 'turnFinished')
      ).to.have.lengthOf(1)
    })

    it('clears the decline block so a new instruction can edit again', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield {
            type: 'tool_call',
            id: 'e1',
            name: 'edit_file',
            args: { path: 'main.tex', oldText: 'a', newText: 'b' },
          }
        } else if (turn === 2) {
          await manager.queueMessage('run-unblock', {
            id: 'q1',
            text: 'try this instead',
          })
          yield { type: 'text', text: 'Understood.' }
        } else if (turn === 3) {
          yield {
            type: 'tool_call',
            id: 'e2',
            name: 'edit_file',
            args: { path: 'main.tex', oldText: 'a', newText: 'c' },
          }
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
        .find(
          c => c.args[1]?.type === 'toolCallFinished' && c.args[1]?.id === 'e2'
        )
      expect(secondEdit?.args[1]?.result?.status).to.not.equal('rejected')
    })

    it('stores the run so the next run resends the bytes this one sent', async function () {
      const transcript = [
        {
          id: 'u0',
          role: 'user',
          text: 'fix the preamble',
          contextText: '<project-context turn="1"/>',
        },
      ]
      const requests = []
      let turn = 0
      mockClient.streamChat.callsFake(async function* (opts) {
        turn++
        requests.push(JSON.parse(JSON.stringify(opts.messages)))
        if (turn === 1) {
          yield { type: 'text', text: 'Reading both.' }
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
          yield {
            type: 'tool_call',
            id: 'r2',
            name: 'read_file',
            args: { path: 'refs.bib' },
          }
        } else if (turn === 2) {
          // Calls and no text, straight after the previous request's calls
          yield {
            type: 'tool_call',
            id: 's1',
            name: 'search_text',
            args: { query: 'title' },
          }
          await manager.queueMessage('run-roundtrip', {
            id: 'q1',
            text: 'also the date',
            contextText: '<project-context turn="2"/>',
          })
        } else if (turn === 3) {
          yield { type: 'text', text: 'Both now.' }
          yield {
            type: 'tool_call',
            id: 'r3',
            name: 'read_file',
            args: { path: 'main.tex', from: 1 },
          }
        } else {
          yield { type: 'text', text: 'Done: title and date.' }
        }
      })

      await manager.startRun({
        runId: 'run-roundtrip',
        projectId: 'p1',
        userId: 'u1',
        transcript,
        providerSettings: { type: 'anthropic', apiKey: 'k', model: 'claude' },
      })

      // What the panel stores, from the events as they reach it, by its own
      // reducer
      let state = emptyAgentState(transcript)
      for (const call of mockStore.appendEvent.getCalls()) {
        state = reduceAgentEvent(
          state,
          JSON.parse(JSON.stringify(call.args[1]))
        )
      }
      const rebuilt = toAgentMessages(state.transcript)

      // Tool calls compared by what reaches the provider: id, name, args
      const wireShape = messages =>
        JSON.stringify(
          messages.map(({ toolCalls, ...message }) =>
            toolCalls
              ? {
                  ...message,
                  toolCalls: toolCalls.map(({ id, name, args }) => ({
                    id,
                    name,
                    args,
                  })),
                }
              : message
          )
        )
      const lastRequest = requests.at(-1)
      expect(lastRequest.map(m => m.role)).to.deep.equal([
        'user',
        'assistant',
        'tool',
        'tool',
        'assistant',
        'tool',
        'user',
        'assistant',
        'tool',
      ])
      expect(wireShape(rebuilt.slice(0, lastRequest.length))).to.equal(
        wireShape(lastRequest)
      )
      expect(rebuilt.slice(lastRequest.length)).to.deep.equal([
        { role: 'assistant', content: 'Done: title and date.' },
      ])
    })

    it('lets a waiting message take the reply instead of nudging an empty one', async function () {
      let turn = 0
      const requests = []
      mockClient.streamChat.callsFake(async function* (opts) {
        turn++
        requests.push(opts.messages.map(m => m.content))
        if (turn === 1) {
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
        } else if (turn === 2) {
          // Ends with nothing to say, as a message comes in
          await manager.queueMessage('run-no-nudge', {
            id: 'q1',
            text: 'what did you find?',
          })
        } else {
          yield { type: 'text', text: 'The preamble loads graphicx twice.' }
        }
      })

      await manager.startRun({
        runId: 'run-no-nudge',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'check the preamble' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(requests).to.have.length(3)
      expect(requests[2].at(-1)).to.include('what did you find?')
      expect(requests[2].some(c => c === FINAL_REPLY_NUDGE)).to.be.false
    })

    it('turns a message away once the run has looked at its queue for the last time', async function () {
      let lateAnswer = null
      mockStore.appendEvent.callsFake(async (runId, event) => {
        if (event.type === 'turnFinished') {
          lateAnswer = await manager.queueMessage(runId, {
            id: 'q-late',
            text: 'one more',
          })
        }
        return 1
      })
      mockClient.streamChat.callsFake(async function* () {
        yield { type: 'text', text: 'Done.' }
      })

      await manager.startRun({
        runId: 'run-closing',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'go' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(lateAnswer).to.equal(false)
      expect(mockClient.streamChat.callCount).to.equal(1)
    })

    it('turns messages away once the run is stopped', async function () {
      let answer = null
      mockClient.streamChat.callsFake(async function* () {
        await manager.stopLocalRun('run-stopping')
        answer = await manager.queueMessage('run-stopping', {
          id: 'q1',
          text: 'hello?',
        })
        yield { type: 'text', text: 'never read' }
      })

      await manager.startRun({
        runId: 'run-stopping',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'go' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(answer).to.equal(false)
    })

    it('lets a message be taken back until the run reads it', async function () {
      let turn = 0
      const requests = []
      const answers = {}
      mockClient.streamChat.callsFake(async function* (opts) {
        turn++
        requests.push(opts.messages.map(m => m.content))
        if (turn === 1) {
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
          await manager.queueMessage('run-take-back', {
            id: 'q1',
            text: 'never mind',
          })
          await manager.queueMessage('run-take-back', {
            id: 'q2',
            text: 'keep this one',
          })
          answers.unread = await manager.unqueueMessage('run-take-back', 'q1')
        } else {
          answers.read = await manager.unqueueMessage('run-take-back', 'q2')
          yield { type: 'text', text: 'Kept.' }
        }
      })

      await manager.startRun({
        runId: 'run-take-back',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'go' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(answers).to.deep.equal({ unread: true, read: false })
      expect(requests[1].some(c => c.includes('never mind'))).to.be.false
      expect(requests[1].some(c => c.includes('keep this one'))).to.be.true
      const announced = mockStore.appendEvent
        .getCalls()
        .filter(c => c.args[1]?.type === 'userMessage')
        .map(c => c.args[1].id)
      expect(announced).to.deep.equal(['q2'])
    })

    it('rebuilds an entry stored before calls recorded their request as one message', function () {
      const read = (id, content) => ({
        id,
        name: 'read_file',
        args: { path: id },
        result: { content },
      })
      const entry = {
        id: 'a1',
        role: 'assistant',
        text: 'Looked.',
        toolCalls: [read('c1', 'x'), read('c2', 'y')],
        blocks: [
          { type: 'tool_call', call: read('c1', 'x') },
          { type: 'text', text: 'Looked.' },
          { type: 'tool_call', call: read('c2', 'y') },
        ],
      }

      const messages = toAgentMessages([{ role: 'user', text: 'go' }, entry])

      expect(messages.map(m => m.role)).to.deep.equal([
        'user',
        'assistant',
        'tool',
        'tool',
      ])
      expect(messages[1].content).to.equal('Looked.')
      expect(messages[1].toolCalls.map(c => c.id)).to.deep.equal(['c1', 'c2'])
    })

    it('splits requests that made calls without writing anything', function () {
      const read = (id, step) => ({
        id,
        name: 'read_file',
        args: { path: id },
        result: { content: id },
        step,
      })
      const calls = [read('c1', 1), read('c2', 2), read('c3', 2)]
      const entry = {
        id: 'a1',
        role: 'assistant',
        text: 'Done.',
        toolCalls: calls,
        blocks: [
          ...calls.map(call => ({ type: 'tool_call', call })),
          { type: 'thinking', thinking: 'all read' },
          { type: 'text', text: 'Done.' },
        ],
      }

      const messages = toAgentMessages([{ role: 'user', text: 'go' }, entry])

      expect(messages.map(m => m.role)).to.deep.equal([
        'user',
        'assistant',
        'tool',
        'assistant',
        'tool',
        'tool',
        'assistant',
      ])
      expect(messages[1].toolCalls.map(c => c.id)).to.deep.equal(['c1'])
      expect(messages[3].toolCalls.map(c => c.id)).to.deep.equal(['c2', 'c3'])
      expect(messages[6]).to.deep.equal({ role: 'assistant', content: 'Done.' })
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
          yield {
            type: 'tool_call',
            id: 'e1',
            name: 'edit_file',
            args: { path: 'main.tex', oldText: 'a', newText: 'b' },
          }
        } else if (turn === 2) {
          yield {
            type: 'tool_call',
            id: 'e2',
            name: 'edit_file',
            args: { path: 'main.tex', oldText: 'a', newText: 'c' },
          }
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
      expect(
        mockStore.appendEvent.calledWith(
          'run-blocked',
          sinon.match({
            type: 'toolCallFinished',
            id: 'e2',
            result: sinon.match({ status: 'rejected' }),
          })
        )
      ).to.be.true
      expect(mockTools.execute.calledWith('edit_file')).to.be.false
      expect(mockStore.updateStatus.calledWith('run-blocked', 'done')).to.be
        .true
    })

    it('counts a turn whose calls all failed once, however many calls it made', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        for (let i = 0; i < 3; i++) {
          yield {
            type: 'tool_call',
            id: `r${turn}-${i}`,
            name: 'read_file',
            args: { path: `missing-${turn}-${i}.tex` },
          }
        }
      })
      mockTools.execute.resolves({ error: 'File not found' })

      await start('run-turns')

      expect(mockClient.streamChat.callCount).to.equal(4)
      expect(
        mockStore.appendEvent.calledWith(
          'run-turns',
          sinon.match({ type: 'error', code: 'consecutiveToolFailures' })
        )
      ).to.be.true
      expect(
        mockStore.appendEvent
          .getCalls()
          .filter(c => c.args[1]?.type === 'turnFinished')
      ).to.have.lengthOf(1)
    })

    it('forgets earlier failures once a call changes the project', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 3) {
          yield {
            type: 'tool_call',
            id: `s${turn}`,
            name: 'configure_editor_settings',
            args: { mode: 'vim' },
          }
        } else if (turn <= 5) {
          yield {
            type: 'tool_call',
            id: `r${turn}`,
            name: 'read_file',
            args: { path: 'missing.tex' },
          }
        } else {
          yield { type: 'text', text: 'done' }
        }
      })
      mockTools.execute.callsFake(async name =>
        name === 'configure_editor_settings'
          ? { status: 'applied' }
          : { error: 'File not found' }
      )

      const runPromise = start('run-forget')
      await new Promise(r => setTimeout(r, 20))
      await manager.approveEdit('run-forget', { accepted: true })
      await runPromise

      expect(mockClient.streamChat.callCount).to.equal(6)
      expect(
        mockStore.appendEvent.calledWith(
          'run-forget',
          sinon.match({ type: 'error' })
        )
      ).to.be.false
    })

    it('does not count get_compile_result with nothing compiled as a failure', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn <= 3) {
          yield {
            type: 'tool_call',
            id: `g${turn}`,
            name: 'get_compile_result',
            args: {},
          }
        } else {
          yield { type: 'text', text: 'Nothing has been compiled yet.' }
        }
      })
      mockTools.execute.resolves({
        status: 'none',
        message: 'No compile has run in this chat yet.',
      })

      await start('run-none')

      expect(mockClient.streamChat.callCount).to.equal(4)
      expect(
        mockStore.appendEvent.calledWith(
          'run-none',
          sinon.match({ type: 'error' })
        )
      ).to.be.false
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
          yield {
            type: 'tool_call',
            id: 'e1',
            name: 'edit_file',
            args: {
              path: 'main.tex',
              oldText: 'a',
              newText: 'half of it',
              _repaired: true,
            },
          }
          yield { type: 'stop', reason: 'max_tokens' }
        } else {
          yield { type: 'text', text: 'ok' }
        }
      })
      mockTools.checkEdit = sinon
        .stub()
        .resolves({ status: 'ok', path: 'main.tex' })

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
          yield {
            type: 'tool_call',
            id: 'c1',
            name: 'create_file',
            args: { path: 'new.tex', content: 'x', _repaired: true },
          }
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
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex', _repaired: true },
          }
        } else {
          yield { type: 'text', text: 'ok' }
        }
      })

      await start('run-repaired-read')

      expect(mockTools.execute.calledWith('read_file', { path: 'main.tex' })).to
        .be.true
    })

    it('reports a text reply cut off at the output limit', async function () {
      mockClient.streamChat.callsFake(async function* () {
        yield { type: 'text', text: 'A long answer that' }
        yield { type: 'stop', reason: 'max_tokens' }
      })

      await start('run-cut-text')

      expect(
        mockStore.appendEvent.calledWith(
          'run-cut-text',
          sinon.match({ type: 'error', code: 'outputTruncated' })
        )
      ).to.be.true
      expect(mockStore.updateStatus.calledWith('run-cut-text', 'done')).to.be
        .true
    })
  })

  describe('web tools', function () {
    const start = (runId, extra = {}) =>
      manager.startRun({
        runId,
        projectId: 'p1',
        userId: 'u1',
        transcript: [
          {
            role: 'user',
            content: 'which siunitx option sets the range word?',
          },
        ],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
        ...extra,
      })

    it('offers web_search and web_fetch only to runs with web search settings', async function () {
      const webTools = {
        getToolSpecs: () => [
          {
            name: 'web_search',
            description: 'd',
            parameters: { type: 'object', properties: {} },
          },
        ],
        execute: sinon.stub(),
      }
      const webToolsFactory = sinon.stub().returns(webTools)
      manager = new AiAssistRunManager({
        store: mockStore,
        tools: mockTools,
        clientFactory: () => mockClient,
        webToolsFactory,
      })
      mockClient.streamChat.callsFake(async function* () {
        yield { type: 'text', text: 'ok' }
      })

      await start('run-no-web')
      const withoutWeb = mockClient.streamChat.firstCall.args[0]
      expect(withoutWeb.tools.map(t => t.name)).not.to.include('web_search')
      expect(withoutWeb.system).not.to.include('# Web research')
      expect(webToolsFactory.called).to.be.false

      await start('run-web', {
        webSearchSettings: { type: 'searxng', baseUrl: 'http://searxng:8080' },
      })
      const withWeb = mockClient.streamChat.secondCall.args[0]
      expect(
        webToolsFactory.calledOnceWith({
          type: 'searxng',
          baseUrl: 'http://searxng:8080',
        })
      ).to.be.true
      expect(webToolsFactory.firstCall.args[1]).to.deep.equal({
        userId: 'u1',
        contextWindow: 200000,
      })
      expect(withWeb.tools.map(t => t.name)).to.include('web_search')
      expect(withWeb.system).to.include('# Web research')
    })

    it('runs web calls through the web tools, in parallel with project reads', async function () {
      const webTools = {
        getToolSpecs: () => [
          {
            name: 'web_search',
            description: 'd',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        ],
        execute: sinon.stub().resolves({
          query: 'siunitx',
          results: [{ title: 'T', url: 'https://ctan.org', snippet: 's' }],
        }),
      }
      manager = new AiAssistRunManager({
        store: mockStore,
        tools: mockTools,
        clientFactory: () => mockClient,
        webToolsFactory: () => webTools,
      })
      let secondRequest = null
      let turn = 0
      mockClient.streamChat.callsFake(async function* (opts) {
        turn++
        if (turn === 1) {
          yield {
            type: 'tool_call',
            id: 'w1',
            name: 'web_search',
            args: { query: 'siunitx' },
          }
          yield { type: 'tool_call', id: 'g1', name: 'get_packages', args: {} }
        } else {
          secondRequest = opts
          yield { type: 'text', text: 'Use range-phrase.' }
        }
      })

      await start('run-web-call', {
        webSearchSettings: { type: 'ollama', apiKey: 'k' },
      })

      expect(
        webTools.execute.calledOnceWith('web_search', { query: 'siunitx' })
      ).to.be.true
      expect(webTools.execute.firstCall.args[2].signal).to.be.an.instanceOf(
        AbortSignal
      )
      expect(mockTools.execute.calledWith('web_search')).to.be.false
      expect(mockTools.execute.calledWith('get_packages')).to.be.true
      const toolMessage = secondRequest.messages.find(
        m => m.role === 'tool' && m.name === 'web_search'
      )
      expect(toolMessage.content).to.include('<web_results query="siunitx">')
    })

    describe('web call budget', function () {
      const NUDGE = `That is ${WEB_CALL_NUDGE} web calls for this request.`
      let webTools
      let sent

      const search = n => ({
        type: 'tool_call',
        id: `w${n}`,
        name: 'web_search',
        args: { query: `query ${n}` },
      })

      beforeEach(function () {
        webTools = {
          getToolSpecs: () => [
            {
              name: 'web_search',
              description: 'd',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
              },
            },
          ],
          execute: sinon.stub().callsFake(async (name, args) => ({
            query: args.query,
            results: [],
          })),
        }
        manager = new AiAssistRunManager({
          store: mockStore,
          tools: mockTools,
          clientFactory: () => mockClient,
          webToolsFactory: () => webTools,
        })
        sent = []
      })

      // The tool results the model had seen when it made its last request.
      const webResults = () =>
        sent
          .at(-1)
          .filter(m => m.role === 'tool' && m.name === 'web_search')
          .map(m => m.content)

      it('tells the model once to answer after the web call budget, without counting project tools', async function () {
        let turn = 0
        mockClient.streamChat.callsFake(async function* (opts) {
          turn++
          sent.push(opts.messages.map(m => ({ ...m })))
          if (turn === 1) {
            yield {
              type: 'tool_call',
              id: 'g1',
              name: 'get_packages',
              args: {},
            }
          }
          if (turn <= WEB_CALL_NUDGE + 1) {
            yield search(turn)
          } else {
            yield { type: 'text', text: 'Done.' }
          }
        })

        await start('run-web-budget', {
          webSearchSettings: { type: 'ollama', apiKey: 'k' },
        })

        const results = webResults()
        expect(results).to.have.length(WEB_CALL_NUDGE + 1)
        results.forEach((content, index) => {
          if (index === WEB_CALL_NUDGE - 1) {
            expect(content).to.include(NUDGE)
          } else {
            expect(content).not.to.include(NUDGE)
          }
        })
        expect(webTools.execute.callCount).to.equal(WEB_CALL_NUDGE + 1)
      })

      it('does not count more pages or finds of a document already read', async function () {
        webTools.getToolSpecs = () => [
          {
            name: 'web_fetch',
            description: 'd',
            parameters: {
              type: 'object',
              properties: { url: { type: 'string' } },
            },
          },
        ]
        webTools.execute = sinon.stub().callsFake(async (name, args) => ({
          url: 'https://docs.example.org/manual',
          page: args.page ?? 1,
          totalPages: 20,
          content: 'text',
        }))
        let turn = 0
        mockClient.streamChat.callsFake(async function* (opts) {
          turn++
          sent.push(opts.messages.map(m => ({ ...m })))
          if (turn <= WEB_CALL_NUDGE + 2) {
            yield {
              type: 'tool_call',
              id: `f${turn}`,
              name: 'web_fetch',
              // The first read spells the address loosely; the rest page on
              args:
                turn === 1
                  ? { url: 'docs.example.org/manual#units' }
                  : turn % 2
                    ? { url: 'https://docs.example.org/manual', page: turn }
                    : { url: 'https://www.docs.example.org/manual/', find: `t${turn}` },
            }
          } else {
            yield { type: 'text', text: 'Done.' }
          }
        })

        await start('run-web-paging', {
          webSearchSettings: { type: 'ollama', apiKey: 'k' },
        })

        const results = sent
          .at(-1)
          .filter(m => m.role === 'tool' && m.name === 'web_fetch')
          .map(m => m.content)
        expect(results).to.have.length(WEB_CALL_NUDGE + 2)
        expect(results.filter(content => content.includes(NUDGE))).to.be.empty
      })

      it('starts the count again for a message queued during the run', async function () {
        let turn = 0
        mockClient.streamChat.callsFake(async function* (opts) {
          turn++
          sent.push(opts.messages.map(m => ({ ...m })))
          if (turn < WEB_CALL_NUDGE) {
            yield search(turn)
            if (turn === WEB_CALL_NUDGE - 1) {
              await manager.queueMessage('run-web-queued', {
                id: 'q1',
                text: 'and the other package?',
                contextText: '<project-context turn="2"/>',
              })
            }
          } else if (turn < 2 * WEB_CALL_NUDGE - 1) {
            yield search(turn)
          } else {
            yield { type: 'text', text: 'Done.' }
          }
        })

        await start('run-web-queued', {
          webSearchSettings: { type: 'ollama', apiKey: 'k' },
        })

        const results = webResults()
        expect(results).to.have.length(2 * WEB_CALL_NUDGE - 2)
        expect(results.filter(content => content.includes(NUDGE))).to.be.empty
      })
    })
  })

  describe('tool results the next run can rebuild', function () {
    const provider = { type: 'anthropic', apiKey: 'k', model: 'claude-x' }

    it('puts a mid-run mode switch on the next tool result, once', async function () {
      mockStore.setMode = sinon.stub().resolves()
      let secondRequest = null
      let callCount = 0
      mockClient.streamChat.callsFake(async function* (opts) {
        callCount++
        if (callCount === 1) {
          yield { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'a.tex' } }
          yield { type: 'tool_call', id: 'r2', name: 'read_file', args: { path: 'b.tex' } }
        } else {
          secondRequest = opts
          yield { type: 'text', text: 'done' }
        }
      })
      let switched = false
      mockTools.execute.callsFake(async () => {
        if (!switched) {
          switched = true
          await manager.setMode('run-mode-notice', 'acceptEdits')
        }
        return { content: 'x' }
      })

      await manager.startRun({
        runId: 'run-mode-notice',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'read them' }],
        providerSettings: provider,
      })

      const finished = mockStore.appendEvent.args
        .map(([, event]) => event)
        .filter(event => event.type === 'toolCallFinished')
      const noticed = finished.filter(e => e.result?.notice)
      expect(noticed).to.have.length(1)
      expect(noticed[0].result.notice).to.equal(
        'The user switched to Accept edits mode.'
      )
      const toolMessages = secondRequest.messages.filter(m => m.role === 'tool')
      expect(
        toolMessages.filter(m =>
          m.content.endsWith('The user switched to Accept edits mode.')
        )
      ).to.have.length(1)
    })

    it('rebuilds tool messages exactly as the live run sent them', async function () {
      let secondRequest = null
      let callCount = 0
      mockClient.streamChat.callsFake(async function* (opts) {
        callCount++
        if (callCount === 1) {
          yield { type: 'tool_call', id: 'e1', name: 'read_file', args: { path: 'a.tex' } }
        } else {
          secondRequest = opts
          yield { type: 'text', text: 'done' }
        }
      })
      mockTools.execute.resolves({ status: 'noMatch', message: 'not found' })
      await manager.startRun({
        runId: 'run-rebuild',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'edit' }],
        providerSettings: provider,
      })
      const live = secondRequest.messages.find(m => m.role === 'tool')
      const event = mockStore.appendEvent.args
        .map(([, e]) => e)
        .find(e => e.type === 'toolCallFinished')
      const rebuilt = toAgentMessages([
        { role: 'user', content: 'edit' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            {
              id: 'e1',
              name: 'read_file',
              args: {},
              result: event.result,
              isError: event.isError,
            },
          ],
        },
      ]).find(m => m.role === 'tool')
      expect(rebuilt.content).to.equal(live.content)
      expect(rebuilt.isError).to.equal(live.isError)
      expect(live.isError).to.equal(true)
    })

    it('treats noMatch and ambiguous as failed tool messages', function () {
      expect(toolMessageIsError({ status: 'noMatch' }, false)).to.equal(true)
      expect(toolMessageIsError({ status: 'ambiguous' }, false)).to.equal(true)
      expect(toolMessageIsError({ status: 'denied' }, true)).to.equal(false)
      expect(toolMessageIsError({ error: 'x' }, false)).to.equal(true)
      expect(toolMessageIsError({ content: 'ok' }, false)).to.equal(false)
    })
  })

  describe('prompt prefix', function () {
    const provider = { type: 'anthropic', apiKey: 'k', model: 'claude-x' }
    const startWith = (m, runId, extra = {}) =>
      m.startRun({
        runId,
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'hi' }],
        providerSettings: provider,
        ...extra,
      })

    beforeEach(function () {
      mockClient.streamChat.callsFake(async function* () {
        yield { type: 'text', text: 'ok' }
      })
      mockTools.getToolSpecs = () => [
        {
          name: 'read_file',
          description: 'r',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'edit_file',
          description: 'e',
          parameters: { type: 'object', properties: {} },
        },
      ]
    })

    it('sends the same system prompt and tools whatever the mode', async function () {
      await startWith(manager, 'run-plan', { mode: 'plan' })
      await startWith(manager, 'run-accept', { mode: 'acceptEdits' })
      const [plan, accept] = mockClient.streamChat.args.map(([a]) => a)
      expect(plan.system).to.equal(accept.system)
      expect(plan.tools).to.deep.equal(accept.tools)
      expect(plan.tools.map(t => t.name)).to.deep.equal([
        'read_file',
        'edit_file',
        'present_plan',
      ])
      expect(plan.cacheHints.systemPrefix).to.equal(plan.system)
    })

    it('keeps the prefix byte-identical across a plan approval and a mode switch mid-run', async function () {
      mockStore.setMode = sinon.stub().resolves()
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield {
            type: 'tool_call',
            id: 'p1',
            name: 'present_plan',
            args: { plan: 'Fix the title.' },
          }
        } else if (turn === 2) {
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
          await manager.setMode('run-modes', 'manual')
        } else {
          yield { type: 'text', text: 'Done.' }
        }
      })

      const run = startWith(manager, 'run-modes', { mode: 'plan' })
      await new Promise(resolve => setTimeout(resolve, 20))
      await manager.approveEdit('run-modes', {
        accepted: true,
        nextMode: 'acceptEdits',
      })
      await run

      const requests = mockClient.streamChat.args.map(([a]) => a)
      expect(requests).to.have.length(3)
      for (const request of requests.slice(1)) {
        expect(request.system).to.equal(requests[0].system)
        expect(JSON.stringify(request.tools)).to.equal(
          JSON.stringify(requests[0].tools)
        )
      }
      // The switches reach the model in the conversation instead
      const results = requests[2].messages.filter(m => m.role === 'tool')
      expect(results[0].content).to.include('Accept edits')
      expect(results[1].content).to.include('switched to Manual mode')
    })

    it('reads AGENTS.md once for the run, so an edit mid-run keeps the cache', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
        } else {
          yield { type: 'text', text: 'Done.' }
        }
      })
      mockTools.getProjectInstructions = sinon
        .stub()
        .onFirstCall()
        .resolves({ path: 'AGENTS.md', text: 'Use British spelling.' })
        .onSecondCall()
        .resolves({ path: 'AGENTS.md', text: 'Edited while running.' })
      const m = new AiAssistRunManager({
        store: mockStore,
        tools: mockTools,
        clientFactory: () => mockClient,
      })

      await startWith(m, 'run-agents-frozen')

      const [first, second] = mockClient.streamChat.args.map(([a]) => a)
      expect(second.system).to.equal(first.system)
      expect(mockTools.getProjectInstructions.callCount).to.equal(1)
    })

    it('automatically adds AGENTS.md as a second block when present', async function () {
      mockTools.getProjectInstructions = sinon.stub().resolves({
        path: 'AGENTS.md',
        text: 'Use British spelling.',
      })
      const m = new AiAssistRunManager({
        store: mockStore,
        tools: mockTools,
        clientFactory: () => mockClient,
      })
      await startWith(m, 'run-agents')
      const [request] = mockClient.streamChat.firstCall.args
      expect(request.system).to.include('Use British spelling.')
      expect(request.system.startsWith(request.cacheHints.systemPrefix)).to.be
        .true
      expect(request.cacheHints.systemPrefix).not.to.include('British')
      expect(mockTools.getProjectInstructions.calledWith('p1')).to.be.true
    })

    it('keeps running when AGENTS.md cannot be read', async function () {
      mockTools.getProjectInstructions = sinon.stub().rejects(new Error('boom'))
      const m = new AiAssistRunManager({
        store: mockStore,
        tools: mockTools,
        clientFactory: () => mockClient,
      })
      await startWith(m, 'run-agents-error')
      const [request] = mockClient.streamChat.firstCall.args
      expect(request.system).not.to.include('# Project instructions')
      expect(mockStore.updateStatus.calledWith('run-agents-error', 'done')).to
        .be.true
    })

    it('rebuilds the next run from the transcript as a prefix of what was sent', async function () {
      const requests = []
      mockClient.streamChat.callsFake(async function* (opts) {
        requests.push(JSON.parse(JSON.stringify(opts.messages)))
        if (requests.length === 1) {
          yield { type: 'text', text: 'Looking.' }
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
        } else if (requests.length === 2) {
          yield { type: 'text', text: 'Reply to first question.' }
        } else {
          yield { type: 'text', text: 'Reply to second question.' }
        }
      })

      const first = [{ id: 'u0', role: 'user', text: 'first question' }]
      await manager.startRun({
        runId: 'run-seq-1',
        projectId: 'p1',
        userId: 'u1',
        transcript: first,
        providerSettings: provider,
      })

      // The panel's transcript, from the events as they reach it
      let state = emptyAgentState(first)
      for (const call of mockStore.appendEvent.getCalls()) {
        state = reduceAgentEvent(
          state,
          JSON.parse(JSON.stringify(call.args[1]))
        )
      }

      await manager.startRun({
        runId: 'run-seq-2',
        projectId: 'p1',
        userId: 'u1',
        transcript: [
          ...state.transcript,
          { id: 'u2', role: 'user', text: 'second question' },
        ],
        providerSettings: provider,
      })

      expect(requests).to.have.length(3)
      // Calls compared by what reaches the provider: id, name, args
      const wire = messages =>
        messages.map(({ toolCalls, ...message }) =>
          toolCalls
            ? {
                ...message,
                toolCalls: toolCalls.map(({ id, name, args }) => ({
                  id,
                  name,
                  args,
                })),
              }
            : message
        )
      const sent = requests[1]
      expect(wire(requests[2].slice(0, sent.length))).to.deep.equal(wire(sent))
      expect(requests[2].slice(sent.length)).to.deep.equal([
        { role: 'assistant', content: 'Reply to first question.' },
        { role: 'user', content: 'second question' },
      ])
    })
  })

  describe('rebuilding what a run sent, whatever happened during it', function () {
    const provider = { type: 'anthropic', apiKey: 'k', model: 'claude' }

    // What the panel stores from the run's events, by its own reducer
    const panelTranscript = (initial, store = mockStore) => {
      let state = emptyAgentState(initial)
      for (const call of store.appendEvent.getCalls()) {
        state = reduceAgentEvent(
          state,
          JSON.parse(JSON.stringify(call.args[1]))
        )
      }
      return state.transcript
    }
    const wire = messages =>
      JSON.parse(
        JSON.stringify(
          messages.map(({ toolCalls, ...message }) =>
            toolCalls
              ? {
                  ...message,
                  toolCalls: toolCalls.map(({ id, name, args }) => ({
                    id,
                    name,
                    args,
                  })),
                }
              : message
          )
        )
      )
    const expectPrefix = (rebuilt, sent) => {
      expect(wire(rebuilt.slice(0, sent.length))).to.deep.equal(wire(sent))
    }

    it('keeps the reply nudge in the rebuilt messages', async function () {
      const requests = []
      mockClient.streamChat.callsFake(async function* (opts) {
        requests.push(JSON.parse(JSON.stringify(opts.messages)))
        if (requests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
        } else if (requests.length === 3) {
          yield { type: 'text', text: 'Read it.' }
        }
      })
      const first = [{ id: 'u0', role: 'user', text: 'read main' }]
      await manager.startRun({
        runId: 'run-nudge-rebuild',
        projectId: 'p1',
        userId: 'u1',
        transcript: first,
        providerSettings: provider,
      })

      expect(requests[2].at(-1)).to.deep.equal({
        role: 'user',
        content: FINAL_REPLY_NUDGE,
      })
      const rebuilt = toAgentMessages(panelTranscript(first))
      expectPrefix(rebuilt, requests[2])
      expect(rebuilt.slice(requests[2].length)).to.deep.equal([
        { role: 'assistant', content: 'Read it.' },
      ])
    })

    it('stores a tool call written as text as the call the run sent', async function () {
      mockTools.getToolSpecs = () => [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ]
      const requests = []
      mockClient.streamChat.callsFake(async function* (opts) {
        requests.push(JSON.parse(JSON.stringify(opts.messages)))
        if (requests.length === 1) {
          yield { type: 'text', text: 'Reading.\n```json\n' }
          yield {
            type: 'text',
            text: '{"name":"read_file","arguments":{"path":"main.tex"}}\n```',
          }
        } else {
          yield { type: 'text', text: 'Done.' }
        }
      })
      const first = [{ id: 'u0', role: 'user', text: 'read main' }]
      await manager.startRun({
        runId: 'run-rescue-rebuild',
        projectId: 'p1',
        userId: 'u1',
        transcript: first,
        providerSettings: provider,
      })

      const transcript = panelTranscript(first)
      expect(transcript.at(-1).text).to.equal('Reading.Done.')
      expectPrefix(toAgentMessages(transcript), requests[1])
    })

    it('drops the text of a failed attempt the run retried', async function () {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] })
      try {
        const requests = []
        let attempt = 0
        mockClient.streamChat.callsFake(async function* (opts) {
          attempt++
          requests.push(JSON.parse(JSON.stringify(opts.messages)))
          if (attempt === 1) {
            yield { type: 'text', text: 'Half a rep' }
            const err = new Error('connection reset')
            err.status = 502
            throw err
          }
          if (attempt === 2) {
            yield { type: 'text', text: 'Whole reply. ' }
            yield {
              type: 'tool_call',
              id: 'r1',
              name: 'read_file',
              args: { path: 'main.tex' },
            }
          } else {
            yield { type: 'text', text: 'Done.' }
          }
        })
        const first = [{ id: 'u0', role: 'user', text: 'read main' }]
        const run = manager.startRun({
          runId: 'run-retry-rebuild',
          projectId: 'p1',
          userId: 'u1',
          transcript: first,
          providerSettings: provider,
        })
        for (let i = 0; i < 50; i++) await clock.tickAsync(1000)
        await run

        const transcript = panelTranscript(first)
        expect(transcript.at(-1).text).to.equal('Whole reply. Done.')
        expectPrefix(toAgentMessages(transcript), requests.at(-1))
      } finally {
        clock.restore()
      }
    })

    it('sends nothing for a reply that produced no text', function () {
      expect(
        toAgentMessages([
          { id: 'u0', role: 'user', text: 'one' },
          { id: 'a1', role: 'assistant', text: '', toolCalls: [], blocks: [] },
          { id: 'u2', role: 'user', text: 'two' },
        ])
      ).to.deep.equal([
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ])
    })

    it('renders a string result as the run did', function () {
      const [, , tool] = toAgentMessages([
        { id: 'u0', role: 'user', text: 'go' },
        {
          id: 'a1',
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'c1', name: 'nope', args: {}, result: 'plain', step: 1 },
          ],
          blocks: [
            {
              type: 'tool_call',
              call: { id: 'c1', name: 'nope', args: {}, result: 'plain' },
            },
          ],
        },
      ])
      expect(tool.content).to.equal(JSON.stringify('plain'))
    })

    it('cuts a rebuilt conversation where the last run had cut it', function () {
      const full = []
      for (let i = 0; i < 6; i++) {
        full.push({ role: 'user', content: `q${i}` })
        full.push({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `c${i}`, name: 'read_file', args: {} }],
        })
        full.push({
          role: 'tool',
          toolCallId: `c${i}`,
          name: 'read_file',
          content: 'x'.repeat(9000),
        })
      }
      const limits = { contextWindow: 12000, maxOutputTokens: 1000 }
      const budgeted = applyContextBudget({ system: 'S', messages: full, limits })
      const trim = recordContextTrim(null, full, budgeted.messages)
      expect(trim.elided.length + trim.dropped).to.be.greaterThan(0)

      // The next run rebuilds the whole chat with a reply and a turn added
      const next = [
        ...full,
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'more' },
      ]
      const rebuilt = applyContextTrim(next, trim)
      expect(rebuilt.trim).to.deep.equal(trim)
      expect(rebuilt.messages).to.deep.equal([
        ...budgeted.messages,
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'more' },
      ])
      // and stays under the budget, so it is not trimmed afresh
      const again = applyContextBudget({
        system: 'S',
        messages: rebuilt.messages,
        limits,
      })
      expect(again.messages).to.deep.equal(rebuilt.messages)

      expect(latestContextTrim([{ role: 'user' }, { contextTrim: trim }])).to
        .equal(trim)
      // A conversation the positions no longer fit is left alone
      expect(applyContextTrim(next.slice(3), trim).trim).to.equal(null)
    })
  })

  describe('hydrateTranscript', function () {
    const stored = [
      { id: 'u0', role: 'user', text: 'first' },
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'c1', name: 'read_file', args: {}, result: { content: 'full' } },
        ],
      },
      { id: 'u2', role: 'user', text: 'second' },
      {
        id: 'a3',
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'c2', name: 'read_file', args: {}, result: { content: 'all' } },
        ],
        blocks: [
          {
            type: 'tool_call',
            call: {
              id: 'c2',
              name: 'read_file',
              args: {},
              result: { content: 'all' },
            },
          },
        ],
      },
    ]

    it('restores results the panel cut down, and turns it dropped', function () {
      const shrunk = { content: 'a', truncated: true, _shrunk: true }
      const panel = [
        { id: 'u2', role: 'user', text: 'second' },
        {
          id: 'a3',
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'c2', name: 'read_file', args: {}, result: shrunk },
          ],
          blocks: [
            {
              type: 'tool_call',
              call: { id: 'c2', name: 'read_file', args: {}, result: shrunk },
            },
          ],
        },
        { id: 'u4', role: 'user', text: 'third' },
      ]
      const hydrated = hydrateTranscript(panel, stored)
      expect(hydrated.map(entry => entry.id)).to.deep.equal([
        'u0',
        'a1',
        'u2',
        'a3',
        'u4',
      ])
      expect(hydrated[3].toolCalls[0].result).to.deep.equal({ content: 'all' })
      expect(hydrated[3].blocks[0].call.result).to.deep.equal({
        content: 'all',
      })
    })

    it('leaves a transcript that does not line up with the history alone', function () {
      const panel = [
        { id: 'u2', role: 'user', text: 'something else' },
        { id: 'u4', role: 'user', text: 'third' },
      ]
      expect(hydrateTranscript(panel, stored)).to.deep.equal(panel)
      expect(hydrateTranscript(panel, null)).to.equal(panel)
    })
  })
})
