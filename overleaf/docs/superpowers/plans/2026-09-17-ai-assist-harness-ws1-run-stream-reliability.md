# AI Assist Harness WS1: Run Stream Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the main-chat event stream survive real deployments: no leaked Redis connections, no silent proxy cut-offs, no nginx buffering, reconnects that resume instead of giving up, and far fewer Redis round trips while a model thinks.

**Architecture:** The main chat runs server-side (`AiAssistRunManager`) and the browser watches it through an SSE endpoint (`AiAssistRunController.streamRun`) fed by Redis pub/sub plus a Redis event list for catch-up. This plan (1) replaces the per-request Redis subscriber with one shared, reference-counted subscriber, (2) adds SSE keep-alive comments and disables proxy buffering, (3) makes catch-up read only the tail of the event list, (4) makes the browser reconnect with `since=<last seq>` instead of abandoning the run, and (5) batches `thinking` chunks the same way `text` chunks already are.

**Tech Stack:** Node.js ES modules (`.mjs`), Express, Redis via `@overleaf/redis-wrapper` (ioredis), Vitest + Chai + Sinon (backend unit tests), TypeScript + React, Mocha + Chai + Sinon (frontend unit tests), browser `EventSource`.

**Spec:** None. This plan comes from a code review of the `ai-assist` module done on 2026-09-17. The "Background" section below records the verified findings it fixes.

## Global Constraints

- **Never run `git commit`, `git push`, `git stash`, or any history-altering git command.** This repository requires explicit per-command user approval for git writes. Leave every change uncommitted. Each task ends with a verification step, not a commit step. This overrides any sub-skill instruction to commit.
- **Another session may be editing this worktree at the same time** (for example, chat-history work in `AiAssistRunRouter.mjs` and `AiAssistChatHistoryController.mjs`). Line numbers below were verified on 2026-09-17 but can drift. If a quoted "current code" block does not match the file, re-read the file and apply the change to the equivalent code. Never overwrite unrelated edits, and never revert a file.
- **Working directory for all commands:**
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Backend test runner (Vitest).** `services/web/node_modules/.bin/vitest` does NOT exist in this worktree; use the npx-cached binary:
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path>
  ```
  `XDG_DATA_HOME` is required: without it Vitest aborts with "Failed to create Vitest API token".
- **Frontend test runner (Mocha, not Vitest):**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
    --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js \
    --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' <path>
  ```
- **Baseline before Task 1.** Run both full module suites and write down the pass/fail counts. Do not start if anything fails that you cannot attribute to pre-existing work:
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' --reporter dot modules/ai-assist/test/frontend 2>&1 | grep -E "passing|failing"
  ```
  On 2026-09-17 both suites were fully green (backend 127+, frontend 777). The counts grow as other sessions add tests.
- **Keep output small.** When checking a run, grep for `passing|failing|Tests |FAIL|Error` rather than dumping full logs.
- **Every feature stays behind `AI_ASSIST_ENABLED`.** Do not add code that runs when `Settings.aiAssist.enabled` is false.
- **Style:** match the surrounding code. Backend `.mjs` files use 2-space indentation, single quotes, no semicolons.

## Background (verified findings this plan fixes)

1. **Redis connection leak.** `AiAssistRunController.streamRun` (`app/src/AiAssistRunController.mjs:86`) calls `RedisWrapper.client('ai-assist')` for every SSE request. `RedisWrapper.client` (`app/src/infrastructure/RedisWrapper.mjs:12-19`) creates a brand-new connection and registers a shutdown drainer each time. `cleanup()` only unsubscribes and never disconnects, so every stream, reconnect, and page reload leaks a connection and a drainer closure.
2. **No keep-alive, and buffering.** While a tool runs (a compile can take 30s+), an approval waits (up to 10 min), or a model thinks without output, the SSE response writes nothing. Reverse proxies in front of a public domain (Cloudflare ≈100s, many nginx setups 60s) close idle connections. The production image's own nginx (`overleaf/server-ce/nginx/overleaf.conf`, `location /`) has `proxy_buffering` on by default, which holds small SSE frames back. The fix is an `X-Accel-Buffering: no` response header plus periodic SSE comment lines.
3. **Giving up on the first error.** `connectRunStream` (`modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts:113-117`) closes the `EventSource` on the first `onerror`, clears the stored active run id, and reports failure. The run keeps going on the server, but the UI shows "Connection to AI background run failed." and can never reattach.
4. **Full replay on catch-up.** `AiAssistRunStore.getEvents` (`modules/ai-assist/app/src/AiAssistRunStore.mjs:183-189`) runs `LRANGE key 0 -1` and filters by `seq` in JavaScript, so every reconnect downloads and parses the whole run history.
5. **One Redis write per thinking token.** `AiAssistRunManager.startRun` (`modules/ai-assist/app/src/AiAssistRunManager.mjs:335-336`) awaits `emitEvent({ type: 'thinking' })` for every thinking chunk. Each call does `INCR`, `RPUSH`, and `PUBLISH`, and the provider stream is not read again until all three finish. Text chunks are already coalesced (`emitText`, lines 260-267); thinking chunks are not.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `modules/ai-assist/app/src/AiAssistRunSubscriber.mjs` | Create | One shared Redis subscriber connection that fans messages out to per-channel listeners. |
| `modules/ai-assist/app/src/AiAssistRunController.mjs` | Modify | Use the shared subscriber, send keep-alives, disable proxy buffering. |
| `modules/ai-assist/app/src/ModuleSettings.mjs` | Modify | Add `streamKeepAliveSeconds`. |
| `modules/ai-assist/app/src/AiAssistRunStore.mjs` | Modify | `getEvents` reads only the tail of the list. |
| `modules/ai-assist/app/src/AiAssistRunManager.mjs` | Modify | Coalesce thinking chunks like text chunks. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts` | Modify | Reconnect with `since=<lastSeq>` and backoff. |
| `modules/ai-assist/test/unit/src/AiAssistRunSubscriber.test.mjs` | Create | Subscriber tests. |
| `modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs` | Modify | Inject a fake subscriber; keep-alive and header tests. |
| `modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs` | Modify | Tail-read test. |
| `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs` | Modify | Thinking coalescing test. |
| `modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts` | Modify | Reconnect tests. |

