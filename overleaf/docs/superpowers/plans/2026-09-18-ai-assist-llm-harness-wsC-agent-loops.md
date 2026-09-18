# AI Assist LLM Harness WS-C: Agent Loops Implementation Plan

> **For agentic workers:** Implement task by task, in order. Steps use checkbox (`- [ ]`) syntax; tick each step when done. Every piece of code you need is in this file. Do not redesign anything. If a quoted "current code" block does not match the file, re-read the file and apply the change to the equivalent code.

**Goal:** Make both agent loops spend fewer tokens per step and stop failing in ways that waste the user's time: trim the context in one deliberate pass so the prompt cache survives, keep the tool list stable, judge failures per model turn with a warning before stopping, never act on tool calls whose arguments were cut off, and bring the browser loop to the same behaviour as the server loop.

**Architecture:** There are two agent loops.
- The **main chat** runs on the server: `AiAssistRunManager.startRun` in `modules/ai-assist/app/src/AiAssistRunManager.mjs`, with `applyContextBudget` in the same file.
- The **one-click fix** (`suggest-fix-panel.tsx`, `FIX_TOOLS`, `requireTool: 'edit_file'`) runs in the browser: `runAgent` in `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`, with `applyBudget` in `agent/context/budget.ts`. Its LLM calls go through the server proxy, so they use the same provider code.

This plan changes only those two loops and their budget functions. It consumes what WS-A added to the provider layer.

**Tech Stack:** Node.js ES modules, TypeScript, Vitest (backend), Mocha (frontend), Chai, Sinon.

**Order:** Run **after WS-A** (`2026-09-18-ai-assist-llm-harness-wsA-provider-requests.md`). WS-B (`…-wsB-tools.md`) can run before, after, or in parallel; this plan does not edit its files. The last task redeploys the dev server for all three plans.

---

## Global Constraints

- **Never run `git commit`, `git push`, `git stash`, `git checkout -- <file>`, `git restore`, or any history-altering git command.** Leave all changes uncommitted. `git checkout`/`git restore` would also wipe other uncommitted work in these files.
- **WS-A must be done first.** Check: `grep -c "type: 'stop', reason: 'max_tokens'" modules/ai-assist/app/src/AiAssistProviders.mjs` prints 4, and `grep -c "'outputTruncated'" modules/ai-assist/frontend/js/features/ai-assist/providers/types.ts` prints 1. If not, stop and implement WS-A.
- **Another session may edit this worktree.** Line numbers were verified on 2026-09-17. If a quoted block does not match, find the equivalent code. Never overwrite unrelated edits.
- **Files this plan owns (edit only these):**
  - `modules/ai-assist/app/src/AiAssistRunManager.mjs`
  - `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`
  - `modules/ai-assist/frontend/js/features/ai-assist/agent/context/budget.ts`
  - `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`
  - `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts`
  - `modules/ai-assist/test/frontend/js/context/budget.test.ts`
- **No step budgets.** Never add a maximum number of tool calls or steps. The user explicitly rejected step budgets. Runaway protection is only by failure patterns (identical failures, turns where everything failed, alternating loops).
- **Do not fix model behaviour by adding instructions to system prompts.**
- **Working directory for all commands:**
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Backend test runner** (`XDG_DATA_HOME` is required):
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path> 2>&1 | grep -E "Test Files|Tests |FAIL|×|AssertionError" | head -40
  ```
- **Frontend runner for one or more files:**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot <path> [<path>…] 2>&1 | grep -E "passing|failing|Error" | head -20
  ```
- **Frontend full module suite:**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' --reporter dot modules/ai-assist/test/frontend 2>&1 | grep -E "passing|failing"
  ```
- **Baseline:** run the backend suite (`modules/ai-assist/test/unit/src`) and the frontend module suite before Task 1 and write the numbers down. They are higher than the 2026-09-17 numbers (212 / 858) by whatever WS-A and WS-B added.
- **Keep output small.** Always pipe test output through `grep`.
- **Style:** 2-space indentation, single quotes, no semicolons, trailing commas in multi-line literals.

---

## Background (verified findings this plan fixes)

1. **Trimming breaks the prompt cache on every step near the limit.** `applyContextBudget` (`AiAssistRunManager.mjs:216-285`) elides old tool results one at a time and stops as soon as the request fits. The loop keeps the trimmed messages (`:441`). The next step adds a result, is over the limit again, and elides one more old result. Every step near the limit changes an early message, so every request misses the provider's prompt cache from that point on. The browser `applyBudget` (`budget.ts:87-182`) does the same. Both also re-serialise the whole conversation after every single elision (`fits()` / `estimateRequestTokens`), which is quadratic.
2. **Declining an edit empties the prompt cache.** After a declined edit the server removes `edit_file`/`create_file` from the tool list (`:416-419`). Tools are the very start of the prompt, so the whole cache is lost for the rest of the run. The loop already refuses further edits in the edit branch (`:546-551`), but that branch also sets `shouldStop = true`, ending the run with no reply to the user. (This reverses the decision of the earlier plan `2026-09-17-ai-assist-harness-ws2-agent-loop-correctness.md`, Task 4, on purpose, for caching.)
3. **Failures are counted per call, and the limits differ between the loops.**
   - Server (`:672-694`): 3 failed **calls** in a row end the run, so one reply with 3 parallel guessed reads that all miss is fatal. The same call failing twice anywhere in the run ends it, even if the model changed the project in between. `status: 'none'` counts as a failure (`:670`), but that is just "nothing compiled yet".
   - Browser (`run-agent.ts:21-24, 257-286`): the limits are 2 identical / 5 consecutive calls. The "first repeat is a chance to change course" warning (`:273-280`) is **dead code**: `repeats >= 2` stops first.
   - The browser has no alternating-loop detection; the server has it (`:696-721`).
4. **Tool calls cut off at the output limit are executed.** WS-A now marks such calls (`{ type: 'stop', reason: 'max_tokens' }` chunk; `_repaired: true` / `_parseError: true` in args), but neither loop reads the marks. A cut-off `edit_file` goes to approval with a truncated `newText`, and the truncated text (or `_raw`) is re-sent in the history on every later step. A text reply cut off at the limit ends silently.
5. **The browser loop budgets only once.** `runAgent` calls `buildRequest` (which trims) once before the loop (`run-agent.ts:55-61`); tool results added during the run are never checked against the window.
6. **Provider wiring.** Neither loop passes `contextWindow` (WS-A's Ollama `num_ctx`), and the server loop sends no `cacheKey` (OpenAI `prompt_cache_key`).

### Decisions (do not revisit)

- `TRIM_TARGET_FRACTION = 0.7`. Trimming starts only when the request is over the budget, then trims until it is at or below 70% of the budget. Whole turns (server pass 3) are dropped only when elision could not get under the **budget**, and then down to the 70% target. The result is `exhausted` only if it is still over the budget.
- The tool list is the same on every request of a run. After a declined edit, further `edit_file`/`create_file` calls get `{ status: 'rejected', error: … }` and the run continues so the model can answer the user.
- `IDENTICAL_FAILURE_LIMIT = 3`: the second identical failure gets a `repeated` warning in its result, the third ends the run (`runawayToolLoop`). Any result with `status: 'applied'` clears the identical-failure memory (the project changed).
- `FAILED_TURN_LIMIT = 4`: four model turns in a row in which **every** tool call failed end the run (`consecutiveToolFailures`). A turn with at least one success resets the count.
- A call "failed" if it threw, or its result has `error`, or `status` is `noMatch` or `ambiguous`. `status: 'none'` is **not** a failure.
- Incomplete calls are never executed and never go to approval. A call is incomplete if (a) the reply was cut off (`stop` chunk) and it is the **last** call of that reply, (b) its args have `_parseError`, or (c) it is `edit_file`/`create_file` and its args have `_repaired`. Its args are replaced by `{ path }` (or `{}`), and it gets `{ status: 'error', error: … }`. For every other call, `_parseError`, `_raw` and `_repaired` are deleted from the args.
- A text-only reply that was cut off gets an `error` event with code `outputTruncated` before `turnFinished`. In the browser, a pending `requireTool` nudge takes precedence over that error.
- The browser loop gets the same rules, plus alternating-loop detection and a budget check before every request. It does **not** get parallel reads (the browser tools share the editor handle; not verified safe).
- The server sends `cacheKey: String(projectId)` and `contextWindow: resolvedLimits.contextWindow`; the browser sends `contextWindow: limits.contextWindow` (its `cacheKey` already comes from the caller).

---

## File Structure

| File | Change |
|---|---|
| `app/src/AiAssistRunManager.mjs` | new exports `TRIM_TARGET_FRACTION`, `IDENTICAL_FAILURE_LIMIT`, `FAILED_TURN_LIMIT`, `classifyIncompleteCalls`, `incompleteCallError`; `applyContextBudget` rewritten; the `try` block of `startRun` rewritten |
| `frontend/…/agent/context/budget.ts` | `TRIM_TARGET_FRACTION`; `applyBudget` rewritten |
| `frontend/…/agent/run-agent.ts` | whole file replaced |
| tests | updated and new tests listed per task |

---

### Task 1: Server budget trims once, to 70%, in linear time

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs` (constants lines 58-62; `applyContextBudget` lines 216-285)
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

