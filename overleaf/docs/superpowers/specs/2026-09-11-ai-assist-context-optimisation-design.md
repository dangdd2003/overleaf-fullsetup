# AI Assist for Overleaf CE — Agent Context Optimisation

**Date:** 2026-09-11
**Status:** Approved design, pending implementation plan
**Sub-project:** 3 of N (follows `2026-09-10-ai-assist-project-agent-design.md`)

## Summary

Sub-project 2 shipped a working project agent: a rail panel, a provider-agnostic
tool-calling loop, five tools, and per-edit diff approval. It works, but it
feeds the model badly.

Everything the agent knows about the project is crammed into a system prompt
that is rebuilt from scratch on every turn, so no provider can cache any of it.
The file listing is a bare list of paths with no sizes, no structure, and no
sense of which file the user is actually looking at. The transcript grows without
bound — every thousand-line `read_file` result is re-sent verbatim on every
subsequent turn until the request dies. There is no LaTeX-aware tool at all, so
answering "is this `\ref` defined?" costs a full-project read.

This sub-project rebuilds the context layer. The system prompt becomes a
constant, project state moves into a cache-stable `<project-context>` envelope,
the transcript gains a token budget with deterministic elision, four LaTeX-aware
tools are added, and the composer gains `@`-mention attachment of files and line
ranges.

The feature stays behind `AI_ASSIST_ENABLED`. With the flag unset the rail tab
does not render and the instance behaves exactly like upstream Overleaf CE.

## Scope

### In scope

- A `agent/context/` unit that assembles every request: static system prompt,
  delta-encoded project envelope, attachment rendering, token budget.
- Prompt caching across all three provider clients.
- Per-model output and context-window limits, replacing today's hard-coded
  constants.
- Deterministic elision of stale tool results when a conversation outgrows the
  window.
- Four new tools: `outline_project`, `list_references`, `get_compile_log`,
  `create_file`.
- Sharpened `read_file` and `search_project`, plus token-efficient rendering of
  tool results.
- `ProjectHandle` additions: open document and cursor, last compile without
  recompiling, file creation.
- `@`-mention and paperclip attachment of files and line ranges in the composer.

### Out of scope

- Any server-side component. The module still has no router: no inference proxy,
  no stored credentials, no stored transcripts. Requests go from the browser
  straight to the provider using the user's own key.
- Deleting or renaming files. `create_file` is added (see the reversal note
  below); destructive tree operations are not.
- Image or PDF input, embeddings, and semantic retrieval. Search stays lexical.
- Model-side summarisation of history. Elision is deterministic and local.

### A reversal recorded on purpose

`2026-09-10-ai-assist-project-agent-design.md:37` placed file creation out of
scope, on the grounds that restructuring a project tree has a larger blast radius
than an edit diff covers, and that v1 should mirror the Cloud surface.

That is reversed here, deliberately. Edit approval has now been built and the
same approval card covers a new file cleanly — a creation is an all-additions
diff, which is strictly easier for a user to judge than a mid-file replacement.
The blast-radius argument applies to deletion and renaming, which stay out of
scope. Mirroring the Cloud surface is no longer a goal worth paying for when a
self-hosted agent asked to add a chapter has to tell the user to create the file
by hand first.

## The problem, concretely

Four defects, each of which the design below addresses:

1. **Nothing caches.** `run-agent.ts:36` calls `buildSystemPrompt` with a live
   file listing and the current selection. Any change to either — and the
   listing embeds file sizes that change on every keystroke — produces a
   different system string, so Anthropic's cache never hits and OpenAI's
   automatic prefix cache breaks at token zero. On a ten-turn session with a
   large project this is the dominant cost.

2. **The context is thin and duplicated.** The listing is `- path` with an
   optional `(binary)` marker: no line counts, so the model cannot choose a read
   range; no structure, so it cannot tell a chapter from a preamble. The model is
   never told which file the user has open, where the cursor is, or whether the
   project currently compiles. Meanwhile the selection is injected twice, once at
   `system-prompt.ts:46` and again at `agent-messages.ts:51`.

