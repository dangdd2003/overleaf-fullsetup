# AI Assist Project Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add an agentic AI chat panel to the Overleaf editor rail that can read, search, edit, and recompile the user's project through a bounded tool-calling loop, with every edit gated behind a diff the user accepts or rejects.

**Architecture:** All code is browser-side inside the existing `services/web/modules/ai-assist/` module; there is no server component and no inference proxy. A provider-agnostic async generator, `runAgent`, owns the tool-call loop and yields typed events. Tool executors depend on one interface, `ProjectHandle`, so the whole tool layer tests against a fake with no React and no network. A single React hook builds the real handle from `projectSnapshot`, the CodeMirror view, and the compile context. The panel attaches through the existing `railEntries` module slot.

**Tech Stack:** React 18 + TypeScript, CodeMirror 6, mocha + chai + `@testing-library/react` + `fetch-mock` (frontend unit tests), the module's existing `OpenAiClient` / `AnthropicClient` / `parseSseFrames`.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-10-ai-assist-project-agent-design.md`

## Global Constraints

- **Default disabled.** With `AI_ASSIST_ENABLED` unset the rail tab must not render and the module must contribute nothing to the page. The gate is `getMeta('ol-aiAssistEnabled')`, already exposed by `app/views/layout-base.pug`.
- **No server component.** `modules/ai-assist/index.mjs` has no router and gains none. No new endpoint, no Mongo collection, no stored credentials, no stored transcripts.
- **Provider calls go straight from the browser to the provider.** Overleaf is never in the path of inference.
- **Only two core files may be modified**, both additively: `config/settings.defaults.js` (the `railEntries` slot) and `frontend/js/features/ide-react/context/rail-context.tsx` (the `RailTabKey` union). New translation keys go in `locales/en.json`.
- **A tool must never throw out of the loop.** Every failure becomes a tool result the model can read and react to.
- **No API key may reach the DOM.** Unchanged from sub-project 1.
- All new files are `.ts` / `.tsx`. Existing files keep their current export names.
- Test commands run from `services/web`. Frontend: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js <path>`.
- Commit after each task. Do not push. Do not sign off with co-author trailers.

## File Structure

All paths below are relative to `services/web/modules/ai-assist/`.

| File | Responsibility |
|---|---|
| `frontend/js/features/ai-assist/providers/types.ts` | *(modify)* Adds `ToolSpec`, `AgentMessage`, the `tool_call` chunk, `ChatRequest.tools` |
| `frontend/js/features/ai-assist/providers/openai.ts` | *(modify)* Sends `tools`, accumulates `tool_calls` deltas, maps `AgentMessage` to the chat-completions wire format |
| `frontend/js/features/ai-assist/providers/anthropic.ts` | *(modify)* Sends `tools`, reads `tool_use` / `input_json_delta`, maps `AgentMessage` to the messages wire format |
| `frontend/js/features/ai-assist/agent/project-handle.ts` | The `ProjectHandle` interface and its data types |
| `frontend/js/features/ai-assist/agent/tools/registry.ts` | `AgentTool` type, the tool table, and `toolSpecs()` |
| `frontend/js/features/ai-assist/agent/tools/list-files.ts` | `list_files` |
| `frontend/js/features/ai-assist/agent/tools/read-file.ts` | `read_file`, with a line cap |
| `frontend/js/features/ai-assist/agent/tools/search-project.ts` | `search_project`, with a hit cap |
| `frontend/js/features/ai-assist/agent/tools/edit-file.ts` | `edit_file`, the one suspending tool |
| `frontend/js/features/ai-assist/agent/tools/compile-project.ts` | `compile_project`, with an in-flight guard |
| `frontend/js/features/ai-assist/agent/system-prompt.ts` | System prompt and project preamble |
| `frontend/js/features/ai-assist/agent/agent-messages.ts` | Transcript types and transcript to `AgentMessage[]` |
| `frontend/js/features/ai-assist/agent/agent-events.ts` | The `AgentEvent` union |
| `frontend/js/features/ai-assist/agent/run-agent.ts` | The loop |
| `frontend/js/features/ai-assist/agent/conversation-store.ts` | Per-project transcripts in `localStorage` |
| `frontend/js/features/ai-assist/agent/use-project-handle.ts` | React glue: contexts to `ProjectHandle` |
| `frontend/js/features/ai-assist/components/apply-fix-listener.tsx` | *(modify)* Adds the agent's read/write bridge events |
| `frontend/js/features/ai-assist/components/agent/tool-call-card.tsx` | Collapsed tool activity |
| `frontend/js/features/ai-assist/components/agent/edit-approval-card.tsx` | Diff with Accept / Reject |
| `frontend/js/features/ai-assist/components/agent/agent-message.tsx` | One transcript turn |
| `frontend/js/features/ai-assist/components/agent/agent-empty-state.tsx` | "Advanced tools" and "Start a chat" |
| `frontend/js/features/ai-assist/components/agent/agent-composer.tsx` | Input, attach, send / stop |
| `frontend/js/features/ai-assist/components/agent/agent-panel.tsx` | Header, transcript, composer, run state |
| `frontend/js/features/ai-assist/rail-entry.tsx` | Default export for the `railEntries` slot |

Test helpers live in `test/frontend/js/agent/helpers/`, which the mocha glob ignores.

---

### Task 1: Tool-calling types and the OpenAI wire format

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/types.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/openai.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/openai-tools.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolSpec`, `AgentMessage`, `ToolCall`, the `{ type: 'tool_call', id, name, args }` chunk, and `ChatRequest.tools`. Every later task depends on these names.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/openai-tools.test.ts`:

```ts
import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { OpenAiClient } from '../../../../frontend/js/features/ai-assist/providers/openai'

const OPENAI = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
}

const READ_FILE = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

function sse(body: string) {
  return { body, headers: { 'Content-Type': 'text/event-stream' } }
}

async function collect(generator: AsyncGenerator<any>) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

describe('OpenAiClient tool calling', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('sends tool specs and tool_choice auto', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse('data: [DONE]\n\n')
    )

    await collect(
      new OpenAiClient(OPENAI).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const body = JSON.parse(
      fetchMock.callHistory.lastCall()!.options!.body as string
    )
    expect(body.tools).to.deep.equal([{ type: 'function', function: READ_FILE }])
    expect(body.tool_choice).to.equal('auto')
  })

  it('assembles one tool_call from argument fragments split across frames', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"main.tex\\"}"}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )

    const chunks = await collect(
      new OpenAiClient(OPENAI).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    expect(chunks.filter(c => c.type === 'tool_call')).to.deep.equal([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        args: { path: 'main.tex' },
      },
    ])
    expect(chunks.at(-1)).to.deep.equal({ type: 'done', stopReason: 'tool_calls' })
  })

  it('reports malformed arguments as an args parse failure rather than throwing', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"read_file","arguments":"{not json"}}]}}]}\n\n' +
          'data: [DONE]\n\n'
      )
    )

    const chunks = await collect(
      new OpenAiClient(OPENAI).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const call = chunks.find(c => c.type === 'tool_call')
    expect(call.args).to.deep.equal({ __parseError: '{not json' })
  })

  it('replays a tool result as a role:tool message', async function () {
    fetchMock.post(
      'https://api.openai.com/v1/chat/completions',
      sse('data: [DONE]\n\n')
    )

    await collect(
      new OpenAiClient(OPENAI).streamChat({
        system: 's',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'call_1', name: 'read_file', args: { path: 'main.tex' } },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_1',
            name: 'read_file',
            content: '1: hello',
          },
        ],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const body = JSON.parse(
      fetchMock.callHistory.lastCall()!.options!.body as string
    )
    expect(body.messages[2]).to.deep.equal({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"main.tex"}' },
        },
      ],
    })
    expect(body.messages[3]).to.deep.equal({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '1: hello',
    })
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

Run from `services/web`:

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/openai-tools.test.ts
```

Expected: FAIL — `tools` is not sent and no `tool_call` chunk is produced.

- [x] **Step 3: Extend the shared types**

In `providers/types.ts`, add these exports and widen the two existing ones:

```ts
export type ToolSpec = {
  name: string
  description: string
  parameters: object // JSON Schema
}

export type ToolCall = {
  id: string
  name: string
  args: unknown
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | {
      role: 'tool'
      toolCallId: string
      name: string
      content: string
      isError?: boolean
    }

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; stopReason?: 'stop' | 'tool_calls' | 'length' }

export type ChatRequest = {
  system: string
  messages: AgentMessage[]
  maxTokens: number
  tools?: ToolSpec[]
  signal?: AbortSignal
}
```

`{ role: 'user' | 'assistant', content: string }` is still assignable to `AgentMessage`, so the error assistant compiles unchanged.

- [x] **Step 4: Implement tool calling in `OpenAiClient`**

Add a message mapper and an accumulator to `providers/openai.ts`:

```ts
function toWireMessages(system: string, messages: AgentMessage[]) {
  return [
    { role: 'system', content: system },
    ...messages.map(message => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.content,
        }
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content,
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }
      }
      return { role: message.role, content: message.content }
    }),
  ]
}

/** Arguments arrive as fragments keyed by index; assemble then parse once. */
class ToolCallAccumulator {
  private byIndex = new Map<number, { id: string; name: string; args: string }>()

  add(deltas: any[]) {
    for (const delta of deltas) {
      const entry = this.byIndex.get(delta.index) ?? {
        id: '',
        name: '',
        args: '',
      }
      if (delta.id) entry.id = delta.id
      if (delta.function?.name) entry.name = delta.function.name
      if (delta.function?.arguments) entry.args += delta.function.arguments
      this.byIndex.set(delta.index, entry)
    }
  }

  drain(): ChatChunk[] {
    return [...this.byIndex.values()].map(entry => {
      let args: unknown
      try {
        args = JSON.parse(entry.args || '{}')
      } catch {
        // The model produced invalid JSON. The loop turns this into a tool
        // error the model can read, which beats throwing mid-stream.
        args = { __parseError: entry.args }
      }
      return { type: 'tool_call', id: entry.id, name: entry.name, args }
    })
  }
}
```

In `streamChat`, build the body with `messages: toWireMessages(system, messages)` and, when `tools?.length`, add:

```ts
tools: tools.map(tool => ({ type: 'function', function: tool })),
tool_choice: 'auto',
```

In the frame loop, track `finish_reason` and feed `payload.choices?.[0]?.delta?.tool_calls` to the accumulator. After the loop, yield the accumulator's chunks, then:

```ts
yield {
  type: 'done',
  stopReason:
    finishReason === 'tool_calls'
      ? 'tool_calls'
      : finishReason === 'length'
        ? 'length'
        : 'stop',
}
```

- [x] **Step 5: Run the tests and verify they pass**

Run the command from Step 2, then the existing provider suite to confirm nothing regressed:

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js
```

Expected: PASS, including the pre-existing `providers.test.ts`.

- [x] **Step 6: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/providers/types.ts modules/ai-assist/frontend/js/features/ai-assist/providers/openai.ts modules/ai-assist/test/frontend/js/agent/openai-tools.test.ts
git commit -m "feat(ai-assist): add tool calling to the OpenAI provider client"
```

---

### Task 2: The Anthropic wire format

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/anthropic.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/anthropic-tools.test.ts`

**Interfaces:**
- Consumes: `ToolSpec`, `AgentMessage`, `ToolCall`, `ChatChunk` from Task 1.
- Produces: nothing new; `AnthropicClient` reaches parity with `OpenAiClient`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/anthropic-tools.test.ts`:

```ts
import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { AnthropicClient } from '../../../../frontend/js/features/ai-assist/providers/anthropic'

const ANTHROPIC = {
  type: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5',
}

const READ_FILE = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

function sse(body: string) {
  return { body, headers: { 'Content-Type': 'text/event-stream' } }
}

async function collect(generator: AsyncGenerator<any>) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

