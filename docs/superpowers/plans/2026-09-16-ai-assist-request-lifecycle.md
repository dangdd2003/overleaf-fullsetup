# AI Assist Request Lifecycle & Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every AI provider request cancellable, bounded, and cheap: fix the stop triggers that are missing (chiefly *New chat*), cancel genuinely abandoned runs after a no-watcher grace period, and cut per-request cost via prompt caching, an output cap, an ingress bound, and fewer Redis round trips.

**Architecture:** Frontend stop triggers route through the existing `stop()` in `use-agent-run.ts`, extended so it cancels both the local in-page generator and the server-side background run. On the server, `AiAssistRunManager` gains an approval timeout and a heartbeat, `AiAssistRunStore` gains watcher counting and stale-run reconciliation, and a new `AiAssistRunReaper` polls Redis to cancel runs nobody is watching. Stop and approve are broadcast over a Redis pub/sub control channel so they reach the instance that owns the run. `AiAssistProviders` gains connect/idle timeouts and Anthropic cache breakpoints.

**Tech Stack:** Node.js (ES modules `.mjs`, Node ≥20.19 — `AbortSignal.any` and `AbortSignal.timeout` are available), Express, Redis (`@overleaf/redis-wrapper`, ioredis under the hood), Vitest (backend unit tests), Mocha + Chai + Sinon + @testing-library/react (frontend unit tests), TypeScript, React.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-16-ai-assist-request-lifecycle-design.md`

## Global Constraints

- **Never run `git commit`, `git push`, or any history-altering git command.** This repository requires explicit per-command user approval for all git writes. Leave every change in the working tree. Verification steps replace commit steps. This overrides any instruction from a sub-skill telling you to commit after each task.
- **Working directory for all commands:** `overleaf/services/web` inside the `ai-assist` worktree:
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Backend test runner** (vitest):
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path_to_test>
  ```
- **Frontend test runner** (mocha — note: NOT vitest):
  ```bash
  NODE_ENV=test TZ=GMT /home/dangdd/projects/overleaf-fullsetup/overleaf/node_modules/.bin/mocha \
    --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
    --require test/frontend/bootstrap.js \
    --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
    <path_to_test>
  ```
- **`node_modules` is symlinked into this worktree.** Both `overleaf/node_modules` and `overleaf/services/web/node_modules` are symlinks to the main checkout. They show up as untracked in `git status`. **Never `git add -A`**, and remove the symlinks before any `docker compose build` in this worktree.
- **Baseline (verified 2026-09-16, all green):** 71 backend tests across 8 files; 752 frontend tests. Run the full module suites at the end and expect no regressions.
- **Feature flag:** everything stays behind `AI_ASSIST_ENABLED=true`. New tunables get their own env vars with the defaults in spec §7. An instance that sets nothing must behave as it does today *except* for the confirmed bugs being fixed.
- **API key security:** the provider API key is held in memory for one run's lifetime only. Never write it to Redis, disk, or a log line. This includes the new control-channel messages — publish only `runId` and the action.
- **Test conventions.** Backend: `import { expect } from 'chai'`, `import sinon from 'sinon'`, files `*.test.mjs` under `test/unit/src/`. Frontend: `import { expect } from 'chai'`, `sinon`, `@testing-library/react`, files `*.test.ts(x)` under `test/frontend/js/`. Follow the existing files in each directory.

---

### Task 1: Cancel the run on New chat, Enter-while-running, and error-boundary reset

Fixes the reported bug. Three missing stop triggers in the main chat.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-composer.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/hooks/use-agent-run.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/components/agent-panel.test.tsx`
- Test: `modules/ai-assist/test/frontend/js/components/agent-composer-mentions.test.tsx` (or a new `agent-composer-stop.test.tsx`)

**Interfaces:**
- Consumes: `stop()` from `useAgentRun`; `stopBackgroundRun(runId)` and `getStoredActiveRunId(projectId)` from `../../agent/background/background-run-client`; `setStoredActiveRunId` likewise.
- Produces: no new exports. `onNewChat` stays **synchronous** and fires `void stop()` before clearing — see step 3 for why awaiting it would be wrong.

**The defect, precisely.** `agent-panel.tsx:436` `onNewChat` does:

```ts
const onNewChat = useCallback(() => {
  clearConversation(projectId)
  setState(emptyAgentState([]))
  setNewChatSeed(s => s + 1)
  setCompletedRun(null)
  setRunStartedAt(null)
}, [projectId, setState])
```

It never touches the run. Three consequences, all of which must be fixed by the same change:
1. the server keeps generating and billing;
2. `streamCleanupRef` still holds a live `EventSource`, so `handleStreamEvent` keeps reducing the **old run's events into the freshly emptied transcript** — the new chat visibly fills up with the previous run's output;
3. `saveConversation` then persists that resurrected transcript to localStorage.

Note `currentRunIdRef` and `streamCleanupRef` live inside `use-agent-run.ts` and are **not** reachable from the panel. So `stop()` is the only correct lever — do not try to reach into the refs.

- [ ] **Step 1: Write the failing test**

**TRAP — do not `sinon.stub(bgClient, 'stopBackgroundRun')`.** Stubbing a named export of an imported ES module fails under this runner (bindings are read-only), and a cheap model will burn a lot of time on it. This module's existing tests stub `globalThis.fetch` instead — see `test/frontend/js/agent/background-run-client.test.ts:15` (`sinon.stub(globalThis, 'fetch')`) and its `FakeEventSource` at line 80. Use that approach.

**TRAP — `currentRunIdRef` is a private `useRef` inside `useAgentRun`.** It is not reachable from a rendered component, so you cannot set it directly. Seed the *stored* run id instead: the hook's reconnect-on-mount effect (`use-agent-run.ts:317-358`) reads `getStoredActiveRunId(projectId)` and assigns `currentRunIdRef.current` from it. Writing the localStorage key before render therefore produces a hook that genuinely owns a run id.

In `agent-panel.test.tsx`, following the file's existing `EditorProviders` / `createFakeHandle` / `resetMeta` setup:

```ts
import customLocalStorage from '@/infrastructure/local-storage'

// 1. Seed an active background run for the project BEFORE rendering, so the
//    reconnect effect adopts it and currentRunIdRef is populated.
customLocalStorage.setItem('ai-assist:active-run:' + PROJECT_ID, 'run-123')
customLocalStorage.setItem('ai-assist:active-run-start:' + PROJECT_ID, String(Date.now()))

// 2. Stub fetch so the hook's eventual stop POST is observable, and install a
//    FakeEventSource so connectRunStream does not hit the network.
const fakeFetch = sinon.stub(globalThis, 'fetch' as any).resolves({ ok: true, json: async () => ({ ok: true }) })

// 3. Render <AgentPanel /> inside EditorProviders, then click "New chat".
//    The button is agent-panel.tsx:455-460: a <button> with
//    aria-label={t('ai_assist_new_chat', 'New chat')} inside an OLTooltip in
//    the RailPanelHeader actions. Use:
//      fireEvent.click(screen.getByLabelText('New chat'))
//    Do not query by class name — several header buttons share it.

// 4. Assert the stop request was issued for the seeded run.
const stopCall = fakeFetch.getCalls().find(c =>
  String(c.args[0]).includes('/runs/run-123/stop')
)
expect(stopCall, 'New chat must POST stop for the active run').to.exist
```

Clean up the localStorage keys and restore the stubs in `afterEach`, matching the file's existing teardown.

**Second test — the resurrection, which is the actual user-visible bug.** Assert that after New chat, a stream event arriving from the old run does **not** repopulate the transcript:

```ts
// Drive the FakeEventSource's onmessage with a text event AFTER clicking New
// chat, then assert the rendered transcript is still the empty state.
```

This is the assertion that fails before the fix for the reason the user reported it (old text reappearing in the new chat), and it does not depend on fetch stubbing at all. Write it even if the first test proves awkward.

**Third test — Enter while running.** Render `AgentComposer` with `running={true}` and a non-empty value, fire Enter on the textarea, and assert `onSend` was not called. Check `test/frontend/js/components/agent-composer-mentions.test.tsx` for the existing prop shape and render helper; reuse it rather than inventing one.

- [ ] **Step 2: Run the test and confirm it fails**

- [ ] **Step 3: Fix `onNewChat`**

```ts
const onNewChat = useCallback(() => {
  // Stop first: the EventSource is still live, so clearing the transcript
  // without cancelling would let the old run's events reduce into the new
  // empty conversation and get saved over it.
  void stop()
  clearConversation(projectId)
  setState(emptyAgentState([]))
  setNewChatSeed(s => s + 1)
  setCompletedRun(null)
  setRunStartedAt(null)
}, [projectId, setState, stop])
```

`stop()` already does all of: abort the local controller, close the stream, clear the stored run id, resolve any pending approval as declined, and `await stopBackgroundRun(runId)`. Adding `stop` to the dependency array is required.

**Ordering — verified 2026-09-16, leave `void stop()` unawaited.** It looks like a race: `stop()` calls `setState`, then `onNewChat` calls `setState(emptyAgentState([]))`, so the two could be applied in either order and the old run's `stoppedByUser: true` state might stomp the reset. It is safe, because inside `stop()` the `setState` call (`use-agent-run.ts:304`) comes **before** its first `await` (`stopBackgroundRun` at line 312). React 18 batches both functional updates from the same click handler and applies them in queue order — `stop`'s first, then the empty state — so the empty state wins.

Do **not** add `await stop()` here. `onNewChat` is a synchronous `useCallback` passed to `onClick`, and making it async would turn the UI reset into a post-network-await action, so the transcript would still show the old run while the stop POST is in flight. If you later move code inside `stop()` so that an `await` precedes its `setState`, this reasoning breaks and `onNewChat` must be revisited — note that in a comment at the `void stop()` line so the coupling is visible.

The reason `void` is needed at all is that `stop()` is `async`; ignoring its promise without `void` trips the `no-floating-promises` lint rule. Its rejections are already swallowed internally (`stopBackgroundRun(runId).catch(() => {})`).

There is a second *New chat* affordance: the `contextExhausted` error state at `agent-panel.tsx:590` renders an `OLButton` with `onClick={onNewChat}`. It inherits the fix automatically. Verify it by reading the code, do not duplicate the handler.

- [ ] **Step 4: Guard Enter in the composer**

`agent-composer.tsx` `onKeyDown` handles Escape-while-running but the Enter branch has no guard — only the *button* is swapped for a stop button:

```ts
if (event.key === 'Enter' && !event.shiftKey) {
  event.preventDefault()
  if (running) return          // <- add this line
  // Enter picks from the menu rather than sending a half-typed mention.
  if (query !== null) return
  send()
}
```

Keep `event.preventDefault()` before the guard so Enter still does not insert a newline while running.

- [ ] **Step 5: Make `run()` self-cancelling**

Enter is only one way to start a second run; a starter click or a handoff are others. In `use-agent-run.ts`, at the top of the `run` callback (after the consent checks, before `setState`), cancel anything already in flight:

```ts
// One run per conversation. A second send is a new intent, not a continuation.
if (currentRunIdRef.current || abortRef.current) {
  await stop()
}
```

`stop` is defined below `run` in the file; either move `stop` above `run`, or read the refs inline and duplicate the four lines. Prefer moving `stop` above `run` and adding it to `run`'s dependency array.

- [ ] **Step 6: Stop the run on error-boundary reset**

`AgentPanelFallback.handleReset` (`agent-panel.tsx:680`) clears the stored run id without stopping the run — the opposite of what is wanted, because it removes the only handle to the live run. Capture the id first:

```ts
const handleReset = () => {
  const activeRunId = getStoredActiveRunId(projectId)
  if (activeRunId) {
    void stopBackgroundRun(activeRunId).catch(() => {})
  }
  clearConversation(projectId)
  setStoredActiveRunId(projectId, null)
  if (resetErrorBoundary) {
    resetErrorBoundary()
  } else {
    // eslint-disable-next-line no-restricted-syntax
    window.location.reload()
  }
}
```

Add `stopBackgroundRun` and `getStoredActiveRunId` to the existing `background-run-client` import block at `agent-panel.tsx:33-36`.

- [ ] **Step 7: Run the tests and confirm they pass**

- [ ] **Step 8: Verify no regressions**

```bash
NODE_ENV=test TZ=GMT /home/dangdd/projects/overleaf-fullsetup/overleaf/node_modules/.bin/mocha \
  --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```
Expect 752 passing plus the new tests.

---

### Task 2: Cancel the in-page fix run when its panel unmounts or is replaced

The audit refuted `panel-unmount-leaks-inpage-run` for the *docking* trigger (correctly — docking does not unmount `SuggestFixPanel`). The defect is real for a different trigger: a recompile that makes the log entry vanish unmounts the panel, and `suggest-fix-panel.tsx` has **no unmount cleanup at all**.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/suggest-fix-panel.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-store.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/hooks/use-agent-run.ts`
- Test: `modules/ai-assist/test/frontend/js/components/suggest-fix-panel.test.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/fix-store.test.ts`

