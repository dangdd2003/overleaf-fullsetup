# AI Assist Request Lifecycle & Cost Design Specification

**Date:** 2026-09-16
**Topic:** When an AI request stops — stop triggers, orphan reaping, and per-request cost
**Status:** Approved

---

## 1. Goal

Make every AI provider request **cancellable, bounded, and cheap**.

Three things are wrong today:

1. **Some user actions that should stop a request do not.** The clearest is the
   *New chat* button: it clears the transcript but leaves the server-side run
   streaming, so the old run's events reduce into the freshly emptied
   conversation and are then saved to localStorage. The old chat visibly
   resurrects inside the new one, and tokens keep being billed.
2. **Nothing bounds a request that nobody is watching.** Per the background-runs
   spec (Decision 2), a run continues to completion "even if every tab for the
   project closes and nothing ever reconnects." That was a deliberate trade for
   surviving browser restart. It is now too broad: it also covers runs the user
   has genuinely abandoned.
3. **Each request costs more than it needs to.** The server-side path sends no
   prompt-cache breakpoints and no `max_tokens`, so a 20-step run re-bills its
   full system prompt and tool schemas at 100% on every step and can generate
   without the user's configured output cap.

### 1.1 Non-goals

- Changing *where* runs execute. Server-side execution stays.
- Changing the tool surface, the transcript rendering order, or the UI design.
- Making in-page fix runs survive reload. They stay transient by design.

---

## 2. The two execution paths (unchanged)

| | Main chat | Compile-log "Suggest fix" |
|---|---|---|
| Runs in | `web` backend (`AiAssistRunManager`) | Browser (`runAgent` generator) |
| Driven by | `use-agent-run.ts` background branch | `fix-store.ts` / `use-agent-run.ts` `systemPrompt` branch |
| Events | Redis list + pub/sub → SSE | Direct generator yield → React state |
| Abort | `AbortController` in `manager.activeRuns` | `AbortController` in `fix-store.activeRuns` / `abortRef` |
| Survives reload | **Yes** (intentional) | No (intentional) |

This split is correct and stays. Every rule below says explicitly which path it
applies to.

---

## 3. The stop policy

### 3.1 Two verbs, not one

Every lifecycle event must be classified as **cancel** or **detach**. Confusing
them is the root cause of both the reported bug and of the wasted work:

- **cancel** — kill the provider request. Stop billing. The partial turn ends.
- **detach** — stop *watching*. The request keeps running and its events keep
  being recorded, so a later reconnect can replay them.

The invariant: **a user's explicit intent to start over is cancel; a user's
navigation away is detach.**

### 3.2 Policy matrix

| Trigger | Path | Verb | Why |
|---|---|---|---|
| New chat button | both | **cancel** | Explicit intent to start over. The old turn must not survive into the new conversation. |
| Stop button / Escape | both | **cancel** | Already correct; unchanged. |
| Enter pressed while running | main | **cancel-then-replace** | A second message is a new intent; the old turn is abandoned, not continued. |
| Error-boundary reset | main | **cancel** | The UI is being rebuilt from scratch; a run still writing into it would re-corrupt it. |
| Fix panel unmounts (log entry vanished after recompile) | fix | **cancel** | Transient in-page run with no consumer. Nobody can ever see its result. |
| New fix started for a different log entry, same project | fix | **cancel** prior | Two runs editing one document races. One fix per project at a time. |
| Approval left unanswered | main (server) | **cancel after timeout** | The loop currently blocks on a Promise that may never settle. |
| Project switch | both | **detach** | The run is still wanted; the user moved. Reconnect replays it. |
| Panel closed / docked away | main | **detach** | Same. |
| Tab hidden | both | **no-op** | Nothing to gain; the SSE stream stays open. |
| Tab closed / browser closed | main | **detach** | The headline feature. Runs survive. |
| Provider settings changed mid-run | main | **no-op** | Takes effect on the next run. Mid-run key swap would corrupt the client. |
| Chat handoff while running | fix→main | **no-op** | Already guarded by `chatBusy`. |
| **No watcher for the grace period** | main (server) | **cancel** | **New.** See §4. |
| Process restart / crash | main (server) | **reconcile** | **New.** See §4.3. |

### 3.3 Why New chat is cancel and project switch is detach

