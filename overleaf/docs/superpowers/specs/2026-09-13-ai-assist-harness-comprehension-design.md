# AI Assist — Harness Comprehension and Token Economy

**Date:** 2026-09-13
**Status:** Approved design, pending implementation plan
**Sub-project:** 5 of N

**Predecessors (all implemented):**

- `2026-09-10-ai-assist-project-agent-design.md` — the agent rail, tool
  registry, edit approval flow.
- `2026-09-11-ai-assist-context-optimisation-design.md` — static system
  prompt, frozen `<project-context>` envelope, token budget and elision,
  LaTeX-aware tools, `@`-mention attachments.
- `2026-09-13-ai-assist-error-panel-agent-design.md` — the compile-log
  "Suggest fix" panel re-platformed onto the same harness.

## Summary

The harness already keeps every byte of the project in the browser and keeps
the request prefix cache-stable. What it does not do is help the model
*navigate* a large project cheaply. On a 2,000-line paper the model orients by
paging `read_file` through 1,000-line windows, pays up to 200 rows of file
listing on turn 1 of every chat, and chooses among three overlapping
orientation tools whose specs it re-reads on every request.

This design adds a memoized client-side structural index, collapses the
orientation surface from three tools to one filterable tool, slims the frozen
envelope to a summary with the listing on demand, rewrites the static system
prompt around explicit tool costs, and adds a stream-level fallback that
rescues tool calls emitted as plain text by providers without native tool
support.

The feature stays disabled by default. With `AI_ASSIST_ENABLED` unset the
instance behaves exactly like upstream Overleaf CE.

## Decisions (settled in brainstorming, binding on the plan)

1. **No cost UI.** There is no user-visible token or price readout. The win
   must come from the harness: what bytes get assembled into each request.
2. **Client-side index plus dense query tools.** The harness precomputes
   structure and answers structural questions locally in a few hundred bytes.
   No auto-injection of guessed-relevant context — the model pulls, but every
   pull is cheap and precise.
3. **Seven tools.** `outline_project`, `list_references` and `list_files`
   merge into one `project_map` tool with a `view` discriminator.
4. **Prompt rewrite plus text-tool-call fallback.** Prevention via a rewritten
   static prompt and tighter tool specs; rescue via a stream-level detector
   for tool calls emitted as text. No post-hoc audit notes.
5. **Slim envelope.** Turn 1's `<files>` block carries the root path, per-type
   counts and top-level directory names. The full listing lives behind
   `project_map view=files`.

## Scope

### In scope

- A memoized project index (`agent/context/project-index.ts`).
- The merged `project_map` tool and structure-aware `read_file`.
- The slim envelope in `agent/context/project-context.ts`.
- A rewritten static `SYSTEM_PROMPT` and rewritten tool spec descriptions.
- A text-tool-call fallback in `agent/run-agent.ts`.
- Tool-card mapping for the merged tool name.

### Out of scope

- Any user-visible cost or usage UI.
- Any server-side component. The module remains frontend-only with no
  inference proxy; the index is computed in the browser from the project
  snapshot it already holds.
- Auto-injection of context the model did not ask for.
- Changing the envelope freezing mechanism, the budget/elision policy, or the
  provider cache breakpoints.

## Architecture

### §1 The project index

New module `agent/context/project-index.ts`, one responsibility: answer
structural questions about the project from bytes the browser already holds.

```ts
export type FileIndex = {
  path: string
  hash: string
  outline: Outline | null          // existing parseOutline output
  references: References | null    // existing extractReferences output
  environments: EnvironmentCount[] // new: figure/table/equation/algorithm,
                                   //        each with count and line numbers
}

export type ProjectIndex = {
  files: FileIndex[]
  builtAt: number
}

export function buildProjectIndex(
  docs: Array<{ path: string; content: string }>,
  previous?: ProjectIndex | null
): ProjectIndex
```

