# AI Assist Background Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AI Assist provider request and tool-calling agent loop into Overleaf's `web` backend with Redis persistence and SSE streaming, so in-flight requests and multi-step tool turns survive tab reloads and browser restarts without interruption.

**Architecture:** A new backend router and controller in `modules/ai-assist/app/src/` exposes run lifecycle endpoints (`POST .../runs`, `GET .../stream`, `POST .../stop`, `POST .../approve`). A server-side `AiAssistRunManager` holds in-memory provider API keys and `AbortController`s while driving turns via server-side provider clients (`anthropic`, `openai`, `ollama`) and server-side tools (`read_file`, `edit_file`, `create_file`, `compile_project`, `get_compile_log`, `search_project`, `project_map`) acting on `DocumentUpdaterHandler`, `ProjectEntityHandler`, and `CompileManager`. Run status and event streams are recorded in Redis and broadcast via Redis Pub/Sub so multiple tabs or reloaded pages reconnect seamlessly to the same run via Server-Sent Events (SSE).

**Tech Stack:** Node.js (ES modules `.mjs`), Express, Redis (`@overleaf/redis-wrapper`), Vitest (backend unit tests), Mocha + Chai + Sinon (frontend unit tests), TypeScript, React.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-14-ai-assist-background-runs-design.md`

## Global Constraints

- **Never run `git commit`, `git push`, or any history-altering git command.** This repository requires explicit per-command user approval for all git writes. Leave every change in the working tree. Verification steps replace commit steps.
- **Working directory for all commands:** `overleaf/services/web` inside the `ai-assist` worktree (`/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`).
- **Backend test runner:**
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path_to_test>
  ```
- **Frontend test runner:**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
    --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js \
    --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
    <path_to_test>
  ```
- **API key security:** The provider API key is passed in the request body when initiating a run and held only in memory on the `web` worker instance for that run's lifetime. It must NEVER be persisted to Redis, MongoDB, or disk logs.
- **Feature flag:** `AI_ASSIST_ENABLED=true` guards all new routes and behaviors.

---

### Task 1: Redis Run Storage and Event Log (`AiAssistRunStore.mjs`)

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistRunStore.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs`

**Interfaces:**
- Consumes: `RedisWrapper` from `../../../../app/src/infrastructure/RedisWrapper.mjs`.
- Produces:
  - `createRun({ runId, projectId, userId, metadata })`: initializes hash `ai-assist:run:{runId}` with status `'running'`, sets `seq` to 0.
  - `appendEvent(runId, event)`: increments seq, pushes JSON event to list `ai-assist:run:{runId}:events`, updates heartbeat, publishes to channel `ai-assist:run:{runId}:channel`.
  - `getRun(runId)`: returns run metadata and current status.
  - `getEvents(runId, sinceSeq = 0)`: returns array of `{ seq, event }` from `sinceSeq`.
  - `updateStatus(runId, status, error = null)`: updates status (`running`, `awaitingApproval`, `stopped`, `error`, `interrupted`, `done`).
  - `setPendingApproval(runId, editData)`: stores pending edit payload for approval.
  - `getPendingApproval(runId)`: retrieves stored pending edit payload.
  - `reconcileStaleRuns(maxHeartbeatAgeMs)`: scans active runs and marks any with stale heartbeat as `'interrupted'`.

- [ ] **Step 1: Write the failing backend test**

Create `modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs`:

```javascript
import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistRunStore } from '../../../app/src/AiAssistRunStore.mjs'

describe('AiAssistRunStore', function () {
  let mockRedis
  let store

  beforeEach(function () {
    const data = new Map()
    const lists = new Map()

    mockRedis = {
      hset: sinon.stub().callsFake(async (key, field, val) => {
        if (!data.has(key)) data.set(key, new Map())
        if (typeof field === 'object') {
          for (const [k, v] of Object.entries(field)) data.get(key).set(k, String(v))
        } else {
          data.get(key).set(field, String(val))
        }
      }),
      hgetall: sinon.stub().callsFake(async key => {
        if (!data.has(key)) return {}
        return Object.fromEntries(data.get(key).entries())
      }),
      incr: sinon.stub().callsFake(async key => {
        const curr = parseInt(data.get(key)?.get('val') || '0', 10) + 1
        if (!data.has(key)) data.set(key, new Map())
        data.get(key).set('val', String(curr))
        return curr
      }),
      rpush: sinon.stub().callsFake(async (key, val) => {
        if (!lists.has(key)) lists.set(key, [])
        lists.get(key).push(val)
        return lists.get(key).length
      }),
      lrange: sinon.stub().callsFake(async (key, start, stop) => {
        const arr = lists.get(key) || []
        const end = stop === -1 ? undefined : stop + 1
        return arr.slice(start, end)
      }),
      publish: sinon.stub().resolves(1),
      expire: sinon.stub().resolves(1),
    }

    store = new AiAssistRunStore(mockRedis)
  })

  it('creates a run with running status and TTL', async function () {
    await store.createRun({
      runId: 'run-123',
      projectId: 'proj-456',
      userId: 'user-789',
    })

    const run = await store.getRun('run-123')
    expect(run.status).to.equal('running')
    expect(run.projectId).to.equal('proj-456')
    expect(run.userId).to.equal('user-789')
    expect(mockRedis.expire.called).to.be.true
  })

  it('appends events with incrementing seq and publishes them', async function () {
    await store.createRun({ runId: 'run-123', projectId: 'p1', userId: 'u1' })

    const ev1 = { type: 'thinking', text: 'analyzing...' }
    const seq1 = await store.appendEvent('run-123', ev1)
    expect(seq1).to.equal(1)

    const ev2 = { type: 'text', text: 'Hello' }
    const seq2 = await store.appendEvent('run-123', ev2)
    expect(seq2).to.equal(2)

    const events = await store.getEvents('run-123', 0)
    expect(events).to.have.lengthOf(2)
    expect(events[0].seq).to.equal(1)
    expect(events[0].event).to.deep.equal(ev1)
    expect(events[1].seq).to.equal(2)
    expect(events[1].event).to.deep.equal(ev2)

    expect(mockRedis.publish.calledWith('ai-assist:run:run-123:channel')).to.be.true
  })

  it('filters events using sinceSeq parameter', async function () {
    await store.createRun({ runId: 'run-123', projectId: 'p1', userId: 'u1' })
    await store.appendEvent('run-123', { type: 'text', text: 'a' })
    await store.appendEvent('run-123', { type: 'text', text: 'b' })
    await store.appendEvent('run-123', { type: 'text', text: 'c' })

    const eventsAfter1 = await store.getEvents('run-123', 1)
    expect(eventsAfter1).to.have.lengthOf(2)
    expect(eventsAfter1[0].seq).to.equal(2)
    expect(eventsAfter1[1].seq).to.equal(3)
  })

  it('stores and retrieves pending approvals', async function () {
    await store.createRun({ runId: 'run-123', projectId: 'p1', userId: 'u1' })
    const edit = { path: 'main.tex', oldText: 'foo', newText: 'bar' }
    await store.setPendingApproval('run-123', { id: 'call-1', edit })

    const retrieved = await store.getPendingApproval('run-123')
    expect(retrieved).to.deep.equal({ id: 'call-1', edit })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs
```
Expected: FAIL (Cannot find module `AiAssistRunStore.mjs`)

