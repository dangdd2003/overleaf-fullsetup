# AI Assist — Error Panel on the Agent Harness

**Date:** 2026-09-13
**Status:** Approved design, pending implementation plan
**Sub-project:** 4 of N

**Predecessors:**

- `2026-09-09-ai-assist-error-assistant-design.md` — built the module, the
  provider abstraction, and the first version of the error assistant this
  design replaces.
- `2026-09-10-ai-assist-project-agent-design.md` — built the agent rail, the
  tool registry, and the edit approval flow.
- `2026-09-11-ai-assist-context-optimisation-design.md` — built the static
  system prompt, the frozen `<project-context>` envelope, the token budget,
  and the LaTeX-aware tools. **Implemented.**

## Summary

The AI Assist module currently contains two unrelated ways of talking to an LLM.
The agent rail runs on optimised, cached, tool-equipped infrastructure. The
"Suggest fix" button in the compile log pane still runs the original one-shot
stack from sub-project 1: its own system prompt, a forty-line window around the
error, no tools, no caching, and a bespoke edit format.

This design retires the second stack. Suggest fix keeps its place inside the log
entry, but the work behind it becomes a real, bounded agent run on the shared
harness.

The feature stays disabled by default. With `AI_ASSIST_ENABLED` unset the meta
flag is false, every component returns null, and the instance behaves exactly
like upstream Overleaf CE.

## The problem

| | Agent rail | Suggest fix (today) |
|---|---|---|
| System prompt | static, cached `SYSTEM_PROMPT` | separate prompt in `error-prompt.ts` |
| Context | `<project-context>`: file tree, compile state, open doc, selection, attachments | ±20 lines either side of the error line |
| Tools | 9 | none |
| Caching | Anthropic breakpoints + OpenAI `prompt_cache_key` | none |
| Edits | `edit_file` anchor match, diff approval card | `<fix from= to=>`, line-range replace |
| Multi-turn | yes | one shot |

The forty-line window is the root defect. The most common LaTeX failures are not
local:

- `Undefined control sequence \includegraphics` at `chapter3.tex:87` is fixed by
  adding `\usepackage{graphicx}` to the preamble of `main.tex`.
- An unclosed brace on line 42 surfaces as an error hundreds of lines below.
- `LaTeX Error: File 'titleasfsasec.sty' not found` is a typo in a
  `\usepackage` line the window may or may not contain.

In each case the model is asked to fix something it cannot see, and the
`<fix from= to=>` format cannot express the correction even when the model
guesses right, because it addresses exactly one line range in exactly one file.

## Decisions

Six decisions were settled during brainstorming and are binding on the plan:

1. **Surface** — the suggestion stays inline in the log entry. It does not move
   to the agent rail.
2. **Edit mechanism** — `edit_file` with anchor matching and the shared approval
   flow. The `<fix>` format retires.
3. **Investigation** — read-only tools plus `edit_file`, capped at 6 steps. No
   `compile_project`.
4. **Error scope** — the clicked entry in full, plus a one-line index of the
   rest of the log. Detail is pulled lazily via `get_compile_log`.
5. **Diff rendering** — the panel's `DiffView` is promoted into the shared
   approval card rather than discarded, so the rail gains it too.
6. **Density** — the log entry is a narrow, crowded surface. The card must stay
   near its current height regardless of how much the agent investigated.

## Scope

### In scope

- A `<compile-error>` context envelope and a task block for the fix turn.
- A shared `useAgentRun` hook extracted from `agent-panel.tsx`.
- A rewritten `SuggestFixPanel` built on the rail's rendering components.
- `DiffView` promoted to a shared component and adopted by `EditApprovalCard`.
- Widening the approval callback to carry a start line.
- Deleting the superseded one-shot stack.

### Out of scope

- Changing `SYSTEM_PROMPT`. It is byte-frozen; see §1.
- Post-approval verification loops (apply the fix, recompile, confirm). The
  user recompiles; the log pane already updates itself.
- Any change to the agent rail's behaviour beyond the `useAgentRun` extraction
  and the richer diff.
- Any server-side component. The module remains frontend-only with no inference
  proxy, per the module's founding constraint.

## Architecture

### §1 One system prompt, not two

`SYSTEM_PROMPT` is not modified. Every byte of it stays identical so that the
rail and every Suggest fix click in the same browser session share one cached
system prefix.