3. **The transcript is unbounded.** `toAgentMessages` replays every tool result
   in full, forever. A `read_file` of a 1000-line chapter is roughly 12k tokens
   that is re-sent on every following turn. There is no token accounting anywhere
   in the module, so the first symptom is a provider 400.

4. **No LaTeX awareness.** The tools treat `.tex` as plain text. Undefined
   references and missing citations — the most common class of LaTeX failure —
   can only be diagnosed by reading every file and every `.bib`.

## Architecture

A new unit owns request assembly. Tools and the loop keep their current shape.

```
agent/
  context/
    system-prompt.ts      # the constant; no project data
    project-context.ts    # ContextSnapshot -> <project-context> envelope
    outline.ts            # LaTeX structure parser
    references.ts         # \label / \ref / \cite / .bib extraction
    attachments.ts        # user-pinned attachments -> envelope section
    budget.ts             # token estimation and elision
    build-request.ts      # orchestrator
  tools/
    ...                   # existing five, plus four new
```

Everything in `context/` is a pure function over plain data. Nothing there
imports React, CodeMirror, or `fetch`, which is what makes each rendering
decision testable against a literal object rather than a mounted editor.

`build-request.ts` exposes one entry point:

```ts
export function buildRequest({
  transcript,
  limits,
}: {
  transcript: TranscriptEntry[]
  limits: { contextWindow: number; maxOutputTokens: number }
}): { system: string; messages: AgentMessage[]; cacheHints: CacheHints }
```

Note what is *not* an argument: there is no snapshot and no attachment list.

### Envelopes are rendered once, at send time

Reproducing turn 1's envelope on turn 5 would require turn 1's snapshot, and
snapshots are not retained — the project has moved on. Re-deriving it from the
current snapshot would produce different bytes every turn, which is exactly the
cache defeat this whole design exists to remove.

So the envelope is rendered **once, when the user sends the message**, and
persisted onto the user transcript entry:

```ts
type UserEntry = {
  id: string
  role: 'user'
  text: string
  /** The rendered <project-context> block, frozen at send time. */
  contextText?: string
  /** Carried forward so the next turn can delta-encode against it. */
  envelopeState?: EnvelopeState
  attachments?: Attachment[]
}

export type EnvelopeState = { turn: number; filesFingerprint: string }
```

`renderEnvelope` is called from the send path with the live `ContextSnapshot`
and the previous entry's `envelopeState`; it returns the text and the new state.
`buildRequest` then never re-renders anything — it concatenates `contextText`
with `text`, runs the budget pass, and computes cache hints. History is
byte-immutable by construction, a reloaded conversation is identical to a live
one, and the prefix-stability guarantee follows from the data model rather than
from care.

The existing `selection` field on the user entry is folded into `contextText`;
`attachments` is stored alongside because the panel renders chips from it.

`runAgent` calls `buildRequest` once at the start of a user turn, not once per
loop iteration. Rebuilding mid-turn would move the envelope and invalidate the cache
for the entire tail; the model learns about changes it just made from the tool
results themselves, which is both cheaper and more accurate.

### ContextSnapshot

`ProjectHandle` gains the accessors the snapshot needs. The existing seven
methods are unchanged, so no current tool or test is disturbed:

```ts
export type ContextSnapshot = {
  rootDocPath: string | null
  files: ProjectFile[]           // gains `lines` for docs
  openFile: { path: string; cursorLine: number | null } | null
  selection: Selection | null
  compile: {
    status: 'success' | 'failure' | 'none'
    errorCount: number
    warningCount: number
  }
}

export interface ProjectHandle {
  // ...existing seven, unchanged...
  openFile(): { path: string; cursorLine: number | null } | null
  lastCompile(): LastCompile | null
  createFile(request: { path: string; content: string }): Promise<EditOutcome>
}

/** The last compile, including the raw log `get_compile_log` excerpts from. */
export type LastCompile = CompileOutcome & { rawLog: string | null }
```

`openFile` reads `currentDocumentId` from the editor manager context and resolves
it against the file tree; the cursor line arrives over the existing
`aiAssist:*` window-event bridge that `use-project-handle.ts` already uses for
selection. `lastCompile` reads `logEntries` and `rawLog` from the local compile
context without calling `startCompile`, which is what lets `get_compile_log`
avoid a 120-second round trip. `rawLog` is what the tool's `includeRaw` argument
excerpts around each error; it is `null` before the first compile of a session,
in which case `includeRaw` is silently ignored rather than erroring.