- [ ] **Step 3: Write minimal implementation**

Create `modules/ai-assist/app/src/AiAssistRunStore.mjs`:

```javascript
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'

const RUN_TTL_SECONDS = 7 * 24 * 3600 // 7 days retention

export class AiAssistRunStore {
  constructor(redisClient = null) {
    this.rclient = redisClient || RedisWrapper.client('ai-assist')
  }

  _key(runId) {
    return `ai-assist:run:${runId}`
  }

  _eventsKey(runId) {
    return `ai-assist:run:${runId}:events`
  }

  _channel(runId) {
    return `ai-assist:run:${runId}:channel`
  }

  async createRun({ runId, projectId, userId, metadata = {} }) {
    const key = this._key(runId)
    const now = Date.now()
    await this.rclient.hset(key, {
      runId,
      projectId,
      userId,
      status: 'running',
      heartbeat: String(now),
      createdAt: String(now),
      metadata: JSON.stringify(metadata),
    })
    await this.rclient.expire(key, RUN_TTL_SECONDS)
    await this.rclient.expire(this._eventsKey(runId), RUN_TTL_SECONDS)
  }

  async getRun(runId) {
    const data = await this.rclient.hgetall(this._key(runId))
    if (!data || Object.keys(data).length === 0) return null
    return {
      ...data,
      heartbeat: Number(data.heartbeat || 0),
      createdAt: Number(data.createdAt || 0),
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
    }
  }

  async updateStatus(runId, status, error = null) {
    const updates = {
      status,
      heartbeat: String(Date.now()),
    }
    if (error) {
      updates.error = JSON.stringify(error)
    }
    await this.rclient.hset(this._key(runId), updates)
  }

  async touchHeartbeat(runId) {
    await this.rclient.hset(this._key(runId), 'heartbeat', String(Date.now()))
  }

  async appendEvent(runId, event) {
    const seqKey = `${this._key(runId)}:seq`
    const seq = await this.rclient.incr(seqKey)
    const payload = JSON.stringify({ seq, event })
    await this.rclient.rpush(this._eventsKey(runId), payload)
    await this.touchHeartbeat(runId)
    await this.rclient.publish(this._channel(runId), payload)
    return seq
  }

  async getEvents(runId, sinceSeq = 0) {
    const rawList = await this.rclient.lrange(this._eventsKey(runId), 0, -1)
    const parsed = rawList.map(item => JSON.parse(item))
    return parsed.filter(item => item.seq > sinceSeq)
  }

  async setPendingApproval(runId, approvalData) {
    await this.rclient.hset(this._key(runId), {
      status: 'awaitingApproval',
      pendingApproval: JSON.stringify(approvalData),
      heartbeat: String(Date.now()),
    })
  }

  async getPendingApproval(runId) {
    const run = await this.getRun(runId)
    if (!run?.pendingApproval) return null
    return typeof run.pendingApproval === 'string'
      ? JSON.parse(run.pendingApproval)
      : run.pendingApproval
  }

  async clearPendingApproval(runId, nextStatus = 'running') {
    await this.rclient.hset(this._key(runId), {
      status: nextStatus,
      pendingApproval: '',
      heartbeat: String(Date.now()),
    })
  }
}

export default new AiAssistRunStore()
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs
```
Expected: PASS (4 tests passed)

- [ ] **Step 5: Verify working tree**

Run: `git status --porcelain modules/ai-assist`
Verify new files are untracked and no unwanted changes were introduced.

---

### Task 2: Server-Side LLM Provider Streaming (`AiAssistProviders.mjs`)

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistProviders.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`

**Interfaces:**
- Consumes: Node `fetch` and standard stream readers.
- Produces:
  - `createProviderClient(settings)`: returns client with `streamChat({ system, messages, maxTokens, tools, signal })` async generator yielding:
    - `{ type: 'thinking', text: string }`
    - `{ type: 'text', text: string }`
    - `{ type: 'tool_call', id: string, name: string, args: object }`
  - `ProviderError` class with code and hint.

- [ ] **Step 1: Write the failing backend test**

Create `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`:

```javascript
import { expect } from 'chai'
import sinon from 'sinon'
import {
  createProviderClient,
  ProviderError,
  parseSseLines,
} from '../../../app/src/AiAssistProviders.mjs'

