import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  AiAssistRunManager,
  FINAL_REPLY_NUDGE,
  SENT_DURING_RUN_NOTE,
  TRIM_TARGET_FRACTION,
  WEB_CALL_NUDGE,
  anchorAt,
  anchoredRequestCount,
  applyContextBudget,
  applyContextTrim,
  autoCompactionAllowed,
  latestContextTrim,
  queuedEntry,
  recordContextTrim,
  recordRunStep,
  usageTokens,
  extractTextToolCall,
  toAgentMessages,
  toQueuedMessage,
  toolMessageIsError,
  userTurnContent,
} from '../../../app/src/AiAssistRunManager.mjs'
import { scopeRefusal } from '../../../app/src/AiAssistSlashCommands.mjs'
import Settings from '@overleaf/settings'
import {
  emptyAgentState,
  reduceAgentEvent,
} from '../../../frontend/js/features/ai-assist/agent/agent-state.ts'
import { hydrateTranscript } from '../../../app/src/AiAssistChatHistoryStore.mjs'
import {
  contextThresholds,
  estimateRequestTokens,
  estimateToolTokens,
} from '../../../app/src/AiAssistContextUsage.mjs'

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

  it('saves the chat before the provider is reached', async function () {
    const order = []
    const chatHistoryStore = {
      saveChat: sinon.stub().callsFake(async () => {
        order.push('saveChat')
      }),
      getChat: sinon.stub().resolves(null),
      saveChatTitle: sinon.stub().resolves(null),
    }
    mockClient.streamChat.callsFake(async function* () {
      order.push('provider')
      yield { type: 'text', text: 'hello' }
    })
    manager = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
      chatHistoryStore,
    })
    const transcript = [{ id: 'u0', role: 'user', text: 'first message' }]

    await manager.startRun({
      runId: 'run-persist',
      projectId: '0123456789abcdef01234567',
      userId: 'abcdef0123456789abcdef01',
      transcript,
      providerSettings: { type: 'openai', apiKey: 'k', model: 'm' },
      mode: 'plan',
      chatId: 'chat_first',
    })

    expect(chatHistoryStore.saveChat.calledOnce).to.be.true
    expect(chatHistoryStore.saveChat.firstCall.args).to.deep.equal([
      '0123456789abcdef01234567',
      'abcdef0123456789abcdef01',
      'chat_first',
      transcript,
      'plan',
    ])
    // The provider is called for the reply and for the chat's title
    expect(order[0]).to.equal('saveChat')
    expect(order).to.include('provider')
  })

  it('does not announce a title for a chat that was not saved', async function () {
    const chatHistoryStore = {
      saveChat: sinon.stub().resolves({}),
      getChat: sinon.stub().resolves(null),
      saveChatTitle: sinon.stub().resolves(null),
    }
    mockClient.streamChat.callsFake(async function* () {
      yield { type: 'text', text: 'hello' }
    })
    manager = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
      chatHistoryStore,
    })

    await manager.startRun({
      runId: 'run-title-gone',
      projectId: '0123456789abcdef01234567',
      userId: 'abcdef0123456789abcdef01',
      transcript: [{ id: 'u0', role: 'user', text: 'first message' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'm' },
      chatId: 'chat_gone',
    })
    const deadline = Date.now() + 1000
    while (!chatHistoryStore.saveChatTitle.called && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(chatHistoryStore.saveChatTitle.called).to.be.true
    const titleEvents = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[1]?.type === 'chatTitle')
    expect(titleEvents).to.have.lengthOf(0)
  })

  it('still runs when the chat cannot be saved', async function () {
    const chatHistoryStore = {
      saveChat: sinon.stub().rejects(new Error('disk full')),
      getChat: sinon.stub().resolves(null),
      saveChatTitle: sinon.stub().resolves(null),
    }
    mockClient.streamChat.callsFake(async function* () {
      yield { type: 'text', text: 'hello' }
    })
    manager = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
      chatHistoryStore,
    })

    await manager.startRun({
      runId: 'run-persist-fail',
      projectId: '0123456789abcdef01234567',
      userId: 'abcdef0123456789abcdef01',
      transcript: [{ id: 'u0', role: 'user', text: 'hi' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'm' },
      chatId: 'chat_x',
    })

    expect(mockClient.streamChat.called).to.be.true
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

  it('emits the provider usage and a context breakdown for each step', async function () {
    mockClient.streamChat.callsFake(async function* () {
      yield { type: 'text', text: 'hello' }
      yield {
        type: 'usage',
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }
    })

    await manager.startRun({
      runId: 'run-usage',
      projectId: '0123456789abcdef01234567',
      userId: 'abcdef0123456789abcdef01',
      transcript: [{ id: 'u0', role: 'user', text: 'hi there' }],
      providerSettings: {
        type: 'openai',
        apiKey: 'k',
        model: 'gpt-x',
        contextWindow: 100000,
        maxOutputTokens: 4000,
      },
    })

    const events = mockStore.appendEvent.args.map(args => args[1])
    expect(events).to.deep.include({
      type: 'usage',
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        step: 1,
      },
      step: 1,
    })
    const breakdown = events.find(event => event.type === 'contextBreakdown')
    expect(breakdown.step).to.equal(1)
    expect(breakdown.breakdown.contextWindow).to.equal(100000)
    expect(breakdown.breakdown.maxOutputTokens).to.equal(4000)
    expect(breakdown.breakdown.budget).to.equal(
      contextThresholds({ contextWindow: 100000, maxOutputTokens: 4000 }).blockAt
    )
    expect(breakdown.breakdown.model).to.equal('gpt-x')
    expect(breakdown.breakdown.userMessages).to.be.above(0)
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

    const retryingEvents = () =>
      mockStore.appendEvent.args
        .map(args => args[1])
        .filter(event => event.type === 'retrying')

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
      await advance(300000)
      await runPromise

      expect(mockClient.streamChat.callCount).to.equal(6)
      expect(mockStore.updateStatus.calledWith('run-retry', 'done')).to.be.true
      const retries = retryingEvents()
      expect(retries.map(event => event.attempt)).to.deep.equal([1, 2, 3, 4, 5])
      expect(retries[0]).to.include({
        type: 'retrying',
        maxRetries: 10,
        message: 'Server error (500)',
        status: 500,
      })
      expect(retries[0].retryInMs).to.be.above(0)
      expect(retries[0].retryAt).to.be.a('number')
    })

    it('gives up after the tenth retry, with the error', async function () {
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
      await advance(300000)
      await runPromise

      // The first try and ten retries
      expect(mockClient.streamChat.callCount).to.equal(11)
      expect(retryingEvents()).to.have.lengthOf(10)
      expect(mockStore.updateStatus.calledWith('run-give-up', 'error')).to.be
        .true
      const errorEvent = mockStore.appendEvent.args
        .map(args => args[1])
        .find(event => event.type === 'error')
      expect(errorEvent).to.include({ status: 500, message: 'Internal Server Error (ref: abc)' })
    })

    it('reports a connect timeout as an error, not as a stop', async function () {
      mockClient.streamChat.callsFake(async function* () {
        throw Object.assign(new Error('Connection timed out'), {
          code: 'providerTimeout',
        })
      })

      const runPromise = manager.startRun({
        runId: 'run-timeout',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'hi' }],
        providerSettings: { type: 'ollama', model: 'm' },
      })
      await advance(300000)
      await runPromise

      const events = mockStore.appendEvent.args.map(args => args[1])
      expect(events.find(event => event.type === 'turnFinished')).to.be.undefined
      expect(events.find(event => event.type === 'error')).to.include({
        code: 'providerTimeout',
      })
      expect(mockStore.updateStatus.calledWith('run-timeout', 'error')).to.be
        .true
    })

    it('does not retry a request the provider refuses', async function () {
      mockClient.streamChat.callsFake(async function* () {
        throw Object.assign(new Error('Invalid API key'), {
          status: 401,
          code: 'providerAuth',
        })
      })

      const runPromise = manager.startRun({
        runId: 'run-auth',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'hi' }],
        providerSettings: { type: 'ollama', model: 'm' },
      })
      await advance(10000)
      await runPromise

      expect(mockClient.streamChat.callCount).to.equal(1)
      expect(retryingEvents()).to.have.lengthOf(0)
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
                buildId: null,
                clsiServerId: null,
              },
            },
          })
        )
      ).to.be.true
    })

    it('keeps the build the editor compiled, so its PDF can be viewed', async function () {
      mockStore.getWatcherCount = sinon.stub().resolves(1)
      scriptCompile()

      const runPromise = manager.startRun({
        runId: 'run-compile-build',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'compile' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })
      await new Promise(r => setTimeout(r, 10))
      await manager.submitCompileResult('run-compile-build', {
        id: 'comp-1',
        outcome: {
          status: 'success',
          buildId: '18f4c3a2b10-0123456789abcdef',
          clsiServerId: 'clsi-1',
        },
      })
      await runPromise

      const finished = mockStore.appendEvent.args
        .map(args => args[1])
        .find(event => event.type === 'toolCallFinished')
      expect(finished.result.outcome).to.include({
        buildId: '18f4c3a2b10-0123456789abcdef',
        clsiServerId: 'clsi-1',
      })
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

  describe('page images from view_compiled_pdf_page', function () {
    const IMAGE = { mediaType: 'image/png', data: 'iVBORw0KGgo=', dpi: 150 }
    const viewCall = id => ({
      type: 'tool_call',
      id,
      name: 'view_compiled_pdf_page',
      args: { page: 2 },
    })
    const startView = runId =>
      manager.startRun({
        runId,
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'check the table' }],
        providerSettings: { type: 'anthropic', apiKey: 'k', model: 'm' },
      })

    // What each provider request was given, as it was at the time
    let sent
    beforeEach(function () {
      sent = []
      mockTools.execute.callsFake(async (name, args, context) => ({
        status: 'ok',
        page: 2,
        sourceMap: [],
        badBoxes: [],
        ...(context.images ? { image: IMAGE } : { imageOmitted: true }),
      }))
    })

    it('sends the image with the tool message but never emits or stores its bytes', async function () {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* ({ messages }) {
        sent.push(structuredClone(messages))
        callCount++
        if (callCount === 1) yield viewCall('v1')
        else yield { type: 'text', text: 'The table fits.' }
      })

      await startView('run-view')

      const toolMessage = sent[1].find(message => message.role === 'tool')
      // The bytes go to the provider, and the token cost of the image rides
      // with them for the context budget.
      expect(toolMessage.images).to.have.length(1)
      expect(toolMessage.images[0]).to.include({
        mediaType: 'image/png',
        data: 'iVBORw0KGgo=',
      })
      expect(toolMessage.images[0].tokens).to.be.a('number')
      expect(toolMessage.content).to.include('PDF page 2')
      const finished = mockStore.appendEvent.args
        .map(args => args[1])
        .find(event => event.type === 'toolCallFinished')
      expect(finished.result.image).to.deep.equal({
        mediaType: 'image/png',
        dpi: 150,
      })
      expect(JSON.stringify(mockStore.appendEvent.args)).to.not.include(
        'iVBORw0KGgo='
      )
      expect(mockTools.execute.firstCall.args[2].images).to.equal(true)
    })

    it('carries on text-only when the model refuses images', async function () {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* ({ messages }) {
        sent.push(structuredClone(messages))
        callCount++
        if (callCount === 1) yield viewCall('v1')
        else if (callCount === 2) {
          throw Object.assign(
            new Error('This model does not support image input'),
            { status: 400 }
          )
        } else if (callCount === 3) yield viewCall('v2')
        else yield { type: 'text', text: 'Done.' }
      })

      await startView('run-view-text-only')

      expect(sent[1].some(message => message.images)).to.equal(true)
      // The same step again, without the image
      expect(sent[2]).to.have.lengthOf(sent[1].length)
      expect(sent[2].some(message => message.images)).to.equal(false)
      // and the next page is not rendered at all
      expect(mockTools.execute.secondCall.args[2].images).to.equal(false)
      expect(sent[3].some(message => message.images)).to.equal(false)
      expect(mockStore.updateStatus.calledWith('run-view-text-only', 'done')).to
        .be.true
    })

    it('keeps only the newest page images in the conversation', async function () {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* ({ messages }) {
        sent.push(structuredClone(messages))
        callCount++
        if (callCount <= 9) yield viewCall(`v${callCount}`)
        else yield { type: 'text', text: 'Done.' }
      })

      await startView('run-view-many')

      // Six images fit in the slack (4 + 4), so nothing is dropped yet
      const sixth = sent[6].filter(message => message.role === 'tool')
      expect(sixth.every(message => Boolean(message.images))).to.equal(true)
      // The ninth goes past it, and all but the newest four go at once
      const last = sent.at(-1).filter(message => message.role === 'tool')
      expect(last).to.have.lengthOf(9)
      expect(last.map(message => Boolean(message.images))).to.deep.equal([
        false,
        false,
        false,
        false,
        false,
        true,
        true,
        true,
        true,
      ])
      // Dropping an image leaves the text as the next run rebuilds it
      expect(last[0].content).to.equal(last[8].content)
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
      .filter(
        e =>
          e.type !== 'contextBreakdown' &&
          e.type !== 'usage' &&
          e.type !== 'contextUsage'
      )

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
        limits: { contextWindow: 4500, maxOutputTokens: 500 },
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
      // budget (blockAt) = 17000: an 18525 window, 1000 reserved, 3% buffer of 17525 (525); target = 11900
      const limits = { contextWindow: 18525, maxOutputTokens: 1000 }

      const result = applyContextBudget({ system: 'Sys', messages, limits })

      const elided = result.messages.filter(
        m => m.role === 'tool' && m.content.includes('"elided":true')
      )
      expect(result.exhausted).to.equal(false)
      expect(elided).to.have.length(3)
      expect(
        estimateRequestTokens({ system: 'Sys', messages: result.messages }),
      ).to.be.at.most(
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

    it('recognises the PDF view tools when the run passes no specs', function () {
      for (const name of [
        'view_compiled_pdf_overview',
        'search_compiled_pdf',
      ]) {
        const text = `\`\`\`json\n{ "name": "${name}", "arguments": { "fromPage": 1 } }\n\`\`\``
        const extracted = extractTextToolCall(text, [])
        expect(extracted.call.name).to.equal(name)
      }
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

    it('injects queued message with images into model request and emits userMessage with images', async function () {
      let turn = 0
      const sentMessages = []
      const sampleImages = [
        {
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      ]
      mockClient.streamChat.callsFake(async function* (opts) {
        turn++
        sentMessages.push(opts.messages.map(m => ({ ...m })))
        if (turn === 1) {
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
          await manager.queueMessage('run-queue-images', {
            id: 'q_img',
            text: 'check this diagram',
            contextText: '<project-context turn="2"/>',
            images: sampleImages,
          })
        } else {
          yield { type: 'text', text: 'Diagram checked.' }
        }
      })

      await manager.startRun({
        runId: 'run-queue-images',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'check main' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      const injectedMessage = sentMessages[1].find(
        m => m.content && m.content.includes('check this diagram')
      )
      expect(injectedMessage).to.exist
      expect(injectedMessage.role).to.equal('user')
      expect(injectedMessage.images).to.deep.equal(sampleImages)

      expect(
        mockStore.appendEvent.calledWith(
          'run-queue-images',
          sinon.match({
            type: 'userMessage',
            id: 'q_img',
            text: 'check this diagram',
            contextText: '<project-context turn="2"/>',
            images: sampleImages,
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

  describe('sending a queued message now', function () {
    describe('sendQueuedNow and the control channel', function () {
      it('returns false for a message the run does not hold', async function () {
        const interruptStep = sinon.stub()
        manager.activeRuns.set('run-s1', {
          queuedMessages: [{ id: 'q1' }],
          interruptStep,
        })
        expect(await manager.sendQueuedNow('run-s1', 'zz')).to.be.false
        expect(interruptStep.called).to.be.false
      })

      it('returns true for a held message and interrupts the step', async function () {
        const interruptStep = sinon.stub()
        manager.activeRuns.set('run-s2', {
          queuedMessages: [{ id: 'q1' }],
          interruptStep,
        })
        expect(await manager.sendQueuedNow('run-s2', 'q1')).to.be.true
        expect(interruptStep.calledOnce).to.be.true
      })

      it('publishes sendNow and returns null when another instance owns the run', async function () {
        const publish = sinon.stub().resolves()
        manager.attachControl({ publish })
        expect(await manager.sendQueuedNow('run-s3', 'q1')).to.be.null
        expect(publish.calledWith('run-s3', { action: 'sendNow', id: 'q1' }))
          .to.be.true
      })

      it('returns false with no run and no control channel', async function () {
        expect(await manager.sendQueuedNow('run-s4', 'q1')).to.be.false
      })

      it('onCommand sendNow interrupts the step for a held message', function () {
        const interruptStep = sinon.stub()
        manager.activeRuns.set('run-s5', {
          queuedMessages: [{ id: 'q1' }],
          interruptStep,
        })
        manager.onCommand({ runId: 'run-s5', action: 'sendNow', id: 'other' })
        expect(interruptStep.called).to.be.false
        manager.onCommand({ runId: 'run-s5', action: 'sendNow', id: 'q1' })
        expect(interruptStep.calledOnce).to.be.true
      })
    })

    it('cuts the streaming reply short and carries on with the queued message', async function () {
      const requests = []
      let answer
      let signalAbortedAtCut
      mockClient.streamChat.callsFake(async function* (opts) {
        requests.push([...opts.messages])
        if (requests.length === 1) {
          yield { type: 'text', text: 'Looking at ' }
          yield { type: 'text', text: 'the preamble' }
          await manager.queueMessage('run-now', {
            id: 'q1',
            text: 'check the bibliography instead',
          })
          answer = await manager.sendQueuedNow('run-now', 'q1')
          // The request is cut: its signal aborts and the stream ends
          await new Promise(resolve => {
            if (opts.signal.aborted) return resolve()
            opts.signal.addEventListener('abort', resolve, { once: true })
          })
          signalAbortedAtCut = opts.signal.aborted
        } else {
          yield { type: 'text', text: 'Bibliography checked.' }
        }
      })

      await manager.startRun({
        runId: 'run-now',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'check the preamble' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(answer).to.be.true
      expect(signalAbortedAtCut).to.be.true
      expect(mockClient.streamChat.callCount).to.equal(2)

      // The partial reply stays as an assistant message, then the queued
      // message follows it at the top of the next request
      const second = requests[1]
      expect(second.slice(-2)[0]).to.deep.equal({
        role: 'assistant',
        content: 'Looking at the preamble',
      })
      expect(second.at(-1).role).to.equal('user')
      expect(second.at(-1).content).to.include('check the bibliography instead')

      expect(
        mockStore.appendEvent.calledWith(
          'run-now',
          sinon.match({
            type: 'userMessage',
            id: 'q1',
            text: 'check the bibliography instead',
          })
        )
      ).to.be.true

      // The run was not stopped or aborted: it finished normally
      const statuses = mockStore.updateStatus
        .getCalls()
        .map(c => c.args[1])
      expect(statuses).to.include('done')
      expect(statuses).to.not.include('stopped')
      expect(statuses).to.not.include('interrupted')
      expect(statuses).to.not.include('error')
    })

    it('does nothing when nothing is queued', async function () {
      let answer
      let abortedAfterCall
      mockClient.streamChat.callsFake(async function* (opts) {
        yield { type: 'text', text: 'Hello.' }
        answer = await manager.sendQueuedNow('run-empty', 'q1')
        abortedAfterCall = opts.signal.aborted
        yield { type: 'text', text: ' Done.' }
      })

      await manager.startRun({
        runId: 'run-empty',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'hi' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(answer).to.be.false
      expect(abortedAfterCall).to.be.false
      expect(mockClient.streamChat.callCount).to.equal(1)
      expect(
        mockStore.appendEvent.calledWith(
          'run-empty',
          sinon.match({ type: 'userMessage' })
        )
      ).to.be.false
    })

    it('waits for the tool calls to finish when no reply is streaming', async function () {
      const requests = []
      let answer
      mockTools.execute.callsFake(async () => {
        await manager.queueMessage('run-busy', { id: 'q1', text: 'and then this' })
        answer = await manager.sendQueuedNow('run-busy', 'q1')
        return { content: 'file content' }
      })
      mockClient.streamChat.callsFake(async function* (opts) {
        requests.push([...opts.messages])
        if (requests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'r1',
            name: 'read_file',
            args: { path: 'main.tex' },
          }
        } else {
          yield { type: 'text', text: 'Read it.' }
        }
      })

      await manager.startRun({
        runId: 'run-busy',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'read it' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

      expect(answer).to.be.true
      expect(mockClient.streamChat.callCount).to.equal(2)
      // The tool result is kept, and nothing was cut short: the queued
      // message comes after it, not after a partial assistant message
      expect(requests[1].at(-2).role).to.equal('tool')
      expect(requests[1].at(-1).role).to.equal('user')
      expect(requests[1].at(-1).content).to.include('and then this')
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

    it('reports a result that carries an error as a failed call, live as well as rebuilt', async function () {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* () {
        callCount++
        if (callCount === 1) {
          yield { type: 'tool_call', id: 'pdf-1', name: 'resolve_pdf_block', args: { page: 1, block: 'B9' } }
        } else {
          yield { type: 'text', text: 'Not found.' }
        }
      })
      mockTools.execute.resolves({ error: 'No block B9 on page 1 of this build.' })
      await manager.startRun({
        runId: 'run-error-flag',
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'where is B9' }],
        providerSettings: provider,
      })
      const event = mockStore.appendEvent.args
        .map(([, e]) => e)
        .find(e => e.type === 'toolCallFinished')
      expect(event.isError).to.equal(true)
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
        for (let i = 0; i < 50; i++) {
          clock.tick(1000)
          await new Promise(resolve => setImmediate(resolve))
        }
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

  describe('checkpoint recording before file changes', function () {
    const provider = { type: 'openai', apiKey: 'k', model: 'gpt-4o' }
    let mockCheckpointStore

    beforeEach(function () {
      mockCheckpointStore = {
        saveCheckpoint: sinon.stub().resolves({}),
        getCheckpoint: sinon.stub().resolves(null),
      }
      manager.checkpointStore = mockCheckpointStore
    })

    it('records checkpoint before edit_file in acceptEdits mode', async function () {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* () {
        callCount++
        if (callCount === 1) {
          yield {
            type: 'tool_call',
            id: 'e1',
            name: 'edit_file',
            args: { path: 'main.tex', oldText: 'hello', newText: 'world' },
          }
        } else {
          yield { type: 'text', text: 'Done.' }
        }
      })

      mockTools._resolveDoc = sinon.stub().resolves({
        _id: 'doc_123',
        lines: ['hello', 'everyone'],
      })
      mockTools.checkEdit = sinon.stub().resolves({
        status: 'ok',
        path: 'main.tex',
        oldText: 'hello',
        newText: 'world',
      })
      mockTools.execute.resolves({ status: 'applied', path: 'main.tex' })

      await manager.startRun({
        runId: 'run-chk-1',
        projectId: 'p1',
        userId: 'u1',
        chatId: 'chat_123',
        mode: 'acceptEdits',
        transcript: [{ id: 'u0', role: 'user', text: 'change hello to world' }],
        providerSettings: provider,
      })

      expect(mockCheckpointStore.saveCheckpoint.calledOnce).to.be.true
      const args = mockCheckpointStore.saveCheckpoint.firstCall.args
      expect(args[0]).to.equal('p1')
      expect(args[1]).to.equal('u1')
      expect(args[2]).to.equal('chat_123')
      expect(args[3]).to.equal('u0')
      expect(args[4]).to.deep.equal({
        files: {
          'main.tex': {
            originalContent: 'hello\neveryone',
            docId: 'doc_123',
            isNew: false,
          },
        },
      })
    })

    it('records checkpoint before create_file for a new file', async function () {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* () {
        callCount++
        if (callCount === 1) {
          yield {
            type: 'tool_call',
            id: 'c1',
            name: 'create_file',
            args: { path: 'new.tex', content: '\\section{New}' },
          }
        } else {
          yield { type: 'text', text: 'Created.' }
        }
      })

      mockTools._resolveDoc = sinon.stub().resolves(null)
      mockTools.execute.resolves({ status: 'applied', path: 'new.tex' })

      await manager.startRun({
        runId: 'run-chk-2',
        projectId: 'p1',
        userId: 'u1',
        chatId: 'chat_123',
        mode: 'acceptEdits',
        transcript: [{ id: 'u_create', role: 'user', text: 'create new.tex' }],
        providerSettings: provider,
      })

      expect(mockCheckpointStore.saveCheckpoint.calledOnce).to.be.true
      const args = mockCheckpointStore.saveCheckpoint.firstCall.args
      expect(args[0]).to.equal('p1')
      expect(args[1]).to.equal('u1')
      expect(args[2]).to.equal('chat_123')
      expect(args[3]).to.equal('u_create')
      expect(args[4]).to.deep.equal({
        files: {
          'new.tex': {
            originalContent: '',
            docId: null,
            isNew: true,
          },
        },
      })
    })

    it('does not record checkpoint if user declines edit in manual mode', async function () {
      let callCount = 0
      mockClient.streamChat.callsFake(async function* () {
        callCount++
        if (callCount === 1) {
          yield {
            type: 'tool_call',
            id: 'e1',
            name: 'edit_file',
            args: { path: 'main.tex', oldText: 'a', newText: 'b' },
          }
        } else {
          yield { type: 'text', text: 'Declined acknowledged.' }
        }
      })

      mockTools._resolveDoc = sinon.stub().resolves({
        _id: 'doc_123',
        lines: ['a'],
      })
      mockTools.checkEdit = sinon.stub().resolves({
        status: 'ok',
        path: 'main.tex',
        oldText: 'a',
        newText: 'b',
      })

      const runPromise = manager.startRun({
        runId: 'run-chk-decline',
        projectId: 'p1',
        userId: 'u1',
        chatId: 'chat_123',
        mode: 'manual',
        transcript: [{ id: 'u0', role: 'user', text: 'edit please' }],
        providerSettings: provider,
      })

      await new Promise(r => setTimeout(r, 10))
      await manager.approveEdit('run-chk-decline', { accepted: false })
      await runPromise

      expect(mockCheckpointStore.saveCheckpoint.called).to.be.false
      expect(mockTools.execute.calledWith('edit_file')).to.be.false
    })

    it('updates activeUserMessageId when queued message arrives', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'text', text: 'first response' }
          await manager.queueMessage('run-chk-queue', {
            id: 'u_queued_42',
            text: 'now change foo to bar',
          })
        } else if (turn === 2) {
          yield {
            type: 'tool_call',
            id: 'e2',
            name: 'edit_file',
            args: { path: 'main.tex', oldText: 'foo', newText: 'bar' },
          }
        } else {
          yield { type: 'text', text: 'done second turn' }
        }
      })

      mockTools._resolveDoc = sinon.stub().resolves({
        _id: 'doc_1',
        lines: ['foo'],
      })
      mockTools.checkEdit = sinon.stub().resolves({
        status: 'ok',
        path: 'main.tex',
        oldText: 'foo',
        newText: 'bar',
      })
      mockTools.execute.resolves({ status: 'applied', path: 'main.tex' })

      const runPromise = manager.startRun({
        runId: 'run-chk-queue',
        projectId: 'p1',
        userId: 'u1',
        chatId: 'chat_123',
        mode: 'acceptEdits',
        transcript: [{ id: 'u0', role: 'user', text: 'first prompt' }],
        providerSettings: provider,
      })

      // Queue a second message while run is active
      await manager.queueMessage('run-chk-queue', {
        id: 'u_queued_42',
        text: 'now change foo to bar',
      })

      await runPromise

      expect(mockCheckpointStore.saveCheckpoint.calledOnce).to.be.true
      expect(mockCheckpointStore.saveCheckpoint.firstCall.args[3]).to.equal(
        'u_queued_42'
      )
    })
  })

  describe('slash commands', function () {
    const provider = { type: 'openai', apiKey: 'k', model: 'gpt-4o' }
    const NOTE = SENT_DURING_RUN_NOTE
    const commandBlock = id =>
      `<command name="${id}">\n<instructions>Do it.</instructions>\n</command>`
    // A user turn sent with a command, as the composer stores it
    const commandTurn = (id, words = '') => ({
      id: `u_${id}`,
      role: 'user',
      text: words,
      contextText: '<project-context turn="1"/>',
      command: { id, args: words },
      commandText: commandBlock(id),
    })
    const toolSpec = name => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    })
    let savedAiAssist

    beforeEach(function () {
      savedAiAssist = Settings.aiAssist
      mockTools.getToolSpecs = () => [
        toolSpec('read_file'),
        toolSpec('edit_file'),
      ]
      mockTools.execute = sinon.stub().resolves({ status: 'applied' })
    })

    afterEach(function () {
      Settings.aiAssist = savedAiAssist
    })

    const finishedCall = (id, store = mockStore) =>
      store.appendEvent.args
        .map(args => args[1])
        .find(e => e.type === 'toolCallFinished' && e.id === id)

    describe('the turn content', function () {
      it('puts the context, then the command block, then the words', function () {
        expect(
          userTurnContent({
            contextText: 'C',
            commandText: 'K',
            text: 'words',
          })
        ).to.equal('C\n\nK\n\nwords')
      })

      it('keeps the command block when the words are empty', function () {
        expect(
          userTurnContent({ contextText: 'C', commandText: 'K', text: '' })
        ).to.equal('C\n\nK')
      })

      it('marks a command turn sent during a run after its words', function () {
        expect(
          userTurnContent({
            contextText: 'C',
            commandText: 'K',
            text: 'w',
            sentDuringRun: true,
          })
        ).to.equal(`C\n\nK\n\nw\n\n${NOTE}`)
      })

      it('renders an entry without a command exactly as before', function () {
        expect(userTurnContent({ contextText: 'C', text: 'words' })).to.equal(
          'C\n\nwords'
        )
        expect(userTurnContent({ contextText: 'C', text: '' })).to.equal(
          'C\n\n'
        )
        expect(userTurnContent({ text: 'words' })).to.equal('words')
        expect(
          userTurnContent({ text: 'w', sentDuringRun: true })
        ).to.equal(`w\n\n${NOTE}`)
      })

      it('rebuilds a stored command turn as the run sent it', function () {
        const [message] = toAgentMessages([commandTurn('fix', 'the table')])
        expect(message).to.deep.equal({
          role: 'user',
          content: `<project-context turn="1"/>\n\n${commandBlock('fix')}\n\nthe table`,
        })
      })

      it('preserves images on user transcript entries in toAgentMessages', function () {
        const transcript = [
          {
            role: 'user',
            text: 'Explain this diagram',
            images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo...' }],
          },
        ]
        const messages = toAgentMessages(transcript)
        expect(messages).to.have.lengthOf(1)
        expect(messages[0].role).to.equal('user')
        expect(messages[0].images).to.deep.equal([
          { mediaType: 'image/png', data: 'iVBORw0KGgo...' },
        ])
      })

      it('does not add images property to user message if entry has no images', function () {
        const transcript = [
          {
            role: 'user',
            text: 'Hello',
          },
        ]
        const messages = toAgentMessages(transcript)
        expect(messages).to.have.lengthOf(1)
        expect(messages[0]).to.not.have.property('images')
      })

      it('preserves images on a queued message in toQueuedMessage', function () {
        const queued = toQueuedMessage({
          id: 'q1',
          text: 'explain this screenshot',
          contextText: 'C',
          images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo...' }],
        })
        expect(queued.images).to.deep.equal([
          { mediaType: 'image/png', data: 'iVBORw0KGgo...' },
        ])
      })

      it('keeps the command on a queued message and drops it when unknown', function () {
        const queued = toQueuedMessage({
          id: 'q1',
          text: 'w',
          contextText: 'C',
          commandText: 'K',
          command: { id: 'fix', args: '' },
        })
        expect(queued).to.deep.equal({
          id: 'q1',
          text: 'w',
          contextText: 'C',
          commandText: 'K',
          command: { id: 'fix', args: '' },
          content: `C\n\nK\n\nw\n\n${NOTE}`,
        })

        const plain = toQueuedMessage({
          id: 'q2',
          text: 'w',
          contextText: 'C',
          commandText: 'K',
          command: { id: 'nope' },
        })
        expect(plain).to.not.have.property('command')
        expect(plain).to.not.have.property('commandText')
        expect(plain.content).to.equal(`C\n\nw\n\n${NOTE}`)
      })

      it('queues an old message with the same fields and bytes as before', function () {
        expect(
          toQueuedMessage({ id: 'q3', text: 'w', contextText: 'C' })
        ).to.deep.equal({
          id: 'q3',
          text: 'w',
          contextText: 'C',
          content: `C\n\nw\n\n${NOTE}`,
        })
      })
    })

    describe('scope enforcement', function () {
      it('refuses an edit in a read command with the scope error, and sends the same tools and prompt', async function () {
        const sent = []
        let turn = 0
        mockClient.streamChat.callsFake(async function* (opts) {
          sent.push({
            tools: opts.tools.map(t => t.name),
            system: opts.system,
            // A copy: the run keeps appending to the same array
            messages: [...opts.messages],
          })
          turn++
          if (turn === 1) {
            yield {
              type: 'tool_call',
              id: 'call_edit',
              name: 'edit_file',
              args: { path: 'main.tex', oldText: 'a', newText: 'b' },
            }
          } else {
            yield { type: 'text', text: 'It would change a sentence.' }
          }
        })

        await manager.startRun({
          runId: 'run-scope-read',
          projectId: 'p1',
          userId: 'u1',
          transcript: [commandTurn('review', 'the intro')],
          providerSettings: provider,
          // Accept edits would apply this; the command's scope does not
          mode: 'acceptEdits',
        })

        expect(mockTools.execute.calledWith('edit_file')).to.be.false
        const call = finishedCall('call_edit')
        expect(call.isError).to.be.true
        expect(call.result.status).to.equal('denied')
        expect(call.result.error).to.equal(scopeRefusal('review', 'edit_file'))
        expect(call.result.error).to.equal(
          "`edit_file` is outside /review's scope: this command only reads. Report the change instead of making it."
        )
        // The refusal reaches the model as the tool's result
        expect(JSON.stringify(sent[1].messages)).to.include(
          "outside /review's scope"
        )
        // Tool specs and system prompt do not change because of the command
        expect(sent[0].tools).to.deep.equal([
          'read_file',
          'edit_file',
          'present_plan',
        ])
        expect(sent[1].tools).to.deep.equal(sent[0].tools)
        expect(sent[1].system).to.equal(sent[0].system)
      })

      it('lets a read command read the project', async function () {
        let turn = 0
        mockClient.streamChat.callsFake(async function* () {
          turn++
          if (turn === 1) {
            yield {
              type: 'tool_call',
              id: 'call_read',
              name: 'read_file',
              args: { path: 'main.tex' },
            }
          } else {
            yield { type: 'text', text: 'Read it.' }
          }
        })

        await manager.startRun({
          runId: 'run-scope-read-ok',
          projectId: 'p1',
          userId: 'u1',
          transcript: [commandTurn('explain')],
          providerSettings: provider,
        })

        expect(mockTools.execute.calledWith('read_file')).to.be.true
        expect(finishedCall('call_read').result.status).to.not.equal('denied')
      })

      it('ends the command when a queued plain message is drained', async function () {
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
            await manager.queueMessage('run-plain-after', {
              id: 'q_plain',
              text: 'now make the change',
              contextText: '<project-context turn="2"/>',
            })
          } else if (turn === 2) {
            yield {
              type: 'tool_call',
              id: 'call_edit',
              name: 'edit_file',
              args: { path: 'main.tex', oldText: 'a', newText: 'b' },
            }
          } else {
            yield { type: 'text', text: 'Changed it.' }
          }
        })

        await manager.startRun({
          runId: 'run-plain-after',
          projectId: 'p1',
          userId: 'u1',
          transcript: [commandTurn('review')],
          providerSettings: provider,
          mode: 'acceptEdits',
        })

        expect(mockTools.execute.calledWith('edit_file')).to.be.true
        expect(finishedCall('call_edit').result.status).to.not.equal('denied')
      })

      it('starts the command when a queued command message is drained', async function () {
        const sent = []
        let turn = 0
        mockClient.streamChat.callsFake(async function* (opts) {
          sent.push([...opts.messages])
          turn++
          if (turn === 1) {
            yield {
              type: 'tool_call',
              id: 'r1',
              name: 'read_file',
              args: { path: 'main.tex' },
            }
            await manager.queueMessage('run-command-after', {
              id: 'q_cmd',
              text: 'the abstract',
              contextText: '<project-context turn="2"/>',
              commandText: commandBlock('review'),
              command: { id: 'review', args: 'the abstract' },
            })
          } else if (turn === 2) {
            yield {
              type: 'tool_call',
              id: 'call_edit',
              name: 'edit_file',
              args: { path: 'main.tex', oldText: 'a', newText: 'b' },
            }
          } else {
            yield { type: 'text', text: 'Only reviewed.' }
          }
        })

        await manager.startRun({
          runId: 'run-command-after',
          projectId: 'p1',
          userId: 'u1',
          transcript: [{ id: 'u0', role: 'user', text: 'hello' }],
          providerSettings: provider,
          mode: 'acceptEdits',
        })

        expect(mockTools.execute.calledWith('edit_file')).to.be.false
        expect(finishedCall('call_edit').result.status).to.equal('denied')
        // The queued turn is stored with its command, and sent with its block
        expect(
          mockStore.appendEvent.calledWith(
            'run-command-after',
            sinon.match({
              type: 'userMessage',
              id: 'q_cmd',
              command: { id: 'review', args: 'the abstract' },
              commandText: commandBlock('review'),
            })
          )
        ).to.be.true
        expect(sent[1].at(-1).content).to.equal(
          `<project-context turn="2"/>\n\n${commandBlock('review')}\n\nthe abstract\n\n${NOTE}`
        )
      })
    })

    describe('system prompt', function () {
      it('sends the same system prompt and tools for a command turn and a plain one', async function () {
        mockClient.streamChat.callsFake(async function* () {
          yield { type: 'text', text: 'ok' }
        })
        await manager.startRun({
          runId: 'run-plain-turn',
          projectId: 'p1',
          userId: 'u1',
          transcript: [{ role: 'user', text: 'hi' }],
          providerSettings: provider,
        })
        await manager.startRun({
          runId: 'run-command-turn',
          projectId: 'p1',
          userId: 'u1',
          transcript: [commandTurn('fix', 'the table')],
          providerSettings: provider,
        })
        const [plain, command] = mockClient.streamChat.args.map(([a]) => a)
        expect(command.system).to.equal(plain.system)
        expect(command.tools).to.deep.equal(plain.tools)
        expect(plain.system).to.include('# Slash commands')
      })
    })
  })
})

describe('AiAssistRunManager connector tools', function () {
  const provider = { type: 'anthropic', apiKey: 'k', model: 'claude-x' }
  const spec = name => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
  })
  let savedAiAssist

  beforeEach(function () {
    savedAiAssist = Settings.aiAssist
    Settings.aiAssist = { ...(savedAiAssist || {}), enabled: true }
  })

  afterEach(function () {
    Settings.aiAssist = savedAiAssist
  })

  function storeStub() {
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

  const builtIns = {
    getToolSpecs: () => [spec('read_file')],
    execute: sinon.stub().resolves({ content: 'file' }),
  }

  // Calls the given tools in turn, then answers with text
  function scriptedClient(calls) {
    let turn = 0
    return {
      streamChat: sinon.stub().callsFake(async function* () {
        turn++
        const call = calls[turn - 1]
        if (call) yield { type: 'tool_call', ...call }
        else yield { type: 'text', text: 'Done' }
      }),
    }
  }

  function connectorSession(overrides = {}) {
    return {
      connectors: [],
      deferred: false,
      unavailable: [],
      specs: () => [],
      has: () => false,
      describe: () => null,
      execute: sinon.stub().resolves({ result: 'ok' }),
      allowAlways: async () => {},
      close: async () => {},
      ...overrides,
    }
  }

  const runWith = (manager, runId, extra = {}) =>
    manager.startRun({
      runId,
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'hi' }],
      providerSettings: provider,
      mode: 'manual',
      ...extra,
    })

  it('offers a deferred connector tool from the step after search_connector_tools loaded it', async function () {
    let loaded = false
    const session = connectorSession({
      deferred: true,
      loadedTools: new Set(),
      specs: () =>
        loaded
          ? [spec('search_connector_tools'), spec('mcp__docs__get')]
          : [spec('search_connector_tools')],
      describe: name =>
        name === 'mcp__docs__get'
          ? {
              id: 'c1',
              name: 'Docs',
              tool: 'get',
              title: 'Get',
              permission: 'allow',
              readOnly: true,
              destructive: false,
            }
          : null,
      execute: sinon.stub().callsFake(async name => {
        if (name === 'search_connector_tools') {
          loaded = true
          session.loadedTools.add('mcp__docs__get')
          return { result: 'Loaded: mcp__docs__get' }
        }
        return { result: 'page body' }
      }),
    })
    const client = scriptedClient([
      { id: 'a', name: 'search_connector_tools', args: { query: 'select:mcp__docs__get' } },
      { id: 'b', name: 'mcp__docs__get', args: {} },
    ])
    const manager = new AiAssistRunManager({
      store: storeStub(),
      tools: builtIns,
      clientFactory: () => client,
      connectorSessionFactory: async () => session,
    })

    await runWith(manager, 'run-loaded')

    const offered = client.streamChat.args.map(([a]) => a.tools.map(t => t.name))
    expect(offered[0]).to.deep.equal(['read_file', 'search_connector_tools', 'present_plan'])
    expect(offered[1]).to.deep.equal([
      'read_file',
      'search_connector_tools',
      'mcp__docs__get',
      'present_plan',
    ])
    expect(session.execute.calledWith('mcp__docs__get')).to.be.true
  })

  it('counts the deferred connector tools it has not loaded in the breakdown, not in the offered tools', async function () {
    const session = connectorSession({
      deferred: true,
      loadedTools: new Set(),
      specs: () => [spec('search_connector_tools')],
      catalog: () => [
        {
          name: 'mcp__docs__get',
          originalName: 'get',
          server: 'Docs',
          spec: spec('mcp__docs__get'),
          deferred: true,
        },
        {
          name: 'mcp__docs__put',
          originalName: 'put',
          server: 'Docs',
          spec: spec('mcp__docs__put'),
          deferred: true,
        },
      ],
      execute: sinon.stub().resolves({ result: 'ok' }),
    })
    const client = scriptedClient([])
    const store = storeStub()
    const manager = new AiAssistRunManager({
      store,
      tools: builtIns,
      clientFactory: () => client,
      connectorSessionFactory: async () => session,
    })

    await runWith(manager, 'run-deferred-count')

    const offered = client.streamChat.args.map(([a]) => a.tools.map(t => t.name))
    expect(offered[0]).to.not.include('mcp__docs__get')
    const breakdown = store.appendEvent.args
      .map(args => args[1])
      .find(event => event.type === 'contextBreakdown').breakdown
    expect(breakdown.deferredConnectorToolCount).to.equal(2)
    // Each spec in the wire shape of the run's provider (anthropic here)
    const tokens = name => estimateToolTokens(spec(name), 'anthropic', 'claude-x')
    expect(breakdown.deferredConnectorTools).to.equal(
      tokens('mcp__docs__get') + tokens('mcp__docs__put')
    )
    // The dashboard lists them by the connector's own tool names, as deferred
    expect(breakdown.connectorToolDetails).to.have.deep.members([
      { name: 'get', server: 'Docs', tokens: tokens('mcp__docs__get'), deferred: true },
      { name: 'put', server: 'Docs', tokens: tokens('mcp__docs__put'), deferred: true },
    ])
  })

  it('emits the breakdown again with the provider counts once they land, for the same step', async function () {
    const countTokens = sinon.stub().callsFake(async ({ system = '', tools = [] }) => {
      // The base count is 10; the system prompt counts a token a character
      return 10 + system.length + tools.length * 50
    })
    const client = {
      model: 'claude-x',
      baseURL: 'https://api.anthropic.com',
      exactCountsSupported: true,
      countTokens,
      streamChat: sinon.stub().callsFake(async function* () {
        // The stream stays open a moment, as a provider's does, so the counts land within the run
        await new Promise(resolve => setTimeout(resolve, 20))
        yield { type: 'text', text: 'Done' }
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 } }
      }),
    }
    const store = storeStub()
    const manager = new AiAssistRunManager({
      store,
      tools: builtIns,
      clientFactory: () => client,
    })

    await runWith(manager, 'run-exact-counts')

    const events = store.appendEvent.args.map(args => args[1])
    const breakdowns = events.filter(event => event.type === 'contextBreakdown')
    expect(breakdowns).to.have.lengthOf(2)
    expect(breakdowns[0].breakdown.exactFixed).to.equal(false)
    expect(breakdowns[1].breakdown.exactFixed).to.equal(true)
    expect(breakdowns.map(event => event.step)).to.deep.equal([1, 1])
    expect(breakdowns[1].breakdown.step).to.equal(1)
    const systemText = countTokens.args.find(([args]) => args.system)[0].system
    const {
      systemPrompt,
      skills,
      projectInstructions,
      connectorInstructions,
    } = breakdowns[1].breakdown
    expect(
      systemPrompt + skills + projectInstructions + connectorInstructions
    ).to.equal(systemText.length)
    expect(events).to.deep.include({
      type: 'usage',
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        step: 1,
      },
      step: 1,
    })
  })

  it('refuses a deferred connector tool that is not loaded yet, before asking the user', async function () {
    const session = connectorSession({
      deferred: true,
      loadedTools: new Set(),
      specs: () => [spec('search_connector_tools')],
      describe: () => ({
        id: 'c1',
        name: 'Docs',
        tool: 'write',
        title: 'Write',
        permission: undefined,
        readOnly: false,
        destructive: false,
      }),
    })
    const client = scriptedClient([
      { id: 'b', name: 'mcp__docs__write', args: {} },
    ])
    const store = storeStub()
    const manager = new AiAssistRunManager({
      store,
      tools: builtIns,
      clientFactory: () => client,
      connectorSessionFactory: async () => session,
    })

    await runWith(manager, 'run-not-loaded')

    expect(session.execute.called).to.be.false
    const events = store.appendEvent.args.map(args => args[1].type)
    expect(events).not.to.include('awaitingApproval')
    const toolMessage = client.streamChat.args[1][0].messages.find(
      m => m.role === 'tool' && m.toolCallId === 'b'
    )
    expect(toolMessage.content).to.include('is not loaded yet')
    expect(toolMessage.content).to.include('select:mcp__docs__write')
  })

  describe('declining a connector tool that needs approval', function () {
    const writeTool = () =>
      connectorSession({
        specs: () => [spec('mcp__docs__write')],
        describe: () => ({
          id: 'c1',
          name: 'Docs',
          tool: 'write',
          title: 'Write',
          permission: 'ask',
          readOnly: false,
          destructive: false,
        }),
      })

    // Asks for the write and a read in one step, then answers with text
    function twoCallClient() {
      let turn = 0
      return {
        streamChat: sinon.stub().callsFake(async function* () {
          turn++
          if (turn === 1) {
            yield { type: 'tool_call', id: 'w', name: 'mcp__docs__write', args: {} }
            yield { type: 'tool_call', id: 'r', name: 'read_file', args: { path: 'main.tex' } }
          } else {
            yield { type: 'text', text: 'Done' }
          }
        }),
      }
    }

    async function declineWith(decision) {
      const session = writeTool()
      const client = twoCallClient()
      const store = storeStub()
      const tools = {
        getToolSpecs: builtIns.getToolSpecs,
        execute: sinon.stub().resolves({ content: 'file' }),
      }
      const manager = new AiAssistRunManager({
        store,
        tools,
        clientFactory: () => client,
        connectorSessionFactory: async () => session,
      })
      const run = runWith(manager, 'run-decline')
      while (!store.setPendingApproval.called) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      await manager.approveEdit('run-decline', decision)
      await run
      return { session, client, store, tools }
    }

    it('ends the turn without running the rest of the step', async function () {
      const { session, client, store, tools } = await declineWith({
        accepted: false,
      })

      expect(session.execute.called).to.be.false
      expect(tools.execute.called).to.be.false
      expect(client.streamChat.callCount).to.equal(1)
      const events = store.appendEvent.args.map(args => args[1])
      const skipped = events.find(
        e => e.type === 'toolCallFinished' && e.id === 'r'
      )
      expect(JSON.stringify(skipped)).to.include('Not run')
      expect(events.at(-1)).to.include({ type: 'turnFinished', reason: 'stop' })
      expect(store.updateStatus.calledWith('run-decline', 'done')).to.be.true
    })

    it('hands what to do differently back to the model', async function () {
      const { session, client } = await declineWith({
        accepted: false,
        note: 'Write to notes.tex instead',
      })

      expect(session.execute.called).to.be.false
      expect(client.streamChat.callCount).to.equal(2)
      const toolMessage = client.streamChat.args[1][0].messages.find(
        m => m.role === 'tool' && m.toolCallId === 'w'
      )
      expect(toolMessage.content).to.include(
        'To tell you how to proceed, the user said:\nWrite to notes.tex instead'
      )
    })

    it('passes what to do next on to the model with the result', async function () {
      const { session, client } = await declineWith({
        accepted: true,
        note: 'Then summarise it',
      })

      expect(session.execute.calledOnce).to.be.true
      const toolMessage = client.streamChat.args[1][0].messages.find(
        m => m.role === 'tool' && m.toolCallId === 'w'
      )
      expect(toolMessage.content).to.equal(
        'ok\n\nThe user allowed this tool use and said:\nThen summarise it'
      )
    })
  })

  it('sends a failed connector result to the provider as an error, and records it failed', async function () {
    const session = connectorSession({
      specs: () => [spec('mcp__docs__get')],
      describe: () => ({
        id: 'c1',
        name: 'Docs',
        tool: 'get',
        title: 'Get',
        permission: 'allow',
        readOnly: true,
        destructive: false,
      }),
      execute: sinon.stub().resolves({ result: 'Not found', isError: true }),
    })
    const client = scriptedClient([
      { id: 'b', name: 'mcp__docs__get', args: {} },
    ])
    const store = storeStub()
    const manager = new AiAssistRunManager({
      store,
      tools: builtIns,
      clientFactory: () => client,
      connectorSessionFactory: async () => session,
    })

    await runWith(manager, 'run-error')

    const toolMessage = client.streamChat.args[1][0].messages.find(
      m => m.role === 'tool' && m.toolCallId === 'b'
    )
    expect(toolMessage.isError).to.be.true
    expect(toolMessage.content).to.equal('Error: Not found')
    const finished = store.appendEvent.args
      .map(args => args[1])
      .find(e => e.type === 'toolCallFinished' && e.id === 'b')
    expect(finished.isError).to.be.true
  })

  it('treats an error result from a connector as a failed call', function () {
    expect(toolMessageIsError({ error: 'Docs is signed out', mcpError: true }, false)).to.be.true
  })

  it('refuses a connector tool no session describes, without running it', async function () {
    const session = connectorSession({
      specs: () => [],
      describe: () => null,
    })
    const client = scriptedClient([
      { id: 'b', name: 'mcp__docs__unknown', args: {} },
    ])
    const manager = new AiAssistRunManager({
      store: storeStub(),
      tools: builtIns,
      clientFactory: () => client,
      connectorSessionFactory: async () => session,
    })

    await runWith(manager, 'run-unknown')

    expect(session.execute.called).to.be.false
    const toolMessage = client.streamChat.args[1][0].messages.find(
      m => m.role === 'tool' && m.toolCallId === 'b'
    )
    expect(toolMessage.content).to.include('Unknown connector tool: mcp__docs__unknown')
  })

  it('tells the model when the connector session could not be built', async function () {
    const client = scriptedClient([])
    const manager = new AiAssistRunManager({
      store: storeStub(),
      tools: builtIns,
      clientFactory: () => client,
      connectorSessionFactory: async () => {
        throw new Error('database down')
      },
    })

    await runWith(manager, 'run-failed-session')

    const system = client.streamChat.args[0][0].system
    expect(system).to.include('Connectors could not be loaded for this run')
  })

  it('leaves connectors out of the prompt when the feature is off', async function () {
    Settings.aiAssist = { enabled: false }
    const client = scriptedClient([])
    const factory = sinon.stub().resolves(connectorSession())
    const manager = new AiAssistRunManager({
      store: storeStub(),
      tools: builtIns,
      clientFactory: () => client,
      connectorSessionFactory: factory,
    })

    await runWith(manager, 'run-off')

    expect(factory.called).to.be.false
    expect(client.streamChat.args[0][0].system).not.to.include('# Connectors')
  })
})


describe('AiAssistRunManager queue bounds', function () {
  it('refuses a message once the run already holds ten unread', async function () {
    const manager = new AiAssistRunManager({
      store: { appendEvent: sinon.stub().resolves(0) },
      tools: {},
    })
    manager.activeRuns.set('run-q', {
      queuedMessages: [],
      acceptsMessages: true,
    })
    for (let i = 0; i < 10; i++) {
      expect(await manager.queueMessage('run-q', { id: `m${i}`, text: 'x' })).to
        .be.true
    }
    expect(await manager.queueMessage('run-q', { id: 'm10', text: 'x' })).to.be
      .false
    expect(manager.activeRuns.get('run-q').queuedMessages).to.have.lengthOf(10)
  })

  it('normalises a mode taken from the control channel', function () {
    const manager = new AiAssistRunManager({
      store: {
        setMode: sinon.stub().resolves(),
        appendEvent: sinon.stub().resolves(0),
      },
      tools: {},
    })
    const active = { mode: 'manual', modeNotice: null }
    manager.activeRuns.set('run-m', active)
    manager.onCommand({ runId: 'run-m', action: 'setMode', mode: 'root' })
    expect(active.mode).to.equal('manual')
  })
})

describe('AiAssistRunManager context meter and automatic compaction', function () {
  // A 100000 window with 4000 reserved: effective 96000, autoCompactAt 83000,
  // blockAt 93120
  const PROVIDER = {
    type: 'openai',
    apiKey: 'k',
    model: 'gpt-4o',
    contextWindow: 100000,
    maxOutputTokens: 4000,
  }
  const IDS = {
    projectId: '0123456789abcdef01234567',
    userId: 'abcdef0123456789abcdef01',
  }
  const spec = name => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
  })
  function storeStub() {
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

  function chatStore() {
    return {
      saveChat: sinon.stub().resolves({}),
      getChat: sinon.stub().resolves({ titleGenerated: true }),
      saveChatTitle: sinon.stub().resolves(null),
    }
  }

  // Each reply: its provider usage, its tool calls, then its text. Past the
  // last reply the model says 'Done'.
  function usageClient(replies) {
    let turn = 0
    return {
      streamChat: sinon.stub().callsFake(async function* () {
        const reply = replies[turn++] ?? { text: 'Done' }
        if (reply.usage) yield { type: 'usage', usage: reply.usage }
        for (const call of reply.calls ?? []) {
          yield { type: 'tool_call', ...call }
        }
        if (reply.text) yield { type: 'text', text: reply.text }
      }),
    }
  }

  const toolReply = (id, usage, extra = {}) => ({
    usage,
    calls: [{ id, name: 'read_file', args: { path: `${id}.tex` } }],
    ...extra,
  })

  function build({ client, store, history = chatStore(), compactor, tools }) {
    return new AiAssistRunManager({
      store,
      tools: tools ?? {
        getToolSpecs: () => [spec('read_file')],
        execute: sinon.stub().resolves({ content: 'file' }),
      },
      clientFactory: () => client,
      chatHistoryStore: history,
      ...(compactor ? { compactor } : {}),
    })
  }

  const eventsOf = store =>
    store.appendEvent.args.map(args => args[1])

  const withChat = {
    chatId: 'chat1',
    userId: IDS.userId,
    projectId: IDS.projectId,
  }

  // Long enough that the compacted summary, with its framing, is smaller
  const LONG = 'Background detail on the thesis chapters. '.repeat(120)
  const TRANSCRIPT = [
    { id: 'u0', role: 'user', text: `first question. ${LONG}` },
    { id: 'a0', role: 'assistant', text: `first answer. ${LONG}` },
    { id: 'u1', role: 'user', text: `second question. ${LONG}` },
  ]

  it('emits contextUsage before each provider request, with its thresholds and state', async function () {
    const store = storeStub()
    const client = usageClient([{ text: 'Hello' }])
    const manager = build({ client, store })

    await manager.startRun({
      runId: 'run-usage',
      projectId: IDS.projectId,
      userId: IDS.userId,
      transcript: [{ id: 'u0', role: 'user', text: 'hi' }],
      providerSettings: PROVIDER,
    })

    const events = eventsOf(store)
    const usage = events.filter(e => e.type === 'contextUsage')
    expect(usage).to.have.length(1)
    expect(usage[0]).to.deep.include({
      step: 1,
      exact: false,
      anchoredTokens: 0,
      contextWindow: 100000,
      state: 'ok',
    })
    expect(usage[0].tokens).to.equal(usage[0].estimatedTokens)
    expect(usage[0].thresholds).to.deep.equal({
      effective: 96000,
      autoCompactAt: 83000,
      warnAt: 76800,
      blockAt: 93120,
    })
    expect(events.indexOf(usage[0])).to.be.below(
      events.findIndex(e => e.type === 'text')
    )
  })

  it('anchors the next request on the usage the last response reported', async function () {
    const store = storeStub()
    const client = usageClient([
      toolReply('c1', {
        inputTokens: 5000,
        outputTokens: 100,
        cacheReadTokens: 1000,
        cacheCreationTokens: 0,
      }),
      { text: 'Done' },
    ])
    const manager = build({ client, store })

    await manager.startRun({
      runId: 'run-anchor',
      projectId: IDS.projectId,
      userId: IDS.userId,
      transcript: [{ id: 'u0', role: 'user', text: 'read a file' }],
      providerSettings: PROVIDER,
    })

    const usage = eventsOf(store).filter(e => e.type === 'contextUsage')
    expect(usage).to.have.length(2)
    expect(usage[1]).to.deep.include({
      step: 2,
      exact: true,
      anchoredTokens: 6100,
    })
    expect(usage[1].estimatedTokens).to.be.above(0)
    expect(usage[1].estimatedTokens).to.be.below(100)
    expect(usage[1].tokens).to.equal(6100 + usage[1].estimatedTokens)
  })

  it('compacts the chat mid-run once the count reaches autoCompactAt, and goes on with the compacted messages', async function () {
    const store = storeStub()
    const history = chatStore()
    const compactor = sinon.stub().resolves({
      summary: 'Earlier work on the thesis, summarized.',
      ledger: {},
    })
    const client = usageClient([
      toolReply('c1', { inputTokens: 90000, outputTokens: 10 }),
      { text: 'Carrying on' },
    ])
    const manager = build({ client, store, history, compactor })

    await manager.startRun({
      runId: 'run-auto',
      transcript: TRANSCRIPT,
      providerSettings: PROVIDER,
      ...withChat,
    })

    expect(compactor.calledOnce).to.equal(true)
    expect(compactor.firstCall.args[0].trigger).to.equal('auto')
    const events = eventsOf(store)
    const started = events.find(e => e.type === 'compactStarted')
    const finished = events.find(e => e.type === 'compactFinished')
    expect(started).to.deep.equal({ type: 'compactStarted', trigger: 'auto' })
    expect(finished.entry).to.deep.include({
      role: 'compact',
      trigger: 'auto',
      summary: 'Earlier work on the thesis, summarized.',
    })
    expect(finished.entry.id).to.be.a('string')
    // Persisted the way /compact persists it: the transcript with the entry last
    const lastSave = history.saveChat.lastCall.args[3]
    expect(lastSave.at(-1)).to.deep.include({ role: 'compact', trigger: 'auto' })
    // The second request starts from the summary, and the run finishes on it
    const second = client.streamChat.secondCall.args[0].messages
    expect(second[0].content).to.include('Earlier work on the thesis, summarized.')
    expect(events.some(e => e.type === 'text' && e.text === 'Carrying on')).to.equal(true)
    expect(events.at(-1)).to.deep.include({ type: 'turnFinished', reason: 'stop' })
    const compactIndex = events.indexOf(finished)
    const usage = events.filter(e => e.type === 'contextUsage')
    expect(events.indexOf(usage[1])).to.be.above(compactIndex)
  })

  it('waits two steps between automatic compactions and blocks at blockAt when none can run', async function () {
    const store = storeStub()
    const compactor = sinon.stub().rejects(
      Object.assign(new Error('provider down'), { code: 'compactFailed' })
    )
    const client = usageClient([
      toolReply('c1', { inputTokens: 90000, outputTokens: 10 }),
      toolReply('c2', { inputTokens: 94000, outputTokens: 10 }),
      { text: 'never reached' },
    ])
    const manager = build({ client, store, history: chatStore(), compactor })

    await manager.startRun({
      runId: 'run-blocked',
      transcript: TRANSCRIPT,
      providerSettings: PROVIDER,
      ...withChat,
    })

    expect(compactor.callCount).to.equal(1)
    const events = eventsOf(store)
    expect(events.filter(e => e.type === 'compactFailed')).to.have.length(1)
    expect(events.find(e => e.type === 'compactFailed')).to.deep.include({
      trigger: 'auto',
      code: 'compactFailed',
    })
    expect(events.find(e => e.type === 'error')).to.deep.include({
      code: 'contextExhausted',
    })
    expect(client.streamChat.callCount).to.equal(2)
  })

  it('stops trying automatic compactions after three failures in a run', async function () {
    const store = storeStub()
    const compactor = sinon.stub().rejects(
      Object.assign(new Error('provider down'), { code: 'compactFailed' })
    )
    const replies = Array.from({ length: 7 }, (_, i) =>
      toolReply(`c${i}`, { inputTokens: 88000, outputTokens: 10 })
    )
    const client = usageClient(replies)
    const manager = build({ client, store, history: chatStore(), compactor })

    await manager.startRun({
      runId: 'run-breaker',
      transcript: TRANSCRIPT,
      providerSettings: PROVIDER,
      ...withChat,
    })

    // Steps 2, 4 and 6 try; after the third failure no more tries
    expect(compactor.callCount).to.equal(3)
    const events = eventsOf(store)
    expect(events.filter(e => e.type === 'compactFailed')).to.have.length(3)
    expect(events.some(e => e.type === 'error')).to.equal(false)
    expect(events.at(-1)).to.deep.include({ type: 'turnFinished', reason: 'stop' })
  })

  it('refuses a compaction that does not shrink the context, and keeps the chat as it was', async function () {
    const store = storeStub()
    const history = chatStore()
    const compactor = sinon.stub().resolves({
      summary: 'x'.repeat(4000),
      ledger: {},
    })
    const client = usageClient([
      toolReply('c1', { inputTokens: 90000, outputTokens: 10 }),
      { text: 'Done' },
    ])
    const manager = build({ client, store, history, compactor })

    await manager.startRun({
      runId: 'run-no-progress',
      transcript: [{ id: 'u0', role: 'user', text: 'hi' }],
      providerSettings: PROVIDER,
      ...withChat,
    })

    const failed = eventsOf(store).find(e => e.type === 'compactFailed')
    expect(failed.code).to.equal('compactNoProgress')
    expect(history.saveChat.callCount).to.equal(1)
    expect(client.streamChat.secondCall.args[0].messages[0].content).to.equal('hi')
  })

  it('records the reply of each request in the stored shape, with its calls and results', function () {
    const entries = [{ id: 'u0', role: 'user', text: 'hi' }]
    const call = { id: 'c1', name: 'read_file', args: { path: 'a.tex' } }
    recordRunStep(entries, {
      runId: 'r',
      step: 1,
      text: 'Reading',
      calls: [call],
      results: new Map([[call, { result: { content: 'x' }, isError: false }]]),
    })
    recordRunStep(entries, { runId: 'r', step: 2, text: 'Done' })

    expect(entries).to.have.length(2)
    expect(entries[1].text).to.equal('ReadingDone')
    expect(entries[1].toolCalls[0]).to.deep.equal({
      id: 'c1',
      name: 'read_file',
      args: { path: 'a.tex' },
      step: 1,
      result: { content: 'x' },
      isError: false,
    })
    expect(queuedEntry({ id: 'q1', text: 'more', images: [] })).to.deep.equal({
      id: 'q1',
      role: 'user',
      text: 'more',
    })
  })

  it('counts the last response by its usage, and only the messages after it by estimate', function () {
    expect(
      usageTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 })
    ).to.equal(10)
    expect(anchorAt({ inputTokens: 1, partialInput: true }, 3)).to.equal(null)
    expect(anchorAt({ inputTokens: 10 }, 3)).to.deep.equal({ tokens: 10, index: 3 })

    const messages = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c'.repeat(40) },
    ]
    const count = anchoredRequestCount({
      system: '',
      messages,
      provider: 'openai',
      model: 'gpt-4o',
      anchor: { tokens: 500, index: 2 },
    })
    expect(count.exact).to.equal(true)
    expect(count.anchoredTokens).to.equal(500)
    // Only the message at index 2 is after the anchor: 40 characters, 10 tokens, and 3 of framing
    expect(count.estimatedTokens).to.equal(13)
    expect(anchoredRequestCount({ system: '', messages, provider: 'openai', model: 'gpt-4o' }).exact).to.equal(false)
  })

  it('allows an automatic compaction at most once every two steps', function () {
    expect(autoCompactionAllowed({ lastStep: null, failures: 0, disabled: false }, 1)).to.equal(true)
    expect(autoCompactionAllowed({ lastStep: 3, failures: 0, disabled: false }, 4)).to.equal(false)
    expect(autoCompactionAllowed({ lastStep: 3, failures: 0, disabled: false }, 5)).to.equal(true)
    expect(autoCompactionAllowed({ lastStep: null, failures: 3, disabled: true }, 9)).to.equal(false)
  })
})