## The static system prompt

`buildSystemPrompt(...)` becomes `SYSTEM_PROMPT`, a constant. It carries, in
order:

1. **Identity and environment.** An assistant embedded in the Overleaf editor,
   working on a live project the user is editing at the same time.
2. **Response style.** Concise, markdown, no restating the question, LaTeX
   commands in backticks.
3. **Workflow.** Orient before reading, read before editing, prefer the smallest
   change that solves the problem, explain what changed and why.
4. **Tool policy.** One line per tool on *when* it is the right call —
   specifically that `outline_project` and `list_references` answer structural
   questions far more cheaply than reading files, and that `search_project`
   beats guessing at a path.
5. **The edit contract.** `oldText` must match exactly once, and what to do for
   each failure status: `noMatch` re-read, `ambiguous` widen the anchor,
   `rejected` stop and ask rather than retrying the same edit, `drifted` re-read
   because the user typed while the diff was open.
6. **Compile policy.** Compile after edits that could affect the build; do not
   compile after prose-only or comment edits; never claim a fix works without
   evidence from a compile.
7. **Honesty rules.** Do not invent citation keys, label names, or package
   names. If a reference does not resolve, say so.

Because it contains no project data it is byte-identical across every request in
every project, which makes it a perfect cache prefix and lets it be asserted
against in tests as a constant.

## The project-context envelope

The envelope is **prefixed onto the user message content**, not injected as its
own message.

This is the load-bearing decision. A separate synthetic message sits at a
different array index on every turn, so the arrays for turn 4 and turn 5 diverge
at position zero and no prefix cache can hit. Prefixed onto the user turn it
becomes immutable history:

```
turn 1:  [ E1+U1 ]
turn 2:  [ E1+U1, A1, T1…, E2+U2 ]
turn 3:  [ E1+U1, A1, T1…, E2+U2, A2, T2…, E3+U3 ]
```

Every turn shares an exact prefix with the one before it. Only the newest
envelope, the newest user text, and that turn's tool results are uncached.

### Delta encoding

Left alone, that design would accumulate one full file tree per turn. So the
envelope emits the heavy sections only when they changed since the previous
envelope in the transcript:

```
<project-context turn="4">
<files>unchanged since turn 3</files>
<compile>failure — 2 errors, 5 warnings (call get_compile_log for detail)</compile>
<open-file>sections/results.tex, cursor line 88</open-file>
<selection file="sections/results.tex" lines="84-91">
\begin{figure}[h]
  \includegraphics{plot}
\end{figure}
</selection>
</project-context>
```

and in full when it did:

```
<project-context turn="1">
<files root="main.tex">
main.tex               doc     412 lines
sections/intro.tex     doc      88 lines
sections/results.tex   doc     190 lines
refs.bib               doc     240 lines
figures/plot.pdf       binary  84 KB
</files>
<compile>success — 0 errors, 3 warnings</compile>
<open-file>main.tex, cursor line 12</open-file>
</project-context>
```

The comparison is against the previously rendered envelope, which is derivable
from the transcript, so the encoding is deterministic and history is never
rewritten. Line counts replace today's byte sizes: a model choosing a `read_file`
range needs lines, not bytes.

Sections are ordered stable-to-volatile, so the material most likely to matter —
selection, attachments — ends up adjacent to the user's own words. The listing
cap stays at 200 entries with a pointer to `list_files` beyond that.

The duplicate selection injection at `agent-messages.ts:51` is removed; the
envelope is the single source.

## Request shape and caching

`ChatRequest` gains cache hints and real limits:

```ts
export type CacheHints = {
  cacheSystem: boolean
  cacheTools: boolean
  /** Index of the last message whose content is stable across turns. */
  lastStableMessage: number | null
  /** Stable per-project key for providers with keyed caches. */
  cacheKey?: string
}
```