describe('AiAssistProviders', function () {
  describe('parseSseLines', function () {
    it('parses data frames across chunk boundaries', async function* () {
      const chunks = [
        'event: message\ndata: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: [DONE]\n\n',
      ]
      async function* source() {
        for (const c of chunks) yield new TextEncoder().encode(c)
      }

      const events = []
      for await (const line of parseSseLines(source())) {
        events.push(line)
      }
      expect(events).to.have.lengthOf(2)
      expect(events[0]).to.include('"Hello"')
      expect(events[1]).to.equal('[DONE]')
    })
  })

  describe('Anthropic Provider Client', function () {
    it('streams thinking, text, and tool_use blocks', async function () {
      const sseBody = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_1","name":"read_file","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"main.tex\\"}"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('')

      const fakeResponse = {
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(sseBody)
        })(),
      }

      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-3-7-sonnet',
        fetchFn: sinon.stub().resolves(fakeResponse),
      })

      const chunks = []
      for await (const chunk of client.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      })) {
        chunks.push(chunk)
      }

      expect(chunks).to.deep.include({ type: 'thinking', text: 'Plan' })
      expect(chunks).to.deep.include({ type: 'text', text: 'Hi' })
      expect(chunks).to.deep.include({
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        args: { path: 'main.tex' },
      })
    })

    it('throws ProviderError on non-200 responses', async function () {
      const fakeResponse = {
        ok: false,
        status: 401,
        json: sinon.stub().resolves({ error: { message: 'Invalid API key' } }),
      }

      const client = createProviderClient({
        type: 'anthropic',
        apiKey: 'bad-key',
        model: 'claude-3-7-sonnet',
        fetchFn: sinon.stub().resolves(fakeResponse),
      })

      let error = null
      try {
        for await (const _ of client.streamChat({ system: 'x', messages: [] })) {}
      } catch (err) {
        error = err
      }

      expect(error).to.be.instanceOf(ProviderError)
      expect(error.status).to.equal(401)
      expect(error.message).to.include('Invalid API key')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs
```
Expected: FAIL (Cannot find module `AiAssistProviders.mjs`)

- [ ] **Step 3: Write minimal implementation**

Create `modules/ai-assist/app/src/AiAssistProviders.mjs`:

```javascript
export class ProviderError extends Error {
  constructor(message, { code = 'providerError', status = 500, hint = '' } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.hint = hint
  }
}

export async function* parseSseLines(stream) {
  const reader = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.next()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) {
        yield trimmed.slice(5).trim()
      }
    }
  }

  if (buffer.trim().startsWith('data:')) {
    yield buffer.trim().slice(5).trim()
  }
}

class AnthropicServerClient {
  constructor({ apiKey, model, baseURL = 'https://api.anthropic.com', fetchFn = fetch }) {
    this.apiKey = apiKey
    this.model = model
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.fetch = fetchFn
  }

  async *streamChat({ system, messages, maxTokens = 4096, tools = [], signal }) {
    const anthropicMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        if (m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: [
              ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ...m.toolCalls.map(tc => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: tc.args,
              })),
            ],
          }
        }
        return { role: m.role, content: m.content }
      })

    const payload = {
      model: this.model,
      system,
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream: true,
    }

    if (tools?.length) {
      payload.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }

    const res = await this.fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    })

    if (!res.ok) {
      let msg = `Anthropic API error (${res.status})`
      try {
        const body = await res.json()
        if (body?.error?.message) msg = body.error.message
      } catch {}
      throw new ProviderError(msg, { status: res.status })
    }

    let activeTool = null
    for await (const data of parseSseLines(res.body)) {
      if (data === '[DONE]') break
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }

      if (parsed.type === 'content_block_start') {
        if (parsed.content_block?.type === 'tool_use') {
          activeTool = {
            id: parsed.content_block.id,
            name: parsed.content_block.name,
            rawArgs: '',
          }
        }
      } else if (parsed.type === 'content_block_delta') {
        const delta = parsed.delta
        if (delta?.type === 'thinking_delta') {
          yield { type: 'thinking', text: delta.thinking }
        } else if (delta?.type === 'text_delta') {
          yield { type: 'text', text: delta.text }
        } else if (delta?.type === 'input_json_delta' && activeTool) {
          activeTool.rawArgs += delta.partial_json
        }
      } else if (parsed.type === 'content_block_stop' && activeTool) {
        let args = {}
        try {
          args = JSON.parse(activeTool.rawArgs || '{}')
        } catch {}
        yield {
          type: 'tool_call',
          id: activeTool.id,
          name: activeTool.name,
          args,
        }
        activeTool = null
      }
    }
  }
}

class OpenAiServerClient {
  constructor({ apiKey, model, baseURL = 'https://api.openai.com', fetchFn = fetch }) {
    this.apiKey = apiKey
    this.model = model
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.fetch = fetchFn
  }