There is **no** existing test file for `use-agent-run.ts` (`test/frontend/js/hooks/` holds only `use-editor-theme-styles.test.tsx`). Put the `stop()` ownership regression test in `suggest-fix-panel.test.tsx`, which already renders the in-page path and drives real runs through `fetch-mock` SSE bodies (see its `sse()` helper at line 44 and the `fetchMock.mock(...)` calls). Do not create a new hook test harness for one assertion.

**Interfaces:**
- Consumes: `stop()` from `useAgentRun` (already destructured at `suggest-fix-panel.tsx:166`).
- Produces: nothing new. This task **removes** dead API (`executeFixRun`, `useFix`, `stopFixRun`, `setFixRunning`, `isFixRunning`, `activeRuns`) and moves the per-project exclusivity guard into the live path in `use-agent-run.ts`. `clearFixStore` stays (it is live — see step 5).

- [ ] **Step 1: Write the failing tests**

**How to assert an abort — `abortRef` is private.** `abortRef` is a `useRef` inside `useAgentRun` (`use-agent-run.ts:50`); you cannot read it from a rendered component. Two workable approaches, in order of preference:

*Approach A (observable, no stubbing of internals):* the in-page fix run calls `client.streamChat`, which does a `fetch` to the provider. `suggest-fix-panel.test.tsx` already drives this with `fetch-mock` and an `sse(...)` body. Make the mocked SSE stream **never finish** (an open body that yields one chunk then hangs), start a fix run, unmount the panel, and assert the run stops producing state — e.g. the provider `fetch` was aborted. With `fetch-mock`, the cleanest signal is that the pending request rejects with an abort; alternatively spy on `AbortController.prototype.abort` before render and assert it was called on unmount:

```ts
const abortSpy = sinon.spy(AbortController.prototype, 'abort')
const { unmount } = renderPanel()
open()                          // dispatches aiAssist:suggestFix -> starts the run
await waitFor(() => expect(screen.getByText(/working|reading|thinking/i)).to.exist)
unmount()
expect(abortSpy.called).to.be.true
abortSpy.restore()
```

Spying on the prototype is legitimate here and is the least brittle way to observe a private controller. Restore it in `afterEach`.

*Approach B (stub the generator):* stub `runAgent` from `../agent/run-agent` with an async generator that records the `signal` it is handed and never returns, then unmount and assert `recordedSignal.aborted === true`. This is more precise but requires stubbing an ESM named export — which, per Task 1's trap, does not work reliably under this runner. Prefer Approach A.

