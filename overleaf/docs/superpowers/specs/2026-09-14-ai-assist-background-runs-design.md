# AI Assist — Background Runs That Survive Reload and Browser Close

**Date:** 2026-09-14
**Status:** Approved design, pending implementation plan
**Sub-project:** 6 of N

**Predecessors:**

- `2026-09-09-ai-assist-error-assistant-design.md` — the module, the browser-side
  provider layer, the first error assistant.
- `2026-09-10-ai-assist-project-agent-design.md` — the agent rail, the tool
  registry, the edit approval flow.
- `2026-09-11-ai-assist-context-optimisation-design.md` — the static system
  prompt, the frozen `<project-context>` envelope, the token budget.
- `2026-09-13-ai-assist-error-panel-agent-design.md` — the compile-log "Suggest
  fix" panel re-platformed onto the shared harness.
- `2026-09-13-ai-assist-harness-comprehension-design.md` — navigation tooling
  and token economy for large projects.

This design changes where the harness those sub-projects built actually
*runs*, not what it does. The tool set, the system prompt, the transcript UI
(`SubresultGroup`, `ToolCallCard`, `reduceAgentEvent`, …) are unchanged.

## Summary

`runAgent()` (`agent/run-agent.ts`) is a plain async generator that runs inside
the browser tab's JS heap: it owns the provider `fetch` and drives tool
execution against a live `ProjectHandle` bound to the mounted editor.
Reloading or closing the tab kills both, mid-turn, with no recovery.

This design moves the run — the provider call, the tool-calling loop, and tool
execution itself — into Overleaf's `web` backend, so a run continues
regardless of whether any browser tab is open, the same way claude.ai,
ChatGPT and Gemini's web clients behave. The browser becomes a thin client
that starts a run, streams its events over SSE, and reconnects to the same
run from any tab, at any time, exactly as it would reconnect to any other
conversation.

This is a deliberate reversal of the founding principle in sub-project 1
("the assistant runs entirely in the browser and calls the AI provider
directly... the server has nothing to configure"). That trade was made
knowingly: matching real background-survival behavior requires the user's
provider API key to transit Overleaf's own backend on each run, which it
never did before. See Decision 3.

The feature stays disabled by default under `AI_ASSIST_ENABLED`, unchanged.

## The problem

Two independent things die together on reload, and both have to move for a
run to survive it:

1. **The provider connection.** `client.streamChat()`'s `fetch` is scoped to
   the page's lifetime; any navigation aborts it, full stop, in every browser.
2. **Tool execution.** `tool.execute(args, handle)` — `read_file`, `edit_file`,
   `compile_project`, etc. — all act on `ProjectHandle`, an object bound to
   *this* mounted CodeMirror/ShareJS instance. Even a connection that somehow
   survived a reload would have nothing live to execute tools against
   afterward.

A pure client-side fix (a Service Worker owning the loop, with page(s)
executing tools on its behalf via `postMessage`) was designed first and
would have solved reload/navigation without any backend involvement. It was
explicitly rejected in favor of this design once "survives fully closing the
browser" was named as a requirement: a Service Worker's lifetime is bound to
the browser process itself, so closing the browser ends it — no client-only
design can avoid that. Matching claude.ai/ChatGPT/Gemini's actual behavior
means the run has to live somewhere that isn't the browser at all.

## Decisions

1. **Scope** — this covers the main chat panel (`use-agent-run.ts`, driven
   from `agent-panel.tsx`) only. The narrower "fix compile errors" flow
   (`fix-store.ts`) keeps running in-page for now; it's a short, usually
   single-turn run where reload loss is far less costly.
2. **No idle/time-based safety cap.** A run keeps going until it finishes,
   the model or provider errors, or the user explicitly stops it — even if
   every tab for the project closes and nothing ever reconnects.
3. **True server-side execution**, not a Service Worker. Overleaf's `web`
   backend calls the configured provider on the user's behalf and persists
   run state independent of any browser. This is the one place in the
   `ai-assist` module where a provider API key transits Overleaf's own
   server, reversing the client-direct design from sub-project 1.
4. **The API key is held in memory only**, for the lifetime of the one run
   that needs it — never written to Redis or disk. A conversation spans many
   runs (one per user message); the page sends the key fresh with every
   `POST .../runs` call, and the run manager process driving that run
   discards it once the run reaches a terminal state. It is never cached
   server-side across runs. A `web` process restart ends any runs it was
   driving rather than resuming them; see Decision 7 for how that's
   surfaced.
5. **Tool execution moves server-side.** Each tool in `agent/tools/*.ts`
   currently takes `(args, handle: ProjectHandle)`. The server-side
   equivalents read/write project content through the same internal APIs the
   rest of `web` already uses for the editor and compiles — `docstore` /
   `project-history` for reads and edits, `clsi` for compiles — not a
   browser-bound handle.
6. **Edit approval becomes real server-side state.** `edit_file`/`create_file`
   already suspend the loop pending a human decision
   (`tool.suspends` / `EditApprovalCard`). That pause is now "the run sits
   `awaitingApproval` in Redis until a `POST .../approve` arrives," not an
   in-memory `Promise` — it survives the browser closing while the question
   is still open, the same as everything else here.
7. **A new terminal status, `interrupted`,** distinct from today's
   `stop` / `budget` / `aborted` / `error`. Each run owner updates a heartbeat
   in Redis while alive; a run found `running`/`awaitingApproval` with a
   stale heartbeat (backend restart, crash) is reconciled to `interrupted` on
   next contact, and that correction is written back into the saved
   transcript — so history never shows a permanently stuck "still thinking"
   entry, regardless of how long it's been.
8. **Provider clients are reimplemented server-side**, not shared with the
   frontend. `providers/{anthropic,openai,ollama}.ts` are pure `fetch` + SSE
   TypeScript with no browser dependency, but the backend here is plain Node
   `.mjs` with no TS build step, and no other module in this codebase shares
   a TS package between the webpack frontend and the Node backend. Rather
   than introduce that cross-runtime build as new infrastructure, the three
   clients get a small, duplicated `.mjs` implementation server-side. See
   Risks.

## Scope

### In scope

- `AiAssistRunRouter.mjs` / `AiAssistRunController.mjs` in
  `modules/ai-assist/app/src/`, following this codebase's existing module
  router/controller convention (`modules/launchpad`, `modules/github-sync`).
- A run manager: the turn loop, ported from `run-agent.ts`'s shape into a
  backend `.mjs`, driving provider calls and tool dispatch.
- Redis-backed run state: status, event log, heartbeat, Pub/Sub for
  cross-instance event delivery (`web` runs multiple replicas in production;
  a run started on one instance must be reconnectable from a request landing
  on another).
- SSE endpoint for streaming/reconnect, a start endpoint, a stop endpoint, an
  approve endpoint.
- Server-side rewrites of the 7 existing tools (`project_map`, `read_file`,
  `search_project`, `edit_file`, `create_file`, `compile_project`,
  `get_compile_log`) against server-side project data instead of
  `ProjectHandle`.
- Frontend rewiring: `use-agent-run.ts` talks to the new endpoints instead of
  calling `runAgent()` and executing tools in-page.
- `interrupted` reconciliation and transcript back-fill.

### Out of scope

- The compile-log "Suggest fix" flow (`fix-store.ts`) — unchanged, stays
  in-page.
- Any new tools beyond the existing 7.
- Idle/cost safety caps (explicitly declined — Decision 2).
- API-key-at-rest persistence beyond one run's lifetime (explicitly declined
  — Decision 4).