- [x] **Step 1: Write the failing test**

(a) Change line 3 of the test file from:
```js
import { AiAssistRunManager, applyContextBudget, extractTextToolCall } from '../../../app/src/AiAssistRunManager.mjs'
```
to:
```js
import {
  AiAssistRunManager,
  TRIM_TARGET_FRACTION,
  applyContextBudget,
  estimateMessagesTokens,
  extractTextToolCall,
} from '../../../app/src/AiAssistRunManager.mjs'
```

(b) Inside `describe('applyContextBudget', …)` (line 562), add after the last test of that block:
```js
    it('trims to 70% of the budget in one pass, so the next steps reuse the cache', function () {
      const messages = []
      for (let i = 0; i < 8; i++) {
        messages.push({ role: 'user', content: `q${i}` })
        messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `${i}`, name: 'read_file', args: { path: 'main.tex' } }] })
        messages.push({ role: 'tool', toolCallId: `${i}`, name: 'read_file', content: 'x'.repeat(8000) })
      }
      messages.push({ role: 'user', content: 'latest' })
      // budget = 20000 - 1000 - 2000 = 17000; target = 11900
      const limits = { contextWindow: 20000, maxOutputTokens: 1000 }

      const result = applyContextBudget({ system: 'Sys', messages, limits })

      const elided = result.messages.filter(m => m.role === 'tool' && m.content.includes('"elided":true'))
      expect(result.exhausted).to.equal(false)
      expect(elided).to.have.length(3)
      expect(estimateMessagesTokens('Sys', result.messages)).to.be.at.most(Math.floor(17000 * TRIM_TARGET_FRACTION))

      // The next step appends a small turn: nothing earlier changes.
      const next = [...result.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }]
      const again = applyContextBudget({ system: 'Sys', messages: next, limits })
      expect(again.messages.slice(0, result.messages.length)).to.deep.equal(result.messages)
    })
```
Why 3: the request is about 17,430 tokens. One elision (−2,127) already fits the 17,000 budget, which is where today's code stops. Reaching the 11,900 target takes three.

- [x] **Step 2: Run to verify it fails**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs 2>&1 | grep -E "Tests |×" | head
```
Expected: the new test fails (`TRIM_TARGET_FRACTION` undefined / 1 elided instead of 3).

- [x] **Step 3: Add the constant**

Replace exactly:
```js
export const ASSISTANT_ELISION_MARKER = '[earlier reply elided]'
```
with:
```js
export const ASSISTANT_ELISION_MARKER = '[earlier reply elided]'
// Once trimming is needed, trim to this fraction of the budget instead of to
// just under it. See applyContextBudget.
export const TRIM_TARGET_FRACTION = 0.7
```

- [x] **Step 4: Replace `applyContextBudget`**

Replace the whole function, from `export function applyContextBudget({ system, messages, limits, tools = [] }) {` (line 216) through its closing `}` (line 285), with:
```js
export function applyContextBudget({ system, messages, limits, tools = [] }) {
  const contextWindow = limits?.contextWindow ?? 200000
  const maxOutputTokens = limits?.maxOutputTokens ?? 32000
  const rawBudget = contextWindow - maxOutputTokens - Math.ceil(contextWindow * MARGIN_FRACTION)

  if (rawBudget <= 0) {
    return { messages: [...messages], exhausted: true }
  }

  const working = [...messages]
  // Per-message estimates kept in step with `working`, so a trim updates the
  // total instead of re-serialising the whole conversation.
  const sizes = working.map(estimateMessageTokens)
  let total =
    estimateTokens(system) +
    (tools.length ? estimateTokens(JSON.stringify(tools)) : 0) +
    sizes.reduce((sum, size) => sum + size, 0)

  if (total <= rawBudget) {
    return { messages: working, exhausted: false }
  }

  // Trimming rewrites the prompt prefix, which throws away the provider's
  // prompt cache from that point on. Trim well below the limit in one go, so
  // the next several steps append to a stable prefix instead of each step
  // eliding one more result and missing the cache every time.
  const target = Math.floor(rawBudget * TRIM_TARGET_FRACTION)

  const replace = (index, message) => {
    const size = estimateMessageTokens(message)
    total += size - sizes[index]
    sizes[index] = size
    working[index] = message
  }

  // Pass 1: Elide older tool results (keep latest KEEP_RECENT_TOOL_RESULTS)
  const toolIndices = working
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m.role === 'tool')
    .map(({ idx }) => idx)

  const elidableTools = toolIndices.slice(
    0,
    Math.max(0, toolIndices.length - KEEP_RECENT_TOOL_RESULTS)
  )

  for (const idx of elidableTools) {
    const msg = working[idx]
    if (isElided(msg)) continue
    const stub = stubToolMessage(msg)
    if (estimateTokens(stub.content) >= sizes[idx]) continue
    replace(idx, stub)
    if (total <= target) return { messages: working, exhausted: false }
  }

  // Pass 2: Elide older assistant prose (keep latest KEEP_RECENT_ASSISTANT_TURNS)
  const assistantIndices = working
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m.role === 'assistant' && m.content)
    .map(({ idx }) => idx)

  const elidableAssistants = assistantIndices.slice(
    0,
    Math.max(0, assistantIndices.length - KEEP_RECENT_ASSISTANT_TURNS)
  )

  for (const idx of elidableAssistants) {
    const msg = working[idx]
    if (estimateTokens(ASSISTANT_ELISION_MARKER) >= estimateTokens(msg.content)) continue
    replace(idx, { ...msg, content: ASSISTANT_ELISION_MARKER })
    if (total <= target) return { messages: working, exhausted: false }
  }

  // Pass 3: drop whole turns from the front, only when eliding could not get
  // under the budget, and then down to the target. A turn runs from a user
  // message up to the next one. Cutting inside a turn leaves an assistant
  // message or a tool result without the message it answers, which providers
  // reject with a 400. If only one turn is left and it still does not fit,
  // report exhaustion.
  if (total > rawBudget) {
    while (total > target) {
      const nextUser = working.findIndex(
        (message, index) => index > 0 && message.role === 'user'
      )
      if (nextUser === -1) break
      working.splice(0, nextUser)
      total -= sizes.splice(0, nextUser).reduce((sum, size) => sum + size, 0)
    }
  }

  return {
    messages: working,
    exhausted: total > rawBudget,
  }
}
```
TRAP: passes 1 and 2 stop at the **target**; pass 3 only starts when the total is still over the **budget**. Do not make pass 3 run whenever the total is over the target: the existing test `'elides older tool results to fit budget while preserving recent ones'` would then drop a whole turn it expects to keep.

- [x] **Step 5: Run to verify all budget tests pass**

Same command as Step 2. Expected: all `applyContextBudget` tests pass, including `'drops oldest turns…'`, `'drops whole turns so the trimmed conversation still opens with a user message'` and `'reports exhausted instead of cutting inside the only remaining turn'`.

---

### Task 2: Browser budget trims once, to 70%, in linear time

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/budget.ts` (lines 79-182)
- Test: `modules/ai-assist/test/frontend/js/context/budget.test.ts`

- [x] **Step 1: Update the pinned test to the new contract**

In `budget.test.ts`, replace:
```ts
  it('elision can succeed: a request too big to send untrimmed fits after eliding', function () {
    const roomy = { contextWindow: 50000, maxOutputTokens: 1000 }
    const result = applyBudget({ system: 'sys', messages: conversation(6), limits: roomy })
    expect(result.elided).to.equal(2)
    expect(result.exhausted).to.equal(false)
  })
```
with:
```ts
  it('elision can succeed: a request too big to send untrimmed fits after eliding', function () {
    const roomy = { contextWindow: 50000, maxOutputTokens: 1000 }
    const result = applyBudget({ system: 'sys', messages: conversation(6), limits: roomy })
    // Two elisions would already fit the 44,000 budget; trimming continues
    // toward 70% of it (30,800) so the next steps keep the cached prefix.
    // Only three results are elidable (the newest three are kept).
    expect(result.elided).to.equal(3)
    expect(result.exhausted).to.equal(false)
  })

  it('trims no further than needed to reach the target', function () {
    const roomy = { contextWindow: 50000, maxOutputTokens: 1000 }
    const once = applyBudget({ system: 'sys', messages: conversation(6), limits: roomy })
    const next = [...once.messages, { role: 'user', content: 'another question' } as AgentMessage]
    const twice = applyBudget({ system: 'sys', messages: next, limits: roomy })
    expect(twice.elided).to.equal(0)
    expect(twice.messages.slice(0, once.messages.length)).to.deep.equal(once.messages)
  })
```