---

### Task 1: Shared Redis subscriber for run streams

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistRunSubscriber.mjs`
- Create: `modules/ai-assist/test/unit/src/AiAssistRunSubscriber.test.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistRunController.mjs:1-15` (imports, constructor) and `:85-157` (subscribe logic in `streamRun`)
- Modify: `modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs` (the two tests that stub `RedisWrapper.client`)

**Interfaces:**
- Produces: `class AiAssistRunSubscriber` with `constructor({ clientFactory })` and `async subscribe(channel: string, listener: (message: string) => void): Promise<() => void>`. The returned function unsubscribes; calling it twice is a no-op. Default export: a singleton instance.
- Produces: `AiAssistRunController` constructor accepts `{ manager, store, subscriber }`, where `subscriber` defaults to the singleton.

- [x] **Step 1: Write the failing subscriber test**

Create `modules/ai-assist/test/unit/src/AiAssistRunSubscriber.test.mjs`:

```js
import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistRunSubscriber } from '../../../app/src/AiAssistRunSubscriber.mjs'

function fakeClient() {
  const handlers = []
  return {
    handlers,
    on: sinon.stub().callsFake((event, fn) => {
      if (event === 'message') handlers.push(fn)
    }),
    subscribe: sinon.stub().resolves(),
    unsubscribe: sinon.stub().resolves(),
    emit(channel, message) {
      for (const fn of handlers) fn(channel, message)
    },
  }
}