The `stop()`-ownership regression test (step 3's trap): seed `customLocalStorage` with `ai-assist:active-run:<projectId>` = `'run-main'`, render the fix panel, trigger a fix run, call its stop, and assert `getStoredActiveRunId(projectId)` still returns `'run-main'` — i.e. stopping an in-page run must not clear the main chat's stored run id.

Do **not** write the replacement-case test against `fix-store.test.ts` — that file's `activeRuns` machinery is the dead code step 5 deletes, so a test there would assert behaviour that no longer exists. The cross-run exclusivity now lives in `use-agent-run.ts`; test it by rendering two fix runs (two panels, or one panel started twice) and asserting the first controller aborted via the prototype spy above.

- [ ] **Step 2: Run the test and confirm it fails**

- [ ] **Step 3: Abort on unmount**

**TRAP — read first.** `stop()` in `use-agent-run.ts:295` unconditionally calls
`setStoredActiveRunId(projectId, null)`, and `projectId` is `cacheKey || 'default'`
(line 63). The main panel and the fix panel **both** pass `cacheKey: projectId`
(`agent-panel.tsx` and `suggest-fix-panel.tsx:174`), so they resolve to the same
key. An in-page fix run never owns a server run — its `currentRunIdRef` is always
null — yet its `stop()` still clears the main chat's stored run id. That silently
breaks the main chat's reconnect-on-mount.

This is a **pre-existing** bug (the fix panel's Stop button at
`suggest-fix-panel.tsx:837` already triggers it), but wiring `stop()` into unmount
would make it fire on every recompile. Fix the ownership rule first:

```ts
const stop = useCallback(async () => {
  const runId = currentRunIdRef.current
  currentRunIdRef.current = null
  abortRef.current?.abort()
  streamCleanupRef.current?.()
  // Only the background path owns this storage key. An in-page run (systemPrompt
  // set) shares the same projectId, and clearing it here would drop the main
  // chat's live run id and break its reconnect.
  if (!systemPrompt) {
    setStoredActiveRunId(projectId, null)
  }
  approvalRef.current?.({ accepted: false })
  approvalRef.current = null
  setApprovalContext(null)
  setState(current => ({
    ...current,
    running: false,
    stoppedByUser: true,
    pendingApproval: null,
    error: null,
  }))
  if (runId) {
    await stopBackgroundRun(runId).catch(() => {})
  }
}, [projectId, systemPrompt])
```

Add `systemPrompt` to the dependency array. Then add a regression test asserting
that stopping an in-page run leaves the stored server run id untouched — stub
`setStoredActiveRunId` and assert it was not called when `systemPrompt` is set.

Now the unmount cleanup itself. In `suggest-fix-panel.tsx`, add an unmount
cleanup; `stop` is already in scope (destructured at line 166):

```ts
// The panel lives inside a compile-log entry. A recompile that fixes the
// error removes the entry and unmounts this panel with a run still in
// flight — there is no consumer left for its output, so cancel it.
useEffect(() => {
  return () => {
    void stop()
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

Mount-once with an empty dependency array and the eslint suppression: `stop` is a `useCallback` whose identity changes, and re-running this effect on every change would abort the run mid-flight. Capture nothing else in the effect.

Verify `stop()` is safe to call when no run is active — it is: `currentRunIdRef.current` is null, `abortRef.current` is null, and `stopBackgroundRun` is only awaited `if (runId)`.

- [ ] **Step 4: One fix run per project — in the LIVE path**

**TRAP — verified 2026-09-16. `fix-store.ts`'s `activeRuns` machinery is dead code.** Do not add the per-project guard there; it would have no effect.

`SuggestFixPanel` does **not** run fixes through `fix-store.ts`. It calls `useAgentRun` directly (`suggest-fix-panel.tsx:170-176`, passing `FIX_TOOLS`, `FIX_MAX_STEPS`, `FIX_SYSTEM_PROMPT`), and its AbortController lives in `use-agent-run.ts`'s `abortRef`. In `fix-store.ts`, the only writers to `activeRuns` are `setFixRunning` (line 215, zero callers) and `executeFixRun` (line 398, called only by `useFix` at line 558 — and `useFix` has **zero callers in the repository**).

Consequences to understand before editing:
- `isFixRunning(projectId, entryId)` is always `false` in the live path, so the initial `loading` state at `suggest-fix-button.tsx:39` is always false. The button still works because it flips `loading` on the `aiAssist:suggestFix` event — but a remount *during* a run shows a non-loading button. That is a pre-existing cosmetic defect, not something to fix here; note it and move on.
- `stopFixRun` never aborts anything real, and neither does the `activeRuns` loop inside `clearFixStore`, for the same reason. (`clearFixStore` itself is still live — it clears other, genuinely-used state. See step 5.)

So the per-project exclusivity guard belongs in `use-agent-run.ts`, keyed on the fact that an in-page run is identified by `cacheKey` (which is `projectId`):

```ts
// In the run() callback's systemPrompt (in-page) branch, before creating the
// controller: cancel any in-page run already live for this hook instance.
// Two fix runs editing one document race, and the user reads one answer at a
// time. abortRef is per-hook-instance, and each SuggestFixPanel has its own,
// so this covers a re-run of the same panel; the cross-panel case is handled
// by step 3's unmount cleanup.
abortRef.current?.abort()
const controller = new AbortController()
abortRef.current = controller
```

The existing code already assigns a fresh controller at `use-agent-run.ts:187-188` without aborting the previous one — add the abort line immediately before it. Combined with step 3 (abort on unmount) this gives: one live fix run per panel, and no run surviving its panel.

If you want true cross-panel exclusivity (two different log entries' panels open at once), it needs a module-level registry in `fix-run.ts` or `fix-store.ts` that `useAgentRun` consults — that is a larger change than this task warrants. The realistic case is one panel at a time, since panels live inside compile-log entries. Note the limitation in a comment rather than building the registry.

- [ ] **Step 5: Delete the dead cancellation API — but NOT `clearFixStore`**

**TRAP — verified 2026-09-16. `clearFixStore` is live and must be kept.** It is imported by **five** test files for state hygiene (`fix-store.test.ts:6`, `suggest-fix-panel.test.tsx:12`, `last-fix-banner.test.tsx:12`, `suggest-fix-handoff.test.tsx:16`, `error-panel-activity.test.tsx:16`), and it clears `inMemoryFixes`, `listeners`, and `lastCompletedFixByProject` — all of which the live path genuinely populates. Deleting it breaks four unrelated suites and removes real cleanup. Only the `activeRuns` loop inside it (lines 71-74) is dead.

Delete from `fix-store.ts`:
- `executeFixRun` (line 326) — only caller is `useFix`
- `useFix` (line 509) — **zero callers in the repository**
- `stopFixRun` (line ~237), `setFixRunning` (line 207), `isFixRunning` (line 203)
- the `activeRuns` Map (line 45), the `ActiveRun` type, and the `activeRuns` loop inside `clearFixStore` (lines 71-74) — keep the rest of `clearFixStore` exactly as is
- any now-unused imports those functions relied on (`runAgent`, `reduceAgentEvent`, `FIX_TOOLS`, `resolveLimits`, `AiAssistant`, `hasConsented`, `buildFixTranscript`) — check each before removing, since `fix-store.ts` may use some elsewhere. Run `tsc`/lint afterwards; unused imports are an error under this repo's lint config.

`isFixRunning` has a **live** caller at `suggest-fix-button.tsx:8,39`, but since `activeRuns` is only ever written by the dead functions it always returns `false` — so that initial `loading` state is always false, and the button works only because it flips `loading` on the `aiAssist:suggestFix` event. Delete `isFixRunning` and change the button's initialiser to `useState(false)`, which is what it already effectively is. Add a comment there noting that a remount *mid-run* will show a non-loading button — a pre-existing cosmetic defect this task surfaces but does not fix.

Keep everything the panel actually imports: `getStoredFix`, `saveStoredFix`, `buildLogEntryFingerprint`, `recordLastCompletedFix`, `getLastCompletedFix`, `clearFixStore`, and the storage helpers.

Deleting dead cancellation API is the point of this step: code that looks like it stops runs but does not is worse than no code, and it is exactly what misled the original audit.

**Test fallout:** `fix-store.test.ts` will lose most of its subject. Remove the tests that only exercised `executeFixRun` / `useFix` / `stopFixRun` / `setFixRunning` / `isFixRunning`, and keep or rewrite any that cover the storage helpers (`getStoredFix`, `saveStoredFix`, `buildLogEntryFingerprint`, `recordLastCompletedFix`). Run all five dependent test files after the deletion, not just `fix-store.test.ts`:

```bash
NODE_ENV=test TZ=GMT /home/dangdd/projects/overleaf-fullsetup/overleaf/node_modules/.bin/mocha \
  --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend/js/agent/fix-store.test.ts \
  modules/ai-assist/test/frontend/js/components/suggest-fix-panel.test.tsx \
  modules/ai-assist/test/frontend/js/components/last-fix-banner.test.tsx \
  modules/ai-assist/test/frontend/js/components/suggest-fix-handoff.test.tsx \
  modules/ai-assist/test/frontend/js/components/error-panel-activity.test.tsx
```

- [ ] **Step 6: Run the tests and confirm they pass**

---

### Task 3: Approval timeout and a single terminal event on stop

`AiAssistRunManager.mjs:173` awaits a Promise that only `approveEdit` or `stopRun` resolves. If the user leaves an edit pending and disconnects, the run blocks forever, holding an `activeRuns` entry, its closures, and the API key in memory until process restart.

Separately, `stopRun` appends `turnFinished` immediately while `startRun`'s own catch/finally also writes terminal status — two writers racing on one event stream.

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs`
- Modify: `modules/ai-assist/app/src/ModuleSettings.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`
- Test: `modules/ai-assist/test/unit/src/index.test.mjs` (**must be updated — see the trap below**)

**Interfaces:**
- Produces: `Settings.aiAssist.approvalTimeoutSeconds`, `.heartbeatStaleSeconds`, `.orphanGraceSeconds`, `.requestTimeoutSeconds`, `.streamIdleSeconds`, `.maxTranscriptBytes`.

**TRAP — read before editing `ModuleSettings.mjs`.** `test/unit/src/index.test.mjs` asserts:

```js
expect(Object.keys(settings.aiAssist)).toEqual(['enabled'])
```

with the comment "carries no credentials or endpoints in settings". Adding fields breaks that test. The assertion's *intent* is "no secrets in settings" — the new fields are numeric timeouts, not credentials. Update the test to assert the absence of secrets rather than an exact key list:

```js
it('carries no credentials or endpoints in settings', async () => {
  const { settings } = await loadModule({ AI_ASSIST_ENABLED: 'true' })
  const serialised = JSON.stringify(settings.aiAssist)
  expect(serialised).not.toMatch(/key|secret|token|password|baseUrl/i)
})
```

- [ ] **Step 1: Write the failing tests**

In `AiAssistRunManager.test.mjs`, following its existing `mockStore` / `mockClient` sinon pattern:

1. An approval that is never decided settles on its own: with a short timeout injected, `startRun` completes, `appendEvent` receives a `toolCallFinished` whose result carries `status: 'rejected'`, and `updateStatus` is called with `'done'`.
2. `stopRun` during an active stream produces **exactly one** `turnFinished` event: `expect(mockStore.appendEvent.getCalls().filter(c => c.args[1]?.type === 'turnFinished')).to.have.lengthOf(1)`.

Make the timeout injectable so the test does not sleep 600 seconds — take it as a constructor option defaulting to the setting.

- [ ] **Step 2: Run the tests and confirm they fail**

- [ ] **Step 3: Bound the approval Promise**

**TRAP.** `approveEdit` (line 316) resolves this Promise *from outside*, via `active.approvalResolver.resolve(decision)`. So a timer created inside the `new Promise` executor is **not** cleared on the normal approve/reject path — it fires later against an already-settled run, and the abort listener leaks. All three exit paths (external decision, timeout, abort) must run the same cleanup.

Replace the bare `new Promise` at `AiAssistRunManager.mjs:173-175`. The key move is to publish a **wrapped** resolver into `approvalPromiseResolvers.resolve`, so the external caller goes through cleanup too:

```js
let timer = null
let onAbort = null
let settled = false

const cleanup = () => {
  if (timer) { clearTimeout(timer); timer = null }
  if (onAbort) {
    controller.signal.removeEventListener('abort', onAbort)
    onAbort = null
  }
  approvalPromiseResolvers.resolve = null
}

const decision = await new Promise(resolve => {
  // One settle path for all three exits. `settled` makes it idempotent, so a
  // timeout racing an external decision cannot resolve twice.
  const settle = value => {
    if (settled) return
    settled = true
    cleanup()
    resolve(value)
  }

  // Publish the WRAPPED resolver: approveEdit and stopRun both call this, so
  // an external decision also clears the timer and the abort listener.
  approvalPromiseResolvers.resolve = settle

  // A decision that never arrives must not pin the run, its activeRuns entry,
  // and the in-memory API key open until the process restarts.
  timer = setTimeout(
    () => settle({ accepted: false, note: 'Approval timed out' }),
    this.approvalTimeoutMs
  )
  timer.unref?.()

  // stopRun aborts the controller; that must also release this await.
  onAbort = () => settle({ accepted: false, note: 'Run stopped' })
  if (controller.signal.aborted) onAbort()
  else controller.signal.addEventListener('abort', onAbort)
})
```

`approveEdit` and `stopRun` call `active.approvalResolver.resolve(...)` unchanged — because `.resolve` now holds `settle`, both go through cleanup automatically. Do **not** add `{ once: true }` to the abort listener here: `cleanup()` removes it explicitly, and `once` combined with manual removal is fine but obscures who is responsible. Either is correct as long as exactly one removal happens.

Also add `approvalResolver` reset in the run's `finally` block (line 299-301), which currently only does `this.activeRuns.delete(runId)`:

```js
} finally {
  // Belt and braces: if the loop exits through an unexpected path while an
  // approval is pending, the timer and listener must not outlive the run.
  approvalPromiseResolvers.resolve?.({ accepted: false, note: 'Run ended' })
  this.activeRuns.delete(runId)
}
```

That call is safe when no approval is pending, because `.resolve` is `null` except between the executor and `settle`.

Add the constructor option:

```js
constructor({
  store = defaultStore,
  tools = defaultTools,
  clientFactory = createProviderClient,
  approvalTimeoutMs = null,
} = {}) {
  ...
  this.approvalTimeoutMs = approvalTimeoutMs
}
```

**Do not evaluate the setting as a constructor default.** The module ends with `export default new AiAssistRunManager()`, which runs at *import* time. That is not a correctness bug — `approvalTimeoutMs = (Settings.aiAssist?.approvalTimeoutSeconds ?? 600) * 1000` degrades to 600000 even when `Settings.aiAssist` is uninitialised, because the optional chaining and `??` cover it (verified). It is a *testability* problem: a default argument is evaluated before the constructor body, so a test cannot tell whether it got the configured value or the silent 600 fallback, and changing the env var per test would not take effect on the singleton. Resolve it in the body instead:

```js
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'   // side-effect import: guarantees Settings.aiAssist exists

// in the constructor body, not the signature:
this.approvalTimeoutMs =
  approvalTimeoutMs ??
  (Settings.aiAssist?.approvalTimeoutSeconds ?? 600) * 1000
```

Importing `./ModuleSettings.mjs` directly also makes the module self-sufficient rather than relying on `index.mjs` happening to import it first — a test that imports `AiAssistRunManager.mjs` directly would otherwise read a bare `Settings` object. Tests still inject a small `approvalTimeoutMs` so they do not sleep 600 seconds.

- [ ] **Step 4: One owner for the terminal event**

*(Task 6 step 4 revises the `!active` branch below once stop is broadcast across instances. Implement it as written here — it is correct for a single process and its tests must pass — then apply the Task 6 revision.)*

`stopRun` currently appends `turnFinished` itself. Make the **run loop** the only writer of terminal events, and let `stopRun` only abort:

```js
async stopRun(runId) {
  const active = this.activeRuns.get(runId)
  if (active) {
    active.controller.abort()
    if (active.approvalResolver?.resolve) {
      active.approvalResolver.resolve({ accepted: false })
    }
  }
  // No event written here. If the loop is live it owns the terminal event
  // (see the aborted branch below); if it is not live — already finished, or
  // running in another process — the control channel and the reaper handle it.
  if (!active) {
    await this.store.updateStatus(runId, 'stopped')
    await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'aborted' })
  }
}
```

And in `startRun`, the existing `if (controller.signal.aborted)` branch (line 267) must emit the terminal event before setting status:

```js
if (controller.signal.aborted) {
  await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'aborted' })
  await this.store.updateStatus(runId, 'stopped')
}
```

`!active` covers a run this process does not own — writing the terminal event there is what lets a cross-instance stop still close the client's stream. Task 6 makes the abort reach the owning process as well.

- [ ] **Step 5: Add the settings**

```js
// module: ModuleSettings.mjs
if (Settings.aiAssist === undefined) {
  Settings.aiAssist = {
    enabled: process.env.AI_ASSIST_ENABLED === 'true',
    // Bounded, tunable lifecycle limits. See the request-lifecycle spec §7.
    // 0 disables the corresponding reaper, restoring "runs always finish".
    orphanGraceSeconds: intFromEnv('AI_ASSIST_ORPHAN_GRACE_SECONDS', 300),
    approvalTimeoutSeconds: intFromEnv('AI_ASSIST_APPROVAL_TIMEOUT_SECONDS', 600),
    heartbeatStaleSeconds: intFromEnv('AI_ASSIST_HEARTBEAT_STALE_SECONDS', 1800),
    requestTimeoutSeconds: intFromEnv('AI_ASSIST_REQUEST_TIMEOUT_SECONDS', 60),
    streamIdleSeconds: intFromEnv('AI_ASSIST_STREAM_IDLE_SECONDS', 15),
    maxTranscriptBytes: intFromEnv('AI_ASSIST_MAX_TRANSCRIPT_BYTES', 200000),
  }
}
```

with a small local `intFromEnv(name, fallback)` helper that returns the fallback on a missing, empty, or non-numeric value. The existing comment at the top of `ModuleSettings.mjs` says "the server has nothing to configure" — that is no longer true once runs execute server-side; update the comment to say these are lifecycle bounds, not provider configuration.

- [ ] **Step 6: Update `index.test.mjs` per the trap above, run all backend tests**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/
```

---

### Task 4: Watcher counting and stale-run reconciliation in the store

Implements background-runs **Decision 7**, which specified `reconcileStaleRuns` and never got built. Also adds the watcher counter the orphan reaper needs.

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunStore.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs`

**Interfaces:**
- Produces (Task 7 consumes every one of these — if you skip any, the reaper throws a TypeError at runtime):
  - `addWatcher(runId) -> Promise<number>` — `HINCRBY` on field `watchers`; clears `zeroSince` when the count becomes > 0. Returns the new count.
  - `removeWatcher(runId) -> Promise<number>` — `HINCRBY -1`, clamped at 0; **stamps `zeroSince = Date.now()` when the count reaches 0**. Returns the new count.
  - `getWatcherCount(runId) -> Promise<number>`
  - `setZeroSince(runId, ms) -> Promise<void>` — `HSET zeroSince`
  - `clearZeroSince(runId) -> Promise<void>` — `HSET zeroSince ''`
  - `getActiveRuns() -> Promise<string[]>` — `SMEMBERS ai-assist:active-runs`
  - `reconcileStaleRuns({ heartbeatStaleMs }) -> Promise<string[]>` — returns the run ids it acted on.

`zeroSince` is a separate field from `heartbeat` and they mean different things — see the trap below. `addWatcher`/`removeWatcher` are the only writers of `zeroSince`; the reaper only reads it (plus the `setZeroSince` stamp for a run it first observes already at zero).

**Constant:** define `const ACTIVE_RUNS_KEY = 'ai-assist:active-runs'` at module scope in `AiAssistRunStore.mjs`, next to `RUN_TTL_SECONDS`.

**Semantics — the heartbeat trap.** `heartbeat` is written only by `appendEvent`, i.e. only when the run emits. A live run goes heartbeat-stale while awaiting approval or inside a long compile. So `reconcileStaleRuns` must treat a stale heartbeat as **"the driving process died"**, not as "the run is idle". It only ever rewrites the status of a run nothing can resurrect; it never aborts a live loop. Use the much larger `heartbeatStaleSeconds` (1800) for this, never the orphan grace (300).

- [ ] **Step 1: Write the failing tests**

Follow the existing `mockRedis` fake in `AiAssistRunStore.test.mjs` (lines 10-44). It currently provides `hset`, `hgetall`, `incr`, `rpush`, `lrange`, `publish`, `expire` — and **none** of `hincrby`, `sadd`, `srem`, `smembers`, which this task's code calls. Add all four or the tests crash on `not a function` before asserting anything:

```js
// alongside the existing `const data = new Map()` / `const lists = new Map()`
const sets = new Map()

// in mockRedis:
hincrby: sinon.stub().callsFake(async (key, field, delta) => {
  if (!data.has(key)) data.set(key, new Map())
  const curr = Number(data.get(key).get(field) || '0') + Number(delta)
  data.get(key).set(field, String(curr))
  return curr                       // real ioredis returns a number, not a string
}),
sadd: sinon.stub().callsFake(async (key, member) => {
  if (!sets.has(key)) sets.set(key, new Set())
  sets.get(key).add(member)
  return 1
}),
srem: sinon.stub().callsFake(async (key, member) => {
  if (!sets.has(key)) return 0
  return sets.get(key).delete(member) ? 1 : 0
}),
smembers: sinon.stub().callsFake(async key =>
  sets.has(key) ? [...sets.get(key)] : []
),
```

Note the existing `hset` fake already handles both the `(key, field, val)` and `(key, objectOfFields)` forms, so the two-field `hset` calls in `removeWatcher` work unchanged.

Cases:
1. `addWatcher` then `removeWatcher` returns to 0; two `removeWatcher` calls never go negative and clamp at 0.
2. `removeWatcher` reaching 0 stamps `zeroSince`; `addWatcher` clears it. Assert via `getRun(runId).zeroSince`.
3. `createRun` adds the run to `getActiveRuns()`; `updateStatus(runId, 'done')` removes it; `updateStatus(runId, 'running')` does not.
4. A run with `status: 'running'` and `heartbeat` older than the threshold is reconciled to `'interrupted'`.
5. A run with a fresh heartbeat is left alone.
6. A run already terminal (`done`/`stopped`/`error`/`interrupted`) is left alone — reconciliation must not resurrect or rewrite a finished run.
7. `reconcileStaleRuns` on a run id present in the index but missing its hash (expired) drops it from the index without throwing.

Case 6 needs the run to be in the index, which `updateStatus` removes from on a terminal write — so seed the index directly with `sadd` for that test rather than calling `createRun` then `updateStatus('done')`.

- [ ] **Step 2: Run the tests and confirm they fail**

- [ ] **Step 3: Implement watcher counting and `zeroSince`**

```js
async addWatcher(runId) {
  const rclient = this.getClient()
  if (!rclient) return 0
  const count = Number(await rclient.hincrby(this._key(runId), 'watchers', 1))
  // Somebody is watching again: the orphan clock stops.
  if (count > 0) await rclient.hset(this._key(runId), 'zeroSince', '')
  return count
}

async removeWatcher(runId) {
  const rclient = this.getClient()
  if (!rclient) return 0
  const count = Number(await rclient.hincrby(this._key(runId), 'watchers', -1))
  // A connection that never finished subscribing must not drive this below 0,
  // or a later reconnect would look like a watcher that is not there.
  if (count < 0) {
    await rclient.hset(this._key(runId), { watchers: '0', zeroSince: '' })
    return 0
  }
  // Watchers just hit zero: start the orphan clock now. The reaper reads this.
  if (count === 0) await rclient.hset(this._key(runId), 'zeroSince', String(Date.now()))
  return count
}

async getWatcherCount(runId) {
  const run = await this.getRun(runId)
  return Number(run?.watchers || 0)
}

async setZeroSince(runId, ms) {
  const rclient = this.getClient()
  if (!rclient) return
  await rclient.hset(this._key(runId), 'zeroSince', String(ms))
}

async clearZeroSince(runId) {
  const rclient = this.getClient()
  if (!rclient) return
  await rclient.hset(this._key(runId), 'zeroSince', '')
}

async getActiveRuns() {
  const rclient = this.getClient()
  if (!rclient) return []
  return await rclient.smembers(ACTIVE_RUNS_KEY)
}
```

`watchers` and `zeroSince` are hash fields on the run key, so they expire with the run — do not give them separate keys. `getRun` spreads the raw hash, so both arrive as strings; always `Number()` them.

In `createRun`, add `watchers: '0'` and `zeroSince: ''` to the existing `hset`, and register the run in the index:

```js
await rclient.sadd(ACTIVE_RUNS_KEY, runId)
await rclient.expire(ACTIVE_RUNS_KEY, RUN_TTL_SECONDS)
```

In `updateStatus`, remove the run from the index on any terminal transition — this is the single choke point every terminal write goes through, so doing it here covers `startRun`'s catch/finally, `stopRun`, and `reconcileStaleRuns` without each caller remembering:

```js
async updateStatus(runId, status, error = null) {
  const rclient = this.getClient()
  if (!rclient) return
  const updates = { status, heartbeat: String(Date.now()) }
  if (error) updates.error = JSON.stringify(error)
  await rclient.hset(this._key(runId), updates)
  if (['done', 'stopped', 'error', 'interrupted'].includes(status)) {
    await rclient.srem(ACTIVE_RUNS_KEY, runId)
  }
}
```

Define the terminal-status list once as an **exported** module constant in `AiAssistRunStore.mjs` (Task 7's reaper imports it by name):

```js
export const TERMINAL_STATUSES = ['done', 'stopped', 'error', 'interrupted']
```

Reuse it in `reconcileStaleRuns`, `updateStatus`, and `AiAssistRunController.streamRun:126`, which currently spells the same four statuses out inline. Importing it into the controller is optional — the inline list there works — but if you leave it, add a comment pointing at the constant so the two are kept in sync.

- [ ] **Step 4: Implement `reconcileStaleRuns`**

There is no index of live runs today. Add one: a Redis set `ai-assist:active-runs`, `SADD` on `createRun`, `SREM` whenever a run reaches a terminal status. Then:

```js
async reconcileStaleRuns({ heartbeatStaleMs = 1800_000 } = {}) {
  const rclient = this.getClient()
  if (!rclient) return []
  const runIds = await rclient.smembers(ACTIVE_RUNS_KEY)
  const acted = []
  const now = Date.now()
  for (const runId of runIds) {
    const run = await this.getRun(runId)
    // A run missing from its hash is already gone; drop it from the index.
    if (!run) { await rclient.srem(ACTIVE_RUNS_KEY, runId); continue }
    const terminal = TERMINAL_STATUSES.includes(run.status)
    if (terminal) { await rclient.srem(ACTIVE_RUNS_KEY, runId); continue }
    if (now - (run.heartbeat || 0) < heartbeatStaleMs) continue
    // Nothing has emitted for a very long time: the process driving this run
    // is gone. Mark it so a reconnecting client stops showing "thinking"
    // forever. This never aborts a live loop — see the heartbeat trap.
    await this.updateStatus(runId, 'interrupted')
    await this.appendEvent(runId, { type: 'turnFinished', reason: 'aborted' })
    await rclient.srem(ACTIVE_RUNS_KEY, runId)
    acted.push(runId)
  }
  return acted
}
```

Give `ACTIVE_RUNS_KEY` a TTL refresh on `createRun` (`expire`, same `RUN_TTL_SECONDS`) so the index cannot outlive its runs.

- [ ] **Step 5: Touch the heartbeat independently of emitting**

`touchHeartbeat` is throttled to 3s and only called from `appendEvent`. A run blocked on approval emits nothing, so its heartbeat ages. Task 3's approval timeout (600s) is shorter than the crash threshold (1800s), so a waiting run can never be misdiagnosed — but a long compile can. Add an explicit heartbeat while blocked: in `AiAssistRunManager.startRun`, call `await this.store.touchHeartbeat(runId, 0)` immediately before awaiting the approval decision, and again immediately after.

- [ ] **Step 6: Run the tests and confirm they pass**

---

### Task 5: Count watchers in the SSE endpoint

`streamRun` must maintain the watcher count the reaper reads, and must be exact: a leaked increment means a run looks watched forever and is never reaped; a leaked decrement means a watched run gets cancelled.

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunController.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs`

- [ ] **Step 1: Write the failing test**

Assert `store.addWatcher` is called once after a successful subscribe, `store.removeWatcher` exactly once on `req` `'close'`, and **not at all** when the request closes before the subscribe completed.

- [ ] **Step 2: Run the test and confirm it fails**

- [ ] **Step 3: Implement**

The current code registers `req.on('close', cleanup)` *before* `await subClient.subscribe(channel)`. Keep that ordering (it prevents a leaked subscriber if the client vanishes during subscribe) but make the watcher bookkeeping exactly-once:

```js
let counted = false
let closed = false

const releaseWatcher = () => {
  if (!counted || closed) return
  closed = true
  void this.store.removeWatcher(runId).catch(() => {})
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

counted = true
await this.store.addWatcher(runId)
```

`cleanup` is also called from `onMessage` when a terminal event arrives — that path now releases the watcher too, which is correct: the stream is over.

**TRAP:** `RedisWrapper.client('ai-assist')` creates a **new** ioredis connection on every call. `streamRun` already does this per request, so each SSE connection costs one connection today; do not make it worse, and do not "optimise" by sharing a single client across concurrent subscriptions — a shared ioredis client in subscriber mode cannot issue ordinary commands, and `unsubscribe(channel)` on a shared client would drop other requests' subscriptions. Keep the per-request client.

- [ ] **Step 4: Run the tests and confirm they pass**

---

### Task 6: Cross-instance stop and approve via a Redis control channel

`manager.activeRuns` is in-process. In a multi-container deployment `POST .../stop` usually lands on an instance that does not own the run, so `stopRun` finds nothing in its Map, and the controller still returns `{ ok: true }`. The user sees the spinner stop while the run keeps billing.

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistRunControl.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs`
- Modify: `modules/ai-assist/index.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunControl.test.mjs`
- Test: `modules/ai-assist/test/unit/src/index.test.mjs`

`AiAssistRunRouter.mjs` is **not** modified — it stays route registration only (see step 5).

**Interfaces:**
- Produces:
  - `AiAssistRunControl.publish(runId, command)` where `command` is `{ action: 'stop' }` or `{ action: 'approve', decision }`.
  - `AiAssistRunControl.start({ onCommand })` — subscribes and dispatches; returns a `stop()` function.
  - Channel: `ai-assist:run:control` (one shared channel, `runId` in the payload — cheaper than one subscription per run).

**Security:** publish only `runId` and the action. Never the API key, never provider settings.

- [ ] **Step 1: Write the failing test**

Two manager instances sharing a fake Redis. Instance A starts a run; instance B publishes `stop`. Assert A's controller aborted and the run reached `'stopped'`. Use a fake that forwards `publish` to registered `subscribe` handlers, mirroring the pattern in `AiAssistRunStore.test.mjs`.

- [ ] **Step 2: Run the test and confirm it fails**

- [ ] **Step 3: Implement `AiAssistRunControl.mjs`**

```js
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'

const CHANNEL = 'ai-assist:run:control'

export class AiAssistRunControl {
  constructor({ clientFactory = () => RedisWrapper.client('ai-assist') } = {}) {
    this.clientFactory = clientFactory
    this._sub = null
    this._pub = null
  }

  async publish(runId, command) {
    if (!this._pub) this._pub = this.clientFactory()
    // runId only. Provider settings and the API key never leave the process.
    await this._pub.publish(CHANNEL, JSON.stringify({ runId, ...command }))
  }

  async start({ onCommand }) {
    this._sub = this.clientFactory()
    const handler = (_channel, message) => {
      let parsed
      try { parsed = JSON.parse(message) } catch { return }
      if (!parsed?.runId) return
      onCommand(parsed)
    }
    this._sub.on('message', handler)
    await this._sub.subscribe(CHANNEL)
    return () => {
      try {
        this._sub.unsubscribe(CHANNEL)
        this._sub.removeListener('message', handler)
      } catch {}
    }
  }
}
```

A subscriber-mode ioredis client cannot publish, hence separate `_pub` and `_sub` clients.

**End the file with a default singleton export** — `index.mjs` does `const { default: control } = await import('./AiAssistRunControl.mjs')`, which resolves to `undefined` without it:

```js
export default new AiAssistRunControl()
```

This matches how every other file in `app/src/` exports (`AiAssistRunManager.mjs:325`, `AiAssistRunStore.mjs`, `AiAssistRunController.mjs:166`). The named class export stays for tests.

Note the singleton reads `Settings.aiAssist` only inside methods, never at module scope, so importing it while the feature is disabled is harmless — but `index.mjs` only imports it inside `start()` behind the flag anyway.

- [ ] **Step 4: Wire the manager**

**TRAP — infinite broadcast storm.** If `onCommand` simply calls `this.stopRun(runId)`, every non-owning instance re-publishes: instance A publishes `stop` → all instances receive it → on each instance that does not own the run, `!active` is true → each publishes `stop` again → all instances receive it again → unbounded loop across the cluster. **Never route a received command back through the method that broadcasts.**

Split the two concerns explicitly. `stopRun(runId)` is the *entry point* (called by the HTTP controller): act locally if we own it, otherwise broadcast. `stopLocalRun(runId)` is the *executor*: abort only, never broadcast. `onCommand` calls the executor.

```js
/** Aborts a run this process owns. Never publishes. Idempotent. */
async stopLocalRun(runId) {
  const active = this.activeRuns.get(runId)
  if (!active) return false
  active.controller.abort()
  active.approvalResolver?.resolve?.({ accepted: false })
  // The run loop owns the terminal event (see startRun's aborted branch).
  return true
}

/**
 * Entry point for an HTTP stop. Acts locally if we own the run; otherwise
 * broadcasts so the owning instance can act.
 *
 * This deliberately revises Task 3 step 4. Task 3's version is correct for a
 * single process and its tests must pass as written there; once stop is
 * broadcast, writing status/events in the !owned branch would happen once per
 * instance for one stop, so that write moves out.
 */
async stopRun(runId) {
  if (await this.stopLocalRun(runId)) return

  if (this.control) {
    await this.control.publish(runId, { action: 'stop' }).catch(() => {})
    return
  }

  // No control channel (single process, or a unit test constructing the
  // manager directly). Fall back to Task 3's behaviour so those tests pass.
  await this.store.updateStatus(runId, 'stopped')
  await this.store.appendEvent(runId, { type: 'turnFinished', reason: 'aborted' })
}

/** Same shape for approval: local first, broadcast only if not ours. */
async approveEdit(runId, decision) {
  const active = this.activeRuns.get(runId)
  if (active?.approvalResolver?.resolve) {
    await this.store.clearPendingApproval(runId, 'running')
    active.approvalResolver.resolve(decision)
    return
  }
  if (this.control) {
    await this.control.publish(runId, { action: 'approve', decision }).catch(() => {})
  }
}

/** Handles a command received from the control channel. NEVER re-broadcasts. */
onCommand({ runId, action, decision }) {
  if (action === 'stop') {
    void this.stopLocalRun(runId).catch(() => {})
    return
  }
  if (action === 'approve') {
    // Resolve locally only. Do not call approveEdit — it would re-publish
    // when this instance does not own the run, which is the normal case for
    // a broadcast, and loop.
    const active = this.activeRuns.get(runId)
    if (active?.approvalResolver?.resolve) {
      void this.store
        .clearPendingApproval(runId, 'running')
        .then(() => active.approvalResolver.resolve(decision))
        .catch(() => {})
    }
  }
}
```

`approveEdit` broadcasting is easy to miss and is a real defect if omitted: an approval POST landing on a non-owning instance would silently no-op, returning `{ ok: true }` to the user while the run stays blocked on its Promise until the Task 3 timeout. **Task 6 must cover approve as well as stop** — the spec says both.

A run whose owner has genuinely died is not closed by this path; the reaper's `reconcileStaleRuns` (Tasks 4 and 7) closes it. Say so in a comment, so nobody reinstates a duplicate terminal write in `stopRun`.

- [ ] **Step 4b: Test the storm guard**

Add to `AiAssistRunControl.test.mjs`: wire two manager instances to one fake Redis and a recording `publish`. Publish a single `stop` for a run **neither** instance owns. Assert `publish` was called exactly **once** in total (the original), not twice or more. This is the assertion that catches the loop — write it before wiring `onCommand`, and confirm it fails if `onCommand` calls `stopRun` instead of `stopLocalRun`.

Also assert: a run owned by instance A is aborted when the stop is published to instance B (cross-instance stop works), and `approveEdit` on a non-owning instance publishes rather than silently no-opping.

- [ ] **Step 5: Wire startup and shutdown**

**Verified 2026-09-16 — use a `start()` hook on the module.** `Modules.mjs` exports `start()`, which loops every loaded module and calls `module.start?.()`, and `app.mjs:132` invokes it at boot:

```js
try {
  await Modules.start()
} catch (err) {
  logger.fatal({ err }, 'failed to start web module background jobs')
}
```

`WebModule.start?: () => Promise<void>` is in the module contract (`types/web-module.ts`). No module in this repo uses it yet, so this will be the first — that is fine, the loader already supports it.

**Do not** start the subscription and the reaper from `AiAssistRunRouter.apply()`. `apply()` runs while routes are being registered, so unit tests that build the router (`test/unit/src/AiAssistRunRouter.test.mjs`) would open unmocked Redis connections and leak `setInterval` handles. Keep `apply()` to route registration only.

`modules/ai-assist/index.mjs`:

```js
import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import AiAssistRunRouter from './app/src/AiAssistRunRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const AiAssistModule = {
  name: 'ai-assist',
  router: AiAssistRunRouter,
  // Invoked by app.mjs via Modules.start() at boot. Import lazily so a
  // disabled feature never touches Redis at all.
  async start() {
    if (!Settings.aiAssist?.enabled) return

    const { default: control } = await import('./app/src/AiAssistRunControl.mjs')
    const { default: reaper } = await import('./app/src/AiAssistRunReaper.mjs')
    const { default: manager } = await import('./app/src/AiAssistRunManager.mjs')
    const {
      addRequiredCleanupHandlerBeforeDrainingConnections,
    } = await import('../../app/src/infrastructure/GracefulShutdown.mjs')

    manager.attachControl(control)

    const stopControl = await control.start({
      onCommand: command => manager.onCommand(command),
    })
    reaper.start()

    addRequiredCleanupHandlerBeforeDrainingConnections(
      'ai-assist run control',
      stopControl
    )
    addRequiredCleanupHandlerBeforeDrainingConnections(
      'ai-assist run reaper',
      () => reaper.stop()
    )
  },
}

export default AiAssistModule
```

`attachControl` is a small setter on the manager (`this.control = control`). Prefer it over importing the control singleton directly into `AiAssistRunManager.mjs`, which would create an import cycle (control → manager → control).

**Verify the relative import path** for `GracefulShutdown.mjs` — from `modules/ai-assist/index.mjs` the store uses `../../../../app/src/infrastructure/RedisWrapper.mjs`, so from `index.mjs` (one level up from `app/src/`) the correct depth is `../../app/src/infrastructure/GracefulShutdown.mjs`. Confirm by checking how `AiAssistRunController.mjs:6` resolves `RedisWrapper` and counting from there; do not guess.

`addRequiredCleanupHandlerBeforeDrainingConnections(label, handler)` is the pattern `SystemMessageManager.mjs:63-74` uses. Call `.unref()` on any `setInterval` so it never holds the process open.

**Test impact:** `test/unit/src/index.test.mjs` imports `../../../index.mjs` and asserts on `module.name`, `module.router`, and settings. Adding a `start` property is additive, so those tests keep passing — but add one asserting `module.start` is a function, and one asserting that with the flag off, calling it does not import the control module (spy on the dynamic import, or assert no Redis client is created).

- [ ] **Step 6: Run the tests and confirm they pass**

---

### Task 7: The orphan reaper (no-watcher grace period)

The policy change the user asked for. A run with zero watchers for longer than the grace period is cancelled.

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistRunReaper.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunReaper.test.mjs`

**Interfaces:**
- Consumes: `store.getActiveRuns()` (add to the store: `SMEMBERS ai-assist:active-runs`), `store.getRun`, `control.publish`.
- Produces: `AiAssistRunReaper.start()` / `.stop()`, plus an exported `sweepOnce()` for tests.

- [ ] **Step 1: Write the failing tests**

Drive `sweepOnce()` directly with a fake store — no timers in tests.
1. A run with `watchers: 0` and `zeroSince` older than the grace → publishes `stop`.
2. A run with `watchers: 0` but `zeroSince` inside the grace → untouched.
3. A run with `watchers: 2` and an old `zeroSince` → untouched, **and** `zeroSince` is cleared.
4. `orphanGraceSeconds: 0` → the sweep does nothing at all (the escape hatch).
5. A run whose `watchers` dropped to 0 between the check and the abort is not cancelled (the re-read guard).

- [ ] **Step 2: Run the tests and confirm they fail**

- [ ] **Step 3: Implement**

Track *when* watchers hit zero rather than inferring it from the heartbeat — the heartbeat cannot express this (see the Task 4 trap). Add a `zeroSince` hash field, maintained where watchers change:

```js
// in addWatcher: if the new count > 0, HSET zeroSince = ''
// in removeWatcher: if the new count === 0, HSET zeroSince = String(Date.now())
```

Then:

```js
async sweepOnce() {
  const graceMs = (Settings.aiAssist?.orphanGraceSeconds ?? 300) * 1000
  if (graceMs <= 0) return []          // reaping disabled
  const heartbeatStaleMs = (Settings.aiAssist?.heartbeatStaleSeconds ?? 1800) * 1000

  const cancelled = []
  for (const runId of await this.store.getActiveRuns()) {
    const run = await this.store.getRun(runId)
    if (!run) continue
    if (TERMINAL_STATUSES.includes(run.status)) continue

    const watchers = Number(run.watchers || 0)
    if (watchers > 0) {
      if (run.zeroSince) await this.store.clearZeroSince(runId)
      continue
    }

    const zeroSince = Number(run.zeroSince || 0)
    if (!zeroSince) {
      // First time we have seen it unwatched: stamp it, do not act yet.
      await this.store.setZeroSince(runId, Date.now())
      continue
    }
    if (Date.now() - zeroSince < graceMs) continue

    // Re-read immediately before acting: a watcher may have reconnected
    // while this sweep was walking the index.
    const fresh = await this.store.getRun(runId)
    if (!fresh || Number(fresh.watchers || 0) > 0) continue
    if (TERMINAL_STATUSES.includes(fresh.status)) continue

    await this.control.publish(runId, { action: 'stop' })
    cancelled.push(runId)
  }

  // Separate concern: runs whose driving process is gone.
  await this.store.reconcileStaleRuns({ heartbeatStaleMs })
  return cancelled
}
```

`start()` wraps `sweepOnce` in a `setInterval` (sweep every ~30s), `.catch`-logged, `.unref()`'d, cleared in `stop()`. Follow `GoogleDrivePollingWorker.mjs:96-105` for the shape.

The sweep interval (30s) must be **shorter** than the orphan grace (300s), or a run can sit abandoned for grace + interval before anyone notices. Keep that relationship in a comment next to the interval constant.

`TERMINAL_STATUSES` is the module constant Task 4 step 3 defines in `AiAssistRunStore.mjs`. Import it from there:

```js
import defaultStore, { TERMINAL_STATUSES } from './AiAssistRunStore.mjs'
```

Do not redeclare a local list of the four statuses — two copies will drift. That means Task 4 must **export** the constant (`export const TERMINAL_STATUSES = [...]`), not just define it; if you implemented Task 4 without the export, add it now.

**End the file with a default singleton export**, since `index.mjs` does `const { default: reaper } = await import('./AiAssistRunReaper.mjs')`:

```js
export default new AiAssistRunReaper()
```

The reaper's constructor takes `{ store = defaultStore, control = defaultControl }` so tests can inject fakes. Importing `AiAssistRunControl.mjs` at module scope here is safe — it is a sibling singleton with no import of the reaper, so there is no cycle.

Publishing `stop` rather than calling `manager.stopRun` directly is what makes this correct across instances — the owner receives it on the control channel from Task 6, and `onCommand` routes it to `stopLocalRun`, which never re-broadcasts.

- [ ] **Step 4: Handle `interrupted` on the frontend**

`interrupted` is a terminal status the backend can now emit, and **the frontend never handles it** — `grep -rn interrupted modules/ai-assist/frontend/` returns nothing. A reconnecting client would show a spinner forever.

There is **no** `GET .../runs/:runId` status endpoint (`AiAssistRunRouter.mjs` exposes only POST runs, GET stream, POST stop, POST approve), so the frontend cannot poll for status. Do not add an endpoint for this — carry the distinction in the event stream, which the client already reads.

Make the reason explicit rather than overloading `'aborted'`, which today means "the user pressed Stop" and drives `stoppedByUser` in the reducer (`agent-state.ts:245`):

1. In `AiAssistRunStore.reconcileStaleRuns` (Task 4 step 4), emit
   `{ type: 'turnFinished', reason: 'interrupted' }` instead of `reason: 'aborted'`.
2. Widen the `turnFinished` reason union. It is **inline** in `AgentEvent`, not a
   named type — `agent-events.ts:10` reads:

```ts
| { type: 'turnFinished'; reason: 'stop' | 'budget' | 'aborted' }
```

   Add `'interrupted'` to that union. Nothing else needs widening:
   `AgentState.error.code` is already typed `string` (`agent-state.ts:16`), so
   `{ code: 'interrupted' }` type-checks without touching `ProviderErrorCode` in
   `providers/types.ts:146`. Do **not** add `'interrupted'` to
   `ProviderErrorCode` — it is not a provider failure, and widening that union
   would imply every provider client can emit it.
3. In `reduceAgentEvent`'s `turnFinished` case (`agent-state.ts:232`), treat it as
   terminal and distinct from a user stop:

```ts
const stoppedByUser = event.reason === 'aborted'
const interrupted = event.reason === 'interrupted'
return {
  ...state,
  transcript: nextTranscript,
  running: false,
  stoppedForBudget: event.reason === 'budget',
  stoppedByUser,
  pendingApproval: null,
  error: stoppedByUser
    ? null
    : interrupted
      ? { code: 'interrupted', message: 'This run was interrupted.' }
      : state.error,
}
```

4. The panel already renders `state.error` (`agent-panel.tsx:571` onwards), so an
   `interrupted` code shows through the existing error block with no new UI. Keep
   it to that one short line — the AI panel is a narrow, dense surface and this
   needs no bespoke card.
5. `background-run-client.ts`'s `connectRunStream` already closes on any
   `turnFinished` or `error` event and calls `onDone`, so an interrupted run
   terminates the stream correctly with no client change. Verify that by reading
   it; do not add a parallel status check.

Add a frontend test asserting `reduceAgentEvent` maps `reason: 'interrupted'` to
`running: false` plus the `interrupted` error code, and a backend test asserting
`reconcileStaleRuns` emits that exact reason.

- [ ] **Step 5: Run the tests and confirm they pass**

---

### Task 8: Provider timeouts, abort-listener cleanup, and correct ProviderError

A stalled provider hangs a run forever today: there is no connect timeout and no stream-inactivity timeout. Separately `fetchWithRetry` mis-constructs `ProviderError` and leaks abort listeners.

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistProviders.mjs`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/sse.ts` (idle watchdog only if needed — see step 5)
- Test: `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`

**Interfaces:**
- Consumes: `Settings.aiAssist.requestTimeoutSeconds` (60), `.streamIdleSeconds` (15).
- Produces: `withRequestTimeouts(signal, { connectMs, idleMs })` returning a combined signal plus a `reset()` function for the idle watchdog.

**The `ProviderError` bug, precisely.** The server-side constructor is `(message, { code, status, hint })`. But `fetchWithRetry` calls it as `new ProviderError('aborted', 'Request was cancelled')` at **three** sites (lines 82, 103, 127) — the frontend's `(code, message)` order. The result is `message: 'aborted'`, `code: 'providerError'`, and a discarded second argument. Downstream, `AiAssistRunManager`'s abort check looks for `err.code === 'aborted'`, so an aborted request can fall through to the generic provider-error branch. Note the frontend `ProviderError` really *is* `(code, message, ...)` — the two classes differ, which is how this happened.

- [ ] **Step 1: Write the failing tests**

In `AiAssistProviders.test.mjs`, following its existing `fetchFn` injection pattern:
1. A `fetch` that never resolves rejects with `code: 'aborted'` after the connect timeout (inject a tiny timeout).
2. A stream that emits one chunk then stalls rejects with `code: 'aborted'` after the idle timeout.
3. A stream that keeps emitting is **not** aborted by the idle watchdog.
4. Aborting mid-backoff rejects with a `ProviderError` whose `code` is `'aborted'` **and** whose `message` is human-readable — this is the assertion that catches the constructor bug.
5. After a successful retry sleep, no abort listener remains on the signal (`signal.onabort` / listener count via a stub).
6. An Anthropic SSE `event: error` frame surfaces as a thrown `ProviderError` rather than being silently skipped.

- [ ] **Step 2: Run the tests and confirm they fail**

- [ ] **Step 3: Fix the ProviderError call sites**

All three become:

```js
throw new ProviderError('Request was cancelled', { code: 'aborted' })
```

- [ ] **Step 4: Fix the listener leak**

In both backoff blocks, remove the listener when the sleep resolves normally:

```js
await new Promise((resolve, reject) => {
  const onAbort = () => {
    clearTimeout(timer)
    reject(new ProviderError('Request was cancelled', { code: 'aborted' }))
  }
  const timer = setTimeout(() => {
    options?.signal?.removeEventListener('abort', onAbort)
    resolve()
  }, delay)
  options?.signal?.addEventListener('abort', onAbort, { once: true })
})
```

The current code adds a listener per retry attempt and never removes it, so a run that retries repeatedly accumulates listeners on a long-lived signal.

Also check `signal.aborted` **before** sleeping, not only at the top of the loop, so a cancellation during the delay is not slept through.

- [ ] **Step 5: Add the dual-layer timeout**

**TRAP — verified empirically on Node 24 (2026-09-16). Do NOT use `AbortSignal.timeout(connectMs)` in the `fetch` signal.** A timeout signal passed to `fetch` keeps governing the response **body**, not just the connection: once the window elapses the signal aborts, which kills the stream. Every LLM stream longer than the connect timeout would be cut off mid-answer. Reproduced:

```js
const s = AbortSignal.timeout(300)
const res = await fetch(url, { signal: s })   // headers arrive immediately
await sleep(500)
s.aborted                                     // -> true, and the body is dead
```

The connect phase needs a controller you **clear** the moment headers arrive:

```js
// In fetchWithRetry, around the fetch call:
const connect = new AbortController()
const connectTimer = setTimeout(() => connect.abort(), connectMs)
// Combine the caller's signal with the connect controller. options.signal may
// be undefined — filter it out, AbortSignal.any rejects undefined members.
const combined = AbortSignal.any(
  [options?.signal, connect.signal].filter(Boolean)
)

let res
try {
  res = await fetchFn(url, { ...options, signal: combined })
} finally {
  // Headers have arrived (or the call failed): the connect phase is over.
  // Leaving this timer armed would abort the stream later on.
  clearTimeout(connectTimer)
}
```

`AbortSignal.any` and `AbortSignal.timeout` are both available on Node ≥20.19 (this repo's `engines` floor) — confirmed present on the Node 24 this project runs.

For the idle watchdog, wrap the response body iteration. Declare the handler **before** the timer that references it — `const onIdle` used inside a `setTimeout` initializer that runs before the declaration throws a `ReferenceError` (TDZ):

```js
const idleController = new AbortController()
let idleTimer = null
const onIdle = () => idleController.abort()

const armIdle = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(onIdle, idleMs)   // sliding: reset on every chunk
  idleTimer.unref?.()
}

try {
  armIdle()
  for await (const data of parseSseLines(res.body)) {
    armIdle()
    ...existing per-frame handling...
  }
} finally {
  if (idleTimer) clearTimeout(idleTimer)   // every exit path, including throws
}
```

The idle controller must be part of the signal handed to `fetch`, so combine all three up front rather than after the response arrives:

```js
const combined = AbortSignal.any(
  [options?.signal, connect.signal, idleController.signal].filter(Boolean)
)
```

Distinguishing an idle abort from a user cancel matters for the error the user sees: check `options?.signal?.aborted` first (user cancel → `code: 'aborted'`), then `idleController.signal.aborted` (stall → a provider-error code with a message saying the stream stalled). Do not report a stall as a user cancellation.

Set the connect timeout generously (60s): reasoning models can take tens of seconds before the first byte. The idle timeout (15s) only fires once a stream has stalled mid-answer — it must be **shorter** than the connect timeout, and both must be shorter than the approval timeout (600s) so a legitimately waiting run is never mistaken for a stalled one.

`parseSseLines` is shared by the Anthropic, OpenAI, and Google server clients; Ollama has its own NDJSON loop, so it needs the same treatment separately. **Prefer the call sites over the parser**: `parseSseLines` is exported and covered directly by `test/unit/src/AiAssistProviders.test.mjs`, and changing its signature to accept a signal would break those tests and complicate a function whose job is only parsing. Check the existing tests before deciding, and if you do change the parser, update its tests in the same task.

The frontend `sse.ts` parsers need this only if you want the in-page fix run bounded too — it is worth doing, but the fix run already aborts on unmount after Task 2, so it is lower priority. Decide and note it.

- [ ] **Step 6: Handle the Anthropic error frame**

In `AnthropicServerClient.streamChat`, the frame loop handles `content_block_*` and `message_stop` but has no branch for `parsed.type === 'error'`, so a mid-stream provider error is silently dropped and the run ends as if the model simply stopped. Add:

```js
} else if (parsed.type === 'error') {
  throw new ProviderError(parsed.error?.message || 'Anthropic stream error', {
    code: parsed.error?.type === 'authentication_error' ? 'providerAuth' : 'providerError',
    status: parsed.error?.code ? 500 : undefined,
  })
}
```

- [ ] **Step 7: Fix the `resolveDockerHostUrl` asymmetry**

`OpenAiServerClient` (line 524) and `OllamaServerClient` (line 869) normalise the base URL through `resolveDockerHostUrl`; `AnthropicServerClient` and `GoogleServerClient` do not. Apply it consistently in all four constructors so a local `host.docker.internal` endpoint behaves the same regardless of provider.

- [ ] **Step 8: Run the tests and confirm they pass**

---

### Task 9: Cheaper requests — caching, output cap, ingress bound, step budget

The cost work. Four independent changes, all small.

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistProviders.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistRunController.mjs`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs`
- Test: `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts`

#### 9a. Prompt caching on the server path

The frontend already does this correctly — copy its approach rather than inventing one. See `frontend/js/features/ai-assist/providers/anthropic.ts:150-177`: `system` becomes `[{ type: 'text', text: system, cache_control: ephemeral }]`, only the **last** tool spec is marked (the array is one prefix; breakpoints are capped at four per request), and the last stable message is marked.

- [ ] **Step 1: Write the failing test** — assert the Anthropic payload carries `cache_control: { type: 'ephemeral' }` on `system`, on the final entry of `tools`, and on the message at `cacheHints.lastStableMessage`. Capture the payload with an injected `fetchFn`.
- [ ] **Step 2: Confirm it fails.**
- [ ] **Step 3: Implement.** Add `cacheHints` to the server `streamChat` signature (`{ system, messages, maxTokens, tools, cacheHints, signal }`) and mirror the frontend's marking in `AnthropicServerClient`. Leave the other three providers alone unless they support equivalent caching — do not invent headers.
- [ ] **Step 4: Compute the hints in the manager.** In `AiAssistRunManager.startRun`, before each `streamChat` call:

```js
const cacheHints = {
  cacheSystem: true,
  cacheTools: true,
  // Everything but the last message was sent in an earlier request, so it is
  // exactly the prefix worth caching. Same reasoning as build-request.ts.
  lastStableMessage: messages.length >= 2 ? messages.length - 2 : null,
}
```

**Stability requirement:** this only pays if the cached prefix is byte-identical across requests. `DEFAULT_SYSTEM_PROMPT` and `getToolSpecs()` are both constants today, so it holds. Note in a comment that interpolating per-run data into either silently destroys the cache.

There is a wrinkle: the manager sets `toolsToUse = []` after a declined edit. An empty tool array changes the prefix, so that turn simply misses the cache. That is correct and rare; do not work around it.

#### 9b. Explicit output cap

- [ ] **Step 5: Write the failing test** — `streamChat` receives `maxTokens` equal to the resolved limit for the provider type, not the 8192 default.
- [ ] **Step 6: Implement.** The manager calls `client.streamChat` without `maxTokens`, so every server request ignores the user's `maxOutputTokens`. Pass it:

```js
const DEFAULT_LIMITS = {
  openai: { contextWindow: 200000, maxOutputTokens: 32000 },
  anthropic: { contextWindow: 200000, maxOutputTokens: 32000 },
  google: { contextWindow: 1000000, maxOutputTokens: 65536 },
  ollama: { contextWindow: 256000, maxOutputTokens: 65536 },
}
// providerSettings.type may be absent or unknown — fall back, never throw.
const limits = DEFAULT_LIMITS[providerSettings?.type] ?? DEFAULT_LIMITS.openai
const maxTokens =
  Number(providerSettings?.maxOutputTokens) > 0
    ? Number(providerSettings.maxOutputTokens)
    : limits.maxOutputTokens
```

This duplicates the frontend's `DEFAULT_LIMITS` table (`providers/types.ts:27`). Duplication across the TS/ESM boundary is unavoidable here without a shared build step — keep the two in sync and cross-reference them in a comment on both sides.

#### 9c. Transcript ingress bound

- [ ] **Step 7: Write the failing test** — a transcript serialising above `maxTranscriptBytes` is rejected with 400 and **no** run is created (`expect(store.createRun.called).to.be.false`).
- [ ] **Step 8: Implement** in `AiAssistRunController.createRun`, immediately after the existing `transcript`/`providerSettings` presence check and **before** `runId` generation:

```js
const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 200000
if (!Array.isArray(transcript) || transcript.length === 0) {
  return res.status(400).json({ error: 'transcript must be a non-empty array' })
}
const size = Buffer.byteLength(JSON.stringify(transcript))
if (size > maxBytes) {
  return res.status(400).json({ error: 'Conversation is too large to send' })
}
```

200000 matches the client's own `MAX_STORED_BYTES` (`frontend/js/features/ai-assist/agent/conversation-store.ts:4`), so a legitimate client can never trip this. Reject before allocating a run id, creating Redis state, or instantiating a provider client.

#### 9d. Step budget before the provider call

- [ ] **Step 9: Write the failing test** — in `run-agent.test.ts`, a run that reaches `maxSteps` does not call `streamChat` again. Stub the client and count calls.
- [ ] **Step 10: Implement.** In `run-agent.ts`, the cap is checked inside the tool loop (`if (steps >= maxSteps)` at line 191), which is *after* a full provider round trip whose output is then discarded. Add the check at the top of `while (true)`:

```js
while (true) {
  if (steps >= maxSteps) {
    return yield { type: 'turnFinished', reason: 'budget' }
  }
  ...
```

Keep the existing in-loop check too — it stops mid-batch, which the top-of-loop check cannot. Do the same in `AiAssistRunManager.startRun`: its `while (steps < maxSteps)` already guards the top, so verify rather than change it.

- [ ] **Step 11: Run all backend and frontend tests**

---

### Task 10: Batched Redis event writes

`appendEvent` fires `INCR` + `RPUSH` + `PUBLISH` per streamed text chunk. A long answer is thousands of Redis commands and thousands of SSE frames.

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Approach: coalesce in the manager, not in the store.** The store's `appendEvent` contract (one seq per call, immediate publish) is used by every other caller and by tests; changing it would ripple. Buffering in the manager keeps the store simple and puts the policy where the chunks are produced.

**Correctness requirement:** the reducer concatenates consecutive `text` events (`appendText`, `agent-state.ts:114-121`), so merging N text chunks into one event renders identically. This is what makes coalescing safe. It is **only** safe for `text` — never merge `thinking`, `toolCallStarted`, `toolCallFinished`, `awaitingApproval`, `error`, or `turnFinished`, and never reorder a text event across a non-text boundary.

- [ ] **Step 1: Write the failing test** — stream 100 text chunks with no other event; assert `appendEvent` was called far fewer times and that concatenating the emitted `text` events reproduces the original string exactly. Then stream text → `toolCallStarted` → text and assert the tool event is not delayed past its position and the two text runs are not merged across it.
- [ ] **Step 2: Confirm it fails.**
- [ ] **Step 3: Implement** a small buffer in `startRun`

**TRAP — event ordering.** `appendEvent` does `INCR` (seq) then `RPUSH`+`PUBLISH`. Two *concurrent* `appendEvent` calls can interleave so that seq order and list order disagree (A takes seq 5, B takes seq 6, B pushes first). The SSE catch-up path reads the list, so it would replay events out of order and the reducer would build a corrupt transcript. Two hazards cause this here:

1. an unawaited `emitText` letting the stream loop run ahead of a size-triggered flush;
2. the background timer flush racing an awaited flush from `emitEvent`.

Serialise every flush through one chain, and make both emit functions `async` so callers must await them:

```js
let pendingText = ''
let flushTimer = null
let flushChain = Promise.resolve()
const FLUSH_MS = 50
const FLUSH_CHARS = 100

// Single writer. Every append goes through here, so seq order and list order
// can never disagree.
const write = event => {
  flushChain = flushChain.then(() => this.store.appendEvent(runId, event))
  return flushChain
}

const flushText = () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  if (!pendingText) return Promise.resolve()
  const chunk = pendingText
  pendingText = ''
  return write({ type: 'text', text: chunk })
}

const armTimer = () => {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    // Chained, so this cannot interleave with an awaited flush.
    void flushText().catch(() => {})
  }, FLUSH_MS)
  flushTimer.unref?.()
}