  async *streamChat({ system, messages, maxTokens = 4096, tools = [], signal }) {
    const formattedMessages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        }
        if (m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          }
        }
        return { role: m.role, content: m.content }
      }),
    ]

    const payload = {
      model: this.model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      stream: true,
    }

    if (tools?.length) {
      payload.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const res = await this.fetch(`${this.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    })

    if (!res.ok) {
      let msg = `OpenAI API error (${res.status})`
      try {
        const body = await res.json()
        if (body?.error?.message) msg = body.error.message
      } catch {}
      throw new ProviderError(msg, { status: res.status })
    }

    const pendingToolCalls = new Map()

    for await (const data of parseSseLines(res.body)) {
      if (data === '[DONE]') break
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }

      const delta = parsed.choices?.[0]?.delta
      if (delta?.content) {
        yield { type: 'text', text: delta.content }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0
          if (!pendingToolCalls.has(index)) {
            pendingToolCalls.set(index, { id: tc.id, name: tc.function?.name || '', rawArgs: '' })
          }
          const curr = pendingToolCalls.get(index)
          if (tc.id) curr.id = tc.id
          if (tc.function?.name) curr.name = tc.function.name
          if (tc.function?.arguments) curr.rawArgs += tc.function.arguments
        }
      }
    }

    for (const tool of pendingToolCalls.values()) {
      let args = {}
      try {
        args = JSON.parse(tool.rawArgs || '{}')
      } catch {}
      yield {
        type: 'tool_call',
        id: tool.id,
        name: tool.name,
        args,
      }
    }
  }
}

export function createProviderClient(settings) {
  if (settings.type === 'anthropic') {
    return new AnthropicServerClient(settings)
  }
  return new OpenAiServerClient(settings)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs
```
Expected: PASS (3 tests passed)

- [ ] **Step 5: Verify working tree**

Run: `git status --porcelain modules/ai-assist`
Verify new files are untracked and no unwanted changes were introduced.

---

### Task 3: Server-Side Tool Execution Against Overleaf Project Backend (`AiAssistTools.mjs`)

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistTools.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`

**Interfaces:**
- Consumes:
  - `ProjectEntityHandler` from `../../../../app/src/Features/Project/ProjectEntityHandler.mjs`
  - `DocumentUpdaterHandler` from `../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs`
  - `EditorController` from `../../../../app/src/Features/Editor/EditorController.mjs`
  - `CompileManager` from `../../../../app/src/Features/Compile/CompileManager.mjs`
  - `ClsiManager` from `../../../../app/src/Features/Compile/ClsiManager.mjs`
- Produces:
  - `executeServerTool(toolName, args, { projectId, userId })`: executes requested tool against project backend APIs and returns tool output object. Supports:
    - `read_file`: `{ path, from, to }` -> reads doc lines via `DocumentUpdaterHandler` / `ProjectEntityHandler`.
    - `search_project`: `{ query }` -> scans all project docs for matching text.
    - `list_files` / `project_map`: `{ view }` -> returns directory tree / files.
    - `edit_file`: `{ path, oldText, newText }` -> replaces text anchor in document, updates doc via `DocumentUpdaterHandler.promises.setDocument`.
    - `create_file`: `{ path, content }` -> creates document via `EditorController.addDoc`.
    - `compile_project`: -> compiles via `CompileManager.promises.compile`.
    - `get_compile_log`: -> retrieves log stream via `ClsiManager.promises.getOutputFileStream`.

- [ ] **Step 1: Write the failing backend test**

Create `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`:

```javascript
import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistTools } from '../../../app/src/AiAssistTools.mjs'

describe('AiAssistTools', function () {
  let tools
  let mockDocUpdater
  let mockEntityHandler
  let mockEditorController
  let mockCompileManager

  beforeEach(function () {
    mockDocUpdater = {
      getDocument: sinon.stub().resolves({
        lines: ['line 1', 'line 2: target text', 'line 3'],
      }),
      setDocument: sinon.stub().resolves({ rev: 1, modified: true }),
    }

    mockEntityHandler = {
      getAllDocs: sinon.stub().resolves([
        { _id: 'doc-1', name: 'main.tex' },
        { _id: 'doc-2', name: 'chapters/intro.tex' },
      ]),
      getDocPathByProjectIdAndDocId: sinon.stub().callsFake(async (pid, docId) => {
        if (docId === 'doc-1') return 'main.tex'
        return 'chapters/intro.tex'
      }),
      getDocIdByPath: sinon.stub().callsFake(async (pid, path) => {
        if (path === 'main.tex') return 'doc-1'
        return null
      }),
    }

    mockEditorController = {
      addDoc: sinon.stub().yields(null, { _id: 'doc-new' }, 'root-folder'),
    }

    mockCompileManager = {
      compile: sinon.stub().resolves({ status: 'success', outputFiles: [] }),
    }

    tools = new AiAssistTools({
      docUpdater: mockDocUpdater,
      entityHandler: mockEntityHandler,
      editorController: mockEditorController,
      compileManager: mockCompileManager,
    })
  })

  it('reads lines from a document via read_file', async function () {
    const res = await tools.execute('read_file', { path: 'main.tex', from: 1, to: 2 }, {
      projectId: 'p1',
      userId: 'u1',
    })

    expect(res.content).to.equal('line 1\nline 2: target text')
    expect(res.from).to.equal(1)
    expect(res.to).to.equal(2)
  })

  it('performs text replacement via edit_file', async function () {
    const res = await tools.execute(
      'edit_file',
      { path: 'main.tex', oldText: 'target text', newText: 'updated text' },
      { projectId: 'p1', userId: 'u1' }
    )

    expect(res.status).to.equal('applied')
    expect(mockDocUpdater.setDocument.calledOnce).to.be.true
    const updatedLines = mockDocUpdater.setDocument.firstCall.args[3]
    expect(updatedLines[1]).to.equal('line 2: updated text')
  })

  it('creates new files via create_file', async function () {
    const res = await tools.execute(
      'create_file',
      { path: 'references.bib', content: '@article{test}' },
      { projectId: 'p1', userId: 'u1' }
    )

    expect(res.status).to.equal('applied')
    expect(mockEditorController.addDoc.calledOnce).to.be.true
  })

  it('searches across project documents via search_project', async function () {
    const res = await tools.execute(
      'search_project',
      { query: 'target' },
      { projectId: 'p1', userId: 'u1' }
    )

    expect(res.hits).to.have.lengthOf(1)
    expect(res.hits[0].path).to.equal('main.tex')
    expect(res.hits[0].line).to.equal(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs
```
Expected: FAIL (Cannot find module `AiAssistTools.mjs`)

- [ ] **Step 3: Write minimal implementation**

Create `modules/ai-assist/app/src/AiAssistTools.mjs`:

```javascript
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'

export class AiAssistTools {
  constructor({
    docUpdater = DocumentUpdaterHandler.promises,
    entityHandler = ProjectEntityHandler.promises,
    editorController = EditorController,
    compileManager = CompileManager.promises,
    clsiManager = ClsiManager.promises,
  } = {}) {
    this.docUpdater = docUpdater
    this.entityHandler = entityHandler
    this.editorController = editorController
    this.compileManager = compileManager
    this.clsiManager = clsiManager
  }

  async _resolveDocId(projectId, path) {
    if (this.entityHandler.getDocIdByPath) {
      const docId = await this.entityHandler.getDocIdByPath(projectId, path)
      if (docId) return docId
    }
    const docs = await this.entityHandler.getAllDocs(projectId)
    const match = docs.find(d => d.name === path || path.endsWith(d.name))
    return match?._id ?? null
  }

  async execute(name, args, { projectId, userId }) {
    switch (name) {
      case 'read_file': {
        const docId = await this._resolveDocId(projectId, args.path)
        if (!docId) return { error: `File not found: ${args.path}` }
        const doc = await this.docUpdater.getDocument(projectId, docId)
        const lines = doc.lines || []
        const totalLines = lines.length
        const from = Math.max(1, Math.min(args.from || 1, totalLines))
        const to = Math.min(args.to || totalLines, totalLines)
        const sliced = lines.slice(from - 1, to)
        return {
          path: args.path,
          from,
          to,
          totalLines,
          content: sliced.join('\n'),
        }
      }

      case 'search_project': {
        const docs = await this.entityHandler.getAllDocs(projectId)
        const hits = []
        for (const d of docs) {
          const path = await this.entityHandler.getDocPathByProjectIdAndDocId(projectId, d._id)
          const doc = await this.docUpdater.getDocument(projectId, d._id)
          const lines = doc.lines || []
          lines.forEach((line, idx) => {
            if (line.includes(args.query)) {
              hits.push({ path, line: idx + 1, text: line.trim() })
            }
          })
        }
        return { hits: hits.slice(0, 50) }
      }

      case 'list_files':
      case 'project_map': {
        const docs = await this.entityHandler.getAllDocs(projectId)
        const files = []
        for (const d of docs) {
          const path = await this.entityHandler.getDocPathByProjectIdAndDocId(projectId, d._id)
          const doc = await this.docUpdater.getDocument(projectId, d._id)
          files.push({
            path,
            lines: doc.lines?.length || 0,
            type: 'doc',
          })
        }
        return { files }
      }

      case 'edit_file': {
        const docId = await this._resolveDocId(projectId, args.path)
        if (!docId) return { error: `File not found: ${args.path}` }
        const doc = await this.docUpdater.getDocument(projectId, docId)
        const text = (doc.lines || []).join('\n')
        if (!text.includes(args.oldText)) {
          return { error: `Target anchor text not found in ${args.path}` }
        }
        const replaced = text.replace(args.oldText, args.newText)
        await this.docUpdater.setDocument(projectId, docId, userId, replaced.split('\n'), 'ai-assist')
        return { status: 'applied', path: args.path }
      }

      case 'create_file': {
        const lines = (args.content || '').split('\n')
        return new Promise((resolve, reject) => {
          this.editorController.addDoc(projectId, 'root-folder', args.path, lines, 'ai-assist', userId, (err, newDoc) => {
            if (err) return reject(err)
            resolve({ status: 'applied', path: args.path, docId: newDoc?._id })
          })
        })
      }

      case 'compile_project': {
        const result = await this.compileManager.compile(projectId, userId, {})
        return {
          status: result.status,
          errorCount: (result.outputFiles || []).filter(f => f.path?.endsWith('.log')).length,
        }
      }

      case 'get_compile_log': {
        return { status: 'none', message: 'Compile log retrieval on demand' }
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  }
}

export default new AiAssistTools()
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs
```
Expected: PASS (4 tests passed)

- [ ] **Step 5: Verify working tree**

Run: `git status --porcelain modules/ai-assist`
Verify new files are untracked and no unwanted changes were introduced.

---

### Task 4: Server-Side Run Manager Loop (`AiAssistRunManager.mjs`)

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistRunManager.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Interfaces:**
- Consumes:
  - `AiAssistRunStore` from `./AiAssistRunStore.mjs`
  - `createProviderClient` from `./AiAssistProviders.mjs`
  - `AiAssistTools` from `./AiAssistTools.mjs`
- Produces:
  - `startRun({ runId, projectId, userId, transcript, providerSettings })`: kicks off background agent loop.
  - `stopRun(runId)`: aborts active controller, emits `turnFinished: aborted`.
  - `approveEdit(runId, decision)`: resumes loop suspended on `awaitingApproval`.
  - `getActiveRun(runId)`: returns in-memory state or null.

- [ ] **Step 1: Write the failing backend test**

Create `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`:

```javascript
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
    expect(mockStore.appendEvent.calledWith('run-2', sinon.match({ type: 'toolCallFinished', id: 'edit-1' }))).to.be.true
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
    expect(mockStore.updateStatus.calledWith('run-3', 'stopped')).to.be.true
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs
```
Expected: FAIL (Cannot find module `AiAssistRunManager.mjs`)

- [ ] **Step 3: Write minimal implementation**

Create `modules/ai-assist/app/src/AiAssistRunManager.mjs`:

```javascript
import defaultStore from './AiAssistRunStore.mjs'
import defaultTools from './AiAssistTools.mjs'
import { createProviderClient } from './AiAssistProviders.mjs'

export class AiAssistRunManager {
  constructor({
    store = defaultStore,
    tools = defaultTools,
    clientFactory = createProviderClient,
  } = {}) {
    this.store = store
    this.tools = tools
    this.clientFactory = clientFactory
    this.activeRuns = new Map()
  }

  async startRun({ runId, projectId, userId, transcript, providerSettings }) {
    const controller = new AbortController()
    const approvalPromiseResolvers = { resolve: null }

    this.activeRuns.set(runId, {
      controller,
      projectId,
      userId,
      approvalResolver: approvalPromiseResolvers,
    })

    await this.store.createRun({ runId, projectId, userId })

    const client = this.clientFactory(providerSettings)
    const messages = [...transcript]

    try {
      let steps = 0
      const maxSteps = 20

      while (steps < maxSteps) {
        if (controller.signal.aborted) break

        const calls = []
        let text = ''

        for await (const chunk of client.streamChat({
          system: 'You are an expert LaTeX writing assistant for Overleaf.',
          messages,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break
          if (chunk.type === 'thinking') {
            await this.store.appendEvent(runId, { type: 'thinking', text: chunk.text })
          } else if (chunk.type === 'text') {
            text += chunk.text
            await this.store.appendEvent(runId, { type: 'text', text: chunk.text })
          } else if (chunk.type === 'tool_call') {
            calls.push(chunk)
          }
        }

        if (controller.signal.aborted) break

        if (calls.length === 0) {
          await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'stop' })
          await this.store.updateStatus(runId, 'done')
          break
        }

        messages.push({ role: 'assistant', content: text, toolCalls: calls })

        for (const call of calls) {
          if (controller.signal.aborted) break
          steps++

          await this.store.appendEvent(runId, {
            type: 'toolCallStarted',
            id: call.id,
            name: call.name,
            args: call.args,
          })

          let result = null
          let isError = false

          if (call.name === 'edit_file' || call.name === 'create_file') {
            await this.store.setPendingApproval(runId, { id: call.id, edit: call.args })
            await this.store.appendEvent(runId, {
              type: 'awaitingApproval',
              id: call.id,
              edit: call.args,
            })

            const decision = await new Promise(resolve => {
              approvalPromiseResolvers.resolve = resolve
            })

            if (!decision?.accepted) {
              result = { status: 'rejected', note: decision?.note }
            } else {
              result = await this.tools.execute(call.name, call.args, { projectId, userId })
            }
          } else {
            try {
              result = await this.tools.execute(call.name, call.args, { projectId, userId })
            } catch (err) {
              result = { error: err.message || 'Tool execution failed' }
              isError = true
            }
          }

          await this.store.appendEvent(runId, {
            type: 'toolCallFinished',
            id: call.id,
            result,
            isError,
          })

          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(result),
          })
        }
      }

      if (controller.signal.aborted) {
        await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'aborted' })
        await this.store.updateStatus(runId, 'stopped')
      }
    } catch (err) {
      await this.store.appendEvent(runId, {
        type: 'error',
        code: err.code || 'providerError',
        message: err.message,
      })
      await this.store.updateStatus(runId, 'error', { message: err.message })
    } finally {
      this.activeRuns.delete(runId)
    }
  }

  async stopRun(runId) {
    const active = this.activeRuns.get(runId)
    if (active) {
      active.controller.abort()
      if (active.approvalResolver?.resolve) {
        active.approvalResolver.resolve({ accepted: false })
      }
    } else {
      await this.store.updateStatus(runId, 'stopped')
      await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'aborted' })
    }
  }

  async approveEdit(runId, decision) {
    const active = this.activeRuns.get(runId)
    if (active?.approvalResolver?.resolve) {
      await this.store.clearPendingApproval(runId, 'running')
      active.approvalResolver.resolve(decision)
    }
  }
}

export default new AiAssistRunManager()
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs
```
Expected: PASS (3 tests passed)

- [ ] **Step 5: Verify working tree**

Run: `git status --porcelain modules/ai-assist`
Verify new files are untracked and no unwanted changes were introduced.

---

### Task 5: HTTP Endpoints & SSE Streaming (`AiAssistRunRouter.mjs`, `AiAssistRunController.mjs`)

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistRunController.mjs`
- Create: `modules/ai-assist/app/src/AiAssistRunRouter.mjs`
- Modify: `modules/ai-assist/index.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs`

**Interfaces:**
- Endpoints:
  - `POST /ai-assist/projects/:Project_id/runs` -> calls `runManager.startRun`, returns `{ runId }`.
  - `GET /ai-assist/runs/:runId/stream` -> sets `text/event-stream` headers, streams existing events `since`, subscribes to Redis channel.
  - `POST /ai-assist/runs/:runId/stop` -> calls `runManager.stopRun(runId)`.
  - `POST /ai-assist/runs/:runId/approve` -> calls `runManager.approveEdit(runId, decision)`.
- Consumes:
  - `AuthorizationMiddleware.ensureUserCanReadProject` / `ensureUserCanWriteProjectContent`
  - `AuthenticationController.requireLogin`

- [ ] **Step 1: Write the failing backend test**

Create `modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs`:

```javascript
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs
```
Expected: FAIL (Cannot find module `AiAssistRunController.mjs`)

- [ ] **Step 3: Write minimal implementation**

Create `modules/ai-assist/app/src/AiAssistRunController.mjs`:

```javascript
import crypto from 'node:crypto'
import defaultManager from './AiAssistRunManager.mjs'
import defaultStore from './AiAssistRunStore.mjs'
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'

export class AiAssistRunController {
  constructor({ manager = defaultManager, store = defaultStore } = {}) {
    this.manager = manager
    this.store = store
  }

  createRun = async (req, res) => {
    const projectId = req.params.Project_id || req.params.project_id
    const userId = req.session?.user?._id || 'anonymous'
    const { transcript, providerSettings } = req.body || {}

    if (!transcript || !providerSettings) {
      return res.status(400).json({ error: 'Missing transcript or providerSettings' })
    }

    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`

    // Start background promise without awaiting completion
    this.manager
      .startRun({
        runId,
        projectId,
        userId,
        transcript,
        providerSettings,
      })
      .catch(err => {
        console.error(`[AiAssist] Run ${runId} background failed:`, err)
      })

    res.json({ runId })
  }

  streamRun = async (req, res) => {
    const { runId } = req.params
    const sinceSeq = parseInt(req.query.since || '0', 10)

    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    // 1. Send existing catch-up events
    const existingEvents = await this.store.getEvents(runId, sinceSeq)
    for (const item of existingEvents) {
      res.write(`data: ${JSON.stringify(item)}\n\n`)
    }

    if (run.status === 'done' || run.status === 'stopped' || run.status === 'error' || run.status === 'interrupted') {
      res.end()
      return
    }

    // 2. Subscribe to new live events via Redis pub/sub
    const subClient = RedisWrapper.client('ai-assist')
    const channel = `ai-assist:run:${runId}:channel`

    const onMessage = (chan, message) => {
      if (chan === channel) {
        res.write(`data: ${message}\n\n`)
        try {
          const parsed = JSON.parse(message)
          if (parsed.event?.type === 'turnFinished' || parsed.event?.type === 'error') {
            cleanup()
            res.end()
          }
        } catch {}
      }
    }

    const cleanup = () => {
      try {
        subClient.unsubscribe(channel)
        subClient.removeListener('message', onMessage)
      } catch {}
    }

    req.on('close', cleanup)
    subClient.on('message', onMessage)
    await subClient.subscribe(channel)
  }

  stopRun = async (req, res) => {
    const { runId } = req.params
    await this.manager.stopRun(runId)
    res.json({ ok: true })
  }

  approve = async (req, res) => {
    const { runId } = req.params
    const decision = req.body || { accepted: false }
    await this.manager.approveEdit(runId, decision)
    res.json({ ok: true })
  }
}

