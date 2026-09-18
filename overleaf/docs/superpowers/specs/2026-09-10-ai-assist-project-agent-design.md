# AI Assist for Overleaf CE — Project Agent

**Date:** 2026-09-10
**Status:** Approved design, pending implementation plan
**Sub-project:** 2 of N (follows `2026-09-09-ai-assist-error-assistant-design.md`)

## Summary

Sub-project 1 built the `ai-assist` module: a browser-side provider layer, a
provider configuration UI, a consent gate, and the error assistant that explains
a compile error and proposes a fix.

This sub-project adds the second capability: a **project agent** — a chat panel
in the editor rail that can read the whole project, search it, edit files, and
recompile, running a real tool-calling loop rather than answering one question at
a time. It is the self-hosted analogue of the "AI assistant" panel Overleaf Cloud
ships, and v1 deliberately mirrors that panel's surface.

The feature stays behind `AI_ASSIST_ENABLED`. With the flag unset the rail tab
does not render and the instance behaves exactly like upstream Overleaf CE.

## Scope

### In scope

- A rail tab and panel, attached through the existing `railEntries` module slot.
- A provider-agnostic agent loop with a bounded step budget.
- Tool calling added to the two existing provider clients, with graceful
  degradation for endpoints and models that do not support it.
- Five tools: `list_files`, `read_file`, `search_project`, `edit_file`,
  `compile_project`.
- Per-edit diff approval before anything touches a document.
- Per-project conversation history in browser storage.

### Out of scope

- Creating, deleting, or renaming files. The agent restructuring a project tree
  is a larger blast radius than an edit diff covers, and v1 follows the Cloud
  surface, which does not offer it. Revisit once edit approval has real usage.
- Any server-side component. The module has no router today and gains none here:
  no inference proxy, no stored credentials, no stored transcripts.
- Image or PDF input, embeddings, and full-project retrieval beyond plain text
  search.

## Existing seams

Everything the agent needs is already exposed to the browser by core.

| Need | Seam |
|---|---|
| Rail tab registration | `railEntries` slot, read at `frontend/js/features/ide-react/components/rail/rail.tsx:38`; declared empty at `config/settings.defaults.js:1174` |
| Panel chrome | `RailPanelHeader`, `frontend/js/features/ide-react/components/rail/rail-panel-header.tsx` |
| Project-wide file list and contents | `useProjectContext().projectSnapshot` — `refresh()`, `getDocPaths()`, `getDocContents(path)`, `locateFile()` (`frontend/js/infrastructure/project-snapshot.ts:12`) |
| Precedent for using that snapshot | `modules/full-project-search/frontend/js/util/search-snapshot.ts`, and the word-count modal |
| Bringing a target document into the editor | `useEditorManagerContext().openDocWithId` (`frontend/js/features/ide-react/context/editor-manager-context.tsx:490`) |
| Applying an edit as one undo step | `applyFixToView`, `lineRangeToOffsets`, `hasDrifted` in `modules/ai-assist/frontend/js/features/ai-assist/apply-fix.ts` |
| Compile and compile log | `useLocalCompileContext()` — `startCompile`, `logEntries` (`frontend/js/shared/context/local-compile-context.tsx:693,767`) |
| Provider streaming, model listing, typed errors | `providers/openai.ts`, `providers/anthropic.ts`, `providers/sse.ts`, `providers/types.ts` |
| Provider configuration and consent | `provider-store.ts`, `components/provider-form.tsx`, `components/ai-providers-widget.tsx` |

### Core file changes required

Two lines, both additive and both inert when the module is disabled:

1. `config/settings.defaults.js:1174` — register the module's rail entry in
   `railEntries`, currently `[]`.
2. `frontend/js/features/ide-react/context/rail-context.tsx:20` — add
   `'ai-assist'` to the `RailTabKey` union.

New translation keys go in `locales/en.json` as usual.

## Architecture

The agent runs in the page. The browser already holds the session, the file
tree, the live document, and the compile controls; routing any of it through a
server would mean re-fetching state the page already has, and would put Overleaf
back in the path of inference, which this module exists to avoid.

