# AI Assist Harness WS2: Server Agent Loop Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the server-side agent loop from killing normal work, sending requests providers reject, and asking the user to approve edits that cannot apply.

**Architecture:** All changes are in the server run loop (`AiAssistRunManager.mjs`) and the server tool executor (`AiAssistTools.mjs`). There are five fixes: (1) tool-result messages carry the tool `name` and `isError`, (2) the alternating-loop detector compares full call signatures instead of tool names, (3) context trimming drops whole turns so a conversation never starts with an orphaned assistant or tool message, (4) a declined edit removes only the file-editing tools, not every tool, and (5) `edit_file` is planned before approval, so an edit that cannot apply returns `noMatch`/`ambiguous` without a pointless approval prompt.

**Tech Stack:** Node.js ES modules (`.mjs`), Vitest + Chai + Sinon.

**Spec:** None. This plan comes from a code review of the `ai-assist` module done on 2026-09-17. The "Background" section records the verified findings.

## Global Constraints

- **Never run `git commit`, `git push`, `git stash`, or any history-altering git command.** Leave every change uncommitted. Each task ends with a verification step, not a commit step. This overrides any sub-skill instruction to commit.
- **Another session may be editing this worktree at the same time.** Line numbers were verified on 2026-09-17 against the working tree, but WS1 (`2026-09-17-ai-assist-harness-ws1-run-stream-reliability.md`) also edits `AiAssistRunManager.mjs` (its Task 5 renames `emitText` to `emitChunk`). If a quoted "current code" block does not match, re-read the file and apply the change to the equivalent code. Never overwrite unrelated edits.
- **Working directory for all commands:**
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Backend test runner (Vitest, npx-cached binary; `XDG_DATA_HOME` is required):**
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path>
  ```
- **Baseline before Task 1:**
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
  ```
  Write the counts down. Expected: 0 failed.
- **Do not fix model behaviour by editing system prompts.** Every fix here is in the harness or the tools. This is a standing project rule.
- **Keep output small.** Grep test output for `Tests |×|FAIL|Error`.
- **Style:** 2-space indentation, single quotes, no semicolons, matching the file.

## Background (verified findings this plan fixes)

1. **Tool results lose `name` and `isError`.** `AiAssistRunManager.mjs:521-525` pushes `{ role: 'tool', toolCallId, content }`. `toGeminiContents` in `AiAssistProviders.mjs` sends `name: message.name || 'tool'` as the Gemini `functionResponse` name, so every Gemini tool result claims to come from a function called `tool`. The Anthropic client sends `is_error: Boolean(message.isError)`, which is therefore always `false`, even for failures.
2. **The loop detector stops the normal fix loop.** `AiAssistRunManager.mjs:504-519` stops any `A, B, A, B` pattern of tool *names*. `edit_file → compile_project → edit_file → compile_project`, the normal way to fix compile errors, is stopped with "Stopped repeated alternating tool loop". Only calls with identical arguments are a real loop.
3. **Trimming can produce requests providers reject.** Pass 3 of `applyContextBudget` (`AiAssistRunManager.mjs:161-164`) shifts one message at a time from the front. It can leave the conversation starting with an assistant message whose tool calls lost their user turn, or with a `tool` message whose `tool_use` was dropped. Anthropic and OpenAI reject both with HTTP 400.
4. **One declined edit disables every tool.** `AiAssistRunManager.mjs:292-294` sends `tools: []` for the rest of the run once `userDeclinedEdit` is set. The model can no longer read or search to address the user's feedback. Only the file-editing tools should go.
5. **Approval before feasibility.** For `edit_file`, the manager asks the user to approve (`setPendingApproval`, line 389) *before* the tool checks whether `oldText` exists. The user reviews a diff that cannot apply, and then the tool fails with an error string. The server tool also returns only `{ error }` for these failures, while the browser tool (`frontend/.../agent/tools/edit-file.ts:166-178`) and the manager's failure check (`AiAssistRunManager.mjs:473-478`) use `status: 'noMatch'` / `status: 'ambiguous'`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `modules/ai-assist/app/src/AiAssistRunManager.mjs` | Modify | Tool message fields, loop detector, whole-turn trimming, declined-edit tool filtering, edit preflight before approval. |
| `modules/ai-assist/app/src/AiAssistTools.mjs` | Modify | Extract `_planEdit`, add `checkEdit`, return `noMatch`/`ambiguous` statuses. |
| `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs` | Modify | Tests for all manager changes. |
| `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs` | Modify | Tests for `checkEdit` and edit statuses. |

