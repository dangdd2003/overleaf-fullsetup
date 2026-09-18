import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistRunController } from '../../../app/src/AiAssistRunController.mjs'

describe('AiAssistRunController', function () {
  let controller
  let mockManager
  let mockStore
  let fakeSubscriber

  beforeEach(function () {
    mockManager = {
      startRun: sinon.stub().resolves(),
      stopRun: sinon.stub().resolves(),
      approveEdit: sinon.stub().resolves(),
    }

    mockStore = {
      getRun: sinon.stub().resolves({ runId: 'run-1', projectId: 'p1', status: 'running' }),
      getEvents: sinon.stub().resolves([
        { seq: 1, event: { type: 'text', text: 'hi' } },
      ]),
      addWatcher: sinon.stub().resolves(1),
      removeWatcher: sinon.stub().resolves(0),
    }

    fakeSubscriber = {
      listeners: new Map(),
      subscribe: sinon.stub().callsFake(async (channel, listener) => {
        fakeSubscriber.listeners.set(channel, listener)
        return fakeSubscriber.release
      }),
      release: sinon.stub(),
    }

    controller = new AiAssistRunController({
      manager: mockManager,
      store: mockStore,
      subscriber: fakeSubscriber,
    })
  })

  it('creates run and responds with runId', async function () {
    const req = {
      params: { Project_id: 'proj-1' },
      session: { user: { _id: 'user-1' } },
      body: {
        transcript: [{ role: 'user', content: 'test' }],
        providerSettings: { type: 'openai', apiKey: 'key', model: 'gpt-4o' },
      },
    }
    const res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis(),
    }

    await controller.createRun(req, res)
    expect(res.json.calledOnce).to.be.true
    const responseData = res.json.firstCall.args[0]
    expect(responseData.runId).to.be.a('string')
    expect(mockManager.startRun.calledOnce).to.be.true
  })

  it('handles stop run requests', async function () {
    const req = { params: { runId: 'run-1' } }
    const res = { json: sinon.stub(), status: sinon.stub().returnsThis() }

    await controller.stopRun(req, res)
    expect(mockManager.stopRun.calledWith('run-1')).to.be.true
    expect(res.json.calledWith({ ok: true })).to.be.true
  })

  it('handles approve requests', async function () {
    const req = {
      params: { runId: 'run-1' },
      body: { accepted: true },
    }
    const res = { json: sinon.stub(), status: sinon.stub().returnsThis() }

    await controller.approve(req, res)
    expect(mockManager.approveEdit.calledWith('run-1', { accepted: true })).to.be.true
    expect(res.json.calledWith({ ok: true })).to.be.true
  })

  it('rejects createRun with 400 when providerSettings.baseUrl is internal service', async function () {
    const req = {
      params: { Project_id: 'proj-1' },
      session: { user: { _id: 'user-1' } },
      body: {
        transcript: [{ role: 'user', content: 'test' }],
        providerSettings: { type: 'openai', baseUrl: 'http://mongo:27017', apiKey: 'key' },
      },
    }
    const res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis(),
    }

    await controller.createRun(req, res)
    expect(res.status.calledWith(400)).to.be.true
    expect(mockManager.startRun.called).to.be.false
  })

  it('generates runId with 128-bit hex entropy', async function () {
    const req = {
      params: { Project_id: 'proj-1' },
      session: { user: { _id: 'user-1' } },
      body: {
        transcript: [{ role: 'user', content: 'test' }],
        providerSettings: { type: 'openai', apiKey: 'key' },
      },
    }
    const res = { json: sinon.stub(), status: sinon.stub().returnsThis() }

    await controller.createRun(req, res)
    const runId = res.json.firstCall.args[0].runId
    // Format: run_<timestamp>_<32 hex chars>
    const parts = runId.split('_')
    expect(parts[0]).to.equal('run')
    expect(parts[2]).to.have.lengthOf(32)
  })

  it('rejects streamRun with 403 when route Project_id does not match run.projectId', async function () {
    const req = {
      params: { Project_id: 'attacker-proj', runId: 'run-1' },
      query: {},
      session: { user: { _id: 'user-1' } },
      on: sinon.stub(),
    }
    const res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis(),
    }

    // mockStore.getRun returns projectId: 'p1'
    await controller.streamRun(req, res)
    expect(res.status.calledWith(403)).to.be.true
    expect(res.json.firstCall.args[0].error).to.include('forbidden')
  })

  it('rejects stopRun with 403 when route Project_id does not match run.projectId', async function () {
    const req = {
      params: { Project_id: 'mismatched-proj', runId: 'run-1' },
      session: { user: { _id: 'user-1' } },
    }
    const res = { json: sinon.stub(), status: sinon.stub().returnsThis() }

    await controller.stopRun(req, res)
    expect(res.status.calledWith(403)).to.be.true
    expect(mockManager.stopRun.called).to.be.false
  })

  it('rejects approve with 403 when route Project_id does not match run.projectId', async function () {
    const req = {
      params: { Project_id: 'mismatched-proj', runId: 'run-1' },
      body: { accepted: true },
      session: { user: { _id: 'user-1' } },
    }
    const res = { json: sinon.stub(), status: sinon.stub().returnsThis() }

    await controller.approve(req, res)
    expect(res.status.calledWith(403)).to.be.true
    expect(mockManager.approveEdit.called).to.be.false
  })

  it('increments watcher count on subscribe and decrements on close', async function () {
    let closeHandler
    const req = {
      params: { Project_id: 'p1', runId: 'run-1' },
      query: {},
      session: { user: { _id: 'user-1' } },
      on: sinon.stub().callsFake((event, handler) => {
        if (event === 'close') closeHandler = handler
      }),
    }
    const res = {
      setHeader: sinon.stub(),
      flushHeaders: sinon.stub(),
      write: sinon.stub(),
      end: sinon.stub(),
    }

    await controller.streamRun(req, res)
    expect(fakeSubscriber.subscribe.calledWith('ai-assist:run:run-1:channel')).to.be.true
    expect(mockStore.addWatcher.calledWith('run-1')).to.be.true
    expect(mockStore.removeWatcher.called).to.be.false

    closeHandler()
    expect(mockStore.removeWatcher.calledWith('run-1')).to.be.true
    expect(fakeSubscriber.release.calledOnce).to.be.true
  })

  it('does not increment or decrement watcher count if request closes before subscribe resolves', async function () {
    let resolveSubscribe
    fakeSubscriber.subscribe = sinon.stub().callsFake(
      () => new Promise(resolve => {
        resolveSubscribe = () => resolve(fakeSubscriber.release)
      })
    )

    let closeHandler
    const req = {
      params: { Project_id: 'p1', runId: 'run-1' },
      query: {},
      session: { user: { _id: 'user-1' } },
      on: sinon.stub().callsFake((event, handler) => {
        if (event === 'close') closeHandler = handler
      }),
    }
    const res = {
      setHeader: sinon.stub(),
      flushHeaders: sinon.stub(),
      write: sinon.stub(),
      end: sinon.stub(),
    }

    const streamPromise = controller.streamRun(req, res)
    await new Promise(r => setTimeout(r, 0))
    closeHandler()
    resolveSubscribe()
    await streamPromise

    expect(mockStore.addWatcher.called).to.be.false
    expect(mockStore.removeWatcher.called).to.be.false
    // The channel handle obtained after close must still be released.
    expect(fakeSubscriber.release.calledOnce).to.be.true
  })

  it('forwards live pub/sub messages to the SSE response', async function () {
    mockStore.getEvents.resolves([])
    mockStore.getRun.resolves({ runId: 'run-1', projectId: 'p1', status: 'running' })
    const req = {
      params: { Project_id: 'p1', runId: 'run-1' },
      query: {},
      session: { user: { _id: 'user-1' } },
      on: sinon.stub(),
    }
    const res = {
      setHeader: sinon.stub(),
      flushHeaders: sinon.stub(),
      write: sinon.stub(),
      end: sinon.stub(),
    }

    await controller.streamRun(req, res)
    const listener = fakeSubscriber.listeners.get('ai-assist:run:run-1:channel')
    listener(JSON.stringify({ seq: 5, event: { type: 'text', text: 'hi' } }))

    expect(res.write.calledWith(`data: ${JSON.stringify({ seq: 5, event: { type: 'text', text: 'hi' } })}\n\n`)).to.be.true
  })

  it('accepts createRun with rich transcripts up to maxTranscriptBytes (e.g. 500KB)', async function () {
    const largeText = 'x'.repeat(500000)
    const req = {
      params: { Project_id: 'proj-1' },
      session: { user: { _id: 'user-1' } },
      body: {
        transcript: [{ role: 'user', content: largeText }],
        providerSettings: { type: 'openai', apiKey: 'key' },
      },
    }
    const res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis(),
    }

    await controller.createRun(req, res)
    expect(res.status.called).to.be.false
    expect(res.json.calledOnce).to.be.true
    expect(mockManager.startRun.calledOnce).to.be.true
  })

  it('rejects createRun with 400 when transcript exceeds maxTranscriptBytes', async function () {
    const hugeText = 'x'.repeat(5500000)
    const req = {
      params: { Project_id: 'proj-1' },
      session: { user: { _id: 'user-1' } },
      body: {
        transcript: [{ role: 'user', content: hugeText }],
        providerSettings: { type: 'openai', apiKey: 'key' },
      },
    }
    const res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis(),
    }

    await controller.createRun(req, res)
    expect(res.status.calledWith(400)).to.be.true
    expect(res.json.firstCall.args[0].error).to.include('too large')
    expect(mockManager.startRun.called).to.be.false
  })

  it('disables proxy buffering on the SSE response', async function () {
    const req = {
      params: { Project_id: 'p1', runId: 'run-1' },
      query: {},
      session: { user: { _id: 'user-1' } },
      on: sinon.stub(),
    }
    const res = {
      setHeader: sinon.stub(),
      flushHeaders: sinon.stub(),
      write: sinon.stub(),
      end: sinon.stub(),
    }

    await controller.streamRun(req, res)

    expect(res.setHeader.calledWith('X-Accel-Buffering', 'no')).to.be.true
    expect(res.setHeader.calledWith('Cache-Control', 'no-cache, no-transform')).to.be.true
  })

  it('writes SSE comment keep-alives while the stream is idle and stops after close', async function () {
    const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      let closeHandler
      const req = {
        params: { Project_id: 'p1', runId: 'run-1' },
        query: {},
        session: { user: { _id: 'user-1' } },
        on: sinon.stub().callsFake((event, handler) => {
          if (event === 'close') closeHandler = handler
        }),
      }
      const res = {
        setHeader: sinon.stub(),
        flushHeaders: sinon.stub(),
        write: sinon.stub(),
        end: sinon.stub(),
        writableEnded: false,
      }

      await controller.streamRun(req, res)
      clock.tick(15000)
      expect(res.write.calledWith(': keepalive\n\n')).to.be.true

      const writesBeforeClose = res.write.callCount
      closeHandler()
      clock.tick(60000)
      expect(res.write.callCount).to.equal(writesBeforeClose)
    } finally {
      clock.restore()
    }
  })
})