- [x] **Step 2: Run to verify the updated test fails**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot modules/ai-assist/test/frontend/js/context/budget.test.ts 2>&1 | grep -E "passing|failing|Error" | head
```
Expected: `'elision can succeed…'` fails (2 instead of 3).

- [x] **Step 3: Replace `applyBudget`**

In `budget.ts`, replace everything from the doc comment that starts `/**\n * Trims a conversation to fit, deterministically.` (line 79) through the closing `}` of `applyBudget` (line 182) with:
```ts
/**
 * Once trimming is needed, trim to this fraction of the budget instead of to
 * just under it. Every trim rewrites the prompt prefix and costs a full prompt
 * cache miss; trimming further in one go leaves room for the next several
 * steps to append without trimming again. Mirrors AiAssistRunManager.mjs.
 */
export const TRIM_TARGET_FRACTION = 0.7

/**
 * Trims a conversation to fit, deterministically.
 *
 * Order matters and is fixed: stale tool results first, then old assistant
 * text, then give up. Elision is monotonic — an elided result is already at its
 * smallest, so re-running this leaves it alone. Trimming only starts above the
 * budget and continues down to TRIM_TARGET_FRACTION of it, so the cache prefix
 * stays stable for the steps that follow.
 */
export function applyBudget({
  system,
  messages,
  limits,
  tools = [],
}: {
  system: string
  messages: AgentMessage[]
  limits: Limits
  tools?: ToolSpec[]
}): {
  messages: AgentMessage[]
  elided: number
  exhausted: boolean
  reason?: 'budget-non-positive'
} {
  const rawBudget =
    limits.contextWindow -
    limits.maxOutputTokens -
    Math.ceil(limits.contextWindow * MARGIN_FRACTION)

  if (rawBudget <= 0) {
    // The output reservation plus the safety margin already consumes the
    // whole context window on its own — a misconfigured model (small window,
    // large output cap), not a conversation that grew too large. Flagged
    // distinctly so the caller doesn't tell the user "your chat is too long"
    // when the real fault is the configured output cap.
    return {
      messages: [...messages],
      elided: 0,
      exhausted: true,
      reason: 'budget-non-positive',
    }
  }
  const budget = rawBudget

  const working = [...messages]
  // Per-message estimates kept in step with `working`, so each trim updates
  // the total instead of re-serialising the whole conversation.
  const sizes = working.map(messageTokens)
  let total =
    estimateTokens(system) +
    (tools.length ? estimateTokens(JSON.stringify(tools)) : 0) +
    sizes.reduce((sum, size) => sum + size, 0)

  if (total <= budget) return { messages: working, elided: 0, exhausted: false }

  const target = Math.floor(budget * TRIM_TARGET_FRACTION)
  let elided = 0

  const replace = (index: number, message: AgentMessage) => {
    const size = messageTokens(message)
    total += size - sizes[index]
    sizes[index] = size
    working[index] = message
  }

  // Pass one: tool results, oldest first, keeping the newest few intact.
  const toolIndexes = working
    .map((message, index) => ({ message, index }))
    .filter(entry => entry.message.role === 'tool')
    .map(entry => entry.index)

  const elidable = toolIndexes.slice(
    0,
    Math.max(0, toolIndexes.length - KEEP_RECENT_TOOL_RESULTS)
  )

  for (const index of elidable) {
    const message = working[index]
    if (isElided(message)) continue
    const candidate = stub(message as Extract<AgentMessage, { role: 'tool' }>)
    // Only worth it if the stub is actually smaller. A short tool result (an
    // error string, a boolean) can serialise to *more* tokens once wrapped in
    // the elision envelope, which would grow the request instead of
    // shrinking it.
    if (estimateTokens(candidate.content) >= sizes[index]) continue
    replace(index, candidate)
    elided += 1
    if (total <= target) return { messages: working, elided, exhausted: false }
  }

  // Pass two: assistant prose from the oldest turns, keeping the newest few
  // intact. Tool calls stay attached — an orphaned tool result is rejected by
  // every provider — and content is replaced with a short marker rather than
  // blanked, since an assistant message with no tool calls and empty content
  // is itself invalid and would be rejected the same way.
  const assistantIndexes = working
    .map((message, index) => ({ message, index }))
    .filter(entry => entry.message.role === 'assistant' && entry.message.content)
    .map(entry => entry.index)

  const elidableAssistants = assistantIndexes.slice(
    0,
    Math.max(0, assistantIndexes.length - KEEP_RECENT_ASSISTANT_TURNS)
  )

  for (const index of elidableAssistants) {
    const message = working[index] as Extract<AgentMessage, { role: 'assistant' }>
    // Symmetric to the pass-one guard above: a short reply (`'ok'`) is
    // already smaller than the marker that would replace it, so rewriting it
    // would grow the request instead of shrinking it.
    if (estimateTokens(ASSISTANT_ELISION_MARKER) >= estimateTokens(message.content)) {
      continue
    }
    replace(index, { ...message, content: ASSISTANT_ELISION_MARKER })
    if (total <= target) return { messages: working, elided, exhausted: false }
  }

  return { messages: working, elided, exhausted: total > budget }
}
```
TRAP: keep `estimateRequestTokens` (lines 48-58) exported and unchanged; tests import it.

- [x] **Step 4: Run to verify the whole budget file passes**

Same command as Step 2. Expected: 0 failing, including `'leaves a request exactly at the limit untouched'`, `'is monotonic…'` and the assistant-elision tests.

---

### Task 3: Server run loop — stable tools, per-turn failures, incomplete calls, provider wiring

This task replaces the body of `startRun`'s main `try` block in one go, because every change touches the same loop. Write the tests first (Step 1), then replace the code (Steps 3-4).

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs` (after `FILE_EDIT_TOOLS` at line 66; new helpers before `export class AiAssistRunManager {` at line 287; `startRun` lines 402-745)
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

- [x] **Step 1: Update existing tests and write the new ones**

(a) Test `'stops runaway loop and outer while loop when identical tool call fails repeatedly'` (line 229). Replace its body so it reads:
```js
  it('stops runaway loop and outer while loop when identical tool call fails repeatedly', async function () {
    const lastMessages = []
    mockClient.streamChat.callsFake(async function* (opts) {
      lastMessages.push(opts.messages.at(-1)?.content)
      yield {
        type: 'tool_call',
        id: 'call-fail',
        name: 'read_file',
        args: { path: 'nonexistent.tex' },
      }
    })

    mockTools.execute.resolves({ error: 'File not found' })

    await manager.startRun({
      runId: 'run-fail',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    // First failure: plain error. Second: a warning. Third: the run stops.
    expect(mockClient.streamChat.callCount).to.equal(3)
    expect(lastMessages[2]).to.include('failed 2 times')
    const turnFinishedCalls = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[1]?.type === 'turnFinished')
    expect(turnFinishedCalls).to.have.lengthOf(1)
    expect(mockStore.appendEvent.calledWith('run-fail', sinon.match({ type: 'error', code: 'runawayToolLoop' }))).to.be.true
    expect(mockStore.updateStatus.calledWith('run-fail', 'done')).to.be.true
  })
```

(b) Test `'stops prompting user when user rejects an edit and completes turn cleanly'` (line 259). Replace:
```js
    // Only file-editing tools are withdrawn; the model can still read and
    // search to address the user's feedback.
    expect(passedToolsInSecondCall.map(t => t.name)).to.deep.equal(['read_file', 'search_text'])
```
with:
```js
    // The tool list never changes during a run: changing it would throw away
    // the provider's prompt cache. Further edits are refused by the loop.
    expect(passedToolsInSecondCall.map(t => t.name)).to.deep.equal(['read_file', 'search_text', 'edit_file', 'create_file'])
```