---

### Task 1: Tool result messages carry `name` and `isError`

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs:521-525`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Interfaces:**
- Produces: tool messages shaped `{ role: 'tool', toolCallId: string, name: string, content: string, isError: boolean }`. WS3 Task 5 changes how `content` is produced; keep these field names.

- [x] **Step 1: Write the failing test**

Add inside the top-level `describe('AiAssistRunManager', ...)`:

```js
  it('sends tool results back to the provider with the tool name and error flag', async function () {
    let secondRequest = null
    let callCount = 0
    mockClient.streamChat.callsFake(async function* (opts) {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'missing.tex' } }
      } else {
        secondRequest = opts
        yield { type: 'text', text: 'done' }
      }
    })
    mockTools.execute.resolves({ error: 'File not found: missing.tex' })

    await manager.startRun({
      runId: 'run-tool-msg',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'read it' }],
      providerSettings: { type: 'google', apiKey: 'k', model: 'gemini-2.5-pro' },
    })

    const toolMessage = secondRequest.messages.find(m => m.role === 'tool')
    expect(toolMessage).to.include({ toolCallId: 'r1', name: 'read_file', isError: true })
  })
```

- [x] **Step 2: Run to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs 2>&1 | grep -E "Tests |×" | head -5
```
Expected: 1 failed (`expected { … } to have property 'name'`).

- [x] **Step 3: Implement**

Replace (currently lines 521-525):
```js
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(result),
          })
```
with:
```js
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            // Gemini names the functionResponse after this, and Anthropic's
            // is_error comes from isError; without them every result looks like
            // a successful call to a function named "tool".
            name: call.name,
            content: JSON.stringify(result),
            isError: Boolean(isFailed),
          })
```

`isFailed` is already declared a few lines above this push (the `const isFailed = isError || result?.error || ...` block). Do not move it.

- [x] **Step 4: Run to verify it passes**

Same command as Step 2. Expected: 0 failed.

---

### Task 2: The loop detector compares full call signatures

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs:282` (declaration) and `:504-519` (detector)
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Interfaces:**
- Produces: the same stop event as today, `{ type: 'error', code: 'runawayToolLoop', message }`, followed by `turnFinished` with `reason: 'stop'`. It now only fires when the last four calls are `X, Y, X, Y` with identical names *and* arguments.

- [x] **Step 1: Write the failing tests**

```js
  it('does not stop an edit-compile style loop whose calls change between rounds', async function () {
    const script = [
      { name: 'read_file', args: { path: 'main.tex', from: 1, to: 40 } },
      { name: 'compile_project', args: {} },
      { name: 'read_file', args: { path: 'main.tex', from: 41, to: 80 } },
      { name: 'compile_project', args: {} },
    ]
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      const step = script[callCount]
      callCount++
      if (step) {
        yield { type: 'tool_call', id: `c${callCount}`, ...step }
      } else {
        yield { type: 'text', text: 'All fixed.' }
      }
    })

    await manager.startRun({
      runId: 'run-progress',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'fix the build' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    const loopErrors = mockStore.appendEvent
      .getCalls()
      .filter(c => c.args[1]?.code === 'runawayToolLoop')
    expect(loopErrors).to.have.lengthOf(0)
    expect(mockStore.appendEvent.calledWith('run-progress', sinon.match({ type: 'text', text: 'All fixed.' }))).to.be.true
  })

  it('stops an alternating loop whose calls repeat exactly', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      const name = callCount % 2 === 1 ? 'compile_project' : 'get_compile_result'
      yield { type: 'tool_call', id: `c${callCount}`, name, args: {} }
    })

    await manager.startRun({
      runId: 'run-spin',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'check the build' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    expect(mockStore.appendEvent.calledWith('run-spin', sinon.match({ type: 'error', code: 'runawayToolLoop' }))).to.be.true
    expect(callCount).to.equal(4)
  })