describe('AnthropicClient tool calling', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('sends tools with input_schema', async function () {
    fetchMock.post(
      'https://api.anthropic.com/v1/messages',
      sse('data: {"type":"message_stop"}\n\n')
    )

    await collect(
      new AnthropicClient(ANTHROPIC).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const body = JSON.parse(
      fetchMock.callHistory.lastCall()!.options!.body as string
    )
    expect(body.tools).to.deep.equal([
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: READ_FILE.parameters,
      },
    ])
  })

  it('assembles a tool_use block from input_json_delta fragments', async function () {
    fetchMock.post(
      'https://api.anthropic.com/v1/messages',
      sse(
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n' +
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n' +
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"main.tex\\"}"}}\n\n' +
          'data: {"type":"content_block_stop","index":0}\n\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
      )
    )

    const chunks = await collect(
      new AnthropicClient(ANTHROPIC).streamChat({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    expect(chunks.filter(c => c.type === 'tool_call')).to.deep.equal([
      {
        type: 'tool_call',
        id: 'toolu_1',
        name: 'read_file',
        args: { path: 'main.tex' },
      },
    ])
    expect(chunks.at(-1)).to.deep.equal({ type: 'done', stopReason: 'tool_calls' })
  })

  it('replays tool results as a user message of tool_result blocks', async function () {
    fetchMock.post(
      'https://api.anthropic.com/v1/messages',
      sse('data: {"type":"message_stop"}\n\n')
    )

    await collect(
      new AnthropicClient(ANTHROPIC).streamChat({
        system: 's',
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: 'Looking.',
            toolCalls: [
              { id: 'toolu_1', name: 'read_file', args: { path: 'main.tex' } },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'toolu_1',
            name: 'read_file',
            content: '1: hello',
          },
        ],
        maxTokens: 100,
        tools: [READ_FILE],
      })
    )

    const body = JSON.parse(
      fetchMock.callHistory.lastCall()!.options!.body as string
    )
    expect(body.messages[1].content).to.deep.equal([
      { type: 'text', text: 'Looking.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'read_file',
        input: { path: 'main.tex' },
      },
    ])
    expect(body.messages[2]).to.deep.equal({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '1: hello',
          is_error: false,
        },
      ],
    })
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/anthropic-tools.test.ts
```

Expected: FAIL — `tools` is not sent and `tool_use` blocks are ignored.

- [x] **Step 3: Implement tool calling in `AnthropicClient`**

Add the mapper. Consecutive `role: 'tool'` messages collapse into one user message, which is what the API requires:

```ts
function toWireMessages(messages: AgentMessage[]) {
  const wire: any[] = []

  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        is_error: Boolean(message.isError),
      }
      const previous = wire.at(-1)
      if (previous?.role === 'user' && Array.isArray(previous.content)) {
        previous.content.push(block)
      } else {
        wire.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const content: any[] = []
      if (message.content) content.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.args,
        })
      }
      wire.push({ role: 'assistant', content })
      continue
    }

    wire.push({ role: message.role, content: message.content })
  }

  return wire
}
```

When `tools?.length`, add to the request body:

```ts
tools: tools.map(tool => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
})),
```

In the frame loop, keep a map from block index to `{ id, name, json }`. On `content_block_start` with `content_block.type === 'tool_use'`, record the id and name. On `content_block_delta` with `delta.type === 'input_json_delta'`, append `delta.partial_json`. On `message_delta`, record `delta.stop_reason`. After the loop, parse each accumulated JSON with the same `__parseError` fallback as Task 1, yield one `tool_call` per block in index order, then:

```ts
yield {
  type: 'done',
  stopReason:
    stopReason === 'tool_use'
      ? 'tool_calls'
      : stopReason === 'max_tokens'
        ? 'length'
        : 'stop',
}
```

- [x] **Step 4: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/providers/anthropic.ts modules/ai-assist/test/frontend/js/agent/anthropic-tools.test.ts
git commit -m "feat(ai-assist): add tool calling to the Anthropic provider client"
```

---

### Task 3: The project handle and the three read tools

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/list-files.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-project.ts`
- Create: `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`

**Interfaces:**
- Consumes: `ToolSpec` from Task 1.
- Produces: `ProjectHandle`, `ProjectFile`, `EditRequest`, `EditOutcome`, `LogEntrySummary`, `SearchHit`, `CompileOutcome`, `AgentTool`, `TOOLS`, `toolSpecs()`, and the test helper `createFakeHandle`. Tasks 4, 5, 7 and 9 all build on these.

- [x] **Step 1: Write the failing test**

First create the fake, `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts`:

```ts
import {
  EditOutcome,
  EditRequest,
  ProjectHandle,
} from '../../../../../frontend/js/features/ai-assist/agent/project-handle'

export type FakeHandleOptions = {
  docs?: Record<string, string>
  binaries?: string[]
  rootDoc?: string | null
  selection?: { path: string; from: number; to: number; text: string } | null
  onEdit?: (edit: EditRequest) => EditOutcome
  compileResult?: Awaited<ReturnType<ProjectHandle['compile']>>
}

/** A ProjectHandle backed by a plain object, for tests that need no DOM. */
export function createFakeHandle(options: FakeHandleOptions = {}) {
  const docs = options.docs ?? {}
  const calls: Array<{ name: string; args: unknown }> = []

  const handle: ProjectHandle = {
    rootDocPath: () => options.rootDoc ?? Object.keys(docs)[0] ?? null,

    async listFiles() {
      calls.push({ name: 'listFiles', args: null })
      return [
        ...Object.entries(docs).map(([path, text]) => ({
          path,
          type: 'doc' as const,
          size: text.length,
        })),
        ...(options.binaries ?? []).map(path => ({
          path,
          type: 'binary' as const,
          size: 0,
        })),
      ]
    },

    async readFile(path, range) {
      calls.push({ name: 'readFile', args: { path, range } })
      const text = docs[path]
      if (text === undefined) throw new Error(`no such doc: ${path}`)
      const lines = text.split('\n')
      if (!range) return { lines, truncated: false }
      return { lines: lines.slice(range.from - 1, range.to), truncated: false }
    },

    async search(query) {
      calls.push({ name: 'search', args: { query } })
      const hits = []
      for (const [path, text] of Object.entries(docs)) {
        text.split('\n').forEach((line, index) => {
          if (line.includes(query)) hits.push({ path, line: index + 1, text: line })
        })
      }
      return hits
    },

    currentSelection: () => options.selection ?? null,

    async proposeEdit(edit) {
      calls.push({ name: 'proposeEdit', args: edit })
      return options.onEdit ? options.onEdit(edit) : { status: 'applied' }
    },

    async compile() {
      calls.push({ name: 'compile', args: null })
      return (
        options.compileResult ?? { status: 'success', errors: [], warnings: [] }
      )
    },
  }

  return { handle, calls }
}
```

Then `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`:

```ts
import { expect } from 'chai'
import {
  TOOLS,
  toolSpecs,
} from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = {
  'main.tex':
    '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}',
  'chapters/intro.tex': 'Intro text\nSecond line',
}

describe('read tools', function () {
  it('exposes every tool spec with a JSON-schema object', function () {
    const names = toolSpecs().map(spec => spec.name)
    expect(names).to.include.members(['list_files', 'read_file', 'search_project'])
    for (const spec of toolSpecs()) {
      expect(spec.parameters).to.have.property('type', 'object')
      expect(spec.description).to.be.a('string').and.not.be.empty
    }
  })

  it('list_files returns every path with its type', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      binaries: ['figures/plot.png'],
    })
    const result: any = await TOOLS.list_files.execute({}, handle)
    expect(result.files.map((file: any) => file.path)).to.deep.equal([
      'main.tex',
      'chapters/intro.tex',
      'figures/plot.png',
    ])
    expect(result.files.at(-1).type).to.equal('binary')
  })

  it('read_file numbers the lines it returns', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await TOOLS.read_file.execute(
      { path: 'chapters/intro.tex' },
      handle
    )
    expect(result.content).to.equal('1: Intro text\n2: Second line')
    expect(result.truncated).to.equal(false)
  })

  it('read_file honours a line range', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await TOOLS.read_file.execute(
      { path: 'main.tex', from: 2, to: 3 },
      handle
    )
    expect(result.content).to.equal('2: \\begin{document}\n3: Hello')
  })

  it('read_file refuses a binary file with a readable message', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      binaries: ['figures/plot.png'],
    })
    const result: any = await TOOLS.read_file.execute(
      { path: 'figures/plot.png' },
      handle
    )
    expect(result.error).to.match(/binary/i)
  })

  it('read_file reports a missing path instead of throwing', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await TOOLS.read_file.execute({ path: 'nope.tex' }, handle)
    expect(result.error).to.match(/not found/i)
  })

  it('read_file truncates a file longer than the cap', async function () {
    const long = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n')
    const { handle } = createFakeHandle({ docs: { 'long.tex': long } })
    const result: any = await TOOLS.read_file.execute({ path: 'long.tex' }, handle)
    expect(result.truncated).to.equal(true)
    expect(result.content.split('\n')).to.have.length(1000)
  })

  it('search_project returns path, line and text', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await TOOLS.search_project.execute({ query: 'Intro' }, handle)
    expect(result.hits).to.deep.equal([
      { path: 'chapters/intro.tex', line: 1, text: 'Intro text' },
    ])
  })

  it('search_project caps the number of hits it returns', async function () {
    const many = Array.from({ length: 200 }, () => 'needle').join('\n')
    const { handle } = createFakeHandle({ docs: { 'many.tex': many } })
    const result: any = await TOOLS.search_project.execute(
      { query: 'needle' },
      handle
    )
    expect(result.hits).to.have.length(50)
    expect(result.truncated).to.equal(true)
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/read-tools.test.ts
```

Expected: FAIL — `agent/tools/registry` does not exist.

- [x] **Step 3: Write `project-handle.ts`**

```ts
export type ProjectFile = {
  path: string
  type: 'doc' | 'binary'
  size: number
}

export type LogEntrySummary = {
  message: string
  file: string | null
  line: number | null
}

export type EditRequest = {
  path: string
  oldText: string
  newText: string
}

export type EditOutcome =
  | { status: 'applied' }
  | { status: 'rejected'; note?: string }
  | { status: 'noMatch' }
  | { status: 'ambiguous'; matches: number }
  | { status: 'drifted' }

export type SearchHit = { path: string; line: number; text: string }

export type CompileOutcome = {
  status: string
  errors: LogEntrySummary[]
  warnings: LogEntrySummary[]
}

/**
 * Everything the agent is allowed to do to a project.
 *
 * Tools depend on this and nothing else, which is what keeps them testable
 * without React, a DOM, or a network.
 */
export interface ProjectHandle {
  rootDocPath(): string | null
  listFiles(): Promise<ProjectFile[]>
  readFile(
    path: string,
    range?: { from: number; to: number }
  ): Promise<{ lines: string[]; truncated: boolean }>
  search(
    query: string,
    options?: { caseSensitive?: boolean; regexp?: boolean }
  ): Promise<SearchHit[]>
  currentSelection(): {
    path: string
    from: number
    to: number
    text: string
  } | null
  proposeEdit(edit: EditRequest): Promise<EditOutcome>
  compile(): Promise<CompileOutcome>
}

export const MAX_READ_LINES = 1000
export const MAX_SEARCH_HITS = 50
```

- [x] **Step 4: Write the registry and the three read tools**

`tools/registry.ts`:

```ts
import { ToolSpec } from '../../providers/types'
import { ProjectHandle } from '../project-handle'
import { listFilesTool } from './list-files'
import { readFileTool } from './read-file'
import { searchProjectTool } from './search-project'

export type AgentTool = {
  spec: ToolSpec
  /** True when the tool needs the user before it can finish. */
  suspends: boolean
  execute(args: any, handle: ProjectHandle): Promise<unknown>
}

export const TOOLS: Record<string, AgentTool> = {
  list_files: listFilesTool,
  read_file: readFileTool,
  search_project: searchProjectTool,
}

export function toolSpecs(): ToolSpec[] {
  return Object.values(TOOLS).map(tool => tool.spec)
}
```

`tools/list-files.ts`:

```ts
import { AgentTool } from './registry'

export const listFilesTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'list_files',
    description:
      'List every file in the project with its path, type and size. Call this first to orient yourself.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async execute(_args, handle) {
    return { files: await handle.listFiles() }
  },
}
```

`tools/read-file.ts`:

```ts
import { AgentTool } from './registry'
import { MAX_READ_LINES } from '../project-handle'

function number(lines: string[], offset: number) {
  return lines.map((line, index) => `${offset + index}: ${line}`).join('\n')
}

