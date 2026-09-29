import { expect } from 'chai'
import sinon from 'sinon'
import customLocalStorage from '@/infrastructure/local-storage'
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

  it('surfaces server error message when create run endpoint returns non-ok with error json', async function () {
    fakeFetch.resolves({
      ok: false,
      status: 400,
      json: sinon.stub().resolves({ error: 'Conversation is too large to send' }),
    })

    try {
      await startBackgroundRun({
        projectId: 'proj-1',
        transcript: [{ id: '1', role: 'user', text: 'test' }],
        providerSettings: {
          type: 'openai',
          model: 'gpt-4o',
          apiKey: 'k',
          baseUrl: '',
        },
      })
      expect.fail('should have thrown')
    } catch (err: any) {
      expect(err.message).to.equal('Conversation is too large to send')
    }
  })

  it('falls back to status code message when error json cannot be parsed', async function () {
    fakeFetch.resolves({
      ok: false,
      status: 500,
      json: sinon.stub().rejects(new Error('invalid json')),
    })

    try {
      await startBackgroundRun({
        projectId: 'proj-1',
        transcript: [{ id: '1', role: 'user', text: 'test' }],
        providerSettings: {
          type: 'openai',
          model: 'gpt-4o',
          apiKey: 'k',
          baseUrl: '',
        },
      })
      expect.fail('should have thrown')
    } catch (err: any) {
      expect(err.message).to.equal('Failed to start AI run (500)')
    }
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

  function installFakeEventSource() {
    const instances: any[] = []
    function FakeEventSource(this: any, url: string) {
      this.url = url
      this.close = sinon.stub()
      this.onmessage = null
      this.onerror = null
      this.onopen = null
      instances.push(this)
    }
    globalThis.EventSource = FakeEventSource as any
    return instances
  }

  it('reconnects after a dropped connection, resuming from the last seq', async function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const onError = sinon.spy()
      const onEvent = sinon.spy()

      connectRunStream({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent,
        onDone: () => {},
        onError,
        reconnectDelayMs: 100,
      })

      instances[0].onmessage({
        data: JSON.stringify({ seq: 7, event: { type: 'text', text: 'a' } }),
      })
      instances[0].onerror(new Event('error'))

      expect(instances[0].close.calledOnce).to.equal(true)
      expect(onError.called).to.equal(false)

      clock.tick(100)

      expect(instances).to.have.length(2)
      expect(instances[1].url).to.equal(
        '/ai-assist/projects/proj-1/runs/run-1/stream?since=7'
      )
    } finally {
      clock.restore()
    }
  })

  it('keeps the stored active run id while reconnecting', function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      customLocalStorage.setItem('ai-assist:active-run:proj-1', 'run-1')

      connectRunStream({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent: () => {},
        onDone: () => {},
        onError: () => {},
        reconnectDelayMs: 100,
      })
      instances[0].onerror(new Event('error'))

      expect(customLocalStorage.getItem('ai-assist:active-run:proj-1')).to.equal('run-1')
    } finally {
      clock.restore()
      customLocalStorage.removeItem('ai-assist:active-run:proj-1')
    }
  })

  it('gives up and reports the error after maxReconnects consecutive failures', function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const onError = sinon.spy()

      connectRunStream({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent: () => {},
        onDone: () => {},
        onError,
        maxReconnects: 2,
        reconnectDelayMs: 10,
      })

      instances[0].onerror(new Event('error'))
      clock.tick(10)
      instances[1].onerror(new Event('error'))
      clock.tick(20)
      instances[2].onerror(new Event('error'))
      clock.tick(1000)

      expect(instances).to.have.length(3)
      expect(onError.calledOnce).to.equal(true)
    } finally {
      clock.restore()
    }
  })

  it('does not reconnect after the cleanup function is called', function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const close = connectRunStream({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent: () => {},
        onDone: () => {},
        onError: () => {},
        reconnectDelayMs: 10,
      })

      instances[0].onerror(new Event('error'))
      close()
      clock.tick(1000)

      expect(instances).to.have.length(1)
    } finally {
      clock.restore()
    }
  })
})