```

- [x] **Step 2: Run to verify the first test fails**

Same command as Task 1 Step 2. Expected: `'does not stop an edit-compile style loop…'` fails; the second test already passes.

- [x] **Step 3: Implement**

Replace the declaration (currently line 282):
```js
      const recentToolNames = []
```
with:
```js
      const recentCallSignatures = []
```

Replace the detector (currently lines 504-519):
```js
          // Cycle detection for tool calls (e.g. compile -> get_log -> compile -> get_log)
          recentToolNames.push(call.name)
          if (recentToolNames.length >= 4) {
            const last4 = recentToolNames.slice(-4)
            if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
              await emitEvent({
                type: 'error',
                code: 'runawayToolLoop',
                message: `Stopped repeated alternating tool loop between ${last4[0]} and ${last4[1]}.`,
              })
              await emitEvent({ type: 'turnFinished', reason: 'stop' })
              await this.store.updateStatus(runId, 'done')
              shouldStop = true
              break
            }
          }
```
with:
```js
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
              await emitEvent({
                type: 'error',
                code: 'runawayToolLoop',
                message: `Stopped repeated alternating tool loop between ${a.name} and ${b.name}.`,
              })
              await emitEvent({ type: 'turnFinished', reason: 'stop' })
              await this.store.updateStatus(runId, 'done')
              shouldStop = true
              break
            }
          }
```

Confirm the old name is gone:
```bash
grep -n "recentToolNames" modules/ai-assist/app/src/AiAssistRunManager.mjs
```
Expected: no output.

- [x] **Step 4: Run the manager tests**

Same command. Expected: 0 failed.

---

### Task 3: Context trimming drops whole turns

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs:161-169` (pass 3 of `applyContextBudget`)
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs` (inside `describe('applyContextBudget', ...)`)

**Interfaces:**
- Produces: `applyContextBudget({ system, messages, limits, tools })` returns `{ messages, exhausted }` as before, with a new invariant: when `exhausted` is `false`, `messages[0].role === 'user'`.

- [x] **Step 1: Write the failing test**

Add inside `describe('applyContextBudget', ...)`:

```js
    it('drops whole turns so the trimmed conversation still opens with a user message', function () {
      const messages = [
        { role: 'user', content: 'first request ' + 'a'.repeat(6000) },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'main.tex' } }],
        },
        { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'x'.repeat(400) },
        { role: 'user', content: 'second request' },
        { role: 'assistant', content: 'second reply' },
        { role: 'user', content: 'latest message' },
      ]

      const result = applyContextBudget({
        system: 'Sys',
        messages,
        limits: { contextWindow: 2000, maxOutputTokens: 100 },
      })

      expect(result.exhausted).to.equal(false)
      expect(result.messages[0].role).to.equal('user')
      expect(result.messages[0].content).to.equal('second request')
      expect(result.messages.some(m => m.role === 'tool')).to.equal(false)
      expect(result.messages.at(-1).content).to.equal('latest message')
    })

    it('reports exhausted instead of cutting inside the only remaining turn', function () {
      const messages = [
        { role: 'user', content: 'only request' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'main.tex' } }],
        },
        { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'x'.repeat(20000) },
      ]

      const result = applyContextBudget({
        system: 'Sys',
        messages,
        limits: { contextWindow: 2000, maxOutputTokens: 100 },
      })

      expect(result.exhausted).to.equal(true)
      expect(result.messages[0].role).to.equal('user')
    })
```

Why this data fails today: the budget is `2000 - 100 - 200 = 1700` tokens at 3.7 chars per token. The first user message alone is about 1626 tokens. The one tool result is inside `KEEP_RECENT_TOOL_RESULTS` (3), so pass 1 cannot stub it, and there are fewer than `KEEP_RECENT_ASSISTANT_TURNS` (3) assistant messages, so pass 2 does nothing. Today's pass 3 shifts only the first message, leaving `[assistant(toolCalls), tool, user, …]`, which fits but starts with an assistant.

In the second test, today's code shifts the user message and the assistant message and leaves a lone `tool` message.

- [x] **Step 2: Run to verify both fail**

Same command as Task 1 Step 2. Expected: 2 failed.

- [x] **Step 3: Implement**

Replace (currently lines 161-169):
```js
  // Pass 3: If still over budget, drop oldest turns from the front
  while (working.length > 1 && !fits()) {
    working.shift()
  }

  return {
    messages: working,
    exhausted: !fits(),
  }