// async and always awaited by the caller — see the trap above.
const emitText = async text => {
  pendingText += text
  if (pendingText.length >= FLUSH_CHARS) {
    await flushText()
    return
  }
  armTimer()
}

// Every non-text event must be preceded by a flush, or ordering breaks:
const emitEvent = async event => {
  await flushText()
  await write(event)
}
```

Replace the streaming loop's `await this.store.appendEvent(runId, { type: 'text', text: chunk.text })` (line 116) with `await emitText(chunk.text)` — keep the `await`. Route **every** other `appendEvent` call in `startRun` through `await emitEvent(...)`, including `thinking`, `toolCallStarted`, `toolCallFinished`, `awaitingApproval`, `error`, and `turnFinished`. Grep the file for `appendEvent` afterwards and confirm no direct `this.store.appendEvent` call remains inside `startRun` — a single missed one reintroduces the race.

In the `finally` block (line 299), flush the trailing buffer **and** drain the chain, so a partial buffer is never dropped and no write outlives the run:

```js
} finally {
  await flushText().catch(() => {})
  await flushChain.catch(() => {})
  approvalPromiseResolvers.resolve?.({ accepted: false, note: 'Run ended' })
  this.activeRuns.delete(runId)
}
```

If the timer fires after the loop ends, `flushText` is a no-op (`pendingText` is empty) and `clearTimeout` in the `finally` is not strictly needed — but clear it anyway to avoid a stray unref'd timer per run.

50ms is below the threshold of perception for streaming text; 100 chars means fast streams flush on size rather than on the timer. The chain costs one extra microtask per write, which is nothing next to a Redis round trip.

**Interaction with Tasks 3 and 4:** both add code around the approval block (`touchHeartbeat` calls, the bounded Promise). `touchHeartbeat` is not an event append — do **not** route it through `write`. It touches a different Redis field and has no ordering relationship with the event stream.

- [ ] **Step 4: Run the tests and confirm they pass**

---

### Task 11: Cancel the compile poll on abort

`compile_project` polls for up to `COMPILE_TIMEOUT_MS` (120s, `use-project-handle.ts:34`) with no signal check, so a stopped run keeps polling — and `compileInFlight` stays true, wedging the tool for the rest of the session.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-store.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`