(c) Test `'forwards resolved maxTokens and cacheHints to provider client'` (line 415). Replace:
```js
    expect(capturedOpts.maxTokens).to.equal(32000)
    expect(capturedOpts.cacheHints).to.deep.equal({
      cacheSystem: true,
      cacheTools: true,
      lastStableMessage: 1,
    })
```
with:
```js
    expect(capturedOpts.maxTokens).to.equal(32000)
    expect(capturedOpts.contextWindow).to.equal(200000)
    expect(capturedOpts.cacheHints).to.deep.equal({
      cacheSystem: true,
      cacheTools: true,
      lastStableMessage: 1,
      cacheKey: 'p1',
    })
```

(d) Add these tests at the end of the top-level `describe('AiAssistRunManager', …)`, just before its final `})`:
```js
  describe('failure accounting', function () {
    const start = (runId, extra = {}) =>
      manager.startRun({
        runId,
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'go' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
        ...extra,
      })

    it('refuses a further edit after a decline without asking again or ending the run', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'e1', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'b' } }
        } else if (turn === 2) {
          yield { type: 'tool_call', id: 'e2', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'c' } }
        } else {
          yield { type: 'text', text: 'I will leave it as it is.' }
        }
      })

      const runPromise = start('run-blocked')
      await new Promise(r => setTimeout(r, 10))
      await manager.approveEdit('run-blocked', { accepted: false })
      await runPromise

      expect(mockStore.setPendingApproval.calledOnce).to.be.true
      expect(mockClient.streamChat.callCount).to.equal(3)
      expect(mockStore.appendEvent.calledWith('run-blocked', sinon.match({
        type: 'toolCallFinished',
        id: 'e2',
        result: sinon.match({ status: 'rejected' }),
      }))).to.be.true
      expect(mockTools.execute.calledWith('edit_file')).to.be.false
      expect(mockStore.updateStatus.calledWith('run-blocked', 'done')).to.be.true
    })

    it('counts a turn whose calls all failed once, however many calls it made', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        for (let i = 0; i < 3; i++) {
          yield { type: 'tool_call', id: `r${turn}-${i}`, name: 'read_file', args: { path: `missing-${turn}-${i}.tex` } }
        }
      })
      mockTools.execute.resolves({ error: 'File not found' })

      await start('run-turns')

      expect(mockClient.streamChat.callCount).to.equal(4)
      expect(mockStore.appendEvent.calledWith('run-turns', sinon.match({ type: 'error', code: 'consecutiveToolFailures' }))).to.be.true
      expect(mockStore.appendEvent.getCalls().filter(c => c.args[1]?.type === 'turnFinished')).to.have.lengthOf(1)
    })

    it('forgets earlier failures once a call changes the project', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 3) {
          yield { type: 'tool_call', id: `s${turn}`, name: 'configure_editor_settings', args: { mode: 'vim' } }
        } else if (turn <= 5) {
          yield { type: 'tool_call', id: `r${turn}`, name: 'read_file', args: { path: 'missing.tex' } }
        } else {
          yield { type: 'text', text: 'done' }
        }
      })
      mockTools.execute.callsFake(async name =>
        name === 'configure_editor_settings' ? { status: 'applied' } : { error: 'File not found' }
      )

      await start('run-forget')

      expect(mockClient.streamChat.callCount).to.equal(6)
      expect(mockStore.appendEvent.calledWith('run-forget', sinon.match({ type: 'error' }))).to.be.false
    })

    it('does not count get_compile_result with nothing compiled as a failure', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn <= 3) {
          yield { type: 'tool_call', id: `g${turn}`, name: 'get_compile_result', args: {} }
        } else {
          yield { type: 'text', text: 'Nothing has been compiled yet.' }
        }
      })
      mockTools.execute.resolves({ status: 'none', message: 'No compile has run in this chat yet.' })

      await start('run-none')

      expect(mockClient.streamChat.callCount).to.equal(4)
      expect(mockStore.appendEvent.calledWith('run-none', sinon.match({ type: 'error' }))).to.be.false
    })
  })

  describe('incomplete tool calls', function () {
    const start = runId =>
      manager.startRun({
        runId,
        projectId: 'p1',
        userId: 'u1',
        transcript: [{ role: 'user', content: 'go' }],
        providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
      })

    it('never runs an edit that was cut off at the output limit', async function () {
      let turn = 0
      const requests = []
      mockClient.streamChat.callsFake(async function* (opts) {
        turn++
        requests.push(JSON.parse(JSON.stringify(opts.messages)))
        if (turn === 1) {
          yield { type: 'tool_call', id: 'e1', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'half of it', _repaired: true } }
          yield { type: 'stop', reason: 'max_tokens' }
        } else {
          yield { type: 'text', text: 'ok' }
        }
      })
      mockTools.checkEdit = sinon.stub().resolves({ status: 'ok', path: 'main.tex' })

      await start('run-cut')

      expect(mockStore.setPendingApproval.called).to.be.false
      expect(mockTools.checkEdit.called).to.be.false
      expect(mockTools.execute.called).to.be.false
      const assistant = requests[1].find(m => m.role === 'assistant')
      expect(assistant.toolCalls[0].args).to.deep.equal({ path: 'main.tex' })
      const tool = requests[1].find(m => m.role === 'tool')
      expect(tool.content).to.include('cut off at the 32000-token output limit')
    })

    it('never runs a file change whose arguments only parsed after repair', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'c1', name: 'create_file', args: { path: 'new.tex', content: 'x', _repaired: true } }
        } else {
          yield { type: 'text', text: 'ok' }
        }
      })

      await start('run-repaired')

      expect(mockTools.execute.called).to.be.false
      expect(mockStore.setPendingApproval.called).to.be.false
    })

    it('runs a read whose arguments were repaired, without the marker', async function () {
      let turn = 0
      mockClient.streamChat.callsFake(async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'main.tex', _repaired: true } }
        } else {
          yield { type: 'text', text: 'ok' }
        }
      })

      await start('run-repaired-read')

      expect(mockTools.execute.calledWith('read_file', { path: 'main.tex' })).to.be.true
    })

    it('reports a text reply cut off at the output limit', async function () {
      mockClient.streamChat.callsFake(async function* () {
        yield { type: 'text', text: 'A long answer that' }
        yield { type: 'stop', reason: 'max_tokens' }
      })

      await start('run-cut-text')

      expect(mockStore.appendEvent.calledWith('run-cut-text', sinon.match({ type: 'error', code: 'outputTruncated' }))).to.be.true
      expect(mockStore.updateStatus.calledWith('run-cut-text', 'done')).to.be.true
    })
  })
```
Notes for these tests:
- `mockTools` (from `beforeEach`) has no `getToolSpecs` and no `checkEdit` unless a test adds them, so the tool list is `[]` and edits go straight to approval.
- `'forgets earlier failures…'`: turns 1-2 fail on the same call (the second gets a warning), turn 3 applies a change (clears the memory), turns 4-5 fail again without reaching 3 identical failures, turn 6 answers.

- [x] **Step 2: Run to verify the new and updated tests fail**

Same command as Task 1 Step 2. Expected failures: the 3 updated tests and most of the new ones (for example `callCount` 2 instead of 3, the tool list is filtered, `contextWindow` undefined, the cut-off edit is sent to approval).

- [x] **Step 3: Add constants and helpers**

(a) Replace exactly:
```js
export const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file'])
```
with:
```js
export const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file'])

// The same failing call, arguments and all: the second failure carries a
// warning in its result, the third ends the run.
export const IDENTICAL_FAILURE_LIMIT = 3
// Model turns in a row in which every tool call failed. Counted per turn, not
// per call: one reply with three parallel guesses that all miss is one wrong
// decision, not three.
export const FAILED_TURN_LIMIT = 4
```
Note: the comment block directly above this line (`// Withdrawn for the rest of a run once the user declines an edit, …`) is now wrong. Replace those two comment lines with:
```js
// The tools that change files. After the user declines an edit, calls to these
// are refused for the rest of the run (the tool list itself never changes).
```