```
with:
```js
  // Pass 3: drop whole turns from the front. A turn runs from a user message
  // up to the next one. Cutting inside a turn leaves an assistant message or a
  // tool result without the message it answers, which providers reject with a
  // 400. If only one turn is left and it still does not fit, report exhaustion.
  while (!fits()) {
    const nextUser = working.findIndex(
      (message, index) => index > 0 && message.role === 'user'
    )
    if (nextUser === -1) break
    working.splice(0, nextUser)
  }

  return {
    messages: working,
    exhausted: !fits(),
  }
```

> **TRAP — the existing test `'drops oldest turns when eliding tool results is still not enough to fit budget'` must still pass.** It trims `[u1, a1, u2, a2, u3]` and only checks that the result is shorter, not exhausted, and ends with `'latest message'`. With whole-turn dropping, the result is `[u2, a2, u3]` or `[u3]`, and both satisfy it. Do not change that test.

> **TRAP — `'emits contextExhausted and finishes turn when conversation exceeds context window'`** sends a single 100 000-character user message. `findIndex` returns `-1`, the loop breaks, and `exhausted` is `true`, which is what that test expects.

- [x] **Step 4: Run the manager tests**

Same command. Expected: 0 failed.

---

### Task 4: A declined edit removes only the file-editing tools

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs:292-294`
- Modify: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs` (the existing test `'stops prompting user when user rejects an edit and completes turn cleanly'`, currently lines 180-219)

**Interfaces:**
- Produces: `FILE_EDIT_TOOLS` (module-level `Set` of `'edit_file'` and `'create_file'`), exported for tests.

- [x] **Step 1: Update the existing test to the new contract (it will fail)**

In `'stops prompting user when user rejects an edit and completes turn cleanly'`:

1. At the top of the test body, before `mockClient.streamChat.callsFake`, give the tools real specs:
```js
    mockTools.getToolSpecs = () => [
      { name: 'read_file', description: 'r', parameters: {} },
      { name: 'search_text', description: 's', parameters: {} },
      { name: 'edit_file', description: 'e', parameters: {} },
      { name: 'create_file', description: 'c', parameters: {} },
    ]
```
2. Replace:
```js
    // Tools must be disabled in subsequent step to prevent continuous prompting
    expect(passedToolsInSecondCall).to.be.an('array').that.is.empty
```
with:
```js
    // Only file-editing tools are withdrawn; the model can still read and
    // search to address the user's feedback.
    expect(passedToolsInSecondCall.map(t => t.name)).to.deep.equal(['read_file', 'search_text'])
```

- [x] **Step 2: Run to verify it fails**

Same command as Task 1 Step 2. Expected: that test fails (`expected [] to deeply equal [ 'read_file', 'search_text' ]`).

- [x] **Step 3: Implement**

Add near the top of `AiAssistRunManager.mjs`, after the `DEFAULT_SYSTEM_PROMPT` constant (or after the imports if WS3 already removed that constant):
```js
// Withdrawn for the rest of a run once the user declines an edit, so the model
// stops proposing changes but can still read and search to answer the feedback.
export const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file'])
```

Replace (currently lines 292-294):
```js
        const toolsToUse = userDeclinedEdit
          ? []
          : (this.tools?.getToolSpecs ? this.tools.getToolSpecs() : [])
```
with:
```js
        const allToolSpecs = this.tools?.getToolSpecs ? this.tools.getToolSpecs() : []
        const toolsToUse = userDeclinedEdit
          ? allToolSpecs.filter(spec => !FILE_EDIT_TOOLS.has(spec.name))
          : allToolSpecs