**Interfaces:**
- `AgentTool.execute(args, handle, options?: { signal?: AbortSignal })` — a third, optional parameter, so all 16 existing tools keep working unchanged.
- `ProjectHandle.compile(options?: { signal?: AbortSignal })`.

- [ ] **Step 1: Write the failing test** — a handle whose `compile` never resolves; abort the signal; assert `execute` returns promptly and `compileInFlight` was released (a second call does not return the "already in progress" error).
- [ ] **Step 2: Confirm it fails.**
- [ ] **Step 3: Thread the signal**

The signal already reaches `runAgent` — `use-agent-run.ts:200` passes `signal: controller.signal` for the in-page path, and `runAgent` accepts it as a parameter (`run-agent.ts:30`). The **only** missing hop is `runAgent` → `tool.execute`. Three precise edits:

1. `agent/tools/registry.ts` — widen the `AgentTool` type's `execute` signature to take an optional third argument:

```ts
execute(
  args: any,
  handle: ProjectHandle,
  options?: { signal?: AbortSignal }
): Promise<unknown>
```

This is **additive and optional**, so all 16 existing tools keep compiling untouched. Verified: none of the tools in `agent/tools/*.ts` destructure their parameters positionally in a way an extra trailing argument would break — they all use the `async execute(args, handle)` two-parameter form, and an unused third parameter is not an error.

