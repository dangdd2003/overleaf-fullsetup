# AI Assist LLM Harness WS-A: Provider Requests Implementation Plan

> **For agentic workers:** Implement task by task, in order. Steps use checkbox (`- [ ]`) syntax; tick each step when done. Every piece of code you need is in this file. Do not redesign anything. If a quoted "current code" block does not match the file, re-read the file and apply the change to the equivalent code.

**Goal:** Make every LLM request cheaper and more reliable: Anthropic prompt caching that actually hits, OpenAI requests that official reasoning models accept and that use OpenAI's cache routing, Ollama requests that use the real context window and work with models that cannot "think", and a signal from every provider when a reply was cut off at the output token limit.

**Architecture:** All provider wire-format code lives in one server file, `modules/ai-assist/app/src/AiAssistProviders.mjs`. Both agent loops call it: the main chat runs on the server (`AiAssistRunManager.mjs`), and the one-click fix runs in the browser and streams through the chat proxy (`AiAssistProviderController.mjs` → `providers/server-client.ts`). This plan changes only the provider layer, the proxy, and the shared TypeScript types. It does **not** change either agent loop. WS-C consumes what this plan produces.

**Tech Stack:** Node.js ES modules (`.mjs`), TypeScript types, Vitest + Chai + Sinon.

**Order:** WS-A and WS-B can run in parallel (they touch different files). WS-C must run after WS-A.

---

## Global Constraints

- **Never run `git commit`, `git push`, `git stash`, `git checkout -- <file>`, `git restore`, or any history-altering git command.** Leave all changes uncommitted. `git checkout`/`git restore` would also wipe other uncommitted work in these files.
- **Another session may edit this worktree.** Line numbers were verified on 2026-09-17. If a quoted block does not match, find the equivalent code. Never overwrite unrelated edits.
- **Files this plan owns (edit only these):**
  - `modules/ai-assist/app/src/AiAssistProviders.mjs`
  - `modules/ai-assist/app/src/AiAssistProviderController.mjs`
  - `modules/ai-assist/frontend/js/features/ai-assist/providers/types.ts`
  - `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`
  - `modules/ai-assist/test/unit/src/AiAssistProviderController.test.mjs`
- **Do not fix model behaviour by adding instructions to system prompts.** Fix tools and the harness.
- **Working directory for all commands:**
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Backend test runner** (`XDG_DATA_HOME` is required, the sandbox makes `~/.local/share` read-only):
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path> 2>&1 | grep -E "Test Files|Tests |FAIL|×|AssertionError" | head -40
  ```
- **Frontend test runner:**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' --reporter dot modules/ai-assist/test/frontend 2>&1 | grep -E "passing|failing"
  ```
- **Baseline (measured 2026-09-17 on this worktree):** backend `modules/ai-assist/test/unit/src` → **18 files, 212 tests passed**. Frontend `modules/ai-assist/test/frontend` → **858 passing, 0 failing**. Re-run both before Task 1 and write the numbers down. Another session may have changed them.
- `node_modules` in this worktree are symlinks to the main checkout. Do not delete them during this plan.
- **Keep output small.** Always pipe test output through `grep`.
- **Style:** 2-space indentation, single quotes, no semicolons, trailing commas in multi-line literals, matching the file.

---

## Background (verified findings this plan fixes)

1. **Anthropic message cache breakpoint lands on the wrong message or is dropped.** `AnthropicServerClient.streamChat` (`AiAssistProviders.mjs:516`) builds `wire` from agent messages. Consecutive `tool` messages are **merged** into one `user` message (`:541-551`). Then it marks `wire[cacheHints.lastStableMessage]` (`:583-605`), but `lastStableMessage` is computed by the callers on the **agent** message list (`AiAssistRunManager.mjs:448`, `build-request.ts`: `messages.length - 2`). After any turn with 2+ tool calls the index points at the wrong wire message, or past the end (`stable < wire.length` fails) and **no message breakpoint is sent at all**, so the whole history is billed uncached on every step. Example: agent `[user, assistant(2 calls), tool, tool]` → `lastStableMessage = 2`; wire is `[user, assistant, user(2 tool_results)]` → marks the assistant, not the newest message.
   Also, marking only "second to last" means the newest message is never written to cache in the request that introduces it.
2. **OpenAI:** `OpenAiServerClient.streamChat` (`:798`) ignores `cacheHints` entirely (no `prompt_cache_key`), always sends `max_tokens` (`:827`), which OpenAI's reasoning models (o-series, GPT-5) reject with "Unsupported parameter: 'max_tokens' … use 'max_completion_tokens'", and requests `stream_options: { include_usage: true }` (`:829`) whose usage chunk is never read (the loop breaks on `finish_reason`, `:915-917`, before the usage chunk arrives).
3. **Ollama:** `OllamaServerClient.streamChat` (`:1230`) never sets `options.num_ctx`, so Ollama runs with its small default context and **silently truncates** the prompt (system prompt + 15 tool schemas are several thousand tokens), while the harness budgets for the configured window (default 256000). It always sends `think: true` (`:1250`); Ollama answers HTTP 400 `"<model>" does not support thinking` for models without thinking support, so those models cannot be used at all.
4. **No provider reports a reply cut off at the output limit.** Anthropic `message_delta.delta.stop_reason === 'max_tokens'`, OpenAI `finish_reason === 'length'`, Gemini `finishReason === 'MAX_TOKENS'`, Ollama `done_reason === 'length'` are all ignored.
5. **`safeParseToolArgs` (`:376-398`) silently "repairs" truncated JSON** by appending `"}` etc. A cut-off `edit_file` `newText` becomes a valid, shorter `newText` that looks legitimate. The harness cannot tell a repaired call from a complete one.