```

> **TRAP — the existing guard still matters.** Further down, `if (call.name === 'edit_file' || call.name === 'create_file') { if (userDeclinedEdit) { … status: 'rejected' … shouldStop = true } }` handles a model that emits a withdrawn tool anyway (some OpenAI-compatible gateways do not enforce the tool list). Leave that block unchanged.

- [x] **Step 4: Run the manager tests**

Same command. Expected: 0 failed.

---

### Task 5: Plan `edit_file` before asking for approval

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (the `edit_file` case, currently lines 495-605; the traversal check in `execute`, currently lines 431-437)
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs:362-369` (edit target resolution) and `:381-455` (approval branch)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`, `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Interfaces:**
- Produces (tools): `async checkEdit(args, { projectId }): Promise<{ status: 'ok', path: string } | { status: 'noMatch' | 'ambiguous' | 'error', error: string, matches?: number }>`. It never writes.
- Produces (tools): the `edit_file` execute result gains `status` on failures: `{ status: 'noMatch', error }`, `{ status: 'ambiguous', matches, error }`, `{ status: 'error', error }`. Success is unchanged: `{ status: 'applied', path, note? }`.
- Consumes (manager): `this.tools.checkEdit` when present. The manager stops calling `this.tools.resolveEditTarget`, but leave that method and its tests in place.

- [x] **Step 1: Write the failing tools tests**

Add to `AiAssistTools.test.mjs`. The top-level `beforeEach` mocks give `main.tex` (doc id `doc-1`) the lines `['line 1', 'line 2: target text', 'line 3']` and every other doc `['other file', 'no match here']`. Verified on 2026-09-17: `locateAnchorInText` returns `null` for `'line'` (it occurs 3 times) and for `'nope'`.

```js
  describe('edit planning', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    it('checkEdit accepts an edit whose anchor is unique, without writing', async function () {
      const res = await tools.checkEdit({ path: 'main.tex', oldText: 'target text', newText: 'x' }, ctx)
      expect(res).to.deep.equal({ status: 'ok', path: 'main.tex' })
      expect(mockDocUpdater.setDocument.called).to.equal(false)
    })

    it('checkEdit reports noMatch when the anchor is nowhere in the project', async function () {
      const res = await tools.checkEdit({ path: 'main.tex', oldText: 'nope', newText: 'x' }, ctx)
      expect(res.status).to.equal('noMatch')
      expect(res.error).to.be.a('string')
    })

    it('checkEdit reports ambiguous with the match count', async function () {
      const res = await tools.checkEdit({ path: 'main.tex', oldText: 'line', newText: 'x' }, ctx)
      expect(res.status).to.equal('ambiguous')
      expect(res.matches).to.equal(3)
    })

    it('checkEdit rejects path traversal', async function () {
      const res = await tools.checkEdit({ path: '../secret.tex', oldText: 'a', newText: 'b' }, ctx)
      expect(res.status).to.equal('error')
      expect(res.error).to.include('traversal')
    })

    it('edit_file returns a noMatch status instead of a bare error', async function () {
      const res = await tools.execute('edit_file', { path: 'main.tex', oldText: 'nope', newText: 'x' }, ctx)
      expect(res.status).to.equal('noMatch')
      expect(mockDocUpdater.setDocument.called).to.equal(false)
    })
  })
```

- [x] **Step 2: Run to verify they fail**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs 2>&1 | grep -E "Tests |×" | head -8
```
Expected: 5 failed (`tools.checkEdit is not a function`, and a missing `status`).

- [x] **Step 3: Extract the traversal check**

In `AiAssistTools.execute`, the current check (lines 431-437) is:
```js
    // Path sanitization for file operations
    if (args.path && typeof args.path === 'string') {
      const normalized = args.path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
        return { error: 'Path traversal forbidden: file path cannot reference parent directories.' }
      }
    }
```
Add this method to the class, just above `async execute(`:
```js
  _traversalError(args) {
    if (args?.path && typeof args.path === 'string') {
      const normalized = args.path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
        return 'Path traversal forbidden: file path cannot reference parent directories.'
      }
    }
    return null
  }