2. `agent/run-agent.ts:216` — pass the signal through at the single call site:

```ts
result = await tool.execute(call.args, toolHandle, { signal })
```

`signal` is already in scope here as `runAgent`'s destructured parameter (line 30). There is exactly one `tool.execute` call in the file — grep to confirm before and after.

3. `agent/tools/compile-project.ts:20,27` — accept and forward it:

```ts
async execute(_args, handle, options?: { signal?: AbortSignal }) {
  ...
  const outcome = await handle.compile(options)
```

- [ ] **Step 4: Break the poll loop.** In `use-project-handle.ts:544-550`:

```ts
const compile = useCallback(async (options?: { signal?: AbortSignal }): Promise<CompileOutcome> => {
  if (!startCompile) {
    throw new Error('Compilation is not available in this context.')
  }
  startCompile()
  const start = Date.now()
  while (Date.now() - start < COMPILE_TIMEOUT_MS) {
    if (options?.signal?.aborted) {
      throw new Error('Compile cancelled')
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const current = logEntriesRef.current
    if (current && (current.errors?.length > 0 || current.all?.length > 0)) {
      return toCompileOutcome(current)
    }
  }
  throw new Error('Compile timed out waiting for results.')
}, [startCompile])
```

`compile-project.ts`'s existing `finally` already releases `compileInFlight`, so throwing on abort clears it correctly. Verify that `catch` turns the cancellation into `{ error: 'Compile cancelled' }` rather than an unhandled rejection — and that `run-agent.ts` treats a tool error as data, which it does (line 218-222). Since the run is aborting anyway, the exact result does not matter; what matters is that the poll stops and the flag clears.