**`AnthropicClient`** sends the system prompt as a content block array with
`cache_control: { type: 'ephemeral' }`, marks the final tool spec, and marks the
last content block of `lastStableMessage`. Anthropic allows four breakpoints, so
placement is explicit rather than sprayed across the array.

**`OpenAiClient`** needs no cache directives — prefix caching is automatic above
its minimum prefix length. The work is entirely in making the prefix stable,
which the envelope design does. It sends `prompt_cache_key` set to the project
id so cache routing is stable across a session.

**`OllamaClient`** has no cache API. A stable prefix still helps its own KV
reuse, so it ignores the hints and benefits anyway.

### Limits

`MAX_OUTPUT_TOKENS = 4096` and `MAX_STEPS = 12` are replaced:

- **Output tokens.** A per-provider default (8192 for `openai` and `anthropic`,
  4096 for `ollama`), overridable per provider in the settings form.
- **Context window.** A new `contextWindow` field on `ProviderSettings`,
  defaulting to 128000, exposed as a number input. This is user-supplied on
  purpose: the window of an arbitrary Ollama model or an OpenAI-compatible
  endpoint cannot be detected, and guessing silently would fail worse than
  asking.
- **Step budget.** 12 → 30. A read → edit → compile → re-read → fix cycle is
  eight or nine calls on its own, so 12 truncates ordinary work. The existing
  `budget` stop reason and its "Continue" affordance are unchanged.

## Token budget and elision

`budget.ts` estimates tokens at roughly 3.7 characters per token — deliberately
conservative for LaTeX, and chosen over a real tokenizer because none of the
three providers share one and shipping a tokenizer to the browser bundle is not
worth the bytes.

The budget is `contextWindow - maxOutputTokens - margin`, where `margin` is 10%
of the context window. The margin absorbs the gap between a character-count
estimate and a real tokenizer; under-estimating produces a provider 400, so the
error is deliberately biased towards eliding slightly too early.

When the assembled request exceeds the budget, elision runs in a fixed order:

1. Tool results, oldest first, keeping the three most recent verbatim. Content is
   replaced with a stub that names what was there and how to get it back:
   `{"elided": true, "summary": "read_file main.tex lines 1-400 (400 lines) — content elided, call read_file again if you need it"}`
2. If still over, assistant text from the oldest turns.
3. If still over after everything above, the panel surfaces a warning event and
   the run stops rather than sending a request that will 400.

Tool-call and tool-result pairing is preserved throughout — all three APIs reject
an orphan on either side. Envelopes, user text, and the current turn are never
elided.

Elision is monotonic: once a result is elided it stays elided in exactly that
form, so the prefix re-stabilises after the event and caching resumes.

## Tools

### Sharpened

| Tool | Change |
|---|---|
| `read_file` | Returns `totalLines`; when truncated, names the exact next range to request rather than only setting a flag |
| `search_project` | Adds a `path` glob filter, `contextLines` (default 1) around each hit, and a true total when truncated |

Both keep their current arguments, so existing transcripts replay unchanged.

### Rendering

`AgentTool` gains an optional `render(result): string`. Where it is absent the
loop keeps today's `JSON.stringify`. `read_file` and `get_compile_log` implement
it, returning fenced numbered text instead of a JSON string whose every newline
is an escape sequence. `render` affects only the `role: 'tool'` content sent to
the model. The structured result is what the transcript stores and what
`tool-call-card.tsx` renders, so the panel is unchanged and replaying an old
conversation still works — roughly a third fewer tokens on file content, and easier
for a model to quote back accurately. Errors stay structured JSON, because the
model needs to branch on them.

### New

| Tool | Arguments | Result |
|---|---|---|
| `outline_project` | optional `path` | Section tree with line numbers, the `\input`/`\include` graph from the root document, documentclass, and loaded packages |
| `list_references` | optional `kind`, `undefinedOnly` | Every `\label`, `\ref`/`\eqref`/`\autoref`, `\cite`, and `.bib` key, each with path, line, and resolved status |
| `get_compile_log` | optional `severity`, `maxEntries`, `includeRaw` | The last compile's errors and warnings, optionally with raw log lines around each, without triggering a compile |
| `create_file` | `path`, `content` | An `EditOutcome`, after the same approval card |