```
and replace the block in `execute` with:
```js
    // Path sanitization for file operations
    const traversal = this._traversalError(args)
    if (traversal) return { error: traversal }
```

- [x] **Step 4: Move the edit logic into `_planEdit` and add `checkEdit`**

Add these two methods to the class, just above `_traversalError`. `_planEdit` is the current `edit_file` case body with every `setDocument` call replaced by returning the new lines, and every failure given a `status`:

```js
  /**
   * Works out what an edit_file call would write, without writing it.
   *
   * Returns { result } for a call that cannot apply (the result is what the
   * model should see), or { doc, lines, path, note? } for one that can. The run
   * loop calls this before asking the user to approve, so nobody reviews a diff
   * that could never apply.
   */
  async _planEdit(projectId, args = {}) {
    if (args._parseError) {
      return {
        result: {
          status: 'error',
          error: 'Tool arguments were truncated or invalid JSON. Please perform smaller edits or edit one section at a time.',
        },
      }
    }
    if (!args.path || typeof args.path !== 'string' || !args.path.trim()) {
      return { result: { status: 'error', error: "Parameter 'path' is required for edit_file." } }
    }

    const doc = await this._resolveDoc(projectId, args.path)
    let docText = ''
    if (doc) {
      let lines = doc.lines || []
      try {
        const docObj = await this.docUpdater.getDocument(projectId, doc._id)
        if (docObj?.lines) lines = docObj.lines
      } catch {}
      docText = lines.join('\n')
    }

    // Whole file replacement:
    const hasDocClass = (args.newText || '').includes('\\documentclass')
    const isDocEmpty = !doc || docText.trim().length === 0
    const isFullFileReplace =
      (typeof args.oldText === 'string' && args.oldText.trim().length > 0 && normalizeLines(args.oldText).trim() === normalizeLines(docText).trim()) ||
      ((args.oldText === '' || args.oldText === undefined) && (hasDocClass || isDocEmpty))

    if (isFullFileReplace && doc) {
      return { doc, lines: (args.newText || '').split('\n'), path: doc.path }
    }

    // Append mode: only when oldText is explicitly empty string "" and NOT full-file LaTeX
    if (args.oldText === '' && doc) {
      const appended = docText.endsWith('\n') || docText.length === 0
        ? docText + (args.newText || '')
        : docText + '\n' + (args.newText || '')
      return { doc, lines: appended.split('\n'), path: doc.path }
    }

    if (typeof args.oldText !== 'string') {
      return {
        result: {
          status: 'error',
          error: `Parameter 'oldText' is required to replace text in ${args.path}. Provide the exact snippet from the file to replace, or pass the full file content if replacing the entire file.`,
        },
      }
    }

    const targetAnchor = args.oldText
    let resolvedDoc = doc
    let resolvedDocText = docText
    let targetMatch = doc ? locateAnchorInText(resolvedDocText, targetAnchor) : null

    // If not found in target file, search other project documents
    if (!targetMatch) {
      const allDocs = await this._getDocsList(projectId)
      for (const other of allDocs) {
        if (doc && String(other._id) === String(doc._id)) continue
        let otherText = (other.lines || []).join('\n')
        try {
          const fetched = await this.docUpdater.getDocument(projectId, other._id)
          if (fetched?.lines) otherText = fetched.lines.join('\n')
        } catch {}

        const candidateMatch = locateAnchorInText(otherText, targetAnchor)
        if (candidateMatch) {
          resolvedDoc = other
          resolvedDocText = otherText
          targetMatch = candidateMatch
          break
        }
      }
    }

    if (!targetMatch || !resolvedDoc) {
      if (resolvedDocText) {
        const matches = countOccurrences(resolvedDocText, targetAnchor)
        if (matches > 1) {
          const occurrences = findMatchingLines(resolvedDocText, targetAnchor)
          return {
            result: {
              status: 'ambiguous',
              matches,
              error: `That text appears ${matches} times in ${resolvedDoc.path} (around line(s) ${occurrences.join(', ')}). Include more surrounding context lines so the anchor is unique.`,
            },
          }
        }
      }
      return {
        result: {
          status: 'noMatch',
          error: `Could not find target text in ${args.path} or any other project file. If replacing text, copy an existing anchor line that appears in the file.`,
        },
      }
    }

    // Perform replacement
    let replaced
    if (targetMatch.charStart !== undefined && targetMatch.charEnd !== undefined) {
      replaced = resolvedDocText.slice(0, targetMatch.charStart) + (args.newText || '') + resolvedDocText.slice(targetMatch.charEnd)
    } else {
      const matchedAnchor = targetMatch.anchor
      const normDoc = normalizeLines(resolvedDocText)
      const normAnchor = normalizeLines(matchedAnchor)
      if (normDoc.includes(normAnchor)) {
        replaced = normDoc.replace(normAnchor, args.newText || '')
      } else {
        replaced = resolvedDocText.replace(matchedAnchor, args.newText || '')
      }
    }

    const note = doc && resolvedDoc.path !== doc.path
      ? `Text was located in '${resolvedDoc.path}' (redirected from '${args.path}').`
      : undefined
    return { doc: resolvedDoc, lines: replaced.split('\n'), path: resolvedDoc.path, note }
  }

  async checkEdit(args = {}, { projectId }) {
    const traversal = this._traversalError(args)
    if (traversal) return { status: 'error', error: traversal }
    const plan = await this._planEdit(projectId, args)
    return plan.result ?? { status: 'ok', path: plan.path }
  }