### Decisions (do not revisit)

- Provider streams yield a new chunk `{ type: 'stop', reason: 'max_tokens' }` **only** when the output limit was hit, as the **last** chunk of the stream. Nothing is yielded for normal stops. Reason: existing tests assert exact chunk counts for normal streams (`AiAssistProviders.test.mjs:676-766`), and the proxy forwards every chunk to the browser.
- `safeParseToolArgs` keeps repairing, but marks the result `_repaired: true`. WS-C decides what to do with it.
- `max_completion_tokens` and `prompt_cache_key` are sent **only** when the base URL hostname is exactly `api.openai.com`. OpenAI-compatible gateways and local servers keep `max_tokens` and get no unknown fields.
- `prompt_cache_key` is a SHA-256 hash (first 32 hex chars) of the cache key, so the raw project id is not sent to OpenAI.
- Ollama `num_ctx` = the resolved context window the harness already budgets for (`contextWindow` request field). Default limits stay as they are (`ollama: 256000/65536`, pinned by `test/frontend/js/limits.test.ts:19-27`). Ollama caps `num_ctx` at the model's trained length. Users with small GPUs lower "Context window" in the provider settings. **Do not change `DEFAULT_LIMITS`.**
- Ollama `think` fallback is remembered per `baseURL|model` in a module-level `Set`, so only the first request to such a model pays for the failed attempt.
- Anthropic: breakpoints are system (1) + last tool (1) + at most two message breakpoints = at most 4, which is the API maximum. `cacheHints.lastStableMessage` is kept in the type for compatibility but **ignored** by the Anthropic client.

---

## Interfaces this plan produces (WS-C relies on them exactly)

- `client.streamChat({ ..., contextWindow })`: new optional numeric field. Used only by Ollama.
- Stream chunk `{ type: 'stop', reason: 'max_tokens' }`: yielded last, only when output was cut off.
- `safeParseToolArgs(raw)`: a repaired object now includes `_repaired: true`. Valid JSON has no marker. Unparseable input still returns `{ _parseError: true, _raw }`.
- TS `ChatChunk` gains `| { type: 'stop'; reason: 'max_tokens' }`. TS `ChatRequest` gains `contextWindow?: number`. TS `ProviderErrorCode` gains `| 'outputTruncated'`.
- `AiAssistProviderController.chat` forwards `request.contextWindow` to `streamChat`.

---

## File Structure

| File | Change |
|---|---|
| `modules/ai-assist/app/src/AiAssistProviders.mjs` | new exports `markMessageCacheBreakpoints`, `isOfficialOpenAiUrl`, `promptCacheKey`; Anthropic/OpenAI/Gemini/Ollama `streamChat` changes; `safeParseToolArgs` marker |
| `modules/ai-assist/app/src/AiAssistProviderController.mjs` | forward `contextWindow` |
| `modules/ai-assist/frontend/js/features/ai-assist/providers/types.ts` | `ChatChunk`, `ChatRequest`, `ProviderErrorCode` additions |
| `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs` | update 1 test, add tests |
| `modules/ai-assist/test/unit/src/AiAssistProviderController.test.mjs` | add 1 test |

---