- Parses are memoized per file, keyed on a content hash. A keystroke reparses
  one file; `buildProjectIndex` reuses every unchanged `FileIndex` from
  `previous` and reassembles the index cheaply. The index is never rebuilt
  wholesale mid-run.
- `parseOutline` and `extractReferences` are the existing parsers from
  `agent/context/outline.ts` and `references.ts`, reused unchanged. Only the
  environment inventory is new, and it is a single regex pass per file.
- Binary files and files over a size cap (the same cap `read_file` refuses)
  get a `FileIndex` with null parses and a `tooLarge: true` flag, so
  `project_map` can say so instead of silently omitting them.
- Nothing from the index enters a request on its own. It exists only to
  answer tool queries.

**Ownership.** `ProjectHandle` gains one method:

```ts
index(): Promise<ProjectIndex>
```

implemented in `use-project-handle.ts` by reading every document file's
content from the project snapshot the browser already holds (no network, no
server), then calling `buildProjectIndex` with a module-level cache keyed by
project id as `previous`. The cache lives for the page session; a run never
rebuilds from scratch, and a keystroke costs one file's reparse. The fake
handle in tests implements `index()` from its `docs` map the same way.

### §2 Seven tools

`outline_project`, `list_references` and `list_files` are deleted and replaced
by:

```
project_map {
  view: 'outline' | 'references' | 'files' | 'packages'   (required)
  glob?: string          // view=files: narrow the listing
  kind?: 'labels' | 'refs' | 'citations' | 'all'  // view=references
  undefinedOnly?: boolean                          // view=references
  section?: string       // view=outline: only this subtree, with line range
}
```

- `view=outline` — the section tree over the whole `\input`/`\include` graph:
  documentclass, packages, sections with levels and line numbers. With
  `section`, only that subtree plus its exact `from`/`to` line range, which is
  what makes "read the methodology section" a one-call operation.
- `view=references` — the existing label/ref/cite resolution report plus bib
  keys, filterable exactly as `list_references` was.
- `view=files` — the full listing (path, type, size/lines), `glob`-narrowable.
  This is the only place the full listing now lives.
- `view=packages` — documentclass plus every `\usepackage`/`\RequirePackage`
  with the file and line that loads it, which is the single most common
  "why is this command undefined" question.

`read_file` gains one parameter:

```
section?: string   // read by section title or number instead of from/to
```

resolved through the index to an exact line range, then served through the
existing 1,000-line cap and `nextRange` pointer. `from`/`to` and `section` are
mutually exclusive; passing both is an argument error, not a silent choice.

**Section matching rule, made explicit.** `section` matches case-insensitively
against a section's title with LaTeX commands stripped and whitespace
collapsed. An exact match wins; otherwise a unique prefix match wins;
otherwise the tool returns the list of candidate titles with their line
numbers and reads nothing. Ambiguity is answered with information, never with
a guess.

`search_project`, `edit_file`, `create_file`, `compile_project` and
`get_compile_log` are unchanged. The fix panel's subset drops from seven tools
to five (`project_map`, `read_file`, `search_project`, `edit_file`,
`get_compile_log`).

Every tool keeps the existing `render()` hook: fenced plain text on the wire,
structured JSON in the stored transcript.

**Migration cost, named:** the rail's `ToolCallCard` icon/label mapping gains
a `project_map` entry; every test naming `outline_project`, `list_references`
or `list_files` is renamed. Both are mechanical.

### §3 The slim envelope

`renderEnvelope`'s `<files>` block becomes:

```
<files root="main.tex" tex="14" bib="1" other="37">
sections/  9 tex
figures/   22 other
data/      15 other
</files>
```

Root document path, per-type counts, top-level directory names with counts.
The delta contract is unchanged: `filesFingerprint` still hashes the full
listing, so an unchanged tree still collapses to `<files>unchanged since turn
N</files>` on later turns and a changed tree re-emits the slim block — never
the full listing.