```

Then replace the entire `case 'edit_file': { … }` block in `execute` (from `case 'edit_file': {` through the `return { status: 'applied', path: resolvedDoc.path, ...(note ? { note } : {}) }` line and its closing `}`) with:
```js
      case 'edit_file': {
        const plan = await this._planEdit(projectId, args)
        if (plan.result) return plan.result
        await this.docUpdater.setDocument(projectId, plan.doc._id, userId, plan.lines, 'ai-assist')
        return { status: 'applied', path: plan.path, ...(plan.note ? { note: plan.note } : {}) }
      }
```

> **TRAP — copy the matching logic exactly.** The only differences from the old case body are: `setDocument` became `return { doc, lines, path }`, failure returns are wrapped in `{ result: { status, … } }`, and `let targetAnchor` became `const targetAnchor` (it is never reassigned). Do not "improve" the anchor matching here. It is covered by the editor-tooling plans (`2026-09-16-ai-assist-editor-tooling-ws2…`/`ws3…`).

> **TRAP — `countOccurrences`, `findMatchingLines`, `normalizeLines`, `locateAnchorInText`** are module-level functions in the same file. They are already in scope.

- [x] **Step 5: Run the tools tests**

Same command as Step 2. Expected: 0 failed, including the existing `'performs text replacement via edit_file'` and `'rejects path traversal attempts in read_file and edit_file'`.

- [x] **Step 6: Write the failing manager test**

Add to `AiAssistRunManager.test.mjs`:

```js
  it('does not ask for approval of an edit that cannot apply', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'e1', name: 'edit_file', args: { path: 'main.tex', oldText: 'nope', newText: 'x' } }
      } else {
        yield { type: 'text', text: 'Let me read the file first.' }
      }
    })
    mockTools.checkEdit = sinon.stub().resolves({ status: 'noMatch', error: 'Could not find target text' })

    await manager.startRun({
      runId: 'run-nomatch',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'edit' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    expect(mockStore.setPendingApproval.called).to.equal(false)
    expect(mockTools.execute.calledWith('edit_file')).to.equal(false)
    expect(mockStore.appendEvent.calledWith('run-nomatch', sinon.match({
      type: 'toolCallFinished',
      id: 'e1',
      result: sinon.match({ status: 'noMatch' }),
    }))).to.be.true
  })

  it('follows a planned edit to the file that actually contains the anchor', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'e2', name: 'edit_file', args: { path: 'main.tex', oldText: 'intro', newText: 'x' } }
      } else {
        yield { type: 'text', text: 'ok' }
      }
    })
    mockTools.checkEdit = sinon.stub().resolves({ status: 'ok', path: 'chapters/intro.tex' })

    const runPromise = manager.startRun({
      runId: 'run-redirect',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'edit' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })
    await new Promise(r => setTimeout(r, 10))

    expect(mockStore.setPendingApproval.calledWith('run-redirect', sinon.match({
      edit: sinon.match({ path: 'chapters/intro.tex' }),
    }))).to.be.true

    await manager.approveEdit('run-redirect', { accepted: true })
    await runPromise
  })
