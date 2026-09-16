import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistRunController } from '../../../app/src/AiAssistRunController.mjs'

describe('AiAssistRunController', function () {
  let controller
  let mockManager
  let mockStore

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
    }

    controller = new AiAssistRunController({
      manager: mockManager,
      store: mockStore,
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
})