Consequence, accepted: the model cannot see a path it has never asked about.
Invented paths fail with the existing `File not found` error, whose recovery
(`search_project`, `project_map view=files`) the system prompt teaches. That
recovery is one cheap call and replaces 2–3k tokens on every fresh chat over a
large project.

### §4 Prompt rewrite and the text-tool-call fallback

**System prompt.** Rewritten once as a single static constant, reorganised
around the new surface:

- An orientation ladder: `project_map` → `search_project` → `read_file`
  (prefer `section=`) → edit. Each rung names the cheaper alternative below it.
- Explicit relative-cost hints, e.g. "`project_map` returns a few hundred
  tokens; `read_file` costs roughly 270 tokens per 1,000 characters, so read a
  section, not a file."
- The honesty, compile-policy and edit-contract sections carried over verbatim
  where they still apply; tool names inside them updated to the new surface.

Because it is a constant, the rewrite costs one cache re-read at deploy and
then caches exactly as today. No project data is interpolated — the
byte-freeze invariant from the 2026-09-11 design is untouched.

The fix panel's `<task>` block in `agent/fix-run.ts` gets its tool list
updated from seven names to five.

**Tool specs.** Each description becomes a tight "use when / not when" pair
naming the cheaper alternative, e.g. `read_file`: "Use after `project_map` has
told you where to look. Prefer `section=` over line ranges. Not for finding
where something is — that is `search_project`."

**Text-tool-call fallback.** In `run-agent.ts`, ahead of the existing
`<think>` scanner, a detector watches streamed assistant text for a tool call
emitted as plain text:

- a fenced ```json block, or a bare object, matching
  `{"name": <string>, "arguments": <object>}`;
- whose `name` is a tool in the current request's registry;
- whose `arguments` validate against that tool's spec.

On a complete match the detector converts the text into a real `tool_call`
event, executes it through the registry, and suppresses the raw JSON from the
visible reply. Guardrails: at most one conversion per assistant turn, so a
model narrating JSON in prose cannot trigger a loop; a non-matching or
partial candidate is left in the text untouched. This makes Ollama and small
self-hosted models able to use the tool surface at all — today their tool
calls are dead text in the reply.

### §5 Testing

- `project-index.test.ts` — memoization (same hash returns the same parse
  object; changed content reparses one file only), environment inventory on a
  fixture paper, `tooLarge` flagging.
- `project-map-tool.test.ts` — each `view` returns dense output; `section`
  returns the subtree with exact line ranges; `view=files` + `glob` narrows;
  unknown view is an argument error.
- `read-file` section reads — by title and by number; `from`+`section`
  together is an error; unknown section reports clearly.
- Envelope — slim block shape; fingerprint still collapses unchanged trees;
  changed tree re-emits slim, never full.
- Fallback detector — fenced JSON converts and executes; bare object
  converts; prose mentioning JSON does not; two candidates in one turn convert
  at most one; unknown tool name stays text; invalid arguments stay text.
- Regression gates — the module suite (443 passing at design time) and the
  byte-exact prefix test from the 2026-09-11 plan, since envelope freezing is
  unchanged in mechanism.

## Risks

1. **The merge is a rename with teeth.** Three familiar names become one with
   a discriminator; a model that learned `outline_project` from its training
   distribution may still emit it. Mitigation: the fallback detector's
   unknown-name rule leaves such text visible rather than executing it, and
   the system prompt names the merged tool first and often. If real usage
   shows frequent stale-name calls, add a one-line alias mapping in the
   registry — decided at implementation, not now.
2. **Slim envelope trades visibility for tokens.** A model that never calls
   `project_map view=files` may guess paths more often on first contact with
   an unfamiliar project. The recovery loop is cheap and taught; the risk is
   accepted and measurable in the existing `File not found` tool results.
3. **Parallel edits in this worktree.** Another actor is adding files to
   `modules/ai-assist` concurrently (observed 2026-09-13). The plan's tasks
   must re-read every file immediately before editing it and treat unexpected
   content as current, not as drift to revert.