```

- [x] **Step 7: Run to verify the first test fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs 2>&1 | grep -E "Tests |×" | head -5
```
Expected: `'does not ask for approval of an edit that cannot apply'` fails; the redirect test fails too, because `checkEdit` is not called.

- [x] **Step 8: Implement in the manager**

Replace the target-resolution block (currently lines 362-369):
```js
          if (call.name === 'edit_file' && this.tools?.resolveEditTarget) {
            try {
              const target = await this.tools.resolveEditTarget(call.args, { projectId })
              if (target?.path && target.path !== call.args.path) {
                call.args.path = target.path
              }
            } catch {}
          }
```
with:
```js
          // Plan the edit before anything is shown to the user: an edit that
          // cannot apply goes straight back to the model, and one that applies
          // to a different file than named is shown under its real path.
          let editPlan = null
          if (call.name === 'edit_file' && this.tools?.checkEdit) {
            try {
              editPlan = await this.tools.checkEdit(call.args, { projectId })
              if (editPlan?.status === 'ok' && editPlan.path && editPlan.path !== call.args.path) {
                call.args.path = editPlan.path
              }
            } catch {
              editPlan = null
            }
          }
```

In the approval branch, the current structure is:
```js
          if (call.name === 'edit_file' || call.name === 'create_file') {
            if (userDeclinedEdit) {
              result = { … }
              shouldStop = true
            } else {
              await this.store.setPendingApproval(runId, { id: call.id, edit: call.args })
              …
            }
          } else {
```
Insert a new branch between the `userDeclinedEdit` branch and the `else`:
```js
            } else if (editPlan && editPlan.status !== 'ok') {
              result = editPlan
```
so it reads:
```js
          if (call.name === 'edit_file' || call.name === 'create_file') {
            if (userDeclinedEdit) {
              result = { … unchanged … }
              shouldStop = true
            } else if (editPlan && editPlan.status !== 'ok') {
              result = editPlan
            } else {
              await this.store.setPendingApproval(runId, { id: call.id, edit: call.args })
              … unchanged …
            }
          } else {
```

> **TRAP — do not set `isError = true` for a plan failure.** `isFailed` already counts `status: 'noMatch'` and `'ambiguous'` (and `result.error`) as failures for the consecutive-failure and identical-failure limits. `isError` means "the tool threw".

> **TRAP — `checkEdit` resolves `{ status: 'error' }` for traversal paths.** That also skips approval and returns the error, which is correct: a traversal path must never reach `setPendingApproval`.

- [x] **Step 9: Run the manager tests**

Same command as Step 7. Expected: 0 failed, including `'suspends on edit_file and resumes when approveEdit is called'` (its `mockTools` has no `checkEdit`, so `editPlan` stays `null` and approval proceeds as before).

---

### Task 6: Final verification and redeploy

- [x] **Step 1: Full backend module suite**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
```
Expected: 0 failed.

- [x] **Step 2: Redeploy and smoke-test**

Restart the dev web container (Docker needs the sandbox disabled):
```bash
docker restart ai-assist-web-1
```
Wait for `curl -s -o /dev/null -w '%{http_code}' http://localhost:81/login` to return `200`. Log in at `http://<host>:81` as `dangdoan2206@gmail.com` / `dang22062003`, open a project with a compile error, and ask the AI chat to fix it. Confirm it can edit, compile, edit again, and compile again without "Stopped repeated alternating tool loop". Report the URL and what you observed.

## Out of scope

- **Re-checking the document version between planning and `setDocument`.** `execute('edit_file')` re-plans after approval and writes milliseconds later; the remaining race is too small to justify version plumbing here. The browser editing path has its own drift handling.
- **The anchor matching algorithm** (`locateAnchorInText` and helpers). It is owned by the editor-tooling plans.
- **`create_file` preflight.** Creating a file has no anchor to fail on.