(b) Insert immediately before `export class AiAssistRunManager {`:
```js
/**
 * Finds the tool calls that must not run, and strips the provider parser's
 * markers from every call's arguments.
 *
 * A call is incomplete when the reply was cut off at the output limit inside
 * it (always the last call of a cut-off reply), when its arguments were not
 * valid JSON, or when a file change's arguments only parsed after repair.
 * Running it would act on half an argument, e.g. write a cut-off newText into
 * the document. Its arguments are reduced to the path, so a long cut-off text
 * is not re-sent on every later request.
 *
 * Returns a Map from each incomplete call to 'cutOff' or 'invalid'.
 */
export function classifyIncompleteCalls(calls, truncated) {
  const incomplete = new Map()
  calls.forEach((call, index) => {
    const args =
      call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? { ...call.args }
        : {}
    const parseError = Boolean(args._parseError)
    const repaired = Boolean(args._repaired)
    delete args._parseError
    delete args._raw
    delete args._repaired
    const cutOff = truncated && index === calls.length - 1
    if (cutOff || parseError || (repaired && FILE_EDIT_TOOLS.has(call.name))) {
      incomplete.set(call, cutOff || repaired ? 'cutOff' : 'invalid')
      call.args = typeof args.path === 'string' ? { path: args.path } : {}
    } else {
      call.args = args
    }
  })
  return incomplete
}

export function incompleteCallError(call, reason, maxTokens) {
  return reason === 'cutOff'
    ? `This ${call.name} call was cut off at the ${maxTokens}-token output limit, so its arguments are incomplete and it was not run. Make the change in smaller pieces: replace a smaller line range per edit_file call, or create the file with part of its content and add the rest with edit_file.`
    : `The arguments of this ${call.name} call were not valid JSON, so it was not run. Send the call again with complete arguments.`
}

```

- [x] **Step 4: Replace the main `try` block of `startRun`**

In `startRun`, the main `try` block starts at line 402 with:
```js
    try {
      let steps = 0
      let consecutiveFailures = 0
      const failedCallSignatures = []
```
and its body ends at line 745, just before:
```js
    } catch (err) {
      if (
        controller.signal.aborted ||
```
**Before deleting anything, copy the approval code out.** It is the block inside `} else {` of the edit branch, from the line
```js
              const isCreate = call.name === 'create_file'
```
(line 555) down to and including the closing `}` of
```js
                } catch (err) {
                  result = { error: err.message || 'Tool execution failed' }
                  isError = true
                }
              }
```
(line 642). It handles the approval prompt, the timeout, the abort and the execution of an accepted edit. It stays **exactly** as it is.

Now replace lines 402-745 (from `    try {` up to, but not including, `    } catch (err) {`) with the code below. Where it says `// APPROVAL BLOCK`, paste the lines you copied, unchanged, with their original indentation (14 spaces).
```js
    try {
      let steps = 0
      let failedTurns = 0
      const failedCallSignatures = new Map()
      const recentCallSignatures = []
      let shouldStop = false
      let userDeclinedEdit = false

      const finishWithError = async (code, message) => {
        await emitEvent({ type: 'error', code, message })
        await emitEvent({ type: 'turnFinished', reason: 'stop' })
        await this.store.updateStatus(runId, 'done')
        shouldStop = true
      }

      // The same tool list on every request. Withdrawing tools after a declined
      // edit would change the start of the prompt and throw away the
      // provider's prompt cache for the rest of the run; the edit branch below
      // refuses further edits instead.
      const toolSpecs = this.tools?.getToolSpecs ? this.tools.getToolSpecs() : []

      while (true) {
        if (controller.signal.aborted || shouldStop) break

        const calls = []
        let text = ''
        let truncated = false

        const budgeted = applyContextBudget({
          system: SYSTEM_PROMPT,
          messages,
          limits: resolvedLimits,
          tools: toolSpecs,
        })

        if (budgeted.exhausted) {
          await finishWithError(
            'contextExhausted',
            'This conversation no longer fits in the model context window. Start a new chat to continue.'
          )
          break
        }

        messages = budgeted.messages

        const cacheHints = {
          cacheSystem: true,
          cacheTools: true,
          // Everything but the last message was sent in an earlier request, so it is
          // exactly the prefix worth caching. Same reasoning as build-request.ts.
          lastStableMessage: messages.length >= 2 ? messages.length - 2 : null,
          // Keeps this project's requests on the same OpenAI prompt cache.
          cacheKey: String(projectId),
        }

        for await (const chunk of client.streamChat({
          system: SYSTEM_PROMPT,
          messages,
          maxTokens,
          contextWindow: resolvedLimits.contextWindow,
          tools: toolSpecs,
          cacheHints,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break
          if (chunk.type === 'thinking') {
            await emitChunk('thinking', chunk.text)
          } else if (chunk.type === 'text') {
            text += chunk.text
            await emitChunk('text', chunk.text)
          } else if (chunk.type === 'tool_call') {
            calls.push(chunk)
          } else if (chunk.type === 'stop' && chunk.reason === 'max_tokens') {
            truncated = true
          }
        }

        if (controller.signal.aborted) break

        if (calls.length === 0 && text) {
          const rescued = extractTextToolCall(text, toolSpecs)
          if (rescued) {
            calls.push(rescued.call)
            text = rescued.prose
          }
        }

        if (calls.length === 0) {
          if (truncated) {
            await emitEvent({
              type: 'error',
              code: 'outputTruncated',
              message: `The reply was cut off at the ${maxTokens}-token output limit. Raise "Max output tokens" in the AI provider settings, or ask for a shorter answer.`,
            })
          }
          await emitEvent({ type: 'turnFinished', reason: 'stop' })
          await this.store.updateStatus(runId, 'done')
          shouldStop = true
          break
        }

        const incomplete = classifyIncompleteCalls(calls, truncated)

        messages.push({ role: 'assistant', content: text, toolCalls: calls })

        // The reads a model asks for together are independent, so run the ones
        // at the start of the turn at the same time. Stop at the first call
        // that is not read-only: a read listed after an edit expects to see it.
        const prefetched = new Map()
        const leadingReads = []
        for (const call of calls) {
          if (!READ_ONLY_TOOLS.has(call.name) || incomplete.has(call)) break
          leadingReads.push(call)
        }
        if (leadingReads.length > 1) {
          await Promise.all(
            leadingReads.map(async call => {
              try {
                const value = await this.tools.execute(call.name, call.args, { projectId, userId })
                prefetched.set(call, { result: value, isError: false })
              } catch (err) {
                prefetched.set(call, {
                  result: { error: err.message || 'Tool execution failed' },
                  isError: true,
                })
              }
            })
          )
        }

        let turnSucceeded = false
        let turnFailed = false

        for (const call of calls) {
          if (controller.signal.aborted || shouldStop) break
          steps++
          const callId = call.id || `call_${steps}_${runId}`
          call.id = callId

          // Plan the edit before anything is shown to the user: an edit that
          // cannot apply goes straight back to the model, and one that applies
          // to a different file than named is shown under its real path.
          let editPlan = null
          if (
            call.name === 'edit_file' &&
            this.tools?.checkEdit &&
            !incomplete.has(call) &&
            !userDeclinedEdit
          ) {
            try {
              editPlan = await this.tools.checkEdit(call.args, { projectId })
              if (editPlan?.status === 'ok' && editPlan.path && editPlan.path !== call.args.path) {
                call.args.path = editPlan.path
              }
            } catch {
              editPlan = null
            }
          }

          await emitEvent({
            type: 'toolCallStarted',
            id: callId,
            name: call.name,
            args: call.args,
          })

          let result = null
          let isError = false

          if (incomplete.has(call)) {
            result = {
              status: 'error',
              error: incompleteCallError(call, incomplete.get(call), maxTokens),
            }
            isError = true
          } else if (FILE_EDIT_TOOLS.has(call.name)) {
            if (userDeclinedEdit) {
              result = {
                status: 'rejected',
                error: 'The user declined an edit earlier in this turn, so file changes are blocked until they send a new message. Do not retry the edit. Say what you would change and why, or ask how they want to proceed.',
              }
            } else if (editPlan && editPlan.status !== 'ok') {
              result = editPlan
            } else {
              // APPROVAL BLOCK
            }
          } else if (prefetched.has(call)) {
            const done = prefetched.get(call)
            result = done.result
            isError = done.isError
          } else {
            try {
              result = await this.tools.execute(call.name, call.args, { projectId, userId })
            } catch (err) {
              result = { error: err.message || 'Tool execution failed' }
              isError = true
            }
          }

          await emitEvent({
            type: 'toolCallFinished',
            id: call.id,
            name: call.name,
            result,
            isError,
          })

          // "nothing compiled yet" (status 'none') is an answer, not a failure.
          const isFailed = Boolean(
            isError ||
              result?.error ||
              result?.status === 'noMatch' ||
              result?.status === 'ambiguous'
          )

          if (isFailed) {
            turnFailed = true
            const callSig = `${call.name}:${JSON.stringify(call.args)}`
            const repeats = (failedCallSignatures.get(callSig) ?? 0) + 1
            failedCallSignatures.set(callSig, repeats)
            if (repeats >= IDENTICAL_FAILURE_LIMIT) {
              await finishWithError(
                'runawayToolLoop',
                `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`
              )
              break
            }
            if (repeats === IDENTICAL_FAILURE_LIMIT - 1 && result && typeof result === 'object') {
              result = {
                ...result,
                repeated: `This exact ${call.name} call has now failed ${repeats} times with the same arguments; one more identical failure ends the run. Change the arguments (re-read the file and copy its current text) or take a different approach.`,
              }
            }
          } else {
            turnSucceeded = true
            // The project changed, so a call that failed before may succeed now.
            if (result?.status === 'applied') failedCallSignatures.clear()
          }

          // Cycle detection: X, Y, X, Y with identical names AND arguments is a
          // loop making no progress (compile -> read result -> compile -> read
          // result). Comparing names alone would also stop edit -> compile ->
          // edit -> compile, which is how compile errors get fixed.
          recentCallSignatures.push({
            name: call.name,
            signature: `${call.name}:${JSON.stringify(call.args ?? {})}`,
          })
          if (recentCallSignatures.length >= 4) {
            const [a, b, c, d] = recentCallSignatures.slice(-4)
            if (
              a.signature === c.signature &&
              b.signature === d.signature &&
              a.signature !== b.signature
            ) {
              await finishWithError(
                'runawayToolLoop',
                `Stopped repeated alternating tool loop between ${a.name} and ${b.name}.`
              )
              break
            }
          }

          messages.push({
            role: 'tool',
            toolCallId: call.id,
            // Gemini names the functionResponse after this, and Anthropic's
            // is_error comes from isError; without them every result looks like
            // a successful call to a function named "tool".
            name: call.name,
            content: renderToolResult(call.name, result),
            isError: isFailed,
          })
        }

        if (shouldStop || controller.signal.aborted) break

        if (turnSucceeded) {
          failedTurns = 0
        } else if (turnFailed) {
          failedTurns += 1
          if (failedTurns >= FAILED_TURN_LIMIT) {
            await finishWithError(
              'consecutiveToolFailures',
              `Stopped after ${failedTurns} turns in a row in which every tool call failed. Please check the file contents or provide more specific instructions.`
            )
          }
        }
      }

      if (controller.signal.aborted) {
        await emitEvent({ type: 'turnFinished', reason: 'aborted' })
        await this.store.updateStatus(runId, 'stopped')
      } else if (!shouldStop) {
        await emitEvent({
          type: 'turnFinished',
          reason: 'stop',
        })
        await this.store.updateStatus(runId, 'done')
      }
```
TRAP: after pasting, the file must contain exactly one `const isCreate = call.name === 'create_file'` and no `// APPROVAL BLOCK` line. Check with `grep -c "APPROVAL BLOCK\|const isCreate" modules/ai-assist/app/src/AiAssistRunManager.mjs` → prints `1`.
TRAP: the pasted approval code sets `userDeclinedEdit = true` when the user declines. Keep that line: it is what makes the next edit get the `rejected` result above.
CHECK: `grep -n "toolsToUse\|consecutiveFailures\b" modules/ai-assist/app/src/AiAssistRunManager.mjs` prints nothing.

