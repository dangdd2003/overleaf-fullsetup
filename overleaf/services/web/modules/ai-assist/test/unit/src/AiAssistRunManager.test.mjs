import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistRunManager } from '../../../app/src/AiAssistRunManager.mjs'

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

  it('emits toolCallFinished with call id and name on non-edit tool', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'config-1', name: 'configure_appearance_settings', args: { fontSize: 14 } }
      } else {
        yield { type: 'text', text: 'Settings configured.' }
      }
    })

    mockTools.execute.resolves({ status: 'applied', updatedSettings: { fontSize: 14 } })

    const runPromise = manager.startRun({
      runId: 'run-tool-name',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'change font size' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await runPromise

    expect(
      mockStore.appendEvent.calledWith(
        'run-tool-name',
        sinon.match({
          type: 'toolCallFinished',
          id: 'config-1',
          name: 'configure_appearance_settings',
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
    mockClient.streamChat.callsFake(async function* () {
      yield {
        type: 'tool_call',
        id: 'call-fail',
        name: 'read_file',
        args: { path: 'nonexistent.tex' },
      }
    })

    mockTools.execute.resolves({ error: 'File not found' })

    const runPromise = manager.startRun({
      runId: 'run-fail',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    await runPromise

    expect(mockClient.streamChat.callCount).to.equal(2)
    const turnFinishedCalls = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[1]?.type === 'turnFinished')
    expect(turnFinishedCalls).to.have.lengthOf(1)
    expect(mockStore.updateStatus.calledWith('run-fail', 'done')).to.be.true
  })

  it('stops prompting user when user rejects an edit and completes turn cleanly', async function () {
    let callCount = 0
    let passedToolsInSecondCall = null

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

    // Tools must be disabled in subsequent step to prevent continuous prompting
    expect(passedToolsInSecondCall).to.be.an('array').that.is.empty
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
})