The fix-specific instruction rides on the user turn as a `<task>` block. This is
the existing contract used as intended: static instructions live in the cached
system block, per-request instructions live in the uncached user turn.

**Cache behaviour, precisely.** The system breakpoint hits across both surfaces,
because `SYSTEM_PROMPT` is identical. The tool-spec breakpoint does *not* hit
across surfaces, because the fix agent sends 7 specs and the rail sends 9, so
the tool block differs. This is expected and acceptable; the system block is the
larger of the two.

**The seven-versus-nine gap.** `SYSTEM_PROMPT`'s `# Choosing a tool` section
enumerates all nine tools, including `compile_project` and `create_file`, which
the fix agent does not send. Rather than fork the prompt and lose the shared
cache, the task block closes the gap in one line.

The task block, verbatim:

```
<task>
The user clicked "Suggest fix" on the compile error above.

1. Explain the cause in two or three sentences, in plain language.
2. Investigate before you conclude. The error line is where LaTeX noticed the
   problem, not always where it is: a missing \usepackage in the preamble
   surfaces at the first command that needs it, and an unclosed brace surfaces
   far below itself. Check the preamble and the compile log index before you
   assume the fix is local.
3. If you are confident, call edit_file. The fix may belong in a different file
   from the one the error names. If you are not confident, say what the user
   should check instead and make no edit.

compile_project and create_file are not available for this task. Do not offer
to compile; the user will rebuild when they apply your fix.
</task>
```

### §2 `agent/context/compile-error.ts` — the error envelope

A new module with one responsibility: render a compile error and a log index as
text. It depends on nothing but `escape.ts` and its own types, so it is testable
without React, a DOM, or a network — the same rule the tools follow.

```ts
export type FocusedLogEntry = {
  level: string
  message: string
  raw: string | null
  file: string | null
  line: number | null
}

export type LogIndexEntry = {
  level: string
  file: string | null
  line: number | null
}

export function renderCompileError({
  focused,
  others,
}: {
  focused: FocusedLogEntry
  others: LogIndexEntry[]
}): string
```

Output:

```
<compile-error file="chapter3.tex" line="87" level="error">
Undefined control sequence \includegraphics
<raw>
! Undefined control sequence.
l.87 \includegraphics
                     [width=\textwidth]{fig1.png}
</raw>
</compile-error>
<compile-log-index>
2 more errors: main.tex:42, chapter3.tex:91
7 warnings
</compile-log-index>
```

Rules:

- `escapeAttribute` on `file` and `level`; `neutraliseClosingTags` on `message`
  and `raw`. A raw LaTeX log can contain anything, including a literal
  `</compile-error>`, and gets the same injection defence the project envelope
  already applies to file paths and selections.
- A null `file` or `line` omits that attribute rather than emitting `null`.
- `<raw>` is omitted entirely when `raw` is null.
- The index groups by level. Entries of the same level as the focused entry are
  listed as `file:line`, capped at 20 locations, then `+N more`. Other levels
  collapse to a count.
- `others` empty renders `<compile-log-index>no other entries</compile-log-index>`,
  which is a positive statement the model can rely on rather than an absence it
  has to interpret.

The index is deliberately thin. It exists to tell the model whether a cascade is
plausible, at a cost of roughly thirty tokens. If the index looks suspicious the
model calls `get_compile_log` and pays for detail only then.

### §3 `agent/fix-run.ts` — assembling the turn

```ts
export const FIX_TOOLS: Record<string, AgentTool>
export const FIX_MAX_STEPS = 6

export async function buildFixTranscript({
  handle,
  focused,
  others,
}: {
  handle: ProjectHandle
  focused: FocusedLogEntry
  others: LogIndexEntry[]
}): Promise<TranscriptEntry[]>
```

`FIX_TOOLS` is `TOOLS` minus `compile_project` and `create_file`: seven entries —
`list_files`, `read_file`, `outline_project`, `search_project`,
`list_references`, `edit_file`, `get_compile_log`.

`buildFixTranscript` returns exactly one user entry:

- `contextText` — `renderEnvelope({ snapshot, attachments: [], turn: 1,
  previous: null })` followed by `renderCompileError({ focused, others })`.
- `text` — the task block from §1.
- `id` — `'u0'`.