- Load-testing multi-instance Pub/Sub fan-out at scale.

**Implementation phasing note:** this spec describes the target end state as
one coherent design. Given its size — a new backend subsystem plus a full
rewrite of every tool's execution path — the implementation plan
(next step) should sequence it rather than land it as one change; a natural
split is "run infrastructure + SSE transport + the 3 read-only tools" before
"the two write tools + approval-as-server-state." That sequencing is a
planning concern, not a design one, and is deferred to the plan.

## Architecture

### §1 Router & Controller

`POST /ai-assist/projects/:projectId/runs` starts a run from a transcript and
returns `{ runId }` immediately. `GET /ai-assist/runs/:runId/stream?since=<seq>`
opens an SSE stream of `AgentEvent`s from a cursor — the same endpoint a fresh
connection and a reconnect both use. `POST /ai-assist/runs/:runId/stop` and
`POST /ai-assist/runs/:runId/approve` cover the two user-driven actions.
All four are scoped to the requesting user's own project access, same as any
other `web` route.

### §2 Run manager & Redis schema

One run manager instance drives the loop for a run on whichever `web`
replica owns it: build request → `streamChat` → parse text/tool calls (same
logic as today's `run-agent.ts`) → dispatch tools → append each `AgentEvent`
to Redis and publish it → repeat until `turnFinished`. Redis holds, per run:
status (`running` / `awaitingApproval` / `stopped` / `error` / `interrupted`
/ `done`), the ordered event log, and an owner heartbeat. Pub/Sub carries
events to whichever replica(s) currently have an open SSE stream for that
run, independent of which replica is actually driving it.

### §3 Tool execution

Each tool's server-side implementation reads/writes through the same
internal paths `web` already uses elsewhere: `read_file` / `search_project` /
`outline_project` / `project_map` become lookups against project docs via
`docstore`; `edit_file` / `create_file` write through the same doc-update
path the editor's own save flow uses, so edits stay consistent with
real-time collaboration and project history rather than a side-channel
write; `compile_project` / `get_compile_log` call `clsi` the way a normal
compile request already does.

### §4 Approval flow

`edit_file` / `create_file` still suspend the loop (`tool.suspends`,
unchanged). The run manager writes `awaitingApproval` + the pending edit to
Redis and stops advancing the loop. `POST .../approve` with the user's
decision resumes it — from any tab, at any time, since the state lives in
Redis, not a page's in-memory `Promise`.

### §5 Frontend rewiring

`use-agent-run.ts` drops its direct `runAgent()` call and the tool-execution
responsibility. `run()` becomes: `POST` to start, open the SSE stream, feed
each event into the existing, unchanged `reduceAgentEvent` reducer. `stop()`
posts to the stop endpoint. `onDecision()` posts to the approve endpoint. On
mount, if a run for the current conversation is already active, the page
just opens the SSE stream from the last known cursor — no separate "attach"
protocol is needed, since the stream endpoint already accepts a `since`
cursor for exactly this case.

## Data flow

- **Start:** page `POST`s a transcript + resolved provider settings (incl.
  key) → controller creates the run in Redis, kicks off the run manager, and
  responds with `runId` → page opens the SSE stream immediately.
- **Steady state:** run manager streams from the provider, emits
  `AgentEvent`s → Redis append + publish → every subscribed SSE connection
  (any tab, any replica) receives it and updates local `AgentState` via the
  existing reducer.
- **Reload/reconnect:** new page load reopens the SSE stream with
  `since=<last known seq>` → misses nothing, no special-cased replay logic.
- **Multi-tab:** free. Two tabs open two SSE streams against the same Redis
  state; both render identically. No driver election, no mirroring logic —
  the complexity that a Service Worker design would have needed here simply
  doesn't exist in a server-owned model.
- **Stop:** `POST .../stop` → run manager aborts its own provider request,
  finishes the loop, emits `turnFinished: aborted`, marks the run `stopped`.
- **Approval:** `awaitingApproval` event → `POST .../approve` → run manager
  resumes.

## Error handling

- **Upstream provider error:** unchanged in substance — a `ProviderError`
  from `streamChat` becomes an `error` event server-side exactly as it does
  in today's `run-agent.ts`, persisted and published, run marked `error`.
- **Backend restart / crash mid-run:** the owning run manager's heartbeat
  goes stale. On next contact (a periodic sweep, or the next reconnect
  attempt for that run) the run is reconciled to `interrupted`, and the
  saved transcript is patched with a clear "this response didn't finish —
  the connection was lost" terminal entry, distinct from a user-initiated
  stop or a real provider error.
- **Tool execution failure:** unchanged — becomes data for the model
  (`{ error: ... }`, `isError: true`), never ends the run, same as today.
- **No client ever reconnects:** per Decision 2, nothing special happens —
  the run keeps going (or keeps waiting on an approval) until it reaches a
  natural terminal state on its own.

## Testing

- `AiAssistRunController` request/response tests, following this codebase's
  existing mocha + chai backend pattern.
- The run manager's turn loop against a mocked provider client — mirrors how
  `run-agent.ts`'s loop logic is tested today, just server-side.
- Each rewritten tool against a real test-project fixture instead of a
  mocked `ProjectHandle`.
- Interrupted-reconciliation: a run left with a stale heartbeat is correctly
  relabeled and the transcript patched.
- Frontend: `use-agent-run.ts` tested against a mocked SSE stream instead of
  a mocked `runAgent()` generator.

## Risks

- **Provider client drift.** Duplicating `anthropic.ts` / `openai.ts` /
  `ollama.ts` server-side (Decision 8) means the two implementations can
  drift out of sync as providers change their APIs. Mitigation: keep the
  server-side versions minimal and structurally parallel to the frontend
  ones, and flag in code review whenever one changes without the other.
- **Tool rewrite is the largest single piece of this design** and the one
  most likely to reveal scope the plan needs to split further — editing a
  live document server-side, consistently with real-time collaboration and
  history, is materially harder than editing it through a mounted
  CodeMirror instance.
- **Cross-instance Pub/Sub correctness** under real multi-replica production
  load is asserted by design here, not load-tested as part of this
  sub-project.

## Deletions

None from existing code yet — this adds a new execution path alongside the
existing one. Once it ships, `use-agent-run.ts`'s direct call to `runAgent()`
for the main chat panel is removed in favor of the SSE-backed client
(§5). `run-agent.ts` itself, and the browser-side tool implementations, stay
in place — they remain exactly what drives the still-in-scope compile-log fix
flow (Decision 1).

## What this does not change

- The tool set and their specs (still the same 7 tools).
- The system prompt, context envelope, and token budget from sub-projects
  3/5.
- The transcript/message UI — `SubresultGroup`, `ToolCallCard`,
  `AgentState`, `reduceAgentEvent` — all unchanged; they still just consume
  an `AgentEvent` stream, now arriving over SSE instead of from an in-page
  generator.
- The compile-log "Suggest fix" flow, entirely (Decision 1).
- `AI_ASSIST_ENABLED` default-off behavior.
