import { expect } from 'chai'
import sinon from 'sinon'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  startBackgroundRun,
  stopBackgroundRun,
  approveBackgroundEdit,
  connectRunStream,
  setDetachedRun,
  getDetachedRuns,
} from '../../../../frontend/js/features/ai-assist/agent/background/background-run-client'
import { followDetachedRun } from '../../../../frontend/js/features/ai-assist/agent/background/detached-run-follower'

describe('background-run-client', function () {
  let fakeFetch: sinon.SinonStub
  let originalEventSource: any
  // Every stream a test opens is closed afterwards: a stream left open keeps
  // its visibility listener and would open sockets in the next test
  let cleanups: Array<() => void> = []
  const connect = (options: Parameters<typeof connectRunStream>[0]) => {
    const close = connectRunStream(options)
    cleanups.push(close)
    return close
  }
  // Lets pending promise callbacks run, without fake timers
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  beforeEach(function () {
    fakeFetch = sinon.stub(globalThis, 'fetch' as any)
    originalEventSource = globalThis.EventSource
    cleanups = []
  })

  afterEach(function () {
    for (const close of cleanups) close()
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
    const instances = installFakeEventSource()

    connect({
      runId: 'run-123',
      projectId: 'proj-456',
      onEvent: () => {},
      onDone: () => {},
      onError: () => {},
    })

    expect(instances[0].url).to.equal(
      '/ai-assist/projects/proj-456/runs/run-123/stream?since=0'
    )
  })

  it('keeps the stream open when an event handler throws', function () {
    const instances = installFakeEventSource()
    const onEvent = sinon.stub().throws(new Error('boom'))
    const onErrorSpy = sinon.spy()
    connect({
      runId: 'run-123',
      projectId: 'proj-456',
      onEvent,
      onDone: () => {},
      onError: onErrorSpy,
    })

    instances[0].onmessage({
      data: JSON.stringify({ seq: 1, event: { type: 'text', text: 'hi' } }),
    })
    instances[0].onmessage({
      data: JSON.stringify({ seq: 2, event: { type: 'text', text: 'more' } }),
    })

    expect(onEvent.calledTwice).to.equal(true)
    expect(instances[0].close.called).to.equal(false)
    expect(onErrorSpy.called).to.equal(false)
  })

  it('reconnects instead of failing on an unreadable frame', function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const onEvent = sinon.spy()
      const onError = sinon.spy()
      connect({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent,
        onDone: () => {},
        onError,
        reconnectDelayMs: 10,
      })
      instances[0].onmessage({ data: '{not json' })
      clock.tick(10)

      expect(onEvent.called).to.equal(false)
      expect(onError.called).to.equal(false)
      expect(instances).to.have.length(2)
    } finally {
      clock.restore()
    }
  })

  function installFakeEventSource() {
    const instances: any[] = []
    function FakeEventSource(this: any, url: string) {
      this.url = url
      this.close = sinon.stub()
      this.onmessage = null
      this.onerror = null
      this.onopen = null
      this.readyState = 1
      this.listeners = {} as Record<string, (msg: any) => void>
      this.addEventListener = (type: string, fn: (msg: any) => void) => {
        this.listeners[type] = fn
      }
      instances.push(this)
    }
    ;(FakeEventSource as any).OPEN = 1
    globalThis.EventSource = FakeEventSource as any
    return instances
  }

  it('tells the caller once the run has caught up, without an event', function () {
    const instances = installFakeEventSource()
    const onEvent = sinon.spy()
    const onCaughtUp = sinon.spy()
    connect({
      runId: 'run-1',
      projectId: 'proj-1',
      onEvent,
      onCaughtUp,
      onDone: () => {},
      onError: () => {},
    })

    instances[0].onmessage({
      data: JSON.stringify({ seq: 1, event: { type: 'text', text: 'a' } }),
    })
    expect(onCaughtUp.called).to.equal(false)
    instances[0].onmessage({ data: JSON.stringify({ caughtUp: true }) })

    expect(onCaughtUp.calledOnce).to.equal(true)
    expect(onEvent.calledOnce).to.equal(true)
  })

  it('reconnects after a dropped connection, resuming from the last seq', async function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const onError = sinon.spy()
      const onEvent = sinon.spy()

      connect({
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

      connect({
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

  it('keeps reconnecting past many failures while the run is still there', async function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const onError = sinon.spy()
      fakeFetch.resolves({ status: 500, body: null })

      connect({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent: () => {},
        onDone: () => {},
        onError,
        reconnectDelayMs: 10,
      })

      for (let i = 0; i < 8; i++) {
        instances[instances.length - 1].onerror(new Event('error'))
        clock.tick(40_000)
        await Promise.resolve()
      }

      expect(instances.length).to.be.greaterThan(8)
      expect(onError.called).to.equal(false)
    } finally {
      clock.restore()
    }
  })

  it('stops and reports the error at once when the run is gone (404)', async function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const onError = sinon.spy()
      fakeFetch.resolves({ status: 404, body: null })

      connect({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent: () => {},
        onDone: () => {},
        onError,
        reconnectDelayMs: 10,
      })
      instances[0].onerror(new Event('error'))
      await flush()
      clock.tick(100)

      expect(onError.calledOnce).to.equal(true)
      expect(onError.firstCall.args[1]).to.deep.equal({ gone: true })
      expect(instances).to.have.length(1)
    } finally {
      clock.restore()
    }
  })

  it('reports the error only after the reconnect budget is spent', function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const onError = sinon.spy()
      connect({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent: () => {},
        onDone: () => {},
        onError,
        reconnectDelayMs: 10,
      })
      for (let i = 0; i < 60 && !onError.called; i++) {
        instances[instances.length - 1].onerror(new Event('error'))
        clock.tick(30_000)
      }

      expect(onError.calledOnce).to.equal(true)
      // The run may still be going: its id stays for a reload to reattach
      expect(onError.firstCall.args[1]).to.deep.equal({ gone: false })
    } finally {
      clock.restore()
    }
  })

  it('arms the heartbeat watchdog only after the first heartbeat', function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      connect({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent: () => {},
        onDone: () => {},
        onError: () => {},
      })
      // A quiet stream with no heartbeats is left alone (older servers)
      clock.tick(120_000)
      expect(instances).to.have.length(1)

      instances[0].listeners.heartbeat({ data: '{}' })
      clock.tick(30_000)
      instances[0].listeners.heartbeat({ data: '{}' })
      clock.tick(30_000)
      expect(instances).to.have.length(1)

      // Silent for 45s after the last heartbeat: dropped and reconnected
      clock.tick(46_000)
      expect(instances[0].close.called).to.equal(true)
      clock.tick(1000)
      expect(instances).to.have.length(2)
      expect(instances[1].url).to.equal(
        '/ai-assist/projects/proj-1/runs/run-1/stream?since=0'
      )
    } finally {
      clock.restore()
    }
  })

  it('reconnects when the tab becomes visible while the stream is down', function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      connect({
        runId: 'run-1',
        projectId: 'proj-1',
        onEvent: () => {},
        onDone: () => {},
        onError: () => {},
        reconnectDelayMs: 30_000,
      })
      instances[0].onerror(new Event('error'))
      expect(instances).to.have.length(1)

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
      expect(instances).to.have.length(2)
    } finally {
      clock.restore()
      delete (document as any).visibilityState
    }
  })

  it('skips events already seen after a reconnect', function () {
    const instances = installFakeEventSource()
    const onEvent = sinon.spy()
    connect({
      runId: 'run-1',
      projectId: 'proj-1',
      onEvent,
      onDone: () => {},
      onError: () => {},
    })
    instances[0].onmessage({
      data: JSON.stringify({ seq: 3, event: { type: 'text', text: 'a' } }),
    })
    instances[0].onmessage({
      data: JSON.stringify({ seq: 3, event: { type: 'text', text: 'a' } }),
    })
    instances[0].onmessage({
      data: JSON.stringify({ seq: 2, event: { type: 'text', text: 'old' } }),
    })

    expect(onEvent.callCount).to.equal(1)
  })

  it('does not reconnect after the cleanup function is called', function () {
    const clock = sinon.useFakeTimers()
    try {
      const instances = installFakeEventSource()
      const close = connect({
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

  it('clears stale detached run from storage when followDetachedRun is called with empty transcript', function () {
    setDetachedRun('proj-1', 'chat-1', {
      runId: 'run-stale',
      startedAt: Date.now(),
    })
    expect(getDetachedRuns('proj-1')).to.have.property('chat-1')

    const result = followDetachedRun({
      projectId: 'proj-1',
      chatId: 'chat-1',
      runId: 'run-stale',
      startedAt: Date.now(),
      transcript: [],
      mode: 'manual',
    })

    expect(result).to.equal(false)
    expect(getDetachedRuns('proj-1')).to.not.have.property('chat-1')
  })
})