The design's spine is a single interface, `ProjectHandle`, between the agent
loop and Overleaf. Tools depend only on that interface, so the entire tool layer
is testable with a fake and no React, no DOM, and no network.

### Module layout

```
modules/ai-assist/frontend/js/features/ai-assist/
  agent/
    run-agent.ts           provider-agnostic tool-call loop (async generator)
    agent-events.ts        the event union the loop yields
    agent-messages.ts      transcript <-> provider message-array conversion
    system-prompt.ts       LaTeX-agent prompt plus project preamble
    project-handle.ts      the ProjectHandle type and a fake for tests
    use-project-handle.ts  the only React-aware piece: contexts -> handle
    conversation-store.ts  per-project transcripts in localStorage
    tools/
      registry.ts          name -> { schema, execute, suspends }
      list-files.ts
      read-file.ts
      search-project.ts
      edit-file.ts
      compile-project.ts
  components/agent/
    agent-panel.tsx        header, empty state, transcript, composer
    agent-empty-state.tsx  "Advanced tools" and "Start a chat"
    agent-composer.tsx     input, attach, send/stop
    agent-message.tsx      user and assistant turns
    tool-call-card.tsx     collapsed tool activity
    edit-approval-card.tsx diff with Accept / Reject
  rail-entry.tsx           default export for the railEntries slot
```

### The project handle

```ts
export type ProjectFile = {
  path: string
  type: 'doc' | 'binary'
  size: number
}

export type EditRequest = {
  path: string
  oldText: string
  newText: string
}

export type LogEntrySummary = {
  message: string
  file: string | null
  line: number | null
}

export type EditOutcome =
  | { status: 'applied' }
  | { status: 'rejected'; note?: string }
  | { status: 'noMatch' }
  | { status: 'ambiguous'; matches: number }
  | { status: 'drifted' }

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
  ): Promise<Array<{ path: string; line: number; text: string }>>
  currentSelection(): {
    path: string
    from: number
    to: number
    text: string
  } | null
  proposeEdit(edit: EditRequest): Promise<EditOutcome>
  compile(): Promise<{
    status: string
    errors: LogEntrySummary[]
    warnings: LogEntrySummary[]
  }>
}
```

`use-project-handle.ts` implements it:

- **Reads** call `projectSnapshot.refresh()` then `getDocPaths()` and
  `getDocContents(path)`. Binary files are listed but not readable; `read_file`
  on one returns an explanatory tool error.
- **Search** reuses the CodeMirror `SearchCursor` approach that
  `full-project-search` already applies to the same snapshot, rather than a
  hand-rolled scan.
- **Selection** comes from the CodeMirror view. The panel renders in the rail,
  outside the source editor's provider, so it reaches the view through the same
  window-event bridge `apply-fix-listener.tsx` already establishes, extended
  with agent events. That listener stays registered in `sourceEditorComponents`.
- **Writes** go through `proposeEdit`, described under "Edit approval" below.
- **Compile** calls `startCompile()` and resolves once `logEntries` updates,
  summarising errors and warnings to message, file, and line.

## Provider tool calling

`ChatRequest` gains an optional `tools: ToolSpec[]`. `ChatChunk` gains a
`tool_call` variant, and `done` carries a stop reason:

```ts
export type ToolSpec = {
  name: string
  description: string
  parameters: object // JSON Schema
}

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; stopReason?: 'stop' | 'tool_calls' | 'length' }
```

Both clients keep their current shape: `streamChat` stays an async generator and
`parseSseFrames` is untouched.

**`OpenAiClient`** sends `tools` and `tool_choice: 'auto'`. It accumulates
`choices[0].delta.tool_calls[].function.arguments` fragments keyed by index and
emits one `tool_call` per index when the stream ends. On the next request, an
assistant turn replays as an assistant message carrying `tool_calls`, followed by
one `role: 'tool'` message per result.

**`AnthropicClient`** sends `tools`, reads `content_block_start` for `tool_use`
blocks and `input_json_delta` for their arguments. Results replay as a user
message whose content is an array of `tool_result` blocks.