export const readFileTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'read_file',
    description:
      'Read a text file from the project. Returns numbered lines. Pass from and to to read part of a long file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path as returned by list_files' },
        from: { type: 'number', description: 'First line, 1-indexed' },
        to: { type: 'number', description: 'Last line, inclusive' },
      },
      required: ['path'],
    },
  },
  async execute({ path, from, to }, handle) {
    const files = await handle.listFiles()
    const file = files.find(candidate => candidate.path === path)

    if (!file) return { error: `File not found: ${path}` }
    if (file.type === 'binary') {
      return { error: `${path} is a binary file and cannot be read as text.` }
    }

    const range = from && to ? { from, to } : undefined
    const { lines } = await handle.readFile(path, range)
    const start = range ? range.from : 1
    const capped = lines.slice(0, MAX_READ_LINES)

    return {
      path,
      content: number(capped, start),
      truncated: capped.length < lines.length,
    }
  },
}
```

`tools/search-project.ts`:

```ts
import { AgentTool } from './registry'
import { MAX_SEARCH_HITS } from '../project-handle'

export const searchProjectTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'search_project',
    description:
      'Search every text file in the project for a string or regular expression.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        regexp: { type: 'boolean' },
      },
      required: ['query'],
    },
  },
  async execute({ query, caseSensitive, regexp }, handle) {
    const hits = await handle.search(query, { caseSensitive, regexp })
    return {
      hits: hits.slice(0, MAX_SEARCH_HITS),
      truncated: hits.length > MAX_SEARCH_HITS,
    }
  },
}
```

- [x] **Step 5: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/read-tools.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/agent modules/ai-assist/test/frontend/js/agent
git commit -m "feat(ai-assist): add the project handle and the agent read tools"
```

---

### Task 4: The edit tool

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`

**Interfaces:**
- Consumes: `AgentTool`, `TOOLS`, `ProjectHandle`, `EditOutcome`, `createFakeHandle`.
- Produces: `editFileTool`, registered as `TOOLS.edit_file` with `suspends: true`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`:

```ts
import { expect } from 'chai'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = {
  'main.tex': 'alpha\nbeta\ngamma\nbeta\n',
  'unique.tex': 'one\ntwo\nthree\n',
}

describe('edit_file', function () {
  it('is marked as suspending, so the loop waits for the user', function () {
    expect(TOOLS.edit_file.suspends).to.equal(true)
  })

  it('reports a unique match as applied once the user accepts', async function () {
    const { handle, calls } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('applied')
    expect(calls.filter(call => call.name === 'proposeEdit')).to.have.length(1)
  })

  it('reports noMatch without ever proposing an edit', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'absent', newText: 'x' },
      handle
    )

    expect(result.status).to.equal('noMatch')
    expect(result.message).to.match(/did not appear/i)
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('reports ambiguous with a count when the anchor appears twice', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'beta', newText: 'BETA' },
      handle
    )

    expect(result.status).to.equal('ambiguous')
    expect(result.matches).to.equal(2)
    expect(result.message).to.match(/more context/i)
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('passes a rejection and its note back to the model', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'rejected', note: 'keep the original wording' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('rejected')
    expect(result.note).to.equal('keep the original wording')
  })

  it('reports drift when the document changed before the user accepted', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'drifted' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
      handle
    )

    expect(result.status).to.equal('drifted')
    expect(result.message).to.match(/re-read/i)
  })

  it('reports a missing file rather than throwing', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'nope.tex', oldText: 'a', newText: 'b' },
      handle
    )

    expect(result.error).to.match(/not found/i)
  })

  it('rejects an empty anchor, which would match everywhere', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'unique.tex', oldText: '', newText: 'x' },
      handle
    )

    expect(result.error).to.match(/oldText/i)
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts
```

Expected: FAIL — `TOOLS.edit_file` is undefined.

- [x] **Step 3: Write `tools/edit-file.ts`**

```ts
import { AgentTool } from './registry'

function countOccurrences(haystack: string, needle: string) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export const editFileTool: AgentTool = {
  // The loop must wait for the user's decision before continuing.
  suspends: true,
  spec: {
    name: 'edit_file',
    description:
      'Replace a span of text in a project file. oldText must appear exactly once in the file - include surrounding lines to make it unique. The user reviews the change as a diff and may reject it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: {
          type: 'string',
          description: 'The exact text to replace, unique within the file',
        },
        newText: { type: 'string', description: 'The replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },

  async execute({ path, oldText, newText }, handle) {
    if (typeof oldText !== 'string' || oldText.length === 0) {
      return { error: 'oldText must be a non-empty span of the file to replace.' }
    }

    const files = await handle.listFiles()
    const file = files.find(candidate => candidate.path === path)
    if (!file) return { error: `File not found: ${path}` }
    if (file.type === 'binary') {
      return { error: `${path} is a binary file and cannot be edited.` }
    }

    const { lines } = await handle.readFile(path)
    const matches = countOccurrences(lines.join('\n'), oldText)

    if (matches === 0) {
      return {
        status: 'noMatch',
        message: `That text did not appear in ${path}. Read the file again and copy the span exactly.`,
      }
    }
    if (matches > 1) {
      return {
        status: 'ambiguous',
        matches,
        message: `That text appears ${matches} times in ${path}. Include more context so the anchor is unique.`,
      }
    }

    const outcome = await handle.proposeEdit({ path, oldText, newText })

    switch (outcome.status) {
      case 'applied':
        return { status: 'applied', message: `Applied the change to ${path}.` }
      case 'rejected':
        return {
          status: 'rejected',
          note: outcome.note,
          message: 'The user rejected this change.',
        }
      case 'drifted':
        return {
          status: 'drifted',
          message: `${path} changed while the user was reviewing. Re-read it before trying again.`,
        }
      default:
        return outcome
    }
  },
}
```

Register it in `tools/registry.ts` by importing `editFileTool` and adding `edit_file: editFileTool` to `TOOLS`.

- [x] **Step 4: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/agent/tools modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts
git commit -m "feat(ai-assist): add the agent edit tool with anchor matching"
```

---

### Task 5: The compile tool

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`

**Interfaces:**
- Consumes: `AgentTool`, `ProjectHandle`, `CompileOutcome`, `createFakeHandle`.
- Produces: `compileProjectTool`, registered as `TOOLS.compile_project`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`:

```ts
import { expect } from 'chai'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { createFakeHandle } from './helpers/fake-handle'

describe('compile_project', function () {
  it('summarises errors and warnings', async function () {
    const { handle } = createFakeHandle({
      compileResult: {
        status: 'failure',
        errors: [
          { message: 'Undefined control sequence', file: 'main.tex', line: 12 },
        ],
        warnings: [{ message: 'Overfull hbox', file: 'main.tex', line: 40 }],
      },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.status).to.equal('failure')
    expect(result.errorCount).to.equal(1)
    expect(result.warningCount).to.equal(1)
    expect(result.errors[0].message).to.equal('Undefined control sequence')
  })

  it('says so plainly when the compile succeeded with nothing to report', async function () {
    const { handle } = createFakeHandle({
      compileResult: { status: 'success', errors: [], warnings: [] },
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.errorCount).to.equal(0)
    expect(result.message).to.match(/compiled/i)
  })

  it('refuses a second compile while one is still running', async function () {
    let release: (value: any) => void = () => {}
    const pending = new Promise(resolve => {
      release = resolve
    })

    const { handle } = createFakeHandle()
    handle.compile = () => pending as any

    const first = TOOLS.compile_project.execute({}, handle)
    const second: any = await TOOLS.compile_project.execute({}, handle)

    expect(second.error).to.match(/already in progress/i)

    release({ status: 'success', errors: [], warnings: [] })
    await first
  })

  it('clears the in-flight guard after a compile throws', async function () {
    const { handle } = createFakeHandle()
    handle.compile = () => Promise.reject(new Error('clsi unreachable'))

    const failed: any = await TOOLS.compile_project.execute({}, handle)
    expect(failed.error).to.match(/clsi unreachable/i)

    handle.compile = async () => ({ status: 'success', errors: [], warnings: [] })
    const recovered: any = await TOOLS.compile_project.execute({}, handle)
    expect(recovered.status).to.equal('success')
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts
```

Expected: FAIL — `TOOLS.compile_project` is undefined.

- [x] **Step 3: Write `tools/compile-project.ts`**

```ts
import { AgentTool } from './registry'

const MAX_REPORTED = 20

// Module-level so a second call during the same run sees the first one. The
// guard is per page, which is exactly the scope that matters: one editor tab
// drives one project.
let compileInFlight = false

export const compileProjectTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'compile_project',
    description:
      'Compile the project and return the LaTeX errors and warnings. Use this to check whether an edit fixed the problem.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  async execute(_args, handle) {
    if (compileInFlight) {
      return { error: 'A compile is already in progress. Wait for it to finish.' }
    }

    compileInFlight = true
    try {
      const outcome = await handle.compile()
      return {
        status: outcome.status,
        errorCount: outcome.errors.length,
        warningCount: outcome.warnings.length,
        errors: outcome.errors.slice(0, MAX_REPORTED),
        warnings: outcome.warnings.slice(0, MAX_REPORTED),
        message:
          outcome.errors.length === 0
            ? 'The project compiled without errors.'
            : `The project compiled with ${outcome.errors.length} error(s).`,
      }
    } catch (error: any) {
      return { error: error?.message ?? 'The compile failed to start.' }
    } finally {
      // Always released, or one failure would wedge the tool for the session.
      compileInFlight = false
    }
  },
}
```

Register it in `tools/registry.ts` as `compile_project: compileProjectTool`.

- [x] **Step 4: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/agent/tools modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts
git commit -m "feat(ai-assist): add the agent compile tool"
```

---

### Task 6: The system prompt and transcript conversion

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/system-prompt.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/agent-messages.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/agent-messages.test.ts`

**Interfaces:**
- Consumes: `AgentMessage`, `ToolCall`, `ProjectFile`.
- Produces: `buildSystemPrompt({ rootDocPath, files, selection })`, the types `TranscriptEntry` and `ToolCallRecord`, and `toAgentMessages(transcript)`. Tasks 7, 8, 10 and 11 all use `TranscriptEntry`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/agent-messages.test.ts`:

```ts
import { expect } from 'chai'
import { buildSystemPrompt } from '../../../../frontend/js/features/ai-assist/agent/system-prompt'
import {
  TranscriptEntry,
  toAgentMessages,
} from '../../../../frontend/js/features/ai-assist/agent/agent-messages'

describe('buildSystemPrompt', function () {
  it('names the root document and lists the project files', function () {
    const prompt = buildSystemPrompt({
      rootDocPath: 'main.tex',
      files: [
        { path: 'main.tex', type: 'doc', size: 10 },
        { path: 'refs.bib', type: 'doc', size: 20 },
      ],
      selection: null,
    })

    expect(prompt).to.include('main.tex')
    expect(prompt).to.include('refs.bib')
    expect(prompt).to.match(/root document/i)
  })

  it('includes the current selection when there is one', function () {
    const prompt = buildSystemPrompt({
      rootDocPath: 'main.tex',
      files: [],
      selection: { path: 'main.tex', from: 3, to: 4, text: '\\alpha' },
    })

    expect(prompt).to.include('\\alpha')
    expect(prompt).to.include('main.tex')
  })

  it('tells the model that edits need the user to accept them', function () {
    const prompt = buildSystemPrompt({
      rootDocPath: null,
      files: [],
      selection: null,
    })
    expect(prompt).to.match(/reject/i)
  })
})

describe('toAgentMessages', function () {
  it('converts a plain exchange', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'hello' },
      { id: '2', role: 'assistant', text: 'hi', toolCalls: [] },
    ]

    expect(toAgentMessages(transcript)).to.deep.equal([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('expands each tool call into an assistant turn plus a tool result', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'read main' },
      {
        id: '2',
        role: 'assistant',
        text: 'Looking.',
        toolCalls: [
          {
            id: 'call_1',
            name: 'read_file',
            args: { path: 'main.tex' },
            result: { content: '1: hello' },
            isError: false,
          },
        ],
      },
    ]

    expect(toAgentMessages(transcript)).to.deep.equal([
      { role: 'user', content: 'read main' },
      {
        role: 'assistant',
        content: 'Looking.',
        toolCalls: [
          { id: 'call_1', name: 'read_file', args: { path: 'main.tex' } },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'read_file',
        content: '{"content":"1: hello"}',
        isError: false,
      },
    ])
  })

  it('synthesises a result for a call that never finished', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'go' },
      {
        id: '2',
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call_1', name: 'compile_project', args: {} }],
      },
    ]

    const messages = toAgentMessages(transcript)
    expect(messages.at(-1)).to.deep.include({
      role: 'tool',
      toolCallId: 'call_1',
      isError: true,
    })
  })

  it('drops an empty trailing assistant turn so the model is not asked to continue nothing', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'go' },
      { id: '2', role: 'assistant', text: '', toolCalls: [] },
    ]

    expect(toAgentMessages(transcript)).to.deep.equal([
      { role: 'user', content: 'go' },
    ])
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/agent-messages.test.ts
```

Expected: FAIL — neither module exists.

- [x] **Step 3: Write `system-prompt.ts`**

```ts
import { ProjectFile } from './project-handle'

const MAX_LISTED_FILES = 200

export function buildSystemPrompt({
  rootDocPath,
  files,
  selection,
}: {
  rootDocPath: string | null
  files: ProjectFile[]
  selection: { path: string; from: number; to: number; text: string } | null
}) {
  const listing = files
    .slice(0, MAX_LISTED_FILES)
    .map(file => `- ${file.path}${file.type === 'binary' ? ' (binary)' : ''}`)
    .join('\n')

  const parts = [
    "You are a LaTeX expert working inside the user's Overleaf project.",
    '',
    'Work in small steps. Read a file before you edit it. Prefer the smallest',
    'change that solves the problem, and explain what you changed and why.',
    '',
    'Every edit you propose is shown to the user as a diff, and they may reject',
    'it. If they reject a change, do not simply try the same edit again - ask',
    'what they want instead.',
    '',
    'When you edit, the oldText anchor must appear exactly once in the file.',
    'Include surrounding lines if a short anchor would be ambiguous.',
    '',
    rootDocPath
      ? `The root document is ${rootDocPath}.`
      : 'This project has no root document set.',
  ]

  if (listing) {
    parts.push('', 'Project files:', listing)
    if (files.length > MAX_LISTED_FILES) {
      parts.push(
        `(${files.length - MAX_LISTED_FILES} more; call list_files for all of them.)`
      )
    }
  }

  if (selection) {
    parts.push(
      '',
      `The user currently has lines ${selection.from}-${selection.to} of ${selection.path} selected:`,
      selection.text
    )
  }

  return parts.join('\n')
}
```

- [x] **Step 4: Write `agent-messages.ts`**

```ts
import { AgentMessage } from '../providers/types'

export type ToolCallRecord = {
  id: string
  name: string
  args: unknown
  result?: unknown
  isError?: boolean
}

export type TranscriptEntry =
  | { id: string; role: 'user'; text: string }
  | {
      id: string
      role: 'assistant'
      text: string
      toolCalls: ToolCallRecord[]
    }

/**
 * Rebuilds the provider-facing message array from the stored transcript.
 *
 * The transcript is what gets persisted and rendered; this is the only place
 * that knows how it maps onto a conversation, which is why switching provider
 * mid-project is safe.
 */
export function toAgentMessages(transcript: TranscriptEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = []

  transcript.forEach((entry, index) => {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text })
      return
    }

    const isLast = index === transcript.length - 1
    if (isLast && !entry.text && entry.toolCalls.length === 0) return

    if (entry.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: entry.text })
      return
    }

    messages.push({
      role: 'assistant',
      content: entry.text,
      toolCalls: entry.toolCalls.map(call => ({
        id: call.id,
        name: call.name,
        args: call.args,
      })),
    })

    for (const call of entry.toolCalls) {
      const finished = 'result' in call
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: finished
          ? JSON.stringify(call.result)
          : 'This tool call did not complete.',
        isError: finished ? Boolean(call.isError) : true,
      })
    }
  })

  return messages
}
```

- [x] **Step 5: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/agent-messages.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/agent/system-prompt.ts modules/ai-assist/frontend/js/features/ai-assist/agent/agent-messages.ts modules/ai-assist/test/frontend/js/agent/agent-messages.test.ts
git commit -m "feat(ai-assist): add the agent system prompt and transcript conversion"
```

---

### Task 7: The agent loop

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/agent-events.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts`

**Interfaces:**
- Consumes: `ProviderClient`, `ChatChunk`, `AgentMessage`, `ToolSpec`, `ProviderError`, `ProviderErrorCode` from the providers; `TOOLS`, `AgentTool`, `ProjectHandle`, `EditRequest`; `TranscriptEntry`, `toAgentMessages`, `buildSystemPrompt`.
- Produces: `AgentEvent`, `MAX_STEPS`, and `runAgent(options): AsyncGenerator<AgentEvent>`. Task 11 consumes both.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts`:

```ts
import { expect } from 'chai'
import { runAgent } from '../../../../frontend/js/features/ai-assist/agent/run-agent'
import { AgentEvent } from '../../../../frontend/js/features/ai-assist/agent/agent-events'
import { AgentTool } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { ProviderError } from '../../../../frontend/js/features/ai-assist/providers/types'
import { createFakeHandle } from './helpers/fake-handle'

/** A provider client that replays a scripted list of turns. */
function fakeClient(turns: any[][]) {
  const requests: any[] = []
  let turn = 0

  return {
    requests,
    client: {
      async *streamChat(request: any) {
        requests.push(request)
        const chunks = turns[turn++] ?? [{ type: 'done', stopReason: 'stop' }]
        for (const chunk of chunks) yield chunk
      },
      async listModels() {
        return []
      },
    },
  }
}

const echoTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: {} },
  },
  async execute(args) {
    return { echoed: args }
  },
}

const throwingTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'boom',
    description: 'boom',
    parameters: { type: 'object', properties: {} },
  },
  async execute() {
    throw new Error('tool exploded')
  },
}