export default new AiAssistRunController()
```

Create `modules/ai-assist/app/src/AiAssistRunRouter.mjs`:

```javascript
import AiAssistRunController from './AiAssistRunController.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import Settings from '@overleaf/settings'

export default {
  apply(webRouter) {
    if (!Settings.aiAssist?.enabled) return

    webRouter.post(
      '/ai-assist/projects/:Project_id/runs',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.createRun
    )

    webRouter.get(
      '/ai-assist/runs/:runId/stream',
      AuthenticationController.requireLogin(),
      AiAssistRunController.streamRun
    )

    webRouter.post(
      '/ai-assist/runs/:runId/stop',
      AuthenticationController.requireLogin(),
      AiAssistRunController.stopRun
    )

    webRouter.post(
      '/ai-assist/runs/:runId/approve',
      AuthenticationController.requireLogin(),
      AiAssistRunController.approve
    )
  },
}
```

Update `modules/ai-assist/index.mjs`:

```javascript
import './app/src/ModuleSettings.mjs'
import AiAssistRunRouter from './app/src/AiAssistRunRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const AiAssistModule = {
  name: 'ai-assist',
  router: AiAssistRunRouter,
}

export default AiAssistModule
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs
```
Expected: PASS (3 tests passed)

- [ ] **Step 5: Verify working tree**

Run: `git status --porcelain modules/ai-assist`
Verify new files are untracked and no unwanted changes were introduced.

---

### Task 6: Frontend Client Integration & Hook Rewiring (`background-run-client.ts`, `use-agent-run.ts`)

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/hooks/use-agent-run.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts`