`toAgentMessages` already joins a user entry as
`` `${contextText}\n\n${text}` ``, so this needs no change to the transcript
layer. The split is the intended one: frozen context in `contextText`, the ask
in `text`.

The snapshot is built the same way `buildUserEntry` builds it in the panel:
`rootDocPath`, `listFiles`, `openFile`, `currentSelection`, and `lastCompile`
reduced to status and counts. Snapshot failure is not fatal — on a throw the
entry is returned with `contextText` carrying only the `<compile-error>` block,
so a failing file listing cannot stop the user getting an explanation.

### §4 `hooks/use-agent-run.ts` — the harness, extracted

`agent-panel.tsx` is 583 lines, of which roughly 120 are surface-agnostic:
provider resolution from stored settings, the consent gate, the
`requestApproval` promise and its `approvalRef`, `useProjectHandle`
construction, the abort controller, and the `for await` loop that reduces
`AgentEvent`s into state.

**First, the state reducer moves out of the component.** `AgentState`,
`emptyAgentState` and `reduceAgentEvent` are currently exported *from*
`agent-panel.tsx`. A `useAgentRun` that returns an `AgentState` would have to
import its type from the component that imports the hook, which is circular.
They move to `agent/agent-state.ts`, where they belong regardless: the reducer
is pure logic over `AgentEvent`s with no React in it.

Only `test/frontend/js/agent/components/agent-panel.test.tsx` imports them
today, so this is a one-line import change in one test file. The reducer's own
tests move alongside it to `test/frontend/js/agent/agent-state.test.ts`.

Both surfaces then need all of the runner. It moves to:

```ts
export function useAgentRun({
  tools,
  maxSteps,
  cacheKey,
}: {
  tools: Record<string, AgentTool>
  maxSteps: number
  cacheKey?: string
}): {
  state: AgentState
  running: boolean
  error: { code: string; message: string } | null
  handle: ProjectHandle
  run(transcript: TranscriptEntry[]): Promise<void>
  stop(): void
  onDecision(decision: { accepted: boolean; note?: string }): void
  needsConsent: boolean
  allowConsent(): void
}
```

`AgentPanel` keeps what is genuinely its own: transcript persistence via
`conversation-store`, the composer, `@`-mention file lists, and new-chat. It
passes `tools: TOOLS, maxSteps: MAX_STEPS, cacheKey: projectId`.

`SuggestFixPanel` keeps entry-id matching, open/closed state, and log-entry
chrome. It passes `tools: FIX_TOOLS, maxSteps: FIX_MAX_STEPS`.

This is the only change to the rail, and it is behaviour-preserving. The rail's
existing test suite is the gate on it.

### §5 The approval callback carries a start line

`EditRequest` is `{ path, oldText, newText }` — anchors, not positions. But
`DiffView` renders line-number gutters, which need a position.

`proposeEdit` in `use-project-handle.ts` already locates `oldText` in the
document, because that is how it distinguishes `noMatch` from `ambiguous`. It
therefore already knows the answer. The approval callback widens to carry it:

```ts
requestApproval(
  edit: EditRequest,
  context: { startLine: number }
): Promise<{ accepted: boolean; note?: string }>
```

`useProjectHandle`'s signature changes to match. Without this, gutters degrade
to no line numbers and most of the value of promoting `DiffView` is lost.

This touches the rail, so it lands inside the §4 extraction task, gated on the
rail's tests.

### §6 UI — vertical budget is the constraint

The panel renders inside a compile log entry in the `pdfLogEntryComponents`
slot: a narrow column already carrying a "No PDF" explainer, a "Last suggested
fix" summary, one entry per error with its raw log excerpt, and a "Raw logs"
section. The user can drag it much narrower than its default.

**The budget: the card stays near its current height in the steady state, no
matter how much the agent investigated.** This is a correctness requirement of
this design, not a polish concern.

**One work row, not two.** Thinking and tool calls collapse into a single row:

```
✨ Thought for 4s · read 3 files, checked references  ›
```

While streaming it is a live status — `Reading main.tex…`. Expanded, it reveals
the interleaved timeline: thinking segments and `ToolCallCard`s in chronological
order, with the chevron at the end of the text, matching the rail's established
conventions. Steady state is one row rather than seven.

**Only the pending edit shows a diff.** A decided edit collapses to a one-line
receipt — `main.tex:13 ✓ applied` or `✗ rejected`. A three-file fix is still one
diff tall. This falls out of the harness rather than being imposed on it:
`edit_file` suspends per call, so edits arrive one at a time and only one can be
pending.