### Task 1: Anthropic cache breakpoints computed on the wire messages

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistProviders.mjs` (insert before `class AnthropicServerClient {` at line 484; replace lines 583-605)
- Modify: `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs` (lines 1-10 imports; lines 229-233; add a `describe`)

- [x] **Step 1: Update the existing cache test to the new contract**

In `AiAssistProviders.test.mjs`, test `'attaches prompt cache control breakpoints when cacheHints are provided'` (starts line 182). Replace exactly:
```js
      // 3. Last stable message cached
      expect(sentPayload.messages[1].content).to.deep.equal([
        { type: 'text', text: 'Reply 1', cache_control: { type: 'ephemeral' } },
      ])
      expect(sentPayload.messages[2].content).to.equal('Turn 2')
```
with:
```js
      // 3. The newest message, and the message before the newest assistant
      //    turn (the previous request's breakpoint)
      expect(sentPayload.messages[2].content).to.deep.equal([
        { type: 'text', text: 'Turn 2', cache_control: { type: 'ephemeral' } },
      ])
      expect(sentPayload.messages[1].content).to.equal('Reply 1')
      expect(sentPayload.messages[0].content).to.deep.equal([
        { type: 'text', text: 'Turn 1', cache_control: { type: 'ephemeral' } },
      ])
```

- [x] **Step 2: Add the new import and tests**

Look at the import block at the top of `AiAssistProviders.test.mjs` (lines 1-10; it imports `safeParseToolArgs` among others from `'../../../app/src/AiAssistProviders.mjs'`). Add `markMessageCacheBreakpoints,` to that import list.

Then, directly after the closing `})` of `describe('Anthropic Provider Client', ...)` (the line after the cache test ends, currently line 235), add:
```js
  describe('markMessageCacheBreakpoints', function () {
    const ephemeral = { type: 'ephemeral' }

    it('marks the merged tool-result message, not an index counted before merging', function () {
      const wire = [
        { role: 'user', content: 'fix it' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
            { type: 'tool_use', id: 't2', name: 'read_file', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'a' },
            { type: 'tool_result', tool_use_id: 't2', content: 'b' },
          ],
        },
      ]

      markMessageCacheBreakpoints(wire)

      expect(wire[2].content[1].cache_control).to.deep.equal(ephemeral)
      expect(wire[2].content[0].cache_control).to.equal(undefined)
      expect(wire[1].content.some(block => block.cache_control)).to.equal(false)
      expect(wire[0].content).to.deep.equal([
        { type: 'text', text: 'fix it', cache_control: ephemeral },
      ])
    })

    it('marks only the newest message when there is no assistant turn', function () {
      const wire = [{ role: 'user', content: 'hello' }]
      markMessageCacheBreakpoints(wire)
      expect(wire[0].content).to.deep.equal([
        { type: 'text', text: 'hello', cache_control: ephemeral },
      ])
    })

    it('never marks more than two messages', function () {
      const wire = []
      for (let i = 0; i < 6; i++) {
        wire.push({ role: 'user', content: `q${i}` })
        wire.push({ role: 'assistant', content: `a${i}` })
      }
      wire.push({ role: 'user', content: 'latest' })

      markMessageCacheBreakpoints(wire)

      const marked = wire.filter(
        message => Array.isArray(message.content) && message.content.some(block => block.cache_control)
      )
      expect(marked).to.have.length(2)
      expect(wire.at(-1).content[0].cache_control).to.deep.equal(ephemeral)
      expect(wire.at(-3).content[0].cache_control).to.deep.equal(ephemeral)
    })

    it('sends at most four cache breakpoints for a multi-call tool turn', async function () {
      let sentPayload = null
      const fakeFetch = sinon.stub().callsFake((_url, opts) => {
        sentPayload = JSON.parse(opts.body)
        return Promise.resolve({
          ok: true,
          status: 200,
          body: (async function* () {
            yield new TextEncoder().encode('data: {"type":"message_stop"}\n\n')
          })(),
        })
      })
      const client = createProviderClient({ type: 'anthropic', apiKey: 'k', model: 'claude-opus-5', fetchFn: fakeFetch })

      for await (const _ of client.streamChat({
        system: 'sys',
        messages: [
          { role: 'user', content: 'fix it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't1', name: 'read_file', args: { path: 'a.tex' } },
              { id: 't2', name: 'read_file', args: { path: 'b.tex' } },
            ],
          },
          { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'a' },
          { role: 'tool', toolCallId: 't2', name: 'read_file', content: 'b' },
        ],
        tools: [{ name: 'read_file', description: 'r', parameters: {} }],
        cacheHints: { cacheSystem: true, cacheTools: true, lastStableMessage: 2 },
      })) {}

      expect(sentPayload.messages).to.have.length(3)
      expect(sentPayload.messages[2].content.at(-1).cache_control).to.deep.equal(ephemeral)
      const count = JSON.stringify(sentPayload).split('"cache_control"').length - 1
      expect(count).to.be.at.most(4)
    })
  })
```

- [x] **Step 3: Run the tests to verify they fail**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs 2>&1 | grep -E "Tests |×|FAIL" | head -20
```
Expected: the updated cache test and the `markMessageCacheBreakpoints` tests fail (`markMessageCacheBreakpoints is not a function` or assertion errors).

- [x] **Step 4: Add the helper**

In `AiAssistProviders.mjs`, insert immediately before the line `class AnthropicServerClient {` (line 484):
```js
/**
 * Marks up to two message cache breakpoints on Anthropic wire messages.
 *
 * Positions come from `wire`, not from the agent message list: consecutive
 * tool results are merged into one user message on the wire, so an index
 * counted on the agent messages points at the wrong message (or past the end)
 * whenever a turn made more than one tool call.
 *
 * - The newest message: the whole request is written to the cache, and the
 *   next step, which only appends to it, reads it back.
 * - The message before the newest assistant turn: where the previous request
 *   put its breakpoint. Anthropic looks back at most 20 content blocks for an
 *   earlier cache entry, and one turn with many tool calls adds more blocks
 *   than that.
 *
 * Together with the system and tools breakpoints this stays within the API's
 * limit of four.
 */
export function markMessageCacheBreakpoints(wire) {
  const ephemeral = { type: 'ephemeral' }
  const mark = index => {
    const entry = wire[index]
    if (!entry) return
    if (typeof entry.content === 'string') {
      entry.content = [{ type: 'text', text: entry.content, cache_control: ephemeral }]
    } else if (Array.isArray(entry.content) && entry.content.length > 0) {
      const last = entry.content.length - 1
      entry.content[last] = { ...entry.content[last], cache_control: ephemeral }
    }
  }

  const newest = wire.length - 1
  if (newest < 0) return
  mark(newest)

  let lastAssistant = -1
  for (let index = newest; index >= 0; index--) {
    if (wire[index].role === 'assistant') {
      lastAssistant = index
      break
    }
  }
  const previous = lastAssistant - 1
  if (previous >= 0 && previous !== newest) mark(previous)
}

```

- [x] **Step 5: Use the helper in `AnthropicServerClient.streamChat`**