async function collect(generator: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = []
  for await (const event of generator) events.push(event)
  return events
}

describe('runAgent', function () {
  it('streams a text-only turn and finishes', async function () {
    const { client } = fakeClient([
      [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'there' },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'hi' }],
      })
    )

    expect(
      events
        .filter(e => e.type === 'text')
        .map((e: any) => e.text)
        .join('')
    ).to.equal('Hello there')
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('executes a tool call and feeds the result into the next turn', async function () {
    const { client, requests } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'echo', args: { a: 1 } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(events.filter(e => e.type === 'toolCallStarted')).to.have.length(1)
    const finished: any = events.find(e => e.type === 'toolCallFinished')
    expect(finished.result).to.deep.equal({ echoed: { a: 1 } })
    expect(finished.isError).to.equal(false)

    const toolMessage: any = requests[1].messages.at(-1)
    expect(toolMessage.role).to.equal('tool')
    expect(toolMessage.toolCallId).to.equal('c1')
  })

  it('runs several tool calls from one turn in order', async function () {
    const { client } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'echo', args: { n: 1 } },
        { type: 'tool_call', id: 'c2', name: 'echo', args: { n: 2 } },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(
      events.filter(e => e.type === 'toolCallFinished').map((e: any) => e.id)
    ).to.deep.equal(['c1', 'c2'])
  })

  it('turns a thrown tool into an error result instead of ending the run', async function () {
    const { client } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'boom', args: {} },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        { type: 'text', text: 'recovered' },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { boom: throwingTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const finished: any = events.find(e => e.type === 'toolCallFinished')
    expect(finished.isError).to.equal(true)
    expect(JSON.stringify(finished.result)).to.match(/tool exploded/)
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('emits an unknown-tool error result when the model invents a name', async function () {
    const { client } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'not_a_tool', args: {} },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const finished: any = events.find(e => e.type === 'toolCallFinished')
    expect(finished.isError).to.equal(true)
    expect(JSON.stringify(finished.result)).to.match(/unknown tool/i)
  })

  it('stops with reason budget once the step limit is reached', async function () {
    const looping = Array.from({ length: 20 }, () => [
      { type: 'tool_call', id: 'c', name: 'echo', args: {} },
      { type: 'done', stopReason: 'tool_calls' },
    ])
    const { client } = fakeClient(looping)
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
        maxSteps: 3,
      })
    )

    expect(events.filter(e => e.type === 'toolCallStarted')).to.have.length(3)
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'budget' })
  })

  it('emits awaitingApproval before a suspending tool runs', async function () {
    const editTool: AgentTool = {
      suspends: true,
      spec: {
        name: 'edit_file',
        description: 'edit',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        return { status: 'applied' }
      },
    }

    const { client } = fakeClient([
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'edit_file',
          args: { path: 'main.tex', oldText: 'a', newText: 'b' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [{ type: 'done', stopReason: 'stop' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { edit_file: editTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const approval: any = events.find(e => e.type === 'awaitingApproval')
    expect(approval.edit).to.deep.equal({
      path: 'main.tex',
      oldText: 'a',
      newText: 'b',
    })
    expect(events.indexOf(approval)).to.be.lessThan(
      events.findIndex(e => e.type === 'toolCallFinished')
    )
  })

  it('reports a provider failure as an error event and stops', async function () {
    const client = {
      async *streamChat() {
        throw new ProviderError('providerAuth', 'key rejected', 401)
      },
      async listModels() {
        return []
      },
    }
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client: client as any,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(events[0]).to.deep.include({ type: 'error', code: 'providerAuth' })
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('finishes with reason aborted when the signal fires', async function () {
    const controller = new AbortController()
    const client = {
      async *streamChat() {
        controller.abort()
        yield { type: 'text', text: 'partial' }
        throw new ProviderError('aborted', 'Cancelled')
      },
      async listModels() {
        return []
      },
    }
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client: client as any,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'go' }],
        signal: controller.signal,
      })
    )

    expect(events.some(e => e.type === 'text')).to.equal(true)
    expect(events.at(-1)).to.deep.equal({
      type: 'turnFinished',
      reason: 'aborted',
    })
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/run-agent.test.ts
```

Expected: FAIL — `run-agent` does not exist.

- [x] **Step 3: Write `agent-events.ts`**

```ts
import { EditRequest } from './project-handle'
import { ProviderErrorCode } from '../providers/types'

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCallStarted'; id: string; name: string; args: unknown }
  | { type: 'toolCallFinished'; id: string; result: unknown; isError: boolean }
  | { type: 'awaitingApproval'; id: string; edit: EditRequest }
  | { type: 'turnFinished'; reason: 'stop' | 'budget' | 'aborted' }
  | { type: 'error'; code: ProviderErrorCode; message: string }
```

- [x] **Step 4: Write `run-agent.ts`**

```ts
import {
  AgentMessage,
  ProviderClient,
  ProviderError,
  ToolCall,
} from '../providers/types'
import { AgentEvent } from './agent-events'
import { AgentTool } from './tools/registry'
import { ProjectHandle } from './project-handle'
import { TranscriptEntry, toAgentMessages } from './agent-messages'
import { buildSystemPrompt } from './system-prompt'

export const MAX_STEPS = 12
const MAX_OUTPUT_TOKENS = 4096

export async function* runAgent({
  client,
  handle,
  tools,
  transcript,
  maxSteps = MAX_STEPS,
  signal,
}: {
  client: ProviderClient
  handle: ProjectHandle
  tools: Record<string, AgentTool>
  transcript: TranscriptEntry[]
  maxSteps?: number
  signal?: AbortSignal
}): AsyncGenerator<AgentEvent> {
  const specs = Object.values(tools).map(tool => tool.spec)
  const messages: AgentMessage[] = toAgentMessages(transcript)

  let system: string
  try {
    system = buildSystemPrompt({
      rootDocPath: handle.rootDocPath(),
      files: await handle.listFiles(),
      selection: handle.currentSelection(),
    })
  } catch {
    // A snapshot that will not load must not stop the user talking to the model.
    system = buildSystemPrompt({ rootDocPath: null, files: [], selection: null })
  }

  let steps = 0

  while (true) {
    let text = ''
    const calls: ToolCall[] = []

    try {
      for await (const chunk of client.streamChat({
        system,
        messages,
        maxTokens: MAX_OUTPUT_TOKENS,
        tools: specs.length ? specs : undefined,
        signal,
      })) {
        if (chunk.type === 'text') {
          text += chunk.text
          yield { type: 'text', text: chunk.text }
        } else if (chunk.type === 'tool_call') {
          calls.push({ id: chunk.id, name: chunk.name, args: chunk.args })
        }
      }
    } catch (error: any) {
      if (error instanceof ProviderError && error.code === 'aborted') {
        return yield { type: 'turnFinished', reason: 'aborted' }
      }
      yield {
        type: 'error',
        code: error?.code ?? 'providerError',
        message: error?.message ?? 'The provider request failed.',
      }
      return yield { type: 'turnFinished', reason: 'stop' }
    }

    if (signal?.aborted) {
      return yield { type: 'turnFinished', reason: 'aborted' }
    }

    if (calls.length === 0) {
      messages.push({ role: 'assistant', content: text })
      return yield { type: 'turnFinished', reason: 'stop' }
    }

    messages.push({ role: 'assistant', content: text, toolCalls: calls })

    for (const call of calls) {
      if (steps >= maxSteps) {
        return yield { type: 'turnFinished', reason: 'budget' }
      }
      steps += 1

      yield {
        type: 'toolCallStarted',
        id: call.id,
        name: call.name,
        args: call.args,
      }

      const tool = tools[call.name]
      let result: unknown
      let isError = false

      if (!tool) {
        result = { error: `Unknown tool: ${call.name}` }
        isError = true
      } else {
        if (tool.suspends) {
          yield { type: 'awaitingApproval', id: call.id, edit: call.args as any }
        }
        try {
          result = await tool.execute(call.args, handle)
          isError = Boolean((result as any)?.error)
        } catch (error: any) {
          // A broken tool is data for the model, never the end of the run.
          result = { error: error?.message ?? 'The tool failed.' }
          isError = true
        }
      }

      yield { type: 'toolCallFinished', id: call.id, result, isError }

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(result),
        isError,
      })

      if (signal?.aborted) {
        return yield { type: 'turnFinished', reason: 'aborted' }
      }
    }
  }
}
```

- [x] **Step 5: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/agent/agent-events.ts modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts modules/ai-assist/test/frontend/js/agent/run-agent.test.ts
git commit -m "feat(ai-assist): add the bounded agent tool-calling loop"
```

---

### Task 8: Conversation storage

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/conversation-store.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/conversation-store.test.ts`

**Interfaces:**
- Consumes: `TranscriptEntry` from Task 6.
- Produces: `loadConversation(projectId)`, `saveConversation(projectId, transcript)`, `clearConversation(projectId)`, `MAX_STORED_BYTES`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/conversation-store.test.ts`:

```ts
import { expect } from 'chai'
import {
  clearConversation,
  loadConversation,
  saveConversation,
} from '../../../../frontend/js/features/ai-assist/agent/conversation-store'
import { TranscriptEntry } from '../../../../frontend/js/features/ai-assist/agent/agent-messages'

const PROJECT = '6789abcdef0123456789abcd'

describe('conversation-store', function () {
  beforeEach(function () {
    window.localStorage.clear()
  })

  it('returns an empty transcript for an unknown project', function () {
    expect(loadConversation(PROJECT)).to.deep.equal([])
  })

  it('round-trips a transcript', function () {
    const transcript: TranscriptEntry[] = [
      { id: '1', role: 'user', text: 'hello' },
      { id: '2', role: 'assistant', text: 'hi', toolCalls: [] },
    ]
    saveConversation(PROJECT, transcript)
    expect(loadConversation(PROJECT)).to.deep.equal(transcript)
  })

  it('keeps conversations for different projects apart', function () {
    saveConversation(PROJECT, [{ id: '1', role: 'user', text: 'a' }])
    saveConversation('other', [{ id: '1', role: 'user', text: 'b' }])
    expect(loadConversation(PROJECT)[0]).to.deep.include({ text: 'a' })
    expect(loadConversation('other')[0]).to.deep.include({ text: 'b' })
  })

  it('truncates a large tool result before storing it', function () {
    saveConversation(PROJECT, [
      {
        id: '2',
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'read_file',
            args: {},
            result: { content: 'x'.repeat(50000) },
          },
        ],
      },
    ])

    const stored = loadConversation(PROJECT)
    const result = JSON.stringify((stored[0] as any).toolCalls[0].result)
    expect(result.length).to.be.lessThan(5000)
    expect(result).to.match(/truncated/i)
  })

  it('drops the oldest turns when the transcript exceeds the byte cap', function () {
    const many: TranscriptEntry[] = Array.from({ length: 400 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      text: 'y'.repeat(2000),
    }))
    saveConversation(PROJECT, many)

    const stored = loadConversation(PROJECT)
    expect(stored.length).to.be.lessThan(400)
    expect(stored.at(-1)!.id).to.equal('399')
  })

  it('clears a conversation', function () {
    saveConversation(PROJECT, [{ id: '1', role: 'user', text: 'a' }])
    clearConversation(PROJECT)
    expect(loadConversation(PROJECT)).to.deep.equal([])
  })

  it('returns an empty transcript rather than throwing on corrupt storage', function () {
    window.localStorage.setItem(`ai-assist:chat:${PROJECT}`, 'not json')
    expect(loadConversation(PROJECT)).to.deep.equal([])
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/conversation-store.test.ts
```

Expected: FAIL — `conversation-store` does not exist.

- [x] **Step 3: Write `conversation-store.ts`**

```ts
import { TranscriptEntry } from './agent-messages'

export const MAX_STORED_BYTES = 200000
const MAX_RESULT_CHARS = 4000

const keyFor = (projectId: string) => `ai-assist:chat:${projectId}`

/** Tool results can be enormous; the transcript only needs enough to re-read. */
function shrink(entry: TranscriptEntry): TranscriptEntry {
  if (entry.role !== 'assistant') return entry

  return {
    ...entry,
    toolCalls: entry.toolCalls.map(call => {
      if (!('result' in call)) return call
      const serialised = JSON.stringify(call.result) ?? ''
      if (serialised.length <= MAX_RESULT_CHARS) return call
      return {
        ...call,
        result: {
          truncated: true,
          preview: serialised.slice(0, MAX_RESULT_CHARS),
        },
      }
    }),
  }
}

function fit(transcript: TranscriptEntry[]) {
  let kept = transcript.map(shrink)
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_STORED_BYTES) {
    kept = kept.slice(1)
  }
  return kept
}

export function loadConversation(projectId: string): TranscriptEntry[] {
  try {
    const raw = window.localStorage.getItem(keyFor(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveConversation(
  projectId: string,
  transcript: TranscriptEntry[]
) {
  try {
    window.localStorage.setItem(keyFor(projectId), JSON.stringify(fit(transcript)))
  } catch {
    // Storage denied or full. History degrades to memory for this session,
    // which matches how provider-store.ts already treats this case.
  }
}

export function clearConversation(projectId: string) {
  try {
    window.localStorage.removeItem(keyFor(projectId))
  } catch {
    // ignore
  }
}
```

- [x] **Step 4: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/conversation-store.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/agent/conversation-store.ts modules/ai-assist/test/frontend/js/agent/conversation-store.test.ts
git commit -m "feat(ai-assist): persist agent conversations per project"
```

---

### Task 9: The real project handle

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`

**Interfaces:**
- Consumes: `ProjectHandle`, `ProjectFile`, `SearchHit`, `EditRequest`, `EditOutcome`, `LogEntrySummary`; `lineRangeToOffsets` from `apply-fix.ts`.
- Produces: `useProjectHandle({ requestApproval }): ProjectHandle`, plus the exported pure helpers `findUniqueSpan(text, oldText)` and `spanToLineRange(text, index, length)` that the bridge and its tests share.

The bridge extends the existing window-event pattern in `apply-fix-listener.tsx`, because the rail panel renders outside the source editor's CodeMirror provider. Three new request events, each with a matching reply: `aiAssist:agentReadDoc`, `aiAssist:agentApplyEdit`, and `aiAssist:agentReadSelection`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`:

```ts
import { expect } from 'chai'
import {
  findUniqueSpan,
  spanToLineRange,
} from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'

const TEXT = 'alpha\nbeta\ngamma\nbeta\n'

describe('findUniqueSpan', function () {
  it('returns the index of a single occurrence', function () {
    expect(findUniqueSpan(TEXT, 'gamma')).to.deep.equal({
      status: 'found',
      index: 11,
    })
  })

  it('reports no match', function () {
    expect(findUniqueSpan(TEXT, 'delta')).to.deep.equal({ status: 'noMatch' })
  })

  it('reports how many times an ambiguous span appears', function () {
    expect(findUniqueSpan(TEXT, 'beta')).to.deep.equal({
      status: 'ambiguous',
      matches: 2,
    })
  })
})

describe('spanToLineRange', function () {
  it('maps a span onto 1-indexed inclusive lines', function () {
    const index = TEXT.indexOf('gamma')
    expect(spanToLineRange(TEXT, index, 'gamma'.length)).to.deep.equal({
      from: 3,
      to: 3,
    })
  })

  it('covers every line a multi-line span touches', function () {
    const index = TEXT.indexOf('beta')
    expect(spanToLineRange(TEXT, index, 'beta\ngamma'.length)).to.deep.equal({
      from: 2,
      to: 3,
    })
  })
})
```

Note on the first assertion: `'alpha\nbeta\n'` is 11 characters, so `'gamma'` starts at index 11. Verify against the literal rather than trusting the number if the fixture changes.

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts
```

Expected: FAIL — `use-project-handle` does not exist.

- [x] **Step 3: Write the pure helpers**

Create `agent/use-project-handle.ts`, starting with the two exported helpers:

```ts
export function findUniqueSpan(text: string, oldText: string) {
  const first = text.indexOf(oldText)
  if (first === -1) return { status: 'noMatch' as const }

  let matches = 0
  let index = first
  while (index !== -1) {
    matches += 1
    index = text.indexOf(oldText, index + oldText.length)
  }

  if (matches > 1) return { status: 'ambiguous' as const, matches }
  return { status: 'found' as const, index: first }
}

export function spanToLineRange(text: string, index: number, length: number) {
  const before = text.slice(0, index)
  const from = before.split('\n').length
  const to = from + text.slice(index, index + length).split('\n').length - 1
  return { from, to }
}
```

- [x] **Step 4: Write the hook**

In the same file:

```ts
import { useCallback, useMemo, useRef } from 'react'
import { useProjectContext } from '@/shared/context/project-context'
import { useLocalCompileContext } from '@/shared/context/local-compile-context'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import {
  EditOutcome,
  EditRequest,
  ProjectFile,
  ProjectHandle,
  SearchHit,
} from './project-handle'

const REPLY_TIMEOUT_MS = 5000

/** Asks the editor a question over the window-event bridge. */
function askEditor<T>(request: string, reply: string, detail: unknown): Promise<T | null> {
  return new Promise(resolve => {
    const onReply = (event: Event) => {
      window.clearTimeout(timer)
      resolve((event as CustomEvent).detail as T)
    }

    const timer = window.setTimeout(() => {
      window.removeEventListener(reply, onReply)
      resolve(null)
    }, REPLY_TIMEOUT_MS)

    window.addEventListener(reply, onReply, { once: true })
    window.dispatchEvent(new CustomEvent(request, { detail }))
  })
}

export function useProjectHandle({
  requestApproval,
}: {
  requestApproval: (
    edit: EditRequest
  ) => Promise<{ accepted: boolean; note?: string }>
}): ProjectHandle {
  const { projectSnapshot, project } = useProjectContext()
  const { startCompile, logEntries } = useLocalCompileContext()
  const { openDocWithId } = useEditorManagerContext()
  const logEntriesRef = useRef(logEntries)
  logEntriesRef.current = logEntries

  const listFiles = useCallback(async (): Promise<ProjectFile[]> => {
    await projectSnapshot.refresh()
    const docs = projectSnapshot.getDocPaths().map(path => ({
      path,
      type: 'doc' as const,
      size: projectSnapshot.getDocContents(path)?.length ?? 0,
    }))
    const binaries = projectSnapshot
      .getBinaryFilePathsWithHash()
      .map(file => ({ path: file.path, type: 'binary' as const, size: file.size }))
    return [...docs, ...binaries]
  }, [projectSnapshot])

  const readFile = useCallback(
    async (path: string, range?: { from: number; to: number }) => {
      await projectSnapshot.refresh()
      const contents = projectSnapshot.getDocContents(path)
      if (contents === null) return { lines: [], truncated: false }
      const lines = contents.split('\n')
      if (!range) return { lines, truncated: false }
      return { lines: lines.slice(range.from - 1, range.to), truncated: false }
    },
    [projectSnapshot]
  )

  const proposeEdit = useCallback(
    async (edit: EditRequest): Promise<EditOutcome> => {
      const doc = await askEditor<{ text: string }>(
        'aiAssist:agentReadDoc',
        'aiAssist:agentReadDocResult',
        { path: edit.path }
      )
      if (!doc) return { status: 'drifted' }

      const found = findUniqueSpan(doc.text, edit.oldText)
      if (found.status === 'noMatch') return { status: 'noMatch' }
      if (found.status === 'ambiguous') {
        return { status: 'ambiguous', matches: found.matches }
      }

      const range = spanToLineRange(doc.text, found.index, edit.oldText.length)
      const decision = await requestApproval(edit)
      if (!decision.accepted) {
        return { status: 'rejected', note: decision.note }
      }

      const applied = await askEditor<{ status: string }>(
        'aiAssist:agentApplyEdit',
        'aiAssist:agentApplyEditResult',
        { ...range, oldText: edit.oldText, replacement: edit.newText }
      )
      return applied?.status === 'applied'
        ? { status: 'applied' }
        : { status: 'drifted' }
    },
    [requestApproval]
  )

  // search, currentSelection and compile are described in Step 5.

  return useMemo(
    () => ({
      rootDocPath: () => project?.rootDocId ? projectSnapshot.getDocPaths()[0] ?? null : null,
      listFiles,
      readFile,
      search,
      currentSelection,
      proposeEdit,
      compile,
    }),
    [project, projectSnapshot, listFiles, readFile, search, currentSelection, proposeEdit, compile]
  )
}
```

Before dispatching `aiAssist:agentApplyEdit`, `proposeEdit` calls `openDocWithId` for the target path's doc id, so the edit lands in a document the user can see. Resolve that id from `projectSnapshot` / the file-tree data for the path.

- [x] **Step 5: Fill in the remaining handle methods**

Still in `use-project-handle.ts`. `search` reuses the same snapshot and the same CodeMirror cursors that `modules/full-project-search/frontend/js/util/search-snapshot.ts` uses:

```ts
import { Text } from '@codemirror/state'
import { RegExpCursor, SearchCursor } from '@codemirror/search'
import useEventListener from '@/shared/hooks/use-event-listener'

const search = useCallback(
  async (query: string, options?: { caseSensitive?: boolean; regexp?: boolean }) => {
    await projectSnapshot.refresh()
    const hits: SearchHit[] = []

    for (const path of projectSnapshot.getDocPaths()) {
      const contents = projectSnapshot.getDocContents(path)
      if (!contents) continue

      const text = Text.of(contents.split('\n'))
      const cursor = options?.regexp
        ? new RegExpCursor(text, query, { ignoreCase: !options.caseSensitive })
        : new SearchCursor(
            text,
            query,
            undefined,
            undefined,
            options?.caseSensitive ? undefined : (s: string) => s.toLowerCase()
          )

      while (!cursor.next().done) {
        const line = text.lineAt(cursor.value.from)
        hits.push({ path, line: line.number, text: line.text })
      }
    }

    return hits
  },
  [projectSnapshot]
)
```

`currentSelection` reads a ref the editor keeps up to date over the bridge:

```ts
const selectionRef = useRef<{
  path: string
  from: number
  to: number
  text: string
} | null>(null)

useEventListener('aiAssist:agentSelection', (event: Event) => {
  selectionRef.current = (event as CustomEvent).detail ?? null
})

const currentSelection = useCallback(() => selectionRef.current, [])
```

`compile` starts a compile and waits for the log to change. Polling is used rather than a promise because `startCompile` resolves when the request is sent, not when the build lands:

```ts
const COMPILE_TIMEOUT_MS = 120000
const POLL_INTERVAL_MS = 500

const compile = useCallback(async () => {
  const before = logEntriesRef.current
  await startCompile()

  const deadline = Date.now() + COMPILE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (logEntriesRef.current && logEntriesRef.current !== before) break
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  const entries = logEntriesRef.current
  if (!entries || entries === before) {
    throw new Error('The compile did not finish in time.')
  }

  const summarise = (list: any[] = []) =>
    list.map(entry => ({
      message: entry.message ?? '',
      file: entry.file ?? null,
      line: entry.line ?? null,
    }))

  return {
    status: entries.errors?.length ? 'failure' : 'success',
    errors: summarise(entries.errors),
    warnings: summarise(entries.warnings),
  }
}, [startCompile])
```

Note that `compile` throwing is safe: `compileProjectTool` catches it and returns `{ error }` to the model.

- [x] **Step 6: Extend the editor bridge**

In `components/apply-fix-listener.tsx`, add three handlers alongside the existing two, using the same `useEventListener` pattern:

```ts
const onAgentReadDoc = useCallback(() => {
  window.dispatchEvent(
    new CustomEvent('aiAssist:agentReadDocResult', {
      detail: { text: view.state.doc.toString() },
    })
  )
}, [view])

const onAgentApplyEdit = useCallback(
  (event: Event) => {
    const { from, to, oldText, replacement } =
      (event as CustomEvent<any>).detail ?? {}

    const current = view.state.doc.toString().split('\n')
    const respond = (status: string) =>
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentApplyEditResult', { detail: { status } })
      )

    // The user may have typed since the diff was rendered. Compare against the
    // anchor the model matched, not a stale snapshot.
    if (current.slice(from - 1, to).join('\n') !== oldText) {
      return respond('drifted')
    }

    const offsets = lineRangeToOffsets(view.state.doc, from, to)
    if (!offsets) return respond('drifted')

    view.dispatch({
      changes: { from: offsets.from, to: offsets.to, insert: replacement },
    })
    respond('applied')
  },
  [view]
)

const onAgentReadSelection = useCallback(() => {
  const { from, to } = view.state.selection.main
  window.dispatchEvent(
    new CustomEvent('aiAssist:agentSelection', {
      detail:
        from === to
          ? null
          : {
              from: view.state.doc.lineAt(from).number,
              to: view.state.doc.lineAt(to).number,
              text: view.state.sliceDoc(from, to),
            },
    })
  )
}, [view])

useEventListener('aiAssist:agentReadDoc', onAgentReadDoc)
useEventListener('aiAssist:agentApplyEdit', onAgentApplyEdit)
useEventListener('aiAssist:agentReadSelection', onAgentReadSelection)
```

- [x] **Step 7: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js
```

Expected: PASS, including the pre-existing `apply-fix.test.ts`.

- [x] **Step 8: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts
git commit -m "feat(ai-assist): bind the agent project handle to the editor"
```

---

### Task 10: Transcript components

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-card.tsx`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/edit-approval-card.tsx`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-message.tsx`
- Modify: `locales/en.json`
- Test: `modules/ai-assist/test/frontend/js/agent/components/transcript.test.tsx`

**Interfaces:**
- Consumes: `TranscriptEntry`, `ToolCallRecord`, `EditRequest`.
- Produces: `ToolCallCard`, `EditApprovalCard`, and `AgentMessageView` (named so it does not collide with the `AgentMessage` type).

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/components/transcript.test.tsx`:

```tsx
import { expect } from 'chai'
import sinon from 'sinon'
import { fireEvent, render, screen } from '@testing-library/react'
import { ToolCallCard } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-card'
import { EditApprovalCard } from '../../../../../frontend/js/features/ai-assist/components/agent/edit-approval-card'

describe('ToolCallCard', function () {
  it('summarises a read without showing the arguments until expanded', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c1',
          name: 'read_file',
          args: { path: 'chapters/intro.tex' },
          result: {},
        }}
      />
    )

    expect(screen.getByText(/chapters\/intro\.tex/)).to.exist
    expect(screen.queryByText(/"path"/)).to.equal(null)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/"path"/)).to.exist
  })

  it('summarises a compile by its error count', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c2',
          name: 'compile_project',
          args: {},
          result: { status: 'failure', errorCount: 2, warningCount: 0 },
        }}
      />
    )
    expect(screen.getByText(/2 errors/i)).to.exist
  })

  it('marks a failed call', function () {
    render(
      <ToolCallCard
        call={{
          id: 'c3',
          name: 'read_file',
          args: { path: 'x' },
          result: { error: 'nope' },
          isError: true,
        }}
      />
    )
    expect(screen.getByText(/failed/i)).to.exist
  })

  it('shows a running call with no result yet', function () {
    render(<ToolCallCard call={{ id: 'c4', name: 'list_files', args: {} }} />)
    expect(screen.getByText(/running/i)).to.exist
  })
})