- [x] **Step 5: Run to verify the whole file passes**

Same command as Task 1 Step 2. Expected: 0 failures, including the existing approval tests (`'suspends on edit_file…'`, `'propagates rejection note…'`, `'settles approval on timeout…'`), `'does not stop an edit-compile style loop…'`, `'stops an alternating loop…'`, `'executes the leading read-only calls of a turn concurrently…'`, `'renders tool results as text…'` and `'runs an unlimited number of tool calls'`.

---

### Task 4: Browser run loop — same rules as the server

**Files:**
- Replace: `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts` (whole file)
- Test: `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts`

- [x] **Step 1: Update existing tests and write the new ones**

(a) Test `'stops with runawayToolLoop when identical failing tool call repeats'` (line 665). In its `turns` array, add a third turn identical to the second (id `'c3'`), so it reads:
```ts
    const turns = [
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool_call',
          id: 'c2',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool_call',
          id: 'c3',
          name: 'edit_file',
          args: { path: 'ref.bib', oldText: 'missing', newText: 'new' },
        },
        { type: 'done', stopReason: 'tool_calls' },
      ],
    ]
```
Then change `const { client } = fakeClient(turns)` to `const { client, requests } = fakeClient(turns)` in that test, and after the existing `expect(runawayError.message)…` line add:
```ts
    // The second identical failure carried a warning; the third stopped the run.
    expect(requests).to.have.length(3)
    expect(requests[2].messages.at(-1).content).to.include('failed 2 times')
```

(b) Test `'stops with consecutiveToolFailures after 5 consecutive failures'` (line 720): rename it to `'stops with consecutiveToolFailures after 4 turns in which every call failed'`, delete the fifth turn (the one with id `'c5'`) from `turns`, and replace:
```ts
    expect(consecutiveError.message).to.match(/5 consecutive failed/i)
```
with:
```ts
    expect(consecutiveError.message).to.match(/4 turns in a row/i)
```

(c) Add at the end of the top-level `describe('runAgent', …)`, before its final `})`:
```ts
  it('re-checks the context budget before every request, not only the first', async function () {
    const bigTool: AgentTool = {
      suspends: false,
      mutates: false,
      spec: { name: 'big', description: 'big', parameters: { type: 'object', properties: {} } },
      async execute() {
        return { text: 'x'.repeat(40000) }
      },
    }
    const { client, requests } = fakeClient([
      [{ type: 'tool_call', id: 'c1', name: 'big', args: {} }],
      [{ type: 'text', text: 'never sent' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { big: bigTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
        limits: { contextWindow: 8000, maxOutputTokens: 1000 },
      })
    )

    expect(requests).to.have.length(1)
    expect(events.some(e => e.type === 'error' && (e as any).code === 'contextExhausted')).to.equal(true)
  })

  it('stops an alternating loop whose calls repeat exactly', async function () {
    const turns = Array.from({ length: 6 }, (_, i) => [
      { type: 'tool_call', id: `c${i}`, name: 'echo', args: { n: i % 2 } },
    ])
    const { client, requests } = fakeClient(turns)
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { echo: echoTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    const error: any = events.find(e => e.type === 'error')
    expect(error.code).to.equal('runawayToolLoop')
    expect(error.message).to.match(/alternating/)
    expect(requests).to.have.length(4)
  })

  it('never runs an edit that was cut off at the output limit', async function () {
    let executed = false
    const editTool: AgentTool = {
      suspends: false,
      mutates: true,
      spec: { name: 'edit_file', description: 'edit', parameters: { type: 'object', properties: {} } },
      async execute() {
        executed = true
        return { status: 'applied' }
      },
    }
    const { client, requests } = fakeClient([
      [
        { type: 'tool_call', id: 'c1', name: 'edit_file', args: { path: 'main.tex', newText: 'half', _repaired: true } },
        { type: 'stop', reason: 'max_tokens' },
      ],
      [{ type: 'text', text: 'ok' }],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: { edit_file: editTool },
        transcript: [{ id: '1', role: 'user', text: 'go' }],
        limits: { contextWindow: 128000, maxOutputTokens: 4096 },
      })
    )

    expect(executed).to.equal(false)
    expect(events.some(e => e.type === 'awaitingApproval')).to.equal(false)
    const assistant = requests[1].messages.find((m: any) => m.role === 'assistant')
    expect(assistant.toolCalls[0].args).to.deep.equal({ path: 'main.tex' })
    const tool = requests[1].messages.find((m: any) => m.role === 'tool')
    expect(tool.content).to.include('cut off at the 4096-token output limit')
  })

  it('reports a text reply cut off at the output limit', async function () {
    const { client } = fakeClient([
      [
        { type: 'text', text: 'A long answer that' },
        { type: 'stop', reason: 'max_tokens' },
      ],
    ])
    const { handle } = createFakeHandle()

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'go' }],
      })
    )

    expect(events.some(e => e.type === 'error' && (e as any).code === 'outputTruncated')).to.equal(true)
    expect(events.at(-1)).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
  })

  it('sends the context window with every request', async function () {
    const { client, requests } = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle()

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: '1', role: 'user', text: 'hi' }],
        limits: { contextWindow: 32000, maxOutputTokens: 2048 },
      })
    )

    expect(requests[0].contextWindow).to.equal(32000)
  })
```
(`fakeClient`, `createFakeHandle`, `collect`, `echoTool` and the `AgentTool` type are defined or imported at the top of this test file, lines 1-61.)

