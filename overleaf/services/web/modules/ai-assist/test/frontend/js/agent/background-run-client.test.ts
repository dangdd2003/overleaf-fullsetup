import { expect } from 'chai'
import sinon from 'sinon'
import {
  startBackgroundRun,
  stopBackgroundRun,
  approveBackgroundEdit,
  connectRunStream,
} from '../../../../frontend/js/features/ai-assist/agent/background/background-run-client'

describe('background-run-client', function () {
  let fakeFetch: sinon.SinonStub
  let originalEventSource: any

  beforeEach(function () {
    fakeFetch = sinon.stub(globalThis, 'fetch' as any)
    originalEventSource = globalThis.EventSource
  })

  afterEach(function () {
    fakeFetch.restore()
    globalThis.EventSource = originalEventSource
  })

  it('posts to create run endpoint and returns runId', async function () {
    fakeFetch.resolves({
      ok: true,
      json: sinon.stub().resolves({ runId: 'run-abc' }),
    })

    const runId = await startBackgroundRun({
      projectId: 'proj-1',
      transcript: [{ id: '1', role: 'user', text: 'test' }],
      providerSettings: {
        type: 'openai',
        model: 'gpt-4o',
        apiKey: 'k',
        baseUrl: '',
      },
    })

    expect(runId).to.equal('run-abc')
    expect(fakeFetch.firstCall.args[0]).to.equal('/ai-assist/projects/proj-1/runs')
  })

  it('posts to stop run endpoint', async function () {
    fakeFetch.resolves({ ok: true, json: sinon.stub().resolves({ ok: true }) })
    await stopBackgroundRun('run-abc')
    expect(fakeFetch.firstCall.args[0]).to.equal('/ai-assist/runs/run-abc/stop')
  })

  it('posts approval decisions', async function () {
    fakeFetch.resolves({ ok: true, json: sinon.stub().resolves({ ok: true }) })
    await approveBackgroundEdit('run-abc', { accepted: true })
    expect(fakeFetch.firstCall.args[0]).to.equal('/ai-assist/runs/run-abc/approve')
  })

  it('connects to project-scoped stream endpoint', function () {
    const eventSourceSpy = sinon.spy()
    globalThis.EventSource = eventSourceSpy as any

    connectRunStream({
      runId: 'run-123',
      projectId: 'proj-456',
      onEvent: () => {},
      onDone: () => {},
      onError: () => {},
    })

    expect(
      eventSourceSpy.calledWith(
        '/ai-assist/projects/proj-456/runs/run-123/stream?since=0'
      )
    ).to.be.true
  })

  it('closes eventSource and clears stored active run on stream message processing error', function () {
    let messageHandler: ((msg: any) => void) | null = null
    const closeStub = sinon.stub()

    function FakeEventSource(this: any) {
      this.close = closeStub
      Object.defineProperty(this, 'onmessage', {
        set(fn) {
          messageHandler = fn
        },
      })
    }
    globalThis.EventSource = FakeEventSource as any

    const onErrorSpy = sinon.spy()
    connectRunStream({
      runId: 'run-123',
      projectId: 'proj-456',
      onEvent: () => {
        throw new Error('boom')
      },
      onDone: () => {},
      onError: onErrorSpy,
    })

    expect(messageHandler).to.be.a('function')
    messageHandler!({ data: JSON.stringify({ event: { type: 'text', text: 'hi' } }) })

    expect(closeStub.calledOnce).to.be.true
    expect(onErrorSpy.calledOnce).to.be.true
  })
})