Replace exactly (currently lines 583-605):
```js
    const stable = cacheHints?.lastStableMessage
    if (
      typeof stable === 'number' &&
      stable >= 0 &&
      stable < wire.length
    ) {
      const entry = wire[stable]
      if (Array.isArray(entry.content) && entry.content.length > 0) {
        const lastBlock = entry.content[entry.content.length - 1]
        entry.content[entry.content.length - 1] = {
          ...lastBlock,
          cache_control: ephemeral,
        }
      } else if (typeof entry.content === 'string') {
        entry.content = [
          {
            type: 'text',
            text: entry.content,
            cache_control: ephemeral,
          },
        ]
      }
    }
```
with:
```js
    // `cacheHints.lastStableMessage` is an index into the agent messages and
    // is not valid on `wire`; the breakpoints are placed on `wire` directly.
    if (cacheHints) {
      markMessageCacheBreakpoints(wire)
    }
```
Leave `const ephemeral = { type: 'ephemeral' }` (line 522) in place: the system and tools breakpoints still use it.

- [x] **Step 6: Run the tests to verify they pass**

Same command as Step 3. Expected: all tests in the file pass.

---

### Task 2: Every provider reports a reply cut off at the output limit; repaired arguments are marked

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistProviders.mjs` (`safeParseToolArgs` lines 376-398; Anthropic 676-751; OpenAI 869-938; Gemini 1132-1195; Ollama 1287-1357)
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/types.ts` (lines 73-77, 88-95, 146-154)
- Modify: `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`

- [x] **Step 1: Write the failing tests**

In `AiAssistProviders.test.mjs`, inside `describe('safeParseToolArgs', ...)` (starts line 768), replace the test `'repairs common truncated JSON strings'`:
```js
    it('repairs common truncated JSON strings', function () {
      const repaired = safeParseToolArgs('{"path":"main.tex","newText":"hello')
      expect(repaired.path).to.equal('main.tex')
      expect(repaired.newText).to.equal('hello')
    })
```
with:
```js
    it('repairs common truncated JSON strings and marks them repaired', function () {
      const repaired = safeParseToolArgs('{"path":"main.tex","newText":"hello')
      expect(repaired.path).to.equal('main.tex')
      expect(repaired.newText).to.equal('hello')
      expect(repaired._repaired).to.equal(true)
    })

    it('does not mark complete JSON as repaired', function () {
      expect(safeParseToolArgs('{"path":"main.tex"}')).to.not.have.property('_repaired')
    })
```

Then add this new `describe` block at the end of the top-level `describe('AiAssistProviders', ...)` (just before its final `})`):
```js
  describe('output limit signal', function () {
    const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const streamOf = text => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(text)
      })(),
    })
    const collect = async client => {
      const chunks = []
      for await (const chunk of client.streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 })) {
        chunks.push(chunk)
      }
      return chunks
    }

    it('Anthropic: yields stop after a tool call cut off at max_tokens', async function () {
      const body = sse([
        { type: 'message_start', message: { id: 'm1' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'edit_file' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"main.tex","newText":"abc' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        { type: 'message_stop' },
      ])
      const client = createProviderClient({ type: 'anthropic', apiKey: 'k', model: 'claude-opus-5', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({ type: 'stop', reason: 'max_tokens' })
      const call = chunks.find(chunk => chunk.type === 'tool_call')
      expect(call.args).to.deep.equal({ path: 'main.tex', newText: 'abc', _repaired: true })
    })

    it('Anthropic: yields no stop chunk for a normal end_turn', async function () {
      const body = sse([
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
      const client = createProviderClient({ type: 'anthropic', apiKey: 'k', model: 'claude-opus-5', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.some(chunk => chunk.type === 'stop')).to.equal(false)
    })

    it('OpenAI: yields stop when finish_reason is length', async function () {
      const body = sse([
        { choices: [{ delta: { content: 'partial' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ])
      const client = createProviderClient({ type: 'openai', apiKey: 'k', model: 'gpt-4o', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({ type: 'stop', reason: 'max_tokens' })
    })

    it('Gemini: yields stop when finishReason is MAX_TOKENS', async function () {
      const body = sse([
        { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] },
      ])
      const client = createProviderClient({ type: 'google', apiKey: 'k', model: 'gemini-2.0-flash', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({ type: 'stop', reason: 'max_tokens' })
    })

    it('Ollama: yields stop when done_reason is length', async function () {
      const body = [
        JSON.stringify({ message: { content: 'partial' } }),
        JSON.stringify({ message: { content: '' }, done: true, done_reason: 'length' }),
      ].join('\n') + '\n'
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', fetchFn: sinon.stub().resolves(streamOf(body)) })

      const chunks = await collect(client)

      expect(chunks.at(-1)).to.deep.equal({ type: 'stop', reason: 'max_tokens' })
    })
  })
```

- [x] **Step 2: Run to verify they fail**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs 2>&1 | grep -E "Tests |×|FAIL" | head -20
```
Expected: the 5 "stop" tests (except "yields no stop chunk for a normal end_turn", which already passes) and the repair-marker test fail.

- [x] **Step 3: Mark repaired arguments**

In `safeParseToolArgs`, replace exactly:
```js
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate)
      } catch {}
    }
```
with:
```js
    for (const candidate of candidates) {
      try {
        // Marked so the agent loop can refuse to act on a call whose
        // arguments were cut off: a repaired newText parses, but it is short.
        return { ...JSON.parse(candidate), _repaired: true }
      } catch {}
    }