- [x] **Step 2: Run to verify they fail**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot modules/ai-assist/test/frontend/js/agent/run-agent.test.ts 2>&1 | grep -E "passing|failing|Error" | head
```
Expected: the updated and new tests fail.

- [x] **Step 3: Replace `run-agent.ts`**

Replace the entire content of `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts` with:
```ts
import {
  AgentMessage,
  DEFAULT_LIMITS,
  Limits,
  ProviderClient,
  ProviderError,
  ToolCall,
} from '../providers/types'
import { AgentEvent } from './agent-events'
import { AgentTool } from './tools/registry'
import { ProjectHandle } from './project-handle'
import { readOnlyHandle } from './readonly-handle'
import { TranscriptEntry } from './agent-messages'
import { buildRequest } from './context/build-request'
import { applyBudget } from './context/budget'
import {
  extractFencedToolCall,
  nextToolCallId,
  parseWholeMessageToolCall,
} from './text-tool-call'

/**
 * The same failing call, arguments and all: the second failure carries a
 * warning in its result, the third ends the run. Mirrors AiAssistRunManager.mjs.
 */
const IDENTICAL_FAILURE_LIMIT = 3
/**
 * Model turns in a row in which every tool call failed. Counted per turn, not
 * per call. Mirrors AiAssistRunManager.mjs.
 */
const FAILED_TURN_LIMIT = 4

/** The tools that change files. Their repaired arguments are never trusted. */
const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file'])

const CONTEXT_EXHAUSTED_MESSAGE =
  'This conversation no longer fits in the model context window. Start a new chat to continue.'

type StopReason = {
  code: 'runawayToolLoop' | 'consecutiveToolFailures'
  message: string
}

/**
 * Finds the tool calls that must not run, and strips the provider parser's
 * markers (`_parseError`, `_raw`, `_repaired`) from every call's arguments.
 * Mirrors classifyIncompleteCalls in AiAssistRunManager.mjs.
 */
function classifyIncompleteCalls(
  calls: ToolCall[],
  truncated: boolean
): Map<ToolCall, 'cutOff' | 'invalid'> {
  const incomplete = new Map<ToolCall, 'cutOff' | 'invalid'>()
  calls.forEach((call, index) => {
    const args: Record<string, unknown> =
      call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? { ...(call.args as Record<string, unknown>) }
        : {}
    const parseError = Boolean(args._parseError)
    const repaired = Boolean(args._repaired)
    delete args._parseError
    delete args._raw
    delete args._repaired
    const cutOff = truncated && index === calls.length - 1
    if (cutOff || parseError || (repaired && FILE_EDIT_TOOLS.has(call.name))) {
      incomplete.set(call, cutOff || repaired ? 'cutOff' : 'invalid')
      call.args = typeof args.path === 'string' ? { path: args.path } : {}
    } else {
      call.args = args
    }
  })
  return incomplete
}

function incompleteCallError(
  call: ToolCall,
  reason: 'cutOff' | 'invalid',
  maxTokens: number
): string {
  return reason === 'cutOff'
    ? `This ${call.name} call was cut off at the ${maxTokens}-token output limit, so its arguments are incomplete and it was not run. Make the change in smaller pieces: replace a smaller line range per edit_file call, or create the file with part of its content and add the rest with edit_file.`
    : `The arguments of this ${call.name} call were not valid JSON, so it was not run. Send the call again with complete arguments.`
}