**No new action row.** Accept and Reject take the slot where "Apply suggestion"
sits today, beside the existing thumbs and retry buttons. The path badge and the
Copy button merge into the existing "Suggested code" header, which becomes
`✨ main.tex:13 · Copy`.

**Long hunks fold.** `DiffView` already omits unchanged lines outside a change.
It gains a cap: past roughly 12 rendered lines the middle collapses to
`… 24 more lines ›`.

**Horizontal.** The diff body scrolls with `overflow-x: auto` and never wraps.
LaTeX source lines are long, and wrapping destroys the `-`/`+` column alignment
that makes a diff readable at a glance.

**Composition**, top to bottom: work row → markdown explanation → receipts for
already-decided edits, in the order they were decided → the pending
`EditApprovalCard`, if any → existing footer.

Receipts precede the pending card because that is chronological: a decided edit
is always older than the one still awaiting a decision, and the pending card
sits directly above the footer that carries its Accept and Reject buttons.

**`DiffView` is promoted, not deleted.** It moves from
`components/suggest-fix-panel.tsx` to `components/agent/diff-view.tsx` and is
re-typed from `{ fix: ParsedFix, docLines: string[] | null }` to
`{ oldText: string, newText: string, startLine: number }`. `EditApprovalCard`
renders it in place of its current `<pre className="ai-assist-diff">`, so the
rail inherits word-level highlighting, context lines, and gutters. One diff
component, both surfaces.

The explanation switches from `split('\n\n')` into bare `<p>` tags to
`MarkdownContent`. This is a straight upgrade: `SYSTEM_PROMPT` instructs the
model to write LaTeX commands in backticks, and today the user sees the
backticks literally.

## Data flow

1. The user clicks Suggest fix, or `use-log-events.ts:46` clicks it on their
   behalf. Either way `aiAssist:suggestFix` fires with an `entryId`.
2. The `SuggestFixPanel` for that entry opens. It reads the focused entry from
   its `logEntry` prop and the rest of the log from `handle.lastCompile()`.
3. `buildFixTranscript` freezes `<project-context>` and `<compile-error>` into
   `contextText` and sets `text` to the task block.
4. `useAgentRun.run(transcript)` → `buildRequest` → provider request with cache
   hints → `runAgent`, capped at 6 steps with 7 tools.
5. Events stream into the panel. Tool calls accumulate behind the work row.
6. `edit_file` suspends on `requestApproval` and renders the pending
   `EditApprovalCard`.
7. The user accepts. `handle.proposeEdit` applies through the existing window
   event bridge to `ApplyFixListener` inside the source editor. The card becomes
   a receipt and `aiAssist:suggestDone` fires.

## Error handling

Reuses the rail's paths. The panel's `ERROR_MESSAGES` map survives with two
changes:

- `badRequest`'s copy — "Open the file the error is in and try again" — is
  removed. The handle reads files directly now; nothing needs the file open.
- A new `contextExhausted` entry, surfaced by `buildRequest` when the window
  cannot fit the request.

`turnFinished` with `reason: 'budget'` means the 6-step cap was reached. The
panel shows whatever the model did say, plus a line stating it could not pin the
error down within its step budget and offering retry. This is an expected
outcome on a hard error, not a failure state, and must not render as one.

`turnFinished` with `reason: 'aborted'` is Stop or unmount and renders nothing.

## Testing

**New unit tests, no React required:**

- `compile-error.test.ts` — envelope rendering; index grouping and the 20-entry
  cap; a raw log containing `</compile-error>`; null `file` and `line`; the
  empty-`others` case.
- `fix-run.test.ts` — transcript shape: exactly one user entry, `contextText`
  containing both envelopes in order, `text` equal to the task block, `turn` 1,
  no attachments; and the snapshot-failure fallback.
- `FIX_TOOLS` excludes `compile_project` and `create_file` and contains the
  other seven. This is asserted directly, because it is the mechanism enforcing
  decision 3 and a later edit to the registry could silently widen it.

**Component tests:**

- `suggest-fix-panel.test.tsx`, rewritten against the existing
  `helpers/fake-handle.ts` and a stubbed provider: the explanation renders as
  markdown; the work row appears and expands to tool cards in call order; an
  `edit_file` call renders a pending approval card; accepting calls
  `proposeEdit`; a decided edit collapses to a receipt; the step-cap message
  renders on `reason: 'budget'`.