describe('EditApprovalCard', function () {
  const EDIT = { path: 'main.tex', oldText: 'alpha', newText: 'beta' }

  it('shows the path, the removed text and the added text', function () {
    render(<EditApprovalCard edit={EDIT} onDecision={sinon.stub()} />)
    expect(screen.getByText('main.tex')).to.exist
    expect(screen.getByText('alpha')).to.exist
    expect(screen.getByText('beta')).to.exist
  })

  it('reports acceptance', function () {
    const onDecision = sinon.stub()
    render(<EditApprovalCard edit={EDIT} onDecision={onDecision} />)

    fireEvent.click(screen.getByRole('button', { name: /accept/i }))
    expect(onDecision).to.have.been.calledWithMatch({ accepted: true })
  })

  it('reports rejection with the note the user typed', function () {
    const onDecision = sinon.stub()
    render(<EditApprovalCard edit={EDIT} onDecision={onDecision} />)

    fireEvent.change(screen.getByPlaceholderText(/why/i), {
      target: { value: 'wrong section' },
    })
    fireEvent.click(screen.getByRole('button', { name: /reject/i }))

    expect(onDecision).to.have.been.calledWithMatch({
      accepted: false,
      note: 'wrong section',
    })
  })

  it('disables both buttons once a decision has been made', function () {
    render(
      <EditApprovalCard edit={EDIT} onDecision={sinon.stub()} decided="accepted" />
    )
    expect(screen.getByRole('button', { name: /accept/i })).to.have.property(
      'disabled',
      true
    )
    expect(screen.getByRole('button', { name: /reject/i })).to.have.property(
      'disabled',
      true
    )
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/components/transcript.test.tsx
```

Expected: FAIL — the components do not exist.

- [x] **Step 3: Write `tool-call-card.tsx`**

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ToolCallRecord } from '../../agent/agent-messages'

function summarise(call: ToolCallRecord, t: (key: string, opts?: any) => string) {
  const args = (call.args ?? {}) as any
  const result = call.result as any

  if (!('result' in call)) return t('ai_assist_tool_running', { tool: call.name })
  if (call.isError) return t('ai_assist_tool_failed', { tool: call.name })

  switch (call.name) {
    case 'read_file':
      return t('ai_assist_tool_read', { path: args.path })
    case 'search_project':
      return t('ai_assist_tool_searched', {
        query: args.query,
        count: result?.hits?.length ?? 0,
      })
    case 'edit_file':
      return t('ai_assist_tool_edited', { path: args.path, status: result?.status })
    case 'compile_project':
      return t('ai_assist_tool_compiled', { count: result?.errorCount ?? 0 })
    default:
      return call.name
  }
}

export function ToolCallCard({ call }: { call: ToolCallRecord }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="ai-assist-tool-call">
      <button
        type="button"
        className="ai-assist-tool-call-summary"
        onClick={() => setExpanded(open => !open)}
      >
        {summarise(call, t)}
      </button>
      {expanded && (
        <pre className="ai-assist-tool-call-detail">
          {JSON.stringify({ args: call.args, result: call.result }, null, 2)}
        </pre>
      )}
    </div>
  )
}
```

- [x] **Step 4: Write `edit-approval-card.tsx`**

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditRequest } from '../../agent/project-handle'

export function EditApprovalCard({
  edit,
  onDecision,
  decided,
}: {
  edit: EditRequest
  onDecision: (decision: { accepted: boolean; note?: string }) => void
  decided?: 'accepted' | 'rejected'
}) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const locked = Boolean(decided)

  return (
    <div className="ai-assist-edit-approval">
      <div className="ai-assist-edit-approval-path">{edit.path}</div>

      <pre className="ai-assist-diff">
        <del>{edit.oldText}</del>
        <ins>{edit.newText}</ins>
      </pre>

      <input
        type="text"
        value={note}
        disabled={locked}
        placeholder={t('ai_assist_reject_note_placeholder')}
        onChange={event => setNote(event.target.value)}
      />

      <div className="ai-assist-edit-approval-actions">
        <button
          type="button"
          disabled={locked}
          onClick={() => onDecision({ accepted: true })}
        >
          {t('accept')}
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={() => onDecision({ accepted: false, note: note || undefined })}
        >
          {t('reject')}
        </button>
      </div>
    </div>
  )
}
```

- [x] **Step 5: Write `agent-message.tsx` and add the locale keys**

`agent-message.tsx`:

```tsx
import { TranscriptEntry } from '../../agent/agent-messages'
import { EditRequest } from '../../agent/project-handle'
import { ToolCallCard } from './tool-call-card'
import { EditApprovalCard } from './edit-approval-card'

export function AgentMessageView({
  entry,
  pendingApprovalId,
  onDecision,
}: {
  entry: TranscriptEntry
  pendingApprovalId: string | null
  onDecision: (decision: { accepted: boolean; note?: string }) => void
}) {
  if (entry.role === 'user') {
    return <div className="ai-assist-message ai-assist-message-user">{entry.text}</div>
  }

  return (
    <div className="ai-assist-message ai-assist-message-assistant">
      {entry.text && <div className="ai-assist-message-text">{entry.text}</div>}

      {entry.toolCalls.map(call =>
        // An edit still waiting on the user is shown as a diff to act on; every
        // other call, including a decided edit, is shown as activity.
        call.name === 'edit_file' && call.id === pendingApprovalId ? (
          <EditApprovalCard
            key={call.id}
            edit={call.args as EditRequest}
            onDecision={onDecision}
          />
        ) : (
          <ToolCallCard key={call.id} call={call} />
        )
      )}
    </div>
  )
}
```

Add to `locales/en.json`, keeping the file's existing ordering:

```json
"ai_assist_reject_note_placeholder": "Why? (optional)",
"ai_assist_tool_compiled": "Compiled — __count__ errors",
"ai_assist_tool_edited": "Edited __path__ (__status__)",
"ai_assist_tool_failed": "__tool__ failed",
"ai_assist_tool_read": "Read __path__",
"ai_assist_tool_running": "Running __tool__…",
"ai_assist_tool_searched": "Searched for \"__query__\" — __count__ hits"
```

If `accept` and `reject` are not already present in `locales/en.json`, add them too.

- [x] **Step 6: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/components/transcript.test.tsx
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/components/agent locales/en.json modules/ai-assist/test/frontend/js/agent/components
git commit -m "feat(ai-assist): add agent transcript and edit-approval components"
```

---

### Task 11: The panel, composer, and empty state

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-empty-state.tsx`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-composer.tsx`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/assistant.ts` (expose the provider client)
- Modify: `frontend/stylesheets/components/ai-assist.scss`
- Modify: `locales/en.json`
- Test: `modules/ai-assist/test/frontend/js/agent/components/agent-panel.test.tsx`

**Interfaces:**
- Consumes: `runAgent`, `AgentEvent`, `TOOLS`, `useProjectHandle`, `loadConversation` / `saveConversation` / `clearConversation`, `TranscriptEntry`, `ToolCallRecord`, `EditRequest`, `AiAssistant.fromStoredSettings`, `hasConsented` / `recordConsent`, `AgentMessageView`, and core's `RailPanelHeader` and `OLIconButton`.
- Produces: `AgentPanel`, plus `emptyAgentState(transcript)` and `reduceAgentEvent(state, event)` exported for testing.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/components/agent-panel.test.tsx`:

```tsx
import { expect } from 'chai'
import sinon from 'sinon'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  reduceAgentEvent,
  emptyAgentState,
} from '../../../../../frontend/js/features/ai-assist/components/agent/agent-panel'
import { AgentEmptyState } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-empty-state'
import { AgentComposer } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-composer'

describe('reduceAgentEvent', function () {
  it('accumulates streamed text into the open assistant turn', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, { type: 'text', text: 'Hel' })
    state = reduceAgentEvent(state, { type: 'text', text: 'lo' })

    expect(state.transcript.at(-1)).to.deep.include({
      role: 'assistant',
      text: 'Hello',
    })
  })

  it('records a tool call and then its result', function () {
    let state = emptyAgentState([{ id: '1', role: 'user', text: 'hi' }])
    state = reduceAgentEvent(state, {
      type: 'toolCallStarted',
      id: 'c1',
      name: 'read_file',
      args: { path: 'main.tex' },
    })
    expect((state.transcript.at(-1) as any).toolCalls[0]).to.not.have.property(
      'result'
    )

    state = reduceAgentEvent(state, {
      type: 'toolCallFinished',
      id: 'c1',
      result: { content: 'x' },
      isError: false,
    })
    expect((state.transcript.at(-1) as any).toolCalls[0].result).to.deep.equal({
      content: 'x',
    })
  })

  it('marks the run as awaiting approval and clears it on the result', function () {
    let state = emptyAgentState([])
    state = reduceAgentEvent(state, {
      type: 'awaitingApproval',
      id: 'c1',
      edit: { path: 'main.tex', oldText: 'a', newText: 'b' },
    })
    expect(state.pendingApproval).to.deep.include({ id: 'c1' })

    state = reduceAgentEvent(state, {
      type: 'toolCallFinished',
      id: 'c1',
      result: { status: 'applied' },
      isError: false,
    })
    expect(state.pendingApproval).to.equal(null)
  })

  it('records a budget stop so the panel can offer Continue', function () {
    const state = reduceAgentEvent(emptyAgentState([]), {
      type: 'turnFinished',
      reason: 'budget',
    })
    expect(state.running).to.equal(false)
    expect(state.stoppedForBudget).to.equal(true)
  })

  it('keeps a provider error on the state', function () {
    const state = reduceAgentEvent(emptyAgentState([]), {
      type: 'error',
      code: 'providerAuth',
      message: 'key rejected',
    })
    expect(state.error).to.deep.include({ code: 'providerAuth' })
  })
})

describe('AgentEmptyState', function () {
  it('offers the advanced tool and the four starters', function () {
    render(<AgentEmptyState onPick={sinon.stub()} />)

    expect(screen.getByText(/fix compile errors/i)).to.exist
    expect(screen.getByText(/what can the assistant do/i)).to.exist
    expect(screen.getByText(/insert an equation/i)).to.exist
    expect(screen.getByText(/beamer presentation/i)).to.exist
    expect(screen.getByText(/summarize this file/i)).to.exist
  })

  it('passes the chosen prompt up', function () {
    const onPick = sinon.stub()
    render(<AgentEmptyState onPick={onPick} />)

    fireEvent.click(screen.getByText(/insert an equation/i))
    expect(onPick).to.have.been.calledOnce
    expect(onPick.firstCall.args[0]).to.be.a('string').and.not.be.empty
  })
})

describe('AgentComposer', function () {
  it('sends on Enter and clears the input', function () {
    const onSend = sinon.stub()
    render(<AgentComposer running={false} onSend={onSend} onStop={sinon.stub()} />)

    const input = screen.getByPlaceholderText(/what would you like to do/i)
    fireEvent.change(input, { target: { value: 'add a section' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).to.have.been.calledWith('add a section')
    expect((input as HTMLTextAreaElement).value).to.equal('')
  })

  it('does not send on Shift+Enter', function () {
    const onSend = sinon.stub()
    render(<AgentComposer running={false} onSend={onSend} onStop={sinon.stub()} />)

    const input = screen.getByPlaceholderText(/what would you like to do/i)
    fireEvent.change(input, { target: { value: 'line one' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(onSend).to.have.not.been.called
  })

  it('refuses to send an empty message', function () {
    const onSend = sinon.stub()
    render(<AgentComposer running={false} onSend={onSend} onStop={sinon.stub()} />)

    fireEvent.keyDown(screen.getByPlaceholderText(/what would you like to do/i), {
      key: 'Enter',
    })
    expect(onSend).to.have.not.been.called
  })

  it('shows Stop while a run is active', function () {
    const onStop = sinon.stub()
    render(<AgentComposer running onSend={sinon.stub()} onStop={onStop} />)

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(onStop).to.have.been.calledOnce
  })
})
```

- [x] **Step 2: Run the test and verify it fails**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/components/agent-panel.test.tsx
```

Expected: FAIL — none of the three components exist.

- [x] **Step 3: Write `agent-empty-state.tsx`**

```tsx
import { useTranslation } from 'react-i18next'

const ADVANCED_TOOLS = [
  {
    titleKey: 'ai_assist_tool_fix_compile_errors',
    descriptionKey: 'ai_assist_tool_fix_compile_errors_description',
    prompt:
      'Compile the project, then work through the LaTeX errors one at a time, explaining each fix.',
  },
]

const STARTERS = [
  {
    key: 'ai_assist_starter_what_can_you_do',
    prompt: 'What can you do in this project?',
  },
  {
    key: 'ai_assist_starter_insert_equation',
    prompt: 'Insert an equation at my cursor and explain the syntax.',
  },
  {
    key: 'ai_assist_starter_beamer',
    prompt: 'Create a Beamer presentation summarising this project.',
  },
  {
    key: 'ai_assist_starter_summarize',
    prompt: 'Summarize the file I am currently editing.',
  },
]

export function AgentEmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  const { t } = useTranslation()

  return (
    <div className="ai-assist-empty-state">
      <h5>{t('ai_assist_advanced_tools')}</h5>
      {ADVANCED_TOOLS.map(tool => (
        <button
          key={tool.titleKey}
          type="button"
          className="ai-assist-advanced-tool"
          onClick={() => onPick(tool.prompt)}
        >
          <strong>{t(tool.titleKey)}</strong>
          <span>{t(tool.descriptionKey)}</span>
        </button>
      ))}

      <h5>{t('ai_assist_start_a_chat')}</h5>
      {STARTERS.map(starter => (
        <button
          key={starter.key}
          type="button"
          className="ai-assist-starter"
          onClick={() => onPick(starter.prompt)}
        >
          {t(starter.key)}
        </button>
      ))}
    </div>
  )
}
```

- [x] **Step 4: Write `agent-composer.tsx`**

```tsx
import { KeyboardEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function AgentComposer({
  running,
  onSend,
  onStop,
}: {
  running: boolean
  onSend: (text: string) => void
  onStop: () => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

  const send = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    setValue('')
    onSend(trimmed)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="ai-assist-composer">
      <textarea
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('ai_assist_composer_placeholder')}
      />
      {running ? (
        <button type="button" onClick={onStop}>
          {t('stop')}
        </button>
      ) : (
        <button type="button" onClick={send}>
          {t('send')}
        </button>
      )}
      <p className="ai-assist-disclaimer">{t('ai_assist_disclaimer')}</p>
    </div>
  )
}
```

- [x] **Step 5: Write `agent-panel.tsx`**

Export the state shape and reducer so they can be tested without mounting the panel:

```tsx
export type AgentState = {
  transcript: TranscriptEntry[]
  running: boolean
  stoppedForBudget: boolean
  pendingApproval: { id: string; edit: EditRequest } | null
  error: { code: string; message: string } | null
}

export function emptyAgentState(transcript: TranscriptEntry[]): AgentState {
  return {
    transcript,
    running: false,
    stoppedForBudget: false,
    pendingApproval: null,
    error: null,
  }
}

export function reduceAgentEvent(state: AgentState, event: AgentEvent): AgentState {
  // Assistant turns accumulate in place, so the text and the tool calls from one
  // turn stay together in the rendered transcript.
  switch (event.type) {
    case 'text':
      return { ...state, transcript: appendText(state.transcript, event.text) }
    case 'toolCallStarted':
      return {
        ...state,
        transcript: appendToolCall(state.transcript, {
          id: event.id,
          name: event.name,
          args: event.args,
        }),
      }
    case 'toolCallFinished':
      return {
        ...state,
        pendingApproval:
          state.pendingApproval?.id === event.id ? null : state.pendingApproval,
        transcript: finishToolCall(
          state.transcript,
          event.id,
          event.result,
          event.isError
        ),
      }
    case 'awaitingApproval':
      return { ...state, pendingApproval: { id: event.id, edit: event.edit } }
    case 'turnFinished':
      return {
        ...state,
        running: false,
        stoppedForBudget: event.reason === 'budget',
        pendingApproval: null,
      }
    case 'error':
      return { ...state, error: { code: event.code, message: event.message } }
    default:
      return state
  }
}
```

The three helpers, in the same file. Each returns a new array and opens an
assistant turn when there is not already one at the end — which covers both an
empty transcript and one ending in a user turn:

```ts
function openAssistantTurn(transcript: TranscriptEntry[]): TranscriptEntry[] {
  const last = transcript.at(-1)
  if (last && last.role === 'assistant') return transcript
  return [
    ...transcript,
    { id: `a${transcript.length}`, role: 'assistant', text: '', toolCalls: [] },
  ]
}

function appendText(transcript: TranscriptEntry[], text: string) {
  const opened = openAssistantTurn(transcript)
  const last = opened.at(-1) as Extract<TranscriptEntry, { role: 'assistant' }>
  return [...opened.slice(0, -1), { ...last, text: last.text + text }]
}

function appendToolCall(transcript: TranscriptEntry[], call: ToolCallRecord) {
  const opened = openAssistantTurn(transcript)
  const last = opened.at(-1) as Extract<TranscriptEntry, { role: 'assistant' }>
  return [...opened.slice(0, -1), { ...last, toolCalls: [...last.toolCalls, call] }]
}

function finishToolCall(
  transcript: TranscriptEntry[],
  id: string,
  result: unknown,
  isError: boolean
) {
  return transcript.map(entry => {
    if (entry.role !== 'assistant') return entry
    if (!entry.toolCalls.some(call => call.id === id)) return entry
    return {
      ...entry,
      toolCalls: entry.toolCalls.map(call =>
        call.id === id ? { ...call, result, isError } : call
      ),
    }
  })
}
```

The component:

```tsx
export function AgentPanel() {
  const { t } = useTranslation()
  const { projectId } = useProjectContext()

  const [state, setState] = useState<AgentState>(() =>
    emptyAgentState(loadConversation(projectId))
  )
  const abortRef = useRef<AbortController | null>(null)
  const approvalRef = useRef<
    ((decision: { accepted: boolean; note?: string }) => void) | null
  >(null)

  useEffect(() => {
    saveConversation(projectId, state.transcript)
  }, [projectId, state.transcript])

  // The tool suspends on this promise; EditApprovalCard resolves it.
  const requestApproval = useCallback(
    (_edit: EditRequest) =>
      new Promise<{ accepted: boolean; note?: string }>(resolve => {
        approvalRef.current = resolve
      }),
    []
  )

  const handle = useProjectHandle({ requestApproval })

  const onDecision = useCallback(
    (decision: { accepted: boolean; note?: string }) => {
      approvalRef.current?.(decision)
      approvalRef.current = null
    },
    []
  )

  const start = useCallback(
    async (transcript: TranscriptEntry[]) => {
      const assistant = AiAssistant.fromStoredSettings()
      if (!assistant) {
        setState(current => ({
          ...current,
          error: { code: 'noProvider', message: t('ai_assist_configure_provider') },
        }))
        return
      }

      // Refresh the selection before the system prompt is built.
      window.dispatchEvent(new CustomEvent('aiAssist:agentReadSelection'))

      const controller = new AbortController()
      abortRef.current = controller
      setState(current => ({
        ...current,
        transcript,
        running: true,
        stoppedForBudget: false,
        error: null,
      }))

      for await (const event of runAgent({
        client: assistant.client,
        handle,
        tools: TOOLS,
        transcript,
        signal: controller.signal,
      })) {
        setState(current => reduceAgentEvent(current, event))
      }

      abortRef.current = null
    },
    [handle, t]
  )

  const onSend = useCallback(
    (text: string) => {
      if (!hasConsented()) return setShowConsent(true)
      const next: TranscriptEntry[] = [
        ...state.transcript,
        { id: `u${state.transcript.length}`, role: 'user', text },
      ]
      void start(next)
    },
    [state.transcript, start]
  )

  const onStop = useCallback(() => {
    abortRef.current?.abort()
    approvalRef.current?.({ accepted: false })
    approvalRef.current = null
  }, [])

  const onNewChat = useCallback(() => {
    clearConversation(projectId)
    setState(emptyAgentState([]))
  }, [projectId])

  return (
    <div className="ai-assist-panel">
      <RailPanelHeader
        title={t('ai_assistant')}
        actions={
          <OLIconButton
            icon="edit_square"
            accessibilityLabel={t('ai_assist_new_chat')}
            onClick={onNewChat}
            size="sm"
          />
        }
      />

      <div className="ai-assist-transcript">
        {state.transcript.length === 0 ? (
          <AgentEmptyState onPick={onSend} />
        ) : (
          state.transcript.map(entry => (
            <AgentMessageView
              key={entry.id}
              entry={entry}
              pendingApprovalId={state.pendingApproval?.id ?? null}
              onDecision={onDecision}
            />
          ))
        )}

        {state.error && <div className="ai-assist-error">{state.error.message}</div>}

        {state.stoppedForBudget && (
          <button type="button" onClick={() => void start(state.transcript)}>
            {t('ai_assist_continue')}
          </button>
        )}
      </div>

      <AgentComposer running={state.running} onSend={onSend} onStop={onStop} />
    </div>
  )
}
```

`AiAssistant` currently keeps its provider client private; expose it as a
readonly `client` property (or add a `streamChat` passthrough) so `runAgent` can
take it. `setShowConsent` is local `useState` driving the same consent dialog
sub-project 1 already uses; after the user consents, `recordConsent()` runs and
the pending message is sent.

Add the extra locale keys this component uses: `ai_assist_new_chat` ("New chat"),
`ai_assist_continue` ("Continue"), and `ai_assist_configure_provider`
("Configure an AI provider in Account Settings to use the assistant.").

Add the remaining locale keys used above — `ai_assist_advanced_tools` ("Advanced tools"), `ai_assist_start_a_chat` ("Start a chat"), `ai_assist_composer_placeholder` ("What would you like to do?"), `ai_assist_disclaimer` ("AI can make mistakes. Always check responses."), `ai_assist_tool_fix_compile_errors` ("Fix compile errors"), `ai_assist_tool_fix_compile_errors_description` ("Compile the project and work through the LaTeX errors."), `ai_assist_starter_what_can_you_do` ("What can the assistant do for me?"), `ai_assist_starter_insert_equation` ("Insert an equation"), `ai_assist_starter_beamer` ("Create a Beamer presentation"), `ai_assist_starter_summarize` ("Summarize this file") — and the corresponding classes to `frontend/stylesheets/components/ai-assist.scss`.

- [x] **Step 6: Run the tests and verify they pass**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/components/agent frontend/stylesheets/components/ai-assist.scss locales/en.json modules/ai-assist/test/frontend/js/agent/components/agent-panel.test.tsx
git commit -m "feat(ai-assist): add the agent panel, composer and empty state"
```

---

### Task 12: Rail wiring and the default-off guarantee

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/rail-entry.tsx`
- Modify: `config/settings.defaults.js:1174`
- Modify: `frontend/js/features/ide-react/context/rail-context.tsx:20-27`
- Modify: `locales/en.json`
- Test: `modules/ai-assist/test/frontend/js/agent/rail-entry.test.tsx`
- Test: `modules/ai-assist/test/unit/src/CoreWiring.test.mjs` (extend the existing file)

**Interfaces:**
- Consumes: `AgentPanel` from Task 11.
- Produces: the module's `railEntries` default export. Nothing in this plan consumes it.

- [x] **Step 1: Write the failing tests**

Create `modules/ai-assist/test/frontend/js/agent/rail-entry.test.tsx`:

```tsx
import { expect } from 'chai'
import railEntry from '../../../../frontend/js/features/ai-assist/rail-entry'

describe('ai-assist rail entry', function () {
  afterEach(function () {
    delete (window as any).metaAttributesCache
  })

  function setMeta(enabled: boolean) {
    ;(window as any).metaAttributesCache = new Map([
      ['ol-aiAssistEnabled', enabled],
    ])
  }

  it('uses a stable key and an icon', function () {
    expect(railEntry.key).to.equal('ai-assist')
    expect(railEntry.icon).to.equal('auto_awesome')
  })

  it('is hidden when the module is disabled', function () {
    setMeta(false)
    const hide =
      typeof railEntry.hide === 'function' ? railEntry.hide() : railEntry.hide
    expect(hide).to.equal(true)
  })

  it('is shown when the module is enabled', function () {
    setMeta(true)
    const hide =
      typeof railEntry.hide === 'function' ? railEntry.hide() : railEntry.hide
    expect(hide).to.equal(false)
  })
})
```

Add to the existing `modules/ai-assist/test/unit/src/CoreWiring.test.mjs`, matching the import style already at the top of that file for `fs`, `path`, and the resolved `services/web` root:

```js
it('registers the rail entry in the railEntries slot', function () {
  const source = fs.readFileSync(
    path.join(WEB_ROOT, 'config/settings.defaults.js'),
    'utf8'
  )
  expect(source).to.match(
    /ai-assist\/frontend\/js\/features\/ai-assist\/rail-entry/
  )
})

it('adds ai-assist to the RailTabKey union', function () {
  const source = fs.readFileSync(
    path.join(WEB_ROOT, 'frontend/js/features/ide-react/context/rail-context.tsx'),
    'utf8'
  )
  expect(source).to.match(/\|\s*'ai-assist'/)
})
```

If `CoreWiring.test.mjs` does not already define `WEB_ROOT`, add it as the resolved `services/web` directory.

- [x] **Step 2: Run both tests and verify they fail**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/rail-entry.test.tsx
XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/CoreWiring.test.mjs
```

Expected: FAIL — `rail-entry` does not exist and the slot is empty.

- [x] **Step 3: Write `rail-entry.tsx`**

```tsx
import { AgentPanel } from './components/agent/agent-panel'
import getMeta from '@/utils/meta'
import { t } from 'i18next'

/**
 * The module's contribution to the editor rail.
 *
 * `hide` is a function so the flag is read at render time rather than at module
 * evaluation, which keeps the disabled instance identical to upstream CE even
 * though webpack still bundles this file.
 */
export default {
  key: 'ai-assist',
  icon: 'auto_awesome',
  title: t('ai_assistant'),
  component: <AgentPanel />,
  hide: () => !getMeta('ol-aiAssistEnabled'),
}
```

- [x] **Step 4: Wire the two core files**

In `config/settings.defaults.js`, replace `railEntries: [],` with:

```js
railEntries: [
  {
    path: 'ai-assist/frontend/js/features/ai-assist/rail-entry.tsx',
  },
],
```

Match the exact object shape used by the neighbouring populated slots in the same block, such as `pdfLogEntryHeaderActionComponents`.

In `frontend/js/features/ide-react/context/rail-context.tsx`, add `| 'ai-assist'` to the `RailTabKey` union.

Add `"ai_assistant": "AI assistant"` to `locales/en.json`, and use `t('ai_assistant')` for the panel header too.

- [x] **Step 5: Run the whole module suite and verify it passes**

```
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js
XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
```

Expected: PASS.

- [x] **Step 6: Verify the types compile**

```
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: no errors in `modules/ai-assist`.

- [x] **Step 7: Commit**

```bash
git add modules/ai-assist/frontend/js/features/ai-assist/rail-entry.tsx config/settings.defaults.js frontend/js/features/ide-react/context/rail-context.tsx locales/en.json modules/ai-assist/test
git commit -m "feat(ai-assist): add the AI assistant rail tab"
```

---

## Deferred from the spec

The spec's **capability degradation** (falling back to tool-free chat when a provider or model rejects `tools`) and the composer's **`@path` attach control** are both refinements of surfaces this plan builds, and neither blocks the feature working end to end with OpenAI or Anthropic. Implement them as a follow-up once the twelve tasks are green:

- Degradation: catch a 400 naming tools on the first request in `run-agent.ts`, retry once without `tools`, cache the result per model id, and surface a one-line notice through a new `AgentEvent` variant.
- Attach: a file picker in `AgentComposer` that inserts `@path` mentions, resolved through `handle.readFile` and appended to the user message on send.

## Manual verification

After Task 12, bring up the dev server with `AI_ASSIST_ENABLED=true`, configure a provider in Account Settings, open a project, and confirm:

1. The AI assistant tab appears at the bottom of the rail; the empty state shows "Advanced tools" and the four starters.
2. Asking "what files are in this project?" produces a `list_files` card and a correct answer.
3. Asking for a change to a `.tex` file produces a diff card; Accept applies it as one undo step and Reject sends the refusal back to the model.
4. "Fix compile errors" on a project with a deliberate error compiles, reports the error, proposes a fix, and recompiles clean after acceptance.
5. Reloading the page restores the conversation; "new chat" clears it.
6. With `AI_ASSIST_ENABLED` unset, the rail tab is gone and the editor is unchanged.