`outline_project` exists so that orienting on a forty-file thesis costs a few
hundred tokens instead of forty `read_file` calls. `list_references` answers the
single most common LaTeX failure in one call. Both are pure parsers in
`context/` over snapshot contents, reused by the envelope and by the tools.

`create_file` guardrails, enforced in the tool before the handle is touched:
reject a path that already exists, reject `..` traversal and absolute paths,
reject known binary extensions, and require a non-empty `content`. Approval
renders as an all-additions diff in the existing card.

## Composer attachments

`@` in the composer opens a typeahead over `fileTreeData`. Selecting a file
attaches it; a `:from-to` suffix — `@sections/results.tex:40-80` — attaches a
line range. The paperclip button at `agent-composer.tsx:106`, which currently has
no handler at all, opens the same picker.

```ts
/** What the composer holds before the message is sent. */
export type AttachmentRef = {
  path: string
  from?: number
  to?: number
}

/** What the transcript holds after it: resolved, with `text: null` if gone. */
export type Attachment = AttachmentRef & { text: string | null }
```

Attachments are resolved to text at send time through `handle.readFile`, stored
on the transcript entry so they survive a reload, and rendered into the
envelope's `<attachments>` section with path and line range labelled. They are
chips in the composer, removable, and they sit alongside the existing selection
chip rather than replacing it.

An attachment whose file has since been deleted renders as a note that the file
is gone, not as an error — the conversation should survive a file being removed.

## Error handling

Three failure modes are new, and none of them may end a run:

- **Snapshot unavailable.** `buildRequest` falls back to an envelope with the
  sections it could resolve and omits the rest, matching the existing behaviour
  at `run-agent.ts:41` where a snapshot that will not load must not stop the user
  talking to the model.
- **Budget exhausted.** Surfaced as an `error` event with a distinct code so the
  panel can offer "Start a new chat" rather than a generic provider message.
- **Parser failure.** A malformed `.tex` file must not throw out of
  `outline.ts` or `references.ts`. `outline.ts` can fail to find the end of a
  brace group, so it returns what it parsed plus a `notes` array naming each
  skipped construct — a partial outline is more useful than none.
  `references.ts` cannot fail: it is pure regex scanning over lines, so every
  input yields a result and it has no `notes` field.

## Testing

Every unit in `context/` is a pure function, so each gets direct unit tests with
literal inputs:

- `system-prompt` — asserted as a constant, including that it contains no project
  data.
- `project-context` — full render, delta render, each section present and absent,
  ordering, the 200-file cap.
- `budget` — estimation, elision order, the three-most-recent rule, tool pairing
  preserved, monotonicity, the give-up path.
- `outline` / `references` — section nesting, `\input` graph, unresolved refs and
  citations, malformed input.
- `build-request` — cache hint placement, envelope position, that the prefix for
  turn N+1 extends the prefix for turn N byte for byte. This is the regression
  test that protects the whole caching design.

Provider tests assert `cache_control` placement in the Anthropic body and its
absence from the OpenAI body. Tool tests extend the existing fake handle in
`test/frontend/js/agent/helpers/fake-handle.ts` with the three new methods.
Composer tests cover `@` typeahead, line-range parsing, chip removal, and a
deleted attachment.

The suite runs against the existing web unit runner; the module's tests live
under `modules/ai-assist/test/frontend/js/`.

## Configuration

No new environment variables. `AI_ASSIST_ENABLED` continues to gate the whole
module. `ProviderSettings` gains `contextWindow` and `maxOutputTokens`, both
optional with defaults, both persisted in the existing browser-side provider
store and edited in the existing provider form.

## Phasing

1. **Context assembly.** Static prompt, envelope, delta encoding, cache hints in
   all three providers, budget and elision, new limits. No new tools, no UI.
2. **Tools.** Handle additions, sharpened `read_file`/`search_project`, the
   `render` hook, and the four new tools.
3. **Attachments.** `@` typeahead, paperclip, transcript persistence, envelope
   rendering.

Phase 1 is the one that must land intact; 2 and 3 are additive and can ship
independently if the work needs to be cut short.