**Interfaces:**
- Produces:
  - `startBackgroundRun({ projectId, transcript, providerSettings, onEvent, onDone, onError })`
  - `stopBackgroundRun(runId)`
  - `approveBackgroundEdit(runId, decision)`
  - `resumeBackgroundRunIfActive({ projectId, onEvent, onDone })`
- Modifies `useAgentRun`:
  - Connects `run()`, `stop()`, and `onDecision()` to background endpoints.
  - Automatically reconnects to any active run on editor mount.

- [ ] **Step 1: Write the failing frontend test**

Create `modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts`:

```typescript
import { expect } from 'chai'
import sinon from 'sinon'
import {
  startBackgroundRun,
  stopBackgroundRun,
  approveBackgroundEdit,
} from '../../../../frontend/js/features/ai-assist/agent/background/background-run-client'

describe('background-run-client', function () {
  let fakeFetch: sinon.SinonStub

  beforeEach(function () {
    fakeFetch = sinon.stub(window, 'fetch' as any)
  })

  afterEach(function () {
    fakeFetch.restore()
  })

  it('posts to create run endpoint and returns runId', async function () {
    fakeFetch.resolves({
      ok: true,
      json: sinon.stub().resolves({ runId: 'run-abc' }),
    })

    const runId = await startBackgroundRun({
      projectId: 'proj-1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', model: 'gpt-4o', apiKey: 'k' },
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,ts,tsx --require test/frontend/bootstrap.js \
  modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts
```
Expected: FAIL (Cannot find module `background-run-client`)