- `diff-view.test.tsx` — word-level highlight on a single-line change; context
  lines preserved on a multi-line change; the fold past 12 lines.

**Regression gates:**

- `suggest-fix-button.test.tsx` unchanged. The `data-action="suggest-fix"`
  selector is a contract with `use-log-events.ts` and must not move.
- `CoreWiring.test.mjs` unchanged: the same four slot components, same slots.
- The rail's full existing suite must pass through the §4 extraction and the §5
  callback widening. This is the safety net for the only changes this design
  makes to already-working code.

## Risks

**1. Context availability — largely resolved, still worth verifying first.**

`useProjectHandle` consumes `useProjectContext`, `useLocalCompileContext`,
`useEditorManagerContext`, and `useFileTreeData`. `SuggestFixPanel` mounts in
`pdfLogEntryComponents`, inside the PDF preview pane.

Evidence this works: `frontend/js/features/pdf-preview/hooks/use-synctex.ts`
already consumes `useEditorManagerContext`, `useFileTreeData`, and
`useProjectContext` from that same pane. And `useProjectHandle` deliberately
does *not* touch `useCodeMirrorViewContext` — it reaches the editor through
window events precisely because, as `apply-fix-listener.tsx` records, the
compile log pane renders outside the source editor provider.

The compile context resolves too: `LocalCompileProvider` is mounted in
`frontend/js/features/ide-react/context/react-context-root.tsx:120`, wrapping
the whole IDE including the PDF preview pane. `DetachCompileProvider` nests
*inside* it, which is why pdf-preview's own `useCompileContext` works there.
`useProjectHandle`'s direct `useLocalCompileContext` import therefore resolves
in the log pane in the running application.

**The residual risk is the test harness, not the app.** Today's
`suggest-fix-panel.test.tsx` renders the panel bare, because the current panel
consumes no React context at all — it talks to the editor purely through window
events. After the rewrite it needs all four contexts, so every test that mounts
it must wrap in `EditorProviders` from `test/frontend/helpers/editor-providers.tsx`.
Task 1 proves that wrapper supplies what `useProjectHandle` needs before any
other work starts; if it does not, the gap is closed in the helper rather than
by changing the handle.

**2. Cost per click rises.** From roughly forty lines of source to a file
listing, a compile summary, an error envelope, and up to six tool round trips.
The step cap and the shared system-prompt cache bound it, but it is genuinely
more expensive per click. That is the price of correctly fixing the errors the
current implementation gets wrong, and it was accepted knowingly.

**3. Refactor risk on a live 583-line component.** The `useAgentRun` extraction
and the approval-callback widening both touch working rail code. They land as
one task, before the inline panel is touched, gated on the rail's tests.

## Deletions

Removed once the rewrite lands:

- `error-prompt.ts` and `test/frontend/js/error-prompt.test.ts`
- `hooks/use-fix-stream.ts`
- `parse-fix-block.ts` and `test/frontend/js/parse-fix-block.test.ts`
- `apply-fix.ts` in full — `hasDrifted`, `lineRangeToOffsets` and
  `applyFixToView` all take a `ParsedFix` or serve the line-range format — and
  `test/frontend/js/apply-fix.test.ts`
- `AiAssistant.explainError` in `assistant.ts`
- `computeInlineDiff`'s caller changes, but the function itself moves into
  `diff-view.tsx` and survives

`apply-fix-listener.tsx` keeps its agent bridge listeners — `agentApplyEdit`,
`agentReadDoc`, `agentReadSelection`, `agentCursor`, `agentSelection` — and
loses `aiAssist:applyFix` and `aiAssist:documentSnapshot`, which exist only to
serve the retired format. Its document snapshot map goes with them: drift is
detected by anchor matching now, not by comparing snapshots.

## What this does not change

- `SYSTEM_PROMPT`, byte for byte.
- The Suggest fix button, its icon, its loading state, and its
  `data-action="suggest-fix"` contract.
- The `aiAssist:suggestFix` and `aiAssist:suggestDone` event names.
- The four registered frontend slots.
- The module's frontend-only architecture: no route proxies inference, and no
  provider credential reaches the server.
- Default-off behaviour under `AI_ASSIST_ENABLED`.
