import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistRunControl } from '../../../app/src/AiAssistRunControl.mjs'
import { AiAssistRunManager } from '../../../app/src/AiAssistRunManager.mjs'

describe('AiAssistRunControl', function () {
  function createFakeRedis() {
    const listeners = []
    const publishSpy = sinon.stub().callsFake(async (chan, msg) => {
      for (const l of listeners) {
        l(chan, msg)
      }
      return 1
    })

    return {
      publishSpy,
      createClient: () => {
        const clientListeners = new Map()
        return {
          publish: publishSpy,
          subscribe: sinon.stub().resolves(),
          unsubscribe: sinon.stub().resolves(),
          on: sinon.stub().callsFake((ev, fn) => {
            if (!clientListeners.has(ev)) clientListeners.set(ev, [])
            clientListeners.get(ev).push(fn)
            if (ev === 'message') listeners.push(fn)
          }),
          removeListener: sinon.stub().callsFake((ev, fn) => {
            const list = clientListeners.get(ev)
            if (list) {
              const idx = list.indexOf(fn)
              if (idx >= 0) list.splice(idx, 1)
            }
            const lIdx = listeners.indexOf(fn)
            if (lIdx >= 0) listeners.splice(lIdx, 1)
          }),
        }
      },
    }
  }

  it('publishes stop command to the control channel', async function () {
    const fakeRedis = createFakeRedis()
    const control = new AiAssistRunControl({ clientFactory: fakeRedis.createClient })

    await control.publish('run-1', { action: 'stop' })

    expect(fakeRedis.publishSpy.calledWith('ai-assist:run:control')).to.be.true
    const payload = JSON.parse(fakeRedis.publishSpy.firstCall.args[1])
    expect(payload).to.deep.equal({ runId: 'run-1', action: 'stop' })
  })

  it('delivers control messages to onCommand subscribers', async function () {
    const fakeRedis = createFakeRedis()
    const control = new AiAssistRunControl({ clientFactory: fakeRedis.createClient })

    const commands = []
    const stopListening = await control.start({
      onCommand: cmd => commands.push(cmd),
    })

    await control.publish('run-test', { action: 'stop' })
    expect(commands).to.deep.equal([{ runId: 'run-test', action: 'stop' }])

    stopListening()
  })

  it('stops a run across instances when stopRun is called on a non-owning manager', async function () {
    const fakeRedis = createFakeRedis()
    const controlA = new AiAssistRunControl({ clientFactory: fakeRedis.createClient })
    const controlB = new AiAssistRunControl({ clientFactory: fakeRedis.createClient })

    const mockStore = {
      createRun: sinon.stub().resolves(),
      appendEvent: sinon.stub().resolves(1),
      updateStatus: sinon.stub().resolves(),
      setPendingApproval: sinon.stub().resolves(),
      clearPendingApproval: sinon.stub().resolves(),
      getPendingApproval: sinon.stub().resolves(),
      getRun: sinon.stub().resolves({ status: 'running' }),
      touchHeartbeat: sinon.stub().resolves(),
    }
    const mockTools = { execute: sinon.stub().resolves({ content: 'ok' }) }
    const mockClient = {
      streamChat: sinon.stub().callsFake(async function* () {
        yield { type: 'thinking', text: 'working...' }
        await new Promise(r => setTimeout(r, 200))
        yield { type: 'text', text: 'done' }
      }),
    }

    const managerA = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
    })
    const managerB = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
    })

    managerA.attachControl(controlA)
    managerB.attachControl(controlB)

    const stopA = await controlA.start({ onCommand: cmd => managerA.onCommand(cmd) })
    const stopB = await controlB.start({ onCommand: cmd => managerB.onCommand(cmd) })

    // Manager A starts the run
    const runPromise = managerA.startRun({
      runId: 'run-cross',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'k' },
    })

    await new Promise(r => setTimeout(r, 10))

    // Manager B receives the stop request
    await managerB.stopRun('run-cross')
    await runPromise

    expect(mockStore.updateStatus.calledWith('run-cross', 'stopped')).to.be.true

    stopA()
    stopB()
  })

  it('resolves approval across instances when approveEdit is called on a non-owning manager', async function () {
    const fakeRedis = createFakeRedis()
    const controlA = new AiAssistRunControl({ clientFactory: fakeRedis.createClient })
    const controlB = new AiAssistRunControl({ clientFactory: fakeRedis.createClient })

    const mockStore = {
      createRun: sinon.stub().resolves(),
      appendEvent: sinon.stub().resolves(1),
      updateStatus: sinon.stub().resolves(),
      setPendingApproval: sinon.stub().resolves(),
      clearPendingApproval: sinon.stub().resolves(),
      getPendingApproval: sinon.stub().resolves(),
      getRun: sinon.stub().resolves({ status: 'running' }),
      touchHeartbeat: sinon.stub().resolves(),
    }
    const mockTools = { execute: sinon.stub().resolves({ content: 'edited' }) }
    let callCount = 0
    const mockClient = {
      streamChat: sinon.stub().callsFake(async function* () {
        callCount++
        if (callCount === 1) {
          yield { type: 'tool_call', id: 'edit-1', name: 'edit_file', args: { path: 'a.tex' } }
        } else {
          yield { type: 'text', text: 'applied' }
        }
      }),
    }

    const managerA = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
    })
    const managerB = new AiAssistRunManager({
      store: mockStore,
      tools: mockTools,
      clientFactory: () => mockClient,
    })

    managerA.attachControl(controlA)
    managerB.attachControl(controlB)

    const stopA = await controlA.start({ onCommand: cmd => managerA.onCommand(cmd) })
    const stopB = await controlB.start({ onCommand: cmd => managerB.onCommand(cmd) })

    const runPromise = managerA.startRun({
      runId: 'run-approve-cross',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'k' },
    })

    await new Promise(r => setTimeout(r, 10))

    // Manager B receives the approval decision
    await managerB.approveEdit('run-approve-cross', { accepted: true })
    await runPromise

    expect(mockTools.execute.calledWith('edit_file')).to.be.true

    stopA()
    stopB()
  })

  it('guards against broadcast storm: publishing stop for unowned run publishes exactly once', async function () {
    const fakeRedis = createFakeRedis()
    const controlA = new AiAssistRunControl({ clientFactory: fakeRedis.createClient })
    const controlB = new AiAssistRunControl({ clientFactory: fakeRedis.createClient })

    const mockStore = {
      createRun: sinon.stub().resolves(),
      appendEvent: sinon.stub().resolves(1),
      updateStatus: sinon.stub().resolves(),
      touchHeartbeat: sinon.stub().resolves(),
    }
    const managerA = new AiAssistRunManager({ store: mockStore })
    const managerB = new AiAssistRunManager({ store: mockStore })

    managerA.attachControl(controlA)
    managerB.attachControl(controlB)

    const stopA = await controlA.start({ onCommand: cmd => managerA.onCommand(cmd) })
    const stopB = await controlB.start({ onCommand: cmd => managerB.onCommand(cmd) })

    // Stop a run that neither A nor B owns
    await managerA.stopRun('run-unowned')

    // Allow any potential re-broadcast microtasks to settle
    await new Promise(r => setTimeout(r, 50))

    // Must be called exactly once (the initial publish from managerA.stopRun), not looping
    expect(fakeRedis.publishSpy.callCount).to.equal(1)

    stopA()
    stopB()
  })
})