Also update `project-handle.ts:121` (`compile(): Promise<CompileOutcome>`) to `compile(options?: { signal?: AbortSignal }): Promise<CompileOutcome>`, and check whether `readonly-handle.ts`'s Proxy needs any change — it does not, since it only intercepts the mutating method names and passes everything else through via `Reflect.get`.

**Do not** edit `fix-store.ts`'s `runAgent` call to pass a signal. That call is inside `executeFixRun`, which Task 2 step 5 deletes; the live in-page path is `use-agent-run.ts:200`, and it already passes `signal: controller.signal`.

- [ ] **Step 5: Run the tests and confirm they pass**

---

### Task 12: Final verification

- [ ] **Step 1: Full backend suite**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/
```
Baseline was 71 passing; expect 71 + all new tests, 0 failing.

- [ ] **Step 2: Full frontend suite**

```bash
NODE_ENV=test TZ=GMT /home/dangdd/projects/overleaf-fullsetup/overleaf/node_modules/.bin/mocha \
  --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```
Baseline was 752 passing; expect 752 + all new tests, 0 failing.

- [ ] **Step 3: TypeScript check**

```bash
yarn run types:check 2>&1 | grep -iE "ai-assist|error" | head -30
```
Must be clean for `modules/ai-assist`. Pre-existing errors elsewhere are not yours to fix — compare against a clean baseline if unsure.

- [ ] **Step 4: Lint**

```bash
yarn run lint 2>&1 | grep -i "ai-assist" | head -30
```

- [ ] **Step 5: Confirm the defaults are inert**

Read `ModuleSettings.mjs` and confirm that with no env vars set, `orphanGraceSeconds` is 300 and `enabled` is false. Then confirm that `AI_ASSIST_ORPHAN_GRACE_SECONDS=0` disables the sweep entirely (Task 7 step 1, case 4).

- [ ] **Step 6: Confirm no secrets are logged or persisted**

Grep the diff for anything that could carry an API key into Redis or a log line:

```bash
git diff | grep -nE "providerSettings|apiKey" | head -30
```

Every hit must be in-memory only. The Task 6 control-channel payload must contain `runId` and the action and nothing else.

- [ ] **Step 7: Redeploy the dev server**

UI and lifecycle changes are not real until the user can see them. Rebuild and redeploy the `ai-assist` dev server so the behaviour can be checked by hand:
1. Start a run, click **New chat** → generation stops immediately, the new chat stays empty, no old text reappears.
2. Start a run, press Enter → no second concurrent run.
3. Start a run, close the tab, reopen within 5 minutes → the run is still there and reconnects.
4. Start a run, close the tab, wait past the grace period, reopen → the run shows as interrupted, not a permanent spinner.
5. Trigger a compile-error fix, then recompile so the entry disappears → the fix run stops rather than continuing in the background.

Report the dev server URL, ports, and the admin credential used.

- [ ] **Step 8: Leave everything uncommitted**

Do **not** run `git add`, `git commit`, or any other git write. Summarise the changed files and leave them in the working tree.

---

## Out of scope

Deliberately excluded, with reasons:

- **`body-stream-reader-not-cancelled-on-abort`** — refuted. `signal` is passed to `fetch` at all four server clients, so abort reaches the socket.
- **`project-switch-abandons-active-run`** — refuted. Detach on navigation is the intended design (spec §3.2).
- **`chat-handoff-dropped-when-chat-busy`** — refuted. Already guarded by `chatBusy` in `suggest-fix-panel.tsx:391`.
- **`inconsistent-step-budget` (30 vs 20)** — refuted. The two paths have deliberately different scopes.
- **`no-mutual-exclusion-fix-and-chat`** — refuted by the reachability lens. Task 2 step 4 gives one fix per project, which covers the realistic race; a full cross-path lock is not worth the coupling.
- **`reconnect-effect-overwrites-stream-cleanup`** — refuted, but if you touch that effect for Task 7 step 4, re-check that `streamCleanupRef` is closed before being reassigned. Cheap to get right while you are there.
- **A service-worker-based client-only design** — already rejected in the background-runs spec, correctly.
- **Prompt caching for OpenAI/Google/Ollama server clients** — only Anthropic gets explicit breakpoints here. Do not invent headers for providers whose caching semantics you have not verified.

## Reading order for the implementer

1. Spec §3 (stop policy) and §4 (orphan reaping) — the *why*.
2. Task 1 — the reported bug, self-contained, immediately verifiable.
3. Tasks 2, 3 — the remaining cancel triggers and the deadlock.
4. Tasks 4-7 — watcher counting through to the reaper. These build on each other; do them in order.
5. Tasks 8-11 — independent cost and robustness work; any order.
6. Task 12 — verification.