Argument JSON is parsed only once a call is complete. A malformed blob becomes a
tool error returned to the model, never a thrown exception.

### Capability degradation

`openai-compatible` endpoints and small Ollama models frequently do not support
tools. When the first request with `tools` fails with a 400 naming tools, or the
model returns prose describing a tool call instead of calling one, the session
falls back to plain chat without tools and the panel shows a single line
explaining that the selected model cannot use project tools. The result is
cached per model id so the probe happens once, not once per turn.

## The agent loop

`runAgent()` is an async generator over a typed event union, which makes the
panel a pure reducer and lets tests drive the loop with no React:

```ts
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCallStarted'; id: string; name: string; args: unknown }
  | { type: 'toolCallFinished'; id: string; result: unknown; isError: boolean }
  | { type: 'awaitingApproval'; id: string; edit: EditRequest }
  | { type: 'turnFinished'; reason: 'stop' | 'budget' | 'aborted' }
  | { type: 'error'; code: ProviderErrorCode; message: string }
```

Each iteration streams a provider turn, emits its text, executes any tool calls
in order, appends the results, and repeats until the model stops, the budget is
spent, or the run is aborted.

Three guards live in the loop rather than being scattered through tools:

- **Step budget** — 12 tool calls per user turn. On exhaustion the loop emits
  `turnFinished` with reason `budget`; the panel offers "Continue", which starts
  a fresh budget on the same transcript.
- **Compile throttle** — at most one compile in flight, and a minimum gap
  between compiles. A second `compile_project` call while one is running returns
  a "compile already in progress" result instead of queueing.
- **Abort** — one `AbortController` per run, tripped by the Stop button or by the
  panel unmounting. It cancels the provider fetch and rejects any pending
  approval.

### Tools

| Tool | Arguments | Result |
|---|---|---|
| `list_files` | none | Every path in the project with type and size |
| `read_file` | `path`, optional `from`/`to` | Numbered lines, plus a `truncated` flag when a cap is hit |
| `search_project` | `query`, optional `caseSensitive`, `regexp` | Up to a fixed number of `path:line:text` hits |
| `edit_file` | `path`, `oldText`, `newText` | One of the `EditOutcome` statuses |
| `compile_project` | none | Compile status with error and warning summaries |

`read_file` caps how much a single call returns so one tool call cannot flood
the context window; the model is told to request a range when it needs more.

## Edit approval

`edit_file` is the only tool that suspends the loop.

1. The tool anchors on **content, not line numbers**: `oldText` is a span the
   model expects to find. A collaborator typing above the target therefore does
   not invalidate the edit.
2. The handle locates `oldText` in the snapshot. Zero matches returns `noMatch`;
   more than one returns `ambiguous` with the count. Both are ordinary tool
   results the model can retry against with a longer anchor.
3. On a unique match the panel renders a diff card. **Nothing has touched the
   document yet.**
4. **Accept** opens the target document with `openDocWithId`, re-runs the drift
   check from `apply-fix.ts` against the live CodeMirror text, and applies the
   change in a single dispatch — one undo step, synced to collaborators through
   the normal editing path. Drift found at this point returns `drifted`, telling
   the model the file changed and to re-read it, rather than clobbering the
   user's edit.
5. **Reject** returns `rejected`, optionally with a note the user types, so the
   model adapts instead of assuming success.

## User interface

The v1 surface mirrors Overleaf Cloud's AI assistant panel.

**Rail tab.** `rail-entry.tsx` default-exports a `RailElement` with key
`'ai-assist'`, icon `auto_awesome`, title "AI assistant", and
`hide: !getMeta('ol-aiAssistEnabled')`. It renders at the bottom of the rail's
icon strip.

**Panel.**

- `RailPanelHeader` with the title "AI assistant" and a "new chat" action
  alongside the close control core already provides.
