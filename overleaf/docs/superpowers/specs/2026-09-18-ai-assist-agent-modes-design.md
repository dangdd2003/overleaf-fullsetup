# AI Assist — Agent Modes (Manual / Accept edits / Plan)

Date: 2026-09-18
Status: Approved design, not yet implemented
Worktree: `.claude/worktrees/ai-assist` (branch `worktree-ai-assist`)
Module root (all relative paths below): `overleaf/services/web/modules/ai-assist/`

## 1. Goal

Give the main AI Assist chat three permission modes that behave like Claude's
(Claude Code / Claude desktop, see https://code.claude.com/docs/en/permission-modes):

| Mode | Label in UI | One-line description shown in picker |
|---|---|---|
| `manual` | Manual | Ask before every change to the project |
| `acceptEdits` | Accept edits | Apply file edits automatically, ask for everything else |
| `plan` | Plan mode | Research only, then propose a plan for approval |

The user switches mode from a picker in the chat composer (or `Shift+Tab` in the
composer textarea), before or during a run. In Plan mode the model finishes by
presenting a plan; approving it switches the same run into Manual or Accept edits
and the model executes the plan.

## 2. Non-goals

- The error-panel "Suggest fix" run (`frontend/js/features/ai-assist/agent/fix-run.ts`,
  `components/suggest-fix-panel.tsx`, in-page `run-agent.ts`) is **not** changed.
  It keeps its current behaviour.
- No Claude "auto" (classifier) mode, no "bypass permissions" mode, no allow/deny
  rule configuration.
- No new env flag: the feature ships inside the ai-assist module, which is already
  gated by the module's existing enable flag. With the module disabled nothing
  changes.
- No instance-wide default mode setting.

## 3. Decisions already made (do not re-ask)

1. Scope: main chat only (server-side background runs).
2. Manual mode asks for file edits/creates **and** settings changes. Compile does not ask.
3. Mode is stored **per conversation** in chat history. New chats start in `manual`.
   Old chats without a stored mode load as `manual`.
4. Enforcement is **server-side** in the run harness. Prompt text only informs the
   model; it never is the enforcement.
5. Mid-run mode switches are allowed and take effect from the next tool call.

## 4. Current architecture (verified 2026-09-18)

Main chat flow:

- `frontend/js/features/ai-assist/hooks/use-agent-run.ts:302` calls
  `startBackgroundRun` (`agent/background/background-run-client.ts:43`), which
  POSTs `{ transcript, providerSettings }` to `/ai-assist/projects/:Project_id/runs`.
- `app/src/AiAssistRunController.mjs:22` `createRun` validates and calls
  `manager.startRun({ runId, projectId, userId, transcript, providerSettings })`.
- `app/src/AiAssistRunManager.mjs:308` `startRun` runs the agent loop:
  - Tool sets: `FILE_EDIT_TOOLS` (line 66), `READ_ONLY_TOOLS` (line 71).
  - Each turn picks tool specs at lines 416–419 (drops edit tools after the user
    declined an edit) and budgets with `SYSTEM_PROMPT` (lines 422, 452).
  - Leading read-only calls are prefetched in parallel (~line 492).
  - Per call loop starts ~line 513. `edit_file` is pre-checked with
    `tools.checkEdit` (~line 524). `edit_file`/`create_file` build `approvalEdit`,
    call `store.setPendingApproval`, emit `awaitingApproval`, and await a decision
    promise with timeout/abort handling (~lines 548–645). Every other tool runs
    directly (~line 648).
  - `approveEdit(runId, decision)` (line 818) resolves the pending promise locally
    or publishes via `this.control` for other web processes (`handleControl`
    ~line 836).
- `app/src/AiAssistSystemPrompt.mjs` exports a **constant** `SYSTEM_PROMPT`. It is
  constant on purpose for provider prompt caching (see comment at top of file).
- Approval endpoint: `POST /ai-assist/projects/:Project_id/runs/:runId/approve`
  (`AiAssistRunRouter.mjs:56`) → `AiAssistRunController.approve` (line 205), body
  `{ accepted, note? }`. A legacy route `/ai-assist/runs/:runId/approve` also exists
  (line 107).
- Frontend events: `agent/agent-events.ts` (`AgentEvent` union), reducer
  `agent/agent-state.ts` (`awaitingApproval` at line 265 sets `pendingApproval`).
- Approval UI: `components/agent/subresult-group.tsx:285-307` renders
  `EditApprovalCard` (`components/agent/edit-approval-card.tsx`) only for pending
  calls named `edit_file`/`create_file`. Decisions go through `onDecision` in
  `use-agent-run.ts:155` → `approveBackgroundEdit`.
- Settings tools `configure_appearance_settings`, `configure_compiler_settings`,
  `configure_editor_settings` execute server-side in `app/src/AiAssistTools.mjs`
  (cases at ~1501, ~1579, ~1653); their result carries `updatedSettings`, which the
  frontend applies live via `applyLiveSettingsUpdate` (`use-agent-run.ts:105`).
- Chat history: `app/src/AiAssistChatHistoryStore.mjs` `saveChat(projectId, userId,
  chatId, transcript)` (line ~88) writes `{ id, projectId, userId, title, createdAt,
  updatedAt, transcript }`. Controller `AiAssistChatHistoryController.mjs:47` reads
  `req.body.transcript`. Frontend `agent/chat-history-client.ts:46` `saveChat`,
  called from `components/agent/agent-panel.tsx:284`.
- Composer: `components/agent/agent-composer.tsx` (props at lines 28–52).
- Tests: backend `test/unit/src/AiAssistRunManager.test.mjs`; frontend
  `test/frontend/js/agent/agent-state.test.ts`. Both under the module root.

## 5. Design

### 5.1 Mode policy (new, pure, server)

New file `app/src/AiAssistModePolicy.mjs`. No I/O, no imports besides constants.

```js
export const MODES = ['manual', 'acceptEdits', 'plan']
export const DEFAULT_MODE = 'manual'
export function normalizeMode(value) // returns value if in MODES, else DEFAULT_MODE

export const SETTINGS_TOOLS = new Set([
  'configure_appearance_settings',
  'configure_compiler_settings',
  'configure_editor_settings',
])
export const PLAN_TOOL = 'present_plan'

// 'allow' | 'ask' | 'deny'
export function decide(mode, toolName)

// Filters the full tool spec list to the specs offered to the model in `mode`.
export function toolSpecsFor(mode, allSpecs)
```

Decision table (this is the source of truth):

| Tool | manual | acceptEdits | plan |
|---|---|---|---|
| any tool in `READ_ONLY_TOOLS` | allow | allow | allow |
| `compile_project` | allow | allow | allow |
| `edit_file`, `create_file` | ask | **allow** | deny |
| `SETTINGS_TOOLS` | ask | ask | deny |
| `present_plan` | deny | deny | ask |
| any other / unknown name | allow (the existing unknown-tool handling produces the error) | same | deny |

`toolSpecsFor(mode, allSpecs)` returns specs whose `decide` is not `deny`, and
appends the `present_plan` spec only in `plan`. `READ_ONLY_TOOLS` stays defined in
`AiAssistRunManager.mjs`; move it (and `FILE_EDIT_TOOLS`) into the policy file and
re-export from `AiAssistRunManager.mjs` so existing imports keep working.

### 5.2 `present_plan` tool

Spec (offered only in `plan`):

```json
{
  "name": "present_plan",
  "description": "Present your finished plan to the user for approval. Call this once research is complete and you know exactly what to change. The user will approve (you then switch to an editing mode and carry the plan out) or ask you to keep planning with feedback.",
  "parameters": {
    "type": "object",
    "properties": {
      "plan": { "type": "string", "description": "The plan in Markdown: what will change, in which files, in what order." }
    },
    "required": ["plan"]
  }
}
```

It is not executed by `AiAssistTools`; the run manager handles it (5.4).

### 5.3 Mode-aware system prompt

`SYSTEM_PROMPT` must remain a constant. Add in `app/src/AiAssistSystemPrompt.mjs`:

```js
export const MODE_PROMPTS = { manual: '...', acceptEdits: '...', plan: '...' }
export function systemPromptFor(mode) // SYSTEM_PROMPT + '\n\n' + MODE_PROMPTS[normalizeMode(mode)]
```

Each suffix is a fixed string (so there are exactly three cacheable prefixes).
Content, short and factual:

- `manual`: `# Mode: Manual` — file edits and settings changes are shown to the user
  for approval before they apply; a declined change is not applied.
- `acceptEdits`: `# Mode: Accept edits` — file edits apply immediately without
  approval; settings changes still need approval.
- `plan`: `# Mode: Plan` — you cannot edit files or change settings. Read, search
  and compile to understand the project, then call `present_plan` with a concrete
  plan. If the user only asked a question, answer it without a plan. If the user
  asks you to keep planning, revise and call `present_plan` again.

The loop uses `systemPromptFor(liveMode)` at both places that currently pass
`SYSTEM_PROMPT` (lines 422 and 452).

### 5.4 Run manager changes (`app/src/AiAssistRunManager.mjs`)

1. `startRun` accepts `mode`. Store it on the `activeRuns` entry as a mutable
   field: `{ ..., mode: normalizeMode(mode) }`. Also persist it with the run
   (`store.createRun({ runId, projectId, userId, mode })`, add a `mode` field in
   `AiAssistRunStore.mjs`) so a reconnecting client can read it.
2. At the start of every turn read `const mode = active.mode` and use
   `toolSpecsFor(mode, allToolSpecs)` in place of `allToolSpecs`, keeping the
   existing `userDeclinedEdit` filter applied after it.
3. Before handling each call, `const verdict = decide(active.mode, call.name)`
   (read live, so mid-run switches apply to the next call):
   - `deny` → do not execute. Result:
     `{ status: 'denied', error: 'This tool is not available in <Mode label> mode.' }`,
     `isError: true`. For plan mode append: `Use read-only tools and call present_plan.`
     Denied calls must **not** count toward the consecutive-failure / identical-failure
     stop logic (they are a harness decision, not a model failure).
   - `allow` for `edit_file`/`create_file` (acceptEdits) → keep the `checkEdit`
     pre-check; if the plan is not ok return it as today; otherwise execute directly
     with the same `execArgs` construction used after approval. Do not emit
     `awaitingApproval`. The existing `toolCallFinished` carries the result so the
     tool card shows the diff.
   - `ask` for `edit_file`/`create_file` → existing approval path, unchanged, except
     the pending payload gets `kind: 'edit'` (see 5.5).
   - `ask` for `SETTINGS_TOOLS` → same approval mechanism with
     `kind: 'settings'`, payload `{ kind: 'settings', toolName: call.name, args: call.args }`.
     On accept, execute the tool. On decline, result
     `{ status: 'rejected', message: 'The user declined this settings change<note>. Do not retry it in this turn.', note }`.
     A declined settings change does **not** set `userDeclinedEdit`.
   - `ask` for `present_plan` → approval mechanism with `kind: 'plan'`, payload
     `{ kind: 'plan', plan: call.args.plan }`. Decision shapes and outcomes in 5.6.
   - `allow` for everything else → existing path, unchanged.
4. Extract the existing "await a decision with timeout + abort" block (~lines
   584–618) into one private helper, e.g.
   `async #awaitDecision(runId, controller, approvalPromiseResolvers, pending)`
   which calls `setPendingApproval`, emits `awaitingApproval`, awaits, and returns
   the decision. All three `ask` kinds use it. Timeout and abort behaviour stay
   exactly as today.
5. New method `setMode(runId, mode)`: normalise; update the local `activeRuns`
   entry if present, else publish `{ action: 'setMode', mode }` via `this.control`
   (mirror `approveEdit` line 818 and `handleControl` line 836). Emit
   `{ type: 'modeChanged', mode, source: 'user' }` and update the stored run.
   A pending approval is **not** auto-resolved by a mode switch.
6. The loop's final events must stay the same (`turnFinished`, status updates).

### 5.5 Approval payload and events

`awaitingApproval` becomes a discriminated payload. Keep the existing `edit` key for
backward compatibility:

```ts
| { type: 'awaitingApproval'; id: string; kind?: 'edit'; edit: EditRequest }
| { type: 'awaitingApproval'; id: string; kind: 'settings'; settings: { toolName: string; args: Record<string, unknown> } }
| { type: 'awaitingApproval'; id: string; kind: 'plan'; plan: string }
| { type: 'modeChanged'; mode: AgentMode; source: 'user' | 'planApproval' }
```

Missing `kind` means `edit`. `store.setPendingApproval` stores the same object so
reconnect (`use-agent-run.ts` reconnect path ~line 342) restores the right card.

### 5.6 Plan approval decisions

Body for `POST .../approve` when the pending kind is `plan`:

| User choice (button label) | Body | Server outcome |
|---|---|---|
| Yes, auto-accept edits | `{ accepted: true, nextMode: 'acceptEdits' }` | set `active.mode = 'acceptEdits'`, emit `modeChanged` (`source: 'planApproval'`), tool result `{ status: 'approved', mode: 'acceptEdits', message: 'The user approved the plan. You are now in Accept edits mode: carry out the plan now.' }`, loop continues |
| Yes, manually approve edits | `{ accepted: true, nextMode: 'manual' }` | same with `manual` and message saying each edit will be reviewed |
| No, keep planning | `{ accepted: false, note }` | mode stays `plan`, tool result `{ status: 'keepPlanning', note, message: 'The user wants you to keep planning. Revise the plan using their feedback and call present_plan again.' }`, loop continues |
| Timeout / Stop | as today | result `{ status: 'rejected', note }`; run ends as today |

`nextMode` other than `manual`/`acceptEdits` → treated as `manual`. The controller
passes the body through unchanged (it already does, `AiAssistRunController.mjs:217`).
A plan decline does **not** set `userDeclinedEdit`.

### 5.7 HTTP

- `createRun` (`AiAssistRunController.mjs:22`): read `mode` from `req.body`, pass
  `normalizeMode(mode)` to `startRun`. Missing → `manual`.
- New route `POST /ai-assist/projects/:Project_id/runs/:runId/mode`, middleware
  identical to `/approve` (`AiAssistRunRouter.mjs:55-60`), controller method
  `setMode` that performs the same 404/403 checks as `approve` (lines 206–215), then
  rejects a `mode` not in `MODES` with 400, then `manager.setMode(runId, mode)`.
  No legacy fallback route is needed.

### 5.8 Chat history persistence

- Store: `saveChat(projectId, userId, chatId, transcript, mode)` writes
  `mode: normalizeMode(mode)`. `getChat` returns the stored object; if `mode` is
  missing the frontend treats it as `manual`.
- Controller `save`: pass `req.body.mode`.
- Frontend `chat-history-client.ts`: `saveChat(projectId, chatId, transcript, mode)`
  sends `{ transcript, mode }`; `StoredChat` gains `mode?: AgentMode`.

### 5.9 Frontend

New type in `agent/agent-mode.ts`:

```ts
export type AgentMode = 'manual' | 'acceptEdits' | 'plan'
export const AGENT_MODES: AgentMode[] = ['manual', 'acceptEdits', 'plan']
export function nextMode(mode: AgentMode): AgentMode // cycles in AGENT_MODES order
```

State:
- `agent-state.ts`: `AgentState` gains `mode: AgentMode` (initial `'manual'`).
  `modeChanged` event sets it. `awaitingApproval` stores the whole event payload in
  `pendingApproval` (`{ id, kind, edit? , settings?, plan? }`).
- Loading a chat (`fetchChat`) sets `mode` from the stored chat (default `manual`);
  "new chat" resets to `manual`.
- `agent-panel.tsx:284` passes `state.mode` to `saveChat`. Also save when the mode
  changes.

Starting a run: `startBackgroundRun` takes `mode` and includes it in the POST body;
`use-agent-run.ts:302` passes `state.mode`.

Switching mode (`use-agent-run.ts` new `setMode(mode)`): update state; if a
background run is active (`currentRunIdRef.current`), call new client function
`setBackgroundRunMode(runId, mode)` → `POST .../runs/:runId/mode`. On failure keep the
local state and log a warning (the next run will carry the mode anyway).

Composer (`agent-composer.tsx`): new props `mode: AgentMode`,
`onModeChange: (m: AgentMode) => void`.
- A compact dropdown button at the left of the composer footer showing an icon and
  label (Phosphor icons: `HandPalm` Manual, `PencilSimple` Accept edits,
  `ListChecks` Plan mode). Menu items show label + the one-line description from §1,
  with a check on the current mode. Use the existing OL dropdown components used
  elsewhere in the module.
- `Shift+Tab` in the textarea calls `onModeChange(nextMode(mode))` and
  `preventDefault()`.
- Non-manual modes get a subtle tinted pill (use existing CSS variables; add styles
  in `frontend/stylesheets/ai-assist.scss`). Keep it small — the panel is narrow.
- Enabled while a run is going (mid-run switching is allowed).

Approval cards (rendered where `EditApprovalCard` is chosen today in
`subresult-group.tsx`, lines ~285–470; extend the pending-call match from
`edit_file`/`create_file` to also include `SETTINGS_TOOLS` and `present_plan`):
- `kind: 'edit'` → existing `EditApprovalCard`, unchanged.
- `kind: 'settings'` → new `components/agent/settings-approval-card.tsx`: title
  "Change settings", a key → value list of `args` (skip undefined), Approve / Decline
  buttons and an optional note field, visually matching `EditApprovalCard`.
- `kind: 'plan'` → new `components/agent/plan-approval-card.tsx`: renders `plan` with
  the existing `MarkdownContent` component, then three buttons: "Yes, auto-accept
  edits", "Yes, manually approve edits", "No, keep planning". "No, keep planning"
  reveals a textarea + Send button that submits `{ accepted: false, note }`.
  After a decision the card is locked (same pattern as `decided` in
  `EditApprovalCard`).
- After the run, a finished `present_plan` tool call renders in history as a
  collapsed tool card showing the plan markdown and the outcome
  (approved → mode / keep planning).

`onDecision` signature widens to
`(decision: { accepted: boolean; note?: string; nextMode?: AgentMode }) => void`.

i18n: add every new user-visible string to the module's existing locale mechanism
(follow how `edit-approval-card.tsx` uses `t(...)`).

## 6. Error handling

- Unknown `mode` in any request body → `normalizeMode` → `manual` (createRun, chat
  save); `/mode` endpoint returns 400 instead, because an explicit switch to an
  invalid mode is a client bug.
- `/mode` on a run that already finished → 404 if the run record is gone, otherwise
  update stored mode and return `{ ok: true }` (no active loop to affect).
- Model calls a denied tool repeatedly → each gets the `denied` result; this does not
  trip failure-stop logic, but the existing cycle detection still applies.
- Text-embedded tool calls rescued by the provider parser go through the same
  `decide` gate, so plan mode cannot be bypassed that way.

## 7. Testing

Backend (`test/unit/src/`):
- `AiAssistModePolicy.test.mjs`: every row of the §5.1 table; `normalizeMode`;
  `toolSpecsFor` includes `present_plan` only in plan and excludes denied tools.
- `AiAssistRunManager.test.mjs` (extend, reuse its fake client/tools):
  1. manual: `edit_file` emits `awaitingApproval` with `kind: 'edit'` (regression).
  2. manual: `configure_editor_settings` emits `awaitingApproval` `kind: 'settings'`;
     accept executes, decline does not execute and does not withdraw edit tools.
  3. acceptEdits: `edit_file` executes without `awaitingApproval`.
  4. acceptEdits: settings tool still asks.
  5. plan: `edit_file` call returns `status: 'denied'`, tools not executed, specs sent
     to the provider exclude edit/settings tools and include `present_plan`.
  6. plan: `present_plan` accept with `nextMode: 'acceptEdits'` emits `modeChanged`,
     next turn's specs include `edit_file`, and a following `edit_file` executes
     without approval.
  7. plan: `present_plan` keep planning returns `keepPlanning` with note, mode stays plan.
  8. `setMode` mid-run: switch manual → acceptEdits before the model's edit call →
     edit applies without approval.
  9. system prompt passed to the provider equals `systemPromptFor(mode)`.
- Controller: `createRun` forwards normalised mode; `setMode` 400/403/404 cases.
- Chat history store: `mode` round-trips; missing mode is tolerated.

Frontend (`test/frontend/js/`):
- `agent-state.test.ts`: `modeChanged` sets mode; `awaitingApproval` with each kind
  stores the payload.
- `agent-mode.test.ts`: `nextMode` cycles.
- Plan approval card: each button calls `onDecision` with the §5.6 body.

Run tests per the repo's sandbox runner notes (vitest from `overleaf/services/web`
with `XDG_DATA_HOME="$TMPDIR/xdg"`). The web unit suite has pre-existing failures on
clean main — compare against a baseline before blaming this change.