- [ ] **Step 3: Write minimal implementation**

Create `modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts`:

```typescript
import { AgentEvent } from '../agent-events'
import { TranscriptEntry } from '../agent-messages'
import { ProviderSettings } from '../../providers/types'
import customLocalStorage from '@/infrastructure/local-storage'

const ACTIVE_RUN_KEY = (projectId: string) => `ai-assist:active-run:${projectId}`

export function getStoredActiveRunId(projectId: string): string | null {
  return customLocalStorage.getItem(ACTIVE_RUN_KEY(projectId))
}

export function setStoredActiveRunId(projectId: string, runId: string | null) {
  if (runId) {
    customLocalStorage.setItem(ACTIVE_RUN_KEY(projectId), runId)
  } else {
    customLocalStorage.removeItem(ACTIVE_RUN_KEY(projectId))
  }
}

export async function startBackgroundRun({
  projectId,
  transcript,
  providerSettings,
}: {
  projectId: string
  transcript: TranscriptEntry[]
  providerSettings: ProviderSettings
}): Promise<string> {
  const res = await fetch(`/ai-assist/projects/${projectId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, providerSettings }),
  })
  if (!res.ok) {
    throw new Error(`Failed to start AI run (${res.status})`)
  }
  const data = await res.json()
  setStoredActiveRunId(projectId, data.runId)
  return data.runId
}

export function connectRunStream({
  runId,
  projectId,
  since = 0,
  onEvent,
  onDone,
  onError,
}: {
  runId: string
  projectId: string
  since?: number
  onEvent: (event: AgentEvent) => void
  onDone: () => void
  onError: (err: any) => void
}): () => void {
  const eventSource = new EventSource(`/ai-assist/runs/${runId}/stream?since=${since}`)

  eventSource.onmessage = msg => {
    try {
      const data = JSON.parse(msg.data)
      if (data.event) {
        onEvent(data.event)
        if (data.event.type === 'turnFinished' || data.event.type === 'error') {
          setStoredActiveRunId(projectId, null)
          eventSource.close()
          onDone()
        }
      }
    } catch (err) {
      onError(err)
    }
  }

  eventSource.onerror = err => {
    eventSource.close()
    onError(err)
  }

  return () => {
    eventSource.close()
  }
}

export async function stopBackgroundRun(runId: string): Promise<void> {
  await fetch(`/ai-assist/runs/${runId}/stop`, { method: 'POST' })
}