Both abandon the UI. They differ in intent. *New chat* says "throw this away" —
there is no future in which the user wants that turn's output, so continuing to
generate it is pure waste, and (worse) its events arrive into the new
conversation. *Project switch* says "I'll be back" — the user has not rejected
the work, and the whole point of server-side execution is that the work is
waiting when they return.

---

## 4. Orphan reaping: the no-watcher grace period

This replaces background-runs spec **Decision 2**, which declined all idle and
cost caps. Runs still survive reload and browser close. What changes is that a
run **nobody is watching** no longer runs to completion.

### 4.1 Watcher counting

A run's watcher count is the number of live SSE connections streaming it. The
count lives in Redis so it is shared across `web` instances:

- `streamRun` increments `watchers` when it subscribes successfully, and
  decrements on `req.on('close')`.
- The decrement must be **idempotent per connection** — a connection that never
  finished subscribing must not decrement.
- `watchers` is a Redis hash field on the run key, so it expires with the run.

### 4.2 Grace period

A run with `watchers == 0` for longer than `AI_ASSIST_ORPHAN_GRACE_SECONDS`
(default **300**) is cancelled: the AbortController fires, status becomes
`interrupted`, and a terminal `turnFinished` event is appended so any later
reconnect closes cleanly instead of hanging.

300 seconds is deliberately generous. It must exceed the longest ordinary
disconnection a real user causes:

- a page reload (SSE drops and re-opens within ~1s),
- switching projects and switching back,
- closing the laptop lid and reopening it,
- a flaky network handover.

None of those come close to five minutes. A run that has had zero watchers for
five minutes has been abandoned, and continuing it only bills tokens for output
nobody will read.

**Important:** the grace timer measures *watcher absence*, not run duration. A
long-running run with one watcher open is never reaped, however long it takes.

### 4.3 The heartbeat trap (must not be gotten wrong)

`heartbeat` is written only by `appendEvent`, i.e. only when the run *emits*.
A live run can therefore go heartbeat-stale without being dead:

- awaiting approval — blocked on a Promise, emitting nothing, for minutes;
- inside a long tool call (a compile can run to `COMPILE_TIMEOUT_MS` = 120s);
- waiting on a slow first token from a reasoning model.

So **heartbeat staleness alone must never cancel a run.** Two separate
mechanisms, two separate jobs:

| Signal | Meaning | Action |
|---|---|---|
| `watchers == 0` for > grace | Abandoned by the user | **cancel** the run |
| `heartbeat` older than a much larger threshold (default 1800s) | The driving process died | **reconcile** status to `interrupted` |

The heartbeat check is not a liveness probe for the loop; it is a **crash
detector**. Its threshold must exceed every legitimate silent period —
approval wait (§4.4) and compile wait — with room to spare. It only ever
rewrites the status of an already-dead run so a reconnecting client stops
showing "still thinking"; it never aborts anything.

To make the crash detector honest, the loop must touch the heartbeat
independently of emitting: a periodic `touchHeartbeat` while alive.

### 4.4 Approval timeout

The pending-approval Promise must settle on its own. Default
`AI_ASSIST_APPROVAL_TIMEOUT_SECONDS` = **600**. On expiry the run resolves
`{ accepted: false, note: 'Approval timed out' }` and ends cleanly.

This is not an arbitrary number: it must be **shorter than** the heartbeat
crash threshold, or a legitimately waiting run would be misdiagnosed as dead.

```
approval timeout (600s)  <  heartbeat crash threshold (1800s)
orphan grace (300s)        — independent, measured on watchers not heartbeat
```

### 4.5 Ordering

`watchers` reaching 0 starts the grace timer. If a watcher reconnects before it
fires, the timer is cancelled and the run continues untouched. The reaper must
therefore re-read `watchers` immediately before aborting, so it never kills a
run that just gained a watcher.

---

## 5. Request optimisation

### 5.1 Prompt caching on the server path

The in-page path already builds `cacheHints` via `buildRequest` and
`AnthropicClient` honours them with `cache_control: { type: 'ephemeral' }`. The
server path does neither. A 20-step run therefore re-sends and re-bills its
system prompt (~1.5k tokens) and full tool schemas (~2k tokens) on every step.

The server side must attach the same breakpoints:

- `system` → cached (it is a constant string; stable across every turn),
- the **last** tool spec → cached (the tool array is one prefix, so marking the
  last element caches all of them; breakpoints are capped at four per request),