```

- [x] **Step 4: Anthropic**

In `AnthropicServerClient.streamChat`:

(a) Replace `    let activeTool = null` (line 676, the only occurrence inside this class) with:
```js
    let activeTool = null
    let truncated = false
```

(b) Replace exactly:
```js
        } else if (parsed.type === 'message_stop') {
          if (activeTool) {
```
with:
```js
        } else if (parsed.type === 'message_delta') {
          if (parsed.delta?.stop_reason === 'max_tokens') truncated = true
        } else if (parsed.type === 'message_stop') {
          if (activeTool) {
```

(c) At the end of the method, the current code is:
```js
    if (activeTool) {
      const args = safeParseToolArgs(activeTool.rawArgs)
      yield {
        type: 'tool_call',
        id: activeTool.id,
        name: activeTool.name,
        args,
      }
    }
  }
}

export class OpenAiServerClient {
```
Replace it with:
```js
    if (activeTool) {
      const args = safeParseToolArgs(activeTool.rawArgs)
      yield {
        type: 'tool_call',
        id: activeTool.id,
        name: activeTool.name,
        args,
      }
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

export class OpenAiServerClient {
```

- [x] **Step 5: OpenAI**

In `OpenAiServerClient.streamChat`:

(a) Replace exactly:
```js
    const pendingToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()

    try {
      timeouts.resetIdleTimer()
      for await (const data of parseSseLines(res.body, () => timeouts.resetIdleTimer())) {
```
with:
```js
    const pendingToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()
    let truncated = false

    try {
      timeouts.resetIdleTimer()
      for await (const data of parseSseLines(res.body, () => timeouts.resetIdleTimer())) {
```
TRAP: Ollama also has `const pendingToolCalls = new Map()` followed by `const thinkParser`, but it uses `parseNdjsonLines`, not `parseSseLines`. Include the `parseSseLines` line in your match so you edit the OpenAI class.

(b) Replace exactly:
```js
        if (choice?.finish_reason) {
          break
        }
```
with:
```js
        if (choice?.finish_reason) {
          if (choice.finish_reason === 'length') truncated = true
          break
        }
```

(c) Replace exactly:
```js
    for (const tool of pendingToolCalls.values()) {
      const args = safeParseToolArgs(tool.rawArgs)
      yield {
        type: 'tool_call',
        id: tool.id,
        name: tool.name,
        args,
      }
    }
  }
}
```
with:
```js
    for (const tool of pendingToolCalls.values()) {
      const args = safeParseToolArgs(tool.rawArgs)
      yield {
        type: 'tool_call',
        id: tool.id,
        name: tool.name,
        args,
      }
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}
```

- [x] **Step 6: Gemini**

In `GoogleServerClient.streamChat`:

(a) Replace `    let toolCallIndex = 0` with:
```js
    let toolCallIndex = 0
    let truncated = false
```

(b) Replace exactly:
```js
        if (candidate?.finishReason) {
          break
        }
```
with:
```js
        if (candidate?.finishReason) {
          if (candidate.finishReason === 'MAX_TOKENS') truncated = true
          break
        }
```

(c) Replace exactly:
```js
    for (const item of thinkParser.flush()) {
      yield item
    }
  }
}

export class OllamaServerClient {
```
with:
```js
    for (const item of thinkParser.flush()) {
      yield item
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}

export class OllamaServerClient {
```

- [x] **Step 7: Ollama**

In `OllamaServerClient.streamChat`:

(a) Replace exactly:
```js
    const pendingToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()

    try {
      timeouts.resetIdleTimer()
      for await (const chunk of parseNdjsonLines(res.body, () => timeouts.resetIdleTimer())) {
```
with:
```js
    const pendingToolCalls = new Map()
    const thinkParser = new StreamingThinkParser()
    let truncated = false

    try {
      timeouts.resetIdleTimer()
      for await (const chunk of parseNdjsonLines(res.body, () => timeouts.resetIdleTimer())) {
```

(b) Replace exactly:
```js
        if (parsed.done) {
          break
        }
```
with:
```js
        if (parsed.done) {
          if (parsed.done_reason === 'length') truncated = true
          break
        }
```

(c) Replace exactly:
```js
        args: typeof tool.args === 'string' ? safeParseToolArgs(tool.args) : tool.args,
      }
    }
  }
}
```
with:
```js
        args: typeof tool.args === 'string' ? safeParseToolArgs(tool.args) : tool.args,
      }
    }

    if (truncated) yield { type: 'stop', reason: 'max_tokens' }
  }
}
```

- [x] **Step 8: TypeScript types**

In `frontend/js/features/ai-assist/providers/types.ts`:

(a) Replace exactly:
```ts
export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; stopReason?: 'stop' | 'tool_calls' | 'length' }
```
with:
```ts
export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; stopReason?: 'stop' | 'tool_calls' | 'length' }
  /**
   * The reply hit the output token limit. Sent last, and only then. The last
   * tool call of the reply, if any, has incomplete arguments.
   */
  | { type: 'stop'; reason: 'max_tokens' }