export async function* runAgent({
  client,
  handle,
  tools,
  transcript,
  limits = DEFAULT_LIMITS.openai,
  cacheKey,
  signal,
  systemPrompt,
  requireTool,
}: {
  client: ProviderClient
  handle: ProjectHandle
  tools: Record<string, AgentTool>
  transcript: TranscriptEntry[]
  limits?: Limits
  cacheKey?: string
  signal?: AbortSignal
  /** Lets a narrow run (the compile-log fix) swap in its own prompt. */
  systemPrompt?: string
  /**
   * A tool the run exists to call. If the model tries to finish without ever
   * calling it, the loop sends one follow-up turn asking for the call instead
   * of ending on prose.
   */
  requireTool?: string
}): AsyncGenerator<AgentEvent> {
  const specs = Object.values(tools).map(tool => tool.spec)

  const request = buildRequest({
    transcript,
    limits,
    cacheKey,
    tools: specs.length ? specs : undefined,
    systemPrompt,
  })

  if (request.exhausted) {
    yield { type: 'error', code: 'contextExhausted', message: CONTEXT_EXHAUSTED_MESSAGE }
    return yield { type: 'turnFinished', reason: 'stop' }
  }

  const system = request.system
  let messages: AgentMessage[] = request.messages

  let failedTurns = 0
  const failedCallSignatures = new Map<string, number>()
  const recentCallSignatures: { name: string; signature: string }[] = []
  let requiredToolCalled = false
  let requiredToolNudged = false

  while (true) {
    // Tool results added during this run count against the window too, so
    // the budget is checked before every request, not only the first.
    const budgeted = applyBudget({ system, messages, limits, tools: specs })
    if (budgeted.exhausted) {
      yield { type: 'error', code: 'contextExhausted', message: CONTEXT_EXHAUSTED_MESSAGE }
      return yield { type: 'turnFinished', reason: 'stop' }
    }
    messages = budgeted.messages

    let text = ''
    const calls: ToolCall[] = []
    let inThinkTag = false
    let held = ''
    let convertedThisTurn = false
    let truncated = false

    try {
      for await (const chunk of client.streamChat({
        system,
        messages,
        maxTokens: limits.maxOutputTokens,
        contextWindow: limits.contextWindow,
        tools: specs.length ? specs : undefined,
        cacheHints: {
          ...request.cacheHints,
          lastStableMessage: messages.length >= 2 ? messages.length - 2 : null,
        },
        signal,
      })) {
        if (chunk.type === 'thinking') {
          yield { type: 'thinking', text: chunk.text }
        } else if (chunk.type === 'text') {
          let raw = chunk.text
          while (raw.length > 0) {
            if (!inThinkTag) {
              const startIdx = raw.indexOf('<think>')
              if (startIdx === -1) {
                held += raw
                const found = convertedThisTurn
                  ? null
                  : extractFencedToolCall(held, tools)
                if (found) {
                  if (found.before) yield { type: 'text', text: found.before }
                  text += found.before
                  calls.push(found.call)
                  convertedThisTurn = true
                  held = found.after
                } else if (held.includes('```json') && !held.slice(held.indexOf('```json') + 7).includes('```')) {
                  // Fence open but not closed: yield what precedes it and hold
                  // the rest until the closing fence arrives.
                  const open = held.indexOf('```json')
                  if (open > 0) {
                    yield { type: 'text', text: held.slice(0, open) }
                    text += held.slice(0, open)
                  }
                  held = held.slice(open)
                } else {
                  yield { type: 'text', text: held }
                  text += held
                  held = ''
                }
                break
              } else {
                const before = raw.slice(0, startIdx)
                if (before) {
                  text += before
                  yield { type: 'text', text: before }
                }
                inThinkTag = true
                raw = raw.slice(startIdx + '<think>'.length)
              }
            } else {
              const endIdx = raw.indexOf('</think>')
              if (endIdx === -1) {
                yield { type: 'thinking', text: raw }
                break
              } else {
                const thinkPart = raw.slice(0, endIdx)
                if (thinkPart) {
                  yield { type: 'thinking', text: thinkPart }
                }
                inThinkTag = false
                raw = raw.slice(endIdx + '</think>'.length)
              }
            }
          }
        } else if (chunk.type === 'tool_call') {
          const id = chunk.id || nextToolCallId('call')
          calls.push({ id, name: chunk.name, args: chunk.args })
        } else if (chunk.type === 'stop') {
          truncated = true
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
        status: error?.status,
        hint: error?.hint,
        upstreamCode: error?.upstreamCode,
        upstreamType: error?.upstreamType,
      }
      return yield { type: 'turnFinished', reason: 'stop' }
    }

    if (signal?.aborted) {
      return yield { type: 'turnFinished', reason: 'aborted' }
    }

    if (held) {
      yield { type: 'text', text: held }
      text += held
      held = ''
    }

    if (calls.length === 0 && !convertedThisTurn) {
      const rescued = parseWholeMessageToolCall(text, tools)
      if (rescued) {
        calls.push(rescued)
        text = ''
      }
    }

    if (calls.length === 0) {
      messages.push({ role: 'assistant', content: text })
      if (
        requireTool &&
        tools[requireTool] &&
        !requiredToolCalled &&
        !requiredToolNudged
      ) {
        requiredToolNudged = true
        messages.push({
          role: 'user',
          content: `You ended without calling ${requireTool}. Do not explain again — call ${requireTool} now with the change, then write one short sentence on what it changes.`,
        })
        continue
      }
      if (truncated) {
        yield {
          type: 'error',
          code: 'outputTruncated',
          message: `The reply was cut off at the ${limits.maxOutputTokens}-token output limit. Raise "Max output tokens" in the AI provider settings, or ask for a shorter answer.`,
        }
      }
      return yield { type: 'turnFinished', reason: 'stop' }
    }

    const incomplete = classifyIncompleteCalls(calls, truncated)

    messages.push({ role: 'assistant', content: text, toolCalls: calls })

    let turnSucceeded = false
    let turnFailed = false

    for (const call of calls) {
      yield {
        type: 'toolCallStarted',
        id: call.id,
        name: call.name,
        args: call.args,
      }

      const tool = tools[call.name]
      let result: unknown
      let isError = false

      const reason = incomplete.get(call)
      if (reason) {
        result = {
          status: 'error',
          error: incompleteCallError(call, reason, limits.maxOutputTokens),
        }
        isError = true
      } else if (!tool) {
        result = { error: `Unknown tool: ${call.name}` }
        isError = true
      } else {
        if (call.name === requireTool) requiredToolCalled = true
        if (tool.suspends) {
          yield { type: 'awaitingApproval', id: call.id, edit: call.args as any }
        }
        try {
          const toolHandle = tool.mutates ? handle : readOnlyHandle(handle)
          result = await tool.execute(call.args, toolHandle, { signal })
          isError = Boolean((result as any)?.error)
        } catch (error: any) {
          // A broken tool is data for the model, never the end of the run.
          result = { error: error?.message ?? 'The tool failed.' }
          isError = true
        }
      }

      const status = (result as any)?.status
      const isFailed =
        isError ||
        status === 'noMatch' ||
        status === 'ambiguous'
      let stop: StopReason | null = null

      if (isFailed) {
        turnFailed = true
        const callSig = `${call.name}:${JSON.stringify(call.args)}`
        const repeats = (failedCallSignatures.get(callSig) ?? 0) + 1
        failedCallSignatures.set(callSig, repeats)

        if (repeats >= IDENTICAL_FAILURE_LIMIT) {
          stop = {
            code: 'runawayToolLoop',
            message: `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`,
          }
        } else if (repeats === IDENTICAL_FAILURE_LIMIT - 1 && result && typeof result === 'object') {
          result = {
            ...(result as object),
            repeated: `This exact ${call.name} call has now failed ${repeats} times with the same arguments; one more identical failure ends the run. Change the arguments (re-read the file and copy its current text) or take a different approach.`,
          }
        }
      } else {
        turnSucceeded = true
        // The project changed, so a call that failed before may succeed now.
        if (status === 'applied') failedCallSignatures.clear()
      }

      // X, Y, X, Y with identical names and arguments makes no progress.
      // Mirrors the server loop.
      if (!stop) {
        recentCallSignatures.push({
          name: call.name,
          signature: `${call.name}:${JSON.stringify(call.args ?? {})}`,
        })
        if (recentCallSignatures.length >= 4) {
          const [a, b, c, d] = recentCallSignatures.slice(-4)
          if (
            a.signature === c.signature &&
            b.signature === d.signature &&
            a.signature !== b.signature
          ) {
            stop = {
              code: 'runawayToolLoop',
              message: `Stopped repeated alternating tool loop between ${a.name} and ${b.name}.`,
            }
          }
        }
      }

      yield { type: 'toolCallFinished', id: call.id, result, isError }

      const rendered =
        tool?.render && !isError ? tool.render(result) : JSON.stringify(result)

      const safeContent =
        typeof rendered === 'string' && rendered.trim().length > 0
          ? rendered
          : '(empty result)'

      messages.push({
        role: 'tool',
        toolCallId: call.id || nextToolCallId('call'),
        name: call.name,
        content: safeContent,
        isError,
      })

      if (stop) {
        // Every tool call the assistant made needs a result, or the next
        // message in this conversation is rejected by the provider.
        for (const skipped of calls.slice(calls.indexOf(call) + 1)) {
          messages.push({
            role: 'tool',
            toolCallId: skipped.id || nextToolCallId('call'),
            name: skipped.name,
            content: JSON.stringify({ error: 'Not run: the turn was stopped.' }),
            isError: true,
          })
        }
        yield { type: 'error', ...stop }
        return yield { type: 'turnFinished', reason: 'stop' }
      }

      if (signal?.aborted) {
        return yield { type: 'turnFinished', reason: 'aborted' }
      }
    }

    if (turnSucceeded) {
      failedTurns = 0
    } else if (turnFailed) {
      failedTurns += 1
      if (failedTurns >= FAILED_TURN_LIMIT) {
        yield {
          type: 'error',
          code: 'consecutiveToolFailures',
          message: `Stopped after ${failedTurns} turns in a row in which every tool call failed. Please check the file contents or provide more specific instructions.`,
        }
        return yield { type: 'turnFinished', reason: 'stop' }
      }
    }
  }
}
```
Differences from the old file, so you can check your work: new imports (`applyBudget`); new constants and the two helpers; `let messages` with a budget check at the top of every loop iteration; `contextWindow` and a recomputed `lastStableMessage` in the request; the `stop` chunk; the `outputTruncated` error after the `requireTool` nudge; `classifyIncompleteCalls`; `requiredToolCalled` is set only when the tool actually exists and runs; the reachable `repeated` warning; per-turn failure counting; alternating-loop detection. The unused `steps` counter is gone. The streaming text/`<think>`/fenced-tool-call parsing is unchanged.
TRAP: `'outputTruncated'` must be in `ProviderErrorCode` (WS-A Task 2 Step 8), and `{ type: 'stop'; reason: 'max_tokens' }` in `ChatChunk`, and `contextWindow?` in `ChatRequest`; otherwise the type check in Task 5 fails.

- [x] **Step 4: Run to verify the whole file passes**

Same command as Step 2. Expected: 0 failing, including `requireTool` tests, `'runs an unlimited number of tool calls'` (35 identical successful calls are not an alternating loop), `'blocks a second suspending edit…'`, `'passes cache hints through to the provider'` and `'continues turn when user rejects an edit…'`.

---

### Task 5: Final verification and redeploy (for WS-A, WS-B and WS-C together)

- [x] **Step 1: Full backend module suite**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
```
Expected: 0 failed.

- [x] **Step 2: Full frontend module suite** (command in Global Constraints). Expected: 0 failing.

- [x] **Step 3: Type-check the touched TypeScript files**
```bash
timeout 600 ../../node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -E "ai-assist/(agent/(run-agent|context/budget|tools/|use-project-handle)|providers/types)"
```
Expected: no output. Errors in other files that already existed are not yours.

- [x] **Step 4: Redeploy the dev server and smoke-test**

The ai-assist dev stack bind-mounts this worktree and runs `node --watch`, so restarting the web container picks up server code; the frontend is rebuilt by the container's webpack watcher. Docker commands need the sandbox disabled.
```bash
docker restart ai-assist-web-1
```
Wait until `curl -s -o /dev/null -w '%{http_code}' http://localhost:81/login` prints `200` (poll every few seconds; it can take a minute or two). If the container name is different, find it with `docker ps --format '{{.Names}}' | grep ai-assist`.

Smoke test, logged in as `dangdoan2206@gmail.com` / `dang22062003` on `http://<host>:81`, in a project with a compile error:
1. In the AI chat, ask "compile the project and tell me the first error". The tool-call card shows the compile; the reply names the error with its `l.N` context.
2. Ask for an edit that adds a few lines, then approve it. The `edit_file` result in the tool-call details includes `startLine`, `endLine`, `lineDelta`.
3. Ask for an edit and **decline** it. The model answers in the same run instead of stopping silently.
4. Click "Suggest fix" on a log entry. The fix run still proposes an edit.

Report to the user: URL `http://<host>:81`, and what you observed for each of the 4 checks.

---

## Out of scope (checked, do not do)

- **Step or tool-call budgets.** Rejected by the user. Only failure patterns stop a run.
- **Parallel read calls in the browser loop.** The browser tools share the editor handle; concurrency was not verified.
- **Automatically continuing a reply cut off at the output limit** (sending "continue"). The model gets the error for a cut-off tool call and decides; a cut-off text reply is reported to the user.
- **Using provider-reported token usage** to calibrate the budget estimate. Separate change.
- **Changing `KEEP_RECENT_TOOL_RESULTS`, `MARGIN_FRACTION` or `CHARS_PER_TOKEN`.**
- **Changing `extractTextToolCall` / text-tool-call rescue.**