- the last message stable across turns → cached.

Cache reads are billed at 10% on Anthropic. For a multi-step run this is the
single largest cost reduction available and it requires no behaviour change.

**Stability requirement:** caching only pays if the cached prefix is
byte-identical between requests. The system prompt and tool specs are both
constants today, so this holds. Any future change that interpolates per-run
data into either will silently destroy the cache — this is why the constraint
is written down here.

### 5.2 Explicit output cap

`AiAssistRunManager` calls `client.streamChat` without `maxTokens`, so every
server request falls back to the `8192` default and ignores the user's
`maxOutputTokens` setting. The manager must forward the resolved limit, using
the same `DEFAULT_LIMITS` table the frontend uses.

### 5.3 Transcript ingress bound

`createRun` accepts any transcript of any size. The client already bounds stored
history at `MAX_STORED_BYTES = 200000`, so a matching server-side cap rejects
only requests a legitimate client could not have produced. Reject at HTTP
ingress, **before** allocating a run, instantiating a provider client, or
touching a provider.

### 5.4 Step budget checked before the provider call

Both loops check the step cap *after* streaming a turn. On the final step this
buys one full provider round trip whose output is then discarded. The check
moves to the top of the loop.

### 5.5 Batched event writes

`appendEvent` fires `INCR` + `RPUSH` + `PUBLISH` per streamed text chunk. A
long answer is thousands of Redis commands. Buffer text deltas and flush on a
short interval (~50ms) or size threshold (~100 chars), flushing immediately on
every non-text boundary (`tool_call`, `awaitingApproval`, `error`,
`turnFinished`) so interactive control never waits on a timer.

### 5.6 Timeouts and clean abort

- **Connect / time-to-first-token:** a stalled provider currently hangs a run
  forever. Bound it (~60s, generous for reasoning models).
- **Stream inactivity:** a sliding watchdog (~15s) so a provider that stops
  mid-answer does not hold the run open indefinitely.
- These compose with the caller's abort signal via `AbortSignal.any`, and the
  combined signal is what reaches `fetch`.

Note: abort **already** tears down the socket correctly, because `signal` is
passed to `fetch` at all four server clients. The defect is the absence of a
timeout, not a failure to propagate cancellation.

### 5.7 Cancel the compile poll

`compile_project` polls for up to `COMPILE_TIMEOUT_MS` (120s) with no signal
check. On abort it must break immediately and release `compileInFlight`, or a
stopped run leaves the tool wedged for the rest of the session.

---

## 6. Multi-instance correctness

`manager.activeRuns` is an in-process Map. In a multi-container deployment the
HTTP request that receives `POST .../stop` is unlikely to land on the instance
driving the run, so `stopRun` and `approveEdit` silently no-op while the client
is told `{ ok: true }`.

Both actions must be broadcast over a Redis pub/sub control channel so the
instance that owns the run acts on it. The local Map remains the fast path;
pub/sub covers the rest.

This also makes the orphan reaper correct: whichever instance notices an
orphaned run publishes the stop, and the owner executes it.

---

## 7. Configuration

All new behaviour is bounded by env vars and defaults to the current feature
gate. Nothing changes for an instance that sets nothing.

| Variable | Default | Purpose |
|---|---|---|
| `AI_ASSIST_ENABLED` | `false` | Existing master gate. Unchanged. |
| `AI_ASSIST_ORPHAN_GRACE_SECONDS` | `300` | Watcher-absence window before cancelling an abandoned run. `0` disables reaping (restores old behaviour). |
| `AI_ASSIST_APPROVAL_TIMEOUT_SECONDS` | `600` | How long an edit may sit unanswered. |
| `AI_ASSIST_HEARTBEAT_STALE_SECONDS` | `1800` | Crash detector. Must exceed the approval timeout. |
| `AI_ASSIST_REQUEST_TIMEOUT_SECONDS` | `60` | Connect / first-token bound. |
| `AI_ASSIST_STREAM_IDLE_SECONDS` | `15` | Mid-stream inactivity bound. |
| `AI_ASSIST_MAX_TRANSCRIPT_BYTES` | `200000` | Ingress cap; matches `MAX_STORED_BYTES`. |