```

(b) In `export type ChatRequest = {`, replace:
```ts
  maxTokens: number
```
with:
```ts
  maxTokens: number
  /**
   * The context window the caller budgets for. Ollama needs it as num_ctx,
   * otherwise it runs with a small default and silently truncates the prompt.
   */
  contextWindow?: number
```
TRAP: `maxTokens: number` must be replaced only inside `ChatRequest` (line 91). Check there is no other `  maxTokens: number` line in the file first (`grep -n "maxTokens: number" <file>`); if there is, include the neighbouring `messages: AgentMessage[]` line in your match.

(c) Replace exactly:
```ts
  | 'consecutiveToolFailures'
```
with:
```ts
  | 'consecutiveToolFailures'
  | 'outputTruncated'
```

- [x] **Step 9: Run the tests to verify they pass**

Same command as Step 2. Expected: all pass, including the pre-existing `'exits OpenAI stream …'`, `'exits Anthropic stream …'`, `'exits Ollama stream …'` tests, whose exact chunk counts must not change.

---

### Task 3: OpenAI requests that reasoning models accept, with cache routing

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistProviders.mjs` (imports line 1-3; before `export class OpenAiServerClient {`; `streamChat` lines 798-830)
- Modify: `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`

- [x] **Step 1: Write the failing tests**

Add `isOfficialOpenAiUrl,` and `promptCacheKey,` to the import list from `'../../../app/src/AiAssistProviders.mjs'` at the top of the test file. Then add this block at the end of the top-level `describe` (before its final `})`):
```js
  describe('OpenAI request parameters', function () {
    const okStream = () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n')
      })(),
    })
    const send = async settings => {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({ type: 'openai', apiKey: 'k', model: 'gpt-5', fetchFn, ...settings })
      for await (const _ of client.streamChat({
        system: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1000,
        cacheHints: { cacheSystem: true, cacheTools: true, lastStableMessage: null, cacheKey: 'project-1' },
      })) {}
      return body
    }

    it('recognises only api.openai.com as the official API', function () {
      expect(isOfficialOpenAiUrl('https://api.openai.com')).to.equal(true)
      expect(isOfficialOpenAiUrl('https://api.openai.com/v1')).to.equal(true)
      expect(isOfficialOpenAiUrl('https://openrouter.ai/api/v1')).to.equal(false)
      expect(isOfficialOpenAiUrl('not a url')).to.equal(false)
    })

    it('hashes the cache key to 32 hex characters', function () {
      expect(promptCacheKey('project-1')).to.match(/^[0-9a-f]{32}$/)
      expect(promptCacheKey('project-1')).to.equal(promptCacheKey('project-1'))
      expect(promptCacheKey('project-1')).to.not.equal(promptCacheKey('project-2'))
    })

    it('sends max_completion_tokens and prompt_cache_key to api.openai.com', async function () {
      const body = await send({})
      expect(body.max_completion_tokens).to.equal(1000)
      expect(body).to.not.have.property('max_tokens')
      expect(body.prompt_cache_key).to.equal(promptCacheKey('project-1'))
      expect(body).to.not.have.property('stream_options')
    })

    it('keeps max_tokens and sends no OpenAI-only fields to compatible gateways', async function () {
      const body = await send({ baseUrl: 'https://openrouter.ai/api/v1' })
      expect(body.max_tokens).to.equal(1000)
      expect(body).to.not.have.property('max_completion_tokens')
      expect(body).to.not.have.property('prompt_cache_key')
    })
  })
```

- [x] **Step 2: Run to verify they fail**

Same command as Task 2 Step 2. Expected: the 4 new tests fail (`isOfficialOpenAiUrl is not a function`, etc.).

- [x] **Step 3: Add the import**

At the top of `AiAssistProviders.mjs`, replace:
```js
import fs from 'node:fs'
```
with:
```js
import crypto from 'node:crypto'
import fs from 'node:fs'
```

- [x] **Step 4: Add the helpers**

Insert immediately before `export class OpenAiServerClient {`:
```js
/**
 * OpenAI-only request fields go only to OpenAI's own API. Compatible gateways
 * and local servers reject or mishandle fields they do not know.
 */
export function isOfficialOpenAiUrl(url) {
  try {
    return new URL(url).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

/** Groups requests for OpenAI's cache routing without sending the raw key. */
export function promptCacheKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32)
}

```

- [x] **Step 5: Change the OpenAI request**

(a) In `OpenAiServerClient.streamChat`, replace the signature line:
```js
  async *streamChat({ system, messages, maxTokens = 8192, tools = [], signal }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })
    const formattedMessages = [
```
with:
```js
  async *streamChat({ system, messages, maxTokens = 8192, tools = [], cacheHints, signal }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })
    const formattedMessages = [
```
(Include `const formattedMessages = [` in the match: Gemini and Ollama have the same first line.)

(b) Replace exactly:
```js
    const payload = {
      model: this.model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }
```
with:
```js
    const official = isOfficialOpenAiUrl(this.baseURL)
    const payload = {
      model: this.model,
      messages: formattedMessages,
      // OpenAI's reasoning models reject max_tokens; compatible servers often
      // do not know max_completion_tokens.
      ...(official ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      stream: true,
      ...(official && cacheHints?.cacheKey
        ? { prompt_cache_key: promptCacheKey(cacheHints.cacheKey) }
        : {}),
    }
```

- [x] **Step 6: Run the tests to verify they pass**

Same command as Task 2 Step 2. Expected: all pass.

---

### Task 4: Ollama uses the budgeted context window and works with non-thinking models

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistProviders.mjs` (before `export class OllamaServerClient {`; `streamChat` lines 1230-1285)
- Modify: `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`

- [x] **Step 1: Write the failing tests**

Add at the end of the top-level `describe` (before its final `})`):
```js
  describe('Ollama request parameters', function () {
    const okStream = () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(JSON.stringify({ message: { content: 'hi' }, done: true, done_reason: 'stop' }) + '\n')
      })(),
    })

    it('sends the context window as num_ctx', async function () {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', fetchFn })

      for await (const _ of client.streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 512, contextWindow: 32768 })) {}

      expect(body.options).to.deep.equal({ num_predict: 512, num_ctx: 32768 })
    })

    it('omits num_ctx when no context window is given', async function () {
      let body = null
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        body = JSON.parse(opts.body)
        return Promise.resolve(okStream())
      })
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b', fetchFn })

      for await (const _ of client.streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 512 })) {}

      expect(body.options).to.deep.equal({ num_predict: 512 })
    })

    it('retries without think for a model that does not support thinking, and remembers it', async function () {
      const bodies = []
      const fetchFn = sinon.stub().callsFake((_url, opts) => {
        const body = JSON.parse(opts.body)
        bodies.push(body)
        if (body.think) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: async () => ({ error: '"no-think-test:1b" does not support thinking' }),
          })
        }
        return Promise.resolve(okStream())
      })
      const settings = { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'no-think-test:1b', fetchFn }

      const chunks = []
      for await (const chunk of createProviderClient(settings).streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(chunk)
      }
      expect(chunks).to.deep.include({ type: 'text', text: 'hi' })
      expect(bodies).to.have.length(2)
      expect(bodies[0].think).to.equal(true)
      expect(bodies[1]).to.not.have.property('think')

      // A new client for the same model skips the failing attempt.
      for await (const _ of createProviderClient(settings).streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }] })) {}
      expect(bodies).to.have.length(3)
      expect(bodies[2]).to.not.have.property('think')
    })

    it('still surfaces other 400 errors', async function () {
      const fetchFn = sinon.stub().resolves({
        ok: false,
        status: 400,
        json: async () => ({ error: 'model "missing:7b" not found' }),
      })
      const client = createProviderClient({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'missing:7b', fetchFn })

      let error = null
      try {
        for await (const _ of client.streamChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }] })) {}
      } catch (err) {
        error = err
      }
      expect(error).to.be.an.instanceOf(ProviderError)
      expect(error.message).to.include('not found')
      expect(fetchFn.callCount).to.equal(1)
    })
  })