- **Empty state**, in two sections. *Advanced tools* holds one card, "Fix compile
  errors", the analogue of Cloud's "Scan for unsupported statements" mapped onto
  the tools this module actually has: it seeds a turn in which the agent compiles
  the project and works through whatever errors come back. *Start a chat* holds four starter
  rows — "What can the assistant do for me?", "Insert an equation", "Create a
  Beamer presentation", "Summarize this file" — each seeding the composer.
- **Transcript**: user messages; streamed assistant markdown; collapsed
  `tool-call-card`s summarising activity ("Read `chapters/intro.tex`",
  "Compiled — 2 errors") that expand to show arguments and result; and
  `edit-approval-card`s showing a diff with Accept and Reject.
- **Composer**: placeholder "What would you like to do?", Enter to send,
  Shift+Enter for a newline. The send button becomes Stop while a run is active.
  The attach control is a project-file picker that inserts an `@path` mention.
  On send, the composer resolves each mention through `handle.readFile` and
  appends the contents to that user message, so the agent starts with the file
  already in hand instead of spending a tool call fetching it.
- **Footer**: "AI can make mistakes. Always check responses."
- Where Cloud shows an Upgrade card, an unconfigured instance shows a
  "Configure an AI provider" call to action linking to Account Settings, reusing
  the provider widget from sub-project 1. The consent gate in `provider-store.ts`
  runs unchanged on the first send.

## Persistence

`conversation-store.ts` keys transcripts by project under
`ai-assist:chat:<projectId>`. It stores the **rendered transcript**, not a
provider-shaped message array; `agent-messages.ts` rebuilds the provider format
on load, so switching provider mid-project cannot corrupt history.

Tool results are truncated before storage and the oldest turns are dropped to
stay under a byte cap. A `QuotaExceededError` degrades to in-memory history for
the rest of the session rather than throwing, matching how `provider-store.ts`
already treats storage-denied browsers.

History is per browser. That follows from the module storing nothing on the
server, which is the same trade the provider key already makes.

## Error handling

| Condition | Behaviour |
|---|---|
| No provider configured | Panel shows the "Configure an AI provider" call to action |
| Provider rejects the key | Existing `providerAuth` error renders inline with a settings link |
| Rate limited or network failure | Existing `ProviderError` codes render inline with a retry control |
| Model or endpoint lacks tool support | Session degrades to chat without tools, with a one-line notice |
| A tool throws | Returned to the model as an error result; the turn continues |
| `edit_file` finds no match or several | `noMatch` / `ambiguous` returned so the model can retry with a better anchor |
| Document drifted before accept | `drifted` returned; the edit is not applied |
| Step budget exhausted | Turn ends with an explanation and a Continue button |
| Compile already running | `compile_project` returns "compile already in progress" |
| User presses Stop | Provider fetch aborted, pending approval rejected, partial text retained |

## Testing

**Tools** — against a fake `ProjectHandle`: reads, range reads and truncation,
search hits and caps, binary-file rejection, and every `EditOutcome` including
no-match, ambiguous, rejection, and drift discovered at accept time.

**Loop** — `runAgent` against a scripted fake provider: a text-only turn, a
single tool call, several tool calls in one turn, a rejected edit feeding back
into the next turn, budget exhaustion, compile throttling, and mid-stream abort.

**Providers** — tool-call parsing for both wire formats against recorded
fixtures, including argument deltas split across frames, a tool call interleaved
with text, and the degradation probe.

**Components** — the panel reducer over an event script, the approval card's
Accept and Reject paths, the empty state's starters, and the standing assertion
that no API key reaches the DOM.

**Default-off** — with `AI_ASSIST_ENABLED` unset the rail tab is absent and the
module contributes nothing to the page.

## Configuration

No new environment variables. `AI_ASSIST_ENABLED` already gates the module, and
the provider, key, and model come from the user's browser configuration built in
sub-project 1. The step budget, compile throttle, and read caps are constants in
the module; they become settings only if real usage shows they need to differ per
instance.

## Open questions

None blocking. Two to revisit once the agent has real usage: whether file
creation earns its place in v2, and whether the step budget of 12 is too tight
for multi-file restructuring work.