Setting `AI_ASSIST_ORPHAN_GRACE_SECONDS=0` restores the old "runs always finish"
semantics exactly, which is the escape hatch if the grace period ever misfires.

---

## 8. Invariants

These must still hold after every change:

1. A run survives page reload, browser close, and project switch, and replays
   from Redis on reconnect.
2. In-page fix runs stay transient and abort on unmount or replacement.
3. All AI behaviour stays behind `AI_ASSIST_ENABLED`, default off.
4. The provider API key is held in memory for one run's lifetime only — never
   Redis, never disk, never logs.
5. Transcript tool calls stay in chronological order; expansion chevrons stay
   at the end of the text.
6. A stop is idempotent, and exactly one terminal `turnFinished` event is
   emitted per run however it ends.
7. No new git commits are made by the implementation.

---

## 9. Confirmed defects this design addresses

Found by a 5-dimension audit and confirmed by adversarial 2-lens verification
(24 canonical → 15 confirmed, 9 refuted).

**Critical**
- `new-chat-leaves-server-run-active` — `agent-panel.tsx:436`

**High**
- `no-request-or-stream-timeout` — `AiAssistProviders.mjs`
- `enter-submits-second-message-during-active-run` — `agent-composer.tsx:157`
- `multi-instance-stop-approve-lost` — `AiAssistRunManager.mjs:305`
- `approval-promise-deadlock-leak` — `AiAssistRunManager.mjs:173`
- `error-boundary-reset-orphans-server-run` — `agent-panel.tsx:680`
- `fetch-retry-abort-listener-leak-and-malformed-error` — `AiAssistProviders.mjs:82,103,127`
- `server-side-prompt-caching-and-budget-elision` — `AiAssistRunManager.mjs:105`
  *(refuted by the reachability lens as "an optimisation, not a bug" — adopted
  anyway because §5 is an explicit goal of this work)*

**Medium**
- `stale-heartbeat-interrupted-reconciliation` — `reconcileStaleRuns` specified in
  Decision 7, never implemented
- `stop-race-event-ordering-corruption` — `AiAssistRunManager.mjs:304`
- `unbatched-redis-stream-chunk-writes` — `AiAssistRunStore.mjs:88`
- `unbounded-transcript-no-limit` — `AiAssistRunController.mjs:24`
- `provider-client-asymmetries-and-silent-error-drop` — `AiAssistProviders.mjs:460`
- `fix-step-cap-post-provider-call` — `run-agent.ts:191`
- `unabortable-compile-tool-execution` — `compile-project.ts`
- `concurrent-fix-runs-race-edits` — `fix-store.ts`

**Additional, found during implementation review (not in the audit's confirmed set)**
- `panel-unmount-leaks-inpage-run` — the audit refuted this for the *docking*
  trigger, correctly. But `suggest-fix-panel.tsx` has no unmount cleanup at all,
  so a recompile that removes the log entry leaves the in-page run generating.
  The refutation was about the wrong trigger; the defect is real for this one.
- `inpage-stop-clears-background-run-id` — `stop()` in `use-agent-run.ts:300`
  unconditionally calls `setStoredActiveRunId(projectId, null)`, and both the
  main panel and the fix panel derive the same `projectId` from `cacheKey`. An
  in-page fix run never owns a server run, yet stopping it wipes the main chat's
  stored run id and breaks its reconnect-on-mount. Already reachable today via
  the fix panel's own Stop button; it becomes reachable on every recompile once
  the unmount cleanup above lands, so both must be fixed together.
- `fix-store` exports `stopFixRun`, `clearFixStore`, and `setFixRunning` with
  **zero non-test callers** — dead cancellation API. The real path
  (`fix-store.ts:387`) aborts correctly on a same-entry restart, so this is a
  tidiness item, not a live leak.

**Explicitly refuted — do not "fix"**
- `body-stream-reader-not-cancelled-on-abort` — `signal` *is* passed to `fetch`
  at all four server clients; abort reaches the socket.
- `project-switch-abandons-active-run` — detach is the intended design.
- `chat-handoff-dropped-when-chat-busy` — already guarded by `chatBusy`.
- `inconsistent-step-budget` (30 vs 20) — the two paths have different scopes by
  design.
- `no-mutual-exclusion-fix-and-chat`, `reconnect-effect-overwrites-stream-cleanup`,
  `untested-cancellation-edge-cases` — refuted by the reachability lens.