```
Note: `ProviderError` is already imported at the top of the test file (line 5). Do not import it twice.
TRAP: use the exact model name `no-think-test:1b` in the retry test. The "does not support thinking" memory is module-level and would leak into other tests if they used the same `baseURL|model`.

- [x] **Step 2: Run to verify they fail**

Same command as Task 2 Step 2. Expected: the `num_ctx` test and the retry test fail; `'omits num_ctx…'` and `'still surfaces other 400 errors'` may already pass.

- [x] **Step 3: Add the module-level memory and the error reader**

Insert immediately before `export class OllamaServerClient {`:
```js
/**
 * `baseURL|model` pairs that answered "does not support thinking". Sending
 * think: true to such a model is an HTTP 400, so after the first refusal the
 * flag is left out for that model.
 */
const ollamaThinkUnsupported = new Set()

async function ollamaErrorMessage(res) {
  let msg = `Ollama error (${res.status})`
  try {
    const json = await res.json()
    if (json?.error) msg = typeof json.error === 'string' ? json.error : json.error.message || msg
  } catch {}
  return msg
}

```

- [x] **Step 4: Rewrite the start of `OllamaServerClient.streamChat`**

Replace exactly this block (currently lines 1230-1285, from the method signature to the end of the `if (!res.ok) {…}` block):
```js
  async *streamChat({ system, messages, maxTokens = 8192, tools = [], signal }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })

    const wireMessages = toOllamaMessages(system, messages)
```
…through…
```js
    if (!res.ok) {
      let msg = `Ollama error (${res.status})`
      try {
        const json = await res.json()
        if (json?.error) msg = typeof json.error === 'string' ? json.error : json.error.message || msg
      } catch {}
      throw new ProviderError(msg, { status: res.status, code: 'providerError' })
    }