describe('AiAssistRunSubscriber', function () {
  it('opens exactly one Redis connection for many streams', async function () {
    const client = fakeClient()
    const clientFactory = sinon.stub().returns(client)
    const subscriber = new AiAssistRunSubscriber({ clientFactory })

    await subscriber.subscribe('chan-a', () => {})
    await subscriber.subscribe('chan-b', () => {})
    await subscriber.subscribe('chan-a', () => {})

    expect(clientFactory.callCount).to.equal(1)
    expect(client.on.withArgs('message').callCount).to.equal(1)
  })

  it('subscribes to a channel once and fans messages out to every listener', async function () {
    const client = fakeClient()
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const first = sinon.spy()
    const second = sinon.spy()
    const other = sinon.spy()

    await subscriber.subscribe('chan-a', first)
    await subscriber.subscribe('chan-a', second)
    await subscriber.subscribe('chan-b', other)
    client.emit('chan-a', 'payload')

    expect(client.subscribe.withArgs('chan-a').callCount).to.equal(1)
    expect(first.calledOnceWith('payload')).to.equal(true)
    expect(second.calledOnceWith('payload')).to.equal(true)
    expect(other.called).to.equal(false)
  })

  it('unsubscribes from Redis only when the last listener leaves', async function () {
    const client = fakeClient()
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const releaseFirst = await subscriber.subscribe('chan-a', () => {})
    const releaseSecond = await subscriber.subscribe('chan-a', () => {})

    releaseFirst()
    expect(client.unsubscribe.called).to.equal(false)

    releaseSecond()
    releaseSecond()
    expect(client.unsubscribe.withArgs('chan-a').callCount).to.equal(1)
  })

  it('stops delivering to a released listener', async function () {
    const client = fakeClient()
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const listener = sinon.spy()
    const keep = sinon.spy()
    const release = await subscriber.subscribe('chan-a', listener)
    await subscriber.subscribe('chan-a', keep)

    release()
    client.emit('chan-a', 'later')

    expect(listener.called).to.equal(false)
    expect(keep.calledOnceWith('later')).to.equal(true)
  })

  it('does not keep a listener registered when SUBSCRIBE fails', async function () {
    const client = fakeClient()
    client.subscribe.rejects(new Error('redis down'))
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const listener = sinon.spy()

    let caught = null
    try {
      await subscriber.subscribe('chan-a', listener)
    } catch (err) {
      caught = err
    }
    client.emit('chan-a', 'payload')

    expect(caught?.message).to.equal('redis down')
    expect(listener.called).to.equal(false)
  })

  it('keeps delivering to other listeners when one throws', async function () {
    const client = fakeClient()
    const subscriber = new AiAssistRunSubscriber({ clientFactory: () => client })
    const good = sinon.spy()
    await subscriber.subscribe('chan-a', () => {
      throw new Error('bad listener')
    })
    await subscriber.subscribe('chan-a', good)

    client.emit('chan-a', 'payload')

    expect(good.calledOnceWith('payload')).to.equal(true)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunSubscriber.test.mjs 2>&1 | grep -E "Tests |FAIL|Error" | head -5
```
Expected: FAIL, because `AiAssistRunSubscriber.mjs` cannot be resolved.

- [x] **Step 3: Implement the subscriber**

Create `modules/ai-assist/app/src/AiAssistRunSubscriber.mjs`:

```js
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'

/**
 * One Redis connection in subscriber mode, shared by every run stream in this
 * process.
 *
 * RedisWrapper.client() opens a new connection (and registers a shutdown
 * drainer) on every call, so a connection per SSE request leaks one per
 * stream, reconnect and page reload. Channels are reference-counted: Redis
 * SUBSCRIBE happens for the first listener, UNSUBSCRIBE after the last.
 */
export class AiAssistRunSubscriber {
  constructor({ clientFactory = () => RedisWrapper.client('ai-assist') } = {}) {
    this.clientFactory = clientFactory
    this._client = null
    this._listeners = new Map()
    this._pending = new Map()
    this._onMessage = (channel, message) => {
      const listeners = this._listeners.get(channel)
      if (!listeners) return
      for (const listener of [...listeners]) {
        try {
          listener(message)
        } catch {
          // One broken stream must not starve the others on this channel.
        }
      }
    }
  }

  _getClient() {
    if (!this._client) {
      this._client = this.clientFactory()
      this._client.on('message', this._onMessage)
    }
    return this._client
  }

  _remove(channel, listener, client) {
    const listeners = this._listeners.get(channel)
    if (!listeners) return
    listeners.delete(listener)
    if (listeners.size === 0) {
      this._listeners.delete(channel)
      Promise.resolve(client.unsubscribe(channel)).catch(() => {})
    }
  }

  async subscribe(channel, listener) {
    const client = this._getClient()
    let listeners = this._listeners.get(channel)
    if (!listeners) {
      listeners = new Set()
      this._listeners.set(channel, listeners)
    }
    listeners.add(listener)

    try {
      if (listeners.size === 1) {
        const pending = Promise.resolve(client.subscribe(channel))
        this._pending.set(channel, pending)
        try {
          await pending
        } finally {
          if (this._pending.get(channel) === pending) {
            this._pending.delete(channel)
          }
        }
      } else if (this._pending.has(channel)) {
        // A second stream joined while the first SUBSCRIBE is still in flight.
        await this._pending.get(channel)
      }
    } catch (err) {
      this._remove(channel, listener, client)
      throw err
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this._remove(channel, listener, client)
    }
  }
}

export default new AiAssistRunSubscriber()
```

> **TRAP — do not call `client.quit()` or `client.disconnect()` in `_remove`.** The connection is shared by the whole process and closed by the drainer that `RedisWrapper.client` registered. Closing it here would break every other open stream.

- [x] **Step 4: Run the subscriber test to verify it passes**

Same command as Step 2. Expected: `Tests  6 passed (6)`.

- [x] **Step 5: Switch the controller to the shared subscriber**

In `modules/ai-assist/app/src/AiAssistRunController.mjs`:

Replace the import on line 8:
```js
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'
```
with:
```js
import defaultSubscriber from './AiAssistRunSubscriber.mjs'
```

Replace the constructor (lines 12-15):
```js
  constructor({ manager = defaultManager, store = defaultStore } = {}) {
    this.manager = manager
    this.store = store
  }
```
with:
```js
  constructor({
    manager = defaultManager,
    store = defaultStore,
    subscriber = defaultSubscriber,
  } = {}) {
    this.manager = manager
    this.store = store
    this.subscriber = subscriber
  }
```

In `streamRun`, replace everything from the comment `// 1. Subscribe FIRST to avoid missing any live events` down to and including `await subClient.subscribe(channel)` and the `if (closed) { ... }` block that follows it. This is the current code (lines 85-139):
```js
    // 1. Subscribe FIRST to avoid missing any live events
    const subClient = RedisWrapper.client('ai-assist')
    const channel = `ai-assist:run:${runId}:channel`
    let lastSentSeq = sinceSeq
    const liveBuffer = []
    let subscribed = false

    const onMessage = (chan, message) => {
      if (chan !== channel) return
      if (!subscribed) {
        liveBuffer.push(message)
        return
      }
      try {
        const parsed = JSON.parse(message)
        if (parsed.seq <= lastSentSeq) return
        lastSentSeq = parsed.seq
        res.write(`data: ${message}\n\n`)
        if (parsed.event?.type === 'turnFinished' || parsed.event?.type === 'error') {
          cleanup()
          res.end()
        }
      } catch {}
    }

    let counted = false
    let closed = false

    const releaseWatcher = () => {
      if (closed) return
      closed = true
      if (counted) {
        void this.store.removeWatcher(runId).catch(() => {})
      }
    }

    const cleanup = () => {
      try {
        subClient.unsubscribe(channel)
        subClient.removeListener('message', onMessage)
      } catch {}
      releaseWatcher()
    }

    req.on('close', cleanup)
    subClient.on('message', onMessage)
    await subClient.subscribe(channel)

    if (closed) {
      // The client left while we were subscribing. Unwind without ever
      // incrementing, so the count cannot drift upward.
      cleanup()
      res.end()
      return
    }
```
Replace it with:
```js
    // 1. Subscribe FIRST to avoid missing any live events
    const channel = `ai-assist:run:${runId}:channel`
    let lastSentSeq = sinceSeq
    const liveBuffer = []
    let subscribed = false
    let unsubscribe = null

    const onMessage = message => {
      if (!subscribed) {
        liveBuffer.push(message)
        return
      }
      try {
        const parsed = JSON.parse(message)
        if (parsed.seq <= lastSentSeq) return
        lastSentSeq = parsed.seq
        res.write(`data: ${message}\n\n`)
        if (parsed.event?.type === 'turnFinished' || parsed.event?.type === 'error') {
          cleanup()
          res.end()
        }
      } catch {}
    }

    let counted = false
    let closed = false

    const releaseWatcher = () => {
      if (closed) return
      closed = true
      if (counted) {
        void this.store.removeWatcher(runId).catch(() => {})
      }
    }

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      releaseWatcher()
    }

    req.on('close', cleanup)
    unsubscribe = await this.subscriber.subscribe(channel, onMessage)

    if (closed) {
      // The client left while we were subscribing. Unwind without ever
      // incrementing, so the count cannot drift upward. cleanup() already ran
      // once with no unsubscribe handle; run it again to release the channel.
      cleanup()
      res.end()
      return
    }
```

Then update the buffered replay (currently lines 155-157):
```js
    for (const msg of liveBuffer) {
      onMessage(channel, msg)
    }
```
to:
```js
    for (const msg of liveBuffer) {
      onMessage(msg)
    }
```

> **TRAP — ordering in `cleanup`.** `releaseWatcher` returns early once `closed` is true, but `unsubscribe` must still run on the second `cleanup()` call in the "closed while subscribing" branch. That is why `unsubscribe` runs before `releaseWatcher` and is not behind the `closed` guard.

- [x] **Step 6: Update the two controller tests that stubbed `RedisWrapper.client`**

In `modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs`:

1. Delete the import `import RedisWrapper from '../../../../../app/src/infrastructure/RedisWrapper.mjs'` only if nothing else in the file still uses `RedisWrapper` (check with `grep -n RedisWrapper`).
2. In the top-level `beforeEach`, create a fake subscriber and pass it to the controller:
```js
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
```
and declare `let fakeSubscriber` next to `let controller`.

3. Replace the test `'increments watcher count on subscribe and decrements on close'` with:
```js
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
```

4. Replace the test `'does not increment or decrement watcher count if request closes before subscribe resolves'` with:
```js
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
```

5. Add a live-delivery test:
```js
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
```

> **TRAP — the controller's `getRun` mock.** The top-level `mockStore.getRun` resolves `{ runId: 'run-1', projectId: 'p1', status: 'running' }`. Tests that pass `Project_id: 'p1'` get past the 403 check. If the stream test in step 5 hits `res.end` immediately, check that `status` is not terminal.

- [x] **Step 7: Run the controller and subscriber tests**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs modules/ai-assist/test/unit/src/AiAssistRunSubscriber.test.mjs 2>&1 | grep -E "Tests |FAIL|Error|×" | head -10
```
Expected: all pass.

- [x] **Step 8: Verify no other code still creates a per-stream Redis client**

```bash
grep -n "RedisWrapper.client" modules/ai-assist/app/src/*.mjs
```
Expected: only `AiAssistRunStore.mjs`, `AiAssistRunControl.mjs`, and `AiAssistRunSubscriber.mjs`. Each creates at most one or two long-lived clients per process.

---

### Task 2: SSE keep-alive and no proxy buffering

**Files:**
- Modify: `modules/ai-assist/app/src/ModuleSettings.mjs:13-24`
- Modify: `modules/ai-assist/app/src/AiAssistRunController.mjs` (`streamRun` header block and `cleanup`)
- Modify: `modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs`

**Interfaces:**
- Consumes: the `cleanup()` and `unsubscribe` structure from Task 1.
- Produces: `Settings.aiAssist.streamKeepAliveSeconds` (number; `0` disables keep-alives).

- [x] **Step 1: Write the failing tests**

Add these two tests to `AiAssistRunController.test.mjs` (inside the top-level `describe`):

```js
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
```

> **TRAP — fake timers.** Only fake `setInterval` and `clearInterval`. Faking `setTimeout` or `setImmediate` stalls the awaited Redis/store promises inside `streamRun`, and the test hangs.

- [x] **Step 2: Run to verify both fail**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs 2>&1 | grep -E "Tests |×" | head -6
```
Expected: 2 failed.

- [x] **Step 3: Add the setting**

In `modules/ai-assist/app/src/ModuleSettings.mjs`, inside the `Settings.aiAssist = { ... }` object, after the `streamIdleSeconds` line, add:
```js
    // SSE comment lines keep reverse proxies from closing an idle run stream
    // during long compiles, approvals and silent thinking. 0 disables them.
    streamKeepAliveSeconds: intFromEnv('AI_ASSIST_STREAM_KEEPALIVE_SECONDS', 15),
```

> **TRAP — `ModuleSettings` only fills `Settings.aiAssist` when it is `undefined`.** Tests and some deployments set `Settings.aiAssist` without this key. Always read it as `Settings.aiAssist?.streamKeepAliveSeconds ?? 15`.

- [x] **Step 4: Implement headers and keep-alive**

In `streamRun`, replace the header block (currently lines 80-83):
```js
    res.setHeader?.('Content-Type', 'text/event-stream')
    res.setHeader?.('Cache-Control', 'no-cache')
    res.setHeader?.('Connection', 'keep-alive')
    res.flushHeaders?.()
```
with:
```js
    res.setHeader?.('Content-Type', 'text/event-stream')
    res.setHeader?.('Cache-Control', 'no-cache, no-transform')
    res.setHeader?.('Connection', 'keep-alive')
    // nginx (including the one inside the server-ce image) buffers proxied
    // responses by default, which holds SSE frames back until the buffer fills.
    res.setHeader?.('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
```

Declare the timer next to `let unsubscribe = null`:
```js
    let keepAliveTimer = null
```

Change `cleanup` (from Task 1) to also stop the timer:
```js
    const cleanup = () => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer)
        keepAliveTimer = null
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      releaseWatcher()
    }
```

Right after `counted = true` and `await this.store.addWatcher(runId)` (before `// 2. Send existing catch-up events`), start the timer:
```js
    const keepAliveSeconds = Settings.aiAssist?.streamKeepAliveSeconds ?? 15
    if (keepAliveSeconds > 0) {
      keepAliveTimer = setInterval(() => {
        if (closed || res.writableEnded) return
        // Lines starting with ':' are SSE comments: EventSource ignores them,
        // proxies see traffic.
        res.write(': keepalive\n\n')
      }, keepAliveSeconds * 1000)
      keepAliveTimer.unref?.()
    }
```

`Settings` is already imported at the top of the controller (`import Settings from '@overleaf/settings'`). Confirm with `grep -n "^import Settings" modules/ai-assist/app/src/AiAssistRunController.mjs`.

- [x] **Step 5: Run the controller tests**

Same command as Step 2. Expected: all pass.

---

### Task 3: Read only the tail of the event list on catch-up

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunStore.mjs:183-189`
- Modify: `modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs`

**Interfaces:**
- Produces: `getEvents(runId, sinceSeq = 0)`, unchanged signature and return shape (`Array<{ seq, event }>` with `seq > sinceSeq`, ascending).

- [x] **Step 1: Write the failing test**

Look at how `AiAssistRunStore.test.mjs` builds its fake Redis client (`grep -n "new AiAssistRunStore" modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs`); it passes a client object to the constructor. Add:

```js
  it('reads only the tail of the event list when resuming from a sequence number', async function () {
    const all = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ seq: i + 1, event: { type: 'text', text: String(i + 1) } })
    )
    const rclient = {
      lrange: sinon.stub().callsFake(async (_key, start, stop) => {
        const end = stop === -1 ? all.length : stop + 1
        return all.slice(start, end)
      }),
    }
    const store = new AiAssistRunStore(rclient)

    const events = await store.getEvents('run-1', 30)

    const [, start, stop] = rclient.lrange.firstCall.args
    // since (30) minus the 16-entry safety slack
    expect(start).to.equal(14)
    expect(stop).to.equal(-1)
    expect(events.map(e => e.seq)).to.deep.equal([31, 32, 33, 34, 35, 36, 37, 38, 39, 40])
  })

  it('returns every event when resuming from zero', async function () {
    const all = [1, 2].map(seq => JSON.stringify({ seq, event: { type: 'text', text: String(seq) } }))
    const rclient = { lrange: sinon.stub().resolves(all) }
    const store = new AiAssistRunStore(rclient)

    const events = await store.getEvents('run-1', 0)

    expect(rclient.lrange.firstCall.args.slice(1)).to.deep.equal([0, -1])
    expect(events.map(e => e.seq)).to.deep.equal([1, 2])
  })
```

If the file does not import `sinon` or `AiAssistRunStore` under these names, adapt the imports to match the file's existing ones.

- [x] **Step 2: Run to verify the first test fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs 2>&1 | grep -E "Tests |×" | head -5
```
Expected: 1 failed ("expected 0 to equal 14").

- [x] **Step 3: Implement**

Replace:
```js
  async getEvents(runId, sinceSeq = 0) {
    const rclient = this.getClient()
    if (!rclient) return []
    const rawList = await rclient.lrange(this._eventsKey(runId), 0, -1)
    const parsed = rawList.map(item => JSON.parse(item))
    return parsed.filter(item => item.seq > sinceSeq)
  }
```
with:
```js
  async getEvents(runId, sinceSeq = 0) {
    const rclient = this.getClient()
    if (!rclient) return []
    // seq N normally sits at list index N-1, because appendEvent INCRs then
    // RPUSHes and the run loop serialises its writes. Writers outside that
    // chain (stale-run reconciliation, the no-control-channel stop fallback)
    // can interleave, so read a little early and keep the seq filter.
    const SLACK = 16
    const since = Math.max(0, Number(sinceSeq) || 0)
    const start = Math.max(0, since - SLACK)
    const rawList = await rclient.lrange(this._eventsKey(runId), start, -1)
    const parsed = rawList.map(item => JSON.parse(item))
    return parsed.filter(item => item.seq > since)
  }
```

- [x] **Step 4: Run the store tests**

Same command as Step 2. Expected: all pass.

---

### Task 4: Browser reconnects with `since` instead of giving up

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts:76-123` (`connectRunStream`)
- Modify: `modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts`

**Interfaces:**
- Produces: `connectRunStream({ runId, projectId, since?, onEvent, onDone, onError, maxReconnects?, reconnectDelayMs? }): () => void`. The new options are optional (defaults `5` and `1000`). Callers in `hooks/use-agent-run.ts` (two call sites) need no changes.

Behaviour contract:
- Each SSE message carries `{ seq, event }`. Track the highest `seq` seen.
- On `onerror`, close the current `EventSource`. If the stream is not finished and fewer than `maxReconnects` consecutive failed attempts have happened, open a new `EventSource` after `reconnectDelayMs * attempt` ms with `?since=<highest seq>`.
- Any successfully parsed message resets the attempt counter.
- Only after `maxReconnects` consecutive failures: clear the stored active run id, then call `onError`.
- The terminal paths (`turnFinished`/`error` event, parse failure) behave exactly as today.
- The returned cleanup function stops everything, including a pending reconnect timer.

- [x] **Step 1: Write the failing tests**

Add to `background-run-client.test.ts` (inside the existing `describe('background-run-client', ...)`). The file's `afterEach` already restores `globalThis.EventSource`.

```ts
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
```

If `customLocalStorage` is not already imported in this test file, add:
```ts
import customLocalStorage from '@/infrastructure/local-storage'
```

> **TRAP — existing tests in this file.** One existing test (`'closes eventSource and clears stored active run on stream message processing error'`) installs a `FakeEventSource` whose `onmessage` is defined with `Object.defineProperty(..., { set })` and **no getter**. The new implementation must only *assign* `es.onmessage = ...`, never read it back. Another test calls `connectRunStream` with `globalThis.EventSource = sinon.spy()`; assigning `onopen`/`onerror` on a spy-constructed object is fine.

- [x] **Step 2: Run to verify the new tests fail**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts 2>&1 | grep -E "passing|failing"
```
Expected: 4 failing (at least the three reconnect tests; the cleanup test may pass by accident).

- [x] **Step 3: Implement**

Replace the whole `connectRunStream` function (from `export function connectRunStream({` through its closing `}` before `export async function stopBackgroundRun`) with:

```ts
const DEFAULT_MAX_RECONNECTS = 5
const DEFAULT_RECONNECT_DELAY_MS = 1000

export function connectRunStream({
  runId,
  projectId,
  since = 0,
  onEvent,
  onDone,
  onError,
  maxReconnects = DEFAULT_MAX_RECONNECTS,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
}: {
  runId: string
  projectId: string
  since?: number
  onEvent: (event: AgentEvent) => void
  onDone: () => void
  onError: (err: any) => void
  maxReconnects?: number
  reconnectDelayMs?: number
}): () => void {
  // The run lives on the server and keeps going when this connection drops
  // (proxy idle timeout, network blip, laptop sleep). Resume from the last
  // event seen instead of abandoning a run that is still producing output.
  let lastSeq = since
  let failures = 0
  let finished = false
  let current: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const finish = () => {
    finished = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    current?.close()
  }

  const open = () => {
    const eventSource = new EventSource(
      `/ai-assist/projects/${projectId}/runs/${runId}/stream?since=${lastSeq}`
    )
    current = eventSource

    eventSource.onmessage = msg => {
      try {
        const data = JSON.parse(msg.data)
        failures = 0
        if (typeof data.seq === 'number' && data.seq > lastSeq) {
          lastSeq = data.seq
        }
        if (data.event) {
          onEvent(data.event)
          if (
            data.event.type === 'turnFinished' ||
            data.event.type === 'error'
          ) {
            setStoredActiveRunId(projectId, null)
            finish()
            onDone()
          }
        }
      } catch (err) {
        setStoredActiveRunId(projectId, null)
        finish()
        onError(err)
      }
    }

    eventSource.onerror = err => {
      eventSource.close()
      if (finished) return
      if (failures >= maxReconnects) {
        setStoredActiveRunId(projectId, null)
        finish()
        onError(err)
        return
      }
      failures += 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (!finished) open()
      }, reconnectDelayMs * failures)
    }
  }

  open()

  return () => {
    finish()
  }
}
```

> **TRAP — native `EventSource` auto-reconnect.** A browser `EventSource` retries by itself after some errors, but always with the original URL (`since=0`), which would replay the whole run into a transcript that already has it. Closing it in `onerror` and opening a new one with the current `lastSeq` is deliberate. Do not remove the `eventSource.close()` call.

> **TRAP — `failures` counts consecutive failures.** It resets on every parsed message, not on `onopen`. A server that accepts the connection and immediately closes it (for example because the run is already terminal and has no events after `lastSeq`) must still hit the limit instead of looping forever.

- [x] **Step 4: Run the client tests**

Same command as Step 2. Expected: all passing, 0 failing.

- [x] **Step 5: Run the hook tests that use `connectRunStream`**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' --reporter dot modules/ai-assist/test/frontend 2>&1 | grep -E "passing|failing"
```
Expected: the same failing count as the baseline (0 on 2026-09-17).

---

### Task 5: Coalesce thinking chunks like text chunks

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs:229-272` (the buffered writer helpers) and `:334-340` (the stream loop)
- Modify: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Interfaces:**
- Produces: the same event types as before (`{ type: 'thinking', text }`, `{ type: 'text', text }`). Consecutive chunks of the same type may now arrive merged into one event. The frontend reducer (`agent/agent-state.ts:202-208`) appends `text` for both types, so merged events render identically.

- [x] **Step 1: Write the failing test**

Add to `AiAssistRunManager.test.mjs`, next to `'coalesces streamed text chunks into batched writes'`:

```js
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
```

- [x] **Step 2: Run to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs 2>&1 | grep -E "Tests |×" | head -5
```
Expected: 1 failed ("expected 30 to be below 30").

- [x] **Step 3: Implement**

Replace the writer helpers. Current code:
```js
    let pendingText = ''
    let flushTimer = null
    let flushChain = Promise.resolve()
    const FLUSH_MS = 50
    const FLUSH_CHARS = 100

    const write = event => {
      flushChain = flushChain.then(() => this.store.appendEvent(runId, event))
      return flushChain
    }

    const flushText = () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!pendingText) return Promise.resolve()
      const chunk = pendingText
      pendingText = ''
      return write({ type: 'text', text: chunk })
    }

    const armTimer = () => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        void flushText().catch(() => {})
      }, FLUSH_MS)
      flushTimer.unref?.()
    }

    const emitText = async text => {
      pendingText += text
      if (pendingText.length >= FLUSH_CHARS) {
        await flushText()
        return
      }
      armTimer()
    }
```
New code:
```js
    // Streamed text and thinking are buffered and written in batches: every
    // appendEvent is INCR + RPUSH + PUBLISH, and the provider stream is not
    // read again until the write resolves. Only one kind is buffered at a
    // time, so a switch between thinking and text flushes first and order
    // is preserved.
    let pendingType = null
    let pendingText = ''
    let flushTimer = null
    let flushChain = Promise.resolve()
    const FLUSH_MS = 50
    const FLUSH_CHARS = 100

    const write = event => {
      flushChain = flushChain.then(() => this.store.appendEvent(runId, event))
      return flushChain
    }

    const flushText = () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!pendingText) return Promise.resolve()
      const chunk = pendingText
      const type = pendingType
      pendingText = ''
      pendingType = null
      return write({ type, text: chunk })
    }

    const armTimer = () => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        void flushText().catch(() => {})
      }, FLUSH_MS)
      flushTimer.unref?.()
    }

    const emitChunk = async (type, text) => {
      if (!text) return
      if (pendingType && pendingType !== type) {
        await flushText()
      }
      pendingType = type
      pendingText += text
      if (pendingText.length >= FLUSH_CHARS) {
        await flushText()
        return
      }
      armTimer()
    }
```

In the stream loop, replace:
```js
          if (chunk.type === 'thinking') {
            await emitEvent({ type: 'thinking', text: chunk.text })
          } else if (chunk.type === 'text') {
            text += chunk.text
            await emitText(chunk.text)
          } else if (chunk.type === 'tool_call') {
```
with:
```js
          if (chunk.type === 'thinking') {
            await emitChunk('thinking', chunk.text)
          } else if (chunk.type === 'text') {
            text += chunk.text
            await emitChunk('text', chunk.text)
          } else if (chunk.type === 'tool_call') {
```

Then confirm nothing else references the old name:
```bash
grep -n "emitText" modules/ai-assist/app/src/AiAssistRunManager.mjs
```
Expected: no output.

> **TRAP — `emitEvent` already flushes.** `emitEvent` calls `flushText()` before writing a non-streamed event (tool calls, errors, `turnFinished`). With `pendingType` carried inside `flushText`, that still writes the right type. Do not add a type argument to `flushText`.

- [x] **Step 4: Run the manager tests**

Same command as Step 2. Expected: all pass, including `'runs an agent turn yielding text and finishing cleanly'` (its thinking and text arrive as separate events because the type switch flushes) and `'preserves ordering and does not merge text across non-text boundaries'`.

---

### Task 6: Final verification and redeploy

- [x] **Step 1: Full backend module suite**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
```
Expected: 0 failed. The count equals baseline plus the new tests.

- [x] **Step 2: Full frontend module suite**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' --reporter dot modules/ai-assist/test/frontend 2>&1 | grep -E "passing|failing"
```
Expected: 0 failing.

- [x] **Step 3: Type check the touched frontend file**

```bash
timeout 500 ../../node_modules/.bin/tsc --noEmit -p . 2>&1 | grep "background-run-client"
```
Expected: no output. Errors elsewhere in the module that already existed before this plan are not yours.

- [x] **Step 4: Redeploy the dev server and smoke-test**

The ai-assist dev stack bind-mounts this worktree and runs `node --watch`, so restarting the web container is enough. Docker needs the sandbox disabled.
```bash
docker restart ai-assist-web-1
```
Wait until `curl -s -o /dev/null -w '%{http_code}' http://localhost:81/login` returns `200`. Then, logged in as `dangdoan2206@gmail.com` / `dang22062003`, open a project on `http://<host>:81`, send an AI chat message that makes the model compile, and confirm in DevTools → Network → the `stream?since=` request that `: keepalive` lines appear during the compile. Report to the user: URL `http://<host>:81`, web debug port `9241`, and what you observed.

## Out of scope

- **Server-side resumable reconnect for the mount-time path.** `use-agent-run.ts` reconnects on mount with `since: 0` after stripping the unfinished assistant turn. That replay is correct and bounded by Task 3. Leave it.
- **Removing the legacy `/ai-assist/runs/:runId/*` routes.** Other code may still call them (`stopBackgroundRun` and `approveBackgroundEdit` use them). That is a separate cleanup.
- **Changing the production nginx config.** The `X-Accel-Buffering` header fixes buffering per response without touching `server-ce/nginx/overleaf.conf`.