Manual check after implementation: redeploy the ai-assist dev server and verify the
three modes end to end in the browser.

## 8. File checklist

New:
- `app/src/AiAssistModePolicy.mjs`
- `frontend/js/features/ai-assist/agent/agent-mode.ts`
- `frontend/js/features/ai-assist/components/agent/settings-approval-card.tsx`
- `frontend/js/features/ai-assist/components/agent/plan-approval-card.tsx`
- `test/unit/src/AiAssistModePolicy.test.mjs`
- `test/frontend/js/agent/agent-mode.test.ts`

Modified:
- `app/src/AiAssistRunManager.mjs`, `AiAssistRunController.mjs`,
  `AiAssistRunRouter.mjs`, `AiAssistRunStore.mjs`, `AiAssistSystemPrompt.mjs`,
  `AiAssistChatHistoryStore.mjs`, `AiAssistChatHistoryController.mjs`
- `frontend/js/features/ai-assist/agent/agent-events.ts`, `agent-state.ts`,
  `chat-history-client.ts`, `background/background-run-client.ts`
- `frontend/js/features/ai-assist/hooks/use-agent-run.ts`
- `frontend/js/features/ai-assist/components/agent/agent-composer.tsx`,
  `agent-panel.tsx`, `subresult-group.tsx`
- `frontend/stylesheets/ai-assist.scss`, locale strings
- Tests listed in §7

## 9. Constraints for the implementing agent

- Do not run any git write command (commit, push, branch, stash). Leave changes in the
  working tree.
- Do not change the Suggest-fix / error-panel run path.
- Do not add mode enforcement to prompts only; the server gate in §5.4 is required.
- Keep `SYSTEM_PROMPT` constant; mode text goes only through `systemPromptFor`.
- Line numbers above were verified on 2026-09-18 against uncommitted worktree state;
  re-locate by the quoted identifiers if they have shifted.