```
with:
```js
  async *streamChat({ system, messages, maxTokens = 8192, tools = [], contextWindow, signal }) {
    const timeouts = withRequestTimeouts(signal, {
      connectMs: this.connectTimeoutMs,
      idleMs: this.streamIdleTimeoutMs,
    })

    const wireMessages = toOllamaMessages(system, messages)
    const wireTools = tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    const thinkKey = `${this.baseURL}|${this.model}`
    const numCtx = Number(contextWindow) > 0 ? Math.floor(Number(contextWindow)) : null
    const body = {
      model: this.model,
      messages: wireMessages,
      stream: true,
      ...(ollamaThinkUnsupported.has(thinkKey) ? {} : { think: true }),
      options: {
        num_predict: maxTokens,
        // Without num_ctx Ollama uses its small default window and silently
        // drops the start of the prompt, while the harness budgets for this one.
        ...(numCtx ? { num_ctx: numCtx } : {}),
      },
      ...(wireTools?.length ? { tools: wireTools } : {}),
    }

    const headers = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const send = async () => {
      try {
        return await fetchWithRetry(`${this.baseURL}/api/chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: timeouts.signal,
        }, { fetchFn: this.fetch })
      } catch (err) {
        timeouts.checkAbortReason()
        if (err.name === 'AbortError' || err.code === 'aborted') throw err
        throw new ProviderError(`Could not reach Ollama at ${this.baseURL}: ${err.message}`, {
          code: 'network',
        })
      }
    }

    let res
    try {
      res = await send()
      if (!res.ok && body.think) {
        const message = await ollamaErrorMessage(res)
        if (!/does not support thinking/i.test(message)) {
          throw new ProviderError(message, { status: res.status, code: 'providerError' })
        }
        ollamaThinkUnsupported.add(thinkKey)
        delete body.think
        res = await send()
      }
    } finally {
      timeouts.clearConnectTimeout()
    }

    if (!res.ok) {
      throw new ProviderError(await ollamaErrorMessage(res), {
        status: res.status,
        code: 'providerError',
      })
    }
```
TRAP: the old `try { res = await fetchWithRetry(...) } catch { … throw new ProviderError('Could not reach Ollama …') }` wrapped every error as a network error. The new code throws the "other 400" `ProviderError` **outside** `send`'s catch on purpose, so it is not rewritten as "Could not reach Ollama".
TRAP: `res.json()` can be read only once. The first failed response is read in the retry branch; the final `if (!res.ok)` reads the second response. Never call `ollamaErrorMessage` twice on the same response.

- [x] **Step 5: Run the tests to verify they pass**

Same command as Task 2 Step 2. Expected: all pass, including `'Ollama Provider Client'` and `'exits Ollama stream when done: true is received'`.

---

### Task 5: The chat proxy forwards the context window

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistProviderController.mjs` (lines 141-148)
- Modify: `modules/ai-assist/test/unit/src/AiAssistProviderController.test.mjs`

- [x] **Step 1: Write the failing test**

In `AiAssistProviderController.test.mjs`, directly after the test `'streams chat chunks as NDJSON and ends with done'` (ends around line 121), add:
```js
  it('forwards the context window and relays stop chunks', async function () {
    const streamChat = sinon.spy(async function* () {
      yield { type: 'text', text: 'partial' }
      yield { type: 'stop', reason: 'max_tokens' }
    })
    const controller = new AiAssistProviderController({ clientFactory: () => ({ streamChat }) })
    const res = fakeRes()
    const request = {
      system: 'fix it',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      contextWindow: 32768,
    }

    await controller.chat({ body: { providerSettings: settings, request } }, res)

    expect(streamChat.firstCall.args[0]).to.include({ contextWindow: 32768 })
    expect(res.written.map(line => JSON.parse(line))).to.deep.equal([
      { type: 'text', text: 'partial' },
      { type: 'stop', reason: 'max_tokens' },
      { type: 'done' },
    ])
  })
```

- [x] **Step 2: Run to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistProviderController.test.mjs 2>&1 | grep -E "Tests |×|FAIL" | head
```
Expected: the new test fails on `contextWindow`.

- [x] **Step 3: Implement**

In `AiAssistProviderController.mjs`, replace exactly:
```js
        maxTokens: request.maxTokens,
        tools: Array.isArray(request.tools) ? request.tools : [],
```
with:
```js
        maxTokens: request.maxTokens,
        contextWindow: Number(request.contextWindow) > 0 ? Number(request.contextWindow) : undefined,
        tools: Array.isArray(request.tools) ? request.tools : [],
```
TRAP: `'tests the connection with a one-token chat'` (`controller.test`) builds its own `streamChat` call. Do not add `contextWindow` there.

- [x] **Step 4: Run to verify it passes**

Same command as Step 2. Expected: all pass.

---

### Task 6: Final verification

- [x] **Step 1: Full backend module suite**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
```
Expected: 0 failed. Passed = baseline + new tests (about 20 more).

- [x] **Step 2: Full frontend module suite**

Run the frontend command from Global Constraints. Expected: same passing count as baseline, 0 failing (this plan only adds TypeScript type members).

- [x] **Step 3: Type-check the touched TypeScript file**
```bash
timeout 600 ../../node_modules/.bin/tsc --noEmit -p . 2>&1 | grep "ai-assist/providers/types.ts"
```
Expected: no output. Errors in other files that existed before are not yours.

- [x] **Step 4: Do not redeploy yet.** WS-C wires these changes into the agent loops and redeploys at its end.

---

## Out of scope (checked, do not do)

- **Reading usage numbers from providers** to calibrate the token budget. Worth doing later; not part of this plan. `stream_options` is removed because nothing reads it.
- **Round-tripping Anthropic thinking blocks** (`signature_delta`) for tool use with extended thinking. Separate change.
- **Changing Ollama/other `DEFAULT_LIMITS`.** Pinned by tests and deliberately 256k for Ollama cloud models.
- **Fetching Ollama's real per-model context length via `/api/show`.** Not needed: Ollama caps `num_ctx` itself.
- **Gemini `thinkingConfig` model detection** (`cleanModel.includes('pro')`). Unrelated.
- **Removing the `lastStableMessage` field** from `CacheHints`. The browser and server still send it, and OpenAI/Gemini/Ollama ignore it. Harmless.