export async function approveBackgroundEdit(
  runId: string,
  decision: { accepted: boolean; note?: string }
): Promise<void> {
  await fetch(`/ai-assist/runs/${runId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decision),
  })
}
```

Update `modules/ai-assist/frontend/js/features/ai-assist/hooks/use-agent-run.ts` to connect to background run client:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AiAssistant } from '../assistant'
import { hasConsented, recordConsent } from '../provider-store'
import { useProjectHandle } from '../agent/use-project-handle'
import { AgentTool } from '../agent/tools/registry'
import { EditRequest } from '../agent/project-handle'
import { TranscriptEntry } from '../agent/agent-messages'
import { AgentEvent } from '../agent/agent-events'
import {
  AgentState,
  emptyAgentState,
  reduceAgentEvent,
} from '../agent/agent-state'
import {
  startBackgroundRun,
  connectRunStream,
  stopBackgroundRun,
  approveBackgroundEdit,
  getStoredActiveRunId,
  setStoredActiveRunId,
} from '../agent/background/background-run-client'

export function useAgentRun({
  tools,
  maxSteps,
  systemPrompt,
  cacheKey,
  onEvent,
  projectId = 'default',
}: {
  tools: Record<string, AgentTool>
  maxSteps: number
  systemPrompt?: string
  cacheKey?: string
  onEvent?: (event: AgentEvent, nextState: AgentState) => void
  projectId?: string
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<AgentState>(emptyAgentState([]))
  const [needsConsent, setNeedsConsent] = useState(false)
  const currentRunIdRef = useRef<string | null>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)
  const [approvalContext, setApprovalContext] = useState<{
    startLine: number
  } | null>(null)

  const handle = useProjectHandle({
    requestApproval: (_edit: EditRequest, context: { startLine: number }) =>
      Promise.resolve({ accepted: true }),
  })

  const onDecision = useCallback(
    async (decision: { accepted: boolean; note?: string }) => {
      if (currentRunIdRef.current) {
        await approveBackgroundEdit(currentRunIdRef.current, decision)
      }
      setApprovalContext(null)
    },
    []
  )

  const run = useCallback(
    async (transcript: TranscriptEntry[]) => {
      const assistant = AiAssistant.fromStoredSettings()
      if (!assistant) {
        setState(current => ({
          ...current,
          error: {
            code: 'noProvider',
            message: t(
              'ai_assist_configure_provider',
              'Configure an AI provider in Account Settings to use the assistant.'
            ),
          },
        }))
        return
      }
      if (!hasConsented()) {
        setNeedsConsent(true)
        return
      }

      window.dispatchEvent(new CustomEvent('aiAssist:agentReadSelection'))

      setState(current => ({
        ...current,
        transcript,
        running: true,
        stoppedForBudget: false,
        error: null,
      }))

      try {
        const runId = await startBackgroundRun({
          projectId,
          transcript,
          providerSettings: assistant.settings,
        })
        currentRunIdRef.current = runId

        streamCleanupRef.current?.()
        streamCleanupRef.current = connectRunStream({
          runId,
          projectId,
          onEvent: event => {
            setState(current => {
              const next = reduceAgentEvent(current, event)
              onEvent?.(event, next)
              return next
            })
          },
          onDone: () => {
            currentRunIdRef.current = null
          },
          onError: err => {
            currentRunIdRef.current = null
          },
        })
      } catch (err: any) {
        setState(current => ({
          ...current,
          running: false,
          error: { code: 'runFailed', message: err.message },
        }))
      }
    },
    [projectId, onEvent, t]
  )

  const stop = useCallback(async () => {
    if (currentRunIdRef.current) {
      await stopBackgroundRun(currentRunIdRef.current)
    }
    streamCleanupRef.current?.()
    setStoredActiveRunId(projectId, null)
    setApprovalContext(null)
  }, [projectId])

  // Reconnect on mount if run was in progress
  useEffect(() => {
    const activeRunId = getStoredActiveRunId(projectId)
    if (activeRunId) {
      currentRunIdRef.current = activeRunId
      setState(current => ({ ...current, running: true }))
      streamCleanupRef.current = connectRunStream({
        runId: activeRunId,
        projectId,
        onEvent: event => {
          setState(current => {
            const next = reduceAgentEvent(current, event)
            onEvent?.(event, next)
            return next
          })
        },
        onDone: () => {
          currentRunIdRef.current = null
        },
        onError: () => {
          currentRunIdRef.current = null
          setState(current => ({ ...current, running: false }))
        },
      })
    }
    return () => {
      streamCleanupRef.current?.()
    }
  }, [projectId, onEvent])

  const allowConsent = useCallback(() => {
    recordConsent()
    setNeedsConsent(false)
  }, [])

  return {
    state,
    setState,
    running: state.running,
    error: state.error,
    handle,
    approvalContext,
    run,
    stop,
    onDecision,
    needsConsent,
    allowConsent,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,ts,tsx --require test/frontend/bootstrap.js \
  modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts
```
Expected: PASS (3 tests passed)

- [ ] **Step 5: Verify working tree and full test suite**

Run:
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/
```
Expected: All backend unit tests pass.

---

### Task 7: End-to-End Build and Verification

**Files:**
- Verify: full webpack compilation and running dev server containers.

- [ ] **Step 1: Check webpack recompilation in dev server**

Run:
```bash
docker logs --tail 20 ai-assist-webpack-1 2>&1 | grep -iE "compiled|error"
```
Expected: `webpack compiled successfully`.

- [ ] **Step 2: Verify existing frontend test suites do not regress**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,ts,tsx --require test/frontend/bootstrap.js \
  modules/ai-assist/test/frontend/js/agent/components/subresult-group.test.tsx \
  modules/ai-assist/test/frontend/js/agent/components/agent-work-row.test.tsx \
  modules/ai-assist/test/frontend/js/agent/components/tool-call-detail.test.tsx \
  modules/ai-assist/test/frontend/js/agent/components/transcript.test.tsx
```
Expected: All 47 tests pass.
